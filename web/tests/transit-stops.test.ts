import { expect, it } from "vitest";
import {
  defaults,
  type Journey,
  type Leg,
  type TransitStop,
  validNavigationLegData,
} from "../src/model";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import { applyTransit, matchTrip } from "../src/transit-refresh";
import { parseTransitStops, transitStopKey } from "../src/transit-stops";
import { mapResponse } from "../src/transitous";
import { validNavigationSnapshot } from "../src/navigation-store";

const now = Date.parse("2026-10-06T10:00:00Z") / 1000;
const iso = (time: number) => new Date(time * 1000).toISOString();
const stops: TransitStop[] = Array.from({ length: 4 }, (_, i) => ({
  name: `Station ${i}`,
  stopId: `S${i}`,
  detail: "",
  latitude: 48,
  longitude: 11 + i * 0.01,
  scheduledArrival: now + i * 120,
  scheduledDeparture: now + i * 120 + 10,
}));
const rawStop = (i: number) => ({
  name: stops[i].name,
  stopId: stops[i].stopId,
  lat: stops[i].latitude,
  lon: stops[i].longitude,
  scheduledArrival: iso(stops[i].scheduledArrival!),
  scheduledDeparture: iso(stops[i].scheduledDeparture!),
  arrival: iso(stops[i].scheduledArrival! + 60),
  departure: iso(stops[i].scheduledDeparture! + 60),
});
const train = (): Leg => ({
  kind: "transit",
  from: stops[0],
  to: stops[3],
  start: now,
  end: now + 1000,
  distance: 0,
  coordinates: stops,
  transitStops: structuredClone(stops),
  line: "U8",
  transitStatus: { updatedAt: now },
});
const journey = (leg = train()): Journey =>
  navigationJourney({
    id: "train",
    origin: leg.from,
    destination: leg.to,
    departure: leg.start,
    arrival: leg.end,
    transfers: 0,
    isDirect: false,
    legs: [leg],
  });
const fix = (i: number, seconds: number, accuracy = 10) => ({
  ...stops[i],
  timestamp: (now + seconds) * 1000,
  accuracy,
});
const update = (
  engine: NavigationEngine,
  i: number,
  seconds: number,
  accuracy = 10,
) => engine.update(fix(i, seconds, accuracy), (now + seconds) * 1000);

it("maps ordered planning stops and distinguishes missing data from a nonstop journey", () => {
  const response = (intermediateStops?: unknown[]) => ({
    itineraries: [
      {
        id: "plan",
        transfers: 0,
        legs: [
          {
            mode: "SUBWAY",
            from: rawStop(0),
            to: rawStop(3),
            startTime: iso(now),
            endTime: iso(now + 1000),
            intermediateStops,
          },
        ],
      },
    ],
  });
  const request = {
    origin: stops[0],
    destination: stops[3],
    timing: "now" as const,
    time: now,
  };
  const mapped = (intermediate?: unknown[]) =>
    mapResponse(response(intermediate), request, defaults, {
      pre: "WALK",
      post: "WALK",
    }).journeys[0].legs.find((leg) => leg.kind === "transit")!;
  expect(
    mapped([rawStop(1), rawStop(2)]).transitStops?.map((stop) => stop.name),
  ).toEqual(stops.map((stop) => stop.name));
  expect(mapped([]).transitStops).toHaveLength(2);
  expect(mapped().transitStops).toBeUndefined();
  expect(
    mapped([{ ...rawStop(1), lat: "invalid" }]).transitStops,
  ).toBeUndefined();
  expect(
    parseTransitStops([rawStop(0), { ...rawStop(3), arrival: "invalid" }]),
  ).toBeUndefined();
});

it("clips live stops to the boarded segment and merges only trip-leg boundaries", () => {
  const reference = {
    tripId: "trip",
    fromId: "S1",
    toId: "S3",
    scheduledDeparture: stops[1].scheduledDeparture!,
    scheduledArrival: stops[3].scheduledArrival!,
  };
  const response = {
    legs: [
      {
        from: rawStop(0),
        intermediateStops: [rawStop(1)],
        to: rawStop(2),
        realTime: true,
      },
      {
        from: rawStop(2),
        intermediateStops: [],
        to: rawStop(3),
        realTime: true,
      },
    ],
  };
  const result = matchTrip(response, reference, now);
  expect(result).toMatchObject({
    kind: "updated",
    update: { stops: [{ stopId: "S1" }, { stopId: "S2" }, { stopId: "S3" }] },
  });
  const original = journey();
  const refreshed = applyTransit(
    original,
    0,
    new Map([[original.legs[0].navigationId!, result]]),
  );
  expect(refreshed.legs[0].transitStops).toHaveLength(3);
  expect(original.legs[0].transitStops).toHaveLength(4);
});

