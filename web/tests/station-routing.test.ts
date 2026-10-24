import { applyTransit, transitDisruption } from "../src/transit-refresh";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/swift-parity.json";
import {
  defaults,
  journeyEnd,
  journeyStart,
  journeyStops,
  transition,
  type Journey,
  type Leg,
  type Place,
  type RouteRequest,
  type RouteStop,
} from "../src/model";
import {
  ApiClient,
  baseVariants,
  makeURL,
  mapResponse,
  type Batch,
  type RoutingClient,
} from "../src/transitous";
import { PlanningRoutingClient } from "../src/planning-routing";
import { planRoutes } from "../src/planner";
import { routeURL, readRouteURL } from "../src/route-url";
import { samePlace, updatedPlaces } from "../src/places";
import { sameHistoryRoute, validSnapshot } from "../src/offline";
import { joinAtStation } from "../src/station-join";
import { walkingBlocks } from "../src/walking-optimization";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";

const signal = () => new AbortController().signal;
const settings = { ...defaults, foldingDuration: 60, maxBikeTransfers: 0 };
const a: Place = {
  name: "Start",
  detail: "",
  latitude: 48.13,
  longitude: 11.57,
  stopId: "a",
  level: 0,
};
const b: Place = {
  ...a,
  name: "Bahnhof",
  longitude: 11.58,
  stopId: "b:1",
  parentId: "b",
  level: -1,
};
const b2: Place = { ...b, longitude: 11.582, stopId: "b:2" };
const c: Place = { ...a, name: "Ziel", longitude: 11.6, stopId: "c" };
const station: Place = {
  ...b,
  kind: "station",
  stopId: "source:platform",
  stationId: "b",
  longitude: 11.59,
};
const stop: RouteStop = { id: "via", place: station, stayMinutes: 0 };
const train = (
  from: Place,
  to: Place,
  start: number,
  end: number,
  tripId: string,
): Leg => ({
  kind: "transit",
  from,
  to,
  start,
  end,
  scheduledStart: start,
  scheduledEnd: end,
  tripId,
  coordinates: [from, to],
  distance: 0,
});
const t1 = train(a, b, 1000, 1100, "one"),
  t2 = train(b2, c, 1300, 1400, "two");
const trip = (
  legs: Leg[],
  origin = legs[0].from,
  destination = legs.at(-1)!.to,
): Journey => ({
  id: legs.map((l) => `${l.kind}:${l.start}`).join("|"),
  origin,
  destination,
  legs,
  departure: legs[0].start,
  arrival: legs.at(-1)!.end,
  transfers: Math.max(0, legs.filter((l) => l.kind === "transit").length - 1),
  isDirect: legs.every((l) => l.kind !== "transit"),
});
const batch = (journeys: Journey[] = []): Batch => ({
  journeys,
  stop: false,
  issues: [],
  rejected: false,
});
const request: RouteRequest = {
  origin: station,
  destination: {
    ...station,
    stopId: "c:platform",
    stationId: "c",
    longitude: c.longitude,
  },
  timing: "arrive",
  time: 1500,
};

it("resolves parent IDs through the real planning wrapper, caching one lookup per run", async () => {
  const urls: URL[] = [];
  const api = new ApiClient(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/stop"))
      return new Response(
        JSON.stringify({
          place: { stopId: "source:platform", parentId: "parent_G" },
        }),
      );
    const raw = structuredClone(fixture.multimodal.itineraries[0]);
    raw.legs = [raw.legs[1]];
    return new Response(JSON.stringify({ itineraries: [raw], direct: [] }));
  });
  const client = new PlanningRoutingClient(api);
  const run = api.createRun(signal()),
    budget = { run, take: vi.fn() };
  const unresolved = { ...station, stationId: undefined };
  const [first, second] = await Promise.all([
    client.resolveStation(unresolved, signal(), budget),
    client.resolveStation(unresolved, signal(), budget),
  ]);
  expect(first.stationId).toBe("parent_G");
  expect(second).toEqual(first);
  expect(urls).toHaveLength(1);
  const updates = [];
  for await (const update of planRoutes(
    { ...request, origin: unresolved },
    settings,
    signal(),
    client,
    { baseOnly: true, budget },
  ))
    updates.push(update);
  const plans = urls.filter(
    (url) =>
      url.pathname.endsWith("/plan") && !url.searchParams.get("directModes"),
  );
  expect(plans).toHaveLength(1);
  expect(plans[0].searchParams.get("fromPlace")).toBe("parent_G");
  expect(updates.at(-1)?.journeys[0].origin.stationId).toBe("parent_G");
  expect(urls.filter((url) => url.pathname.endsWith("/stop"))).toHaveLength(1);
  run.dispose();
});

