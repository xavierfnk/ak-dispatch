package dispatch

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

const (
	maxPatients  = 40
	maxTeams     = 20
	maxMembers   = 250
	maxCapacity  = 1_000_000
	meanSpeedMPS = 30_000.0 / 3_600
)

var fixedWeights = Weights{Capacity: 0.8, Geography: 0.15, Parity: 0.05}

var monthPattern = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

func Calculate(ctx context.Context, req Request) (Response, error) {
	return CalculateWithProvider(ctx, req, NewMockRouteProvider(), 0)
}

func CalculateWithProvider(ctx context.Context, req Request, provider RouteProvider, maxRouteElements int) (Response, error) {
	if provider == nil {
		return Response{}, fmt.Errorf("route provider is required")
	}
	req.Settings.Weights = fixedWeights
	if issues := validate(req, provider.SupportsTextLocations()); len(issues) > 0 {
		return Response{}, &ValidationError{Issues: issues}
	}

	effectiveWeights := fixedWeights
	knownParity, batchPrimiparous := parityTotals(req.Cohort.Patients)
	if knownParity == 0 {
		total := effectiveWeights.Capacity + effectiveWeights.Geography
		effectiveWeights = Weights{
			Capacity:  effectiveWeights.Capacity / total,
			Geography: effectiveWeights.Geography / total,
			Parity:    0,
		}
	}

	resp := Response{
		RequestID:    req.RequestID,
		ResultStatus: "infeasible",
		Solver: SolverSummary{
			Name:   "exact local branch-and-bound",
			Status: "infeasible",
		},
		RouteLookup: RouteLookupSummary{
			Provider:          provider.Name(),
			RoutingPreference: provider.RoutingPreference(),
		},
		Settings: SettingsSummary{
			ConfiguredWeights:          req.Settings.Weights,
			EffectiveWeights:           effectiveWeights,
			ReferenceTravelTimeMinutes: req.Settings.ReferenceTravelTimeMinutes,
		},
		Assignments:            []Assignment{},
		Teams:                  []TeamSummary{},
		CandidateTravelCosts:   []CandidateTravelCost{},
		AssignmentExplanations: []AssignmentExplanation{},
		UnresolvedRoutes:       []UnresolvedRoute{},
		Issues:                 []string{},
	}

	minTotal, maxTotal := 0, 0
	for _, team := range req.Teams {
		minTotal += team.MinPatients
		maxTotal += team.MaxPatients
	}
	if len(req.Cohort.Patients) < minTotal || len(req.Cohort.Patients) > maxTotal {
		resp.Issues = append(resp.Issues, "Aggregate team capacity cannot fit this cohort.")
		return resp, nil
	}

	requiredRouteElements := routeElementCount(req) * provider.RouteModesPerPair()
	if maxRouteElements > 0 && requiredRouteElements > maxRouteElements {
		return Response{}, &ValidationError{Issues: []string{fmt.Sprintf("This calculation requires %d route elements; the configured per-calculation limit is %d.", requiredRouteElements, maxRouteElements)}}
	}

	resp.RouteLookup.LookedUpAt = time.Now().UTC().Format(time.RFC3339)
	matrix, err := provider.Compute(ctx, req)
	if err != nil {
		return Response{}, err
	}
	if err := validateMatrix(matrix, len(req.Teams), len(req.Cohort.Patients)); err != nil {
		return Response{}, err
	}
	resp.RouteLookup.ElementCount = matrix.ElementCount
	resp.CandidateTravelCosts = matrix.CandidateCosts
	resp.UnresolvedRoutes = matrix.UnresolvedRoutes
	if len(matrix.UnresolvedRoutes) > 0 {
		resp.ResultStatus = "needs_review"
		resp.Solver.Status = "not_run"
		resp.Issues = append(resp.Issues, "One or more required member routes are unresolved. Correct the locations before calculating assignments.")
		return resp, nil
	}

	started := time.Now()
	search, err := optimize(ctx, req, matrix.Costs, effectiveWeights)
	resp.Solver.RuntimeMs = time.Since(started).Milliseconds()
	if err != nil {
		return Response{}, err
	}
	resp.Solver.Status = search.status
	if search.status == "infeasible" {
		resp.Issues = append(resp.Issues, "No complete assignment satisfies team capacities and eligibility restrictions.")
		return resp, nil
	}
	if search.status == "time_limit" {
		resp.ResultStatus = "needs_review"
		resp.Issues = append(resp.Issues, "The local search reached its time limit before finding a complete assignment.")
		return resp, nil
	}

	if search.status == "optimal" {
		resp.ResultStatus = "optimal"
	} else {
		resp.ResultStatus = "feasible"
		bound := 0.0 // Scores are non-negative, so zero is a valid coarse lower bound.
		resp.Solver.BestBound = &bound
		if search.objective > 0 {
			gap := (search.objective - bound) / math.Abs(search.objective)
			resp.Solver.RelativeGap = &gap
		}
	}
	objective := search.objective
	resp.Solver.Objective = &objective

	teamForPatient := make([]int, len(req.Cohort.Patients))
	for patientIndex, teamIndex := range search.assignment {
		teamForPatient[patientIndex] = teamIndex
		resp.Assignments = append(resp.Assignments, Assignment{
			PatientID: req.Cohort.Patients[patientIndex].ID,
			TeamID:    req.Teams[teamIndex].ID,
		})
	}
	resp.Scores, resp.Teams = summarize(req, teamForPatient, matrix.Costs, effectiveWeights, knownParity, batchPrimiparous)
	resp.AssignmentExplanations = explainAssignments(req, search.assignment, matrix.Costs, matrix.CandidateCosts, effectiveWeights)
	return resp, nil
}

