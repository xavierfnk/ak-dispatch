package googlemaps

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"patient-dispatch-planner/server/internal/dispatch"
)

const (
	routesEndpoint       = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
	routesFieldMask      = "originIndex,destinationIndex,duration,status,condition"
	maxElementsPerCall   = 625
	maxTransitElements   = 100
	waypointsPerSide     = 25
	maxGoogleResponse    = 2 << 20
	googleRequestTimeout = 15 * time.Second
)

type Client struct {
	apiKey     string
	httpClient *http.Client
	routesURL  string
}

func NewClient(apiKey string) *Client {
	return &Client{
		apiKey: strings.TrimSpace(apiKey),
		httpClient: &http.Client{
			Timeout: googleRequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		routesURL: routesEndpoint,
	}
}

func (c *Client) Name() string                { return "Google Routes API" }
func (c *Client) RoutingPreference() string   { return "SHORTEST_OF_BICYCLE_AND_TRANSIT" }
func (c *Client) RouteModesPerPair() int      { return 2 }
func (c *Client) SupportsTextLocations() bool { return true }

type APIError struct {
	statusCode int
	code       string
}

func (e *APIError) Error() string   { return e.code }
func (e *APIError) StatusCode() int { return e.statusCode }
func (e *APIError) Code() string    { return e.code }

type waypoint struct {
	Address  string            `json:"address,omitempty"`
	PlaceID  string            `json:"placeId,omitempty"`
	Location *waypointLocation `json:"location,omitempty"`
}

type waypointLocation struct {
	LatLng *dispatch.LatLng `json:"latLng,omitempty"`
}

type matrixWaypoint struct {
	Waypoint waypoint `json:"waypoint"`
}

type matrixRequest struct {
	Origins           []matrixWaypoint `json:"origins"`
	Destinations      []matrixWaypoint `json:"destinations"`
	TravelMode        string           `json:"travelMode"`
	RoutingPreference string           `json:"routingPreference,omitempty"`
}

type matrixElement struct {
	OriginIndex      int    `json:"originIndex"`
	DestinationIndex int    `json:"destinationIndex"`
	Duration         string `json:"duration"`
	Condition        string `json:"condition"`
	Status           struct {
		Code int `json:"code"`
	} `json:"status"`
}

type originRef struct {
	teamIndex   int
	memberIndex int
	member      dispatch.Member
}

type routeOption struct {
	seconds   int64
	duration  time.Duration
	mode      string
	available bool
}

func (c *Client) Compute(ctx context.Context, req dispatch.Request) (dispatch.RouteMatrix, error) {
	origins := make([]originRef, 0)
	for teamIndex, team := range req.Teams {
		for memberIndex, member := range team.Members {
			origins = append(origins, originRef{teamIndex: teamIndex, memberIndex: memberIndex, member: member})
		}
	}
	patientCount := len(req.Cohort.Patients)
	matrix := dispatch.RouteMatrix{
		ElementCount:     len(origins) * patientCount * c.RouteModesPerPair(),
		Costs:            make([][]float64, len(req.Teams)),
		CandidateCosts:   make([]dispatch.CandidateTravelCost, 0, len(req.Teams)*patientCount),
		UnresolvedRoutes: []dispatch.UnresolvedRoute{},
	}
	bestRoutes := make([][][]routeOption, len(req.Teams))
	cellErrors := make([][][][]string, len(req.Teams))
	for teamIndex, team := range req.Teams {
		matrix.Costs[teamIndex] = make([]float64, patientCount)
		bestRoutes[teamIndex] = make([][]routeOption, len(team.Members))
		cellErrors[teamIndex] = make([][][]string, len(team.Members))
		for memberIndex := range team.Members {
			bestRoutes[teamIndex][memberIndex] = make([]routeOption, patientCount)
			cellErrors[teamIndex][memberIndex] = make([][]string, patientCount)
		}
	}
	if len(origins) == 0 || patientCount == 0 {
		return matrix, nil
	}

	for _, travelMode := range [...]string{"BICYCLE", "TRANSIT"} {
		chunkSize := waypointsPerSide
		maxElements := maxElementsPerCall
		if travelMode == "TRANSIT" {
			chunkSize = 10
			maxElements = maxTransitElements
		}
		for originStart := 0; originStart < len(origins); originStart += chunkSize {
			originEnd := min(originStart+chunkSize, len(origins))
			for destinationStart := 0; destinationStart < patientCount; destinationStart += chunkSize {
				destinationEnd := min(destinationStart+chunkSize, patientCount)
				originChunk := origins[originStart:originEnd]
				patientChunk := req.Cohort.Patients[destinationStart:destinationEnd]
				request := matrixRequest{
					Origins:      make([]matrixWaypoint, 0, len(originChunk)),
					Destinations: make([]matrixWaypoint, 0, len(patientChunk)),
					TravelMode:   travelMode,
				}
				for _, origin := range originChunk {
					request.Origins = append(request.Origins, matrixWaypoint{Waypoint: toWaypoint(origin.member.Location)})
				}
				for _, patient := range patientChunk {
					request.Destinations = append(request.Destinations, matrixWaypoint{Waypoint: toWaypoint(patient.Location)})
				}
				if len(request.Origins)*len(request.Destinations) > maxElements || len(request.Origins)+len(request.Destinations) > 2*waypointsPerSide {
					return dispatch.RouteMatrix{}, &APIError{statusCode: http.StatusBadGateway, code: "invalid_matrix_chunk"}
				}
				var elements []matrixElement
				if err := c.postJSON(ctx, c.routesURL, routesFieldMask, request, &elements); err != nil {
					return dispatch.RouteMatrix{}, err
				}
				seen := make([][]bool, len(originChunk))
				for index := range seen {
					seen[index] = make([]bool, len(patientChunk))
				}
				for _, element := range elements {
					if element.OriginIndex < 0 || element.OriginIndex >= len(originChunk) || element.DestinationIndex < 0 || element.DestinationIndex >= len(patientChunk) || seen[element.OriginIndex][element.DestinationIndex] {
						return dispatch.RouteMatrix{}, &APIError{statusCode: http.StatusBadGateway, code: "invalid_matrix_response"}
					}
					seen[element.OriginIndex][element.DestinationIndex] = true
					origin := originChunk[element.OriginIndex]
					patientIndex := destinationStart + element.DestinationIndex
					if element.Status.Code != 0 || element.Condition != "ROUTE_EXISTS" {
						cellErrors[origin.teamIndex][origin.memberIndex][patientIndex] = append(cellErrors[origin.teamIndex][origin.memberIndex][patientIndex], travelMode+":"+routeErrorCode(element))
						continue
					}
					duration, err := time.ParseDuration(element.Duration)
					if err != nil || duration < 0 {
						cellErrors[origin.teamIndex][origin.memberIndex][patientIndex] = append(cellErrors[origin.teamIndex][origin.memberIndex][patientIndex], travelMode+":invalid_duration")
						continue
					}
					value := int64(math.Round(duration.Seconds()))
					best := &bestRoutes[origin.teamIndex][origin.memberIndex][patientIndex]
					if !best.available || duration < best.duration {
						*best = routeOption{seconds: value, duration: duration, mode: travelMode, available: true}
					}
				}
				for originIndex, origin := range originChunk {
					for patientOffset := range patientChunk {
						if !seen[originIndex][patientOffset] {
							globalPatient := destinationStart + patientOffset
							cellErrors[origin.teamIndex][origin.memberIndex][globalPatient] = append(cellErrors[origin.teamIndex][origin.memberIndex][globalPatient], travelMode+":missing_element")
						}
					}
				}
			}
		}
	}

	for teamIndex, team := range req.Teams {
		for patientIndex, patient := range req.Cohort.Patients {
			memberSeconds := make([]dispatch.MemberSeconds, 0, len(team.Members))
			var total int64
			complete := true
			for memberIndex, member := range team.Members {
				route := bestRoutes[teamIndex][memberIndex][patientIndex]
				if !route.available {
					complete = false
					codes := cellErrors[teamIndex][memberIndex][patientIndex]
					code := strings.Join(codes, ",")
					if len(codes) == 0 {
						code = "missing_element"
					}
					matrix.UnresolvedRoutes = append(matrix.UnresolvedRoutes, dispatch.UnresolvedRoute{
						PatientID: patient.ID,
						TeamID:    team.ID,
						MemberID:  member.ID,
						Code:      code,
					})
					continue
				}
				total += route.seconds
				memberSeconds = append(memberSeconds, dispatch.MemberSeconds{MemberID: member.ID, Seconds: route.seconds, TravelMode: route.mode})
			}
			if !complete {
				continue
			}
			meanSeconds := float64(total) / float64(len(team.Members))
			matrix.Costs[teamIndex][patientIndex] = meanSeconds
			matrix.CandidateCosts = append(matrix.CandidateCosts, dispatch.CandidateTravelCost{
				PatientID:     patient.ID,
				TeamID:        team.ID,
				MeanSeconds:   meanSeconds,
				MemberSeconds: memberSeconds,
			})
		}
	}
	return matrix, nil
}

func toWaypoint(location dispatch.Location) waypoint {
	if strings.TrimSpace(location.Address) != "" {
		return waypoint{Address: strings.TrimSpace(location.Address)}
	}
	if strings.TrimSpace(location.PlaceID) != "" {
		return waypoint{PlaceID: strings.TrimSpace(location.PlaceID)}
	}
	return waypoint{Location: &waypointLocation{LatLng: location.LatLng}}
}

func routeErrorCode(element matrixElement) string {
	if element.Condition == "ROUTE_NOT_FOUND" {
		return "route_not_found"
	}
	if element.Status.Code != 0 {
		return "provider_element_error"
	}
	return "route_unavailable"
}

func (c *Client) postJSON(ctx context.Context, endpoint, fieldMask string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return &APIError{statusCode: http.StatusBadRequest, code: "invalid_provider_request"}
	}
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_unavailable"}
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Goog-Api-Key", c.apiKey)
		if fieldMask != "" {
			request.Header.Set("X-Goog-FieldMask", fieldMask)
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if attempt == 0 {
				if retryErr := waitRetry(ctx); retryErr == nil {
					continue
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
			}
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_unavailable"}
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, maxGoogleResponse+1))
		_ = response.Body.Close()
		if readErr != nil || len(data) > maxGoogleResponse {
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_invalid_response"}
		}
		if response.StatusCode == http.StatusTooManyRequests {
			return &APIError{statusCode: http.StatusTooManyRequests, code: "provider_quota_exceeded"}
		}
		if response.StatusCode >= 500 {
			if attempt == 0 {
				if retryErr := waitRetry(ctx); retryErr == nil {
					continue
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
			}
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_unavailable"}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_rejected"}
		}
		if err := json.Unmarshal(data, output); err != nil {
			return &APIError{statusCode: http.StatusBadGateway, code: "provider_invalid_response"}
		}
		return nil
	}
	return &APIError{statusCode: http.StatusBadGateway, code: "provider_unavailable"}
}

func waitRetry(ctx context.Context) error {
	timer := time.NewTimer(150 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
