import { useEffect, useMemo, useState } from "react";
import { db, emptySettings } from "./db";
import { GoogleApiKeySettings } from "./GoogleApiKeySettings";
import { UpdateSettings } from "./UpdateSettings";
import { calculateResponseSchema, type CalculateResponse } from "./response";
import { syntheticDemo } from "./sample";
import { splitMonth } from "./periods";
import { movePreservesPEC } from "./pec";
import { PlannerService } from "../../server/cmd/desktop/frontend/bindings/patient-dispatch-planner/server/cmd/desktop";
import type { CalculateRequest, Capacity, Cohort, CohortTeamOverride, LocationFields, Member, Patient, RunRecord, Team } from "./types";

const newId = () => crypto.randomUUID();
const newToken = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function monthNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function cohortPeriodLabel(cohort: Cohort) {
  const { expectedDeliveryMonth: month, expectedDeliveryHalf: half } = cohort;
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return `${monthLabel(month)} · ${cohort.periodStart ?? (half === 1 ? 1 : 15)}–${cohort.periodEnd ?? (half === 1 ? 14 : lastDay)}`;
}

type StoredPatient = Omit<Patient, "parity"> & { parity: string };
type StoredTeam = Omit<Team, "minPatients" | "maxPatients"> & Partial<Capacity>;
type StoredCohort = Omit<Cohort, "patients" | "expectedDeliveryHalf"> & {
  patients: StoredPatient[];
  expectedDeliveryHalf?: 1 | 2 | 3 | 4;
  teams?: StoredTeam[];
  capacities?: Record<string, Capacity>;
};

function migrateCohortConfiguration(storedCohorts: Cohort[], storedTeams: Team[]) {
  const cohorts = storedCohorts as unknown as StoredCohort[];
  const teams = storedTeams as unknown as StoredTeam[];
  const changed = cohorts.some((cohort) => Array.isArray(cohort.teams)
    || Object.prototype.hasOwnProperty.call(cohort, "capacities")
    || !cohort.expectedDeliveryHalf
    || cohort.patients.some((patient) => patient.parity === "unknown"))
    || teams.some((team) => team.minPatients === undefined || team.maxPatients === undefined);
  if (!changed) return { changed, cohorts: storedCohorts, teams: storedTeams };

  const byName = new Map<string, Team>();
  const ordered = [...cohorts].sort((a, b) => a.expectedDeliveryMonth.localeCompare(b.expectedDeliveryMonth));
  const legacyCapacities = new Map<string, Capacity>();
  for (const cohort of ordered) {
    for (const [id, capacity] of Object.entries(cohort.capacities ?? {})) legacyCapacities.set(id, capacity);
  }
  const addTeam = (team: StoredTeam, capacity?: Capacity) => {
    const key = team.name.trim().toLocaleLowerCase("fr-FR") || team.id;
    byName.set(key, {
      ...team,
      minPatients: team.minPatients ?? capacity?.minPatients ?? null,
      maxPatients: team.maxPatients ?? capacity?.maxPatients ?? null,
    });
  };
  for (const team of teams) addTeam(team, legacyCapacities.get(team.id));
  for (const cohort of ordered) {
    for (const team of cohort.teams ?? []) addTeam(team, cohort.capacities?.[team.id]);
  }

  return {
    changed,
    teams: [...byName.values()],
    cohorts: storedCohorts.map((stored) => {
      const legacy = stored as unknown as StoredCohort;
      return {
        id: legacy.id,
        expectedDeliveryMonth: legacy.expectedDeliveryMonth,
        expectedDeliveryHalf: legacy.expectedDeliveryHalf ?? 1,
        ...(legacy.periodStart !== undefined ? { periodStart: legacy.periodStart, periodEnd: legacy.periodEnd } : {}),
        revision: legacy.revision,
        patients: legacy.patients.map((patient) => patient.parity === "unknown" ? { ...patient, parity: "" as const } : patient) as Patient[],
        ...(legacy.teamOverrides ? { teamOverrides: legacy.teamOverrides } : {}),
      };
    }),
  };
}

const FIXED_WEIGHTS: CalculateRequest["settings"]["weights"] = { capacity: 0.8, geography: 0.15, parity: 0.05 };

