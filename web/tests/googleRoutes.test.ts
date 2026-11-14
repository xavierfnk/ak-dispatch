import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ProviderError } from "../src/dispatch/errors.ts";
import { googleRoutesProvider, parseDurationSeconds } from "../src/dispatch/googleRoutes.ts";
import type { CalculateRequest } from "../src/types.ts";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function request(teams: CalculateRequest["teams"], patients: CalculateRequest["cohort"]["patients"]): CalculateRequest {
  return {
    requestId: "request-token",
    cohort: { id: "cohort-token", revision: 1, expectedDeliveryMonth: "2027-04", expectedDeliveryHalf: 1, patients },
    teams,
    settings: { weights: { capacity: 0.8, geography: 0.15, parity: 0.05 }, referenceTravelTimeMinutes: 30 },
  };
}

test("the fastest travel mode is selected per member", async () => {
  const calls = { count: 0 };
  const modes = new Set<string>();
  const restore = mockFetch(async (_input, init) => {
    calls.count++;
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["X-Goog-Api-Key"], "test-key");
    assert.equal(headers["X-Goog-FieldMask"], "originIndex,destinationIndex,duration,status,condition");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body)) as {
      travelMode: string;
      origins: Array<{ waypoint: { address?: string } }>;
      destinations: Array<{ waypoint: { address?: string } }>;
    };
    modes.add(body.travelMode);
    assert.equal(body.origins.length, 2);
    assert.equal(body.destinations.length, 1);
    assert.ok(body.origins[0].waypoint.address);
    const elements = body.travelMode === "BICYCLE"
      ? [
          { originIndex: 1, destinationIndex: 0, condition: "ROUTE_NOT_FOUND", status: { code: 0 } },
          { originIndex: 0, destinationIndex: 0, duration: "60s", condition: "ROUTE_EXISTS", status: { code: 0 } },
        ]
      : [
          { originIndex: 1, destinationIndex: 0, duration: "90s", condition: "ROUTE_EXISTS", status: { code: 0 } },
          { originIndex: 0, destinationIndex: 0, duration: "120s", condition: "ROUTE_EXISTS", status: { code: 0 } },
        ];
    return new Response(JSON.stringify(elements), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const matrix = await googleRoutesProvider("test-key").compute(request(
      [{
        id: "team-private",
        minPatients: 0,
        maxPatients: 2,
        members: [
          { id: "member-a", location: { address: "40 Rue de Rivoli, Paris" } },
          { id: "member-b", location: { address: "27 Rue Saint-Denis, Paris" } },
        ],
      }],
      [{ id: "patient-private", location: { address: "Place d'Italie, Paris" }, parity: "primiparous" }],
    ));
    assert.equal(matrix.elementCount, 4);
    assert.equal(matrix.costs[0][0], 75);
    assert.equal(calls.count, 2);
    assert.ok(modes.has("BICYCLE"));
    assert.ok(modes.has("TRANSIT"));
    assert.deepEqual(matrix.candidateCosts[0].memberSeconds.map((member) => member.seconds), [60, 90]);
    assert.deepEqual(matrix.candidateCosts[0].memberSeconds.map((member) => member.travelMode), ["BICYCLE", "TRANSIT"]);
  } finally {
    restore();
  }
});

