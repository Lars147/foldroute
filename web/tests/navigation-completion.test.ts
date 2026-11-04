import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    distance: new NavigationPath(coordinates).offsets.at(-1)!,
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
    engine.update(fix(301), now);
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
        streetName: "",
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

it("does not unlock a restored section from a GPS jump rejected by the engine", () => {
  const journey = route();
  const engine = new NavigationEngine(journey, {
    legIndex: 0,
    maneuverIndex: 0,
    meters: 350,
    confirmedStops: [],
  });
  const completion = new NavigationCompletion();
  expect(move(completion, engine, 0)).toBe(false);
  expect(move(completion, engine, 320, now + 1000)).toBe(false);
  expect(engine.guidanceUsable).toBe(false);
  expect(move(completion, engine, 320, now + 21000)).toBe(true);
});

describe("automatic section completion countdown", () => {
  const sample = (
    engine: NavigationEngine,
    meters = 391,
    elapsed = 0,
    accuracy = 10,
  ) => engine.update(fix(meters, now + elapsed, accuracy), now + elapsed);

  it.each(["bike", "walk"] as const)(
    "waits 30 seconds within 10 m before completing %s",
    (kind) => {
      const engine = new NavigationEngine(route(kind));
      sample(engine, 389);
      expect(engine.completionCountdown).toBeUndefined();
      sample(engine, 391, 1000);
      expect(engine.completionCountdown?.remainingSeconds).toBe(30);
      expect(engine.remainingSeconds).toBe(30);
      engine.tick((now + 30999) / 1000);
      expect(engine.phase).toBe("active");
      expect(engine.remainingSeconds).toBeCloseTo(0.001);
      engine.tick((now + 31000) / 1000);
      expect(engine.phase).toBe("arrived");
      expect(engine.completionCountdown).toBeUndefined();
    },
  );

  it("starts the next activity at the end of the countdown and does not skip it", () => {
    const journey = route();
    journey.legs.push({
      ...journey.legs[0],
      kind: "fold",
      navigationId: "fold",
      start: 1001,
      end: 1121,
    });
    const engine = new NavigationEngine(journey);
    sample(engine);
    engine.tick(now / 1000 + 30);
    expect(engine.progress.legIndex).toBe(1);
    expect(engine.leg.start).toBe(now / 1000 + 30);
    expect(engine.leg.end - engine.leg.start).toBe(120);
    expect(engine.completionCountdown).toBeUndefined();
  });

  it("cancels when GPS is lost or unreliable and requires a new full countdown", () => {
    const engine = new NavigationEngine(route());
    sample(engine);
    engine.tick(now / 1000 + 20);
    engine.invalidateLocation();
    engine.tick(now / 1000 + 50);
    expect(engine.phase).toBe("active");
    expect(engine.completionCountdown).toBeUndefined();
    sample(engine, 391, 51000, 51);
    expect(engine.completionCountdown).toBeUndefined();
    sample(engine, 391, 52000);
    expect(engine.completionCountdown?.remainingSeconds).toBe(30);
    engine.tick(now / 1000 + 81);
    expect(engine.phase).toBe("active");
    engine.tick(now / 1000 + 82);
    expect(engine.phase).toBe("arrived");
  });

  it("does not finish from a stale position or a rejected GPS jump", () => {
    const engine = new NavigationEngine(route());
    sample(engine, 0);
    sample(engine, 391, 1000);
    expect(engine.completionCountdown).toBeUndefined();
    sample(engine, 391, 21000);
    expect(engine.completionCountdown).toBeDefined();
    engine.tick(now / 1000 + 82);
    expect(engine.phase).toBe("active");
    expect(engine.completionCountdown).toBeUndefined();
  });

  it("tolerates small GPS drift but resets beyond 20 m", () => {
    const engine = new NavigationEngine(route());
    sample(engine);
    sample(engine, 385, 5000);
    expect(engine.completionCountdown?.remainingSeconds).toBe(25);
    sample(engine, 379, 6000);
    expect(engine.completionCountdown).toBeUndefined();
    sample(engine, 391, 7000);
    expect(engine.completionCountdown?.remainingSeconds).toBe(30);
  });

  it("keeps cancellation until reliably leaving the target area", () => {
    const engine = new NavigationEngine(route());
    sample(engine);
    engine.cancelCompletionCountdown();
    sample(engine, 391, 1000);
    engine.invalidateLocation();
    sample(engine, 391, 2000);
    engine.tick(now / 1000 + 32);
    expect(engine.phase).toBe("active");
    expect(engine.completionCountdown).toBeUndefined();
    sample(engine, 375, 33000);
    sample(engine, 391, 34000);
    expect(engine.completionCountdown?.remainingSeconds).toBe(30);
  });

  it("preserves the countdown across timetable updates and clears it for a changed path or engine", () => {
    const engine = new NavigationEngine(route());
    sample(engine);
    const timetable = structuredClone(engine.journey);
    timetable.legs[0].end += 60;
    engine.applyJourney(timetable);
    engine.tick(now / 1000 + 10);
    expect(engine.completionCountdown?.remainingSeconds).toBe(20);
    expect(
      new NavigationEngine(engine.journey, engine.progress).completionCountdown,
    ).toBeUndefined();
    const changed = structuredClone(engine.journey);
    changed.legs[0].coordinates = [point(0), point(800), point(400)];
    engine.applyJourney(changed);
    expect(engine.completionCountdown).toBeUndefined();
  });

  it("does not bypass route loops, degenerate paths, open turns or transit boarding safeguards", () => {
    const loop = new NavigationEngine(
      route("bike", [point(0), point(400), point(0)]),
    );
    sample(loop, 0);
    expect(loop.completionCountdown).toBeUndefined();
    const empty = new NavigationEngine(route("walk", [point(0), point(0)]));
    sample(empty, 0);
    expect(empty.completionCountdown).toBeUndefined();
    const turning = route("walk", [
      point(0),
      point(400),
      { ...point(400), longitude: 11.00005 },
    ]);
    turning.legs[0].maneuvers = [
      {
        direction: "DEPART",
        streetName: "",
        distance: 400,
        coordinates: [point(0), point(400)],
      },
      {
        direction: "RIGHT",
        streetName: "",
        distance: 4,
        coordinates: [point(400), turning.legs[0].to],
      },
    ];
    const turn = new NavigationEngine(turning);
    sample(turn, 395);
    expect(turn.completionCountdown).toBeUndefined();
    const journey = route();
    journey.legs.push({
      ...journey.legs[0],
      kind: "transit",
      navigationId: "train",
      start: now / 1000 + 600,
      end: now / 1000 + 900,
    });
    const engine = new NavigationEngine(journey);
    sample(engine);
    engine.tick(now / 1000 + 30);
    expect(engine.progress.legIndex).toBe(0);
    expect(engine.completionCountdown).toBeUndefined();
    expect(engine.advance(true)).toBe(true);
  });
});

