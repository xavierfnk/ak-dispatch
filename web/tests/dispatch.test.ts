import { strict as assert } from "node:assert";
import { test } from "node:test";
import { calculateWithProvider } from "../src/dispatch/calculate.ts";
import { DispatchValidationError } from "../src/dispatch/errors.ts";
import type { RouteMatrix, RouteProvider } from "../src/dispatch/types.ts";
import type { CalculateRequest } from "../src/types.ts";

class TestProvider implements RouteProvider {
  calls = 0;
  readonly name: string;
  readonly routingPreference = "TEST";
  readonly routeModesPerPair: number;
  private readonly matrix: RouteMatrix;

  constructor(matrix: RouteMatrix, routeModes = 1, name = "test") {
    this.routeModesPerPair = routeModes;
    this.name = name;
    this.matrix = matrix;
  }

  async compute(): Promise<RouteMatrix> {
    this.calls++;
    return this.matrix;
  }
}

function baseRequest(): CalculateRequest {
  return {
    requestId: "request-token",
    cohort: { id: "cohort-token", revision: 1, expectedDeliveryMonth: "2027-04", expectedDeliveryHalf: 1, patients: [] },
    teams: [],
    settings: { weights: { capacity: 0.2, geography: 0.6, parity: 0.2 }, referenceTravelTimeMinutes: 30 },
  };
}

function matrixFor(request: CalculateRequest, costs: number[][]): RouteMatrix {
  const candidateCosts = request.teams.flatMap((team, teamIndex) =>
    request.cohort.patients.map((patient, patientIndex) => ({
      patientId: patient.id,
      teamId: team.id,
      meanSeconds: costs[teamIndex][patientIndex],
      memberSeconds: team.members.map((member) => ({
        memberId: member.id,
        seconds: Math.round(costs[teamIndex][patientIndex]),
        travelMode: "TEST",
      })),
    })),
  );
  return {
    elementCount: request.teams.reduce((sum, team) => sum + team.members.length * request.cohort.patients.length, 0),
    costs,
    candidateCosts,
    unresolvedRoutes: [],
  };
}

test("every member is used and capacity is respected", async () => {
  const request = baseRequest();
  request.cohort.patients = [{ id: "patient-token", location: { address: "Paris" }, parity: "primiparous" }];
  request.teams = [
    {
      id: "near",
      minPatients: 0,
      maxPatients: 1,
      members: [
        { id: "near-a", location: { address: "Paris" } },
        { id: "near-b", location: { address: "Paris" } },
      ],
    },
    { id: "far", minPatients: 0, maxPatients: 1, members: [{ id: "far-a", location: { address: "Lyon" } }] },
  ];
  const matrix: RouteMatrix = {
    elementCount: 3,
    costs: [[75], [600]],
    candidateCosts: [
      {
        patientId: "patient-token",
        teamId: "near",
        meanSeconds: 75,
        memberSeconds: [
          { memberId: "near-a", seconds: 60, travelMode: "TEST" },
          { memberId: "near-b", seconds: 90, travelMode: "TEST" },
        ],
      },
      {
        patientId: "patient-token",
        teamId: "far",
        meanSeconds: 600,
        memberSeconds: [{ memberId: "far-a", seconds: 600, travelMode: "TEST" }],
      },
    ],
    unresolvedRoutes: [],
  };

  const result = await calculateWithProvider(request, new TestProvider(matrix), 0);
  assert.equal(result.resultStatus, "optimal");
  assert.deepEqual(result.assignments, [{ patientId: "patient-token", teamId: "near" }]);
  assert.equal(result.candidateTravelCosts.length, 2);
  const nearCost = result.candidateTravelCosts[0];
  assert.equal(nearCost.teamId, "near");
  assert.equal(nearCost.meanSeconds, 75);
  assert.deepEqual(nearCost.memberSeconds.map((member) => member.seconds), [60, 90]);
  assert.equal(result.assignmentExplanations.length, 2);
  const explanation = result.assignmentExplanations.find((item) => item.teamId === "near");
  assert.ok(explanation);
  assert.equal(explanation.meanTravelSeconds, 75);
  assert.equal(explanation.closestMemberId, "near-a");
  assert.equal(explanation.closestMemberSeconds, 60);
  assert.equal(explanation.matchScore, 20);
  assert.equal(explanation.criteriaScores.geography, 100);
  assert.equal(explanation.criteriaScores.capacity, 0);
  assert.equal(explanation.criteriaScores.parity, 100);
  assert.equal(result.teams[0].assignedCount, 1);
  assert.equal(result.teams[1].assignedCount, 0);
});

