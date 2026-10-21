import { describe, expect, it } from "vitest";
import type { Leg, TransitStop } from "../src/model";
import { TransitPath } from "../src/navigation-estimate";
import {
  StationMotion,
  TransitTimeline,
  stationCursor,
} from "../src/transit-timeline";

const start = 1000;
function train(count = 4): Leg {
  const stops: TransitStop[] = Array.from({ length: count }, (_, index) => ({
    name: String.fromCharCode(65 + index),
    stopId: String.fromCharCode(65 + index),
    detail: "",
    latitude: 48 + index * 0.001,
    longitude: 11 + index * 0.001,
  }));
  return {
    kind: "transit",
    navigationId: "test-train",
    from: stops[0],
    to: stops.at(-1)!,
    start,
    end: start + (count - 1) * 100,
    distance: 0,
    coordinates: [...stops],
    transitStops: stops,
  };
}
function timeline(leg: Leg) {
  const result = TransitTimeline.create(leg);
  expect(result).toBeDefined();
  return result!;
}

describe("geometry-free station timetable", () => {
  it("interpolates missing times by served sections, independently of their geographic length", () => {
    const leg = train();
    leg.transitStops![1].latitude = 49;
    const time = timeline(leg);
    expect(time.sample(start + 50)).toMatchObject({
      position: 0.5,
      fromIndex: 0,
      toIndex: 1,
      fraction: 0.5,
      phase: "ride",
      stopIndex: 0,
    });
    expect(time.sample(start + 150)).toMatchObject({
      position: 1.5,
      stopIndex: 1,
    });
    expect(time.sample(leg.end)).toMatchObject({
      position: 3,
      stopIndex: 3,
      phase: "exit",
      atExit: true,
    });
  });
  it("uses identical station progress with absent, displaced and original map geometry", () => {
    const original = train();
    const absent = structuredClone(original);
    absent.coordinates = [];
    const displaced = structuredClone(original);
    displaced.coordinates = displaced.coordinates.map((point) => ({
      ...point,
      latitude: point.latitude + 2,
    }));
    for (const now of [
      start - 1,
      start,
      start + 60,
      start + 175,
      original.end,
      original.end + 60,
    ]) {
      const expected = timeline(original).sample(now);
      expect(timeline(absent).sample(now)).toEqual(expected);
      expect(timeline(displaced).sample(now)).toEqual(expected);
    }
    expect(TransitPath.forPresentation(original)?.schematic).toBe(false);
    expect(TransitPath.forPresentation(absent)?.schematic).toBe(true);
    expect(TransitPath.forPresentation(displaced)?.schematic).toBe(true);
    const endpointOnly = structuredClone(original);
    endpointOnly.coordinates = [endpointOnly.from, endpointOnly.to];
    expect(TransitPath.forPresentation(endpointOnly)?.schematic).toBe(true);
  });
  it("waits through dwell, uses realtime per field and passes a stop at its departure", () => {
    const leg = train(3);
    leg.transitStops![1] = {
      ...leg.transitStops![1],
      scheduledArrival: start + 60,
      scheduledDeparture: start + 100,
      arrival: start + 80,
      departure: start + 120,
    };
    const time = timeline(leg);
    expect(time.sample(start + 40).position).toBe(0.5);
    expect(time.sample(start + 80)).toMatchObject({
      position: 1,
      phase: "dwell",
      stopIndex: 0,
    });
    expect(time.sample(start + 110)).toMatchObject({
      position: 1,
      phase: "dwell",
      stopIndex: 0,
    });
    expect(time.sample(start + 120)).toMatchObject({
      position: 1,
      phase: "ride",
      stopIndex: 1,
    });
    expect(time.nextMovementAt(start + 85)).toBe(start + 120);
    delete leg.transitStops![1].departure;
    delete leg.transitStops![1].scheduledDeparture;
    expect(timeline(leg).sample(start + 80).stopIndex).toBe(1);
  });
  it("skips cancelled visits while preserving repeated station occurrences", () => {
    const leg = train(5);
    leg.transitStops![1].cancelled = true;
    leg.transitStops![3] = { ...leg.transitStops![0] };
    const time = timeline(leg);
    const halfway = time.sample(start + 400 / 6);
    expect(halfway).toMatchObject({ fromIndex: 0, toIndex: 2, stopIndex: 0 });
    expect(halfway.position).toBeCloseTo(1);
    expect(halfway.fraction).toBeCloseTo(0.5);
    expect(time.sample(start + 200)).toMatchObject({
      position: 2.5,
      stopIndex: 2,
    });
    expect(time.sample(start + 300)).toMatchObject({
      position: 3.25,
      stopIndex: 3,
    });
    expect(time.sample(leg.end)).toMatchObject({ position: 4, stopIndex: 4 });
  });
  it("projects a cancelled-stop gap using its served endpoints in both map modes", () => {
    const leg = train(4);
    leg.transitStops![1].cancelled = true;
    const cursor = timeline(leg).sample(start + 75);
    expect(cursor).toMatchObject({ fromIndex: 0, toIndex: 2, fraction: 0.5 });
    const expected = {
      latitude:
        (leg.transitStops![0].latitude + leg.transitStops![2].latitude) / 2,
      longitude:
        (leg.transitStops![0].longitude + leg.transitStops![2].longitude) / 2,
    };
    for (const coordinates of [leg.coordinates, []]) {
      const point = TransitPath.forPresentation({ ...leg, coordinates })!.at(
        cursor,
      ).point;
      expect(point.latitude).toBeCloseTo(expected.latitude, 7);
      expect(point.longitude).toBeCloseTo(expected.longitude, 7);
    }
  });
  it("treats changed section endpoints as authoritative over old endpoint stop times", () => {
    const leg = train(3);
    leg.transitStops![0].departure = start;
    leg.transitStops![1].arrival = start + 100;
    leg.transitStops![2].arrival = start + 200;
    leg.end = start + 300;
    expect(timeline(leg).sample(start + 250)).toMatchObject({
      atExit: false,
      phase: "ride",
    });
    expect(timeline(leg).sample(leg.end)).toMatchObject({
      atExit: true,
      position: 2,
    });
    leg.start = start + 50;
    expect(timeline(leg).sample(start + 25)).toMatchObject({
      phase: "before",
      position: 0,
    });
    expect(timeline(leg).sample(start + 75).position).toBe(0.5);
  });
  it("holds only an inconsistent time interval, then resumes at the next reliable event", () => {
    const leg = train(3);
    leg.transitStops![1].arrival = start - 10;
    leg.transitStops![1].departure = start + 10;
    const time = timeline(leg);
    expect(time.sample(start + 5)).toMatchObject({
      phase: "unclear",
      position: 0,
      stopIndex: 0,
    });
    expect(time.sample(start + 10)).toMatchObject({
      phase: "ride",
      position: 1,
      stopIndex: 1,
    });
    expect(time.sample(start + 105)).toMatchObject({
      phase: "ride",
      position: 1.5,
    });
  });
  it("retains a valid arrival before an inconsistent departure without inventing movement", () => {
    const leg = train(3);
    leg.transitStops![1].arrival = start + 170;
    leg.transitStops![1].scheduledDeparture = start + 150;
    const time = timeline(leg);
    expect(time.sample(start + 85)).toMatchObject({
      phase: "ride",
      position: 0.5,
    });
    expect(time.sample(start + 180)).toMatchObject({
      phase: "unclear",
      position: 1,
      atExit: false,
    });
    expect(time.sample(leg.end)).toMatchObject({
      phase: "exit",
      position: 2,
      atExit: true,
    });
  });
  it("does not interpolate across equal-time distinct stops or out-of-bounds intermediate times", () => {
    const leg = train(4);
    leg.transitStops![1].arrival = start + 100;
    leg.transitStops![2].arrival = start + 100;
    expect(timeline(leg).sample(start + 150)).toMatchObject({
      phase: "unclear",
      position: 1,
    });
    leg.transitStops![1].arrival = start + 350;
    leg.transitStops![1].departure = start + 360;
    leg.transitStops![2].arrival = start + 200;
    const time = timeline(leg);
    expect(time.sample(start + 150)).toMatchObject({
      phase: "unclear",
      position: 0,
    });
    expect(time.sample(start + 250)).toMatchObject({
      phase: "ride",
      position: 2.5,
    });
  });
  it("keeps confirmed progress as a floor without preserving an estimated high-water mark", () => {
    const leg = train();
    const before = structuredClone(leg);
    const time = timeline(leg);
    expect(time.sample(start + 50, 1, 1.4)).toMatchObject({
      position: 1.4,
      stopIndex: 1,
      source: "estimated",
    });
    expect(time.sample(start + 280).position).toBeCloseTo(2.8);
    expect(time.sample(start + 50).position).toBe(0.5);
    expect(leg).toEqual(before);
    expect(time.nextMovementAt(start + 10, 1, 1.4)).toBe(start + 140);
  });
  it("rejects unavailable trips and invalid section bounds without requiring map geometry", () => {
    const leg = train();
    for (const invalid of [
      { ...leg, transitStatus: { cancelled: true } },
      { ...leg, end: leg.start },
      { ...leg, start: Number.NaN },
      { ...leg, transitStops: undefined },
      { ...leg, transitStops: [leg.transitStops![0]] },
    ])
      expect(TransitTimeline.create(invalid)).toBeUndefined();
    leg.transitStops!.at(-1)!.cancelled = true;
    expect(TransitTimeline.create(leg)).toBeUndefined();
  });
});

