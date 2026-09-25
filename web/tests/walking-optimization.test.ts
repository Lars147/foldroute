import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cyclingReplacement,
  walkingBlocks,
  optimizeWalking,
} from "../src/walking-optimization";
import {
  defaults,
  compare,
  transition,
  type Journey,
  type Leg,
  type RouteRequest,
} from "../src/model";
import { ApiClient, makeURL, mapResponse } from "../src/transitous";
import { planRoutes } from "../src/planner";
import fixture from "./fixtures/swift-parity.json";
const a = {
  name: "A",
  detail: "",
  latitude: 48.13,
  longitude: 11.57,
  stopId: "station-a",
};
const b = { ...a, name: "B", latitude: 48.14, stopId: "station-b" };
const c = { ...b, name: "C", latitude: 48.15, stopId: "station-c" };
const movement = (
  kind: "walk" | "bike",
  start: number,
  end: number,
  from = a,
  to = b,
): Leg => ({
  kind,
  start,
  end,
  from,
  to,
  distance: 1000,
  coordinates: [from, to],
});
const journey = (id: string, legs: Leg[], isDirect = false): Journey => ({
  id,
  origin: legs[0].from,
  destination: legs.at(-1)!.to,
  legs,
  departure: legs[0].start,
  arrival: legs.at(-1)!.end,
  isDirect,
  transfers: 0,
});
const transit: Leg = {
  kind: "transit",
  start: 1500,
  end: 2000,
  from: b,
  to: c,
  distance: 2000,
  coordinates: [b, c],
  line: "S8",
  mode: "SUBURBAN",
};
const access = () =>
  journey("original", [
    movement("walk", 1000, 1300),
    transition("fold", b, 1300, 1500),
    transit,
  ]);
const ride = (start = 1000, end = 1100) =>
  journey("ride", [movement("bike", start, end)], true);
const request: RouteRequest = {
  origin: a,
  destination: c,
  timing: "depart",
  time: 1000,
};
const settings = { ...defaults, foldingDuration: 60, maxBikeTransfers: 2 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safe walking replacement", () => {
  it("keeps the same train, boarding stop and folding time, reducing walking", () => {
    const original = access();
    const result = cyclingReplacement(
      walkingBlocks([original])[0],
      ride(),
      settings,
    )!;
    expect(result.legs.map((l) => l.kind)).toEqual([
      "bike",
      "wait",
      "fold",
      "transit",
    ]);
    expect(result.legs.at(-1)).toBe(transit);
    expect(result.legs.at(-2)).toBe(original.legs[1]);
    expect(result.departure).toBe(original.departure);
    expect(result.arrival).toBe(original.arrival);
    expect(compare(result, original, "depart")).toBeLessThan(0);
    expect(
      compare(original, { ...result, arrival: 2001 }, "depart"),
    ).toBeLessThan(0);
    expect(
      compare(original, { ...result, departure: 999 }, "arrive"),
    ).toBeLessThan(0);
  });
  it.each([
    [999, 1100],
    [1000, 1301],
  ])("rejects earlier departure or a missed fold: %s–%s", (start, end) => {
    expect(
      cyclingReplacement(
        walkingBlocks([access()])[0],
        ride(start, end),
        settings,
      ),
    ).toBeUndefined();
  });
  it("keeps unavoidable walking in an actual mixed street route", () => {
    const mixed = journey(
      "mixed",
      [movement("walk", 1000, 1020, a, a), movement("bike", 1020, 1100)],
      true,
    );
    const result = cyclingReplacement(
      walkingBlocks([access()])[0],
      mixed,
      settings,
    )!;
    expect(result.legs[0]).toBe(mixed.legs[0]);
  });
  it("respects cycling limits and rejects disconnected endpoints", () => {
    const block = walkingBlocks([access()])[0];
    expect(
      cyclingReplacement(block, ride(), { ...settings, maxCyclingMinutes: 1 }),
    ).toBeUndefined();
    expect(
      cyclingReplacement(
        block,
        journey("wrong", [movement("bike", 1000, 1100, c, b)], true),
        settings,
      ),
    ).toBeUndefined();
  });
  it("reserves unfolding, folding and 180 seconds for an internal transfer", () => {
    const original = journey("transfer", [
      { ...transit, from: a, to: a, start: 0, end: 1000 },
      movement("walk", 1000, 1600),
      { ...transit, start: 1600, end: 2000 },
    ]);
    const block = walkingBlocks([original])[0];
    expect(block.folded).toBe(true);
    const result = cyclingReplacement(block, ride(1060, 1360), settings)!;
    expect(result.legs.map((l) => l.kind)).toEqual([
      "transit",
      "unfold",
      "bike",
      "fold",
      "wait",
      "transit",
    ]);
    expect(
      cyclingReplacement(block, ride(1060, 1361), settings),
    ).toBeUndefined();
    expect(
      cyclingReplacement(block, ride(1060, 1360), {
        ...settings,
        maxBikeTransfers: 0,
      }),
    ).toBeUndefined();
  });
  it("optimizes egress without delaying arrival", () => {
    const original = journey("egress", [
      { ...transit, from: a, to: a, start: 0, end: 800 },
      transition("unfold", a, 800, 1000),
      movement("walk", 1000, 1300),
    ]);
    expect(
      cyclingReplacement(walkingBlocks([original])[0], ride(), settings)
        ?.arrival,
    ).toBe(1100);
  });
});

