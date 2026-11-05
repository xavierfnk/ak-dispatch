package googlemaps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"patient-dispatch-planner/server/internal/dispatch"
)

func TestComputeRouteMatrixChoosesFastestModePerMember(t *testing.T) {
	calls := 0
	modes := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.Header.Get("X-Goog-Api-Key"); got != "test-key" {
			t.Errorf("API key header = %q, want test-key", got)
		}
		if got := r.Header.Get("X-Goog-FieldMask"); got != routesFieldMask {
			t.Errorf("field mask = %q, want %q", got, routesFieldMask)
		}
		var request matrixRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if (request.TravelMode != "BICYCLE" && request.TravelMode != "TRANSIT") || request.RoutingPreference != "" {
			t.Errorf("unexpected route policy: %+v", request)
		}
		modes[request.TravelMode] = true
		if len(request.Origins) != 2 || len(request.Destinations) != 1 {
			t.Fatalf("got %d origins and %d destinations", len(request.Origins), len(request.Destinations))
		}
		if request.Origins[0].Waypoint.Location == nil || request.Origins[0].Waypoint.Location.LatLng == nil {
			t.Fatalf("coordinate waypoint not encoded as a Routes Location: %+v", request.Origins[0])
		}
		w.Header().Set("Content-Type", "application/json")
		if request.TravelMode == "BICYCLE" {
			_, _ = w.Write([]byte(`[
{"originIndex":1,"destinationIndex":0,"condition":"ROUTE_NOT_FOUND","status":{"code":0}},
{"originIndex":0,"destinationIndex":0,"duration":"60s","condition":"ROUTE_EXISTS","status":{"code":0}}
]`))
			return
		}
		_, _ = w.Write([]byte(`[
{"originIndex":1,"destinationIndex":0,"duration":"90s","condition":"ROUTE_EXISTS","status":{"code":0}},
{"originIndex":0,"destinationIndex":0,"duration":"120s","condition":"ROUTE_EXISTS","status":{"code":0}}
]`))
	}))
	defer server.Close()

	client := NewClient("test-key")
	client.routesURL = server.URL
	request := dispatch.Request{
		Teams: []dispatch.Team{{
			ID: "team-token",
			Members: []dispatch.Member{
				{ID: "member-a", Location: coords(48.8, 2.2)},
				{ID: "member-b", Location: coords(48.9, 2.3)},
			},
		}},
		Cohort: dispatch.Cohort{Patients: []dispatch.Patient{{
			ID: "patient-token", Location: coords(48.85, 2.25),
		}}},
	}

	got, err := client.Compute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got.ElementCount != 4 || len(got.CandidateCosts) != 1 || calls != 2 || !modes["BICYCLE"] || !modes["TRANSIT"] {
		t.Fatalf("unexpected matrix summary: %+v", got)
	}
	if got.Costs[0][0] != 75 {
		t.Fatalf("team/patient mean = %v, want 75 seconds", got.Costs[0][0])
	}
	memberSeconds := got.CandidateCosts[0].MemberSeconds
	if len(memberSeconds) != 2 || memberSeconds[0].Seconds != 60 || memberSeconds[0].TravelMode != "BICYCLE" || memberSeconds[1].Seconds != 90 || memberSeconds[1].TravelMode != "TRANSIT" {
		t.Fatalf("did not select and record the fastest route per member: %+v", memberSeconds)
	}
}

func TestRouteRequestsContainOnlyAddressesAndRoutingOptions(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"team-private", "member-private", "patient-private", "primiparous", "eligiblePec100"} {
			if bytes.Contains(payload, []byte(forbidden)) {
				t.Errorf("Google request included local assignment data %q: %s", forbidden, payload)
			}
		}
		var request matrixRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			t.Fatal(err)
		}
		if request.Origins[0].Waypoint.Address != "40 Rue de Rivoli, Paris" || request.Destinations[0].Waypoint.Address != "27 Rue Saint-Denis, Paris" {
			t.Errorf("Google received unexpected locations: %+v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"originIndex":0,"destinationIndex":0,"duration":"60s","condition":"ROUTE_EXISTS","status":{"code":0}}]`))
	}))
	defer server.Close()

	client := NewClient("test-key")
	client.routesURL = server.URL
	_, err := client.Compute(context.Background(), dispatch.Request{
		Teams: []dispatch.Team{{ID: "team-private", Members: []dispatch.Member{{
			ID: "member-private", Location: dispatch.Location{Address: "40 Rue de Rivoli, Paris"},
		}}}},
		Cohort: dispatch.Cohort{Patients: []dispatch.Patient{{
			ID: "patient-private", Parity: "primiparous", EligiblePEC100: true, Location: dispatch.Location{Address: "27 Rue Saint-Denis, Paris"},
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("got %d Routes requests, want one per travel mode", calls)
	}
}

func TestUnresolvedMemberRouteDoesNotProducePartialMean(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`[
{"originIndex":0,"destinationIndex":0,"duration":"60s","condition":"ROUTE_EXISTS","status":{"code":0}},
{"originIndex":1,"destinationIndex":0,"condition":"ROUTE_NOT_FOUND","status":{"code":0}}
]`))
	}))
	defer server.Close()

	client := NewClient("test-key")
	client.routesURL = server.URL
	request := dispatch.Request{
		Teams: []dispatch.Team{{
			ID: "team-token",
			Members: []dispatch.Member{
				{ID: "member-a", Location: coords(48.8, 2.2)},
				{ID: "member-b", Location: coords(48.9, 2.3)},
			},
		}},
		Cohort: dispatch.Cohort{Patients: []dispatch.Patient{{
			ID: "patient-token", Location: coords(48.85, 2.25),
		}}},
	}

	got, err := client.Compute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.UnresolvedRoutes) != 1 || got.UnresolvedRoutes[0].MemberID != "member-b" || calls != 2 {
		t.Fatalf("expected the failed member route to be unresolved, got %+v", got.UnresolvedRoutes)
	}
	if len(got.CandidateCosts) != 0 {
		t.Fatalf("partial member mean must not be emitted: %+v", got.CandidateCosts)
	}
}

