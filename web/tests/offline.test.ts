import { describe, it, expect } from "vitest";
import { validSnapshot, type SavedJourney } from "../src/offline";
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
