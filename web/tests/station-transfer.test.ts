import { expect, it, vi } from "vitest";
import fixture from "./fixtures/swift-parity.json";
import {
  defaults,
  sameStation,
  stationTransferWalks,
  transition,
  type Journey,
  type Leg,
  type Place,
  type RouteRequest,
} from "../src/model";
import { compose, planRoutes, type Seed } from "../src/planner";
import { cyclingReplacement, walkingBlocks } from "../src/walking-optimization";
import {
  baseVariants,
  mapResponse,
  type Batch,
  type RoutingClient,
} from "../src/transitous";

const platform7: Place = {
  name: "Frankfurt (Main) Südbahnhof",
  detail: "Gleis 7",
  latitude: 50.099,
  longitude: 8.686,
  stopId: "sued:7",
  parentId: "sued",
  level: 1,
};
const platformS6: Place = {
  ...platform7,
  detail: "S6",
  latitude: 50.0992,
  stopId: "sued:s6",
  level: -1,
};
const origin: Place = {
  ...platform7,
  name: "Mannheim Hbf",
  latitude: 49.5,
  stopId: "mannheim",
  parentId: undefined,
};
const destination: Place = {
  ...origin,
  name: "Darmstadt Hbf",
  latitude: 49.87,
  stopId: "darmstadt",
};
const settings = {
  ...defaults,
  foldingDuration: 180,
  transferMinutes: 3,
  maxBikeTransfers: 2,
};
const leg = (
  kind: Leg["kind"],
  from: Place,
  to: Place,
  start: number,
  end: number,
  tripId?: string,
): Leg => ({
  kind,
  from,
  to,
  start,
  end,
  tripId,
  coordinates: [from, to],
  distance: kind === "transit" ? 0 : 100,
});
const incoming = leg("transit", origin, platform7, 0, 1000, "incoming");
const outgoing = leg(
  "transit",
  platformS6,
  destination,
  1600,
  2000,
  "outgoing",
);
const journey = (id: string, legs: Leg[], isDirect = false): Journey => ({
  id,
  origin: legs[0].from,
  destination: legs.at(-1)!.to,
  legs,
  departure: legs[0].start,
  arrival: legs.at(-1)!.end,
  transfers: 1,
  isDirect,
});
const original = journey("foot-transfer", [
  incoming,
  leg("walk", platform7, platformS6, 1000, 1400),
  outgoing,
]);
const ride = journey(
  "one-minute-ride",
  [leg("bike", platform7, platformS6, 1180, 1240)],
  true,
);
const request: RouteRequest = {
  origin,
  destination,
  timing: "depart",
  time: 0,
};
const part = (backwards: boolean) =>
  journey(
    "bike-candidate",
    backwards
      ? [incoming, transition("unfold", platform7, 1000, 1180), ...ride.legs]
      : [
          leg("bike", platform7, platformS6, 1360, 1420),
          transition("fold", platformS6, 1420, 1600),
          outgoing,
        ],
  );
const seed = (backwards: boolean): Seed => ({
  journey: original,
  index: backwards ? 2 : 0,
  backwards,
  outer: "WALK",
  request,
  key: "test",
});
const batch = (journeys: Journey[]): Batch => ({
  journeys,
  stop: false,
  rejected: false,
  issues: [],
});

it.each([
  [platform7, platformS6, true],
  [
    { ...platform7, parentId: undefined },
    { ...platform7, parentId: undefined, level: -2 },
    true,
  ],
  [{ ...origin, stopId: "sued" }, platformS6, true],
  [platform7, { ...platformS6, parentId: "other-station" }, false],
  [
    { ...platform7, parentId: undefined },
    { ...platformS6, parentId: undefined },
    false,
  ],
  [
    { ...platform7, stopId: undefined, parentId: undefined },
    { ...platform7, stopId: undefined, parentId: undefined },
    false,
  ],
])("compares only declared station identity (%j, %j)", (a, b, expected) => {
  expect(sameStation(a, b)).toBe(expected);
  expect(sameStation(b, a)).toBe(expected);
});

it("keeps a normal platform walk and rejects a forged cycling replacement without the persisted flag", () => {
  const before = structuredClone(original);
  expect(stationTransferWalks(original.legs)).toEqual(new Set([1]));
  expect(walkingBlocks([original])).toEqual([]);
  expect(
    cyclingReplacement(
      { journey: original, first: 1, last: 1, folded: true, seconds: 400 },
      ride,
      settings,
    ),
  ).toBeUndefined();
  expect(original).toEqual(before);
});

it("protects every part of a multi-leg platform walk, retaining waiting and level changes", () => {
  const middle: Place = {
    ...platform7,
    stopId: undefined,
    parentId: undefined,
    detail: "Unterführung",
    level: 0,
  };
  const path = journey("stairs", [
    incoming,
    leg("walk", platform7, middle, 1000, 1100),
    transition("wait", middle, 1100, 1150),
    leg("walk", middle, platformS6, 1150, 1400),
    outgoing,
  ]);
  expect(stationTransferWalks(path.legs)).toEqual(new Set([1, 3]));
  expect(walkingBlocks([path])).toEqual([]);
});

