import type { CalculateRequest } from "../types";
import type { AssignmentExplanation, CandidateTravelCost, Scores, TeamSummary, Weights } from "./types";
import { contains } from "./utils.ts";

export function parityTotals(patients: CalculateRequest["cohort"]["patients"]): { known: number; primiparous: number } {
  let known = 0;
  let primiparous = 0;
  for (const patient of patients) {
    switch (patient.parity) {
      case "primiparous":
        known++;
        primiparous++;
        break;
      case "multiparous":
        known++;
        break;
    }
  }
  return { known, primiparous };
}

export function summarize(
  request: CalculateRequest,
  assignment: number[],
  costs: number[][],
  weights: Weights,
  known: number,
  primiparous: number,
): { scores: Scores; teams: TeamSummary[] } {
  const teamLoads = new Array<number>(request.teams.length).fill(0);
  const teamPrim = new Array<number>(request.teams.length).fill(0);
  const teamMulti = new Array<number>(request.teams.length).fill(0);
  let totalTravel = 0;
  assignment.forEach((teamIndex, patientIndex) => {
    teamLoads[teamIndex]++;
    totalTravel += costs[teamIndex][patientIndex];
    switch (request.cohort.patients[patientIndex].parity) {
      case "primiparous":
        teamPrim[teamIndex]++;
        break;
      case "multiparous":
        teamMulti[teamIndex]++;
        break;
    }
  });

  let capacityScore = 0;
  if (request.teams.length > 0) {
    request.teams.forEach((team, index) => {
      if (team.maxPatients > team.minPatients) {
        capacityScore += Math.abs(2 * teamLoads[index] - team.minPatients - team.maxPatients) / (team.maxPatients - team.minPatients);
      }
    });
    capacityScore /= request.teams.length;
  }

  let geographyScore = 0;
  if (assignment.length > 0) {
    geographyScore = totalTravel / (assignment.length * request.settings.referenceTravelTimeMinutes * 60);
  }

  let parityScore: number | null = null;
  if (known > 0) {
    let deviation = 0;
    for (let index = 0; index < request.teams.length; index++) {
      deviation += Math.abs(known * teamPrim[index] - primiparous * (teamPrim[index] + teamMulti[index]));
    }
    parityScore = deviation / (known * known);
  }

  let total = weights.capacity * capacityScore + weights.geography * geographyScore;
  if (parityScore !== null) total += weights.parity * parityScore;
  const scores: Scores = { capacity: capacityScore, geography: geographyScore, parity: parityScore, total };

  let batchRatio: number | null = null;
  if (known > 0) batchRatio = primiparous / known;
  const teamSummaries = request.teams.map((team, index): TeamSummary => {
    const summary: TeamSummary = {
      teamId: team.id,
      assignedCount: teamLoads[index],
      minPatients: team.minPatients,
      maxPatients: team.maxPatients,
      primiparousCount: teamPrim[index],
      multiparousCount: teamMulti[index],
      knownParityRatio: null,
      batchTargetPrimiparousRatio: batchRatio,
      mixDeviation: null,
    };
    const teamKnown = teamPrim[index] + teamMulti[index];
    if (teamKnown > 0 && batchRatio !== null) {
      summary.knownParityRatio = teamPrim[index] / teamKnown;
      summary.mixDeviation = Math.abs(teamPrim[index] - batchRatio * teamKnown);
    }
    return summary;
  });
  return { scores, teams: teamSummaries };
}

export function explainAssignments(
  request: CalculateRequest,
  assignment: number[],
  costs: number[][],
  candidates: CandidateTravelCost[],
  weights: Weights,
): AssignmentExplanation[] {
  const teamLoads = new Array<number>(request.teams.length).fill(0);
  const teamPrim = new Array<number>(request.teams.length).fill(0);
  const teamKnown = new Array<number>(request.teams.length).fill(0);
  const { known, primiparous } = parityTotals(request.cohort.patients);
  assignment.forEach((teamIndex, patientIndex) => {
    teamLoads[teamIndex]++;
    teamKnown[teamIndex]++;
    if (request.cohort.patients[patientIndex].parity === "primiparous") teamPrim[teamIndex]++;
  });

  const costByPair = new Map<string, CandidateTravelCost>();
  for (const candidate of candidates) {
    costByPair.set(`${candidate.teamId}\u0000${candidate.patientId}`, candidate);
  }
  const batchRatio = known > 0 ? primiparous / known : 0;

  const result: AssignmentExplanation[] = [];
  assignment.forEach((teamIndex, patientIndex) => {
    const patient = request.cohort.patients[patientIndex];
    request.teams.forEach((team, candidateTeamIndex) => {
      if (patient.eligibleTeamIds?.length && !contains(patient.eligibleTeamIds, team.id)) return;
      const candidate = costByPair.get(`${team.id}\u0000${patient.id}`);
      const memberSeconds = candidate?.memberSeconds ?? [];
      let closestMemberId = "";
      let closestMemberSeconds = 0;
      if (memberSeconds.length > 0) {
        let closest = memberSeconds[0];
        for (const member of memberSeconds.slice(1)) {
          if (member.seconds < closest.seconds) closest = member;
        }
        closestMemberId = closest.memberId;
        closestMemberSeconds = closest.seconds;
      }

      let finalLoad = teamLoads[candidateTeamIndex];
      let finalPrim = teamPrim[candidateTeamIndex];
      let finalKnown = teamKnown[candidateTeamIndex];
      if (candidateTeamIndex !== teamIndex) {
        finalLoad++;
        if (patient.parity === "primiparous") {
          finalPrim++;
          finalKnown++;
        } else if (patient.parity === "multiparous") {
          finalKnown++;
        }
      }

      let capacityScore = 100;
      if (team.maxPatients > team.minPatients) {
        const deviation = Math.abs(2 * finalLoad - team.minPatients - team.maxPatients) / (team.maxPatients - team.minPatients);
        capacityScore = Math.max(0, (1 - deviation) * 100);
      }

      const assignedTravel = costs[candidateTeamIndex][patientIndex];
      let nearestTravel = assignedTravel;
      request.teams.forEach((eligibleTeam, eligibleTeamIndex) => {
        if (!patient.eligibleTeamIds?.length || contains(patient.eligibleTeamIds, eligibleTeam.id)) {
          if (costs[eligibleTeamIndex][patientIndex] < nearestTravel) nearestTravel = costs[eligibleTeamIndex][patientIndex];
        }
      });
      let geographyScore = 100;
      if (assignedTravel > 0) geographyScore = Math.min(100, (nearestTravel / assignedTravel) * 100);

      let parityScore = 100;
      if (finalKnown > 0) {
        const teamRatio = finalPrim / finalKnown;
        parityScore = (1 - Math.abs(teamRatio - batchRatio)) * 100;
      }

      const criteriaScores = { capacity: capacityScore, geography: geographyScore, parity: parityScore };
      result.push({
        patientId: patient.id,
        teamId: team.id,
        meanTravelSeconds: assignedTravel,
        closestMemberId,
        closestMemberSeconds,
        matchScore: weights.capacity * capacityScore + weights.geography * geographyScore + weights.parity * parityScore,
        criteriaScores,
      });
    });
  });
  return result;
}
