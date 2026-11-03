import { describe, expect, it } from "vitest";
import { NavigationCompletion } from "../src/navigation-completion";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import { NavigationPath } from "../src/navigation-estimate";
import type { Journey, Leg } from "../src/model";

const now = 1_000_000;
const point = (meters: number) => ({
  latitude: 48 + meters / 111195,
  longitude: 11,
  name: String(meters),
  detail: "",
});
function route(
  kind: Leg["kind"] = "bike",
  coordinates = [point(0), point(400)],
) {
  const leg: Leg = {
    kind,
    from: coordinates[0],
    to: coordinates.at(-1)!,
    start: now / 1000,
    end: now / 1000 + 1000,
    distance: new NavigationPath(coordinates).length,
    coordinates,
  };
  return navigationJourney({
    id: "completion",
    origin: leg.from,
    destination: leg.to,
    departure: leg.start,
    arrival: leg.end,
    legs: [leg],
    transfers: 0,
    isDirect: true,
  } as Journey);
}
const fix = (meters: number, timestamp = now, accuracy = 10) => ({
  ...point(meters),
  timestamp,
  accuracy,
});

function move(
  completion: NavigationCompletion,
  engine: NavigationEngine,
  meters: number,
  timestamp = now,
) {
  const sample = fix(meters, timestamp);
  engine.update(sample, timestamp);
  return completion.update(engine, sample, true, timestamp);
}

describe("navigation completion visibility", () => {
  it.each(["bike", "walk"] as const)(
    "shows %s only near the section target and holds through GPS loss",
    (kind) => {
      const engine = new NavigationEngine(route(kind));
      const completion = new NavigationCompletion();
      expect(move(completion, engine, 0)).toBe(false);
      expect(move(completion, engine, 299, now + 20000)).toBe(false);
      expect(move(completion, engine, 301, now + 21000)).toBe(true);
      expect(completion.update(engine)).toBe(true);
      expect(completion.update(engine, fix(0, now, 200), true, now)).toBe(true);
      expect(move(completion, engine, 251, now + 26000)).toBe(true);
      expect(move(completion, engine, 249, now + 27000)).toBe(false);
      expect(move(completion, engine, 299, now + 30000)).toBe(false);
      expect(move(completion, engine, 301, now + 31000)).toBe(true);
    },
  );

  it("does not unlock from stale, inaccurate or session-rejected positions", () => {
    const engine = new NavigationEngine(
      route("walk", [point(310), point(400)]),
    );
    const completion = new NavigationCompletion();
    expect(completion.update(engine, fix(301, now, 51), true, now)).toBe(false);
    expect(completion.update(engine, fix(301), true, now + 60001)).toBe(false);
    expect(completion.update(engine, fix(301), false, now)).toBe(false);
    expect(completion.update(engine, fix(301), true, now)).toBe(true);
  });

  it("requires remaining route distance even when a loop starts at its target", () => {
    const engine = new NavigationEngine(
      route("bike", [point(0), point(400), point(0)]),
    );
    expect(move(new NavigationCompletion(), engine, 0)).toBe(false);
  });

  it("requires target proximity even with previously confirmed route progress", () => {
    const engine = new NavigationEngine(route());
    const completion = new NavigationCompletion();
    engine.progress.meters = 350;
    expect(completion.update(engine, fix(100), true, now)).toBe(false);
  });

  it("does not treat a degenerate path as evidence of arrival", () => {
    const engine = new NavigationEngine(route("walk", [point(0), point(0)]));
    expect(new NavigationCompletion().update(engine, fix(0), true, now)).toBe(
      false,
    );
  });

  it("retains availability across timetable updates but resets for a changed path", () => {
    const engine = new NavigationEngine(route());
    const completion = new NavigationCompletion();
    expect(move(completion, engine, 320)).toBe(true);
    const refreshed = structuredClone(engine.journey);
    refreshed.legs[0].end += 60;
    engine.applyJourney(refreshed);
    expect(completion.update(engine)).toBe(true);
    const rerouted = structuredClone(engine.journey);
    rerouted.legs[0].coordinates = [point(0), point(800), point(400)];
    engine.applyJourney(rerouted);
    expect(engine.remainingMeters).toBeGreaterThan(1000);
    expect(completion.update(engine, fix(320), true, now)).toBe(false);
  });

  it("reevaluates a changed maneuver path even when section coordinates stay the same", () => {
    const engine = new NavigationEngine(route());
    const completion = new NavigationCompletion();
    expect(move(completion, engine, 320)).toBe(true);
    const updated = structuredClone(engine.journey);
    updated.legs[0].maneuvers = [
      {
        direction: "CONTINUE",
        distance: 1200,
        coordinates: [point(0), point(800), point(400)],
      },
    ];
    engine.applyJourney(updated);
    expect(engine.remainingMeters).toBeGreaterThan(1000);
    expect(completion.update(engine, fix(320), true, now)).toBe(false);
  });

  it("resets on a new section, restored engine, explicit reset and arrival", () => {
    const journey = route();
    journey.legs.push({
      ...journey.legs[0],
      navigationId: "next",
      start: 2000,
      end: 3000,
    });
    const engine = new NavigationEngine(journey);
    const completion = new NavigationCompletion();
    expect(move(completion, engine, 320)).toBe(true);
    completion.reset();
    expect(completion.update(engine)).toBe(false);
    expect(move(completion, engine, 320, now + 1000)).toBe(true);
    expect(
      completion.update(
        new NavigationEngine(structuredClone(journey), engine.progress),
      ),
    ).toBe(false);
    expect(move(completion, engine, 320, now + 2000)).toBe(true);
    engine.advance(true);
    expect(completion.update(engine)).toBe(false);
    expect(move(completion, engine, 320, now + 3000)).toBe(true);
    engine.advance(true);
    expect(completion.update(engine)).toBe(false);
  });

  it.each(["transit", "fold", "unfold", "wait", "stop"] as const)(
    "keeps the %s action available without GPS",
    (kind) =>
      expect(
        new NavigationCompletion().update(new NavigationEngine(route(kind))),
      ).toBe(true),
  );
});
