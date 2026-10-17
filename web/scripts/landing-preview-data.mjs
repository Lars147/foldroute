import assert from "node:assert/strict";

export function comparisonURL(recording) {
  const { request, settings } = recording;
  const point = (place) =>
    `${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}`;
  const url = new URL("https://api.transitous.org/api/v6/plan");
  url.search = new URLSearchParams({
    fromPlace: point(request.origin),
    toPlace: point(request.destination),
    time: new Date(request.time * 1000).toISOString().replace(".000Z", "Z"),
    arriveBy: "false",
    cyclingSpeed: (settings.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
    detailedLegs: "true",
    realtimeMode: "REALTIME",
    language: "de",
    transitModes: "",
    directModes: "BIKE",
    maxDirectTime: "21600",
  }).toString();
  return url;
}

export function validateComparisonFixture(recording, fixture) {
  assert.equal(
    fixture.source,
    comparisonURL(recording).href,
    "Comparison must use the recorded route and routing settings",
  );
  assert(
    Number.isFinite(Date.parse(fixture.capturedAt)),
    "Comparison needs its recording date",
  );
  assert.deepEqual(
    fixture.request,
    recording.request,
    "Comparison request differs from the selected journey",
  );
  assert.deepEqual(
    fixture.settings,
    recording.settings,
    "Comparison settings differ from the selected journey",
  );
  assert.equal(
    fixture.response.direct?.length,
    1,
    "Exactly one direct cycling route is required",
  );
  const direct = fixture.response.direct[0];
  const start = Date.parse(direct.startTime) / 1000;
  const end = Date.parse(direct.endTime) / 1000;
  assert.equal(
    start,
    recording.journey.departure,
    "Both options must depart at the same time",
  );
  assert(
    end > recording.journey.arrival,
    "Selected journey must arrive before the cycling comparison",
  );
  // Routing responses can pair minute-rounded timestamps with second-precision durations.
  if (direct.duration !== undefined)
    assert(
      Number.isFinite(direct.duration) &&
        Math.abs(direct.duration - (end - start)) < 60,
      "Comparison duration must match its arrival and departure to the displayed minute",
    );
  assert(direct.legs?.length > 0, "Comparison has no legs");
  for (const [index, leg] of direct.legs.entries()) {
    assert.equal(leg.mode, "BIKE", "Comparison must be a pure cycling route");
    assert(!leg.cancelled, "Comparison must be available");
    assert(
      Number.isFinite(leg.distance) && leg.distance > 0,
      "Comparison needs an actual cycling distance",
    );
    assert(
      leg.legGeometry?.points?.length > 0,
      "Comparison needs recorded street geometry",
    );
    const legStart = Date.parse(leg.startTime) / 1000;
    const legEnd = Date.parse(leg.endTime) / 1000;
    assert(legEnd > legStart, "Comparison leg has invalid times");
    assert.equal(
      legStart,
      index ? Date.parse(direct.legs[index - 1].endTime) / 1000 : start,
      "Comparison legs must form a continuous journey",
    );
  }
  assert.equal(
    Date.parse(direct.legs.at(-1).endTime) / 1000,
    end,
    "Comparison must end at its stated arrival",
  );
  for (const [raw, place] of [
    [direct.legs[0].from, recording.request.origin],
    [direct.legs.at(-1).to, recording.request.destination],
  ]) {
    assert(
      Math.abs(raw.lat - place.latitude) < 0.001 &&
        Math.abs(raw.lon - place.longitude) < 0.001,
      "Comparison endpoints differ from the selected journey",
    );
  }
}

export function previewPlannerModule(recording, fixture) {
  validateComparisonFixture(recording, fixture);
  return `
    import { mapResponse } from "/src/transitous.ts";
    const recording = ${JSON.stringify(recording)};
    const comparison = mapResponse(${JSON.stringify(fixture.response)}, recording.request, recording.settings,
      { direct: true, pre: "BIKE", post: "BIKE" });
    if (comparison.rejected || comparison.issues.length || comparison.journeys.length !== 1)
      throw new Error("The recorded cycling comparison has invalid street geometry");
    const journeys = [recording.journey, ...comparison.journeys];
    if (journeys.some(journey => journey.departure !== recording.journey.departure || journey.arrival < recording.journey.arrival))
      throw new Error("The selected preview journey must arrive first");
    export async function* planRoutes(request, settings, signal) {
      signal.throwIfAborted();
      if (request.time !== recording.request.time ||
          ["origin", "destination"].some(key =>
            request[key].latitude !== recording.request[key].latitude ||
            request[key].longitude !== recording.request[key].longitude) ||
          Object.entries(recording.settings).some(([key, value]) => JSON.stringify(settings[key]) !== JSON.stringify(value)))
        throw new Error("Screenshot planning must use the recorded context");
      yield { journeys: structuredClone(journeys), status: "complete", issues: [] };
    }
  `;
}
