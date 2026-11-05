import type { RunRecord } from "./types";

export function movePreservesPEC(run: RunRecord, patientId: string, targetTeamId: string) {
  const counts = new Map(run.result.teams.map((team) => [team.teamId, 0]));
  for (const assignment of run.result.assignments) {
    if (!run.patientPEC100?.[assignment.patientId]) continue;
    const teamId = assignment.patientId === patientId ? targetTeamId : assignment.teamId;
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }
  const values = [...counts.values()];
  return values.length === 0 || Math.max(...values) - Math.min(...values) <= 1;
}
