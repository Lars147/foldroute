import { expect, test, type Page } from "@playwright/test";
import { defaults } from "../../src/model";
import {
  expectPlanningComplete,
  expectSelectedJourneySaved,
  openSettingsSection,
  showMap,
} from "./assertions";

const now = Date.parse("2026-09-04T08:00:00Z") / 1000;
const origin = {
  name: "Start A",
  detail: "",
  latitude: 48.132,
  longitude: 11.5756,
};
const destination = {
  name: "Ziel B",
  detail: "",
  latitude: 48.175,
  longitude: 11.6,
};
const stops = [
  {
    id: "first",
    place: {
      name: "Darmstadt Hauptbahnhof mit einem besonders langen Haltestellennamen",
      detail: "",
      latitude: 48.15,
      longitude: 11.58,
    },
    stayMinutes: 7,
  },
  {
    id: "second",
    place: {
      name: "Frankfurt (Main) Süd",
      detail: "",
      latitude: 48.16,
      longitude: 11.59,
    },
    stayMinutes: 3,
  },
];
function polyline(points: number[][]): string {
  let result = "";
  const previous = [0, 0];
  for (const point of points)
    point.forEach((coordinate, i) => {
      const next = Math.round(coordinate * 1e6),
        delta = next - previous[i];
      previous[i] = next;
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 32) {
        result += String.fromCharCode((32 | (value & 31)) + 63);
        value >>>= 5;
      }
      result += String.fromCharCode(value + 63);
    });
  return result;
}
async function setup(page: Page) {
  await page.clock.setFixedTime(new Date(now * 1000));
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v6/plan?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("directModes") !== "BIKE")
      return route.fulfill({ json: { itineraries: [] } });
    const a = params.get("fromPlace")!.split(",").map(Number),
      b = params.get("toPlace")!.split(",").map(Number);
    const start = Date.parse(params.get("time")!),
      end = start + 20 * 60000;
    const geometry = { points: polyline([a, b]), precision: 6 };
    return route.fulfill({
      json: {
        direct: [
          {
            id: `${a}|${b}|${start}`,
            transfers: 0,
            startTime: new Date(start).toISOString(),
            endTime: new Date(end).toISOString(),
            legs: [
              {
                mode: "BIKE",
                from: { name: "A", lat: a[0], lon: a[1] },
                to: { name: "B", lat: b[0], lon: b[1] },
                startTime: new Date(start).toISOString(),
                endTime: new Date(end).toISOString(),
                distance: 5000,
                legGeometry: geometry,
                steps: [
                  {
                    relativeDirection: "DEPART",
                    distance: 5000,
                    streetName: "Weg",
                    polyline: geometry,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.evaluate(
    async ({ origin, destination, stops, now, settings }) => {
      const path = "/src/offline.ts";
      const { OfflineStore } = await import(path);
      let time = now - 86400;
      const departure = time;
      const places = [origin, ...stops.map((stop) => stop.place), destination];
      const legs: any[] = [];
      for (let i = 1; i < places.length; i++) {
        const from = places[i - 1],
          to = places[i];
        legs.push({
          kind: "bike",
          from,
          to,
          start: time,
          end: time + 1200,
          distance: 5000,
          coordinates: [from, to],
        });
        time += 1200;
        if (i <= stops.length) {
          const stop = stops[i - 1];
          legs.push({
            kind: "stop",
            from: to,
            to,
            start: time,
            end: time + stop.stayMinutes * 60,
            distance: 0,
            coordinates: [to],
            stop,
          });
          time += stop.stayMinutes * 60;
        }
      }
      await new OfflineStore().save(
        {
          version: 4,
          savedAt: departure,
          settings,
          request: { origin, destination, stops, timing: "arrive", time },
          journey: {
            id: "stored-route",
            origin,
            destination,
            departure,
            arrival: time,
            legs,
            transfers: 0,
            isDirect: true,
          },
        },
        "stored",
      );
      localStorage.setItem(
        "foldroute.routing.v3",
        JSON.stringify({
          ...settings,
          cyclingSpeedKilometersPerHour: 20,
          maxBikeTransfers: 0,
        }),
      );
    },
    { origin, destination, stops, now, settings: defaults },
  );
  await page.reload();
  await expect(page.locator("#open-saved")).toBeVisible();
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    return new OfflineStore().read();
  });
}

for (const width of [320, 390, 1280])
  test(`stored routes show ordered stops and replan now at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    const old = (await stored(page)).snapshot;
    const requests: URL[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v6/plan?"))
        requests.push(new URL(request.url()));
    });
    await page.locator("#tab-history").click();
    await expect(page.locator("#tab-history")).toHaveText("Verlauf");
    await expect(page.locator(".history-via")).toHaveText(
      `Über ${stops.map((stop) => stop.place.name).join(" · ")}`,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    expect(
      await page
        .locator(".history-via")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("routes-with-stops.png") });
    await page.locator(".history-open").click();
    await expectPlanningComplete(page);
    await expectSelectedJourneySaved(page);
    const current = await stored(page);
    expect(current.entries).toHaveLength(1);
    expect(current.snapshot.request).toMatchObject({
      origin,
      destination,
      stops,
      timing: "now",
      time: now,
    });
    expect(current.snapshot.settings.cyclingSpeedKilometersPerHour).toBe(20);
    expect(current.snapshot.savedAt).toBeGreaterThan(old.savedAt);
    expect(
      requests[0].searchParams.get("fromPlace")!.split(",").map(Number),
    ).toEqual([origin.latitude, origin.longitude]);
    expect(
      requests.some(
        (url) =>
          url.searchParams.get("fromPlace") ===
          `${stops[0].place.latitude.toFixed(6)},${stops[0].place.longitude.toFixed(6)}`,
      ),
    ).toBe(true);
    expect(
      current.snapshot.journey.legs
        .filter((leg: any) => leg.kind === "stop")
        .map((leg: any) => leg.stop),
    ).toEqual(stops);
    if (width < 900)
      await expect(page.locator("#map-view")).toHaveAttribute(
        "data-result-screen",
        "list",
      );
    const count = requests.length;
    await page.goBack();
    await expect(page.locator("#history-view")).toBeVisible();
    await page.goForward();
    await expect(page.locator("#map-view")).toBeVisible();
    expect(requests).toHaveLength(count);
  });

test("offline routes expose the cached itinerary and keep replanning explicit on reconnect", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v6/plan?")) requests++;
  });
  await context.setOffline(true);
  await page.locator("#tab-history").click();
  await page.locator(".history-open").click();
  await expect(page.locator("#saved-notice")).toContainText(
    "Zeiten wurden nicht aktualisiert",
  );
  await expect(page.locator("#replan-saved")).toBeVisible();
  await expect(page.locator("#replan-saved")).toBeDisabled();
  await page.locator("#route-more").click();
  await expect(page.locator("#navigation-start")).toHaveText(
    "Mit gespeicherter Route starten",
  );
  await page.locator("#route-actions-close").click();
  await showMap(page);
  await expect(page.locator("#replan-saved")).toBeVisible();
  expect(requests).toBe(0);
  await context.setOffline(false);
  await expect(page.locator("#replan-saved")).toBeEnabled();
  expect(requests).toBe(0);
  await page.locator("#replan-saved").click();
  await expectPlanningComplete(page);
  expect(requests).toBeGreaterThan(0);
});

test("planning errors retry the failed route directly and keep the saved snapshot until success", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const before = (await stored(page)).snapshot;
  let failed = true;
  await page.route("**/api/v6/plan?*", (route) =>
    failed ? route.fulfill({ status: 500 }) : route.fallback(),
  );
  await page.locator("#open-saved").click();
  await expect(page.locator("#recover-planning")).toBeVisible();
  await expect(page.locator("#recover-planning")).toHaveText(
    "Erneut versuchen",
  );
  expect((await stored(page)).snapshot).toEqual(before);
  await expect(page.locator("#refresh-route")).toBeHidden();
  await page.screenshot({ path: info.outputPath("retry-inline.png") });
  failed = false;
  await page.locator("#recover-planning").click();
  await expectPlanningComplete(page);
  await expectSelectedJourneySaved(page);
  await expect(page.locator("#planning-recovery")).toBeHidden();
  expect((await stored(page)).snapshot.savedAt).toBe(now);
  await page.locator("#tab-history").click();
  // An empty response needs editing the request rather than another blind retry.
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  await page.locator(".history-open").click();
  await expect(page.locator("#recover-planning")).toHaveText("Route anpassen");
  await page.locator("#recover-planning").click();
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#origin")).toHaveValue(origin.name);
  await expect(page.locator("#destination")).toHaveValue(
    destination.name,
  );
  await expect(page.locator("#via-0")).toHaveValue(stops[0].place.name);
});

for (const exit of ["done", "route", "history", "back"] as const)
  test(`invalid settings block ${exit} and keep the draft until corrected`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.locator("#tab-settings").click();
    await openSettingsSection(page, "options");
    const input = page.locator("#maxWalkingMinutes");
    await input.fill("4");
    await input.fill("1000");
    await page.locator("#settings-options > summary").click();
    const position = await page.evaluate(() => history.state.position);
    if (exit === "back") await page.goBack();
    else
      await page
        .locator(exit === "done" ? "#save-settings" : `#tab-${exit}`)
        .click();
    await expect(page.locator("#settings-view")).toBeVisible();
    await expect(input).toHaveValue("1000");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    await expect(page.locator("#maxWalkingMinutes-error")).toBeVisible();
    await expect(page.locator("#maxWalkingMinutes-error")).toBeInViewport({
      ratio: 1,
    });
    await expect
      .poll(() => page.evaluate(() => history.state.position))
      .toBe(position);
    await page.locator("#tab-settings").click();
    await expect(input).toHaveValue("1000");
    await page.screenshot({
      path: info.outputPath(`settings-invalid-${exit}.png`),
    });
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
            .maxWalkingMinutes,
      ),
    ).toBe(4);
    await input.fill("3");
    await expect(page.locator("#maxWalkingMinutes-error")).toBeHidden();
    if (exit === "back") await page.goBack();
    else
      await page
        .locator(exit === "done" ? "#save-settings" : `#tab-${exit}`)
        .click();
    await expect(page.locator("#settings-view")).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
            .maxWalkingMinutes,
      ),
    ).toBe(3);
  });

test("retry stays next to an update error in the map and is disabled offline", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#open-saved").click();
  await expectPlanningComplete(page);
  let failed = true;
  await page.route("**/api/v6/plan?*", (route) =>
    failed ? route.fulfill({ status: 500 }) : route.fallback(),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#recover-planning")).toBeVisible();
  await expect(page.locator("#stale-notice")).toBeVisible();
  await showMap(page);
  await expect(page.locator("#map-preview #recover-planning")).toBeVisible();
  await expect(page.locator("#map-preview-status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await context.setOffline(true);
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator("#recover-planning")).toBeEnabled();
  await page.screenshot({ path: info.outputPath("retry-map.png") });
  failed = false;
  await page.locator("#recover-planning").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#planning-recovery")).toBeHidden();
});

test("empty and step-mismatched settings stay visible until a valid value is entered", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  const input = page.locator("#foldingDuration");
  for (const value of ["", "1.1"]) {
    await input.fill(value);
    await page.locator("#tab-route").click();
    await expect(page.locator("#settings-view")).toBeVisible();
    await expect(input).toHaveValue(value);
    await expect(input).toBeFocused();
    await expect(page.locator("#foldingDuration-error")).toBeVisible();
    await input.fill("3.5");
    await expect(page.locator("#foldingDuration-error")).toBeHidden();
  }
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-view")).toBeHidden();
});

test("invalid settings preserve an active calculation and do not create history loops", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#open-saved").click();
  await expectPlanningComplete(page);
  let requests = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/v6/plan?") &&
      new URL(request.url()).searchParams.get("directModes") === "BIKE"
    )
      requests++;
  });
  await page.locator("#tab-settings").click();
  const input = page.locator("#cyclingSpeedKilometersPerHour");
  await input.fill("18");
  await input.fill("1000");
  const position = await page.evaluate(() => history.state.position);
  for (let i = 0; i < 2; i++) {
    await page.goBack();
    await expect(input).toHaveValue("1000");
    await expect
      .poll(() => page.evaluate(() => history.state.position))
      .toBe(position);
  }
  expect(requests).toBe(0);
  await input.fill("19");
  await page.locator("#tab-route").click();
  await expectPlanningComplete(page);
  expect(requests).toBe(3); // One direct search for each of the three stages.
});

test("a service pause disables inline retry until its deadline without automatic requests", async ({
  page,
}) => {
  await setup(page);
  let paused = true,
    calls = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    calls++;
    return paused
      ? route.fulfill({
          status: 503,
          headers: {
            "Retry-After": "3",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Retry-After",
          },
        })
      : route.fallback();
  });
  await page.locator("#open-saved").click();
  await expect(page.locator("#recover-planning")).toBeVisible();
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await expect(page.locator("#recovery-wait")).toBeVisible();
  const initialCalls = calls;
  await page.clock.setFixedTime(new Date((now + 5) * 1000));
  await expect(page.locator("#recover-planning")).toBeEnabled();
  expect(calls).toBe(initialCalls);
  paused = false;
  await page.locator("#recover-planning").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#planning-recovery")).toBeHidden();
});
