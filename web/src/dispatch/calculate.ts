import type { CalculateResponse } from "../response";
import type { CalculateRequest } from "../types";
import { DispatchValidationError, ProviderError } from "./errors.ts";
import { googleRoutesProvider } from "./googleRoutes.ts";
import { optimize } from "./optimizer.ts";
import { explainAssignments, parityTotals, summarize } from "./scoring.ts";
import type { Location, RouteMatrix, RouteProvider, Weights } from "./types";
import { finite } from "./utils.ts";

const maxPatients = 40;
const maxTeams = 20;
const maxMembers = 250;
const maxCapacity = 1_000_000;
const maxRouteElements = 625;
const fixedWeights: Weights = { capacity: 0.8, geography: 0.15, parity: 0.05 };
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

const errorMessages: Record<string, string> = {
  missing_api_key: "Ajoutez votre clé Google Maps dans Configuration avant de calculer les trajets.",
  invalid_request: "Vérifiez les informations saisies avant de relancer le calcul.",
  provider_quota_exceeded: "Le quota de l’API Google Routes est atteint. Réessayez plus tard.",
  provider_unavailable: "Google Routes est momentanément indisponible. Réessayez.",
  provider_rejected: "Google Routes a refusé la requête. Vérifiez la clé API et les lieux saisis.",
  provider_invalid_response: "Google Routes a renvoyé une réponse inattendue. Réessayez.",
  calculation_failed: "Le calcul n’a pas abouti. Réessayez.",
};

export function calculationErrorMessage(code: string): string {
  return errorMessages[code] ?? errorMessages.calculation_failed;
}

export async function calculatePlan(request: CalculateRequest, apiKey: string): Promise<CalculateResponse> {
  const key = apiKey.trim();
  if (!key) throw new Error(calculationErrorMessage("missing_api_key"));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    return await calculateWithProvider(request, googleRoutesProvider(key), maxRouteElements, controller.signal);
  } catch (error) {
    if (error instanceof ProviderError) throw new Error(calculationErrorMessage(error.code));
    if (error instanceof DispatchValidationError) throw new Error(calculationErrorMessage("invalid_request"));
    console.error(error);
    throw new Error(calculationErrorMessage("calculation_failed"));
  } finally {
    clearTimeout(timeout);
  }
}

export async function calculateWithProvider(
  request: CalculateRequest,
  provider: RouteProvider,
  routeLimit: number,
  signal?: AbortSignal,
): Promise<CalculateResponse> {
  const effectiveRequest: CalculateRequest = {
    ...request,
    settings: { ...request.settings, weights: { ...fixedWeights } },
  };
  const issues = validate(effectiveRequest);
  if (issues.length > 0) throw new DispatchValidationError(issues);

  let effectiveWeights = { ...fixedWeights };
  const { known, primiparous } = parityTotals(effectiveRequest.cohort.patients);
  if (known === 0) {
    const total = effectiveWeights.capacity + effectiveWeights.geography;
    effectiveWeights = {
      capacity: effectiveWeights.capacity / total,
      geography: effectiveWeights.geography / total,
      parity: 0,
    };
  }

  const response: CalculateResponse = {
    requestId: effectiveRequest.requestId,
    resultStatus: "infeasible",
    solver: { name: "exact local branch-and-bound", status: "infeasible", runtimeMs: 0 },
    routeLookup: {
      provider: provider.name,
      routingPreference: provider.routingPreference,
      lookedUpAt: "",
      elementCount: 0,
    },
    settings: {
      configuredWeights: { ...effectiveRequest.settings.weights },
      effectiveWeights: { ...effectiveWeights },
      referenceTravelTimeMinutes: effectiveRequest.settings.referenceTravelTimeMinutes,
    },
    scores: null,
    assignments: [],
    teams: [],
    candidateTravelCosts: [],
    assignmentExplanations: [],
    unresolvedRoutes: [],
    issues: [],
  };

  let minTotal = 0;
  let maxTotal = 0;
  for (const team of effectiveRequest.teams) {
    minTotal += team.minPatients;
    maxTotal += team.maxPatients;
  }
  if (effectiveRequest.cohort.patients.length < minTotal || effectiveRequest.cohort.patients.length > maxTotal) {
    response.issues.push("Aggregate team capacity cannot fit this cohort.");
    return response;
  }

  const requiredRouteElements = routeElementCount(effectiveRequest) * provider.routeModesPerPair;
  if (routeLimit > 0 && requiredRouteElements > routeLimit) {
    throw new DispatchValidationError([
      `This calculation requires ${requiredRouteElements} route elements; the configured per-calculation limit is ${routeLimit}.`,
    ]);
  }

  response.routeLookup.lookedUpAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const matrix = await provider.compute(effectiveRequest, signal);
  validateMatrix(matrix, effectiveRequest.teams.length, effectiveRequest.cohort.patients.length);
  response.routeLookup.elementCount = matrix.elementCount;
  response.candidateTravelCosts = matrix.candidateCosts;
  response.unresolvedRoutes = matrix.unresolvedRoutes;
  if (matrix.unresolvedRoutes.length > 0) {
    response.resultStatus = "needs_review";
    response.solver.status = "not_run";
    response.issues.push("One or more required member routes are unresolved. Correct the locations before calculating assignments.");
    return response;
  }

  const started = performance.now();
  const search = optimize(effectiveRequest, matrix.costs, effectiveWeights);
  response.solver.runtimeMs = Math.floor(performance.now() - started);
  response.solver.status = search.status;
  if (search.status === "infeasible") {
    response.issues.push("No complete assignment satisfies team capacities, eligibility restrictions, and PEC 100% balance.");
    return response;
  }
  if (search.status === "time_limit") {
    response.resultStatus = "needs_review";
    response.issues.push("The local search reached its time limit before finding a complete assignment.");
    return response;
  }

  if (search.status === "optimal") {
    response.resultStatus = "optimal";
  } else {
    response.resultStatus = "feasible";
    response.solver.bestBound = 0;
    if (search.objective > 0) response.solver.relativeGap = search.objective / Math.abs(search.objective);
  }
  response.solver.objective = search.objective;

  const teamForPatient = new Array<number>(effectiveRequest.cohort.patients.length);
  search.assignment.forEach((teamIndex, patientIndex) => {
    teamForPatient[patientIndex] = teamIndex;
    response.assignments.push({
      patientId: effectiveRequest.cohort.patients[patientIndex].id,
      teamId: effectiveRequest.teams[teamIndex].id,
    });
  });
  const summary = summarize(effectiveRequest, teamForPatient, matrix.costs, effectiveWeights, known, primiparous);
  response.scores = summary.scores;
  response.teams = summary.teams;
  response.assignmentExplanations = explainAssignments(effectiveRequest, search.assignment, matrix.costs, matrix.candidateCosts, effectiveWeights);
  return response;
}

