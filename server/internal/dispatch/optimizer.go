package dispatch

import (
	"context"
	"math"
	"sort"
	"time"
)

const searchLimit = 2 * time.Second

type searchResult struct {
	assignment         []int
	objective          float64
	capacityObjective  float64
	secondaryObjective float64
	status             string
}

type objectiveBound struct {
	capacity  float64
	secondary float64
}

func optimize(ctx context.Context, req Request, costs [][]float64, weights Weights) (searchResult, error) {
	started := time.Now()
	patients := req.Cohort.Patients
	teams := req.Teams
	n, teamCount := len(patients), len(teams)
	options := make([][]int, n)
	for patientIndex, patient := range patients {
		for teamIndex, team := range teams {
			if len(patient.EligibleTeamIDs) == 0 || contains(patient.EligibleTeamIDs, team.ID) {
				options[patientIndex] = append(options[patientIndex], teamIndex)
			}
		}
		if len(options[patientIndex]) == 0 {
			return searchResult{status: "infeasible"}, nil
		}
		sort.Slice(options[patientIndex], func(i, j int) bool {
			a, b := options[patientIndex][i], options[patientIndex][j]
			if costs[a][patientIndex] == costs[b][patientIndex] {
				return teams[a].ID < teams[b].ID
			}
			return costs[a][patientIndex] < costs[b][patientIndex]
		})
	}

	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if len(options[a]) != len(options[b]) {
			return len(options[a]) < len(options[b])
		}
		return patients[a].ID < patients[b].ID
	})

	remainingEligible := make([][]int, n+1)
	for i := range remainingEligible {
		remainingEligible[i] = make([]int, teamCount)
	}
	for depth := n - 1; depth >= 0; depth-- {
		copy(remainingEligible[depth], remainingEligible[depth+1])
		for _, teamIndex := range options[order[depth]] {
			remainingEligible[depth][teamIndex]++
		}
	}

	loads := make([]int, teamCount)
	assignment := make([]int, n)
	best := searchResult{objective: math.Inf(1)}
	found := false
	timedOut := false
	deadline := started.Add(searchLimit)
	known, primiparous := parityTotals(patients)

	var visit func(depth int, geographySeconds float64)
	visit = func(depth int, geographySeconds float64) {
		if ctx.Err() != nil || timedOut {
			return
		}
		if time.Now().After(deadline) {
			timedOut = true
			return
		}
		if !canStillFit(depth, n, teams, loads, remainingEligible[depth]) {
			return
		}
		if found && cannotBeat(lowerBound(depth, n, teams, loads, remainingEligible[depth], order, options, costs, geographySeconds, req.Settings.ReferenceTravelTimeMinutes, weights), best) {
			return
		}
		if depth == n {
			scores, _ := summarize(req, assignment, costs, weights, known, primiparous)
			secondary := weights.Geography * scores.Geography
			if scores.Parity != nil {
				secondary += weights.Parity * *scores.Parity
			}
			if !found || scores.Capacity < best.capacityObjective-1e-12 || (math.Abs(scores.Capacity-best.capacityObjective) <= 1e-12 && secondary < best.secondaryObjective-1e-12) {
				best = searchResult{
					assignment:         append([]int(nil), assignment...),
					objective:          scores.Total,
					capacityObjective:  scores.Capacity,
					secondaryObjective: secondary,
					status:             "optimal",
				}
				found = true
			}
			return
		}

		patientIndex := order[depth]
		for _, teamIndex := range options[patientIndex] {
			if loads[teamIndex] >= teams[teamIndex].MaxPatients {
				continue
			}
			loads[teamIndex]++
			assignment[patientIndex] = teamIndex
			visit(depth+1, geographySeconds+costs[teamIndex][patientIndex])
			loads[teamIndex]--
			if timedOut || ctx.Err() != nil {
				return
			}
		}
	}

	visit(0, 0)
	if err := ctx.Err(); err != nil {
		return searchResult{}, err
	}
	if timedOut {
		if found {
			best.status = "feasible"
			return best, nil
		}
		return searchResult{status: "time_limit"}, nil
	}
	if !found {
		return searchResult{status: "infeasible"}, nil
	}
	return best, nil
}

func canStillFit(depth, patientCount int, teams []Team, loads, remainingEligible []int) bool {
	remaining := patientCount - depth
	freeSlots, minNeeded := 0, 0
	for i, team := range teams {
		if loads[i]+remainingEligible[i] < team.MinPatients {
			return false
		}
		freeSlots += team.MaxPatients - loads[i]
		if loads[i] < team.MinPatients {
			minNeeded += team.MinPatients - loads[i]
		}
	}
	return freeSlots >= remaining && minNeeded <= remaining
}

func lowerBound(
	depth, patientCount int,
	teams []Team,
	loads, remainingEligible []int,
	order []int,
	options [][]int,
	costs [][]float64,
	geographySeconds, referenceMinutes float64,
	weights Weights,
) objectiveBound {
	geographyLowerBound := geographySeconds
	for _, patientIndex := range order[depth:] {
		minCost := math.Inf(1)
		for _, teamIndex := range options[patientIndex] {
			if loads[teamIndex] < teams[teamIndex].MaxPatients && costs[teamIndex][patientIndex] < minCost {
				minCost = costs[teamIndex][patientIndex]
			}
		}
		if math.IsInf(minCost, 1) {
			return objectiveBound{capacity: math.Inf(1), secondary: math.Inf(1)}
		}
		geographyLowerBound += minCost
	}

	capacityLowerBound := 0.0
	for index, team := range teams {
		width := team.MaxPatients - team.MinPatients
		if width == 0 {
			continue
		}
		low := max(loads[index], team.MinPatients)
		high := min(team.MaxPatients, loads[index]+remainingEligible[index])
		if low > high {
			return objectiveBound{capacity: math.Inf(1), secondary: math.Inf(1)}
		}
		midpoint := float64(team.MinPatients+team.MaxPatients) / 2
		loCandidate := max(low, min(high, int(math.Floor(midpoint))))
		hiCandidate := max(low, min(high, int(math.Ceil(midpoint))))
		deviation := math.Min(
			math.Abs(float64(2*loCandidate-team.MinPatients-team.MaxPatients))/float64(width),
			math.Abs(float64(2*hiCandidate-team.MinPatients-team.MaxPatients))/float64(width),
		)
		capacityLowerBound += deviation
	}
	if len(teams) > 0 {
		capacityLowerBound /= float64(len(teams))
	}
	geographyScoreLowerBound := 0.0
	if patientCount > 0 {
		geographyScoreLowerBound = geographyLowerBound / (float64(patientCount) * referenceMinutes * 60)
	}
	return objectiveBound{
		capacity:  capacityLowerBound,
		secondary: weights.Geography * geographyScoreLowerBound,
	}
}

func cannotBeat(bound objectiveBound, best searchResult) bool {
	const tolerance = 1e-12
	if bound.capacity > best.capacityObjective+tolerance {
		return true
	}
	return math.Abs(bound.capacity-best.capacityObjective) <= tolerance && bound.secondary >= best.secondaryObjective-tolerance
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
