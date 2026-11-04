package dispatch

import "context"

type Request struct {
	RequestID string   `json:"requestId"`
	Cohort    Cohort   `json:"cohort"`
	Teams     []Team   `json:"teams"`
	Settings  Settings `json:"settings"`
}

type Cohort struct {
	ID                    string    `json:"id"`
	Revision              int       `json:"revision"`
	ExpectedDeliveryMonth string    `json:"expectedDeliveryMonth"`
	ExpectedDeliveryHalf  int       `json:"expectedDeliveryHalf"`
	Patients              []Patient `json:"patients"`
}

type Patient struct {
	ID              string   `json:"id"`
	Location        Location `json:"location"`
	Parity          string   `json:"parity"`
	EligibleTeamIDs []string `json:"eligibleTeamIds,omitempty"`
}

type Team struct {
	ID          string   `json:"id"`
	MinPatients int      `json:"minPatients"`
	MaxPatients int      `json:"maxPatients"`
	Members     []Member `json:"members"`
}

type Member struct {
	ID       string   `json:"id"`
	Location Location `json:"location"`
}

type Location struct {
	Address string  `json:"address,omitempty"`
	PlaceID string  `json:"placeId,omitempty"`
	LatLng  *LatLng `json:"latLng,omitempty"`
}

type LatLng struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type Settings struct {
	Weights                    Weights `json:"weights"`
	ReferenceTravelTimeMinutes float64 `json:"referenceTravelTimeMinutes"`
}

type Weights struct {
	Capacity  float64 `json:"capacity"`
	Geography float64 `json:"geography"`
	Parity    float64 `json:"parity"`
}

type Response struct {
	RequestID              string                  `json:"requestId"`
	ResultStatus           string                  `json:"resultStatus"`
	Solver                 SolverSummary           `json:"solver"`
	RouteLookup            RouteLookupSummary      `json:"routeLookup"`
	Settings               SettingsSummary         `json:"settings"`
	Scores                 *Scores                 `json:"scores"`
	Assignments            []Assignment            `json:"assignments"`
	Teams                  []TeamSummary           `json:"teams"`
	CandidateTravelCosts   []CandidateTravelCost   `json:"candidateTravelCosts"`
	AssignmentExplanations []AssignmentExplanation `json:"assignmentExplanations"`
	UnresolvedRoutes       []UnresolvedRoute       `json:"unresolvedRoutes"`
	Issues                 []string                `json:"issues"`
}

type SolverSummary struct {
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	RuntimeMs   int64    `json:"runtimeMs"`
	Objective   *float64 `json:"objective,omitempty"`
	BestBound   *float64 `json:"bestBound,omitempty"`
	RelativeGap *float64 `json:"relativeGap,omitempty"`
}

type RouteLookupSummary struct {
	Provider          string `json:"provider"`
	RoutingPreference string `json:"routingPreference"`
	LookedUpAt        string `json:"lookedUpAt"`
	ElementCount      int    `json:"elementCount"`
}

type SettingsSummary struct {
	ConfiguredWeights          Weights `json:"configuredWeights"`
	EffectiveWeights           Weights `json:"effectiveWeights"`
	ReferenceTravelTimeMinutes float64 `json:"referenceTravelTimeMinutes"`
}

type Scores struct {
	Capacity  float64  `json:"capacity"`
	Geography float64  `json:"geography"`
	Parity    *float64 `json:"parity"`
	Total     float64  `json:"total"`
}

type Assignment struct {
	PatientID string `json:"patientId"`
	TeamID    string `json:"teamId"`
}

type TeamSummary struct {
	TeamID                      string   `json:"teamId"`
	AssignedCount               int      `json:"assignedCount"`
	MinPatients                 int      `json:"minPatients"`
	MaxPatients                 int      `json:"maxPatients"`
	PrimiparousCount            int      `json:"primiparousCount"`
	MultiparousCount            int      `json:"multiparousCount"`
	KnownParityRatio            *float64 `json:"knownParityRatio"`
	BatchTargetPrimiparousRatio *float64 `json:"batchTargetPrimiparousRatio"`
	MixDeviation                *float64 `json:"mixDeviation"`
}

type CandidateTravelCost struct {
	PatientID     string          `json:"patientId"`
	TeamID        string          `json:"teamId"`
	MeanSeconds   float64         `json:"meanSeconds"`
	MemberSeconds []MemberSeconds `json:"memberSeconds"`
}

type AssignmentExplanation struct {
	PatientID            string         `json:"patientId"`
	TeamID               string         `json:"teamId"`
	MeanTravelSeconds    float64        `json:"meanTravelSeconds"`
	ClosestMemberID      string         `json:"closestMemberId"`
	ClosestMemberSeconds int64          `json:"closestMemberSeconds"`
	MatchScore           float64        `json:"matchScore"`
	CriteriaScores       CriteriaScores `json:"criteriaScores"`
}

type CriteriaScores struct {
	Capacity  float64 `json:"capacity"`
	Geography float64 `json:"geography"`
	Parity    float64 `json:"parity"`
}

type MemberSeconds struct {
	MemberID   string `json:"memberId"`
	Seconds    int64  `json:"seconds"`
	TravelMode string `json:"travelMode,omitempty"`
}

type UnresolvedRoute struct {
	PatientID string `json:"patientId"`
	TeamID    string `json:"teamId"`
	MemberID  string `json:"memberId,omitempty"`
	Code      string `json:"code"`
}

type RouteMatrix struct {
	ElementCount     int
	Costs            [][]float64
	CandidateCosts   []CandidateTravelCost
	UnresolvedRoutes []UnresolvedRoute
}

type RouteProvider interface {
	Name() string
	RoutingPreference() string
	RouteModesPerPair() int
	SupportsTextLocations() bool
	Compute(context.Context, Request) (RouteMatrix, error)
}

type ValidationError struct {
	Issues []string
}

func (e *ValidationError) Error() string { return "invalid calculation request" }