function numericInput(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function locationInput(value: LocationFields, subject: string): CalculateRequest["cohort"]["patients"][number]["location"] {
  if (value.placeId) return { placeId: value.placeId };
  const address = value.address?.trim();
  if (!address) throw new Error(`Saisissez une adresse pour ${subject}.`);
  return { address };
}

function routeInputKey(cohort: Cohort, teams: Team[]) {
  return JSON.stringify({
    cohort: { ...cohort, patients: cohort.patients.map(({ selectedAddress: _label, ...patient }) => patient) },
    teams: teams.map(({ members, ...team }) => ({ ...team, members: members.map(({ selectedAddress: _label, ...member }) => member) })),
  });
}

function effectiveCapacity(override: CohortTeamOverride | undefined, team: Team, key: "minPatients" | "maxPatients") {
  return override && Object.prototype.hasOwnProperty.call(override, key) ? override[key] ?? null : team[key];
}

function effectiveCohortTeams(cohort: Cohort, teams: Team[]): Team[] {
  return teams.flatMap((team) => {
    const override = cohort.teamOverrides?.[team.id];
    if (override?.enabled === false) return [];
    const disabledMembers = new Set(override?.disabledMemberIds ?? []);
    return [{
      ...team,
      minPatients: effectiveCapacity(override, team, "minPatients"),
      maxPatients: effectiveCapacity(override, team, "maxPatients"),
      members: team.members.filter((member) => !disabledMembers.has(member.id)),
    }];
  });
}

function recalculateAfterMove(result: CalculateResponse, parities: RunRecord["patientParities"], assignments: CalculateResponse["assignments"], coordinatorEdited = false): CalculateResponse {
  const teamIndex = new Map(result.teams.map((team, index) => [team.teamId, index]));
  const patientTeam = new Map(assignments.map((assignment) => [assignment.patientId, assignment.teamId]));
  const loads = result.teams.map(() => 0);
  const primiparous = result.teams.map(() => 0);
  const multiparous = result.teams.map(() => 0);
  let totalTravel = 0;
  const costs = new Map(result.candidateTravelCosts.map((cost) => [`${cost.patientId}:${cost.teamId}`, cost]));
  for (const assignment of assignments) {
    const index = teamIndex.get(assignment.teamId);
    if (index === undefined) continue;
    loads[index]++;
    if (parities?.[assignment.patientId] === "primiparous") primiparous[index]++;
    if (parities?.[assignment.patientId] === "multiparous") multiparous[index]++;
    totalTravel += costs.get(`${assignment.patientId}:${assignment.teamId}`)?.meanSeconds ?? 0;
  }

  const knownParity = primiparous.reduce((sum, count) => sum + count, 0) + multiparous.reduce((sum, count) => sum + count, 0);
  const batchPrimiparous = primiparous.reduce((sum, count) => sum + count, 0);
  const batchRatio = knownParity > 0 ? batchPrimiparous / knownParity : null;
  const capacityScore = result.teams.reduce((sum, team, index) => {
    const width = team.maxPatients - team.minPatients;
    return sum + (width > 0 ? Math.abs(2 * loads[index] - team.minPatients - team.maxPatients) / width : 0);
  }, 0) / Math.max(1, result.teams.length);
  const parityScore = knownParity > 0
    ? result.teams.reduce((sum, _team, index) => sum + Math.abs(knownParity * primiparous[index] - batchPrimiparous * (primiparous[index] + multiparous[index])), 0) / knownParity ** 2
    : null;
  const geographyScore = assignments.length > 0
    ? totalTravel / (assignments.length * result.settings.referenceTravelTimeMinutes * 60)
    : 0;
  const weights = result.settings.effectiveWeights;
  const totalScore = weights.capacity * capacityScore + weights.geography * geographyScore + weights.parity * (parityScore ?? 0);

  return {
    ...result,
    ...(coordinatorEdited ? {
      resultStatus: "feasible" as const,
      solver: { ...result.solver, status: "coordinator_adjusted", objective: totalScore, bestBound: undefined, relativeGap: undefined },
    } : {}),
    assignments,
    scores: {
      capacity: capacityScore,
      geography: geographyScore,
      parity: parityScore,
      total: totalScore,
    },
    teams: result.teams.map((team, index) => {
      const teamKnown = primiparous[index] + multiparous[index];
      return {
        ...team,
        assignedCount: loads[index],
        primiparousCount: primiparous[index],
        multiparousCount: multiparous[index],
        knownParityRatio: teamKnown > 0 ? primiparous[index] / teamKnown : null,
        batchTargetPrimiparousRatio: batchRatio,
        mixDeviation: teamKnown > 0 && batchRatio !== null ? Math.abs(primiparous[index] - batchRatio * teamKnown) : null,
      };
    }),
    assignmentExplanations: result.teams.flatMap((team) => assignments.flatMap((assignment) => {
      const cost = costs.get(`${assignment.patientId}:${team.teamId}`);
      if (!cost) return [];
      const currentTeamId = patientTeam.get(assignment.patientId);
      const currentIndex = currentTeamId === undefined ? undefined : teamIndex.get(currentTeamId);
      const targetIndex = teamIndex.get(team.teamId);
      if (targetIndex === undefined) return [];
      const finalLoad = loads[targetIndex] + Number(currentIndex !== targetIndex);
      const width = team.maxPatients - team.minPatients;
      const capacityFit = width > 0
        ? Math.max(0, 1 - Math.abs(2 * finalLoad - team.minPatients - team.maxPatients) / width) * 100
        : 100;
      let targetPrim = primiparous[targetIndex];
      let targetMulti = multiparous[targetIndex];
      if (currentIndex !== targetIndex) {
        const parity = parities?.[assignment.patientId];
        if (parity === "primiparous") targetPrim++;
        if (parity === "multiparous") targetMulti++;
      }
      const teamKnown = targetPrim + targetMulti;
      const parityFit = teamKnown > 0 && batchRatio !== null ? (1 - Math.abs(targetPrim / teamKnown - batchRatio)) * 100 : 100;
      const nearest = Math.min(...result.teams.map((candidateTeam) => costs.get(`${assignment.patientId}:${candidateTeam.teamId}`)?.meanSeconds ?? Infinity));
      const geographyFit = cost.meanSeconds > 0 ? Math.min(100, nearest / cost.meanSeconds * 100) : 100;
      const criteriaScores = { capacity: capacityFit, geography: geographyFit, parity: parityFit };
      const closestMember = cost.memberSeconds.reduce<(typeof cost.memberSeconds)[number] | null>((best, member) => !best || member.seconds < best.seconds ? member : best, null);
      return [{
        patientId: assignment.patientId,
        teamId: team.teamId,
        meanTravelSeconds: cost.meanSeconds,
        closestMemberId: closestMember?.memberId ?? "",
        closestMemberSeconds: closestMember?.seconds ?? 0,
        matchScore: weights.capacity * capacityFit + weights.geography * geographyFit + weights.parity * parityFit,
        criteriaScores,
      }];
    })),
  };
}

function matchPercent(value: number) {
  return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %`;
}

function parityLabel(value: Patient["parity"] | undefined) {
  return value === "primiparous" ? "Primipare" : value === "multiparous" ? "Multipare" : "—";
}

function travelModeLabel(value: string) {
  return ({
    BICYCLE: "À vélo",
    TRANSIT: "Transports en commun",
    STRAIGHT_LINE: "Simulation en ligne droite",
  } as Record<string, string>)[value] ?? value;
}

function minutes(seconds: number) {
  return `${Math.round(seconds / 60).toLocaleString("fr-FR")} min`;
}

function label(value: string) {
  return value.trim() || "Sans nom";
}

function statusLabel(status: string) {
  return ({
    optimal: "Proposition prête",
    feasible: "Proposition à vérifier",
    infeasible: "Aucune proposition possible",
    needs_review: "Vérification nécessaire",
  } as Record<string, string>)[status] ?? "À vérifier";
}

function statusMessage(status: string) {
  return ({
    optimal: "Voici une proposition de répartition. Vérifiez-la avant de la valider.",
    feasible: "Une proposition est disponible. Vérifiez-la attentivement avant de la valider.",
    infeasible: "Aucune répartition ne respecte les capacités et l’équilibre PEC 100 %. Ajustez les données puis réessayez.",
    needs_review: "Certaines informations doivent être vérifiées avant de proposer une répartition.",
  } as Record<string, string>)[status] ?? "Vérifiez les informations saisies.";
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedCohortId, setSelectedCohortId] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState("");
  const [cohortCount, setCohortCount] = useState(1);
  const [activeTab, setActiveTab] = useState<"calendar" | "configuration">("calendar");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [patientListOpen, setPatientListOpen] = useState(true);
  const [movePatientId, setMovePatientId] = useState("");
  const [moveTargetTeamId, setMoveTargetTeamId] = useState("");
  const [googleKeyConfigured, setGoogleKeyConfigured] = useState(false);

  useEffect(() => {
    let mounted = true;
    void PlannerService.GoogleAPIKeyConfigured()
      .then((configured: boolean) => { if (mounted) setGoogleKeyConfigured(configured); })
      .catch(() => { if (mounted) setError("Impossible d’accéder au trousseau de mots de passe de cet appareil."); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [savedTeams, storedCohorts, savedSettings, savedRuns] = await Promise.all([
          db.teams.toArray(),
          db.cohorts.toArray(),
          db.settings.get("default"),
          db.runs.toArray(),
        ]);
        if (savedSettings && Object.prototype.hasOwnProperty.call(savedSettings, "profile")) await db.settings.put(emptySettings);
        const migrated = migrateCohortConfiguration(storedCohorts, savedTeams);
        if (migrated.changed) {
          await db.transaction("rw", db.teams, db.cohorts, async () => {
            await db.teams.clear();
            if (migrated.teams.length > 0) await db.teams.bulkPut(migrated.teams);
            if (migrated.cohorts.length > 0) await db.cohorts.bulkPut(migrated.cohorts);
          });
        }
        const orderedCohorts = migrated.cohorts.sort((a, b) => a.expectedDeliveryMonth.localeCompare(b.expectedDeliveryMonth) || a.expectedDeliveryHalf - b.expectedDeliveryHalf);
        const orderedRuns = savedRuns.map((run) => {
          const normalized = { ...run, result: { ...run.result, assignmentExplanations: run.result.assignmentExplanations ?? [] } };
          return { ...normalized, result: recalculateAfterMove(normalized.result, normalized.patientParities, normalized.result.assignments) };
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (mounted) {
          setTeams(migrated.teams);
          setCohorts(orderedCohorts);
          setRuns(orderedRuns);
          setSelectedCohortId("");
          setActiveRunId("");
        }
      } catch {
        if (mounted) setBootError("Impossible d’ouvrir les données enregistrées sur cet appareil.");
      } finally {
        if (mounted) setReady(true);
      }
    }
    void load();
    return () => { mounted = false; };
  }, []);

  const selectedCohort = cohorts.find((cohort) => cohort.id === selectedCohortId) ?? null;
  const activeRun = runs.find((run) => run.id === activeRunId && run.cohortId === selectedCohortId) ?? null;
  const selectedCohortTeams = useMemo(
    () => selectedCohort ? effectiveCohortTeams(selectedCohort, teams) : [],
    [selectedCohort, teams],
  );
  const cohortRuns = useMemo(
    () => runs.filter((run) => run.cohortId === selectedCohortId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [runs, selectedCohortId],
  );
  const inputKey = selectedCohort ? routeInputKey(selectedCohort, selectedCohortTeams) : "";
  const staleRun = Boolean(activeRun && activeRun.inputKey !== inputKey);
  const monthCohorts = cohorts.filter((cohort) => cohort.expectedDeliveryMonth === selectedMonth).sort((a, b) => a.expectedDeliveryHalf - b.expectedDeliveryHalf);

  useEffect(() => {
    setPatientListOpen(!activeRun);
  }, [selectedCohortId, activeRun?.id]);

  useEffect(() => {
    if (staleRun) {
      setMovePatientId("");
      setMoveTargetTeamId("");
    }
  }, [staleRun]);

  function runStorageAction(action: () => Promise<unknown>) {
    void action().catch(() => setError("L’opération n’a pas abouti. Réessayez."));
  }

  function saveCohort(next: Cohort, bumpRevision = true) {
    const updated = { ...next, revision: next.revision + Number(bumpRevision) };
    setCohorts((current) => current.map((cohort) => cohort.id === updated.id ? updated : cohort));
    void db.cohorts.put(updated).catch(() => setError("La modification n’a pas pu être enregistrée."));
  }

  function saveTeam(next: Team) {
    setTeams((current) => current.map((team) => team.id === next.id ? next : team));
    void db.teams.put(next).catch(() => setError("La configuration n’a pas pu être enregistrée."));
  }

  async function loadDemo() {
    const demo = syntheticDemo();
    await db.transaction("rw", db.teams, db.cohorts, db.settings, async () => {
      await db.teams.bulkAdd(demo.teams);
      await db.cohorts.add(demo.cohort);
      await db.settings.put(demo.settings);
    });
    setTeams(demo.teams);
    setCohorts([demo.cohort]);
    setSelectedCohortId(demo.cohort.id);
    setActiveTab("calendar");
    setError(null);
    setNotice("Exemple fictif chargé.");
  }

  async function splitSelectedMonth() {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth) || !Number.isInteger(cohortCount) || cohortCount < 1 || cohortCount > 4) return;
    if (monthCohorts.length > 0 && !window.confirm(`Remplacer les cohortes de ${monthLabel(selectedMonth)} ? Toutes leurs patientes, configurations et propositions seront définitivement supprimées.`)) return;
    const oldIds = monthCohorts.map((cohort) => cohort.id);
    const newCohorts: Cohort[] = splitMonth(selectedMonth, cohortCount).map((period, index) => ({
      id: newId(), expectedDeliveryMonth: selectedMonth, expectedDeliveryHalf: (index + 1) as Cohort["expectedDeliveryHalf"],
      periodStart: period.start, periodEnd: period.end, revision: 1, patients: [],
    }));
    await db.transaction("rw", db.cohorts, db.runs, async () => {
      await db.cohorts.bulkDelete(oldIds);
      if (oldIds.length) await db.runs.where("cohortId").anyOf(oldIds).delete();
      await db.cohorts.bulkAdd(newCohorts);
    });
    setCohorts((current) => [...current.filter((cohort) => !oldIds.includes(cohort.id)), ...newCohorts]);
    setRuns((current) => current.filter((run) => !oldIds.includes(run.cohortId)));
    setError(null);
    setNotice(`Cohortes de ${monthLabel(selectedMonth)} créées.`);
  }

  async function deleteCohort() {
    if (!selectedCohort || !window.confirm(`Supprimer la cohorte du ${cohortPeriodLabel(selectedCohort)} et son historique ?`)) return;
    await db.transaction("rw", db.cohorts, db.runs, async () => {
      await db.cohorts.delete(selectedCohort.id);
      await db.runs.where("cohortId").equals(selectedCohort.id).delete();
    });
    const nextCohorts = cohorts.filter((cohort) => cohort.id !== selectedCohort.id);
    const nextRuns = runs.filter((run) => run.cohortId !== selectedCohort.id);
    setCohorts(nextCohorts);
    setRuns(nextRuns);
    setSelectedCohortId("");
    setActiveRunId("");
    setActiveTab("calendar");
  }

  async function addTeam() {
    const team: Team = {
      id: newId(), name: `Équipe ${String.fromCharCode(65 + (teams.length % 26))}`,
      members: [{ id: newId(), name: "Nouvelle sage-femme", address: "", placeId: "" }],
      minPatients: null,
      maxPatients: null,
    };
    await db.teams.add(team);
    setTeams((current) => [...current, team]);
  }

  async function deleteTeam(team: Team) {
    if (!window.confirm(`Supprimer ${label(team.name)} pour toutes les cohortes ?`)) return;
    await db.teams.delete(team.id);
    setTeams((current) => current.filter((item) => item.id !== team.id));
  }

  function addMember(team: Team) {
    saveTeam({
      ...team,
      members: [...team.members, { id: newId(), name: "Nouvelle sage-femme", address: "", placeId: "" }],
    });
  }

  function updateMember(team: Team, memberId: string, patch: Partial<Member>) {
    saveTeam({ ...team, members: team.members.map((member) => member.id === memberId ? { ...member, ...patch } : member) });
  }

  function removeMember(team: Team, memberId: string) {
    if (team.members.length < 2) return;
    saveTeam({ ...team, members: team.members.filter((member) => member.id !== memberId) });
  }

  function updateCapacity(teamId: string, key: "minPatients" | "maxPatients", value: number | null) {
    const team = teams.find((item) => item.id === teamId);
    if (team) saveTeam({ ...team, [key]: value });
  }

  function updateCohortTeam(teamId: string, patch: CohortTeamOverride) {
    if (!selectedCohort) return;
    saveCohort({
      ...selectedCohort,
      teamOverrides: {
        ...selectedCohort.teamOverrides,
        [teamId]: { ...selectedCohort.teamOverrides?.[teamId], ...patch },
      },
    });
  }

  function updateCohortCapacity(team: Team, key: "minPatients" | "maxPatients", value: number | null) {
    updateCohortTeam(team.id, { [key]: value });
  }

  function resetCohortCapacity(teamId: string) {
    if (!selectedCohort) return;
    const override = { ...selectedCohort.teamOverrides?.[teamId] };
    delete override.minPatients;
    delete override.maxPatients;
    saveCohort({ ...selectedCohort, teamOverrides: { ...selectedCohort.teamOverrides, [teamId]: override } });
  }

  function toggleCohortMember(team: Team, memberId: string, enabled: boolean) {
    const disabledMemberIds = new Set(selectedCohort?.teamOverrides?.[team.id]?.disabledMemberIds ?? []);
    if (enabled) disabledMemberIds.delete(memberId);
    else disabledMemberIds.add(memberId);
    updateCohortTeam(team.id, { disabledMemberIds: [...disabledMemberIds] });
  }

  function addPatient() {
    if (!selectedCohort) return;
    const patient: Patient = {
      id: newId(), name: "Nouvelle patiente", address: "", placeId: "", parity: "", eligiblePec100: false,
    };
    saveCohort({ ...selectedCohort, patients: [...selectedCohort.patients, patient] });
  }

  function updatePatient(patientId: string, patch: Partial<Patient>) {
    if (!selectedCohort) return;
    const labelOnlyUpdate = Object.keys(patch).length === 1 && Object.prototype.hasOwnProperty.call(patch, "selectedAddress");
    saveCohort({
      ...selectedCohort,
      patients: selectedCohort.patients.map((patient) => patient.id === patientId ? { ...patient, ...patch } : patient),
    }, !labelOnlyUpdate);
  }

  async function calculate() {
    if (!selectedCohort) return;
    if (!googleKeyConfigured) {
      setError("Ajoutez votre clé Google Maps dans Configuration avant de calculer les trajets.");
      return;
    }
    setError(null);
    setNotice(null);
    setRunning(true);
    try {
      const patientNames: Record<string, string> = {};
      const patientParities: Record<string, Exclude<Patient["parity"], "">> = {};
      const patientPEC100: Record<string, boolean> = {};
      const teamNames: Record<string, string> = {};
      const teamMemberIds: Record<string, string[]> = {};
      const memberNames: Record<string, string> = {};

      const patients = selectedCohort.patients.map((patient) => {
        if (!patient.parity) throw new Error(`Choisissez la parité de ${label(patient.name)}.`);
        const token = newToken("p");
        patientNames[token] = label(patient.name);
        patientParities[token] = patient.parity;
        patientPEC100[token] = Boolean(patient.eligiblePec100);
        return {
          id: token,
          location: locationInput(patient, label(patient.name)),
          parity: patient.parity,
          eligiblePec100: Boolean(patient.eligiblePec100),
        };
      });
      if (selectedCohortTeams.length === 0) throw new Error("Activez au moins une équipe dans le récapitulatif de la cohorte.");
      const requestTeams = selectedCohortTeams.map((team) => {
        const token = newToken("t");
        teamNames[token] = label(team.name);
        if (team.minPatients === null || team.minPatients === undefined || team.maxPatients === null || team.maxPatients === undefined) {
          throw new Error(`Saisissez une capacité minimale et maximale pour ${label(team.name)}.`);
        }
        if (!Number.isInteger(team.minPatients) || !Number.isInteger(team.maxPatients) || team.minPatients < 0 || team.maxPatients < team.minPatients) {
          throw new Error(`Vérifiez les capacités de ${label(team.name)}.`);
        }
        if (team.members.length === 0) throw new Error(`Activez au moins une sage-femme pour ${label(team.name)}.`);
        const members = team.members.map((member) => {
          const memberToken = newToken("m");
          memberNames[memberToken] = label(member.name);
          return {
            id: memberToken,
            location: locationInput(member, label(member.name)),
          };
        });
        teamMemberIds[token] = members.map((member) => member.id);
        return {
          id: token,
          minPatients: team.minPatients,
          maxPatients: team.maxPatients,
          members,
        };
      });

      const body: CalculateRequest = {
        requestId: newToken("r"),
        cohort: {
          id: newToken("c"),
          revision: selectedCohort.revision,
          expectedDeliveryMonth: selectedCohort.expectedDeliveryMonth,
          expectedDeliveryHalf: selectedCohort.expectedDeliveryHalf,
          patients,
        },
        teams: requestTeams,
        settings: { weights: FIXED_WEIGHTS, referenceTravelTimeMinutes: 30 },
      };

      const result = calculateResponseSchema.parse(await PlannerService.Calculate(body));
      const run: RunRecord = {
        id: newId(),
        cohortId: selectedCohort.id,
        cohortRevision: selectedCohort.revision,
        createdAt: new Date().toISOString(),
        inputKey: routeInputKey(selectedCohort, selectedCohortTeams),
        patientNames,
        patientParities,
        patientPEC100,
        teamNames,
        teamMemberIds,
        memberNames,
        result,
      };
      const googleResult = result.routeLookup.provider === "Google Routes API";
      let stored = false;
      if (!googleResult) {
        try {
          await db.runs.add(run);
          stored = true;
        } catch {
          stored = false;
        }
      }
      setRuns((current) => [run, ...current]);
      setActiveRunId(run.id);
      if (googleResult) setNotice("Proposition temporaire calculée. Vérifiez-la avant de l’utiliser.");
      else if (stored) setNotice("Proposition calculée. Vérifiez-la avant de l’utiliser.");
      else setError("La proposition a été calculée, mais n’a pas pu être enregistrée.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(["Saisissez", "Choisissez", "Vérifiez", "Activez", "La proposition", "Ajoutez"].some((prefix) => message.startsWith(prefix))
        ? message
        : "Le calcul n’a pas abouti. Réessayez.");
    } finally {
      setRunning(false);
    }
  }

  function confirmPatientMove(patientId: string, targetTeamId: string) {
    if (!activeRun || staleRun) return;
    const current = activeRun.result.assignments.find((assignment) => assignment.patientId === patientId);
    const sourceTeam = current && activeRun.result.teams.find((team) => team.teamId === current.teamId);
    const targetTeam = activeRun.result.teams.find((team) => team.teamId === targetTeamId);
    if (!current || !sourceTeam || !targetTeam || targetTeamId === current.teamId) return;
    if (sourceTeam.assignedCount - 1 < sourceTeam.minPatients || targetTeam.assignedCount + 1 > targetTeam.maxPatients) {
      setError("Ce déplacement dépasserait la capacité d’une des deux équipes.");
      return;
    }
    if (!movePreservesPEC(activeRun, patientId, targetTeamId)) {
      setError("Ce déplacement déséquilibrerait les patientes éligibles PEC 100 %.");
      return;
    }
    const assignments = activeRun.result.assignments.map((assignment) => assignment.patientId === patientId ? { ...assignment, teamId: targetTeamId } : assignment);
    const updated: RunRecord = {
      ...activeRun,
      result: recalculateAfterMove(activeRun.result, activeRun.patientParities, assignments, true),
    };
    setRuns((previous) => previous.map((run) => run.id === updated.id ? updated : run));
    if (updated.result.routeLookup.provider !== "Google Routes API") {
      void db.runs.put(updated).catch(() => setError("Le déplacement est appliqué, mais n’a pas pu être enregistré."));
    }
    setMovePatientId("");
    setMoveTargetTeamId("");
    setError(null);
    setNotice(`${activeRun.patientNames[patientId] ?? "La patiente"} a été déplacée vers ${activeRun.teamNames[targetTeamId] ?? "l’équipe choisie"}.`);
  }

  async function exportData() {
    if (!window.confirm("Le fichier exporté contient les informations saisies et les propositions. Conservez-le dans un endroit sûr.")) return;
    const [savedTeams, savedCohorts, savedSettings, savedRuns] = await Promise.all([
      db.teams.toArray(), db.cohorts.toArray(), db.settings.toArray(), db.runs.toArray(),
    ]);
    const data = {
      format: "patient-dispatch-planner",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      data: { teams: savedTeams, cohorts: savedCohorts, settings: savedSettings, runs: savedRuns },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `repartition-patientes-${monthNow()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function clearAllData() {
    if (!window.confirm("Supprimer définitivement toutes les équipes, cohortes et propositions ?")) return;
    await db.transaction("rw", db.teams, db.cohorts, db.settings, db.runs, async () => {
      await Promise.all([db.teams.clear(), db.cohorts.clear(), db.settings.clear(), db.runs.clear()]);
      await db.settings.put(emptySettings);
    });
    setTeams([]);
    setCohorts([]);
    setRuns([]);
    setSelectedCohortId("");
    setActiveRunId("");
    setActiveTab("calendar");
    setSelectedMonth("");
    setNotice("Toutes les données ont été supprimées.");
  }

  if (!ready) return <main className="loading">Ouverture…</main>;
  if (bootError) return <main className="loading error-text">{bootError}</main>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Accueil — Répartition des patientes">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span><strong>Répartition des patientes</strong><small>Organisation des cohortes</small></span>
        </a>
        <div className="topbar-actions">
          <button className="button button-quiet" onClick={() => runStorageAction(exportData)}>Exporter les données</button>
        </div>
      </header>

      <main id="top" className="page">
        {error && <div className="message message-error" role="alert">{error}</div>}
        {notice && <div className="message message-success" role="status">{notice}</div>}

        <nav className="workspace-tabs" role="tablist" aria-label="Navigation principale">
          <button role="tab" aria-selected={activeTab === "calendar"} className={activeTab === "calendar" ? "is-active" : ""} onClick={() => { setActiveTab("calendar"); setSelectedCohortId(""); setSelectedMonth(""); setActiveRunId(""); }}>Calendrier</button>
          <button role="tab" aria-selected={activeTab === "configuration"} className={activeTab === "configuration" ? "is-active" : ""} onClick={() => setActiveTab("configuration")}>Configuration</button>
        </nav>

        {activeTab === "calendar" && !selectedCohort && (
          <section className="panel calendar-panel" key={`calendar-${calendarYear}`}>
            <div className="panel-heading panel-heading-wrap">
              <div><span className="eyebrow">COHORTES</span><h1>Calendrier</h1></div>
              <div className="calendar-year">
                <button className="icon-button" aria-label="Année précédente" onClick={() => { setCalendarYear((year) => year - 1); setSelectedMonth(""); }}>‹</button>
                <strong>{calendarYear}</strong>
                <button className="icon-button" aria-label="Année suivante" onClick={() => { setCalendarYear((year) => year + 1); setSelectedMonth(""); }}>›</button>
              </div>
            </div>
            <p className="section-hint">Choisissez un mois, puis répartissez-le en une à quatre cohortes.</p>
            <div className="month-grid">
              {MONTHS.map((month, index) => {
                const monthValue = `${calendarYear}-${String(index + 1).padStart(2, "0")}`;
                const monthItems = cohorts.filter((item) => item.expectedDeliveryMonth === monthValue);
                return (
                  <button
                    type="button"
                    className={`month-card ${monthItems.length ? "has-cohort" : ""} ${selectedMonth === monthValue ? "is-selected" : ""}`}
                    key={monthValue}
                    onClick={() => {
                      setError(null);
                      setSelectedMonth(monthValue);
                      setCohortCount(monthItems.length || 1);
                    }}
                  >
                    <strong>{month}</strong>
                    <span>{monthItems.length ? `${monthItems.length} ${monthItems.length === 1 ? "cohorte" : "cohortes"} · ${monthItems.reduce((sum, cohort) => sum + cohort.patients.length, 0)} patientes` : "Aucune cohorte"}</span>
                  </button>
                );
              })}
            </div>
            {selectedMonth && (
              <div className="month-detail">
                <h2>{monthLabel(selectedMonth)}</h2>
                {monthCohorts.map((cohort) => (
                  <button type="button" className="month-card" key={cohort.id} onClick={() => { setSelectedCohortId(cohort.id); setActiveRunId(runs.find((run) => run.cohortId === cohort.id)?.id ?? ""); }}>
                    <strong>{cohortPeriodLabel(cohort)}</strong><span>{cohort.patients.length} patientes</span>
                  </button>
                ))}
                <p className="section-hint">Nouveau découpage : {splitMonth(selectedMonth, cohortCount).map((period) => `${period.start}–${period.end}`).join(" · ")}</p>
                <div className="calendar-create">
                  <label className="field-label">Nombre de cohortes
                    <select value={cohortCount} onChange={(event) => setCohortCount(Number(event.target.value))}>
                      {[1, 2, 3, 4].map((count) => <option value={count} key={count}>{count}</option>)}
                    </select>
                  </label>
                  <button className="button button-primary" disabled={running} onClick={() => runStorageAction(splitSelectedMonth)}>{monthCohorts.length ? "Remplacer les cohortes" : "Créer les cohortes"}</button>
                </div>
              </div>
            )}
            {cohorts.length === 0 && teams.length === 0 && (
              <div className="calendar-demo">
                <span>Vous pouvez aussi découvrir l’outil avec des données fictives.</span>
                <button className="button button-quiet" onClick={() => runStorageAction(loadDemo)}>Charger l’exemple</button>
              </div>
            )}
            {(cohorts.length > 0 || teams.length > 0) && <div className="calendar-data-actions"><button className="text-button danger-text" onClick={() => runStorageAction(clearAllData)}>Tout supprimer</button></div>}
          </section>
        )}

        {activeTab === "configuration" && (
          <div className="main-column" key="configuration">
            <section className="page-heading">
              <div><span className="eyebrow">CONFIGURATION GÉNÉRALE</span><h1>Équipes et capacités</h1><p>Ces réglages sont les valeurs par défaut ; chaque cohorte peut les ajuster.</p></div>
              <button className="button button-secondary" onClick={() => runStorageAction(addTeam)}>＋ Ajouter une équipe</button>
            </section>
            <GoogleApiKeySettings configured={googleKeyConfigured} onChange={setGoogleKeyConfigured} />
            <UpdateSettings />
            {teams.length === 0 && <div className="inline-notice">Ajoutez les équipes qui prendront en charge les cohortes.</div>}
            <div className="team-grid">
              {teams.map((team) => (
                  <article className="team-card" key={team.id}>
                    <div className="team-card-top">
                      <label className="field-label team-name-field">Nom de l’équipe<input value={team.name} onChange={(event) => saveTeam({ ...team, name: event.target.value })} /></label>
                      <button className="icon-button danger-text" aria-label={`Supprimer ${label(team.name)}`} title="Supprimer l’équipe" onClick={() => runStorageAction(() => deleteTeam(team))}>×</button>
                    </div>
                    <div className="capacity-fields">
                      <label className="field-label">Minimum de patientes<input type="number" min="0" step="1" value={team.minPatients ?? ""} onChange={(event) => updateCapacity(team.id, "minPatients", numericInput(event.target.value))} /></label>
                      <label className="field-label">Maximum de patientes<input type="number" min="0" step="1" value={team.maxPatients ?? ""} onChange={(event) => updateCapacity(team.id, "maxPatients", numericInput(event.target.value))} /></label>
                    </div>
                    <div className="members-heading"><strong>Sages-femmes et lieux</strong><span>{team.members.length}</span></div>
                    {team.members.map((member) => (
                      <div className="member-entry" key={member.id}>
                        <div className="member-entry-name">
                          <label className="sr-only" htmlFor={`member-name-${member.id}`}>Nom de la sage-femme</label>
                          <input id={`member-name-${member.id}`} placeholder="Nom de la sage-femme" value={member.name} onChange={(event) => updateMember(team, member.id, { name: event.target.value })} />
                          <button className="icon-button" aria-label={`Retirer ${label(member.name)}`} title="Retirer la sage-femme" disabled={team.members.length < 2} onClick={() => removeMember(team, member.id)}>×</button>
                        </div>
                          <LocationEditor idPrefix={`member-location-${member.id}`} value={member} compact onChange={(patch) => updateMember(team, member.id, patch)} />
                      </div>
                    ))}
                    <button className="text-button add-member" onClick={() => addMember(team)}>＋ Ajouter une sage-femme</button>
                  </article>
              ))}
            </div>
          </div>
        )}

        {activeTab === "calendar" && selectedCohort && (
          <div className="main-column" key={`cohort-${selectedCohort.id}`}>
            <nav className="cohort-breadcrumb" aria-label="Fil d’Ariane">
              <button className="breadcrumb-link" onClick={() => { setSelectedCohortId(""); setActiveRunId(""); }}>Calendrier</button>
              <span aria-hidden="true">›</span>
              <span>{cohortPeriodLabel(selectedCohort)}</span>
            </nav>
            <section className="page-heading">
              <div><span className="eyebrow">{cohortPeriodLabel(selectedCohort)}</span><h1>Patientes et répartition</h1><p>Les patientes saisies sont conservées pour cette période sur cet appareil.</p></div>
              <button className="text-button danger-text" disabled={running} onClick={() => runStorageAction(deleteCohort)}>Supprimer la cohorte</button>
            </section>
            <details className="panel cohort-teams-panel">
              <summary className="patient-list-summary">
                <span><span className="eyebrow">CONFIGURATION DE LA COHORTE</span><strong>Équipes et capacités</strong></span>
                <span className="muted">{selectedCohortTeams.length} / {teams.length} équipes actives</span>
              </summary>
              <p className="section-hint">Les modifications ci-dessous ne changent pas les réglages par défaut des autres cohortes.</p>
              {teams.length === 0 ? <p className="empty-team">Ajoutez d’abord des équipes dans Configuration.</p> : (
                <div className="cohort-team-settings">
                  {teams.map((team) => {
                    const override = selectedCohort.teamOverrides?.[team.id];
                    const enabled = override?.enabled !== false;
                    const disabledMembers = new Set(override?.disabledMemberIds ?? []);
                    const activeMemberCount = team.members.filter((member) => !disabledMembers.has(member.id)).length;
                    return (
                      <article className={`cohort-team-setting ${enabled ? "" : "is-disabled"}`} key={team.id}>
                        <div className="cohort-team-setting-heading">
                          <label><input type="checkbox" checked={enabled} disabled={!enabled && activeMemberCount === 0} onChange={(event) => updateCohortTeam(team.id, { enabled: event.target.checked })} /><strong>{label(team.name)}</strong></label>
                          <span>{activeMemberCount} / {team.members.length} sages-femmes actives</span>
                        </div>
                        <div className="capacity-fields">
                          <div className="cohort-capacity-heading"><strong>Capacité</strong><button type="button" className="text-button" disabled={!override || (!Object.prototype.hasOwnProperty.call(override, "minPatients") && !Object.prototype.hasOwnProperty.call(override, "maxPatients"))} onClick={() => resetCohortCapacity(team.id)}>Utiliser les valeurs par défaut</button></div>
                          <label className="field-label">Minimum de patientes<input type="number" min="0" step="1" value={effectiveCapacity(override, team, "minPatients") ?? ""} onChange={(event) => updateCohortCapacity(team, "minPatients", numericInput(event.target.value))} /></label>
                          <label className="field-label">Maximum de patientes<input type="number" min="0" step="1" value={effectiveCapacity(override, team, "maxPatients") ?? ""} onChange={(event) => updateCohortCapacity(team, "maxPatients", numericInput(event.target.value))} /></label>
                        </div>
                        <div className="cohort-member-toggles">
                          {team.members.map((member) => (
                            <label key={member.id}>
                              <input type="checkbox" checked={!disabledMembers.has(member.id)} disabled={enabled && activeMemberCount === 1 && !disabledMembers.has(member.id)} onChange={(event) => toggleCohortMember(team, member.id, event.target.checked)} />
                              {label(member.name)}
                            </label>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </details>
            <details className="panel patient-list-panel" open={patientListOpen} onToggle={(event) => setPatientListOpen(event.currentTarget.open)}>
              <summary className="patient-list-summary">
                <span><span className="eyebrow">COHORTE</span><strong>Patientes</strong></span>
                <span className="muted">{selectedCohort.patients.length}</span>
              </summary>
              {selectedCohort.patients.length === 0 && <p className="section-hint">Ajoutez les patientes prévues pour cette période.</p>}
              <div className="table-wrap">
                <table className="patient-table">
                  <thead><tr><th scope="col">Nom</th><th scope="col">Parité</th><th scope="col">Éligible PEC 100 %</th><th scope="col">Adresse</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {selectedCohort.patients.map((patient) => (
                      <tr key={patient.id}>
                        <td><label className="sr-only" htmlFor={`patient-name-${patient.id}`}>Nom de la patiente</label><input id={`patient-name-${patient.id}`} value={patient.name} onChange={(event) => updatePatient(patient.id, { name: event.target.value })} /></td>
                        <td><label className="sr-only" htmlFor={`patient-parity-${patient.id}`}>Parité</label><select id={`patient-parity-${patient.id}`} value={patient.parity} onChange={(event) => updatePatient(patient.id, { parity: event.target.value as Patient["parity"] })}><option value="">Choisir…</option><option value="primiparous">Primipare</option><option value="multiparous">Multipare</option></select></td>
                        <td><input type="checkbox" aria-label={`Éligible PEC 100 % : ${label(patient.name)}`} checked={Boolean(patient.eligiblePec100)} onChange={(event) => updatePatient(patient.id, { eligiblePec100: event.target.checked })} /></td>
                        <td className="location-cell"><LocationEditor idPrefix={`patient-location-${patient.id}`} value={patient} onChange={(patch) => updatePatient(patient.id, patch)} /></td>
                        <td><button className="icon-button" aria-label={`Retirer ${label(patient.name)}`} title="Retirer la patiente" onClick={() => saveCohort({ ...selectedCohort, patients: selectedCohort.patients.filter((item) => item.id !== patient.id) })}>×</button></td>
                      </tr>
                    ))}
                    {selectedCohort.patients.length === 0 && <tr><td className="empty-cell" colSpan={5}>Aucune patiente pour le moment.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="patient-list-footer"><button className="button button-secondary" onClick={addPatient}>＋ Ajouter une patiente</button></div>
            </details>
            {cohortRuns.length > 1 && (
              <label className="field-label history-select">Propositions précédentes
                <select className="select-control" value={activeRunId} onChange={(event) => setActiveRunId(event.target.value)}>
                  {cohortRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString("fr-FR")}</option>)}
                </select>
              </label>
            )}
            {activeRun && (
              <section className="panel results-panel" aria-live="polite">
                <div className="panel-heading panel-heading-wrap">
                  <div><span className="eyebrow">RÉSULTAT</span><h2>Proposition de répartition</h2></div>
                  <span className={`status-pill status-${activeRun.result.resultStatus}`}>{statusLabel(activeRun.result.resultStatus)}</span>
                </div>
                {staleRun && <div className="message message-warning">Les informations ont changé depuis cette proposition. Préparez-en une nouvelle.</div>}
                <p className="section-hint">{statusMessage(activeRun.result.resultStatus)} Les temps de trajet sont indicatifs.</p>
                <div className="team-results">
                  {activeRun.result.teams.map((team) => {
                    const assignments = activeRun.result.assignments.filter((assignment) => assignment.teamId === team.teamId);
                    return (
                      <section className="team-result" key={team.teamId}>
                        <div className="team-result-heading"><h3>{activeRun.teamNames[team.teamId] ?? "Équipe"}</h3><span>{assignments.length} {assignments.length === 1 ? "patiente" : "patientes"} · capacité {team.minPatients}–{team.maxPatients}</span></div>
                        {assignments.length === 0 ? <p className="empty-team">Aucune patiente assignée.</p> : (
                          <div className="assigned-patients">
                            {assignments.map((assignment) => {
                              const explanation = activeRun.result.assignmentExplanations?.find((item) => item.patientId === assignment.patientId && item.teamId === assignment.teamId);
                              const travelCost = activeRun.result.candidateTravelCosts.find((item) => item.patientId === assignment.patientId && item.teamId === assignment.teamId);
                              const travelByMember = new Map((travelCost?.memberSeconds ?? []).map((item) => [item.memberId, item]));
                              const memberIds = activeRun.teamMemberIds?.[assignment.teamId] ?? [...new Set([
                                ...travelByMember.keys(),
                                ...activeRun.result.unresolvedRoutes
                                  .filter((route) => route.patientId === assignment.patientId && route.teamId === assignment.teamId)
                                  .flatMap((route) => route.memberId ? [route.memberId] : []),
                              ])];
                              const scoreDescription = explanation
                                ? `Score de correspondance : ${matchPercent(explanation.matchScore)}. Capacités ${matchPercent(explanation.criteriaScores.capacity)}, trajet ${matchPercent(explanation.criteriaScores.geography)}, parité ${matchPercent(explanation.criteriaScores.parity)}.`
                                : "Score de correspondance indisponible.";
                              const sourceTeam = activeRun.result.teams.find((item) => item.teamId === assignment.teamId);
                              const targetTeam = activeRun.result.teams.find((item) => item.teamId === moveTargetTeamId);
                              const targetPreview = activeRun.result.candidateTravelCosts.find((item) => item.patientId === assignment.patientId && item.teamId === moveTargetTeamId);
                              const targetAllowed = Boolean(sourceTeam && targetTeam && sourceTeam.assignedCount - 1 >= sourceTeam.minPatients && targetTeam.assignedCount + 1 <= targetTeam.maxPatients && movePreservesPEC(activeRun, assignment.patientId, targetTeam.teamId));
                              return (
                                <div className="assigned-patient" key={assignment.patientId}>
                                  <div className="patient-result-row">
                                    <details>
                                      <summary><span>{activeRun.patientNames[assignment.patientId] ?? "Patiente"}</span></summary>
                                      <dl className="patient-result-details">
                                        <div><dt>Parité</dt><dd>{parityLabel(activeRun.patientParities?.[assignment.patientId])}</dd></div>
                                        <div><dt>Éligible PEC 100 %</dt><dd>{activeRun.patientPEC100 ? (activeRun.patientPEC100[assignment.patientId] ? "Oui" : "Non") : "—"}</dd></div>
                                        <div><dt>Temps moyen de trajet</dt><dd>{explanation ? minutes(explanation.meanTravelSeconds) : "—"}</dd></div>
                                        <div className="patient-travel-detail">
                                          <dt>Temps de trajet par sage-femme</dt>
                                          <dd>{memberIds.length === 0 ? "Aucun temps de trajet disponible" : (
                                            <ul className="patient-travel-list">
                                              {memberIds.map((memberId) => {
                                                const travel = travelByMember.get(memberId);
                                                return (
                                                  <li key={memberId}>
                                                    <span className="patient-travel-member-name">{activeRun.memberNames[memberId] ?? "Sage-femme"}</span>
                                                    <span className="patient-travel-meta">
                                                      {explanation?.closestMemberId === memberId && <span className="closest-member-badge">La plus proche</span>}
                                                      {travel?.travelMode && <span className="travel-mode-badge">{travelModeLabel(travel.travelMode)}</span>}
                                                      <strong>{travel ? minutes(travel.seconds) : "Non disponible"}</strong>
                                                    </span>
                                                  </li>
                                                );
                                              })}
                                            </ul>
                                          )}</dd>
                                        </div>
                                        <div className="patient-team-score-detail">
                                          <dt>Comparaison avec les autres équipes</dt>
                                          <dd>
                                            <details className="score-comparison">
                                              <summary>Afficher les scores par équipe</summary>
                                              <div className="table-wrap">
                                                <table className="score-comparison-table">
                                                  <thead><tr><th>Équipe</th><th>Score</th><th>Capacité</th><th>Trajet</th><th>Parité</th><th>Temps moyen</th></tr></thead>
                                                  <tbody>
                                                    {activeRun.result.assignmentExplanations.filter((item) => item.patientId === assignment.patientId).map((item) => (
                                                      <tr key={item.teamId} className={item.teamId === assignment.teamId ? "is-current-team" : ""}>
                                                        <th scope="row">{activeRun.teamNames[item.teamId] ?? "Équipe"}</th>
                                                        <td>{matchPercent(item.matchScore)}</td>
                                                        <td>{matchPercent(item.criteriaScores.capacity)}</td>
                                                        <td>{matchPercent(item.criteriaScores.geography)}</td>
                                                        <td>{matchPercent(item.criteriaScores.parity)}</td>
                                                        <td>{minutes(item.meanTravelSeconds)}</td>
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                              </div>
                                            </details>
                                          </dd>
                                        </div>
                                      </dl>
                                    </details>
                                    {explanation && <button type="button" className="score-info" title={scoreDescription} aria-label={scoreDescription}>i</button>}
                                    {activeRun.result.teams.length > 1 && <button type="button" className="button button-small move-patient-button" disabled={staleRun} onClick={() => { setMovePatientId((current) => current === assignment.patientId ? "" : assignment.patientId); setMoveTargetTeamId(""); }}>Changer d’équipe</button>}
                                  </div>
                                  {movePatientId === assignment.patientId && (
                                    <div className="move-patient-editor">
                                      <label className="field-label">Équipe de destination
                                        <select className="select-control" value={moveTargetTeamId} onChange={(event) => setMoveTargetTeamId(event.target.value)}>
                                          <option value="">Choisir une équipe…</option>
                                          {activeRun.result.teams.filter((item) => item.teamId !== assignment.teamId).map((item) => {
                                            const allowed = Boolean(sourceTeam && sourceTeam.assignedCount - 1 >= sourceTeam.minPatients && item.assignedCount + 1 <= item.maxPatients && movePreservesPEC(activeRun, assignment.patientId, item.teamId));
                                            return <option key={item.teamId} value={item.teamId} disabled={!allowed}>{activeRun.teamNames[item.teamId] ?? "Équipe"}{allowed ? "" : " — capacité ou équilibre PEC incompatible"}</option>;
                                          })}
                                        </select>
                                      </label>
                                      {moveTargetTeamId && (
                                        <div className="move-patient-preview">
                                          {!targetAllowed ? <p>Le déplacement dépasserait la capacité minimale ou maximale d’une des deux équipes.</p> : targetPreview ? (
                                            <>
                                              <p><strong>Temps moyen estimé : {minutes(targetPreview.meanSeconds)}</strong></p>
                                              <ul>{targetPreview.memberSeconds.map((member) => <li key={member.memberId}>{activeRun.memberNames[member.memberId] ?? "Sage-femme"} : {minutes(member.seconds)}{member.travelMode ? ` · ${travelModeLabel(member.travelMode)}` : ""}</li>)}</ul>
                                            </>
                                          ) : <p>Les temps de trajet pour cette équipe ne sont pas disponibles.</p>}
                                        </div>
                                      )}
                                      <div className="move-patient-actions">
                                        <button type="button" className="text-button" onClick={() => { setMovePatientId(""); setMoveTargetTeamId(""); }}>Annuler</button>
                                        <button type="button" className="button button-primary" disabled={staleRun || !moveTargetTeamId || !targetAllowed || !targetPreview} onClick={() => confirmPatientMove(assignment.patientId, moveTargetTeamId)}>Confirmer le déplacement</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </section>
            )}
            {!googleKeyConfigured && <p className="inline-notice">Ajoutez une clé Google Maps dans Configuration pour préparer une proposition.</p>}
            <div className="run-bar">
              <div>
                <strong>{activeRun ? "Une erreur dans la liste ?" : "Vérifiez la liste avant de générer"}</strong>
                <span>{activeRun ? "Modifiez les patientes puis régénérez la proposition. Les temps de trajet sont indicatifs." : "La proposition devra être validée par la coordinatrice."}</span>
              </div>
              <button className="button button-primary run-button" disabled={running || !googleKeyConfigured} onClick={() => void calculate()}>{running ? "Calcul en cours…" : activeRun ? "Régénérer la proposition" : "Préparer une proposition"}<span aria-hidden="true">→</span></button>
            </div>
          </div>
        )}
        <footer className="footer"><span>Répartition des patientes</span></footer>
      </main>
    </div>
  );
}

interface LocationEditorProps {
  idPrefix: string;
  value: LocationFields;
  compact?: boolean;
  onChange: (patch: Partial<LocationFields>) => void;
}

function LocationEditor({ idPrefix, value, compact = false, onChange }: LocationEditorProps) {
  const address = value.address ?? "";
  const placeId = value.placeId ?? "";
  const selectedAddress = value.selectedAddress ?? "";

  return (
    <div className={`location-editor ${compact ? "location-editor-compact" : ""}`}>
      <div className="location-entry">
        <label className="sr-only" htmlFor={`${idPrefix}-address`}>Adresse</label>
        <input
          id={`${idPrefix}-address`}
          type="text"
          autoComplete="off"
          placeholder="Saisir une adresse"
          value={selectedAddress || address}
          onChange={(event) => {
            onChange({ address: event.target.value, placeId: "", selectedAddress: "" });
          }}
        />
        {placeId && selectedAddress && <span className="location-hint">Adresse Google enregistrée</span>}
      </div>
    </div>
  );
}
