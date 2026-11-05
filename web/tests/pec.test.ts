import { strict as assert } from "node:assert";
import { test } from "node:test";
import { movePreservesPEC } from "../src/pec.ts";
import type { RunRecord } from "../src/types.ts";

test("manual moves cannot create a PEC imbalance", () => {
  const run = {
    patientPEC100: { p1: true, p2: true, p3: true, p4: false },
    result: {
      teams: [{ teamId: "a" }, { teamId: "b" }, { teamId: "c" }],
      assignments: [
        { patientId: "p1", teamId: "a" }, { patientId: "p2", teamId: "b" },
        { patientId: "p3", teamId: "c" }, { patientId: "p4", teamId: "c" },
      ],
    },
  } as RunRecord;
  assert.equal(movePreservesPEC(run, "p1", "b"), false);
  assert.equal(movePreservesPEC(run, "p4", "b"), true);
});
