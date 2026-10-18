import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/swift-parity.json";
import {
  defaults,
  PlannerError,
  type Journey,
  type Leg,
  type Place,
  type RouteRequest,
} from "../src/model";
import {
  ApiClient,
  baseVariants,
  mapResponse,
  type Batch,
  type RoutingClient,
} from "../src/transitous";
import { PlanningRoutingClient } from "../src/planning-routing";
import { PlanningSession } from "../src/planning-state";
import { optimizeWalking } from "../src/walking-optimization";

vi.mock("../src/search", () => ({ locate: vi.fn() }));

const origin: Place = {
  name: "Start",
  detail: "",
  latitude: 48.132,
  longitude: 11.5756,
};
const destination = {
  ...origin,
  name: "Ziel",
  latitude: 48.175,
  longitude: 11.6,
};
const request: RouteRequest = {
  origin,
  destination,
  timing: "depart",
  time: Date.parse("2026-09-04T08:00:00Z") / 1000,
};
const batch = (journeys: Journey[] = []): Batch => ({
  journeys,
  issues: [],
  rejected: false,
  stop: false,
});
const signal = () => new AbortController().signal;
const settings = { ...defaults, maxBikeTransfers: 0 };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("calculation routing responses", () => {
  it("reuses successful empty replies without consuming a new request budget", async () => {
    const api: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async (_r, _s, _v, _signal, budget) => {
        budget?.take();
        return batch();
      }),
    };
    const client = new PlanningRoutingClient(api);
    const budget = { take: vi.fn() };
    await client.batch(request, defaults, baseVariants[0], signal(), budget);
    await client.batch(
      structuredClone(request),
      Object.fromEntries(Object.entries(defaults).reverse()) as typeof defaults,
      { post: "BIKE", pre: "BIKE", direct: true },
      signal(),
      budget,
    );
    expect(api.batch).toHaveBeenCalledOnce();
    expect(budget.take).toHaveBeenCalledOnce();
    api.retryAt = 123;
    expect(client.retryAt).toBe(123);
  });

  it("isolates cached journeys from mutations in the planning graph", async () => {
    const reply = mapResponse(
      fixture.multimodal,
      request,
      defaults,
      baseVariants[2],
    );
    const api = { retryAt: 0, batch: vi.fn(async () => reply) };
    const client = new PlanningRoutingClient(api);
    const first = await client.batch(
      request,
      defaults,
      baseVariants[2],
      signal(),
    );
    const expected = structuredClone(first);
    first.journeys[0].legs[0].from.name = "Changed";
    first.journeys.length = 0;
    expect(
      await client.batch(request, defaults, baseVariants[2], signal()),
    ).toEqual(expected);
    expect(api.batch).toHaveBeenCalledOnce();
  });

  for (const incomplete of ["issues", "rejected", "stop", "error"])
    it(`repeats replies with ${incomplete} until they complete`, async () => {
      const api = {
        retryAt: 0,
        batch: vi.fn(async () => {
          if (api.batch.mock.calls.length === 1) {
            if (incomplete === "error") throw new Error("Failed");
            return {
              ...batch(),
              issues: incomplete === "issues" ? ["Partial"] : [],
              rejected: incomplete === "rejected",
              stop: incomplete === "stop",
            };
          }
          return batch();
        }),
      };
      const client = new PlanningRoutingClient(api);
      const first = client.batch(request, defaults, baseVariants[0], signal());
      if (incomplete === "error") await expect(first).rejects.toThrow("Failed");
      else await first;
      await client.batch(request, defaults, baseVariants[0], signal());
      await client.batch(request, defaults, baseVariants[0], signal());
      expect(api.batch).toHaveBeenCalledTimes(2);
    });

  it("does not remember a late response after cancellation", async () => {
    let release!: (value: Batch) => void;
    const api = {
      retryAt: 0,
      batch: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Batch>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(batch()),
    };
    const client = new PlanningRoutingClient(api);
    const controller = new AbortController();
    const pending = client.batch(
      request,
      defaults,
      baseVariants[0],
      controller.signal,
    );
    controller.abort();
    release(batch());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await client.batch(request, defaults, baseVariants[0], signal());
    expect(api.batch).toHaveBeenCalledTimes(2);
  });
});