it("keeps a root without parentId and propagates metadata errors without coordinate fallback", async () => {
  const root = { ...station, stationId: undefined };
  const api = new ApiClient(
    async () =>
      new Response(JSON.stringify({ place: { stopId: root.stopId } })),
  );
  expect((await api.resolveStation(root, signal())).stationId).toBe(
    root.stopId,
  );
  const broken = new ApiClient(
    async () => new Response("unavailable", { status: 500 }),
  );
  await expect(broken.resolveStation(root, signal())).rejects.toMatchObject({
    code: "service",
  });
});

it("binds station endpoints and keeps points/direct cycling and exact internal IDs distinct", () => {
  const url = makeURL(request, settings, baseVariants[2]);
  expect(url.searchParams.get("fromPlace")).toBe("b");
  expect(url.searchParams.get("toPlace")).toBe("c");
  expect(url.searchParams.get("preTransitModes")).toBe("");
  expect(url.searchParams.get("postTransitModes")).toBe("");
  expect(url.searchParams.get("maxPostTransitTime")).toBe("0");
  expect(Date.parse(url.searchParams.get("time")!) / 1000).toBe(request.time);
  expect(
    makeURL(request, settings, baseVariants[0]).searchParams.get("toPlace"),
  ).toContain(",");
  expect(
    makeURL({ ...request, origin: b }, settings, {
      ...baseVariants[0],
      street: true,
    }).searchParams.get("fromPlace"),
  ).toBe(b.stopId);
  expect(
    makeURL(
      { ...request, destination: { ...c, kind: "point" } },
      settings,
      baseVariants[2],
    ).searchParams.get("toPlace"),
  ).toContain(",");
});

it("ends a station journey at its actual platform without unfolding", () => {
  const raw = structuredClone(fixture.multimodal.itineraries[0]);
  raw.legs = [raw.legs[1]];
  const result = mapResponse(
    { itineraries: [raw] },
    request,
    settings,
    baseVariants[2],
  ).journeys[0];
  expect(result.legs.map((l) => l.kind)).toEqual(["fold", "transit"]);
  expect(result.arrival).toBe(Date.parse(raw.legs[0].endTime) / 1000);
  expect(journeyStart(result)).toEqual(result.legs[0].from);
  expect(journeyEnd(result)).toEqual(result.legs.at(-1)!.to);
  expect(journeyEnd(result)).not.toEqual(request.destination);
  expect(
    mapResponse(
      { itineraries: [raw] },
      { ...request, bikeFolded: true },
      settings,
      baseVariants[2],
    ).journeys[0].legs.map((l) => l.kind),
  ).toEqual(["transit"]);
  expect(
    mapResponse(fixture.multimodal, request, settings, baseVariants[2])
      .journeys,
  ).toEqual([]);
});

it("round-trips station semantics for all endpoint roles without coalescing a nearby point", () => {
  const input = { ...request, stops: [stop] };
  const url = routeURL("https://example.org/", { request: input });
  const read = readRouteURL(url);
  expect(read.kind).toBe("plan");
  if (read.kind !== "plan") throw Error("invalid fixture");
  expect(read.plan.request.origin).toMatchObject({
    kind: "station",
    stopId: station.stopId,
    stationId: "b",
  });
  expect(read.plan.request.stops?.[0].place.stationId).toBe("b");
  expect(read.plan.request.destination.stationId).toBe("c");
  const pin = {
    ...station,
    kind: "point" as const,
    stopId: undefined,
    stationId: undefined,
  };
  expect(samePlace(station, pin)).toBe(false);
  expect(sameHistoryRoute(request, { ...request, origin: pin })).toBe(false);
  expect(
    updatedPlaces(updatedPlaces([], station, "favorite", 1), pin, "use", 2),
  ).toHaveLength(2);
  const legacy = new URL(
    "https://example.org/?v=3&from=48.13,11.57&to=48.14,11.58&timing=now",
  );
  expect(readRouteURL(legacy)).toMatchObject({
    kind: "plan",
    plan: { request: { origin: { latitude: 48.13 } } },
  });
  legacy.searchParams.set("fromStationId", "b");
  expect(readRouteURL(legacy).kind).toBe("invalid");
});

