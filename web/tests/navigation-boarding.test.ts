import { describe, expect, it } from "vitest";
import { NavigationBoarding } from "../src/navigation-boarding";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import type { Journey, Leg } from "../src/model";

const point = (meters: number) => ({
  latitude: 48 + meters / 111195,
  longitude: 11,
  name: String(meters),
  detail: "",
});
const fix = (meters: number, seconds: number, accuracy = 10) => ({
  ...point(meters),
  timestamp: seconds * 1000,
  accuracy,
});
function engine() {
  const bike: Leg = {
    kind: "bike",
    from: point(-1000),
    to: point(0),
    start: 0,
    end: 100,
    distance: 1000,
    coordinates: [point(-1000), point(0)],
  };
  const train: Leg = {
    kind: "transit",
    from: point(0),
    to: point(6000),
    start: 100,
    end: 700,
    distance: 6000,
    coordinates: [point(0), point(1000), point(6000)],
    transitStatus: { updatedAt: 300 },
  };
  return new NavigationEngine(
    navigationJourney({
      id: "boarding",
      origin: bike.from,
      destination: train.to,
      departure: 0,
      arrival: 700,
      legs: [bike, train],
      transfers: 0,
      isDirect: false,
    } as Journey),
  );
}
const sample = (
  tracker: NavigationBoarding,
  e: NavigationEngine,
  meters: number,
  seconds: number,
  accuracy = 10,
) => tracker.update(e, fix(meters, seconds, accuracy), seconds * 1000);

describe("boarding recovery evidence", () => {
  it("retains first evidence through 1 Hz updates and ignores repeated timestamps", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    for (let second = 300; second < 303; second++)
      expect(
        sample(tracker, e, 2000 + (second - 300) * 10, second),
      ).toBeUndefined();
    expect(sample(tracker, e, 2020, 302)).toBeUndefined();
    const result = sample(tracker, e, 2030, 303)!;
    expect(result.index).toBe(1);
    expect(result.fixes.map((f) => f.timestamp)).toEqual([300000, 303000]);
    expect(result.meters).toBeCloseTo(2000, 0);
  });
  it.each([
    [2000, 2000, 300, 303, 10], // stationary
    [2000, 1900, 300, 303, 10], // backwards
    [2000, 4000, 300, 303, 10], // jump
    [2000, 2030, 300, 331, 10], // gap
    [2000, 2030, 300, 303, 51], // inaccurate
    [2000, 2030, 110, 113, 10], // wrong time
    [2000, 2030, 701, 704, 10], // after arrival
    [100, 140, 110, 113, 10], // boarding vicinity
    [5901, 5940, 690, 693, 10], // exit vicinity
  ])("rejects invalid pair %j", (a, b, start, end, accuracy) => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.journey.legs[1].transitStatus!.updatedAt = end;
    sample(tracker, e, a, start, accuracy);
    expect(sample(tracker, e, b, end, accuracy)).toBeUndefined();
  });
  it("does not confuse a parallel active bike route with a train", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.leg.coordinates = [point(0), point(6000)];
    sample(tracker, e, 2000, 300);
    expect(sample(tracker, e, 2030, 303)).toBeUndefined();
  });
  it.each(["geometry", "cancelled", "stop", "stale"])(
    "rejects missing prerequisites: %s",
    (kind) => {
      const e = engine(),
        tracker = new NavigationBoarding(),
        train = e.journey.legs[1];
      if (kind === "geometry") train.coordinates = [train.from, train.to];
      if (kind === "cancelled") train.transitStatus!.cancelled = true;
      if (kind === "stop") e.leg.kind = "stop";
      if (kind === "stale") train.transitStatus!.updatedAt = 0;
      sample(tracker, e, 2000, 300);
      expect(sample(tracker, e, 2030, 303)).toBeUndefined();
    },
  );
  it("reevaluates retained fixes after delayed timetable refresh", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.journey.legs[1].transitStatus!.updatedAt = 0;
    sample(tracker, e, 2000, 300);
    expect(sample(tracker, e, 2030, 303)).toBeUndefined();
    e.journey.legs[1].transitStatus!.updatedAt = 304;
    expect(tracker.update(e, fix(2030, 303), 304000)?.index).toBe(1);
  });
  it("uses physical distance across uneven station intervals and respects dwell", () => {
    const e = engine(),
      tracker = new NavigationBoarding(),
      train = e.journey.legs[1];
    train.transitStops = [
      point(0),
      { ...point(1000), arrival: 200, departure: 220 },
      point(6000),
    ];
    sample(tracker, e, 2000, 300);
    expect(sample(tracker, e, 2030, 303)?.index).toBe(1);
  });
  it("rejects contradictory anchor times", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.journey.legs[1].transitStops = [
      point(0),
      { ...point(1000), arrival: 250, departure: 200 },
      point(6000),
    ];
    sample(tracker, e, 2000, 300);
    expect(sample(tracker, e, 2030, 303)).toBeUndefined();
  });
  it("drops evidence on topology changes, source changes and reset", () => {
    for (const kind of ["topology", "engine", "reset"]) {
      let e = engine();
      const tracker = new NavigationBoarding();
      sample(tracker, e, 2000, 300);
      if (kind === "topology") e.journey.legs[1].coordinates[1] = point(1100);
      if (kind === "engine") e = engine();
      if (kind === "reset") tracker.reset();
      expect(sample(tracker, e, 2030, 303)).toBeUndefined();
    }
  });
});

