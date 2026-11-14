import type { CalculateResponse } from "../response";
import type { CalculateRequest } from "../types";

export type Weights = CalculateRequest["settings"]["weights"];
export type Location = CalculateRequest["cohort"]["patients"][number]["location"];
export type TeamSummary = CalculateResponse["teams"][number];
export type CandidateTravelCost = CalculateResponse["candidateTravelCosts"][number];
export type MemberSeconds = CandidateTravelCost["memberSeconds"][number];
export type AssignmentExplanation = CalculateResponse["assignmentExplanations"][number];
export type UnresolvedRoute = CalculateResponse["unresolvedRoutes"][number];
export type Scores = Exclude<CalculateResponse["scores"], null>;

export interface RouteMatrix {
  elementCount: number;
  costs: number[][];
  candidateCosts: CandidateTravelCost[];
  unresolvedRoutes: UnresolvedRoute[];
}

export interface RouteProvider {
  name: string;
  routingPreference: string;
  routeModesPerPair: number;
  compute(request: CalculateRequest, signal?: AbortSignal): Promise<RouteMatrix>;
}
