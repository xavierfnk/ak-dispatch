package dispatch

import (
	"context"
	"testing"
)

func TestCalculateUsesEveryMemberAndRespectsCapacity(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{{
		ID:       "patient-token",
		Location: coordinates(0, 0.1),
		Parity:   "primiparous",
	}}
	req.Teams = []Team{
		{
			ID: "near", MinPatients: 0, MaxPatients: 1,
			Members: []Member{
				{ID: "near-a", Location: coordinates(0, 0)},
				{ID: "near-b", Location: coordinates(0, 0.2)},
			},
		},
		{
			ID: "far", MinPatients: 0, MaxPatients: 1,
			Members: []Member{{ID: "far-a", Location: coordinates(1, 1)}},
		},
	}

	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "optimal" || len(got.Assignments) != 1 || got.Assignments[0].TeamID != "near" {
		t.Fatalf("unexpected assignment result: status=%q assignments=%+v", got.ResultStatus, got.Assignments)
	}
	if len(got.CandidateTravelCosts) != 2 {
		t.Fatalf("got %d candidate costs, want one for each team", len(got.CandidateTravelCosts))
	}
	nearCost := got.CandidateTravelCosts[0]
	if nearCost.TeamID != "near" || len(nearCost.MemberSeconds) != 2 {
		t.Fatalf("unexpected near-team route details: %+v", nearCost)
	}
	wantMean := float64(nearCost.MemberSeconds[0].Seconds+nearCost.MemberSeconds[1].Seconds) / 2
	if nearCost.MeanSeconds != wantMean {
		t.Fatalf("mean route time = %v, want arithmetic mean %v", nearCost.MeanSeconds, wantMean)
	}
	if len(got.AssignmentExplanations) != 2 {
		t.Fatalf("got %d assignment explanations, want one for each team", len(got.AssignmentExplanations))
	}
	var explanation AssignmentExplanation
	for _, candidate := range got.AssignmentExplanations {
		if candidate.TeamID == "near" {
			explanation = candidate
		}
	}
	if explanation.MeanTravelSeconds != nearCost.MeanSeconds || explanation.ClosestMemberID != "near-a" || explanation.ClosestMemberSeconds != nearCost.MemberSeconds[0].Seconds {
		t.Fatalf("unexpected assignment explanation: %+v", explanation)
	}
	if explanation.MatchScore != 20 || explanation.CriteriaScores.Geography != 100 || explanation.CriteriaScores.Capacity != 0 || explanation.CriteriaScores.Parity != 100 {
		t.Fatalf("unexpected criterion match scores: %+v", explanation)
	}
	if got.Teams[0].AssignedCount != 1 || got.Teams[1].AssignedCount != 0 {
		t.Fatalf("capacity summary does not match assignments: %+v", got.Teams)
	}
}

func TestCapacityBalanceOutranksTravelAndWeightsAreFixed(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous"},
		{ID: "p2", Location: coordinates(0, 0.01), Parity: "multiparous"},
	}
	req.Teams = []Team{
		{ID: "near", MinPatients: 0, MaxPatients: 2, Members: []Member{{ID: "near-member", Location: coordinates(0, 0)}}},
		{ID: "far", MinPatients: 0, MaxPatients: 2, Members: []Member{{ID: "far-member", Location: coordinates(1, 1)}}},
	}
	req.Settings.Weights = Weights{Geography: 1}
	provider := &testRouteProvider{
		name: "test",
		matrix: RouteMatrix{
			Costs: [][]float64{{60, 60}, {60_000, 60_000}},
			CandidateCosts: []CandidateTravelCost{
				{PatientID: "p1", TeamID: "near", MeanSeconds: 60, MemberSeconds: []MemberSeconds{{MemberID: "near-member", Seconds: 60}}},
				{PatientID: "p2", TeamID: "near", MeanSeconds: 60, MemberSeconds: []MemberSeconds{{MemberID: "near-member", Seconds: 60}}},
				{PatientID: "p1", TeamID: "far", MeanSeconds: 60_000, MemberSeconds: []MemberSeconds{{MemberID: "far-member", Seconds: 60_000}}},
				{PatientID: "p2", TeamID: "far", MeanSeconds: 60_000, MemberSeconds: []MemberSeconds{{MemberID: "far-member", Seconds: 60_000}}},
			},
		},
	}

	got, err := CalculateWithProvider(context.Background(), req, provider, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Teams[0].AssignedCount != 1 || got.Teams[1].AssignedCount != 1 {
		t.Fatalf("capacity balance should win over much shorter travel: %+v", got.Teams)
	}
	if got.Settings.ConfiguredWeights != fixedWeights || got.Settings.EffectiveWeights != fixedWeights {
		t.Fatalf("client-provided weights were not replaced by fixed weights: %+v", got.Settings)
	}
}

