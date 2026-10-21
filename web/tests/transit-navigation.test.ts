import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationEngine, navigationJourney } from "../src/navigation-engine";
import { transitStopKey } from "../src/transit-stops";
import type { Journey, Leg, TransitStop } from "../src/model";
import { NavigationSession } from "../src/navigation-session";
import { ApiClient } from "../src/transitous";
import type {
  TransitRefresher,
  TransitRefreshOptions,
  TransitResult,
} from "../src/transit-refresh";

const end = 1000000;
const stops: TransitStop[] = [0, 1, 2].map((i) => ({
  name: `Stop ${i}`,
  stopId: `stop-${i}`,
  detail: "",
  latitude: 48,
  longitude: 11 + i * 0.01,
  scheduledArrival: end - 200 + i * 100,
}));
function engine() {
  const leg: Leg = {
    kind: "transit",
    from: stops[0],
    to: stops[2],
    start: end - 200,
    end,
    distance: 1500,
    coordinates: stops,
    transitStops: structuredClone(stops),
    transitStatus: { updatedAt: end },
  };
  return new NavigationEngine(
    navigationJourney({
      id: "trip",
      origin: leg.from,
      destination: leg.to,
      departure: leg.start,
      arrival: end,
      transfers: 0,
      isDirect: false,
      legs: [leg],
    } as Journey),
  );
}
function point(e: NavigationEngine, index: number, seconds: number) {
  e.update(
    { ...stops[index], accuracy: 10, timestamp: seconds * 1000 },
    seconds * 1000,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(end * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("confirmed train exit", () => {
  it("requires two current destination fixes, end time and fresh trip data", () => {
    const e = engine();
    e.tick(end);
    expect(e.phase).toBe("active");
    point(e, 2, end - 1);
    e.tick(end);
    expect(e.phase).toBe("active");
    point(e, 2, end);
    expect(e.transitExitConfirmed).toBe(true);
    e.tick(end - 1);
    expect(e.phase).toBe("active");
    e.leg.transitStatus = { updatedAt: end - 121 };
    e.tick(end);
    expect(e.phase).toBe("active");
    e.leg.transitStatus = { updatedAt: end };
    e.tick(end);
    expect(e.phase).toBe("arrived");
  });
  it("does not reuse an old confirmation with fresh off-route GPS", () => {
    const e = engine();
    point(e, 2, end - 1);
    point(e, 2, end);
    e.update(
      { ...stops[2], latitude: 49, accuracy: 10, timestamp: (end + 1) * 1000 },
      (end + 1) * 1000,
    );
    e.tick(end + 1);
    expect(e.transitStopIndex).toBe(2);
    expect(e.phase).toBe("active");
  });
  it("requires both evidence points to remain fresh", () => {
    const e = engine();
    point(e, 2, end - 59);
    point(e, 2, end);
    vi.setSystemTime((end + 2) * 1000);
    e.tick(end + 2);
    expect(e.hasCurrentTransitPosition).toBe(false);
    expect(e.phase).toBe("active");
  });
  it("keeps missing or cancelled destination metadata manual", () => {
    for (const missing of [true, false]) {
      const e = engine();
      if (missing) e.leg.transitStops = undefined;
      else e.leg.transitStops!.at(-1)!.cancelled = true;
      point(e, 2, end - 1);
      point(e, 2, end);
      e.tick(end);
      expect(e.phase).toBe("active");
      e.advance(true, end);
      expect(e.phase).toBe("arrived");
    }
  });
});

describe("trip revisions", () => {
  it("does not use an endpoint-only line as evidence between stations", () => {
    const e = engine();
    const changed = structuredClone(e.journey);
    changed.legs[0].coordinates = [stops[0], stops[2]];
    e.applyJourney(changed);
    for (const seconds of [end - 1, end])
      e.update(
        {
          ...stops[0],
          longitude: (stops[0].longitude + stops[1].longitude) / 2,
          accuracy: 10,
          timestamp: seconds * 1000,
        },
        seconds * 1000,
      );
    expect(e.hasTransitLocation).toBe(false);
    expect(e.hasCurrentTransitPosition).toBe(false);
    expect(e.progress.meters).toBe(0);
    for (const seconds of [end + 1, end + 2]) point(e, 1, seconds);
    expect(e.hasCurrentTransitPosition).toBe(true);
    expect(e.transitStopIndex).toBe(1);
    expect(e.progress.meters).toBe(0);
  });
  it("preserves evidence and metres for prediction-only updates", () => {
    const e = engine();
    point(e, 1, end - 1);
    point(e, 1, end);
    const progress = structuredClone(e.progress);
    const updated = structuredClone(e.journey);
    updated.legs[0].transitStops![1].arrival = end - 80;
    updated.legs[0].end += 60;
    updated.legs[0].transitStatus = { updatedAt: end, cancelled: false };
    e.applyJourney(updated);
    expect(e.progress).toEqual(progress);
    expect(e.hasCurrentTransitPosition).toBe(true);
  });
  it("discards old route metres and GPS pairs while retaining a unique confirmed stop", () => {
    const e = engine();
    point(e, 1, end - 1);
    point(e, 1, end);
    expect(e.progress.meters).toBeGreaterThan(0);
    const updated = structuredClone(e.journey);
    updated.legs[0].coordinates = [
      stops[0],
      { latitude: 48.02, longitude: 11.01 },
      stops[2],
    ];
    e.applyJourney(updated);
    expect(e.transitStopIndex).toBe(1);
    expect(e.progress.meters).toBe(0);
    expect(e.hasCurrentTransitPosition).toBe(false);
    point(e, 1, end + 1);
    expect(e.hasCurrentTransitPosition).toBe(false);
  });
  it("does not remap ambiguous timeless repeated visits after an insertion", () => {
    const e = engine();
    const repeat = { ...stops[1], scheduledArrival: undefined };
    e.leg.transitStops = [stops[0], repeat, repeat, stops[2]];
    e.progress.transitStop = transitStopKey(e.leg.transitStops, 2);
    const updated = structuredClone(e.journey);
    updated.legs[0].transitStops!.splice(1, 0, { ...repeat });
    e.applyJourney(updated);
    expect(e.progress.transitStop).toBeUndefined();
    expect(e.transitStopIndex).toBe(0);
  });
});

it("applies streamed session updates immediately, allows another poll and ignores a replaced navigation", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const e = engine();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let later!: TransitRefreshOptions["onResult"];
  const result = (arrival: number): Map<string, TransitResult> =>
    new Map([
      [
        e.leg.navigationId!,
        {
          kind: "updated",
          update: {
            departure: e.leg.start,
            arrival,
            realtime: true,
            cancelled: false,
            updatedAt: end,
          },
        },
      ],
    ]);
  const refresh = vi.fn(
    async (_legs, _signal, _now, options: TransitRefreshOptions) => {
      if (refresh.mock.calls.length === 1) {
        options.onResult?.(result(end + 30));
        later = options.onResult;
        await waiting;
        return result(end + 90);
      }
      options.onResult?.(result(end + 60));
      return result(end + 60);
    },
  );
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: vi.fn(),
    storageEnabled: () => false,
    api: new ApiClient(),
    refresher: { refresh } as unknown as TransitRefresher,
  });
  session.engine = e;
  const pending = session.refresh();
  expect(e.leg.end).toBe(end + 30);
  await session.refresh("online");
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(e.leg.end).toBe(end + 60);
  expect(refresh.mock.calls[1][3].reason).toBe("online");
  const replacement = engine();
  session.engine = replacement;
  later?.(result(end + 90));
  release();
  await pending;
  expect(replacement.leg.end).toBe(end);
});
