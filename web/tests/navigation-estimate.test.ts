import { describe, expect, it } from "vitest";
import {
  MarkerMotion,
  NavigationPath,
  TransitPath,
  TransitTimeline,
} from "../src/navigation-estimate";
import {
  NavigationEngine,
  navigationJourney,
  projectTransitPath,
  projectPath,
} from "../src/navigation-engine";
import {
  defaults,
  type Journey,
  type Leg,
  type TransitStop,
} from "../src/model";
import { mapResponse } from "../src/transitous";
import munichS8 from "./fixtures/munich-s8.json";

const start = 1000;
const station = (
  name: string,
  latitude: number,
  longitude: number,
): TransitStop => ({ name, detail: "", stopId: name, latitude, longitude });
const a = station("A", 0, 0),
  b = station("B", 0.01, 0.01),
  c = station("C", 0.01, 0.02);
function train(): Leg {
  return {
    kind: "transit",
    from: a,
    to: c,
    start,
    end: start + 400,
    distance: 0,
    coordinates: [a, { latitude: 0, longitude: 0.01 }, b, c],
    transitStops: [
      { ...a, departure: start },
      { ...b, arrival: start + 200, departure: start + 240 },
      { ...c, scheduledArrival: start + 400 },
    ],
  };
}

function munichTrain(): Leg {
  const origin = {
    name: "Ostbahnhof",
    detail: "",
    latitude: munichS8.from.lat,
    longitude: munichS8.from.lon,
  };
  const destination = {
    name: "Pasing",
    detail: "",
    latitude: munichS8.to.lat,
    longitude: munichS8.to.lon,
  };
  return mapResponse(
    { itineraries: [{ id: "munich-s8", transfers: 0, legs: [munichS8] }] },
    {
      origin,
      destination,
      timing: "depart",
      time: Date.parse(munichS8.startTime) / 1000,
    },
    defaults,
    { pre: "WALK", post: "WALK" },
  ).journeys[0].legs.find((leg) => leg.kind === "transit")!;
}