test("capacity balance outranks travel and weights are fixed", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous" },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous" },
  ];
  request.teams = [
    { id: "near", minPatients: 0, maxPatients: 2, members: [{ id: "near-member", location: { address: "Paris" } }] },
    { id: "far", minPatients: 0, maxPatients: 2, members: [{ id: "far-member", location: { address: "Lyon" } }] },
  ];
  request.settings.weights = { capacity: 0, geography: 1, parity: 0 };

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60], [60_000, 60_000]])), 0);
  assert.equal(result.teams[0].assignedCount, 1);
  assert.equal(result.teams[1].assignedCount, 1);
  assert.deepEqual(result.settings.configuredWeights, { capacity: 0.8, geography: 0.15, parity: 0.05 });
  assert.deepEqual(result.settings.effectiveWeights, { capacity: 0.8, geography: 0.15, parity: 0.05 });
});

test("aggregate capacity infeasibility is explicit and skips the provider", async () => {
  const request = baseRequest();
  request.cohort.patients = [{ id: "patient-token", location: { address: "Paris" }, parity: "primiparous" }];
  request.teams = [{ id: "team-token", minPatients: 2, maxPatients: 3, members: [{ id: "member-token", location: { address: "Paris" } }] }];
  const provider = new TestProvider(matrixFor(request, [[0]]));

  const result = await calculateWithProvider(request, provider, 0);
  assert.equal(result.resultStatus, "infeasible");
  assert.deepEqual(result.assignments, []);
  assert.ok(result.issues.length > 0);
  assert.equal(provider.calls, 0);
});

test("invalid cohort half is rejected", async () => {
  const request = baseRequest();
  (request.cohort as { expectedDeliveryHalf: number }).expectedDeliveryHalf = 5;
  await assert.rejects(
    () => calculateWithProvider(request, new TestProvider({ elementCount: 0, costs: [], candidateCosts: [], unresolvedRoutes: [] }), 0),
    DispatchValidationError,
  );
});

test("fourth cohort is accepted", async () => {
  const request = baseRequest();
  request.cohort.expectedDeliveryHalf = 4;
  const result = await calculateWithProvider(request, new TestProvider({ elementCount: 0, costs: [], candidateCosts: [], unresolvedRoutes: [] }), 0);
  assert.equal(result.resultStatus, "optimal");
});

test("PEC eligible patients are distributed equally", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous", eligiblePec100: true },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous", eligiblePec100: true },
    { id: "p3", location: { address: "Paris" }, parity: "primiparous", eligiblePec100: true },
  ];
  request.teams = [
    { id: "a", minPatients: 0, maxPatients: 3, members: [{ id: "ma", location: { address: "Paris" } }] },
    { id: "b", minPatients: 0, maxPatients: 3, members: [{ id: "mb", location: { address: "Paris" } }] },
    { id: "c", minPatients: 0, maxPatients: 3, members: [{ id: "mc", location: { address: "Paris" } }] },
  ];

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60, 60], [60, 60, 60], [60, 60, 60]])), 0);
  const counts = new Map<string, number>();
  for (const assignment of result.assignments) counts.set(assignment.teamId, (counts.get(assignment.teamId) ?? 0) + 1);
  assert.equal(result.resultStatus, "optimal");
  assert.equal(counts.get("a"), 1);
  assert.equal(counts.get("b"), 1);
  assert.equal(counts.get("c"), 1);
});

test("PEC balance is infeasible when capacity prevents it", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous", eligiblePec100: true },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous", eligiblePec100: true },
  ];
  request.teams = [
    { id: "a", minPatients: 0, maxPatients: 2, members: [{ id: "ma", location: { address: "Paris" } }] },
    { id: "b", minPatients: 0, maxPatients: 0, members: [{ id: "mb", location: { address: "Paris" } }] },
  ];

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60], [60, 60]])), 0);
  assert.equal(result.resultStatus, "infeasible");
  assert.deepEqual(result.assignments, []);
});

test("PEC remainder and non-eligible patients are allowed", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous", eligiblePec100: true },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous", eligiblePec100: true },
    { id: "p3", location: { address: "Paris" }, parity: "multiparous" },
  ];
  request.teams = [
    { id: "a", minPatients: 0, maxPatients: 3, members: [{ id: "ma", location: { address: "Paris" } }] },
    { id: "b", minPatients: 0, maxPatients: 3, members: [{ id: "mb", location: { address: "Paris" } }] },
    { id: "c", minPatients: 0, maxPatients: 3, members: [{ id: "mc", location: { address: "Paris" } }] },
  ];

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60, 60], [60, 60, 60], [60, 60, 60]])), 0);
  const eligibleTeams = new Set(result.assignments.filter((assignment) => assignment.patientId !== "p3").map((assignment) => assignment.teamId));
  assert.equal(result.resultStatus, "optimal");
  assert.equal(result.assignments.length, 3);
  assert.equal(eligibleTeams.size, 2);
});