it("does not infer a platform transfer across an explicitly selected point", () => {
  const point = {
    ...platform7,
    kind: "point" as const,
    stopId: undefined,
    parentId: undefined,
  };
  const stop: Leg = {
    ...transition("wait", point, 1000, 1000),
    kind: "stop",
    stop: { id: "pickup", place: point, stayMinutes: 0 },
  };
  expect(
    stationTransferWalks([incoming, stop, ...original.legs.slice(1)]),
  ).toEqual(new Set());
});

it.each([false, true])(
  "rejects same-station bike composition before result selection (backwards=%s)",
  (backwards) => {
    const input: RouteRequest = {
      ...request,
      timing: backwards ? "arrive" : "depart",
      time: backwards ? 2000 : 0,
    };
    expect(
      compose(seed(backwards), part(backwards), input, settings),
    ).toBeUndefined();
    const other = { ...platformS6, parentId: "other-station" };
    const otherOutgoing = { ...outgoing, from: other };
    const base = journey("other-base", [
      incoming,
      leg("walk", platform7, other, 1000, 1400),
      otherOutgoing,
    ]);
    const candidate = journey(
      "other-candidate",
      part(backwards).legs.map((leg) => ({
        ...leg,
        from: leg.from.stopId === platformS6.stopId ? other : leg.from,
        to: leg.to.stopId === platformS6.stopId ? other : leg.to,
        coordinates: leg.coordinates,
      })),
    );
    expect(
      compose(
        { ...seed(backwards), journey: base },
        candidate,
        input,
        settings,
      ),
    ).toBeDefined();
  },
);

it("still allows cycling between different stations with identical names", () => {
  const other = { ...platformS6, parentId: "other-station" };
  const between = journey("other-station", [
    incoming,
    leg("walk", platform7, other, 1000, 1400),
    { ...outgoing, from: other },
  ]);
  expect(walkingBlocks([between])).toHaveLength(1);
  expect(
    cyclingReplacement(
      walkingBlocks([between])[0],
      journey("ride", [leg("bike", platform7, other, 1180, 1240)], true),
      settings,
    ),
  ).toBeDefined();
});

it("marks native API platform walks without rewriting their times or geometry", () => {
  const template = structuredClone(fixture.multimodal.itineraries[0]);
  const walk = {
    ...template.legs[0],
    mode: "WALK",
    from: {
      ...template.legs[0].from,
      name: platform7.name,
      stopId: platform7.stopId,
      parentId: "sued",
      level: 1,
    },
    to: {
      ...template.legs[0].to,
      name: platform7.name,
      stopId: platformS6.stopId,
      parentId: "sued",
      level: -1,
    },
  };
  const arrival = {
    ...template.legs[1],
    from: { ...template.legs[1].from, name: "Mannheim", lat: 49.5 },
    to: walk.from,
    startTime: "2026-09-04T08:00:00Z",
    endTime: walk.startTime,
  };
  const departure = { ...template.legs[1], from: walk.to };
  const mapped = mapResponse(
    { itineraries: [{ ...template, legs: [arrival, walk, departure] }] },
    request,
    settings,
    baseVariants[1],
  ).journeys[0];
  const protectedWalk = mapped.legs.find((leg) => leg.kind === "walk")!;
  expect(protectedWalk.stationTransfer).toBe(true);
  expect(protectedWalk.start).toBe(Date.parse(walk.startTime) / 1000);
  expect(protectedWalk.end).toBe(Date.parse(walk.endTime) / 1000);
  expect(protectedWalk.coordinates.length).toBeGreaterThan(1);
  expect(walkingBlocks([mapped])).toEqual([]);
});

it.each(["depart", "arrive"] as const)(
  "retains the original foot connection after all optimization phases (%s)",
  async (timing) => {
    const backwards = timing === "arrive";
    const input = { ...request, timing, time: backwards ? 2000 : 0 };
    const client: RoutingClient = {
      retryAt: 0,
      batch: vi.fn(async (r, _settings, variant) => {
        if (variant.direct) return batch([]);
        if (
          r.origin.stopId === platform7.stopId ||
          r.destination.stopId === platformS6.stopId
        )
          return batch([part(backwards)]);
        return batch([original]);
      }),
    };
    const updates = [];
    for await (const update of planRoutes(
      input,
      settings,
      new AbortController().signal,
      client,
    ))
      updates.push(update);
    expect(updates.at(-1)?.status).toBe("complete");
    expect(updates.at(-1)?.journeys).toHaveLength(1);
    expect(updates.at(-1)?.journeys[0].legs).toEqual(original.legs);
    expect(client.batch).toHaveBeenCalledWith(
      expect.objectContaining(
        backwards ? { destination: platformS6 } : { origin: platform7 },
      ),
      settings,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  },
);
