import { expect, it } from "vitest";
import parity from "./fixtures/swift-parity.json";
import comparisonRecording from "./fixtures/landing-preview-direct.json";
import { exampleRecording } from "../src/example-data";
import { makeURL, mapResponse } from "../src/transitous";
import { validSnapshot } from "../src/offline";
import {
  comparisonURL,
  validateComparisonFixture,
} from "../scripts/landing-preview-data.mjs";

// Synthetic selection timing isolates the comparison rule using an existing,
// geometrically valid routing fixture; these data never generate landing images.
function sample(selectedMinutes = 20) {
  const response = structuredClone(parity.direct);
  const raw = response.direct[0];
  const point = (place: { name: string; lat: number; lon: number }) => ({
    name: place.name,
    detail: "",
    latitude: place.lat,
    longitude: place.lon,
  });
  const time = Date.parse(raw.startTime) / 1000;
  const recording = {
    request: {
      origin: point(raw.legs[0].from),
      destination: point(raw.legs.at(-1)!.to),
      timing: "depart" as const,
      time,
    },
    settings: exampleRecording.settings,
    journey: { departure: time, arrival: time + selectedMinutes * 60 },
  };
  const fixture = {
    capturedAt: "2026-09-04T08:00:00Z",
    source: comparisonURL(recording).href,
    request: structuredClone(recording.request),
    settings: structuredClone(recording.settings),
    response,
  };
  return { recording, fixture };
}

it("requests the same cycling comparison as the production API client", () => {
  expect(comparisonURL(exampleRecording).href).toBe(
    makeURL(exampleRecording.request, exampleRecording.settings, {
      direct: true,
      pre: "BIKE",
      post: "BIKE",
    }).href,
  );
});

it("accepts a slower recorded cycling alternative with valid street geometry", () => {
  const { recording, fixture } = sample();
  expect(() => validateComparisonFixture(recording, fixture)).not.toThrow();
  const batch = mapResponse(
    fixture.response,
    recording.request,
    recording.settings,
    {
      direct: true,
      pre: "BIKE",
      post: "BIKE",
    },
  );
  expect(batch.rejected).toBe(false);
  expect(batch.journeys).toHaveLength(1);
  expect(batch.journeys[0].arrival).toBeGreaterThan(recording.journey.arrival);
});

it("keeps the real 57-minute airport connection ahead of its recorded 106-minute bike comparison", () => {
  expect(() =>
    validateComparisonFixture(exampleRecording, comparisonRecording),
  ).not.toThrow();
  const batch = mapResponse(
    comparisonRecording.response,
    exampleRecording.request,
    exampleRecording.settings,
    {
      direct: true,
      pre: "BIKE",
      post: "BIKE",
    },
  );
  expect(batch.rejected).toBe(false);
  expect(batch.issues).toEqual([]);
  expect(batch.journeys).toHaveLength(1);
  const comparison = batch.journeys[0];
  expect(comparison.departure).toBe(exampleRecording.journey.departure);
  expect(comparison.arrival - comparison.departure).toBe(106 * 60);
  expect(comparison.arrival - exampleRecording.journey.arrival).toBe(49 * 60);
  expect(comparison.legs.every((leg) => leg.kind === "bike")).toBe(true);
  expect(
    validSnapshot({
      version: 3,
      savedAt: Date.parse(comparisonRecording.capturedAt) / 1000,
      request: exampleRecording.request,
      settings: exampleRecording.settings,
      journey: comparison,
    }),
  ).toBe(true);
});

it("rejects the misleading 53-minute selection against a 32-minute bike route", () => {
  const { recording, fixture } = sample(53);
  expect(() => validateComparisonFixture(recording, fixture)).toThrow(
    "Selected journey must arrive before the cycling comparison",
  );
});

it("rejects comparisons made with different routing settings or endpoints", () => {
  const { recording, fixture } = sample();
  fixture.settings.cyclingSpeedKilometersPerHour = 25;
  expect(() => validateComparisonFixture(recording, fixture)).toThrow(
    "Comparison settings differ",
  );
  fixture.settings = structuredClone(recording.settings);
  fixture.response.direct[0].legs[0].from.lat += 1;
  expect(() => validateComparisonFixture(recording, fixture)).toThrow(
    "Comparison endpoints differ",
  );
});

it("rejects changed duration or missing street geometry", () => {
  const { recording, fixture } = sample();
  fixture.response.direct[0].duration += 60;
  expect(() => validateComparisonFixture(recording, fixture)).toThrow(
    "Comparison duration must match",
  );
  fixture.response.direct[0].duration -= 60;
  fixture.response.direct[0].legs[0].legGeometry.points = "";
  expect(() => validateComparisonFixture(recording, fixture)).toThrow(
    "Comparison needs recorded street geometry",
  );
});