describe("station handoffs", () => {
  const walk: Leg = {
    kind: "walk",
    from: b,
    to: b2,
    start: 1100,
    end: 1140,
    distance: 150,
    coordinates: [b, b2],
  };
  const first = trip([transition("fold", a, 940, 1000), t1], a, station);
  const last = trip([t2], station, c);
  it("uses the native transfer including walking, dwell and transfer count", async () => {
    const client: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async () => batch([trip([t1, walk, t2])])),
    };
    const result = await joinAtStation(
      first,
      last,
      { ...stop, stayMinutes: 1 },
      settings,
      client,
      signal(),
      { take() {} },
    );
    expect(result?.legs.map((l) => l.kind)).toEqual([
      "fold",
      "transit",
      "walk",
      "stop",
      "transit",
    ]);
    expect(result?.transfers).toBe(1);
    expect(walkingBlocks([result!])).toEqual([]);
    expect(client.batch).toHaveBeenCalledWith(
      expect.anything(),
      settings,
      expect.objectContaining({
        native: true,
        via: { id: "b", stayMinutes: 1 },
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(
      validSnapshot({
        version: 4,
        savedAt: 1,
        settings,
        request: {
          ...request,
          origin: a,
          destination: c,
          stops: [{ ...stop, stayMinutes: 1 }],
        },
        journey: result,
      }),
    ).toBe(true);
  });
  it.each([
    "missing",
    "different-trip",
    "different-platform",
    "different-time",
  ])("rejects an unproven transfer: %s", async (variant) => {
    const other = {
      ...t2,
      ...(variant === "different-trip"
        ? { tripId: "other" }
        : variant === "different-platform"
          ? { from: b }
          : { start: 1200 }),
    };
    const client: RoutingClient = {
      retryAt: 0,
      batch: async () =>
        batch(variant === "missing" ? [] : [trip([t1, walk, other])]),
    };
    expect(
      await joinAtStation(first, last, stop, settings, client, signal(), {
        take() {},
      }),
    ).toBeUndefined();
  });
  it("merges a verified through train without a navigation exit at the intermediate station", async () => {
    const onward = train(b, c, 1120, 1400, t1.tripId!);
    const through = {
      ...train(a, c, 1000, 1400, t1.tripId!),
      transitStops: [a, { ...b, arrival: 1100, departure: 1120 }, c],
    };
    const client: RoutingClient = {
      retryAt: 0,
      batch: async () => batch([trip([through])]),
    };
    const result = await joinAtStation(
      first,
      trip([onward], station, c),
      stop,
      settings,
      client,
      signal(),
      { take() {} },
    );
    expect(result?.legs.map((l) => l.kind)).toEqual(["fold", "transit"]);
    expect(result?.transfers).toBe(0);
    expect(journeyStops(result!)).toEqual([stop]);
    expect(
      validSnapshot({
        version: 4,
        savedAt: 1,
        settings,
        request: { ...request, origin: a, destination: c, stops: [stop] },
        journey: result,
      }),
    ).toBe(true);
    const engine = new NavigationEngine(navigationJourney(result!));
    engine.advance(true, 1000);
    expect(engine.leg.to).toEqual(c);
    engine.advance(true, 1400);
    expect(engine.progress.confirmedStops).toContain(stop.id);
  });
  it("requests a real walking connector for different levels at the same coordinates", async () => {
    const surface = { ...b, stopId: undefined, level: 0 };
    const ride: Leg = {
      kind: "bike",
      from: surface,
      to: c,
      start: 1300,
      end: 1400,
      distance: 500,
      coordinates: [surface, c],
    };
    const client: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async () => batch()),
    };
    expect(
      await joinAtStation(
        first,
        trip([ride], station, c),
        stop,
        settings,
        client,
        signal(),
        { take() {} },
      ),
    ).toBeUndefined();
    expect(client.batch).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: expect.objectContaining({ level: -1 }),
        destination: expect.objectContaining({ level: 0 }),
      }),
      settings,
      expect.objectContaining({ directMode: "WALK" }),
      expect.anything(),
      expect.anything(),
    );
  });
});