it("requires two matching fixes, ignores single jumps and freezes without reliable GPS", () => {
  const engine = new NavigationEngine(journey());
  update(engine, 1, 0);
  expect(engine.transitStopIndex).toBe(0);
  update(engine, 1, 1);
  expect(engine.transitStopIndex).toBe(1);
  expect(engine.transitPositionConfirmed).toBe(true);
  update(engine, 3, 2);
  update(engine, 1, 3);
  expect(engine.transitStopIndex).toBe(1);
  update(engine, 2, 4, 101);
  expect(engine.transitPositionConfirmed).toBe(false);
  engine.tick(now + 30);
  expect(engine.transitStopIndex).toBe(1);
  update(engine, 2, 70);
  expect(engine.transitStopIndex).toBe(1);
  update(engine, 2, 71);
  expect(engine.transitStopIndex).toBe(2);
  update(engine, 1, 72);
  update(engine, 1, 73);
  expect(engine.transitStopIndex).toBe(2);
});

it("rejects stale and duplicate fixes, off-route samples and implausible forward jumps", () => {
  const engine = new NavigationEngine(journey());
  engine.update(fix(1, 0), (now + 61) * 1000);
  expect(engine.transitPositionConfirmed).toBe(false);
  update(engine, 1, 62);
  update(engine, 1, 62);
  expect(engine.transitStopIndex).toBe(0);
  engine.update({ ...fix(2, 63), latitude: 49 }, (now + 63) * 1000);
  update(engine, 2, 64);
  expect(engine.transitStopIndex).toBe(0);
  update(engine, 2, 65);
  expect(engine.transitStopIndex).toBe(2);
  update(engine, 3, 66);
  expect(engine.transitStopIndex).toBe(2);
});

it("keeps loop occurrences separate and does not mistake the boarding point for the exit", () => {
  const leg = train();
  leg.to = { ...stops[0] };
  leg.transitStops![3] = {
    ...stops[0],
    scheduledArrival: now + 360,
    scheduledDeparture: undefined,
  };
  leg.coordinates = leg.transitStops!;
  const engine = new NavigationEngine(journey(leg));
  update(engine, 0, 0);
  update(engine, 0, 1);
  expect(engine.transitStopIndex).toBe(0);
  expect(transitStopKey(leg.transitStops!, 0)).not.toBe(
    transitStopKey(leg.transitStops!, 3),
  );
  const repeated = [stops[0], stops[1], stops[0]];
  expect(transitStopKey(repeated, 0)).not.toBe(transitStopKey(repeated, 2));
});

it("confirms station proximity when the transit shape is unusable", () => {
  const leg = train();
  leg.coordinates = [];
  leg.transitStops![1].latitude += 0.01;
  const engine = new NavigationEngine(journey(leg));
  const station = leg.transitStops![1];
  engine.update(
    { ...station, accuracy: 10, timestamp: now * 1000 },
    now * 1000,
  );
  engine.update(
    { ...station, accuracy: 10, timestamp: (now + 1) * 1000 },
    (now + 1) * 1000,
  );
  expect(engine.transitStopIndex).toBe(1);
});

it("persists station occurrence without GPS and restores it as unconfirmed", () => {
  const original = journey();
  const engine = new NavigationEngine(original);
  update(engine, 1, 0);
  update(engine, 1, 1);
  const snapshot = {
    version: 1,
    savedAt: now,
    journey: original,
    settings: defaults,
    progress: engine.progress,
    request: {
      origin: original.origin,
      destination: original.destination,
      timing: "now",
      time: now,
    },
  };
  expect(validNavigationSnapshot(snapshot)).toBe(true);
  const restored = new NavigationEngine(original, engine.progress);
  expect(restored.transitStopIndex).toBe(1);
  expect(restored.transitPositionConfirmed).toBe(false);
  const changed = structuredClone(original);
  changed.legs[0].transitStops![1].arrival = now + 180;
  restored.applyJourney(changed);
  expect(restored.transitStopIndex).toBe(1);
  const legacy = structuredClone(snapshot);
  delete legacy.journey.legs[0].transitStops;
  delete legacy.progress.transitStop;
  expect(validNavigationSnapshot(legacy)).toBe(true);
  expect(validNavigationLegData({ ...train(), transitStops: [stops[0]] })).toBe(
    false,
  );
  expect(
    validNavigationSnapshot({
      ...snapshot,
      progress: { ...snapshot.progress, transitStop: 4 },
    }),
  ).toBe(false);
});

it("never advances a leg solely because GPS confirms its exit", () => {
  const engine = new NavigationEngine(journey());
  update(engine, 3, 0);
  update(engine, 3, 1);
  expect(engine.transitStopIndex).toBe(3);
  expect(engine.phase).toBe("active");
  const updated = structuredClone(engine.journey);
  updated.legs[0].transitStops![3].scheduledDeparture = now + 2000;
  engine.applyJourney(updated);
  expect(engine.transitStopIndex).toBe(3);
});

it("recognizes a platform just before the exit anchor without skipping a nearby station", () => {
  const engine = new NavigationEngine(journey());
  for (let seconds = 0; seconds < 2; seconds++) {
    const position = {
      ...fix(3, seconds),
      longitude: stops[3].longitude - 0.0002,
    };
    engine.update(position, position.timestamp);
  }
  expect(engine.transitStopIndex).toBe(3);
  expect(engine.phase).toBe("active");
  const leg = train();
  leg.transitStops![2].longitude = stops[1].longitude + 0.0008;
  leg.coordinates = leg.transitStops!;
  const nearby = new NavigationEngine(journey(leg));
  update(nearby, 1, 0);
  update(nearby, 1, 1);
  expect(nearby.transitStopIndex).toBe(1);
});