test("route requests contain only addresses and routing options", async () => {
  let calls = 0;
  const restore = mockFetch(async (_input, init) => {
    calls++;
    const payload = String(init?.body);
    for (const forbidden of ["team-private", "member-private", "patient-private", "primiparous", "eligiblePec100"]) {
      assert.ok(!payload.includes(forbidden), `Google request included local assignment data ${forbidden}: ${payload}`);
    }
    const body = JSON.parse(payload) as {
      origins: Array<{ waypoint: { address?: string } }>;
      destinations: Array<{ waypoint: { address?: string } }>;
    };
    assert.equal(body.origins[0].waypoint.address, "40 Rue de Rivoli, Paris");
    assert.equal(body.destinations[0].waypoint.address, "27 Rue Saint-Denis, Paris");
    return new Response(JSON.stringify([{ originIndex: 0, destinationIndex: 0, duration: "60s", condition: "ROUTE_EXISTS", status: { code: 0 } }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    await googleRoutesProvider("test-key").compute(request(
      [{ id: "team-private", minPatients: 0, maxPatients: 1, members: [{ id: "member-private", location: { address: "40 Rue de Rivoli, Paris" } }] }],
      [{ id: "patient-private", location: { address: "27 Rue Saint-Denis, Paris" }, parity: "primiparous", eligiblePec100: true }],
    ));
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("an unresolved member route does not produce a partial mean", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return new Response(JSON.stringify([
      { originIndex: 0, destinationIndex: 0, duration: "60s", condition: "ROUTE_EXISTS", status: { code: 0 } },
      { originIndex: 1, destinationIndex: 0, condition: "ROUTE_NOT_FOUND", status: { code: 0 } },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const matrix = await googleRoutesProvider("test-key").compute(request(
      [{
        id: "team-token",
        minPatients: 0,
        maxPatients: 1,
        members: [
          { id: "member-a", location: { address: "Paris" } },
          { id: "member-b", location: { address: "Lyon" } },
        ],
      }],
      [{ id: "patient-token", location: { address: "Paris" }, parity: "primiparous" }],
    ));
    assert.equal(matrix.unresolvedRoutes.length, 1);
    assert.equal(matrix.unresolvedRoutes[0].memberId, "member-b");
    assert.equal(calls, 2);
    assert.equal(matrix.candidateCosts.length, 0);
  } finally {
    restore();
  }
});

test("matrix requests stay within Google waypoint and element limits", async () => {
  let calls = 0;
  const modes = new Set<string>();
  const restore = mockFetch(async (_input, init) => {
    calls++;
    const payload = String(init?.body);
    if (calls === 1) {
      assert.ok(payload.includes('"placeId":"origin-place-0"'));
      assert.ok(!payload.includes("member-"));
    }
    const body = JSON.parse(payload) as {
      travelMode: string;
      origins: unknown[];
      destinations: unknown[];
    };
    modes.add(body.travelMode);
    const maxElements = body.travelMode === "TRANSIT" ? 100 : 625;
    assert.ok(body.origins.length * body.destinations.length <= maxElements);
    assert.ok(body.origins.length + body.destinations.length <= 50);
    const elements = body.origins.flatMap((_origin, originIndex) =>
      body.destinations.map((_destination, destinationIndex) => ({
        originIndex,
        destinationIndex,
        duration: "60s",
        condition: "ROUTE_EXISTS",
        status: { code: 0 },
      })),
    );
    return new Response(JSON.stringify(elements), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const members = Array.from({ length: 26 }, (_, index) => ({ id: `member-${index}`, location: { placeId: `origin-place-${index}` } }));
    const patients = Array.from({ length: 26 }, (_, index) => ({ id: `patient-${index}`, location: { placeId: `destination-place-${index}` }, parity: "primiparous" as const }));
    const matrix = await googleRoutesProvider("test-key").compute(request(
      [{ id: "team", minPatients: 0, maxPatients: 26, members }],
      patients,
    ));
    assert.equal(calls, 13);
    assert.equal(matrix.elementCount, 2 * 26 * 26);
    assert.equal(matrix.candidateCosts.length, 26);
    assert.ok(modes.has("BICYCLE"));
    assert.ok(modes.has("TRANSIT"));
  } finally {
    restore();
  }
});

test("quota errors are safe and not retried", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return new Response('{"error":{"message":"private provider detail"}}', { status: 429 });
  });

  try {
    await assert.rejects(
      () => googleRoutesProvider("test-key").compute(request(
        [{ id: "team", minPatients: 0, maxPatients: 1, members: [{ id: "member", location: { address: "Paris" } }] }],
        [{ id: "patient", location: { address: "Paris" }, parity: "primiparous" }],
      )),
      (error: unknown) => error instanceof ProviderError && error.code === "provider_quota_exceeded" && !error.message.includes("private provider detail"),
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("Google duration strings are parsed safely", () => {
  assert.equal(parseDurationSeconds("60s"), 60);
  assert.equal(parseDurationSeconds("1.5s"), 1.5);
  assert.equal(parseDurationSeconds("1m30s"), 90);
  assert.equal(parseDurationSeconds("1h2m3s"), 3723);
  assert.equal(parseDurationSeconds("100ms"), 0.1);
  assert.equal(parseDurationSeconds("invalid"), null);
  assert.equal(parseDurationSeconds("1s2"), null);
  assert.equal(parseDurationSeconds("-1s"), null);
});
