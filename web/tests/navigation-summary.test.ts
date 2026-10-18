import { expect, it } from "vitest";
import {
  emptyNavigationStatistics,
  navigatedRouteMeters,
  routeLegMeters,
  recordNavigation,
  validNavigationStatistics,
  validNavigationTrip,
  type TripSummary,
} from "../src/navigation-summary";
import type { Journey } from "../src/model";
import { distance } from "../src/geometry";

const summary: TripSummary = {
  id: "trip-1",
  originName: "Start",
  destinationName: "Ziel",
  arrivedAt: 1000,
  elapsedSeconds: 600,
  distanceMeters: 4200,
  sinceResume: false,
  storageEpoch: 0,
};

it("counts repeated trips on the same route separately but each session only once", () => {
  const once = recordNavigation(emptyNavigationStatistics(), summary);
  expect(recordNavigation(once, summary)).toBe(once);
  expect(recordNavigation(once, { ...summary, id: "trip-2" })).toEqual({
    version: 1,
    completedIds: ["trip-1", "trip-2"],
    distanceMeters: 8400,
    elapsedSeconds: 1200,
  });
});

it("rejects damaged counters and trip metadata", () => {
  expect(validNavigationStatistics(emptyNavigationStatistics())).toBe(true);
  expect(
    validNavigationStatistics({
      ...emptyNavigationStatistics(),
      completedIds: ["a", "a"],
    }),
  ).toBe(false);
  expect(
    validNavigationStatistics({
      ...emptyNavigationStatistics(),
      elapsedSeconds: Infinity,
    }),
  ).toBe(false);
  expect(() =>
    recordNavigation(emptyNavigationStatistics(), {
      ...summary,
      distanceMeters: -1,
    }),
  ).toThrow();
  const trip = {
    id: "a",
    startedAt: 100,
    originName: "Start",
    distanceMeters: 0,
    routeMeters: 0,
    sinceResume: false,
    storageEpoch: 0,
  };
  expect(validNavigationTrip(trip)).toBe(true);
  expect(validNavigationTrip({ ...trip, startedAt: NaN })).toBe(false);
  expect(validNavigationTrip({ ...trip, storageEpoch: -1 })).toBe(false);
});

it("credits completed mode distances, including transit, without counting beyond the final leg", () => {
  const a = { name: "A", detail: "", latitude: 48, longitude: 11 };
  const b = { ...a, name: "B", longitude: 11.01 };
  const legs = ["bike", "transit", "walk"].map((kind, i) => ({
    kind,
    from: a,
    to: b,
    coordinates: [a, b],
    distance: [500, 5000, 100][i],
    start: 0,
    end: 60,
  }));
  const journey = { legs } as Journey;
  const progress = {
    legIndex: 2,
    maneuverIndex: 0,
    meters: 100000,
    confirmedStops: [],
  };
  expect(navigatedRouteMeters(journey, progress)).toBe(5600);
  expect(navigatedRouteMeters(journey, { ...progress, meters: 0 }, true)).toBe(
    5600,
  );
  journey.legs[1].distance = 0;
  expect(routeLegMeters(journey.legs[1])).toBeCloseTo(distance(a, b));
  expect(
    navigatedRouteMeters(journey, { ...progress, meters: 0 }, true),
  ).toBeCloseTo(600 + distance(a, b));
});
