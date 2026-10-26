import { describe, expect, it } from "vitest";
import { NavigationEngine } from "../src/navigation-engine";
import { NavigationPath, MarkerMotion } from "../src/navigation-estimate";
import { NavigationPositionTracker } from "../src/navigation-position";
import { distance } from "../src/geometry";
import type { Journey, Leg } from "../src/model";

const now = 1_000_000;
const a = { latitude: 48, longitude: 11, name: "Start", detail: "" };
const b = { ...a, longitude: 11.01 };
const c = { ...a, longitude: 11.02, name: "Ziel" };
function route(kind: Leg["kind"] = "bike") {
  const leg: Leg = {
    kind,
    from: a,
    to: c,
    start: now / 1000,
    end: now / 1000 + 1000,
    distance: distance(a, c),
    coordinates: [a, b, c],
  };
  return new NavigationEngine({
    id: "test",
    origin: a,
    destination: c,
    departure: leg.start,
    arrival: leg.end,
    transfers: 0,
    isDirect: true,
    legs: [leg],
  } as Journey);
}
const path = new NavigationPath([a, b, c]);
function fix(meters = 100, side = 0, accuracy = 10, seconds = 0) {
  const point = path.at(meters).point;
  return {
    ...point,
    latitude: point.latitude + side / 111195,
    accuracy,
    timestamp: now + seconds * 1000,
  };
}
function update(
  tracker: NavigationPositionTracker,
  engine: NavigationEngine,
  sample = fix(),
) {
  return tracker.update(engine, sample, "current", sample.timestamp);
}