it.each(["depart", "arrive"] as const)(
  "plans train → station → cycling with the unfold time in a full %s search",
  async (timing) => {
    const start: Place = { ...a, kind: "station", stationId: "a" };
    const via: Place = { ...b, kind: "station", stationId: "b" };
    const input: RouteRequest = {
      origin: start,
      destination: c,
      stops: [{ ...stop, place: via }],
      timing,
      time: timing === "depart" ? 900 : 1400,
    };
    const api: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async (r, _s, variant) => {
        if (variant.directMode === "WALK") return batch();
        if (r.origin.stopId === "a" && !variant.direct) {
          const end = r.timing === "arrive" ? r.time : 1100;
          return batch([
            trip(
              [
                transition("fold", a, end - 160, end - 100),
                train(a, b, end - 100, end, "inbound"),
              ],
              r.origin,
              r.destination,
            ),
          ]);
        }
        if (r.origin.stopId === b.stopId && variant.direct) {
          const start = r.timing === "arrive" ? r.time - 200 : r.time;
          return batch([
            trip(
              [
                {
                  kind: "bike",
                  from: b,
                  to: c,
                  start,
                  end: start + 200,
                  distance: 1000,
                  coordinates: [b, c],
                },
              ],
              r.origin,
              r.destination,
            ),
          ]);
        }
        return batch();
      }),
    };
    const updates = [];
    for await (const update of planRoutes(input, settings, signal(), api))
      updates.push(update);
    const result = updates.at(-1)?.journeys[0];
    expect(result).toBeDefined();
    expect(result!.legs.map((l) => l.kind)).toEqual([
      "fold",
      "transit",
      "stop",
      "unfold",
      "bike",
    ]);
    const unfold = result!.legs.find((l) => l.kind === "unfold")!;
    expect(unfold.end - unfold.start).toBe(settings.foldingDuration);
    expect(result!.legs.at(-1)!.start).toBe(unfold.end);
    if (timing === "arrive")
      expect(result!.arrival).toBeLessThanOrEqual(input.time);
    else expect(result!.departure).toBeGreaterThanOrEqual(input.time);
  },
);

it("preserves folded state at station stops, including walks outside the protected native connector", () => {
  const walk: Leg = {
    kind: "walk",
    from: b,
    to: b2,
    start: 1100,
    end: 1200,
    distance: 150,
    coordinates: [b, b2],
  };
  const visit: Leg = {
    ...transition("wait", b, 1100, 1100),
    kind: "stop",
    stop,
  };
  expect(walkingBlocks([trip([t1, visit, walk])])[0].folded).toBe(true);
});

