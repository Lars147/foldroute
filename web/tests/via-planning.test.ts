import fixture from "./fixtures/swift-parity.json";
import { describe, expect, it, vi } from "vitest";
import {
  defaults,
  cyclingExcess,
  bikeBoardings,
  type Journey,
  type Place,
  type RouteRequest,
  type RouteStop,
  type RoutingSettings,
  type PlanningUpdate,
  PlannerError,
} from "../src/model";
import {
  ApiClient,
  type Variant,
  type RequestBudget,
  type Batch,
} from "../src/transitous";
import { planRoutes } from "../src/planner";
import { joinAtStop } from "../src/via-planner";
import { readRouteURL, routeURL } from "../src/route-url";
import { validSnapshot } from "../src/offline";
const p = (n: number): Place => ({
  name: `Ort ${n}`,
  detail: "",
  latitude: 48 + n * 0.01,
  longitude: 11.5,
});
const stop = (n: number, stayMinutes = 0): RouteStop => ({
  id: `stop-${n}`,
  place: p(n),
  stayMinutes,
});
const time = Date.now() / 1000 + 86400;
function ride(request: RouteRequest, minutes = 20, direct = true): Journey {
  const departure =
    request.timing === "arrive" ? request.time - minutes * 60 : request.time;
  return {
    id: `${request.origin.name}|${request.destination.name}|${departure}|${minutes}|${direct}`,
    origin: request.origin,
    destination: request.destination,
    departure,
    arrival: departure + minutes * 60,
    transfers: 0,
    isDirect: direct,
    legs: [
      {
        kind: direct ? "bike" : "transit",
        from: request.origin,
        to: request.destination,
        start: departure,
        end: departure + minutes * 60,
        distance: direct ? 5000 : 0,
        coordinates: [request.origin, request.destination],
        ...(direct ? {} : { tripId: request.origin.name, line: "S1" }),
      },
    ],
  };
}
class Client extends ApiClient {
  calls: RouteRequest[] = [];
  constructor(
    private result: (r: RouteRequest, v: Variant) => Journey[] = (r, v) =>
      v.direct ? [ride(r)] : [],
  ) {
    super();
  }
  override async batch(
    r: RouteRequest,
    _s: RoutingSettings,
    v: Variant,
    signal: AbortSignal,
    budget?: RequestBudget,
  ): Promise<Batch> {
    signal.throwIfAborted();
    budget?.take();
    this.calls.push(r);
    return {
      journeys: this.result(r, v),
      issues: [],
      stop: false,
      rejected: false,
    };
  }
}
async function collect(
  request: RouteRequest,
  client = new Client(),
  settings = { ...defaults, maxBikeTransfers: 0 },
) {
  const updates: PlanningUpdate[] = [];
  for await (const update of planRoutes(
    request,
    settings,
    new AbortController().signal,
    client,
  ))
    updates.push(update);
  return updates;
}
describe("free intermediate stops", () => {
  for (const timing of ["depart", "arrive"] as const)
    for (const count of [1, 2, 3]) {
      it(`plans ${count} stops ${timing} with dwell and publishes only complete trips`, async () => {
        const request = {
          origin: p(0),
          destination: p(count + 1),
          time,
          timing,
          stops: Array.from({ length: count }, (_, i) => stop(i + 1, 10)),
        };
        const updates = await collect(request);
        expect(updates.length).toBeGreaterThan(0);
        for (const update of updates)
          for (const j of update.journeys) {
            expect(
              j.legs.filter((l) => l.kind === "stop").map((l) => l.stop),
            ).toEqual(request.stops);
            expect(j.arrival - j.departure).toBe(
              (20 * (count + 1) + 10 * count) * 60,
            );
            expect(timing === "arrive" ? j.arrival : j.departure).toBe(time);
            expect(cyclingExcess(j, 30)).toBe(0);
          }
      });
    }
  it("permits round trips but rejects adjacent coincident stops", async () => {
    const request = {
      origin: p(0),
      destination: p(0),
      time,
      timing: "depart" as const,
      stops: [stop(1)],
    };
    expect((await collect(request)).at(-1)?.journeys).toHaveLength(1);
    await expect(collect({ ...request, stops: [stop(0)] })).rejects.toThrow(
      "Teilstrecke 1",
    );
    await expect(
      collect({ ...request, stops: [stop(1), stop(1)] }),
    ).rejects.toThrow("prüfen");
  });
  it("rejects missing sections and never returns a partial journey", async () => {
    const client = new Client((r, v) =>
      r.origin.name === p(0).name && v.direct ? [ride(r)] : [],
    );
    await expect(
      collect(
        {
          origin: p(0),
          destination: p(2),
          time,
          timing: "depart",
          stops: [stop(1)],
        },
        client,
      ),
    ).rejects.toThrow("Teilstrecke 2");
  });
  it("compares the longest cycling section and hides only over-limit complete rides", async () => {
    const client = new Client((r, v) =>
      v.direct ? [ride(r, r.origin.name === p(0).name ? 35 : 20)] : [],
    );
    const request = {
      origin: p(0),
      destination: p(2),
      time,
      timing: "depart" as const,
      stops: [stop(1, 30)],
    };
    const j = (await collect(request, client)).at(-1)!.journeys[0];
    expect(cyclingExcess(j, 30)).toBe(300);
    await expect(
      collect(request, client, {
        ...defaults,
        maxBikeTransfers: 0,
        showCyclingComparison: false,
      }),
    ).rejects.toThrow("vollständige");
  });
  it("never disguises an over-limit cycling section as a regular mixed trip", async () => {
    const client = new Client((r, v) =>
      r.origin.name === p(0).name
        ? v.direct
          ? [ride(r, 35)]
          : []
        : v.direct
          ? [ride(r, 20)]
          : [ride(r, 5, false)],
    );
    const updates = await collect(
      {
        origin: p(0),
        destination: p(2),
        time,
        timing: "depart",
        stops: [stop(1)],
      },
      client,
    );
    expect(updates.at(-1)!.journeys.every((j) => j.isDirect)).toBe(true);
  });
  it("retains pauses and checks onward departure without shifting transit times", () => {
    const first = ride(
      { origin: p(0), destination: p(1), time, timing: "depart" },
      20,
      false,
    );
    const tooEarly = ride(
      {
        origin: p(1),
        destination: p(2),
        time: first.arrival + 599,
        timing: "depart",
      },
      20,
      false,
    );
    expect(joinAtStop(first, tooEarly, stop(1, 10))).toBeUndefined();
    const onward = ride(
      {
        origin: p(1),
        destination: p(2),
        time: first.arrival + 600,
        timing: "depart",
      },
      20,
      false,
    );
    const combined = joinAtStop(first, onward, stop(1, 10))!;
    expect(combined.legs.at(-1)!.start).toBe(onward.departure);
    expect(bikeBoardings(combined)).toEqual([]);
  });
  it("honors cancellation before any routing request", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    const client = new Client();
    await expect(async () => {
      for await (const _ of planRoutes(
        {
          origin: p(0),
          destination: p(2),
          stops: [stop(1)],
          time,
          timing: "depart",
        },
        defaults,
        abort.signal,
        client,
      )) {
      }
    }).rejects.toThrow("cancelled");
    expect(client.calls).toHaveLength(0);
  });
  it("stops globally on a provider pause", async () => {
    const client = new Client(() => {
      throw new PlannerError("pause", "Pause", true);
    });
    await expect(
      collect(
        {
          origin: p(0),
          destination: p(2),
          stops: [stop(1)],
          time,
          timing: "depart",
        },
        client,
      ),
    ).rejects.toThrow("Pause");
    expect(client.calls.length).toBeLessThanOrEqual(2);
  });
  it("round-trips v2 links and rejects gaps, invalid stays, and unversioned stops", () => {
    const request = {
      origin: p(0),
      destination: p(4),
      stops: [stop(1, 10), stop(2, 0), stop(3, 1440)],
      time,
      timing: "depart" as const,
    };
    const url = routeURL("https://example.org/plan/", {
      request,
      settings: defaults,
    });
    expect(url.searchParams.get("v")).toBe("2");
    const parsed = readRouteURL(url);
    expect(parsed.kind).toBe("plan");
    if (parsed.kind === "plan")
      expect(parsed.plan.request.stops?.map(({ id, ...s }) => s)).toEqual(
        request.stops.map(({ id, ...s }) => s),
      );
    for (const [key, value] of [
      ["v", "1"],
      ["via2Stay", "-1"],
      ["via3Stay", "1441"],
      ["via1Stay", "1.5"],
      ["via4", "48,11"],
    ]) {
      const invalid = new URL(url);
      invalid.searchParams.set(key, value);
      expect(readRouteURL(invalid).kind).toBe("invalid");
    }
    url.searchParams.delete("via2");
    expect(readRouteURL(url).kind).toBe("invalid");
  });
  it("restores complete v4 snapshots and rejects omitted or mismatched stops", async () => {
    const request = {
      origin: p(0),
      destination: p(2),
      stops: [stop(1, 10)],
      time,
      timing: "depart" as const,
    };
    const journey = (await collect(request)).at(-1)!.journeys[0];
    const snapshot = {
      version: 4,
      savedAt: time,
      request,
      journey,
      settings: defaults,
    };
    expect(validSnapshot(snapshot)).toBe(true);
    expect(validSnapshot({ ...snapshot, version: 3 })).toBe(false);
    expect(
      validSnapshot({ ...snapshot, request: { ...request, stops: [] } }),
    ).toBe(false);
  });
});