func TestCalculateReportsAggregateCapacityInfeasibility(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{{ID: "patient-token", Location: coordinates(0, 0), Parity: "primiparous"}}
	req.Teams = []Team{{
		ID: "team-token", MinPatients: 2, MaxPatients: 3,
		Members: []Member{{ID: "member-token", Location: coordinates(0, 0)}},
	}}

	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "infeasible" || len(got.Assignments) != 0 {
		t.Fatalf("expected an explicit infeasible result, got %+v", got)
	}
}

func TestCalculateRejectsInvalidCohortHalf(t *testing.T) {
	req := baseRequest()
	req.Cohort.ExpectedDeliveryHalf = 5
	_, err := Calculate(context.Background(), req)
	if _, ok := err.(*ValidationError); !ok {
		t.Fatalf("invalid cohort half should be rejected, got %v", err)
	}
}

func TestFourthCohortIsAccepted(t *testing.T) {
	req := baseRequest()
	req.Cohort.ExpectedDeliveryHalf = 4
	got, err := Calculate(context.Background(), req)
	if err != nil || got.ResultStatus != "optimal" {
		t.Fatalf("fourth cohort should be accepted, status=%s error=%v", got.ResultStatus, err)
	}
}

func TestPECEligiblePatientsAreDistributedEqually(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous", EligiblePEC100: true},
		{ID: "p2", Location: coordinates(0, 0), Parity: "multiparous", EligiblePEC100: true},
		{ID: "p3", Location: coordinates(0, 0), Parity: "primiparous", EligiblePEC100: true},
	}
	req.Teams = []Team{
		{ID: "a", MaxPatients: 3, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}},
		{ID: "b", MaxPatients: 3, Members: []Member{{ID: "mb", Location: coordinates(1, 1)}}},
		{ID: "c", MaxPatients: 3, Members: []Member{{ID: "mc", Location: coordinates(2, 2)}}},
	}
	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, assignment := range got.Assignments {
		counts[assignment.TeamID]++
	}
	if got.ResultStatus != "optimal" || counts["a"] != 1 || counts["b"] != 1 || counts["c"] != 1 {
		t.Fatalf("expected one eligible patient per team, got status %s counts %v", got.ResultStatus, counts)
	}
}

func TestPECDistributionReportsInfeasibleWhenCapacityPreventsBalance(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous", EligiblePEC100: true},
		{ID: "p2", Location: coordinates(0, 0), Parity: "multiparous", EligiblePEC100: true},
	}
	req.Teams = []Team{
		{ID: "a", MaxPatients: 2, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}},
		{ID: "b", MaxPatients: 0, Members: []Member{{ID: "mb", Location: coordinates(0, 0)}}},
	}
	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "infeasible" || len(got.Assignments) != 0 {
		t.Fatalf("expected infeasible without an unbalanced assignment, got %+v", got)
	}
}

func TestPECDistributionAllowsRemainderAndNonEligiblePatients(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous", EligiblePEC100: true},
		{ID: "p2", Location: coordinates(0, 0), Parity: "multiparous", EligiblePEC100: true},
		{ID: "p3", Location: coordinates(0, 0), Parity: "multiparous"},
	}
	req.Teams = []Team{
		{ID: "a", MaxPatients: 3, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}},
		{ID: "b", MaxPatients: 3, Members: []Member{{ID: "mb", Location: coordinates(1, 1)}}},
		{ID: "c", MaxPatients: 3, Members: []Member{{ID: "mc", Location: coordinates(2, 2)}}},
	}
	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, assignment := range got.Assignments {
		if assignment.PatientID != "p3" {
			counts[assignment.TeamID]++
		}
	}
	if got.ResultStatus != "optimal" || len(got.Assignments) != 3 || len(counts) != 2 {
		t.Fatalf("expected two different teams for eligible patients, got %+v", got.Assignments)
	}
}

func TestPECDistributionReportsInfeasibleForConflictingEligibility(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous", EligiblePEC100: true, EligibleTeamIDs: []string{"a"}},
		{ID: "p2", Location: coordinates(0, 0), Parity: "multiparous", EligiblePEC100: true, EligibleTeamIDs: []string{"a"}},
	}
	req.Teams = []Team{
		{ID: "a", MaxPatients: 2, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}},
		{ID: "b", MaxPatients: 2, Members: []Member{{ID: "mb", Location: coordinates(0, 0)}}},
	}
	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "infeasible" || len(got.Assignments) != 0 {
		t.Fatalf("expected infeasible with conflicting eligibility, got %+v", got)
	}
}

func TestCalculateDetectsEligibilityInfeasibility(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous", EligibleTeamIDs: []string{"a"}},
		{ID: "p2", Location: coordinates(0, 0.01), Parity: "multiparous", EligibleTeamIDs: []string{"a"}},
	}
	req.Teams = []Team{
		{ID: "a", MinPatients: 1, MaxPatients: 1, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}},
		{ID: "b", MinPatients: 1, MaxPatients: 1, Members: []Member{{ID: "mb", Location: coordinates(1, 1)}}},
	}

	got, err := Calculate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "infeasible" {
		t.Fatalf("result status = %q, want infeasible", got.ResultStatus)
	}
	if len(got.Issues) == 0 {
		t.Fatal("expected an infeasibility explanation")
	}
}