func validate(req Request, supportsTextLocations bool) []string {
	var issues []string
	if strings.TrimSpace(req.RequestID) == "" {
		issues = append(issues, "A request token is required.")
	}
	if strings.TrimSpace(req.Cohort.ID) == "" || !monthPattern.MatchString(req.Cohort.ExpectedDeliveryMonth) || (req.Cohort.ExpectedDeliveryHalf != 1 && req.Cohort.ExpectedDeliveryHalf != 2) || req.Cohort.Revision < 0 {
		issues = append(issues, "Cohort token, delivery period, and non-negative revision are required.")
	}
	if len(req.Cohort.Patients) > maxPatients {
		issues = append(issues, fmt.Sprintf("The local optimizer supports at most %d patients per calculation.", maxPatients))
	}
	if len(req.Teams) > maxTeams {
		issues = append(issues, fmt.Sprintf("The local optimizer supports at most %d teams per calculation.", maxTeams))
	}

	ids := map[string]bool{}
	addID := func(id string) {
		if strings.TrimSpace(id) == "" || ids[id] {
			issues = append(issues, "Patient, team, and member request tokens must be non-empty and unique.")
			return
		}
		ids[id] = true
	}
	teamIDs := make(map[string]bool, len(req.Teams))
	for _, team := range req.Teams {
		addID(team.ID)
		teamIDs[team.ID] = true
	}
	for _, patient := range req.Cohort.Patients {
		addID(patient.ID)
		if patient.Parity != "primiparous" && patient.Parity != "multiparous" {
			issues = append(issues, "Patient parity must be primiparous or multiparous.")
		}
		if err := validateLocation(patient.Location, supportsTextLocations); err != "" {
			issues = append(issues, err)
		}
		seenEligible := map[string]bool{}
		for _, teamID := range patient.EligibleTeamIDs {
			if !teamIDs[teamID] || seenEligible[teamID] {
				issues = append(issues, "Eligibility restrictions must reference unique teams in this request.")
				break
			}
			seenEligible[teamID] = true
		}
	}
	totalMembers := 0
	for _, team := range req.Teams {
		if team.MinPatients < 0 || team.MaxPatients < team.MinPatients || team.MaxPatients > maxCapacity {
			issues = append(issues, fmt.Sprintf("Team capacities must be ordered non-negative integers no greater than %d.", maxCapacity))
		}
		if len(team.Members) == 0 {
			issues = append(issues, "Every team must have at least one member.")
		}
		totalMembers += len(team.Members)
		for _, member := range team.Members {
			addID(member.ID)
			if err := validateLocation(member.Location, supportsTextLocations); err != "" {
				issues = append(issues, err)
			}
		}
	}
	if totalMembers > maxMembers {
		issues = append(issues, fmt.Sprintf("The local optimizer supports at most %d team members per calculation.", maxMembers))
	}

	w := req.Settings.Weights
	weightSum := w.Capacity + w.Geography + w.Parity
	if !finite(w.Capacity) || !finite(w.Geography) || !finite(w.Parity) || w.Capacity < 0 || w.Geography < 0 || w.Parity < 0 || math.Abs(weightSum-1) > 1e-6 {
		issues = append(issues, "Objective weights must be non-negative and sum to 1.")
	}
	if !finite(req.Settings.ReferenceTravelTimeMinutes) || req.Settings.ReferenceTravelTimeMinutes <= 0 {
		issues = append(issues, "Reference travel time must be positive.")
	}
	known, _ := parityTotals(req.Cohort.Patients)
	if known == 0 && w.Capacity+w.Geography <= 0 {
		issues = append(issues, "Capacity or geography must have a positive weight when parity is unavailable.")
	}
	return issues
}