function validate(request: CalculateRequest): string[] {
  const issues: string[] = [];
  if (!request.requestId.trim()) issues.push("A request token is required.");
  const half = Number(request.cohort.expectedDeliveryHalf);
  if (!request.cohort.id.trim() || !monthPattern.test(request.cohort.expectedDeliveryMonth) || !Number.isInteger(half) || half < 1 || half > 4 || request.cohort.revision < 0) {
    issues.push("Cohort token, delivery period, and non-negative revision are required.");
  }
  if (request.cohort.patients.length > maxPatients) {
    issues.push(`The local optimizer supports at most ${maxPatients} patients per calculation.`);
  }
  if (request.teams.length > maxTeams) {
    issues.push(`The local optimizer supports at most ${maxTeams} teams per calculation.`);
  }

  const ids = new Set<string>();
  const addId = (id: string) => {
    if (!id.trim() || ids.has(id)) {
      issues.push("Patient, team, and member request tokens must be non-empty and unique.");
      return;
    }
    ids.add(id);
  };
  const teamIds = new Set(request.teams.map((team) => team.id));
  for (const team of request.teams) addId(team.id);
  for (const patient of request.cohort.patients) {
    addId(patient.id);
    const parity: string = patient.parity;
    if (parity !== "primiparous" && parity !== "multiparous") {
      issues.push("Patient parity must be primiparous or multiparous.");
    }
    const locationIssue = validateLocation(patient.location);
    if (locationIssue) issues.push(locationIssue);
    const seenEligible = new Set<string>();
    for (const teamId of patient.eligibleTeamIds ?? []) {
      if (!teamIds.has(teamId) || seenEligible.has(teamId)) {
        issues.push("Eligibility restrictions must reference unique teams in this request.");
        break;
      }
      seenEligible.add(teamId);
    }
  }

  let totalMembers = 0;
  for (const team of request.teams) {
    if (team.minPatients < 0 || team.maxPatients < team.minPatients || team.maxPatients > maxCapacity) {
      issues.push(`Team capacities must be ordered non-negative integers no greater than ${maxCapacity}.`);
    }
    if (team.members.length === 0) issues.push("Every team must have at least one member.");
    totalMembers += team.members.length;
    for (const member of team.members) {
      addId(member.id);
      const locationIssue = validateLocation(member.location);
      if (locationIssue) issues.push(locationIssue);
    }
  }
  if (totalMembers > maxMembers) {
    issues.push(`The local optimizer supports at most ${maxMembers} team members per calculation.`);
  }

  const weights = request.settings.weights;
  const weightSum = weights.capacity + weights.geography + weights.parity;
  if (!finite(weights.capacity) || !finite(weights.geography) || !finite(weights.parity) || weights.capacity < 0 || weights.geography < 0 || weights.parity < 0 || Math.abs(weightSum - 1) > 1e-6) {
    issues.push("Objective weights must be non-negative and sum to 1.");
  }
  if (!finite(request.settings.referenceTravelTimeMinutes) || request.settings.referenceTravelTimeMinutes <= 0) {
    issues.push("Reference travel time must be positive.");
  }
  const { known } = parityTotals(request.cohort.patients);
  if (known === 0 && weights.capacity + weights.geography <= 0) {
    issues.push("Capacity or geography must have a positive weight when parity is unavailable.");
  }
  return issues;
}

function validateLocation(location: Location): string {
  const address = (location as { address?: string }).address?.trim() ?? "";
  const placeId = (location as { placeId?: string }).placeId?.trim() ?? "";
  const representations = Number(address !== "") + Number(placeId !== "");
  if (representations !== 1) return "Each location must contain exactly one address or place ID.";
  if (address.length > 500) return "Location address is too long.";
  if (placeId.length > 512) return "Location place ID is too long.";
  return "";
}

function validateMatrix(matrix: RouteMatrix, teamCount: number, patientCount: number) {
  if (matrix.costs.length !== teamCount) throw new ProviderError("provider_invalid_response");
  for (const row of matrix.costs) {
    if (row.length !== patientCount) throw new ProviderError("provider_invalid_response");
    for (const seconds of row) {
      if (!finite(seconds) || seconds < 0) throw new ProviderError("provider_invalid_response");
    }
  }
}

function routeElementCount(request: CalculateRequest): number {
  let elements = 0;
  for (const team of request.teams) elements += team.members.length * request.cohort.patients.length;
  return elements;
}
