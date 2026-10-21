import { expect, it } from "vitest";
import { defaults, migrateSettings, validSettings } from "../src/model";
import { baseVariants, makeURL } from "../src/transitous";
import { exampleRecording } from "../src/example-data";
import { routeURL, readRouteURL } from "../src/route-url";

it("migrates existing preferences without resetting personal values", () => {
  const { transferMinutes: _, ...old } = {
    ...defaults,
    maxCyclingMinutes: 17,
    maxWalkingMinutes: 7,
  };
  expect(migrateSettings(old)).toEqual({ ...old, transferMinutes: 3 });
  for (const transferMinutes of [0, 7, 30]) {
    const settings = { ...old, transferMinutes };
    expect(migrateSettings(settings)).toEqual(settings);
    expect(validSettings(settings)).toBe(true);
  }
  for (const transferMinutes of [-1, 31, 1.5, "3", null])
    expect(migrateSettings({ ...old, transferMinutes })).toBeUndefined();
});

it("passes the chosen additional transfer minutes to every transit variant in either time direction", () => {
  for (const timing of ["depart", "arrive"] as const)
    for (const transferMinutes of [0, 7, 30])
      for (const variant of baseVariants) {
        const params = makeURL(
          { ...exampleRecording.request, timing },
          { ...defaults, transferMinutes },
          variant,
        ).searchParams;
        expect(params.get("additionalTransferTime")).toBe(
          variant.direct ? null : String(transferMinutes),
        );
      }
});

it("continues accepting old links without transfer minutes while new links use personal preferences", () => {
  const url = routeURL("https://example.test/plan/", exampleRecording);
  url.searchParams.set("v", "1");
  const { transferMinutes: _, ...old } = defaults;
  for (const [key, value] of Object.entries(old))
    url.searchParams.set(key, String(value));
  expect(readRouteURL(url).kind).toBe("plan");
  expect(
    routeURL(url, exampleRecording).searchParams.has("transferMinutes"),
  ).toBe(false);
});