describe("station correction motion", () => {
  it("replaces old stop indices immediately when a halt is inserted before the current position", () => {
    const leg = train();
    const motion = new StationMotion();
    motion.setTarget(
      "same-presentation-key",
      () => stationCursor(leg, 2.5, 2, "estimated"),
      start,
      0,
      false,
      leg,
    );
    const inserted = {
      ...leg.transitStops![1],
      name: "Inserted stop",
      stopId: "inserted",
    };
    // Update in place, as a fresh data revision may retain the leg object.
    leg.transitStops!.splice(1, 0, inserted);
    motion.setTarget(
      "same-presentation-key",
      () => stationCursor(leg, 3.5, 3, "estimated"),
      start,
      10,
      true,
      leg,
    );
    expect(motion.correcting).toBe(false);
    expect(motion.sample(start, 10)).toMatchObject({
      position: 3.5,
      stopIndex: 3,
      fromIndex: 3,
      toIndex: 4,
      fraction: 0.5,
    });
  });
  it("discards the old segment fraction immediately when route geometry changes", () => {
    const leg = train();
    const motion = new StationMotion();
    motion.setTarget(
      "same-presentation-key",
      () => stationCursor(leg, 2.5, 2, "gps"),
      start,
      0,
      false,
      leg,
    );
    const revised = structuredClone(leg);
    revised.coordinates[1].longitude += 0.005;
    motion.setTarget(
      "same-presentation-key",
      () => stationCursor(revised, 2, 2, "estimated"),
      start,
      10,
      true,
      revised,
    );
    expect(motion.correcting).toBe(false);
    expect(motion.sample(start, 10)).toMatchObject({
      position: 2,
      stopIndex: 2,
      fraction: 0,
      source: "estimated",
    });
  });
  it("continues smoothing a pure timetable revision for two seconds", () => {
    const leg = train();
    const previous = timeline(leg);
    const updated = { ...leg, end: start + 600 };
    const revised = timeline(updated);
    const wall = start + 200;
    const motion = new StationMotion();
    motion.setTarget(
      previous.revision,
      (now) => previous.sample(now),
      wall,
      0,
      false,
      leg,
    );
    expect(motion.sample(wall, 0).position).toBe(2);
    motion.setTarget(
      revised.revision,
      (now) => revised.sample(now),
      wall,
      10,
      true,
      updated,
    );
    expect(motion.correcting).toBe(true);
    expect(motion.sample(wall, 10).position).toBe(2);
    expect(motion.sample(wall, 11).position).toBe(1.5);
    expect(motion.sample(wall, 12)).toMatchObject({
      position: 1,
      revision: revised.revision,
    });
    expect(motion.correcting).toBe(false);
  });
  it("corrects backwards on monotonic time while sampling the current wall-clock target", () => {
    const leg = train();
    const motion = new StationMotion();
    motion.setTarget(
      "old",
      () => stationCursor(leg, 2.5, 2, "estimated"),
      start,
      10,
      false,
      leg,
    );
    motion.setTarget(
      "gps",
      () => stationCursor(leg, 1, 1, "gps"),
      start,
      20,
      true,
      leg,
    );
    expect(motion.sample(start, 20).position).toBe(2.5);
    expect(motion.sample(start + 3600, 21).position).toBe(1.75);
    expect(motion.sample(start - 3600, 22)).toMatchObject({
      position: 1,
      source: "gps",
    });
    expect(motion.correcting).toBe(false);
  });
  it("tracks a timetable target through a wall-clock jump without ending correction early", () => {
    const leg = train();
    const motion = new StationMotion();
    motion.setTarget(
      "old",
      () => stationCursor(leg, 0, 0, "estimated"),
      start,
      0,
      false,
      leg,
    );
    motion.setTarget(
      "new",
      (now) => stationCursor(leg, (now - start) / 100, 0, "estimated"),
      start + 100,
      10,
      true,
      leg,
    );
    expect(motion.sample(start + 200, 11).position).toBe(1);
    expect(motion.correcting).toBe(true);
    expect(motion.sample(start + 250, 12).position).toBe(2.5);
    expect(motion.correcting).toBe(false);
  });
  it("rebases interrupted corrections, respects the confirmed floor and reduces motion", () => {
    const leg = train();
    const motion = new StationMotion();
    motion.setTarget(
      "a",
      () => stationCursor(leg, 0, 0, "estimated"),
      start,
      0,
      false,
      leg,
    );
    motion.setTarget(
      "b",
      () => stationCursor(leg, 2, 1, "gps"),
      start,
      10,
      true,
      leg,
    );
    const visible = motion.sample(start, 11);
    expect(visible.position).toBe(1);
    motion.setTarget(
      "c",
      () => stationCursor(leg, 1.5, 1, "gps"),
      start,
      11,
      true,
      leg,
    );
    expect(motion.sample(start, 11).position).toBe(visible.position);
    expect(motion.sample(start, 11, true, 1.2).position).toBe(1.2);
    expect(motion.sample(start, 11, false).position).toBe(1.5);
    expect(motion.correcting).toBe(false);
    motion.reset();
    motion.setTarget(
      "new-leg",
      () => stationCursor({ ...leg, navigationId: "other" }, 0, 0, "estimated"),
      start,
      12,
      true,
      leg,
    );
    expect(motion.correcting).toBe(false);
    expect(motion.sample(start, 12).navigationId).toBe("other");
  });
});