describe("time-based transit presentation", () => {
  it("estimates the real Munich S8 despite station entrances away from the track", () => {
    const leg = munichTrain();
    const station = leg.transitStops![6];
    expect(projectPath(station, leg.coordinates).distance).toBeGreaterThan(180);
    const timeline = TransitTimeline.create(leg);
    expect(timeline).toBeDefined();
    expect(
      timeline!.sample(leg.transitStops![2].departure! + 1).stopIndex,
    ).toBe(2);
    // Station metadata tolerance must not accept an off-route GPS measurement.
    expect(
      projectTransitPath(
        { ...station, accuracy: 10, timestamp: leg.start * 1000 },
        leg.coordinates,
        0,
      ),
    ).toBeUndefined();
    leg.transitStops![6].latitude += 0.01;
    expect(TransitTimeline.create(leg)).toBeDefined();
    expect(TransitPath.create(leg)).toBeUndefined();
    expect(TransitPath.forPresentation(leg)?.schematic).toBe(true);
  });
  it("confirms GPS progress on the Munich S8 with station coordinates off the track", () => {
    const leg = munichTrain();
    const journey: Journey = {
      id: "munich-s8",
      origin: leg.from,
      destination: leg.to,
      departure: leg.start,
      arrival: leg.end,
      transfers: 0,
      isDirect: false,
      legs: [leg],
    };
    const engine = new NavigationEngine(navigationJourney(journey));
    const anchor = projectPath(leg.transitStops![6], leg.coordinates).meters;
    const point = new NavigationPath(leg.coordinates).at(anchor + 5).point;
    for (const seconds of [0, 1]) {
      const timestamp = (leg.start + seconds) * 1000;
      engine.update({ ...point, accuracy: 10, timestamp }, timestamp);
    }
    expect(engine.transitStopIndex).toBe(6);
  });
  it("follows the curved route at the scheduled speed, waits at a stop and clamps at the exit", () => {
    const leg = train();
    const timeline = TransitTimeline.create(leg)!;
    const path = TransitPath.forPresentation(leg)!;
    expect(path.schematic).toBe(false);
    expect(path.at(timeline.sample(start - 10)).point).toEqual({
      latitude: 0,
      longitude: 0,
    });
    const halfway = path.at(timeline.sample(start + 100));
    expect(halfway.point.latitude).toBeCloseTo(0);
    expect(halfway.point.longitude).toBeCloseTo(0.01);
    expect(timeline.sample(start + 100).stopIndex).toBe(0);
    expect(path.at(timeline.sample(start + 220)).point).toEqual({
      latitude: b.latitude,
      longitude: b.longitude,
    });
    expect(timeline.sample(start + 220).stopIndex).toBe(0);
    expect(timeline.sample(start + 240).stopIndex).toBe(1);
    expect(timeline.nextMovementAt(start + 210)).toBe(start + 240);
    expect(timeline.nextMovementAt(start + 10, 1, 1)).toBe(start + 240);
    expect(timeline.nextMovementAt(start + 500)).toBeUndefined();
    const earlyBoarding = train();
    earlyBoarding.transitStops![0].arrival = start - 60;
    delete earlyBoarding.transitStops![0].departure;
    const early = TransitTimeline.create(earlyBoarding)!;
    expect(early.sample(start - 30).position).toBe(0);
    expect(early.nextMovementAt(start - 30)).toBe(start);
    expect(path.at(timeline.sample(start + 10000)).point).toEqual({
      latitude: c.latitude,
      longitude: c.longitude,
    });
    expect(timeline.sample(start + 10000)).toMatchObject({
      position: 2,
      stopIndex: 2,
      atExit: true,
    });
  });
  it("uses updated times, skips cancelled stops and bridges missing intermediate times", () => {
    const leg = train();
    const stops = leg.transitStops!;
    stops[1].arrival = start + 300;
    stops[1].departure = start + 320;
    stops[1].scheduledArrival = start + 200;
    expect(TransitTimeline.create(leg)!.sample(start + 250).stopIndex).toBe(0);
    stops[1].cancelled = true;
    expect(TransitTimeline.create(leg)!.sample(start + 350).stopIndex).toBe(0);
    stops[1].cancelled = false;
    delete stops[1].arrival;
    delete stops[1].scheduledArrival;
    delete stops[1].departure;
    expect(TransitTimeline.create(leg)!.sample(start + 300).stopIndex).toBe(1);
  });
  it("keeps contradictory times local and uses schematic geometry when the shape is unusable", () => {
    const leg = train();
    leg.transitStops![1].departure = start + 100;
    const contradictory = TransitTimeline.create(leg)!;
    expect(contradictory.sample(start + 150).phase).toBe("ride");
    expect(contradictory.sample(start + 250).phase).toBe("unclear");
    expect(contradictory.sample(leg.end).atExit).toBe(true);
    expect(TransitPath.create(leg)!.stopOffsets).toHaveLength(3);
    const missingShape = train();
    missingShape.coordinates = [a, c];
    expect(TransitTimeline.create(missingShape)).toBeDefined();
    expect(TransitPath.forPresentation(missingShape)?.schematic).toBe(true);
    expect(
      TransitTimeline.create({
        ...train(),
        transitStatus: { cancelled: true },
      }),
    ).toBeUndefined();
  });
  it("keeps repeated station occurrences separate", () => {
    const leg = train();
    leg.to = a;
    leg.coordinates.push(a);
    leg.transitStops!.push({ ...a, arrival: start + 600 });
    leg.end = start + 600;
    const timeline = TransitTimeline.create(leg)!;
    const path = TransitPath.forPresentation(leg)!;
    expect(path.stopOffsets[3]).toBeGreaterThan(path.stopOffsets[2]);
    expect(timeline.sample(start + 1).stopIndex).toBe(0);
    expect(timeline.sample(start + 601).stopIndex).toBe(3);
    const fix = { ...a, accuracy: 10, timestamp: 1000 };
    expect(projectTransitPath(fix, leg.coordinates, 0)).toBeUndefined();
    expect(
      projectTransitPath(fix, leg.coordinates, path.stopOffsets[2])!.meters,
    ).toBeCloseTo(path.stopOffsets[3]);
  });
  it("never mutates confirmed progress or moves behind its lower bound", () => {
    const leg = train();
    const journey: Journey = {
      id: "test",
      origin: a,
      destination: c,
      departure: start,
      arrival: leg.end,
      transfers: 0,
      isDirect: false,
      legs: [leg],
    };
    const engine = new NavigationEngine(navigationJourney(journey));
    const before = structuredClone(engine.progress);
    const timeline = TransitTimeline.create(engine.leg)!;
    expect(timeline.sample(start + 10, 1, 1).stopIndex).toBe(1);
    expect(timeline.sample(start + 10, 1, 1).position).toBe(1);
    timeline.sample(start + 10000);
    expect(engine.progress).toEqual(before);
    expect(engine.phase).toBe("active");
  });
});