describe("completion countdown pauses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it.each(["bike", "walk"] as const)(
    "holds the real %s deadline and resumes with remaining time",
    (kind) => {
      const engine = new NavigationEngine(route(kind));
      engine.update(fix(391), now);
      engine.setCompletionPaused(true, now + 5000);
      expect(engine.completionCountdown?.remainingSeconds).toBe(25);
      engine.tick(now / 1000 + 45);
      expect(engine.phase).toBe("active");
      expect(engine.completionCountdown?.remainingSeconds).toBe(25);
      engine.update(fix(391, now + 46000), now + 46000);
      engine.setCompletionPaused(false, now + 47000);
      engine.tick(now / 1000 + 71);
      expect(engine.phase).toBe("active");
      expect(engine.completionCountdown?.remainingSeconds).toBe(1);
      engine.tick(now / 1000 + 72);
      expect(engine.phase).toBe("arrived");
    },
  );

  it.each(["fold", "unfold", "wait"] as const)(
    "holds %s time and its connection forecast while paused",
    (kind) => {
      const journey = route(kind);
      journey.legs[0].end = now / 1000 + 30;
      journey.legs.push({ ...route().legs[0], navigationId: "next" });
      const engine = new NavigationEngine(journey);
      vi.setSystemTime(now + 10000);
      engine.setCompletionPaused(true);
      expect(engine.remainingSeconds).toBe(20);
      vi.setSystemTime(now + 70000);
      engine.tick();
      expect(engine.progress.legIndex).toBe(0);
      expect(engine.remainingSeconds).toBe(20);
      expect(engine.connectionJourney.legs[0].end).toBe(now / 1000 + 90);
      expect(engine.leg.end).toBe(now / 1000 + 30);
      engine.setCompletionPaused(false);
      engine.tick(now / 1000 + 89);
      expect(engine.progress.legIndex).toBe(0);
      engine.tick(now / 1000 + 90);
      expect(engine.progress.legIndex).toBe(1);
      expect(engine.completionPaused).toBe(false);
    },
  );

  it("keeps cancellation, GPS loss and path changes effective during a pause", () => {
    const engine = new NavigationEngine(route());
    engine.update(fix(391), now);
    engine.setCompletionPaused(true, now + 1000);
    engine.invalidateLocation();
    expect(engine.completionCountdown).toBeUndefined();
    engine.update(fix(391, now + 10000), now + 10000);
    expect(engine.completionCountdown?.remainingSeconds).toBe(30);
    engine.cancelCompletionCountdown();
    engine.setCompletionPaused(false, now + 40000);
    engine.update(fix(391, now + 41000), now + 41000);
    expect(engine.completionCountdown).toBeUndefined();
    const changed = structuredClone(engine.journey);
    changed.legs[0].coordinates = [point(0), point(800), point(400)];
    engine.setCompletionPaused(true, now + 42000);
    engine.applyJourney(changed);
    expect(engine.completionPaused).toBe(false);
    expect(engine.completionCountdown).toBeUndefined();
  });

  it("does not automatically board a train missed during a pause", () => {
    const journey = route("fold");
    journey.legs[0].end = now / 1000 + 30;
    journey.legs.push({
      ...route("transit").legs[0],
      navigationId: "train",
      start: now / 1000 + 40,
      end: now / 1000 + 900,
      transitStatus: { updatedAt: now / 1000 + 70 },
    });
    const engine = new NavigationEngine(journey);
    engine.setCompletionPaused(true, now + 10000);
    expect(engine.advance(false, now / 1000 + 20)).toBe(false);
    engine.setCompletionPaused(false, now + 70000);
    engine.tick(now / 1000 + 90);
    expect(engine.progress.legIndex).toBe(0);
    expect(engine.advance(true, now / 1000 + 90)).toBe(true);
  });
});
