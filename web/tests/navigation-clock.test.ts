import { describe, expect, it, vi } from "vitest";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import { NavigationSession } from "../src/navigation-session";
import { ApiClient } from "../src/transitous";
import type { Clock } from "../src/clock";
import type { Journey } from "../src/model";

const a = { name: "A", detail: "", latitude: 48, longitude: 11 };
const b = { name: "B", detail: "", latitude: 48, longitude: 11.001 };
function clockAt(milliseconds = 1_000_000) {
  let now = milliseconds;
  const clock: Clock = { now: () => now };
  return {
    clock,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
function route(withPreparation = false): Journey {
  const bike = {
    kind: "bike" as const,
    from: a,
    to: b,
    start: 1120,
    end: 1240,
    distance: 100,
    coordinates: [a, b],
  };
  return navigationJourney({
    id: "clock",
    origin: a,
    destination: b,
    departure: withPreparation ? 1000 : bike.start,
    arrival: bike.end,
    transfers: 0,
    isDirect: true,
    legs: withPreparation
      ? [
          {
            kind: "fold",
            from: a,
            to: a,
            start: 1000,
            end: 1120,
            distance: 0,
            coordinates: [a],
          },
          bike,
        ]
      : [bike],
  });
}

describe("navigation clock port without global Date replacement", () => {
  it("uses injected time for remaining duration, pause accounting and timer progress", () => {
    const { clock, advance } = clockAt();
    expect(Math.abs(Date.now() - clock.now())).toBeGreaterThan(60_000);
    const engine = new NavigationEngine(route(true), undefined, clock);
    expect(engine.remainingSeconds).toBe(120);
    advance(30_000);
    expect(engine.remainingSeconds).toBe(90);
    engine.setCompletionPaused(true);
    advance(150_000);
    engine.tick();
    expect(engine.progress.legIndex).toBe(0);
    expect(engine.remainingSeconds).toBe(90);
    engine.setCompletionPaused(false);
    advance(89_000);
    engine.tick();
    expect(engine.remainingSeconds).toBe(1);
    expect(engine.progress.legIndex).toBe(0);
    advance(1000);
    engine.tick();
    expect(engine.progress.legIndex).toBe(1);
    engine.tick();
    expect(engine.progress.legIndex).toBe(1);
  });

  it("matches GPS using injected freshness instead of the host clock", () => {
    const { clock, advance } = clockAt(1_120_000);
    const engine = new NavigationEngine(route(), undefined, clock);
    const fix = { ...a, accuracy: 10, timestamp: clock.now() };
    engine.update(fix);
    expect(engine.guidanceUsable).toBe(true);
    advance(60_001);
    engine.update(fix);
    expect(engine.guidanceUsable).toBe(false);
    engine.update({ ...fix, timestamp: clock.now() });
    expect(engine.guidanceUsable).toBe(true);
  });

  it("keeps session freshness and foreground barriers on the injected millisecond clock", () => {
    const { clock, advance } = clockAt();
    const session = new NavigationSession({
      clock,
      api: new ApiClient(),
      changed: vi.fn(),
      locate: async () => {
        throw new Error("This freshness test must not request GPS");
      },
      resumeEnabled: () => false,
      statisticsEnabled: () => false,
    });
    const fix = { ...a, accuracy: 10, timestamp: clock.now() };
    session.updateLocation(fix, "current");
    expect(session.locationQuality).toBe("current");
    expect(session.hasCurrentLocation).toBe(true);
    advance(60_001);
    expect(session.locationQuality).toBe("stale");
    expect(session.hasCurrentLocation).toBe(false);
    const beforeBackground = { ...fix, timestamp: clock.now() };
    session.updateLocation(beforeBackground, "current");
    expect(session.hasCurrentLocation).toBe(true);
    advance(1);
    session.setForeground(false);
    session.setForeground(true);
    session.updateLocation(beforeBackground, "current");
    expect(session.hasCurrentLocation).toBe(false);
    session.updateLocation({ ...fix, timestamp: clock.now() }, "current");
    expect(session.hasCurrentLocation).toBe(true);
    session.updateLocation({ ...fix, timestamp: Date.now() }, "current");
    expect(session.hasCurrentLocation).toBe(false);
  });
});