func TestComputeChunksWithinGoogleWaypointAndElementLimits(t *testing.T) {
	calls := 0
	modes := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if (calls == 1 && !bytes.Contains(payload, []byte(`"placeId":"origin-place-0"`))) || bytes.Contains(payload, []byte("member-")) {
			t.Errorf("Google request should carry Place IDs only, not internal member IDs: %s", payload)
		}
		var request matrixRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			t.Fatal(err)
		}
		modes[request.TravelMode] = true
		if request.TravelMode != "BICYCLE" && request.TravelMode != "TRANSIT" {
			t.Errorf("unexpected travel mode %q", request.TravelMode)
		}
		maxElements := maxElementsPerCall
		if request.TravelMode == "TRANSIT" {
			maxElements = maxTransitElements
		}
		if len(request.Origins)*len(request.Destinations) > maxElements || len(request.Origins)+len(request.Destinations) > 50 {
			t.Errorf("request exceeded a Google matrix limit: %d origins, %d destinations", len(request.Origins), len(request.Destinations))
		}
		elements := make([]matrixElement, 0, len(request.Origins)*len(request.Destinations))
		for originIndex := range request.Origins {
			for destinationIndex := range request.Destinations {
				elements = append(elements, matrixElement{
					OriginIndex: originIndex, DestinationIndex: destinationIndex,
					Duration: "60s", Condition: "ROUTE_EXISTS",
				})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(elements)
	}))
	defer server.Close()

	client := NewClient("test-key")
	client.routesURL = server.URL
	team := dispatch.Team{ID: "team"}
	for index := range 26 {
		team.Members = append(team.Members, dispatch.Member{
			ID:       fmt.Sprintf("member-%d", index),
			Location: dispatch.Location{PlaceID: fmt.Sprintf("origin-place-%d", index)},
		})
	}
	patients := make([]dispatch.Patient, 26)
	for index := range patients {
		patients[index] = dispatch.Patient{
			ID:       fmt.Sprintf("patient-%d", index),
			Location: dispatch.Location{PlaceID: fmt.Sprintf("destination-place-%d", index)},
			Parity:   "primiparous",
		}
	}
	got, err := client.Compute(context.Background(), dispatch.Request{
		Teams:  []dispatch.Team{team},
		Cohort: dispatch.Cohort{Patients: patients},
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 13 || got.ElementCount != 2*26*26 || len(got.CandidateCosts) != 26 || !modes["BICYCLE"] || !modes["TRANSIT"] {
		t.Fatalf("unexpected chunked result: calls=%d elements=%d costs=%d", calls, got.ElementCount, len(got.CandidateCosts))
	}
}

func TestQuotaErrorsAreSafeAndNotRetried(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		http.Error(w, `{"error":{"message":"private provider detail"}}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	client := NewClient("test-key")
	client.routesURL = server.URL
	_, err := client.Compute(context.Background(), dispatch.Request{
		Teams:  []dispatch.Team{{ID: "team", Members: []dispatch.Member{{ID: "member", Location: coords(48.8, 2.2)}}}},
		Cohort: dispatch.Cohort{Patients: []dispatch.Patient{{ID: "patient", Location: coords(48.85, 2.25), Parity: "primiparous"}}},
	})
	var providerError *APIError
	if !errors.As(err, &providerError) || providerError.StatusCode() != http.StatusTooManyRequests || providerError.Code() != "provider_quota_exceeded" {
		t.Fatalf("unexpected quota error: %v", err)
	}
	if strings.Contains(err.Error(), "private provider detail") || calls != 1 {
		t.Fatalf("provider details leaked or quota response was retried: err=%v calls=%d", err, calls)
	}
}

func coords(latitude, longitude float64) dispatch.Location {
	return dispatch.Location{LatLng: &dispatch.LatLng{Latitude: latitude, Longitude: longitude}}
}