test("conflicting PEC eligibility is infeasible", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous", eligiblePec100: true, eligibleTeamIds: ["a"] },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous", eligiblePec100: true, eligibleTeamIds: ["a"] },
  ];
  request.teams = [
    { id: "a", minPatients: 0, maxPatients: 2, members: [{ id: "ma", location: { address: "Paris" } }] },
    { id: "b", minPatients: 0, maxPatients: 2, members: [{ id: "mb", location: { address: "Paris" } }] },
  ];

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60], [60, 60]])), 0);
  assert.equal(result.resultStatus, "infeasible");
  assert.deepEqual(result.assignments, []);
});

test("eligibility restrictions can make the search infeasible", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous", eligibleTeamIds: ["a"] },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous", eligibleTeamIds: ["a"] },
  ];
  request.teams = [
    { id: "a", minPatients: 1, maxPatients: 1, members: [{ id: "ma", location: { address: "Paris" } }] },
    { id: "b", minPatients: 1, maxPatients: 1, members: [{ id: "mb", location: { address: "Paris" } }] },
  ];

  const result = await calculateWithProvider(request, new TestProvider(matrixFor(request, [[60, 60], [60, 60]])), 0);
  assert.equal(result.resultStatus, "infeasible");
  assert.ok(result.issues.length > 0);
});

test("unknown parity is rejected", async () => {
  const request = baseRequest();
  request.cohort.patients = [{ id: "p1", location: { address: "Paris" }, parity: "unknown" as never }];
  request.teams = [{ id: "a", minPatients: 1, maxPatients: 1, members: [{ id: "ma", location: { address: "Paris" } }] }];
  await assert.rejects(
    () => calculateWithProvider(request, new TestProvider(matrixFor(request, [[60]])), 0),
    DispatchValidationError,
  );
});

test("unresolved required routes block assignment", async () => {
  const request = baseRequest();
  request.cohort.patients = [{ id: "p1", location: { address: "Paris" }, parity: "multiparous" }];
  request.teams = [{ id: "a", minPatients: 1, maxPatients: 1, members: [{ id: "ma", location: { address: "Paris" } }] }];
  const matrix: RouteMatrix = {
    elementCount: 1,
    costs: [[0]],
    candidateCosts: [],
    unresolvedRoutes: [{ patientId: "p1", teamId: "a", memberId: "ma", code: "route_not_found" }],
  };

  const result = await calculateWithProvider(request, new TestProvider(matrix), 625);
  assert.equal(result.resultStatus, "needs_review");
  assert.equal(result.solver.status, "not_run");
  assert.deepEqual(result.assignments, []);
  assert.equal(result.scores, null);
});

test("the per-calculation route limit is checked before the provider call", async () => {
  const request = baseRequest();
  request.cohort.patients = [
    { id: "p1", location: { address: "Paris" }, parity: "primiparous" },
    { id: "p2", location: { address: "Paris" }, parity: "multiparous" },
  ];
  request.teams = [{ id: "a", minPatients: 0, maxPatients: 2, members: [{ id: "ma", location: { address: "Paris" } }] }];
  const provider = new TestProvider(matrixFor(request, [[60, 60]]), 2, "Google Routes API");

  await assert.rejects(
    () => calculateWithProvider(request, provider, 3),
    DispatchValidationError,
  );
  assert.equal(provider.calls, 0);
});

test("address and place ID locations are accepted", async () => {
  const request = baseRequest();
  request.cohort.patients = [{ id: "p1", location: { address: "10 rue de Rivoli, Paris" }, parity: "primiparous" }];
  request.teams = [{ id: "a", minPatients: 1, maxPatients: 1, members: [{ id: "ma", location: { placeId: "ChIJsynthetic" } }] }];
  const provider = new TestProvider(matrixFor(request, [[600]]), 1, "Google Routes API");

  const result = await calculateWithProvider(request, provider, 625);
  assert.equal(provider.calls, 1);
  assert.equal(result.resultStatus, "optimal");
  assert.equal(result.assignments.length, 1);
});