it("matches native replacement decisions and leg order", () => {
  const transfer = journey("transfer", [
    { ...transit, from: a, to: a, start: 0, end: 1000 },
    movement("walk", 1000, 1600),
    { ...transit, start: 1600, end: 2000 },
  ]);
  const cases: [string, Journey, number, number, number, number][] = [
    ["access", access(), 1000, 1100, 30, 2],
    ["early", access(), 999, 1100, 30, 2],
    ["late", access(), 1000, 1301, 30, 2],
    ["limit", access(), 1000, 1100, 1, 2],
    ["transfer", transfer, 1060, 1360, 30, 2],
    ["buffer", transfer, 1060, 1361, 30, 2],
    ["noBikeTransfer", transfer, 1060, 1360, 30, 0],
  ];
  expect(
    cases.map(([name, original, start, end, limit, maxTransfers]) => {
      const result = cyclingReplacement(
        walkingBlocks([original])[0],
        ride(start, end),
        {
          ...settings,
          maxCyclingMinutes: limit,
          maxBikeTransfers: maxTransfers,
        },
      );
      return {
        name,
        accepted: !!result,
        kinds: result?.legs.map((l) => l.kind) ?? [],
      };
    }),
  ).toEqual(fixture.walkingCases);
});

describe("bounded additional street requests", () => {
  it("uses stop IDs and the configured cycling limit", () => {
    const url = makeURL(request, settings, {
      direct: true,
      street: true,
      pre: "BIKE",
      post: "BIKE",
    });
    expect(url.searchParams.get("fromPlace")).toBe("station-a");
    expect(url.searchParams.get("toPlace")).toBe("station-c");
    expect(url.searchParams.get("maxDirectTime")).toBe(
      String(settings.maxCyclingMinutes * 60),
    );
  });
  it.each(["STAIRS", "ELEVATOR"])(
    "rejects bike legs containing %s",
    (direction) => {
      expect(
        mapResponse(fixture.direct, request, settings, {
          direct: true,
          street: true,
          pre: "BIKE",
          post: "BIKE",
        }).journeys.length,
      ).toBeGreaterThan(0);
      const raw = structuredClone(fixture.direct);
      const item = raw.direct[0];
      Object.assign(item.legs[0], {
        steps: [{ relativeDirection: direction }],
      });
      const response = mapResponse(raw, request, settings, {
        direct: true,
        street: true,
        pre: "BIKE",
        post: "BIKE",
      });
      expect(response.journeys).toHaveLength(0);
    },
  );
  it("deduplicates identical checks and returns improvements progressively", async () => {
    const client = new ApiClient();
    const batch = vi
      .spyOn(client, "batch")
      .mockResolvedValue({ journeys: [ride()], issues: [] });
    let last: Journey[] = [];
    for await (const update of optimizeWalking(
      [
        access(),
        journey("other", [
          ...access().legs.slice(0, -1),
          { ...transit, line: "S9" },
        ]),
      ],
      request,
      settings,
      new AbortController().signal,
      client,
    ))
      last = update.journeys;
    expect(batch).toHaveBeenCalledTimes(1);
    expect(last.filter((j) => j.id.includes("|ride:"))).toHaveLength(2);
  });
  it("caps extra requests at six, including retries, with at most two active", async () => {
    const client = new ApiClient();
    let active = 0,
      peak = 0,
      requests = 0;
    vi.spyOn(client, "batch").mockImplementation(
      async (_r, _s, _v, _signal, budget) => {
        budget!.take();
        requests++;
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        budget!.take();
        requests++; // Simulate one retry, charged to the same budget.
        return { journeys: [], issues: [] };
      },
    );
    const legs = Array.from({ length: 8 }, (_, i) => [
      movement("walk", i * 1000, i * 1000 + 600),
      {
        ...transit,
        from: b,
        to: a,
        start: i * 1000 + 600,
        end: i * 1000 + 900,
      },
    ]).flat();
    for await (const _ of optimizeWalking(
      [journey("many", legs)],
      request,
      settings,
      new AbortController().signal,
      client,
    )) {
      /* consume */
    }
    expect(requests).toBe(6);
    expect(peak).toBe(2);
  });
  it("cancels at the deadline and retains original results", async () => {
    vi.useFakeTimers();
    const client = new ApiClient();
    vi.spyOn(client, "batch").mockImplementation(
      (_r, _s, _v, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const original = access();
    const run = (async () => {
      let results = [original];
      for await (const update of optimizeWalking(
        results,
        request,
        settings,
        new AbortController().signal,
        client,
      ))
        results = update.journeys;
      return results;
    })();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await run).toEqual([original]);
  });
});

it("publishes the original immediately and finishes with its improved version", async () => {
  const client = new ApiClient();
  vi.spyOn(client, "batch").mockImplementation(async (_r, _s, variant) => ({
    journeys: variant.street
      ? [ride()]
      : variant.pre === "WALK"
        ? [access()]
        : [],
    issues: [],
  }));
  const updates = [];
  for await (const update of planRoutes(
    { ...request, timing: "now" },
    { ...settings, maxBikeTransfers: 0 },
    new AbortController().signal,
    client,
  ))
    updates.push(update);
  expect(updates[0].journeys[0].id).toBe("original");
  expect(updates[0].status).toBe("searching");
  expect(updates.at(-1)!.status).toBe("complete");
  expect(updates.at(-1)!.journeys).toHaveLength(1);
  expect(updates.at(-1)!.journeys[0].legs[0].kind).toBe("bike");
});
