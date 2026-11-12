import { z } from "zod";
import { calculateResponseSchema } from "./response.ts";

const id = z.string().min(1);
const capacity = z.number().finite().nullable();
const location = { address: z.string().optional(), placeId: z.string().optional(), selectedAddress: z.string().optional() };
const team = z.object({
  id, name: z.string(), minPatients: capacity, maxPatients: capacity,
  members: z.array(z.object({ id, name: z.string(), ...location })),
});
const cohort = z.object({
  id, expectedDeliveryMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  expectedDeliveryHalf: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  periodStart: z.number().int().min(1).max(31).optional(), periodEnd: z.number().int().min(1).max(31).optional(),
  revision: z.number().int().nonnegative(),
  patients: z.array(z.object({ id, name: z.string(), parity: z.enum(["", "primiparous", "multiparous"]), eligiblePec100: z.boolean().optional(), ...location })),
  teamOverrides: z.record(z.string(), z.object({ enabled: z.boolean().optional(), minPatients: capacity.optional(), maxPatients: capacity.optional(), disabledMemberIds: z.array(id).optional() })).optional(),
});
const run = z.object({
  id, cohortId: id, cohortRevision: z.number().int().nonnegative(), createdAt: z.string(), inputKey: z.string(),
  patientNames: z.record(z.string(), z.string()), patientParities: z.record(z.string(), z.enum(["primiparous", "multiparous"])).optional(),
  patientPEC100: z.record(z.string(), z.boolean()).optional(), teamNames: z.record(z.string(), z.string()),
  teamMemberIds: z.record(z.string(), z.array(z.string())).optional(), memberNames: z.record(z.string(), z.string()),
  result: calculateResponseSchema.extend({ assignmentExplanations: calculateResponseSchema.shape.assignmentExplanations.default([]) })
    .refine((result) => result.routeLookup.provider !== "Google Routes API"),
});
const backup = z.object({
  format: z.literal("patient-dispatch-planner"), schemaVersion: z.literal(1),
  data: z.object({ teams: z.array(team), cohorts: z.array(cohort), settings: z.array(z.object({ id: z.literal("default") })), runs: z.array(run) }),
});

export function parseBackup(text: string) {
  const data = backup.parse(JSON.parse(text)).data;
  for (const records of [data.teams, data.cohorts, data.settings, data.runs]) {
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Duplicate IDs");
  }
  const cohortIds = new Set(data.cohorts.map((item) => item.id));
  if (data.runs.some((item) => !cohortIds.has(item.cohortId))) throw new Error("Missing cohort");
  return data;
}
