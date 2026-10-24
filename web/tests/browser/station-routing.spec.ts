import { test, expect } from "./test";
import { setup, choose, cors, fixture } from "./planner-fixture";
import {
  expectPlanningComplete,
  expectSelectedJourneySaved,
  openSelectedDetails,
} from "./assertions";

test("station selection resolves its parent through the planner and survives saving and a route link", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page, true, { maxBikeTransfers: 0 });
  const station = {
    name: "Zielbahnhof",
    type: "STOP",
    id: "search-platform",
    lat: 48.175,
    lon: 11.6,
  };
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({ headers: cors, json: [station] }),
  );
  const lookups: string[] = [],
    plans: URL[] = [];
  await page.route("**/api/v6/stop?*", (route) => {
    lookups.push(new URL(route.request().url()).searchParams.get("stopId")!);
    return route.fulfill({
      headers: cors,
      json: {
        place: { stopId: station.id, parentId: "whole-station" },
        routes: [],
      },
    });
  });
  await page.route("**/api/v6/plan?*", (route) => {
    const url = new URL(route.request().url());
    plans.push(url);
    const reply = structuredClone(fixture.multimodal);
    for (const journey of reply.itineraries) {
      journey.legs = journey.legs.slice(0, 2);
      journey.endTime = journey.legs.at(-1)!.endTime;
      Object.assign(journey.legs.at(-1)!.to, {
        name: "Zielbahnhof",
        stopId: "actual-platform",
        parentId: "whole-station",
      });
    }
    return route.fulfill({
      headers: cors,
      json: url.searchParams.get("directModes") ? { direct: [] } : reply,
    });
  });
  await choose(page, "destination", "Zielbahnhof");
  await expectPlanningComplete(page);
  await expectSelectedJourneySaved(page);
  await openSelectedDetails(page);
  await expect(page.locator("#panel-details")).not.toContainText("Entfalten");
  expect(lookups).toEqual(["search-platform"]);
  const transit = plans.filter((url) => !url.searchParams.get("directModes"));
  expect(transit.length).toBeGreaterThan(0);
  expect(
    transit.every(
      (url) =>
        url.searchParams.get("toPlace") === "whole-station" &&
        url.searchParams.get("postTransitModes") === "" &&
        url.searchParams.get("maxPostTransitTime") === "0",
    ),
  ).toBe(true);
  const link = new URL(page.url());
  expect(link.searchParams.get("v")).toBe("4");
  expect(link.searchParams.get("toKind")).toBe("station");
  expect(link.searchParams.get("toStopId")).toBe("search-platform");
  await page.goto(link.href);
  await expectPlanningComplete(page);
  expect(lookups).toEqual(["search-platform", "search-platform"]);
});
