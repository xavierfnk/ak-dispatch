import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseBackup } from "../src/backup.ts";

test("a malformed backup is rejected before it can replace data", () => {
  assert.throws(() => parseBackup(JSON.stringify({ format: "patient-dispatch-planner", schemaVersion: 1, data: { teams: [{}], cohorts: [], settings: [], runs: [] } })));
});

test("an exported backup preserves teams, cohorts and incomplete patient entries", () => {
  const data = {
    teams: [{ id: "t1", name: "Équipe", minPatients: null, maxPatients: 4, members: [{ id: "m1", name: "Sage-femme", address: "Paris" }] }],
    cohorts: [{ id: "c1", expectedDeliveryMonth: "2026-11", expectedDeliveryHalf: 1, revision: 2, patients: [{ id: "p1", name: "Patiente", parity: "" }], teamOverrides: { t1: { disabledMemberIds: ["m1"] } } }],
    settings: [{ id: "default" }], runs: [],
  };
  assert.deepEqual(parseBackup(JSON.stringify({ format: "patient-dispatch-planner", schemaVersion: 1, data })), data);
});

test("backups with duplicate IDs or unsupported versions are rejected", () => {
  const data = { teams: [], cohorts: [], settings: [{ id: "default" }, { id: "default" }], runs: [] };
  assert.throws(() => parseBackup(JSON.stringify({ format: "patient-dispatch-planner", schemaVersion: 1, data })));
  assert.throws(() => parseBackup(JSON.stringify({ format: "patient-dispatch-planner", schemaVersion: 2, data: { ...data, settings: [] } })));
});