func validateLocation(location Location, supportsTextLocations bool) string {
	address := strings.TrimSpace(location.Address)
	placeID := strings.TrimSpace(location.PlaceID)
	representations := 0
	if address != "" {
		representations++
	}
	if placeID != "" {
		representations++
	}
	if location.LatLng != nil {
		representations++
	}
	if representations != 1 {
		return "Each location must contain exactly one address, place ID, or coordinate pair."
	}
	if address != "" && len(address) > 500 {
		return "Location address is too long."
	}
	if placeID != "" && len(placeID) > 512 {
		return "Location place ID is too long."
	}
	if (address != "" || placeID != "") && !supportsTextLocations {
		return "The local mock requires coordinates; configure Google Maps to use addresses or place IDs."
	}
	if location.LatLng != nil {
		lat, lng := location.LatLng.Latitude, location.LatLng.Longitude
		if !finite(lat) || !finite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 {
			return "Location coordinates are outside the supported latitude/longitude ranges."
		}
	}
	return ""
}

func validateMatrix(matrix RouteMatrix, teamCount, patientCount int) error {
	if len(matrix.Costs) != teamCount {
		return fmt.Errorf("route provider returned an invalid matrix")
	}
	for _, row := range matrix.Costs {
		if len(row) != patientCount {
			return fmt.Errorf("route provider returned an invalid matrix")
		}
		for _, seconds := range row {
			if !finite(seconds) || seconds < 0 {
				return fmt.Errorf("route provider returned an invalid duration")
			}
		}
	}
	return nil
}

func routeElementCount(req Request) int {
	elements := 0
	for _, team := range req.Teams {
		elements += len(team.Members) * len(req.Cohort.Patients)
	}
	return elements
}

func straightLineSeconds(a, b LatLng) int64 {
	const earthRadiusMeters = 6_371_000.0
	lat1, lat2 := a.Latitude*math.Pi/180, b.Latitude*math.Pi/180
	dLat := (b.Latitude - a.Latitude) * math.Pi / 180
	dLng := (b.Longitude - a.Longitude) * math.Pi / 180
	h := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLng/2)*math.Sin(dLng/2)
	h = math.Min(1, math.Max(0, h))
	distance := 2 * earthRadiusMeters * math.Asin(math.Sqrt(h))
	return int64(math.Round(distance / meanSpeedMPS))
}

func parityTotals(patients []Patient) (known, primiparous int) {
	for _, patient := range patients {
		switch patient.Parity {
		case "primiparous":
			known++
			primiparous++
		case "multiparous":
			known++
		}
	}
	return known, primiparous
}

func summarize(req Request, assignment []int, costs [][]float64, weights Weights, known, primiparous int) (*Scores, []TeamSummary) {
	teamLoads := make([]int, len(req.Teams))
	teamPrim := make([]int, len(req.Teams))
	teamMulti := make([]int, len(req.Teams))
	var totalTravel float64
	for patientIndex, teamIndex := range assignment {
		teamLoads[teamIndex]++
		totalTravel += costs[teamIndex][patientIndex]
		switch req.Cohort.Patients[patientIndex].Parity {
		case "primiparous":
			teamPrim[teamIndex]++
		case "multiparous":
			teamMulti[teamIndex]++
		}
	}

	capacityScore := 0.0
	if len(req.Teams) > 0 {
		for index, team := range req.Teams {
			if team.MaxPatients > team.MinPatients {
				capacityScore += math.Abs(float64(2*teamLoads[index]-team.MinPatients-team.MaxPatients)) / float64(team.MaxPatients-team.MinPatients)
			}
		}
		capacityScore /= float64(len(req.Teams))
	}
	geographyScore := 0.0
	if len(assignment) > 0 {
		geographyScore = totalTravel / (float64(len(assignment)) * req.Settings.ReferenceTravelTimeMinutes * 60)
	}

	var parityScore *float64
	if known > 0 {
		deviation := 0.0
		for index := range req.Teams {
			deviation += math.Abs(float64(known*teamPrim[index] - primiparous*(teamPrim[index]+teamMulti[index])))
		}
		value := deviation / float64(known*known)
		parityScore = &value
	}

	total := weights.Capacity*capacityScore + weights.Geography*geographyScore
	if parityScore != nil {
		total += weights.Parity * *parityScore
	}
	scores := &Scores{Capacity: capacityScore, Geography: geographyScore, Parity: parityScore, Total: total}

	batchRatio := (*float64)(nil)
	if known > 0 {
		ratio := float64(primiparous) / float64(known)
		batchRatio = &ratio
	}
	teamSummaries := make([]TeamSummary, 0, len(req.Teams))
	for index, team := range req.Teams {
		summary := TeamSummary{
			TeamID:                      team.ID,
			AssignedCount:               teamLoads[index],
			MinPatients:                 team.MinPatients,
			MaxPatients:                 team.MaxPatients,
			PrimiparousCount:            teamPrim[index],
			MultiparousCount:            teamMulti[index],
			BatchTargetPrimiparousRatio: batchRatio,
		}
		teamKnown := teamPrim[index] + teamMulti[index]
		if teamKnown > 0 {
			knownRatio := float64(teamPrim[index]) / float64(teamKnown)
			mixDeviation := math.Abs(float64(teamPrim[index]) - float64(primiparous)/float64(known)*float64(teamKnown))
			summary.KnownParityRatio = &knownRatio
			summary.MixDeviation = &mixDeviation
		}
		teamSummaries = append(teamSummaries, summary)
	}
	return scores, teamSummaries
}