it.each(["depart", "arrive"] as const)(
  "preserves three mixed intermediate stops in a full %s search",
  async (timing) => {
    const nodes: Place[] = [0, 1, 2, 3, 4].map((i) => ({
      name: `Place ${i}`,
      detail: "",
      latitude: 48.13,
      longitude: 11.5 + i / 100,
      ...(i === 1 || i === 3
        ? {
            kind: "station" as const,
            stopId: `station-${i}`,
            stationId: `station-${i}`,
          }
        : { kind: "point" as const }),
    }));
    const stops = nodes
      .slice(1, 4)
      .map((place, index) => ({
        id: `mixed-${index}`,
        place,
        stayMinutes: index === 0 ? 1 : 0,
      }));
    const input: RouteRequest = {
      origin: nodes[0],
      destination: nodes[4],
      stops,
      timing,
      time: timing === "depart" ? 1000 : 10000,
    };
    const trains: Leg[] = [];
    const concrete = (place: Place): Place => ({
      name: place.name,
      detail: "",
      latitude: place.latitude,
      longitude: place.longitude,
      stopId: `${place.name}:platform`,
      parentId: place.stationId,
      level: 0,
    });
    const api: RoutingClient = {
      retryAt: 0,
      batch: async (r, _s, variant) => {
        if (variant.direct) return batch();
        if (variant.native) {
          const left = trains.filter(
            (leg) =>
              leg.from.stopId === r.origin.stopId && leg.start === r.time,
          );
          const right = trains.filter(
            (leg) => leg.to.stopId === r.destination.stopId,
          );
          return batch(
            left.flatMap((incoming) =>
              right
                .filter(
                  (outgoing) =>
                    outgoing.from.stopId === incoming.to.stopId &&
                    outgoing.start >=
                      incoming.end + variant.via!.stayMinutes * 60,
                )
                .map((outgoing) => trip([incoming, outgoing])),
            ),
          );
        }
        const fold = r.bikeFolded ? 0 : settings.foldingDuration;
        const unfold =
          r.destination.kind === "station" ? 0 : settings.foldingDuration;
        const start =
          r.timing === "arrive" ? r.time - unfold - 100 : r.time + fold + 180;
        const leg = train(
          concrete(r.origin),
          concrete(r.destination),
          start,
          start + 100,
          `${r.origin.name}-${r.destination.name}`,
        );
        trains.push(leg);
        return batch([
          trip(
            [
              ...(fold
                ? [transition("fold", leg.from, start - fold, start)]
                : []),
              leg,
              ...(unfold
                ? [transition("unfold", leg.to, leg.end, leg.end + unfold)]
                : []),
            ],
            r.origin,
            r.destination,
          ),
        ]);
      },
    };
    const updates = [];
    for await (const update of planRoutes(
      input,
      settings,
      signal(),
      new PlanningRoutingClient(api),
    ))
      updates.push(update);
    const result = updates.at(-1)?.journeys[0];
    expect(result).toBeDefined();
    expect(journeyStops(result!)).toEqual(stops);
    expect(result!.legs.filter((leg) => leg.kind === "fold")).toHaveLength(2);
    expect(result!.legs.filter((leg) => leg.kind === "unfold")).toHaveLength(2);
    expect(
      result!.legs.every(
        (leg, index, all) => !index || all[index - 1].end <= leg.start,
      ),
    ).toBe(true);
    if (timing === "arrive")
      expect(result!.arrival).toBeLessThanOrEqual(input.time);
    else expect(result!.departure).toBeGreaterThanOrEqual(input.time);
  },
);

it.each(["removed", "cancelled", "delayed", "other-occurrence"] as const)(
  "checks a required through visit after realtime refresh: %s",
  (change) => {
    const visit = {
      ...b,
      arrival: 1100,
      departure: 1120,
      scheduledArrival: 1100,
      scheduledDeparture: 1120,
    };
    const through: Leg = {
      ...train(a, c, 1000, 1400, "through"),
      navigationId: "through",
      transitStops: [a, visit, c],
      viaStops: [{ stop, place: visit }],
    };
    const stops =
      change === "removed"
        ? [a, c]
        : [
            a,
            {
              ...visit,
              cancelled: change === "cancelled",
              arrival: 1160,
              departure: 1180,
              ...(change === "other-occurrence"
                ? { scheduledArrival: 900, scheduledDeparture: 920 }
                : {}),
            },
            c,
          ];
    const refreshed = applyTransit(
      trip([through]),
      0,
      new Map([
        [
          "through",
          {
            kind: "updated",
            update: {
              departure: 1000,
              arrival: 1460,
              updatedAt: 1300,
              cancelled: false,
              realtime: true,
              stops,
            },
          },
        ],
      ]),
    );
    const missing = change !== "delayed";
    expect(refreshed.legs[0].transitStatus?.missingViaStops).toEqual(
      missing ? [stop.id] : [],
    );
    expect(!!transitDisruption(refreshed, 0, 1300)).toBe(missing);
    const engine = new NavigationEngine(refreshed);
    engine.advance(true, 1460);
    expect(engine.progress.confirmedStops.includes(stop.id)).toBe(!missing);
    expect(engine.phase).toBe(missing ? "active" : "arrived");
    expect(journeyStops(engine.journey)).toEqual([stop]);
  },
);