for (const scenario of fixture.viaScenarios) {
  it(`matches Swift for ${scenario.count} stops with ${scenario.timing}`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    try {
      const request: RouteRequest = {
        origin: p(0),
        destination: p(scenario.count + 1),
        time: scenario.time,
        timing: scenario.timing as "depart" | "arrive",
        stops: Array.from({ length: scenario.count }, (_, i) =>
          stop(i + 1, 10),
        ),
      };
      const result = (await collect(request)).at(-1)!.journeys.map((j) => ({
        departure: j.departure,
        arrival: j.arrival,
        transfers: j.transfers,
        isDirect: j.isDirect,
        excess: cyclingExcess(j, 30),
        legs: j.legs.map((l) => ({
          kind: l.kind,
          start: l.start,
          end: l.end,
        })),
      }));
      expect(result).toEqual(scenario.expected);
    } finally {
      vi.useRealTimers();
    }
  });
}

it("caps all section requests globally and retains complete alternatives", async () => {
  const client = new Client((r, v) =>
    v.direct
      ? [ride(r, 35)]
      : [ride(r, 5, false), ride(r, 7, false), ride(r, 9, false)],
  );
  const updates = await collect(
    {
      origin: p(0),
      destination: p(4),
      time,
      timing: "depart",
      stops: [stop(1), stop(2), stop(3)],
    },
    client,
    { ...defaults, maxBikeTransfers: 3 },
  );
  expect(client.calls.length).toBeLessThanOrEqual(64);
  expect(updates.at(-1)?.status).toBe("partial");
  for (const j of updates.at(-1)!.journeys)
    expect(j.legs.filter((l) => l.kind === "stop")).toHaveLength(3);
});
