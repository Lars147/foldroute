import { expect, it } from "vitest";
import { ApiClient } from "../src/transitous";
import type { Coordinate } from "../src/model";

const city = { name: "München", unique: true, adminLevel: 6 };
const cafe = {
  name: "sweet spot kaffee",
  type: "PLACE",
  lat: 48.1357968,
  lon: 11.5776163,
  zip: "80331",
  country: "DE",
};

async function search(
  results: unknown[],
  query = "sweet spot München",
  center?: Coordinate,
) {
  const requests: URL[] = [];
  const client = new ApiClient(async (url) => {
    requests.push(new URL(String(url)));
    return new Response(JSON.stringify(results));
  });
  const places = await client.searchPlaces(
    query,
    new AbortController().signal,
    center,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].pathname).toBe("/api/v1/geocode");
  return places;
}

const center: Coordinate = { latitude: 52.525, longitude: 13.369 };
it.each([
  { query: "dag", center: undefined, bias: null },
  { query: "Paris", center: undefined, bias: null },
  { query: "da", center, bias: "2" },
  { query: "Dag", center, bias: "2" },
  { query: " dag ", center, bias: "2" },
  { query: "dagl", center, bias: "2" },
  { query: "Paris", center, bias: "2" },
  { query: "Berlin", center, bias: "2" },
])(
  "only sends a geographical bias when a search center is known: %j",
  async ({ query, center, bias }) => {
    const requests: URL[] = [];
    const client = new ApiClient(async (url) => {
      requests.push(new URL(String(url)));
      return new Response(JSON.stringify([cafe]));
    });
    await client.searchPlaces(query, new AbortController().signal, center);
    expect(requests).toHaveLength(1);
    const params = requests[0].searchParams;
    expect(params.get("text")).toBe(query);
    expect(params.get("language")).toBe("de");
    expect(params.get("numResults")).toBe("12");
    expect(params.get("place")).toBe(center ? "52.525,13.369" : null);
    expect(params.get("placeBias")).toBe(bias);
  },
);

const munich = { latitude: 48.12, longitude: 11.43 };
const daglfingStop = {
  name: "Daglfing",
  type: "STOP",
  id: "de-DELFI_de:09162:700_G",
  lat: 48.149624,
  lon: 11.64933,
  score: -13.15257453918457,
};
const daglung = {
  name: "Daglung",
  type: "PLACE",
  lat: 30.9542126,
  lon: 95.8612122,
  score: -12,
};
const daglfingDistrict = {
  name: "Daglfing",
  type: "PLACE",
  lat: 48.1493975,
  lon: 11.65692,
  score: -10.75,
};

it("keeps the nearby Daglfing stop and district before distant prefix matches", async () => {
  const results = await search(
    [daglfingStop, daglung, daglfingDistrict],
    "dagl",
    munich,
  );
  expect(results.map((place) => place.name)).toEqual([
    "Daglfing",
    "Daglfing",
    "Daglung",
  ]);
  expect(results[0].stopId).toBe(daglfingStop.id);
  expect(results[1].stopId).toBeUndefined();
  expect(results[1].longitude).toBe(daglfingDistrict.lon);
});

it("prefers nearby short-prefix matches without changing API order within each group", async () => {
  const dag = { name: "Dag", lat: 29.7, lon: 75.7 };
  const dagobert = { name: "Dagobert", lat: 48.134223, lon: 11.5587791 };
  const results = await search(
    [dag, daglfingStop, daglung, dagobert],
    "dag",
    munich,
  );
  expect(results.map((place) => place.name)).toEqual([
    "Daglfing",
    "Dagobert",
    "Dag",
    "Daglung",
  ]);
});

it("retains the API ranking for an explicit distant destination", async () => {
  const paris = { name: "Paris", lat: 48.8534951, lon: 2.3483915 };
  const nearbyShop = { name: "París", lat: 48.1390531, lon: 11.5584052 };
  const results = await search([paris, nearbyShop], "Paris", munich);
  expect(results.map((place) => place.name)).toEqual(["Paris", "París"]);
});

it("uses the selected region rather than a fixed country and leaves unanchored searches alone", async () => {
  const german = { name: "DAG", lat: 52.5, lon: 13.4 };
  const results = [german, daglung, daglfingStop];
  expect((await search(results, "dag")).map((place) => place.name)).toEqual([
    "DAG",
    "Daglung",
    "Daglfing",
  ]);
  expect(
    (
      await search(results, "dag", {
        latitude: daglung.lat,
        longitude: daglung.lon,
      })
    ).map((place) => place.name),
  ).toEqual(["Daglung", "DAG", "Daglfing"]);
});

it("distinguishes same-named places by district without changing their order or coordinates", async () => {
  const places = await search([
    {
      ...cafe,
      areas: [city, { name: "Altstadt-Lehel", adminLevel: 9, unique: false }],
    },
    {
      ...cafe,
      lat: 48.129031,
      lon: 11.5755194,
      zip: "80469",
      areas: [
        city,
        { name: "Ludwigsvorstadt-Isarvorstadt", adminLevel: 9, unique: false },
      ],
    },
  ]);
  expect(places.map((place) => place.detail)).toEqual([
    "80331, München, Altstadt-Lehel, DE",
    "80469, München, Ludwigsvorstadt-Isarvorstadt, DE",
  ]);
  expect(
    places.map(({ name, latitude, longitude }) => ({
      name,
      latitude,
      longitude,
    })),
  ).toEqual([
    { name: cafe.name, latitude: cafe.lat, longitude: cafe.lon },
    { name: cafe.name, latitude: 48.129031, longitude: 11.5755194 },
  ]);
});

it("uses the first named district and avoids duplicate area names", async () => {
  const [place] = await search([
    {
      ...cafe,
      areas: [
        { ...city, name: " München " },
        { ...city, name: "münchen" },
        { name: " Altstadt-Lehel ", adminLevel: 9, unique: true },
        { name: "Altstadt", adminLevel: 10, unique: false },
      ],
    },
  ]);
  expect(place.detail).toBe("80331, München, Altstadt-Lehel, DE");
});

it("skips empty or invalid metadata and can use a named neighbourhood at level 10", async () => {
  const [place] = await search([
    {
      ...cafe,
      areas: [
        null,
        {},
        city,
        { name: " ", adminLevel: 9 },
        { name: 42, adminLevel: 9, unique: true },
        { name: "Invalid", adminLevel: "9" },
        { name: "Altstadt", adminLevel: 10 },
      ],
    },
  ]);
  expect(place.detail).toBe("80331, München, Altstadt, DE");
});

it.each([undefined, null, {}, []])(
  "keeps the existing location details without district data: %j",
  async (areas) => {
    const [place] = await search([{ ...cafe, areas }]);
    expect(place.detail).toBe("80331, DE");
  },
);

it("preserves stop identifiers and existing details when no district is supplied", async () => {
  const [place] = await search([
    { ...cafe, name: "München Hbf", type: "STOP", id: "stop-1", areas: [city] },
  ]);
  expect(place).toMatchObject({
    stopId: "stop-1",
    detail: "80331, München, DE",
  });
});
