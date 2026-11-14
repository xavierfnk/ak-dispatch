import type { CalculateRequest } from "../types";
import type { CandidateTravelCost, Location, MemberSeconds, RouteMatrix, RouteProvider } from "./types";
import { ProviderError } from "./errors.ts";

const routesEndpoint = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const routesFieldMask = "originIndex,destinationIndex,duration,status,condition";
const maxElementsPerCall = 625;
const maxTransitElements = 100;
const waypointsPerSide = 25;
const maxGoogleResponse = 2 << 20;
const googleRequestTimeout = 15_000;
const travelModes = ["BICYCLE", "TRANSIT"] as const;

interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  condition?: string;
  status?: { code?: number };
}

interface OriginRef {
  teamIndex: number;
  memberIndex: number;
  member: CalculateRequest["teams"][number]["members"][number];
}

interface RouteOption {
  seconds: number;
  durationSeconds: number;
  mode: string;
  available: boolean;
}

type Waypoint = { address: string } | { placeId: string };

interface MatrixWaypoint {
  waypoint: Waypoint;
}

interface MatrixRequest {
  origins: MatrixWaypoint[];
  destinations: MatrixWaypoint[];
  travelMode: string;
}

export function googleRoutesProvider(apiKey: string): RouteProvider {
  const key = apiKey.trim();
  return {
    name: "Google Routes API",
    routingPreference: "SHORTEST_OF_BICYCLE_AND_TRANSIT",
    routeModesPerPair: travelModes.length,
    compute: (request, signal) => computeRouteMatrix(key, request, signal),
  };
}

async function computeRouteMatrix(apiKey: string, request: CalculateRequest, signal?: AbortSignal): Promise<RouteMatrix> {
  const origins: OriginRef[] = [];
  request.teams.forEach((team, teamIndex) => {
    team.members.forEach((member, memberIndex) => {
      origins.push({ teamIndex, memberIndex, member });
    });
  });
  const patientCount = request.cohort.patients.length;
  const matrix: RouteMatrix = {
    elementCount: origins.length * patientCount * travelModes.length,
    costs: request.teams.map(() => new Array<number>(patientCount).fill(0)),
    candidateCosts: [],
    unresolvedRoutes: [],
  };
  const bestRoutes: RouteOption[][][] = request.teams.map((team) =>
    team.members.map(() => Array.from({ length: patientCount }, () => ({ seconds: 0, durationSeconds: 0, mode: "", available: false }))),
  );
  const cellErrors: string[][][][] = request.teams.map((team) =>
    team.members.map(() => Array.from({ length: patientCount }, () => [] as string[])),
  );
  if (origins.length === 0 || patientCount === 0) return matrix;

  for (const travelMode of travelModes) {
    const chunkSize = travelMode === "TRANSIT" ? 10 : waypointsPerSide;
    const maxElements = travelMode === "TRANSIT" ? maxTransitElements : maxElementsPerCall;
    for (let originStart = 0; originStart < origins.length; originStart += chunkSize) {
      const originEnd = Math.min(originStart + chunkSize, origins.length);
      for (let destinationStart = 0; destinationStart < patientCount; destinationStart += chunkSize) {
        const destinationEnd = Math.min(destinationStart + chunkSize, patientCount);
        const originChunk = origins.slice(originStart, originEnd);
        const patientChunk = request.cohort.patients.slice(destinationStart, destinationEnd);
        const body: MatrixRequest = {
          origins: originChunk.map((origin) => ({ waypoint: toWaypoint(origin.member.location) })),
          destinations: patientChunk.map((patient) => ({ waypoint: toWaypoint(patient.location) })),
          travelMode,
        };
        if (originChunk.length * patientChunk.length > maxElements || originChunk.length + patientChunk.length > 2 * waypointsPerSide) {
          throw new ProviderError("invalid_matrix_chunk");
        }

        const elements = await postJSON<MatrixElement[]>(routesEndpoint, routesFieldMask, body, apiKey, signal);
        if (!Array.isArray(elements)) throw new ProviderError("provider_invalid_response");
        const seen = originChunk.map(() => new Array<boolean>(patientChunk.length).fill(false));
        for (const element of elements) {
          const originIndex = element.originIndex ?? 0;
          const destinationIndex = element.destinationIndex ?? 0;
          if (originIndex < 0 || originIndex >= originChunk.length || destinationIndex < 0 || destinationIndex >= patientChunk.length || seen[originIndex][destinationIndex]) {
            throw new ProviderError("invalid_matrix_response");
          }
          seen[originIndex][destinationIndex] = true;
          const origin = originChunk[originIndex];
          const patientIndex = destinationStart + destinationIndex;
          const statusCode = element.status?.code ?? 0;
          if (statusCode !== 0 || element.condition !== "ROUTE_EXISTS") {
            cellErrors[origin.teamIndex][origin.memberIndex][patientIndex].push(`${travelMode}:${routeErrorCode(element)}`);
            continue;
          }
          const durationSeconds = parseDurationSeconds(element.duration ?? "");
          if (durationSeconds === null || durationSeconds < 0) {
            cellErrors[origin.teamIndex][origin.memberIndex][patientIndex].push(`${travelMode}:invalid_duration`);
            continue;
          }
          const seconds = Math.round(durationSeconds);
          const best = bestRoutes[origin.teamIndex][origin.memberIndex][patientIndex];
          if (!best.available || durationSeconds < best.durationSeconds) {
            best.seconds = seconds;
            best.durationSeconds = durationSeconds;
            best.mode = travelMode;
            best.available = true;
          }
        }
        originChunk.forEach((origin, originIndex) => {
          patientChunk.forEach((_patient, patientOffset) => {
            if (!seen[originIndex][patientOffset]) {
              const globalPatient = destinationStart + patientOffset;
              cellErrors[origin.teamIndex][origin.memberIndex][globalPatient].push(`${travelMode}:missing_element`);
            }
          });
        });
      }
    }
  }

  request.teams.forEach((team, teamIndex) => {
    request.cohort.patients.forEach((patient, patientIndex) => {
      const memberSeconds: MemberSeconds[] = [];
      let total = 0;
      let complete = true;
      team.members.forEach((member, memberIndex) => {
        const route = bestRoutes[teamIndex][memberIndex][patientIndex];
        if (!route.available) {
          complete = false;
          const codes = cellErrors[teamIndex][memberIndex][patientIndex];
          matrix.unresolvedRoutes.push({
            patientId: patient.id,
            teamId: team.id,
            memberId: member.id,
            code: codes.length > 0 ? codes.join(",") : "missing_element",
          });
          return;
        }
        total += route.seconds;
        memberSeconds.push({ memberId: member.id, seconds: route.seconds, travelMode: route.mode });
      });
      if (!complete) return;
      const meanSeconds = total / team.members.length;
      matrix.costs[teamIndex][patientIndex] = meanSeconds;
      const candidate: CandidateTravelCost = { patientId: patient.id, teamId: team.id, meanSeconds, memberSeconds };
      matrix.candidateCosts.push(candidate);
    });
  });
  return matrix;
}

