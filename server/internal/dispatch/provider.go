package dispatch

import (
	"context"
	"fmt"
)

type straightLineProvider struct{}

func NewMockRouteProvider() RouteProvider { return straightLineProvider{} }

func (straightLineProvider) Name() string                { return "Local mock" }
func (straightLineProvider) RoutingPreference() string   { return "STRAIGHT_LINE_AT_30_KMH" }
func (straightLineProvider) RouteModesPerPair() int      { return 1 }
func (straightLineProvider) SupportsTextLocations() bool { return false }

func (straightLineProvider) Compute(_ context.Context, req Request) (RouteMatrix, error) {
	teamCount := len(req.Teams)
	patientCount := len(req.Cohort.Patients)
	matrix := RouteMatrix{
		ElementCount:     routeElementCount(req),
		Costs:            make([][]float64, teamCount),
		CandidateCosts:   make([]CandidateTravelCost, 0, teamCount*patientCount),
		UnresolvedRoutes: []UnresolvedRoute{},
	}
	for teamIndex, team := range req.Teams {
		matrix.Costs[teamIndex] = make([]float64, patientCount)
		for patientIndex, patient := range req.Cohort.Patients {
			totalSeconds := int64(0)
			memberSeconds := make([]MemberSeconds, 0, len(team.Members))
			for _, member := range team.Members {
				if member.Location.LatLng == nil || patient.Location.LatLng == nil {
					return RouteMatrix{}, fmt.Errorf("mock route provider received a non-coordinate location")
				}
				seconds := straightLineSeconds(*member.Location.LatLng, *patient.Location.LatLng)
				totalSeconds += seconds
				memberSeconds = append(memberSeconds, MemberSeconds{MemberID: member.ID, Seconds: seconds, TravelMode: "STRAIGHT_LINE"})
			}
			meanSeconds := float64(totalSeconds) / float64(len(team.Members))
			matrix.Costs[teamIndex][patientIndex] = meanSeconds
			matrix.CandidateCosts = append(matrix.CandidateCosts, CandidateTravelCost{
				PatientID:     patient.ID,
				TeamID:        team.ID,
				MeanSeconds:   meanSeconds,
				MemberSeconds: memberSeconds,
			})
		}
	}
	return matrix, nil
}
