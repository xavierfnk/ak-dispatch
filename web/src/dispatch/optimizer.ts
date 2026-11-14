import type { CalculateRequest } from "../types";
import type { Weights } from "./types";
import { parityTotals, summarize } from "./scoring.ts";
import { contains } from "./utils.ts";

const searchLimitMs = 2000;

export interface SearchResult {
  assignment: number[];
  objective: number;
  capacityObjective: number;
  secondaryObjective: number;
  status: "optimal" | "feasible" | "infeasible" | "time_limit";
}

interface ObjectiveBound {
  capacity: number;
  secondary: number;
}

export function optimize(request: CalculateRequest, costs: number[][], weights: Weights): SearchResult {
  const started = performance.now();
  const patients = request.cohort.patients;
  const teams = request.teams;
  const n = patients.length;
  const teamCount = teams.length;

  const options: number[][] = patients.map((patient, patientIndex) => {
    const eligible: number[] = [];
    teams.forEach((team, teamIndex) => {
      if (!patient.eligibleTeamIds?.length || contains(patient.eligibleTeamIds, team.id)) eligible.push(teamIndex);
    });
    eligible.sort((a, b) => {
      if (costs[a][patientIndex] === costs[b][patientIndex]) return teams[a].id < teams[b].id ? -1 : teams[a].id > teams[b].id ? 1 : 0;
      return costs[a][patientIndex] - costs[b][patientIndex];
    });
    return eligible;
  });
  if (options.some((list) => list.length === 0)) return emptyResult("infeasible");

  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => {
    if (options[a].length !== options[b].length) return options[a].length - options[b].length;
    return patients[a].id < patients[b].id ? -1 : patients[a].id > patients[b].id ? 1 : 0;
  });

  const remainingEligible = Array.from({ length: n + 1 }, () => new Array<number>(teamCount).fill(0));
  const remainingPEC = Array.from({ length: n + 1 }, () => new Array<number>(teamCount).fill(0));
  let pecTotal = 0;
  for (let depth = n - 1; depth >= 0; depth--) {
    remainingEligible[depth] = [...remainingEligible[depth + 1]];
    remainingPEC[depth] = [...remainingPEC[depth + 1]];
    const patient = patients[order[depth]];
    if (patient.eligiblePec100) pecTotal++;
    for (const teamIndex of options[order[depth]]) {
      remainingEligible[depth][teamIndex]++;
      if (patient.eligiblePec100) remainingPEC[depth][teamIndex]++;
    }
  }

  const loads = new Array<number>(teamCount).fill(0);
  const pecLoads = new Array<number>(teamCount).fill(0);
  const pecMin = teamCount > 0 ? Math.floor(pecTotal / teamCount) : 0;
  const pecMax = teamCount > 0 ? Math.ceil(pecTotal / teamCount) : 0;
  const assignment = new Array<number>(n).fill(0);
  let best: SearchResult = {
    assignment: [],
    objective: Infinity,
    capacityObjective: Infinity,
    secondaryObjective: Infinity,
    status: "optimal",
  };
  let found = false;
  let timedOut = false;
  const deadline = started + searchLimitMs;
  const { known, primiparous } = parityTotals(patients);

  const visit = (depth: number, geographySeconds: number) => {
    if (timedOut) return;
    if (performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (!canStillFit(depth, n, teams, loads, remainingEligible[depth])) return;
    for (let index = 0; index < teams.length; index++) {
      if (pecLoads[index] > pecMax || pecLoads[index] + remainingPEC[depth][index] < pecMin) return;
    }
    if (found && cannotBeat(lowerBound(depth, n, teams, loads, remainingEligible[depth], order, options, costs, geographySeconds, request.settings.referenceTravelTimeMinutes, weights), best)) return;
    if (depth === n) {
      const { scores } = summarize(request, assignment, costs, weights, known, primiparous);
      let secondary = weights.geography * scores.geography;
      if (scores.parity !== null) secondary += weights.parity * scores.parity;
      if (!found || scores.capacity < best.capacityObjective - 1e-12 || (Math.abs(scores.capacity - best.capacityObjective) <= 1e-12 && secondary < best.secondaryObjective - 1e-12)) {
        best = {
          assignment: [...assignment],
          objective: scores.total,
          capacityObjective: scores.capacity,
          secondaryObjective: secondary,
          status: "optimal",
        };
        found = true;
      }
      return;
    }

    const patientIndex = order[depth];
    for (const teamIndex of options[patientIndex]) {
      if (loads[teamIndex] >= teams[teamIndex].maxPatients) continue;
      loads[teamIndex]++;
      if (patients[patientIndex].eligiblePec100) pecLoads[teamIndex]++;
      assignment[patientIndex] = teamIndex;
      visit(depth + 1, geographySeconds + costs[teamIndex][patientIndex]);
      loads[teamIndex]--;
      if (patients[patientIndex].eligiblePec100) pecLoads[teamIndex]--;
      if (timedOut) return;
    }
  };

  visit(0, 0);
  if (timedOut) {
    if (found) {
      best.status = "feasible";
      return best;
    }
    return emptyResult("time_limit");
  }
  if (!found) return emptyResult("infeasible");
  return best;
}