describe("marker corrections", () => {
  const path = new NavigationPath([
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.01 },
    { latitude: 0.01, longitude: 0.01 },
  ]);
  const track = (meters: number) => ({ path, sample: () => path.at(meters) });
  it("keeps identical GPS updates stationary without scheduling a correction", () => {
    const motion = new MarkerMotion();
    motion.setTarget(track(100), 0, false);
    motion.setTarget(track(100), 10, true);
    expect(motion.correcting).toBe(false);
    expect(motion.sample(10).meters).toBe(100);
  });
  it("glides along the route without a jump or overshoot and rebases an interrupted correction", () => {
    const motion = new MarkerMotion();
    motion.setTarget(track(0), 0, true);
    motion.setTarget(track(2000), 1, true);
    expect(motion.sample(1).meters).toBe(0);
    expect(motion.sample(2).meters).toBe(1000);
    const visible = motion.sample(2);
    motion.setTarget(track(500), 2, true);
    expect(motion.sample(2)).toEqual(visible);
    expect(motion.sample(3).meters).toBe(750);
    expect(motion.sample(4).meters).toBe(500);
    expect(motion.correcting).toBe(false);
  });
  it("samples a moving target continuously and finishes the correction at the current target", () => {
    const motion = new MarkerMotion();
    motion.setTarget(track(0), 0, false);
    motion.setTarget(
      { path, sample: (now) => path.at(1000 + now * 10) },
      1,
      true,
    );
    expect(motion.sample(1).meters).toBe(0);
    expect(motion.sample(2).meters).toBe(510);
    expect(motion.sample(3).meters).toBe(1030);
    expect(motion.sample(3.016).meters! - motion.sample(3).meters!).toBeCloseTo(
      0.16,
    );
  });
  it("glides even over a large GPS correction and takes the shortest turn", () => {
    const motion = new MarkerMotion();
    motion.setTarget({ sample: () => ({ point: a, bearing: 350 }) }, 0, false);
    motion.setTarget(
      { sample: () => ({ point: { latitude: 5, longitude: 6 }, bearing: 10 }) },
      1,
      true,
    );
    expect(motion.sample(1).point).toEqual({
      latitude: a.latitude,
      longitude: a.longitude,
    });
    expect(motion.sample(2)).toMatchObject({
      point: { latitude: 2.5, longitude: 3 },
      bearing: 360,
    });
    expect(motion.sample(3)).toMatchObject({
      point: { latitude: 5, longitude: 6 },
      bearing: 10,
    });
  });
  it("carries rail distances through GPS corrections and repeated coordinates", () => {
    const motion = new MarkerMotion();
    motion.setTarget(
      { sample: () => ({ point: a, bearing: 0, meters: 800 }) },
      0,
      false,
    );
    motion.setTarget(
      { sample: () => ({ point: b, bearing: 0, meters: 200 }) },
      1,
      true,
    );
    expect(motion.sample(1).meters).toBe(800);
    expect(motion.sample(2).meters).toBe(500);
    expect(motion.sample(3).meters).toBe(200);
    motion.setTarget(
      { sample: () => ({ point: b, bearing: 0, meters: 1200 }) },
      4,
      true,
    );
    expect(motion.correcting).toBe(true);
    expect(motion.sample(5).meters).toBe(700);
    expect(motion.sample(6).meters).toBe(1200);
  });
  it("applies the current target immediately when motion is reduced", () => {
    const motion = new MarkerMotion();
    motion.setTarget(track(0), 0, false);
    motion.setTarget(track(2000), 1, true);
    expect(motion.sample(1, false).meters).toBe(2000);
    expect(motion.correcting).toBe(false);
  });
});
