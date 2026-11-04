import { z } from "zod";

const number = z.number().finite();
const nullableNumber = number.nullable();

export const calculateResponseSchema = z.object({
  requestId: z.string(),
  resultStatus: z.enum(["optimal", "feasible", "infeasible", "needs_review"]),
  solver: z.object({
    name: z.string(),
    status: z.string(),
    runtimeMs: number,
    objective: number.optional(),
    bestBound: number.optional(),
    relativeGap: number.optional(),
  }),
  routeLookup: z.object({
    provider: z.string(),
    routingPreference: z.string(),
    lookedUpAt: z.string(),
    elementCount: z.number().int().nonnegative(),
  }),
  settings: z.object({
    configuredWeights: z.object({ capacity: number, geography: number, parity: number }),
    effectiveWeights: z.object({ capacity: number, geography: number, parity: number }),
    referenceTravelTimeMinutes: number,
  }),
  scores: z.object({
    capacity: number,
    geography: number,
    parity: nullableNumber,
    total: number,
  }).nullable(),
  assignments: z.array(z.object({ patientId: z.string(), teamId: z.string() })),
  teams: z.array(z.object({
    teamId: z.string(),
    assignedCount: z.number().int(),
    minPatients: z.number().int(),
    maxPatients: z.number().int(),
    primiparousCount: z.number().int(),
    multiparousCount: z.number().int(),
    knownParityRatio: nullableNumber,
    batchTargetPrimiparousRatio: nullableNumber,
    mixDeviation: nullableNumber,
  })),
  candidateTravelCosts: z.array(z.object({
    patientId: z.string(),
    teamId: z.string(),
    meanSeconds: number,
    memberSeconds: z.array(z.object({ memberId: z.string(), seconds: z.number().int(), travelMode: z.string().optional() })),
  })),
  assignmentExplanations: z.array(z.object({
    patientId: z.string(),
    teamId: z.string(),
    meanTravelSeconds: number,
    closestMemberId: z.string(),
    closestMemberSeconds: z.number().int(),
    matchScore: number,
    criteriaScores: z.object({ capacity: number, geography: number, parity: number }),
  })),
  unresolvedRoutes: z.array(z.object({
    patientId: z.string(),
    teamId: z.string(),
    memberId: z.string().optional(),
    code: z.string(),
  })),
  issues: z.array(z.string()),
});

export type CalculateResponse = z.infer<typeof calculateResponseSchema>;
