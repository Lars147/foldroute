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
} from "../src/navigation-engine";
import type { Journey, Leg, TransitStop } from "../src/model";

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

describe("time-based transit presentation", () => {
  it("follows the curved route at the scheduled speed, waits at a stop and clamps at the exit", () => {
    const timeline = TransitTimeline.create(train())!;
    expect(timeline.sample(start - 10).point).toEqual({
      latitude: 0,
      longitude: 0,
    });
    const halfway = timeline.sample(start + 100);
    expect(halfway.point.latitude).toBeCloseTo(0);
    expect(halfway.point.longitude).toBeCloseTo(0.01);
    expect(halfway.stopIndex).toBe(0);
    expect(timeline.sample(start + 220).point).toEqual({
      latitude: b.latitude,
      longitude: b.longitude,
    });
    expect(timeline.sample(start + 220).stopIndex).toBe(0);
    expect(timeline.sample(start + 240).stopIndex).toBe(1);
    expect(timeline.nextMovementAt(start + 210)).toBe(start + 240);
    expect(
      timeline.nextMovementAt(start + 10, 1, timeline.stopOffsets[1]),
    ).toBe(start + 240);
    expect(timeline.nextMovementAt(start + 500)).toBeUndefined();
    const earlyBoarding = train();
    earlyBoarding.transitStops![0].arrival = start - 60;
    delete earlyBoarding.transitStops![0].departure;
    const early = TransitTimeline.create(earlyBoarding)!;
    expect(early.sample(start - 30).meters).toBe(0);
    expect(early.nextMovementAt(start - 30)).toBe(start);
    expect(timeline.sample(start + 10000)).toMatchObject({
      point: { latitude: c.latitude, longitude: c.longitude },
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
  it("rejects contradictory times, unusable shapes and cancelled journeys", () => {
    const leg = train();
    leg.transitStops![1].departure = start + 100;
    expect(TransitTimeline.create(leg)).toBeUndefined();
    expect(TransitPath.create(leg)!.stopOffsets).toHaveLength(3);
    const missingShape = train();
    missingShape.coordinates = [a, c];
    expect(TransitTimeline.create(missingShape)).toBeUndefined();
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
    expect(timeline.stopOffsets[3]).toBeGreaterThan(timeline.stopOffsets[2]);
    expect(timeline.sample(start + 1).stopIndex).toBe(0);
    expect(timeline.sample(start + 601).stopIndex).toBe(3);
    const fix = { ...a, accuracy: 10, timestamp: 1000 };
    expect(projectTransitPath(fix, leg.coordinates, 0)).toBeUndefined();
    expect(
      projectTransitPath(fix, leg.coordinates, timeline.stopOffsets[2])!.meters,
    ).toBeCloseTo(timeline.stopOffsets[3]);
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
    expect(
      timeline.sample(start + 10, 1, timeline.stopOffsets[1]).stopIndex,
    ).toBe(1);
    expect(timeline.sample(start + 10, 1, timeline.stopOffsets[1]).meters).toBe(
      timeline.stopOffsets[1],
    );
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