describe("real planner continuation", () => {
  for (const timing of ["depart", "arrive"] as const)
    it(`retries only failed HTTP calls for a fixed ${timing} search`, async () => {
      vi.stubGlobal("navigator", { onLine: true });
      const calls = new Map<string, number>();
      const api = new ApiClient(
        vi.fn(async (input: URL) => {
          const key = input.toString();
          const count = (calls.get(key) ?? 0) + 1;
          calls.set(key, count);
          if (
            input.searchParams.get("preTransitModes") === "WALK" &&
            input.searchParams.get("postTransitModes") === "WALK" &&
            count === 1
          )
            return new Response("", { status: 500 });
          return new Response(
            JSON.stringify(
              input.searchParams.get("directModes") === "BIKE"
                ? fixture.direct
                : fixture.multimodal,
            ),
          );
        }) as typeof fetch,
      );
      const session = new PlanningSession(api, () => {});
      await session.calculate(
        {
          ...request,
          timing,
          time: timing === "arrive" ? request.time + 7200 : request.time,
        },
        settings,
        false,
      );
      expect(session.state.searchStatus).toBe("partial");
      const calculationId = session.state.calculationId;
      const before = new Map(calls);
      await session.resumeOptimization();
      expect(session.state.searchStatus).toBe("complete");
      expect(session.state.calculationId).toBe(calculationId);
      expect(calls.size).toBe(baseVariants.length);
      for (const [key, count] of calls) {
        const params = new URL(key).searchParams;
        expect(count).toBe(
          before.get(key)! +
            (params.get("preTransitModes") === "WALK" &&
            params.get("postTransitModes") === "WALK"
              ? 1
              : 0),
        );
      }
      const completedCalls = new Map(calls);
      await session.calculate(
        {
          ...request,
          timing,
          time: timing === "arrive" ? request.time + 7200 : request.time,
        },
        settings,
        false,
      );
      expect(session.state.calculationId).not.toBe(calculationId);
      for (const [key, count] of calls)
        expect(count).toBe(completedCalls.get(key)! + 1);
    });

  it("keeps completed base and bike-transfer requests across repeated timeouts", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const api = new ApiClient();
    const first = mapResponse(
      fixture.multimodal,
      request,
      defaults,
      baseVariants[2],
    ).journeys[0];
    const base = [
      first,
      {
        ...first,
        id: "later-train",
        departure: first.departure + 300,
        arrival: first.arrival + 300,
        legs: first.legs.map((leg) => ({
          ...leg,
          start: leg.start + 300,
          end: leg.end + 300,
        })),
      },
    ];
    let baseCalls = 0,
      failedKey: string | undefined;
    const extraCalls = new Map<string, number>();
    vi.spyOn(api, "batch").mockImplementation(async (r, _s, v, s, budget) => {
      s.throwIfAborted();
      budget?.take();
      if (
        r.origin.latitude === request.origin.latitude &&
        r.destination.latitude === request.destination.latitude
      ) {
        baseCalls++;
        return batch(
          !v.direct && v.pre === "BIKE" && v.post === "BIKE" ? base : [],
        );
      }
      const key = JSON.stringify(r);
      const count = (extraCalls.get(key) ?? 0) + 1;
      extraCalls.set(key, count);
      if (extraCalls.size === 2) failedKey ??= key;
      if (key === failedKey && count <= 2)
        throw new PlannerError("deadline", "Zeitlimit erreicht", true);
      return batch();
    });
    const session = new PlanningSession(api, () => {});
    await session.calculate(
      request,
      { ...defaults, maxBikeTransfers: 2 },
      false,
    );
    expect(session.state.incompletePhases).toContain("bike-transfers");
    await session.resumeOptimization();
    expect(session.state.searchStatus).toBe("partial");
    await session.resumeOptimization();
    expect(session.state.searchStatus).toBe("complete");
    expect(baseCalls).toBe(baseVariants.length);
    expect([...extraCalls.values()].sort()).toEqual([1, 3]);
  });

  it("continues beyond the walking request limit using a fresh budget", async () => {
    const journeys = Array.from({ length: 3 }, (_, index): Journey => {
      const departure = 1000 + index * 10000;
      const legs = Array.from({ length: 3 }, (_, block): Leg[] => {
        const start = departure + block * 500;
        return [
          {
            kind: "walk",
            from: origin,
            to: destination,
            start,
            end: start + 100,
            distance: 100,
            coordinates: [origin, destination],
          },
          {
            kind: "transit",
            from: destination,
            to: origin,
            start: start + 100,
            end: start + 500,
            distance: 1000,
            coordinates: [destination, origin],
            line: `S${index}`,
          },
        ];
      }).flat();
      return {
        id: `train-${index}`,
        origin,
        destination: origin,
        departure,
        arrival: departure + 1500,
        legs,
        transfers: 2,
        isDirect: false,
      };
    });
    const api: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async (_r, _s, _v, _signal, budget) => {
        budget?.take();
        return batch();
      }),
    };
    const client = new PlanningRoutingClient(api);
    let incomplete: boolean | undefined;
    for await (const update of optimizeWalking(
      journeys,
      request,
      defaults,
      signal(),
      client,
    ))
      incomplete = update.incomplete;
    expect(incomplete).toBe(true);
    expect(api.batch).toHaveBeenCalledTimes(6);
    for await (const update of optimizeWalking(
      journeys,
      request,
      defaults,
      signal(),
      client,
    ))
      incomplete = update.incomplete;
    expect(incomplete).toBe(false);
    expect(api.batch).toHaveBeenCalledTimes(9);
  });

  it("retries a failed walking check while preserving its original train", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const boarding = { ...origin, name: "Bahnhof", latitude: 48.14 };
    const original: Journey = {
      id: "walk-to-train",
      origin,
      destination,
      departure: 1000,
      arrival: 2000,
      transfers: 0,
      isDirect: false,
      legs: [
        {
          kind: "walk",
          from: origin,
          to: boarding,
          start: 1000,
          end: 1300,
          distance: 1000,
          coordinates: [origin, boarding],
        },
        {
          kind: "transit",
          from: boarding,
          to: destination,
          start: 1500,
          end: 2000,
          distance: 3000,
          coordinates: [boarding, destination],
          line: "S8",
        },
      ],
    };
    const api = new ApiClient();
    let baseCalls = 0,
      walkingCalls = 0;
    vi.spyOn(api, "batch").mockImplementation(async (_r, _s, v, s, budget) => {
      s.throwIfAborted();
      budget?.take();
      if (!v.street) {
        baseCalls++;
        return batch(v.pre === "WALK" && v.post === "WALK" ? [original] : []);
      }
      if (++walkingCalls === 1)
        throw new PlannerError("timeout", "Zeitlimit erreicht");
      return batch([
        {
          ...original,
          id: "bike-to-train",
          destination: boarding,
          arrival: 1100,
          isDirect: true,
          legs: [{ ...original.legs[0], kind: "bike", end: 1100 }],
        },
      ]);
    });
    const session = new PlanningSession(api, () => {});
    await session.calculate({ ...request, time: 1000 }, settings, false);
    expect(session.state.incompletePhases).toContain("walking");
    await session.resumeOptimization();
    expect(session.state.searchStatus).toBe("complete");
    expect(baseCalls).toBe(baseVariants.length);
    expect(walkingCalls).toBe(2);
    expect(session.state.journeys.some((j) => j.legs[0].kind === "bike")).toBe(
      true,
    );
    expect(
      session.state.journeys.every((j) => j.legs.at(-1)?.line === "S8"),
    ).toBe(true);
  });

  for (const timing of ["depart", "arrive", "now"] as const)
    it(`reuses completed intermediate sections with a fixed ${timing} time`, async () => {
      vi.stubGlobal("navigator", { onLine: true });
      vi.useFakeTimers();
      vi.setSystemTime(request.time * 1000);
      const middle = { ...origin, name: "Zwischenziel", latitude: 48.15 };
      const calls = new Map<string, number>();
      let failedKey: string | undefined;
      const api = new ApiClient();
      vi.spyOn(api, "batch").mockImplementation(async (r, _s, v, s, budget) => {
        s.throwIfAborted();
        budget?.take();
        const key = JSON.stringify([r, v]);
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        if (!v.direct && v.pre === "WALK" && v.post === "WALK") {
          failedKey ??= key;
          if (key === failedKey && count === 1) throw new Error("Unterbrochen");
        }
        const departure = r.timing === "arrive" ? r.time - 1200 : r.time;
        return batch(
          v.direct
            ? [
                {
                  id: `${r.origin.name}|${r.destination.name}|${departure}`,
                  origin: r.origin,
                  destination: r.destination,
                  departure,
                  arrival: departure + 1200,
                  transfers: 0,
                  isDirect: true,
                  legs: [
                    {
                      kind: "bike",
                      from: r.origin,
                      to: r.destination,
                      start: departure,
                      end: departure + 1200,
                      distance: 2000,
                      coordinates: [r.origin, r.destination],
                    },
                  ],
                },
              ]
            : [],
        );
      });
      const session = new PlanningSession(api, () => {});
      await session.calculate(
        {
          ...request,
          timing,
          stops: [{ id: "via", place: middle, stayMinutes: 10 }],
        },
        settings,
        false,
      );
      expect(session.state.searchStatus).toBe("partial");
      const before = structuredClone(session.state);
      const count = calls.size;
      vi.setSystemTime((request.time + 60) * 1000);
      await session.resumeOptimization();
      expect(session.state.searchStatus).toBe("complete");
      expect(session.state.request).toEqual(before.request);
      expect(session.state.queriedAt).toBe(before.queriedAt);
      expect(calls.size).toBe(count);
      expect([...calls].filter(([, count]) => count > 1)).toEqual([
        [failedKey, 2],
      ]);
    });
});
