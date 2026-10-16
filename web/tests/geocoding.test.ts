import { expect, it } from "vitest";
import { ApiClient } from "../src/transitous";

const city = { name: "München", unique: true, adminLevel: 6 };
const cafe = {
  name: "sweet spot kaffee",
  type: "PLACE",
  lat: 48.1357968,
  lon: 11.5776163,
  zip: "80331",
  country: "DE",
};

async function search(results: unknown[]) {
  const requests: URL[] = [];
  const client = new ApiClient(async (url) => {
    requests.push(new URL(String(url)));
    return new Response(JSON.stringify(results));
  });
  const places = await client.searchPlaces(
    "sweet spot München",
    new AbortController().signal,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].pathname).toBe("/api/v1/geocode");
  return places;
}

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
