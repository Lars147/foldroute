import { expect, it } from "vitest";
import { exampleRecording } from "../src/example-data";
import {
  distance,
  validCoordinate,
  validateStreetGeometry,
} from "../src/geometry";
import { journeyEffort } from "../src/model";
import { validSnapshot } from "../src/offline";

it("keeps a complete recorded S8–bike–U6 journey with valid street geometry", () => {
  const { journey, request, settings, capturedAt } = exampleRecording;
  expect(
    validSnapshot({
      version: 3,
      savedAt: Date.parse(capturedAt) / 1000,
      journey,
      request,
      settings,
    }),
  ).toBe(true);
  expect(journey.arrival - journey.departure).toBe(57 * 60);
  expect(journeyEffort(journey)).toEqual({
    cyclingSeconds: 19 * 60,
    walkingSeconds: 60,
    transfers: 1,
  });
  const transferIndex = journey.legs.findIndex(
    (leg) =>
      leg.kind === "bike" &&
      leg.from.name === "Unterföhring" &&
      leg.to.name === "Freimann",
  );
  const transfer = journey.legs[transferIndex];
  expect(transfer.distance).toBe(3817);
  expect(transfer.end - transfer.start).toBe(17 * 60);
  expect(
    journey.legs
      .slice(0, transferIndex)
      .some((leg) => leg.kind === "transit" && leg.line === "S8"),
  ).toBe(true);
  expect(
    journey.legs
      .slice(transferIndex + 1)
      .some((leg) => leg.kind === "transit" && leg.line === "U6"),
  ).toBe(true);
  for (const [index, leg] of journey.legs.entries()) {
    expect(leg.coordinates.every(validCoordinate)).toBe(true);
    expect(leg.end).toBeGreaterThanOrEqual(leg.start);
    if (index) {
      expect(leg.start).toBeGreaterThanOrEqual(journey.legs[index - 1].end);
      expect(distance(journey.legs[index - 1].to, leg.from)).toBeLessThan(100);
    }
    if (leg.kind === "bike" || leg.kind === "walk") {
      expect(() =>
        validateStreetGeometry(
          leg.coordinates,
          leg.maneuvers ?? [],
          leg.from,
          leg.to,
          leg.kind === "walk",
          leg.distance,
        ),
      ).not.toThrow();
    }
    expect(leg.transitReference).toBeUndefined();
    expect(leg.tripId).toBeUndefined();
  }
});