function emptyResult(status: "infeasible" | "time_limit"): SearchResult {
  return { assignment: [], objective: 0, capacityObjective: 0, secondaryObjective: 0, status };
}

function canStillFit(
  depth: number,
  patientCount: number,
  teams: CalculateRequest["teams"],
  loads: number[],
  remainingEligible: number[],
): boolean {
  const remaining = patientCount - depth;
  let freeSlots = 0;
  let minNeeded = 0;
  for (let index = 0; index < teams.length; index++) {
    if (loads[index] + remainingEligible[index] < teams[index].minPatients) return false;
    freeSlots += teams[index].maxPatients - loads[index];
    if (loads[index] < teams[index].minPatients) minNeeded += teams[index].minPatients - loads[index];
  }
  return freeSlots >= remaining && minNeeded <= remaining;
}

function lowerBound(
  depth: number,
  patientCount: number,
  teams: CalculateRequest["teams"],
  loads: number[],
  remainingEligible: number[],
  order: number[],
  options: number[][],
  costs: number[][],
  geographySeconds: number,
  referenceMinutes: number,
  weights: Weights,
): ObjectiveBound {
  let geographyLowerBound = geographySeconds;
  for (let index = depth; index < order.length; index++) {
    const patientIndex = order[index];
    let minCost = Infinity;
    for (const teamIndex of options[patientIndex]) {
      if (loads[teamIndex] < teams[teamIndex].maxPatients && costs[teamIndex][patientIndex] < minCost) {
        minCost = costs[teamIndex][patientIndex];
      }
    }
    if (minCost === Infinity) return { capacity: Infinity, secondary: Infinity };
    geographyLowerBound += minCost;
  }

  let capacityLowerBound = 0;
  for (let index = 0; index < teams.length; index++) {
    const team = teams[index];
    const width = team.maxPatients - team.minPatients;
    if (width === 0) continue;
    const low = Math.max(loads[index], team.minPatients);
    const high = Math.min(team.maxPatients, loads[index] + remainingEligible[index]);
    if (low > high) return { capacity: Infinity, secondary: Infinity };
    const midpoint = (team.minPatients + team.maxPatients) / 2;
    const loCandidate = Math.max(low, Math.min(high, Math.floor(midpoint)));
    const hiCandidate = Math.max(low, Math.min(high, Math.ceil(midpoint)));
    const deviation = Math.min(
      Math.abs(2 * loCandidate - team.minPatients - team.maxPatients) / width,
      Math.abs(2 * hiCandidate - team.minPatients - team.maxPatients) / width,
    );
    capacityLowerBound += deviation;
  }
  if (teams.length > 0) capacityLowerBound /= teams.length;

  const geographyScoreLowerBound = patientCount > 0
    ? geographyLowerBound / (patientCount * referenceMinutes * 60)
    : 0;
  return { capacity: capacityLowerBound, secondary: weights.geography * geographyScoreLowerBound };
}

function cannotBeat(bound: ObjectiveBound, best: SearchResult): boolean {
  const tolerance = 1e-12;
  if (bound.capacity > best.capacityObjective + tolerance) return true;
  return Math.abs(bound.capacity - best.capacityObjective) <= tolerance && bound.secondary >= best.secondaryObjective - tolerance;
}