describe("navigation display matching", () => {
  it.each([
    ["bike", 39, 10, true],
    ["bike", 41, 10, false],
    ["walk", 69, 70, true],
    ["walk", 71, 70, false],
    ["transit", 99, 10, true],
    ["transit", 101, 10, false],
  ] as const)(
    "matches %s at %i m with %i m accuracy: %s",
    (kind, side, accuracy, matched) => {
      const result = update(
        new NavigationPositionTracker(),
        route(kind),
        fix(100, side, accuracy),
      );
      expect(!!result.path).toBe(matched);
    },
  );

  it("holds the marker through inaccurate and stale fixes while updating fresh uncertainty", () => {
    const tracker = new NavigationPositionTracker(),
      engine = route();
    const first = update(tracker, engine);
    const inaccurate = fix(800, 100, 500, 1);
    const held = tracker.update(
      engine,
      inaccurate,
      "inaccurate",
      inaccurate.timestamp,
    );
    expect(held.position).toEqual(first.position);
    expect(held.raw).toEqual(inaccurate);
    expect(held.preferEstimate).toBe(true);
    const stale = tracker.update(
      engine,
      fix(1100, 0, 10, 2),
      "current",
      now + 63000,
    );
    expect(stale.position).toEqual(first.position);
    expect(stale.raw).toEqual(inaccurate);
    expect(stale.source).toBe("last-known");
  });

  it.each(["bike", "walk", "transit"] as const)(
    "pins %s drift inside the accuracy circle while retaining raw GPS",
    (kind) => {
      const engine = route(kind),
        tracker = new NavigationPositionTracker();
      const raw = fix(100, 50, 70);
      const result = update(tracker, engine, raw);
      expect(distance(result.position.point, path.at(100).point)).toBeLessThan(
        0.1,
      );
      expect(distance(result.position.point, raw)).toBeCloseTo(50, 0);
      expect(result.raw).toEqual(raw);
      expect(result.source).toBe("gps");
      expect(result.preferEstimate).toBe(false);
    },
  );

  it("moves hundreds of metres with 70 m GPS without advancing confirmed progress", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    for (let i = 0; i <= 15; i++) {
      const raw = fix(100 + i * 40, 50, 70, i * 5);
      engine.update(raw, raw.timestamp);
      const result = update(tracker, engine, raw);
      expect(result.position.meters).toBeCloseTo(100 + i * 40, 0);
      expect(result.source).toBe("gps");
    }
    expect(engine.progress.meters).toBe(0);
  });

  it.each(["bike", "transit"] as const)(
    "holds two %s outliers, releases on the third and reattaches",
    (kind) => {
      const engine = route(kind),
        tracker = new NavigationPositionTracker();
      const original = update(tracker, engine);
      for (let i = 1; i <= 2; i++) {
        const raw = fix(100, 150, 70, i);
        const held = update(tracker, engine, raw);
        expect(held.position).toEqual(original.position);
        expect(held.source).toBe("last-known");
        expect(held.preferEstimate).toBe(false);
        expect(update(tracker, engine, raw)).toEqual(held);
      }
      const released = update(tracker, engine, fix(100, 150, 70, 3));
      expect(released.path).toBeUndefined();
      expect(released.preferEstimate).toBe(true);
      expect(released.position.point).toMatchObject(fix(100, 150, 70, 3));
      expect(update(tracker, engine, fix(120, 10, 10, 4)).path).toBeDefined();
    },
  );

  it("resets outlier evidence on a match or unusable measurement", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    update(tracker, engine);
    update(tracker, engine, fix(100, 120, 10, 1));
    update(tracker, engine, fix(100, 0, 10, 2));
    expect(update(tracker, engine, fix(100, 120, 10, 3)).source).toBe(
      "last-known",
    );
    tracker.update(engine, fix(100, 120, 500, 4), "inaccurate", now + 4000);
    expect(update(tracker, engine, fix(100, 0, 10, 5)).source).toBe("gps");
    expect(update(tracker, engine, fix(100, 120, 10, 6)).source).toBe(
      "last-known",
    );
  });

  it("reacquires far ahead after a freshness barrier but rejects the cached fix", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    const first = update(tracker, engine);
    const held = tracker.update(engine, fix(), "stale", now + 1000);
    expect(held.position).toEqual(first.position);
    expect(update(tracker, engine, fix()).source).toBe("last-known");
    expect(
      update(tracker, engine, fix(1100, 20, 30, 2)).position.meters,
    ).toBeCloseTo(1100, 0);
    expect(
      update(tracker, engine, fix(200, 20, 30, 70)).position.meters,
    ).toBeCloseTo(200, 0);
  });

  it("holds on an impossible movement without counting it as route departure", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    const first = update(tracker, engine);
    for (let i = 1; i <= 3; i++) {
      const result = update(tracker, engine, fix(1100, 0, 10, i));
      expect(result.position).toEqual(first.position);
      expect(result.source).toBe("last-known");
    }
    expect(update(tracker, engine, fix(110, 0, 10, 4)).source).toBe("gps");
  });

  it("uses drawn geometry rather than maneuver metres and resets when it changes", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    engine.leg.maneuvers = [
      {
        direction: "CONTINUE",
        streetName: "",
        distance: 3000,
        coordinates: [a, { ...b, latitude: 48.01 }, c],
      },
    ];
    engine.progress.meters = 800;
    const first = update(tracker, engine);
    expect(first.position.meters).toBeCloseTo(100, 0);
    engine.leg.coordinates = [c, b, a];
    const changed = update(tracker, engine, fix(100, 0, 10, 1));
    expect(changed.path?.key).not.toBe(first.path?.key);
    expect(changed.position.meters).toBeCloseTo(path.offsets.at(-1)! - 100, 0);
    expect(engine.progress.meters).toBe(800);
  });

  it("resets on engine and leg identity changes even with identical geometry", () => {
    const tracker = new NavigationPositionTracker(),
      engine = route();
    update(tracker, engine);
    expect(update(tracker, route(), fix(1000)).position.meters).toBeCloseTo(
      1000,
      0,
    );
    engine.leg.navigationId = "next";
    expect(update(tracker, engine, fix(1200)).position.meters).toBeCloseTo(
      1200,
      0,
    );
  });

  it("does not snap to schematic transit lines", () => {
    const engine = route("transit"),
      tracker = new NavigationPositionTracker();
    engine.leg.coordinates = [a, c];
    expect(update(tracker, engine, fix(100, 20)).path).toBeUndefined();
  });

  it("rejects ambiguous loops and can disambiguate opposite directions using a moving course", () => {
    const engine = route(),
      tracker = new NavigationPositionTracker();
    engine.leg.coordinates = [a, b, a];
    expect(update(tracker, engine, fix(300)).path).toBeUndefined();
    const matched = update(tracker, engine, {
      ...fix(300, 0, 10, 1),
      heading: 90,
      speed: 4,
    });
    expect(matched.position.meters).toBeCloseTo(300, 0);
  });

  it("keeps transit GPS corrections on a curved drawn route", () => {
    const engine = route("transit"),
      tracker = new NavigationPositionTracker();
    const corner = { ...a, longitude: 11.001 };
    const end = { ...corner, latitude: 48.001 };
    engine.leg.coordinates = [a, corner, end];
    const motion = new MarkerMotion();
    const first = update(tracker, engine, {
      ...a,
      accuracy: 10,
      timestamp: now,
    });
    motion.setTarget(
      { path: first.path, sample: () => first.position },
      0,
      false,
    );
    const last = update(tracker, engine, {
      ...end,
      accuracy: 10,
      timestamp: now + 10000,
    });
    motion.setTarget(
      { path: last.path, sample: () => last.position },
      10,
      true,
    );
    const midway = motion.sample(11).point;
    expect(midway.longitude).toBeCloseTo(corner.longitude, 7);
    expect(midway.latitude).toBeGreaterThan(corner.latitude);
  });
});
