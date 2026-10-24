import { expect, it } from "vitest";
import {
  defaults,
  type Journey,
  type TransitCancellationReason,
  validNavigationLegData,
} from "../src/model";
import { assessConnection } from "../src/connection-assessment";
import { applyTransit, matchTrip } from "../src/transit-refresh";
import { mapResponse } from "../src/transitous";

const now = Date.parse("2026-10-21T08:00:00Z") / 1000;
const iso = (time: number) => new Date(time * 1000).toISOString();
const origin = {
  name: "Ostbahnhof",
  detail: "",
  stopId: "A",
  latitude: 48.1278,
  longitude: 11.6047,
};
const destination = {
  name: "Pasing",
  detail: "",
  stopId: "B",
  latitude: 48.1498,
  longitude: 11.4619,
};
const reference = {
  tripId: "S8-trip",
  fromId: "A",
  toId: "B",
  scheduledDeparture: now + 300,
  scheduledArrival: now + 900,
};
const journey = (): Journey => ({
  id: "S8-journey",
  origin,
  destination,
  departure: reference.scheduledDeparture,
  arrival: reference.scheduledArrival,
  isDirect: false,
  transfers: 0,
  legs: [
    {
      navigationId: "S8-leg",
      kind: "transit",
      line: "S8",
      from: origin,
      to: destination,
      start: reference.scheduledDeparture,
      end: reference.scheduledArrival,
      distance: 0,
      coordinates: [origin, destination],
      transitReference: reference,
      transitStatus: { updatedAt: now },
    },
  ],
});
const trip = (cancelled = false, boarding = false, alighting = false) => ({
  legs: [
    {
      cancelled,
      realTime: true,
      from: {
        ...origin,
        lat: origin.latitude,
        lon: origin.longitude,
        scheduledDeparture: iso(reference.scheduledDeparture),
        cancelled: boarding,
      },
      to: {
        ...destination,
        lat: destination.latitude,
        lon: destination.longitude,
        scheduledArrival: iso(reference.scheduledArrival),
        cancelled: alighting,
      },
    },
  ],
});

it.each<[boolean, boolean, boolean, TransitCancellationReason, string]>([
  [true, false, false, "trip", "S8: Fahrt fällt aus."],
  [true, true, true, "trip", "S8: Fahrt fällt aus."],
  [false, true, false, "boarding", "S8: Halt in Ostbahnhof entfällt."],
  [false, false, true, "alighting", "S8: Halt in Pasing entfällt."],
  [
    false,
    true,
    true,
    "both-stops",
    "S8: Halte in Ostbahnhof und Pasing entfallen.",
  ],
])(
  "retains cancellation cause from trip data (%s, %s, %s)",
  (full, from, to, reason, message) => {
    // Even responses without intermediateStops must retain which endpoint failed.
    const result = matchTrip(trip(full, from, to), reference, now);
    const updated = applyTransit(journey(), 0, new Map([["S8-leg", result]]));
    expect(updated.legs[0].transitStops).toBeUndefined();
    expect(updated.legs[0].transitStatus).toMatchObject({
      cancelled: true,
      cancellationReason: reason,
    });
    expect(assessConnection(updated, 0, now)).toMatchObject({
      status: "cancelled",
      message,
    });
    expect(validNavigationLegData(updated.legs[0])).toBe(true);
  },
);

it("keeps cancellation details through a failed refresh and clears them after recovery", () => {
  const cancelled = applyTransit(
    journey(),
    0,
    new Map([["S8-leg", matchTrip(trip(false, false, true), reference, now)]]),
  );
  const failed = applyTransit(
    cancelled,
    0,
    new Map([["S8-leg", { kind: "failed" }]]),
  );
  expect(assessConnection(failed, 0, now).message).toBe(
    "S8: Halt in Pasing entfällt.",
  );
  const recovered = applyTransit(
    failed,
    0,
    new Map([["S8-leg", matchTrip(trip(), reference, now + 60)]]),
  );
  expect(recovered.legs[0].transitStatus?.cancelled).toBe(false);
  expect(recovered.legs[0].transitStatus?.cancellationReason).toBeUndefined();
  expect(assessConnection(recovered, 0, now + 60).status).toBe("ready");
});

it("does not block a connection when only an intermediate stop is cancelled", () => {
  const response = {
    legs: [
      {
        ...trip().legs[0],
        intermediateStops: [
          {
            name: "Laim",
            stopId: "intermediate",
            lat: 48.1445,
            lon: 11.5028,
            cancelled: true,
          },
        ],
      },
    ],
  };
  const updated = applyTransit(
    journey(),
    0,
    new Map([["S8-leg", matchTrip(response, reference, now)]]),
  );
  expect(updated.legs[0].transitStops?.[1].cancelled).toBe(true);
  expect(assessConnection(updated, 0, now).status).toBe("ready");
});

it.each(["boarding", "alighting", "both-stops"] as const)(
  "retains %s cancellations from planning responses without station lists",
  (reason) => {
    const raw = trip(false, reason !== "alighting", reason !== "boarding")
      .legs[0];
    const mapped = mapResponse(
      {
        itineraries: [
          {
            id: "planned",
            transfers: 0,
            legs: [
              {
                ...raw,
                mode: "SUBURBAN",
                routeShortName: "S8",
                startTime: iso(reference.scheduledDeparture),
                endTime: iso(reference.scheduledArrival),
              },
            ],
          },
        ],
      },
      { origin, destination, timing: "now", time: now },
      defaults,
      { pre: "WALK", post: "WALK", street: false, direct: false },
    ).journeys[0];
    expect(
      mapped.legs.find((leg) => leg.kind === "transit")?.transitStatus,
    ).toMatchObject({
      cancelled: true,
      cancellationReason: reason,
    });
  },
);

it("keeps legacy cancellation records usable without inventing a cause", () => {
  const saved = journey();
  saved.legs[0].transitStatus = { cancelled: true, updatedAt: now };
  expect(validNavigationLegData(saved.legs[0])).toBe(true);
  expect(assessConnection(saved, 0, now).message).toBe(
    "S8: Verbindung nicht nutzbar.",
  );
  expect(
    validNavigationLegData({
      ...saved.legs[0],
      transitStatus: { cancelled: true, cancellationReason: "invalid" },
    } as any),
  ).toBe(false);
});
