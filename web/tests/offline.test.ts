import { describe, it, expect } from "vitest";
import {
  sameHistoryRoute,
  validSnapshot,
  readHistory,
  retainHistory,
  type HistoryEntry,
  type SavedJourney,
} from "../src/offline";
import { mapResponse, baseVariants } from "../src/transitous";
import { defaults, type RouteRequest } from "../src/model";
import fixture from "./fixtures/swift-parity.json";
const request: RouteRequest = {
  origin: { name: "Start", detail: "", latitude: 48.132, longitude: 11.5756 },
  destination: { name: "Ziel", detail: "", latitude: 48.175, longitude: 11.6 },
  timing: "depart",
  time: 1788508800,
};
const snapshot: SavedJourney = {
  version: 3,
  savedAt: 1788508800,
  request,
  settings: defaults,
  journey: mapResponse(fixture.direct, request, defaults, baseVariants[0])
    .journeys[0],
};
describe("offline snapshot validation", () => {
  it("accepts a complete journey with request context", () =>
    expect(validSnapshot(snapshot)).toBe(true));
  it("rejects unsupported versions and missing legs", () => {
    expect(validSnapshot({ ...snapshot, version: 2 })).toBe(false);
    expect(
      validSnapshot({
        ...snapshot,
        journey: { ...snapshot.journey, legs: [] },
      }),
    ).toBe(false);
  });
  it("rejects damaged geometry and timestamps", () => {
    const invalid = structuredClone(snapshot);
    invalid.journey.legs[0].coordinates[0].latitude = NaN;
    expect(validSnapshot(invalid)).toBe(false);
    expect(validSnapshot({ ...snapshot, savedAt: NaN })).toBe(false);
  });
  it("rejects incomplete place data or incompatible settings", () => {
    expect(
      validSnapshot({ ...snapshot, request: { ...request, origin: {} } }),
    ).toBe(false);
    expect(validSnapshot({ ...snapshot, settings: {} })).toBe(false);
  });
});

describe("journey history", () => {
  it("imports a legacy snapshot only when no history exists", () => {
    expect(readHistory(undefined, snapshot).entries).toEqual([
      { id: "legacy", snapshot },
    ]);
    expect(readHistory({ version: 1, entries: [] }, snapshot).entries).toEqual(
      [],
    );
  });
  it("keeps valid entries when another entry is corrupt", () => {
    const result = readHistory({
      version: 1,
      entries: [
        { id: "a", snapshot },
        { id: "broken", snapshot: {} },
        { id: "b", snapshot: routeSnapshot(1) },
        { id: "a", snapshot },
      ],
    });
    expect(result.invalid).toBe(true);
    expect(result.entries.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
  it("retains twenty distinct routes and moves updated routes to the top", () => {
    let entries: HistoryEntry[] = [];
    for (let i = 0; i < 21; i++)
      entries = retainHistory(entries, {
        id: String(i),
        snapshot: routeSnapshot(i),
      });
    expect(entries).toHaveLength(20);
    expect(entries[0].id).toBe("20");
    expect(entries.at(-1)?.id).toBe("1");
    const updated = {
      ...routeSnapshot(10),
      savedAt: snapshot.savedAt + 100,
      journey: { ...snapshot.journey, id: "alternative" },
    };
    entries = retainHistory(entries, { id: "10", snapshot: updated });
    expect(entries).toHaveLength(20);
    expect(entries[0].id).toBe("10");
    expect(
      entries.find((entry) => entry.id === "10")?.snapshot.journey.id,
    ).toBe("alternative");
  });
});

function routeSnapshot(index: number): SavedJourney {
  const result = structuredClone(snapshot);
  result.request.destination.longitude += index * 0.001;
  result.savedAt += index;
  return result;
}

describe("route identity", () => {
  it("ignores timing, stop IDs and stay durations, but preserves direction and stop order", () => {
    const a = {
      ...request,
      stops: [
        { id: "one", place: request.origin, stayMinutes: 0 },
        { id: "two", place: request.destination, stayMinutes: 5 },
      ],
    };
    const b = structuredClone(a);
    b.time++;
    b.stops[0].id = "new";
    b.stops[0].stayMinutes = 20;
    expect(sameHistoryRoute(a, b)).toBe(true);
    b.stops.reverse();
    expect(sameHistoryRoute(a, b)).toBe(false);
    expect(
      sameHistoryRoute(request, {
        ...request,
        origin: request.destination,
        destination: request.origin,
      }),
    ).toBe(false);
  });
  it("tolerates nearby GPS labels and case, but separates different named places or distant points", () => {
    const b = structuredClone(request);
    b.origin.name = "start";
    expect(sameHistoryRoute(request, b)).toBe(true);
    b.origin.name = "Another place";
    expect(sameHistoryRoute(request, b)).toBe(false);
    b.origin.name = "Aktueller Standort";
    b.origin.latitude += 0.0001;
    expect(sameHistoryRoute(request, b)).toBe(true);
    b.origin.latitude += 0.001;
    expect(sameHistoryRoute(request, b)).toBe(false);
  });
  it("silently normalizes old duplicate routes with the newest valid snapshot", () => {
    const newer = { ...snapshot, savedAt: snapshot.savedAt + 100 };
    const result = readHistory({
      version: 1,
      entries: [
        { id: "old", snapshot },
        { id: "different", snapshot: routeSnapshot(1) },
        { id: "new", snapshot: newer },
      ],
    });
    expect(result.invalid).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.entries.map((e) => e.id)).toEqual(["new", "different"]);
    expect(result.entries[0].snapshot).toEqual(newer);
    expect(readHistory({ version: 1, entries: result.entries }).changed).toBe(
      false,
    );
  });
  it("keeps a stable entry ID and rejects stale snapshots", () => {
    const entries = [{ id: "stable", snapshot }];
    const newer = { ...snapshot, savedAt: snapshot.savedAt + 1 };
    const updated = retainHistory(entries, {
      id: "recalculation",
      snapshot: newer,
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({
      id: "stable",
      calculationId: "recalculation",
      snapshot: newer,
    });
    expect(retainHistory(updated, { id: "late", snapshot })).toEqual(updated);
  });
});