describe("transit movement confidence", () => {
  it.each([undefined, 1.1])(
    "rejects platform walking with reported speed %s",
    (speed) => {
      const e = engine(),
        tracker = new NavigationBoarding();
      for (let second = 300; second <= 319; second++) {
        expect(
          tracker.update(
            e,
            { ...fix(2000 + (second - 300) * 1.1, second), speed },
            second * 1000,
          ),
        ).toBeUndefined();
      }
    },
  );
  it("reported high speed cannot replace measured movement", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    tracker.update(e, { ...fix(2000, 300), speed: 20 }, 300000);
    expect(
      tracker.update(e, { ...fix(2000, 303), speed: 20 }, 303000),
    ).toBeUndefined();
  });
  it("low speed vetoes an apparent fast jump", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    tracker.update(e, { ...fix(2000, 300), speed: 1.1 }, 300000);
    expect(
      tracker.update(e, { ...fix(2100, 303), speed: 1.1 }, 303000),
    ).toBeUndefined();
  });
  it("ignores old and duplicate low-speed values without losing refresh reevaluation", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.journey.legs[1].transitStatus!.updatedAt = 0;
    tracker.update(e, { ...fix(2000, 300), speed: 10 }, 300000);
    tracker.update(e, { ...fix(2030, 303), speed: 10 }, 303000);
    tracker.update(e, { ...fix(1990, 299), speed: 1.1 }, 303000);
    tracker.update(e, { ...fix(1990, 303), speed: 1.1 }, 303000);
    tracker.update(e, fix(1990, 303, 90), 303000);
    e.journey.legs[1].transitStatus!.updatedAt = 304;
    expect(tracker.update(e, fix(2030, 303), 304000)?.index).toBe(1);
  });
  it("new walking evidence resets even before fresh timetable data arrive", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    e.journey.legs[1].transitStatus!.updatedAt = 0;
    tracker.update(e, fix(2000, 300), 300000);
    tracker.update(e, { ...fix(2010, 301), speed: 1.1 }, 301000);
    tracker.update(e, fix(2030, 303), 303000);
    e.journey.legs[1].transitStatus!.updatedAt = 304;
    expect(tracker.update(e, fix(2030, 303), 304000)).toBeUndefined();
    expect(tracker.update(e, fix(2060, 306), 306000)?.index).toBe(1);
  });
  it("waits for accuracy-adjusted speed and accepts its boundary", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    sample(tracker, e, 2000, 300);
    expect(sample(tracker, e, 2076, 319)).toBeUndefined();
    expect(sample(tracker, e, 2080.01, 320)?.index).toBe(1);
  });
  it("cannot recover a 5m/s ride with two 50m uncertainty radii in 30 seconds", () => {
    const e = engine(),
      tracker = new NavigationBoarding();
    for (let second = 300; second <= 360; second++) {
      expect(
        sample(tracker, e, 2000 + (second - 300) * 5, second, 50),
      ).toBeUndefined();
    }
  });
});