func explainAssignments(req Request, assignment []int, costs [][]float64, candidates []CandidateTravelCost, weights Weights) []AssignmentExplanation {
	teamLoads := make([]int, len(req.Teams))
	teamPrim := make([]int, len(req.Teams))
	teamKnown := make([]int, len(req.Teams))
	known, primiparous := parityTotals(req.Cohort.Patients)
	for patientIndex, teamIndex := range assignment {
		teamLoads[teamIndex]++
		teamKnown[teamIndex]++
		if req.Cohort.Patients[patientIndex].Parity == "primiparous" {
			teamPrim[teamIndex]++
		}
	}

	costByPair := make(map[[2]string]CandidateTravelCost, len(candidates))
	for _, candidate := range candidates {
		costByPair[[2]string{candidate.TeamID, candidate.PatientID}] = candidate
	}
	batchRatio := 0.0
	if known > 0 {
		batchRatio = float64(primiparous) / float64(known)
	}

	result := make([]AssignmentExplanation, 0, len(assignment)*len(req.Teams))
	for patientIndex, teamIndex := range assignment {
		patient := req.Cohort.Patients[patientIndex]
		for candidateTeamIndex, team := range req.Teams {
			if len(patient.EligibleTeamIDs) > 0 && !contains(patient.EligibleTeamIDs, team.ID) {
				continue
			}
			candidate := costByPair[[2]string{team.ID, patient.ID}]
			closestMemberID, closestMemberSeconds := "", int64(0)
			if len(candidate.MemberSeconds) > 0 {
				closest := candidate.MemberSeconds[0]
				for _, member := range candidate.MemberSeconds[1:] {
					if member.Seconds < closest.Seconds {
						closest = member
					}
				}
				closestMemberID, closestMemberSeconds = closest.MemberID, closest.Seconds
			}

			finalLoad := teamLoads[candidateTeamIndex]
			finalPrim := teamPrim[candidateTeamIndex]
			finalKnown := teamKnown[candidateTeamIndex]
			if candidateTeamIndex != teamIndex {
				finalLoad++
				if patient.Parity == "primiparous" {
					finalPrim++
					finalKnown++
				} else if patient.Parity == "multiparous" {
					finalKnown++
				}
			}
			capacityScore := 100.0
			if width := team.MaxPatients - team.MinPatients; width > 0 {
				deviation := math.Abs(float64(2*finalLoad-team.MinPatients-team.MaxPatients)) / float64(width)
				capacityScore = math.Max(0, (1-deviation)*100)
			}
			assignedTravel := costs[candidateTeamIndex][patientIndex]
			nearestTravel := assignedTravel
			for eligibleTeamIndex, eligibleTeam := range req.Teams {
				if (len(patient.EligibleTeamIDs) == 0 || contains(patient.EligibleTeamIDs, eligibleTeam.ID)) && costs[eligibleTeamIndex][patientIndex] < nearestTravel {
					nearestTravel = costs[eligibleTeamIndex][patientIndex]
				}
			}
			geographyScore := 100.0
			if assignedTravel > 0 {
				geographyScore = math.Min(100, nearestTravel/assignedTravel*100)
			}
			parityScore := 100.0
			if finalKnown > 0 {
				teamRatio := float64(finalPrim) / float64(finalKnown)
				parityScore = (1 - math.Abs(teamRatio-batchRatio)) * 100
			}
			criteria := CriteriaScores{Capacity: capacityScore, Geography: geographyScore, Parity: parityScore}
			matchScore := weights.Capacity*capacityScore + weights.Geography*geographyScore + weights.Parity*parityScore
			result = append(result, AssignmentExplanation{
				PatientID:            patient.ID,
				TeamID:               team.ID,
				MeanTravelSeconds:    assignedTravel,
				ClosestMemberID:      closestMemberID,
				ClosestMemberSeconds: closestMemberSeconds,
				MatchScore:           matchScore,
				CriteriaScores:       criteria,
			})
		}
	}
	return result
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
