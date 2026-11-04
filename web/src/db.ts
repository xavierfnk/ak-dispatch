import Dexie, { type Table } from "dexie";
import type { AppSettings, Cohort, RunRecord, Team } from "./types";

class PlannerDatabase extends Dexie {
  teams!: Table<Team, string>;
  cohorts!: Table<Cohort, string>;
  settings!: Table<AppSettings, string>;
  runs!: Table<RunRecord, string>;

  constructor() {
    super("patient-dispatch-planner");
    this.version(1).stores({
      teams: "id, name",
      cohorts: "id, expectedDeliveryMonth",
      settings: "id",
      runs: "id, cohortId, createdAt",
    });
  }
}

export const db = new PlannerDatabase();

export const emptySettings: AppSettings = {
  id: "default",
};