func TestCalculateRejectsUnknownParity(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{{ID: "p1", Location: coordinates(0, 0), Parity: "unknown"}}
	req.Teams = []Team{{ID: "a", MinPatients: 1, MaxPatients: 1, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}}}

	_, err := Calculate(context.Background(), req)
	if _, ok := err.(*ValidationError); !ok {
		t.Fatalf("unknown parity should be rejected, got %v", err)
	}
}

func TestUnresolvedRequiredRoutePreventsAssignment(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{{ID: "p1", Location: coordinates(0, 0), Parity: "multiparous"}}
	req.Teams = []Team{{ID: "a", MinPatients: 1, MaxPatients: 1, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}}}
	provider := &testRouteProvider{
		name: "Google Routes API",
		matrix: RouteMatrix{
			Costs:            [][]float64{{0}},
			UnresolvedRoutes: []UnresolvedRoute{{PatientID: "p1", TeamID: "a", MemberID: "ma", Code: "route_not_found"}},
		},
	}

	got, err := CalculateWithProvider(context.Background(), req, provider, 625)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultStatus != "needs_review" || got.Solver.Status != "not_run" || len(got.Assignments) != 0 || got.Scores != nil {
		t.Fatalf("unresolved route should block assignment: %+v", got)
	}
}

func TestPerCalculationRouteLimitRejectsBeforeProviderCall(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{
		{ID: "p1", Location: coordinates(0, 0), Parity: "primiparous"},
		{ID: "p2", Location: coordinates(0, 0.01), Parity: "multiparous"},
	}
	req.Teams = []Team{{ID: "a", MinPatients: 0, MaxPatients: 2, Members: []Member{{ID: "ma", Location: coordinates(0, 0)}}}}
	provider := &testRouteProvider{name: "Google Routes API", routeModes: 2}

	_, err := CalculateWithProvider(context.Background(), req, provider, 3)
	if err == nil {
		t.Fatal("expected the per-calculation route limit to reject the request")
	}
	if provider.calls != 0 {
		t.Fatalf("provider was called %d times before limit validation", provider.calls)
	}
}

func TestGoogleProviderAcceptsAddressAndPlaceIDLocations(t *testing.T) {
	req := baseRequest()
	req.Cohort.Patients = []Patient{{ID: "p1", Location: Location{Address: "10 rue de Rivoli, Paris"}, Parity: "primiparous"}}
	req.Teams = []Team{{
		ID: "a", MinPatients: 1, MaxPatients: 1,
		Members: []Member{{ID: "ma", Location: Location{PlaceID: "ChIJsynthetic"}}},
	}}
	provider := &testRouteProvider{
		name:         "Google Routes API",
		supportsText: true,
		matrix: RouteMatrix{
			Costs: [][]float64{{600}},
			CandidateCosts: []CandidateTravelCost{{
				PatientID: "p1", TeamID: "a", MeanSeconds: 600,
				MemberSeconds: []MemberSeconds{{MemberID: "ma", Seconds: 600}},
			}},
		},
	}

	got, err := CalculateWithProvider(context.Background(), req, provider, 625)
	if err != nil {
		t.Fatal(err)
	}
	if provider.calls != 1 || got.ResultStatus != "optimal" || len(got.Assignments) != 1 {
		t.Fatalf("expected the text locations to route and assign: calls=%d result=%+v", provider.calls, got)
	}
}

type testRouteProvider struct {
	name         string
	matrix       RouteMatrix
	calls        int
	supportsText bool
	routeModes   int
}

func (p *testRouteProvider) Name() string              { return p.name }
func (p *testRouteProvider) RoutingPreference() string { return "TEST" }
func (p *testRouteProvider) RouteModesPerPair() int {
	if p.routeModes == 0 {
		return 1
	}
	return p.routeModes
}
func (p *testRouteProvider) SupportsTextLocations() bool { return p.supportsText }
func (p *testRouteProvider) Compute(context.Context, Request) (RouteMatrix, error) {
	p.calls++
	return p.matrix, nil
}

func baseRequest() Request {
	return Request{
		RequestID: "request-token",
		Cohort:    Cohort{ID: "cohort-token", Revision: 1, ExpectedDeliveryMonth: "2027-04", ExpectedDeliveryHalf: 1},
		Settings: Settings{
			Weights:                    Weights{Capacity: 0.2, Geography: 0.6, Parity: 0.2},
			ReferenceTravelTimeMinutes: 30,
		},
	}
}

func coordinates(latitude, longitude float64) Location {
	return Location{LatLng: &LatLng{Latitude: latitude, Longitude: longitude}}
}