function toWaypoint(location: Location): Waypoint {
  const address = (location as { address?: string }).address?.trim() ?? "";
  if (address) return { address };
  const placeId = (location as { placeId?: string }).placeId?.trim() ?? "";
  if (placeId) return { placeId };
  throw new ProviderError("provider_rejected");
}

function routeErrorCode(element: MatrixElement): string {
  if (element.condition === "ROUTE_NOT_FOUND") return "route_not_found";
  if ((element.status?.code ?? 0) !== 0) return "provider_element_error";
  return "route_unavailable";
}

export function parseDurationSeconds(value: string): number | null {
  const text = value.trim();
  if (!text || text.startsWith("-")) return null;
  const pattern = /(\d+(?:\.\d+)?)(h|ms|m|s)/g;
  let total = 0;
  let index = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index !== index) return null;
    index = pattern.lastIndex;
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * (unit === "h" ? 3600 : unit === "m" ? 60 : unit === "ms" ? 0.001 : 1);
  }
  return matched && index === text.length ? total : null;
}

async function postJSON<T>(endpoint: string, fieldMask: string, input: unknown, apiKey: string, signal?: AbortSignal): Promise<T> {
  const body = JSON.stringify(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(googleRequestTimeout)])
        : AbortSignal.timeout(googleRequestTimeout);
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body,
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      if (signal?.aborted) throw new ProviderError("provider_unavailable");
      if (attempt === 0) {
        await waitRetry();
        continue;
      }
      throw new ProviderError("provider_unavailable");
    }

    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > maxGoogleResponse) throw new ProviderError("provider_invalid_response");
    let data: string;
    try {
      data = await response.text();
    } catch {
      throw new ProviderError(signal?.aborted ? "provider_unavailable" : "provider_invalid_response");
    }
    if (data.length > maxGoogleResponse) throw new ProviderError("provider_invalid_response");
    if (response.status === 429) throw new ProviderError("provider_quota_exceeded");
    if (response.status >= 500) {
      if (attempt === 0) {
        await waitRetry();
        continue;
      }
      throw new ProviderError("provider_unavailable");
    }
    if (response.status < 200 || response.status >= 300) throw new ProviderError("provider_rejected");
    try {
      return JSON.parse(data) as T;
    } catch {
      throw new ProviderError("provider_invalid_response");
    }
  }
  throw new ProviderError("provider_unavailable");
}

function waitRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}
