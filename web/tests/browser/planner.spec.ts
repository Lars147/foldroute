import { addStop } from "./assertions";
import { openCachedJourney } from "./assertions";
import { openSettingsSection } from "./assertions";
import { openSelectedDetails, showMap } from "./assertions";
import {
  expectPlanningComplete,
  expectSelectedJourneySaved,
  expectMotionSettled,
} from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import { defaults, type Journey } from "../../src/model";
import type { PlanningState } from "../../src/planning-state";
import { routeURL } from "../../src/route-url";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
};
const places = [
  { name: "Start", lat: 48.132, lon: 11.5756 },
  { name: "Ziel", lat: 48.175, lon: 11.6 },
];
async function setup(page: Page, geolocation = true) {
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({ json: [], headers: cors }),
  );
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  if (geolocation) {
    await page.context().grantPermissions(["geolocation"]);
    await page
      .context()
      .setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  }
  // Browser geolocation timestamps follow the host clock; routing tests freeze page time.
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    const single = geo.getCurrentPosition.bind(geo),
      watch = geo.watchPosition.bind(geo);
    const stamped = (success: PositionCallback) => (p: GeolocationPosition) =>
      success({
        coords: p.coords,
        timestamp: Date.now(),
      } as GeolocationPosition);
    geo.getCurrentPosition = (success, error, options) =>
      single(stamped(success), error, options);
    geo.watchPosition = (success, error, options) =>
      watch(stamped(success), error, options);
  });
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({ headers: cors, json: places }),
  );
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await page.goto("/");
  await page.evaluate(
    (value) =>
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(value)),
    { ...defaults, maxCyclingMinutes: 60 },
  );
  await page.reload();
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
}
async function choose(page: Page, id: string, name: string) {
  await page.locator("#" + id).fill(name);
  await page
    .locator("#" + id + "-options")
    .locator(".place-select")
    .filter({ hasText: name })
    .click();
}
async function plan(page: Page) {
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expectPlanningComplete(page);
}
function shiftedTransitFixture(minutes: number) {
  const response = structuredClone(fixture.multimodal);
  for (const journey of response.itineraries) {
    for (const item of [journey, ...journey.legs]) {
      item.startTime = new Date(
        Date.parse(item.startTime) - minutes * 60000,
      ).toISOString();
      item.endTime = new Date(
        Date.parse(item.endTime) - minutes * 60000,
      ).toISOString();
    }
  }
  return response;
}
async function expectRecoveryButtons(page: Page, actionId: string) {
  const action = page.locator(`#${actionId}`);
  const start = page.locator(".panel-actions #navigation-start");
  // Fractional layout pixels can clip a border by less than one CSS pixel.
  await expect(action).toBeInViewport({ ratio: 0.99 });
  await expect(start).toBeInViewport({ ratio: 0.99 });
  const left = (await action.boundingBox())!;
  const right = (await start.boundingBox())!;
  expect(left.width).toBeCloseTo(right.width, 1);
  expect(left.height).toBeCloseTo(right.height, 1);
  expect(left.height).toBeGreaterThanOrEqual(48);
  expect(left.y).toBeCloseTo(right.y, 1);
  expect(left.x + left.width).toBeLessThan(right.x);
  const tabs = (await page.locator(".app-tabs").boundingBox())!;
  expect(left.y).toBeGreaterThanOrEqual(-1);
  expect(left.y + left.height).toBeLessThanOrEqual(tabs.y + 1);
  expect(right.y + right.height).toBeLessThanOrEqual(tabs.y + 1);
  expect(
    await action.evaluate((button) => button.scrollWidth <= button.clientWidth),
  ).toBe(true);
}

for (const width of [390, 1280]) {
  test(`start footer remains disabled through an empty initial search at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/v6/plan?*", async (r) => {
      await gate;
      await r.fulfill({ headers: cors, json: { direct: [], itineraries: [] } });
    });
    await choose(page, "destination", "Ziel");
    const start = page.locator("#navigation-start");
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveText("Los");
    await expect(start).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#route-start-summary")).toBeHidden();
    const initial = (await start.boundingBox())!;
    release();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect(page.locator(".route-choice")).toHaveCount(0);
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(page.locator("#status")).not.toBeEmpty();
    await expect(page.locator("#navigation-start-notice")).toBeHidden();
    const empty = (await start.boundingBox())!;
    expect(empty.x).toBe(initial.x);
    expect(empty.y).toBe(initial.y);
    expect(empty.width).toBe(initial.width);
  });
}

for (const width of [320, 390, 1280]) {
  test(`a fresh past-departure result keeps Los and explicit recovery visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    const departed = shiftedTransitFixture(20);
    await page.route("**/api/v6/plan?*", (r) =>
      r.fulfill({
        headers: cors,
        json:
          new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
            ? fixture.direct
            : departed,
      }),
    );
    const link = routeURL(page.url(), {
      request: {
        origin: {
          name: "Start",
          detail: "",
          latitude: places[0].lat,
          longitude: places[0].lon,
        },
        destination: {
          name: "Ziel",
          detail: "",
          latitude: places[1].lat,
          longitude: places[1].lon,
        },
        timing: "arrive",
        time: Date.parse("2026-09-04T08:40:00Z") / 1000,
      },
    });
    // Keep the longer direct ride as a comparison so the arrival search also
    // retains the earlier transit departure instead of filtering it as slower.
    await page.evaluate(
      (value) =>
        localStorage.setItem("foldroute.routing.v3", JSON.stringify(value)),
      defaults,
    );
    await page.goto(link.href);
    await expectPlanningComplete(page);
    await page
      .locator(".route-choice")
      .filter({ hasText: "U6" })
      .first()
      .click();
    const start = page.locator(".panel-actions #navigation-start");
    const notice = page.locator("#navigation-start-notice");
    const search = page.locator("#navigation-search-now");
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveText("Los");
    await expect(start).toHaveCSS("background-color", "rgb(226, 231, 228)");
    await expect(start).toHaveAccessibleDescription(
      /Abfahrt von U6.*liegt zurück/,
    );
    await expect(notice).toBeVisible();
    await expect(search).toBeEnabled();
    await expect(search).toHaveCSS("background-color", "rgb(255, 212, 59)");
    await expect(search).toHaveCSS("color", "rgb(23, 26, 28)");
    await expectRecoveryButtons(page, "navigation-search-now");
    await expect(page.locator("#route-start-summary")).toBeHidden();
    await expect(page.locator("#navigation-view-connection")).toHaveCount(0);
    await expect(start).toBeInViewport({ ratio: 1 });
    const original = (await start.boundingBox())!;
    await page.screenshot({
      path: test.info().outputPath("blocked-start-footer.png"),
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await search.scrollIntoViewIfNeeded();
    await expectRecoveryButtons(page, "navigation-search-now");
    await page.screenshot({
      path: test.info().outputPath("blocked-start-large-text.png"),
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "16px";
    });
    await openSelectedDetails(page);
    await expect(start).toBeVisible();
    if (width < 900) {
      await showMap(page);
      await expect(page.locator(".panel-actions")).toBeHidden();
      await page.locator("#result-back").click();
    }
    await page.context().setOffline(true);
    await expect(search).toBeDisabled();
    await expect(search).toHaveCSS("background-color", "rgb(226, 231, 228)");
    await expect(notice).toContainText("Internet");
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await page.context().setOffline(false);
    await expect(search).toBeEnabled();
    await expect(search).toHaveCSS("background-color", "rgb(255, 212, 59)");
    await expect(notice).not.toContainText("Internet");
    await page
      .locator(".route-choice")
      .filter({ hasNotText: "U6" })
      .first()
      .click();
    await expect(start).toBeEnabled();
    await expect(notice).toBeHidden();
    await expect(search).toBeHidden();
    await expect(page.locator("#route-start-summary")).toBeVisible();
    const ready = (await start.boundingBox())!;
    expect(ready.x).toBe(original.x);
    expect(ready.width).toBe(original.width);
    await page
      .locator(".route-choice")
      .filter({ hasText: "U6" })
      .first()
      .click();
    const requests: URL[] = [];
    await page.route("**/api/v6/plan?*", (r) => {
      requests.push(new URL(r.request().url()));
      return r.fulfill({
        headers: cors,
        json:
          new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
            ? fixture.direct
            : fixture.multimodal,
      });
    });
    await search.click();
    await expectPlanningComplete(page);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((url) => url.searchParams.get("arriveBy") === "false"),
    ).toBe(true);
    await expect(start).toBeEnabled();
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#route-origin")).toHaveText("Start");
    await expect(page.locator("#route-destination")).toHaveText("Ziel");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator(".route-choice").last().scrollIntoViewIfNeeded();
    await expect(page.locator(".route-choice").last()).toBeInViewport({
      ratio: 0.99,
    });
    await start.scrollIntoViewIfNeeded();
    await expect(start).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("a fresh risky connection stays startable until checking confirms a cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await setup(page);
  await page.evaluate(
    (value) =>
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(value)),
    defaults,
  );
  await page.reload();
  const multimodal = shiftedTransitFixture(10);
  const train = multimodal.itineraries[0].legs.find(
    (leg) => leg.mode === "SUBWAY",
  )!;
  Object.assign(train, {
    tripId: "footer-train",
    scheduledStartTime: train.startTime,
    scheduledEndTime: train.endTime,
    from: { ...train.from, stopId: "footer-start" },
    to: { ...train.to, stopId: "footer-end" },
  });
  let searches = 0;
  await page.route("**/api/v6/plan?*", (r) => {
    searches++;
    return r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : multimodal,
    });
  });
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({
      headers: cors,
      json: {
        legs: [
          {
            from: {
              stopId: "footer-start",
              scheduledDeparture: train.startTime,
            },
            to: { stopId: "footer-end", scheduledArrival: train.endTime },
            cancelled: true,
          },
        ],
      },
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await page.locator(".route-choice").filter({ hasText: "U6" }).first().click();
  const start = page.locator("#navigation-start");
  await expect(start).toBeEnabled();
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "gefährdet",
  );
  const priorSearches = searches;
  await start.click();
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "fällt aus",
  );
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(start).toHaveText("Los");
  await expect(page.locator("#navigation-search-now")).toBeEnabled();
  await expect(page.locator("#navigation-view")).toBeHidden();
  expect(searches).toBe(priorSearches);
  await page.screenshot({
    path: test.info().outputPath("cancelled-start-footer.png"),
  });
});

for (const width of [320, 390, 1280]) {
  test(`live start keeps Los disabled during location checking and retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await plan(page);
    await page.locator("#tab-settings").click();
    await page.clock.setFixedTime(new Date("2026-09-04T08:02:00Z"));
    await page.evaluate(() => {
      (window as any).savedGeo = navigator.geolocation;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition(
            _success: PositionCallback,
            error: PositionErrorCallback,
          ) {
            (window as any).rejectStartLocation = () =>
              error({ code: 1, message: "denied" } as GeolocationPositionError);
            return 1;
          },
          clearWatch() {},
        },
      });
    });
    await page.locator("#save-settings").click();
    const start = page.locator("#navigation-start");
    const ready = (await start.boundingBox())!;
    await start.click();
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveText("Wird geprüft …");
    await expect(start).toHaveAttribute("aria-busy", "true");
    const checking = (await start.boundingBox())!;
    expect(checking.width).toBe(ready.width);
    expect(checking.height).toBe(ready.height);
    await expect(page.locator("#navigation-start-notice")).toHaveText(
      "Standort wird geprüft …",
    );
    await page.evaluate(() => (window as any).rejectStartLocation());
    await expect(start).toHaveText("Los");
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(
      /Standortzugriff nicht erlaubt/,
    );
    await expect(page.locator("#route-start-summary")).toBeHidden();
    await expect(page.locator("#navigation-start-retry")).toBeVisible();
    await expect(page.locator("#navigation-start-retry")).toHaveCSS(
      "background-color",
      "rgb(255, 212, 59)",
    );
    await expectRecoveryButtons(page, "navigation-start-retry");
    await expect(page.locator("#navigation-view")).toBeHidden();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator("#navigation-start-retry").scrollIntoViewIfNeeded();
    await expectRecoveryButtons(page, "navigation-start-retry");
    await page.screenshot({
      path: test.info().outputPath("retry-start-large-text.png"),
    });
    await page.evaluate(() =>
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: (window as any).savedGeo,
      }),
    );
    await page.locator("#navigation-start-retry").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
  });
}

for (const width of [320, 393, 1280]) {
  test(`route editor groups places and keeps swap reachable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 393 ? "dark" : "light" });
    await setup(page);
    await plan(page);
    await page.locator("#adjust-route").click();
    await expect(page.locator("#search-heading")).toBeFocused();
    await expect(page.locator("#swap")).toHaveAccessibleName(
      "Start und Ziel tauschen",
    );
    await expect(page.locator("#swap")).toBeInViewport({ ratio: 1 });
    await expectMotionSettled(page.locator("#route-editor"));
    // Read one animation frame so an ancestor's entrance cannot skew alignment.
    const { origin, target, swap, more, locationBounds } = await page.evaluate(
      () => {
        const bounds = (id: string) => {
          const { x, y, width, height } = document
            .getElementById(id)!
            .getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          origin: bounds("origin"),
          target: bounds("destination"),
          swap: bounds("swap"),
          more: bounds("planner-more"),
          locationBounds: bounds("origin-location"),
        };
      },
    );
    expect(origin.width).toBeGreaterThanOrEqual(width < 380 ? 150 : 200);
    expect(target.width).toBeCloseTo(origin.width, 1);
    expect(origin.y).toBeLessThan(target.y);
    expect(swap.width).toBeCloseTo(32, 1);
    expect(swap.height).toBeCloseTo(44, 1);
    expect(target.x + target.width).toBeLessThanOrEqual(swap.x);
    expect(Math.abs(swap.y + 22 - target.y - target.height / 2)).toBeLessThan(
      1,
    );
    expect(Math.abs(more.y + 22 - origin.y - origin.height / 2)).toBeLessThan(
      1,
    );
    const locationButton = page.locator("#origin-location");
    await expect(locationButton).toHaveAccessibleName(
      "Aktuellen Standort verwenden",
    );
    expect(locationBounds.width).toBeCloseTo(32, 1);
    expect(locationBounds.height).toBeCloseTo(44, 1);
    expect(locationBounds.x + locationBounds.width).toBeLessThanOrEqual(
      origin.x,
    );
    await page.screenshot({ path: test.info().outputPath("route-editor.png") });
    await page.locator("#swap").click();
    await expect(page.locator("#origin")).toHaveValue("Ziel");
    await expect(page.locator("#destination")).toHaveValue(
      "Aktueller Standort",
    );
    await page.locator("#time-trigger").click();
    await expect(page.locator("#timezone")).toBeVisible();
    await page.locator("#time-cancel").click();
    await expect(page.locator("#time-trigger")).toBeFocused();
    await expect(page.locator("#timezone")).toBeHidden();
    await addStop(page);
    await expect(page.locator("#via-0")).toBeFocused();
    await page.locator("#via-0").press("Escape");
    await expect(page.locator("#swap")).toHaveAccessibleDescription(
      "Die Reihenfolge der Zwischenziele wird ebenfalls umgekehrt.",
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator("#calculate").scrollIntoViewIfNeeded();
    await expect(page.locator("#calculate")).toBeInViewport({ ratio: 1 });
    expect(
      await page
        .locator("#route-editor")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    ).toBe(true);
  });
}
// The mocked GPS position equals the route origin, so its existing marker
// provides a rendered screen coordinate without exposing the map to tests.
async function locationCenterError(page: Page) {
  return page.evaluate(() => {
    const map = document.getElementById("map")!.getBoundingClientRect(),
      panel = document.getElementById("journey-panel")!.getBoundingClientRect(),
      marker = document
        .querySelector("#map .route-marker-start")!
        .getBoundingClientRect();
    const x =
        innerWidth >= 900
          ? (panel.right + map.right) / 2
          : (map.left + map.right) / 2,
      y =
        innerWidth >= 900
          ? (map.top + map.bottom) / 2
          : (map.top + panel.top) / 2;
    return Math.hypot(
      marker.x + marker.width / 2 - x,
      marker.y + marker.height / 2 - y,
    );
  });
}
for (const [width, height] of [
  [320, 986],
  [390, 986],
  [844, 500],
  [1479, 986],
])
  test(`location stays centered in visible map ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await setup(page);
    await plan(page);
    await page.evaluate(() => {
      document.documentElement.dataset.locationCalls = "0";
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition: navigator.geolocation.watchPosition.bind(
            navigator.geolocation,
          ),
          clearWatch: navigator.geolocation.clearWatch.bind(
            navigator.geolocation,
          ),
          getCurrentPosition: (success: (value: unknown) => void) => {
            const root = document.documentElement;
            root.dataset.locationCalls = String(
              Number(root.dataset.locationCalls) + 1,
            );
            success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    });
    if (await page.locator("#map-location").evaluate((e) => e.inert))
      await page.locator("#panel-map-toggle").click();
    await page.locator("#map-location").click({ position: { x: 24, y: 4 } });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    if (width < 900) {
      await page.locator("#result-back").click();
      await showMap(page);
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    // A very short landscape viewport can leave no usable map at all.
    // Keep the focus for when the map becomes visible again.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 390, height: 844 });
    await showMap(page);
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    await expect(page.locator("html")).toHaveAttribute(
      "data-location-calls",
      "0",
    );
  });

test("manual map gestures release location focus; button restores it and route selection retains it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 986 });
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(2);
  await showMap(page);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  const map = await page.locator("#map").boundingBox();
  await page.mouse.move(map!.x + 100, map!.y + 150);
  await page.mouse.down();
  await page.mouse.move(map!.x + 180, map!.y + 180, { steps: 12 });
  await page.mouse.up();
  // Content-sized panels change route fitting after gestures. A retained
  // location focus would center within 2px, regardless of the panel height.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.waitForTimeout(300);
  // Route fitting may move the marker again during the panel transition;
  // only continued location centering (within 2px) would be a regression.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".leaflet-control-zoom-in").click();
  await page.waitForTimeout(300);
  await page.waitForTimeout(300);
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator("#result-back").click();
  await page.locator(".route-choice").last().click();
  await showMap(page);
  // Switching alternatives retains the explicitly requested location view.
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
});

for (const width of [320, 390, 768, 1479])
  test(`responsive app flow ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 986 });
    await setup(page);
    await plan(page);
    await expect(page.locator("#route-more")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await openSelectedDetails(page);
    await expect(page.locator("#journey-detail")).toBeVisible();
    await expect(page.locator("#adjust-route")).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`app-${width}.png`) });
    await showMap(page);
    await expect(page.locator("#map-location")).toBeVisible();
    if (width < 900) {
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      await expect(page.locator("#panel-details")).toBeHidden();
    }
  });
test("destination selection calculates automatically, never on opening or typing", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  expect(requests).toBe(0);
  await page.locator("#destination").fill("Ziel");
  await expect(page.locator("#destination-options")).toBeVisible();
  expect(requests).toBe(0);
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("Enter");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  expect(requests).toBeGreaterThan(0);
});
test("location denial keeps destination and allows a manual start", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) =>
          fail({ code: 1 }),
      },
    });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#destination")).toHaveValue("Ziel");
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#route-origin")).toHaveText("Start");
});
for (const width of [390, 1280])
  test(`ending navigation keeps the chosen alternative and original data timestamp at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await page.route("**/api/v6/trip?*", (route) =>
      route.fulfill({ headers: cors, json: { legs: [] } }),
    );
    await page.locator("#tab-settings").click();
    await page.locator("#maxCyclingMinutes").fill("30");
    await page.locator("#save-settings").click();
    await choose(page, "destination", "Ziel");
    await expectPlanningComplete(page);
    const choices = page.locator(".route-choice");
    const ids = await choices.evaluateAll((buttons) =>
      buttons.map((button) => (button as HTMLElement).dataset.journey),
    );
    expect(ids.length).toBeGreaterThan(1);
    await choices.nth(1).click();
    const originalStand = await page.locator("#result-stand").textContent();
    let searches = 0;
    page.on("request", (r) => {
      if (r.url().includes("/v6/plan")) searches++;
    });
    const activeJourney = () =>
      page.evaluate(async () => {
        const path = "/src/navigation-store.ts";
        const { NavigationStore } = await import(path);
        return (await new NavigationStore().read())?.journey.id;
      });
    await page.locator("#navigation-start").click();
    await expect.poll(activeJourney).toBe(ids[1]);
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    const start = page.locator(".panel-actions #navigation-start");
    await expect(start).toBeFocused();
    await expect(start).toHaveText("Los");
    await expect(start).toBeEnabled();
    await expect(page.locator("#saved-notice")).toBeHidden();
    await expect(page.locator("#replan-saved")).toBeHidden();
    await expect(page.locator("#result-stand")).toHaveText(originalStand!);
    await expect(
      page.locator(".route-choice[aria-pressed=true]"),
    ).toHaveAttribute("data-journey", ids[1]!);
    expect(
      await choices.evaluateAll((buttons) =>
        buttons.map((button) => (button as HTMLElement).dataset.journey),
      ),
    ).toEqual(ids);
    await page.screenshot({ path: info.outputPath("navigation-return.png") });
    if (width < 900) {
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
    }
    await start.click();
    await expect.poll(activeJourney).toBe(ids[1]);
    expect(searches).toBe(0);
  });

test("adjustments are drafts and cancellation preserves results", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Other");
  await page.locator("#cancel-adjust").click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
});

for (const width of [390, 1100])
  test(`editing a now search preserves its minute when only places change at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
    await plan(page);
    await page.clock.setFixedTime(new Date("2026-09-04T08:10:45Z"));
    await page.locator("#adjust-route").click();
    await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
    await expect(page.locator("#timing")).toHaveValue("depart");
    await expect(page.locator("#when")).toHaveValue("2026-09-04T10:07");
    await page.locator("#time-trigger").click();
    await expect(page.locator("#time-clock")).toHaveValue("10:07");
    await page.locator("#time-now").click();
    await expect(page.locator("#time-clock")).toHaveValue("10:10");
    await page.locator("#time-cancel").click();
    await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
    await choose(page, "origin", "Start");
    const query = page.waitForRequest((r) =>
      r.url().includes("directModes=BIKE"),
    );
    await page.locator("#calculate").click();
    const params = new URL((await query).url()).searchParams;
    expect(params.get("time")).toBe("2026-09-04T08:07:00Z");
    expect(params.get("arriveBy")).toBe("false");
    await expectPlanningComplete(page);
    expect(new URL(page.url()).searchParams.get("timing")).toBe("depart");
    await page.reload();
    await expectPlanningComplete(page);
    await page.locator("#adjust-route").click();
    await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
  });

test("editing across midnight keeps the original search day", async ({
  page,
}) => {
  await setup(page);
  await page.clock.setFixedTime(new Date("2026-09-04T21:59:45Z"));
  await plan(page);
  await page.clock.setFixedTime(new Date("2026-09-04T22:01:45Z"));
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).not.toContainText("Heute");
  await expect(page.locator("#when")).toHaveValue("2026-09-04T23:59");
  await page.locator("#time-trigger").click();
  await expect(
    page.locator('[data-date="2026-09-04"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#time-clock")).toHaveValue("23:59");
  await page.locator("#time-cancel").click();
  await page.locator("#cancel-adjust").click();
  expect(new URL(page.url()).searchParams.get("timing")).toBe("now");
});

test("editing pending and failed refreshes keeps the new search time and leaves drafts alone", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v6/plan?*", async (route) => {
    await pending;
    await route.fulfill({ status: 503, headers: cors });
  });
  await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
  const query = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await query;
  await page.clock.setFixedTime(new Date("2026-09-04T08:10:45Z"));
  await page.locator("#adjust-route").click();
  await expect(page.locator("#when")).toHaveValue("2026-09-04T10:07");
  await page.locator("#origin").fill("Mein Entwurf");
  release();
  await expect(page.locator("#status")).toContainText("nicht verfügbar");
  await expect(page.locator("#origin")).toHaveValue("Mein Entwurf");
  await expect(page.locator("#when")).toHaveValue("2026-09-04T10:07");
  await page.locator("#cancel-adjust").click();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
});

test("a draft opened while locating stays now until reopened after time resolution", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    geo.getCurrentPosition = (success) => {
      (window as any).resolvePlanningLocation = () =>
        success({
          coords: { latitude: 48.132, longitude: 11.5756, accuracy: 10 },
          timestamp: Date.now(),
        } as GeolocationPosition);
    };
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
  await page.evaluate(() => (window as any).resolvePlanningLocation());
  await expectPlanningComplete(page);
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  await page.locator("#cancel-adjust").click();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
});

test("settings persist immediately and replan once on leaving", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const priorChoices = await page.locator(".route-choice").count();
  let requests = 0,
    directRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) {
      requests++;
      if (new URL(r.url()).searchParams.get("directModes") === "BIKE")
        directRequests++;
    }
  });
  await page.locator("#tab-settings").click();
  await expect(page.locator("#settings-replan")).toBeHidden();
  await page.locator("#foldingDuration").fill("4");
  await expect(page.locator("#settings-replan")).toHaveText(
    "Die Route wird beim Verlassen neu berechnet.",
  );
  await expect(page.locator("#settings-replan")).toBeVisible();
  await openSettingsSection(page, "options");
  await page.locator("#maxWalkingMinutes").fill("3");
  const cycling = page.getByLabel("Maximale Radzeit je Etappe", {
    exact: false,
  });
  await expect(cycling).toHaveCount(1);
  await expect(cycling).toHaveAttribute("min", "1");
  await expect(cycling).toHaveAttribute("max", "60");
  await cycling.fill("17");
  await expect(page.locator(".route-choice")).toHaveCount(priorChoices);
  expect(requests).toBe(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({
    foldingDuration: 240,
    maxWalkingMinutes: 3,
    maxCyclingMinutes: 17,
  });
  await page.locator("#save-settings").click();
  await expectPlanningComplete(page);
  expect(directRequests).toBe(1);
  await page.reload();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("17");
});
test("throttling stops further requests; manual retry observes the pause", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/v6/plan?*", (r) => {
    requests++;
    return r.fulfill({
      status: 429,
      headers: { ...cors, "Retry-After": "60" },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText("Zu viele Anfragen");
  const before = requests;
  await page.locator("#adjust-route").click();
  await page.locator("#calculate").click();
  await expect(page.locator("#status")).toContainText("Pause");
  expect(requests).toBe(before);
});
test("closing the route cancels optimization and ignores delayed responses", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: fixture.direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#adjust-route")).toBeEnabled();
  await expect(page.locator("#navigation-start")).toBeVisible();
  await expect(page.locator("#navigation-start")).toBeEnabled();
  await expect(page.locator(".panel-tools #close-route")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Suche abbrechen", exact: true }),
  ).toHaveCount(0);
  await page.locator("#close-route").click();
  await expect(page.locator("#destination")).toBeVisible();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await page.waitForTimeout(1700);
  await expect(page.locator("#destination")).toBeVisible();
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
});
for (const width of [390, 1280]) {
  test(`navigation starts during optimization and retains the chosen route at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    let releaseTransit!: () => void;
    const transitGate = new Promise<void>(
      (resolve) => (releaseTransit = resolve),
    );
    await page.route("**/api/v6/plan?*", async (route) => {
      const direct =
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE";
      if (!direct) await transitGate;
      await route.fulfill({
        headers: cors,
        json: direct ? fixture.direct : fixture.multimodal,
      });
    });
    await choose(page, "destination", "Ziel");
    await expect(page.locator(".route-choice")).not.toHaveCount(0);
    await expect(page.locator("#journey-panel")).toHaveClass(/is-loading/);
    await expect(page.locator("#navigation-start")).toBeEnabled();
    await page.locator("#navigation-start").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
    const savedJourney = () =>
      page.evaluate(async () => {
        const { NavigationStore } = await import("/src/navigation-store.ts");
        return (await new NavigationStore().read())?.journey;
      });
    await expect.poll(savedJourney).toBeTruthy();
    const chosen = await savedJourney();
    expect(chosen!.legs.every((leg) => leg.kind !== "transit")).toBe(true);
    releaseTransit();
    await page.waitForTimeout(300);
    expect(await savedJourney()).toEqual(chosen);
    await expect(page.locator("#navigation-view")).toBeVisible();
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  });
}
test("editing during search preserves drafts, focus and optimization until cancelled", async ({
  page,
}) => {
  await setup(page);
  let releaseDirect!: () => void;
  let releaseTransit!: () => void;
  const directGate = new Promise<void>((resolve) => (releaseDirect = resolve));
  const transitGate = new Promise<void>(
    (resolve) => (releaseTransit = resolve),
  );
  let requests = 0;
  await page.route("**/api/v6/plan?*", async (route) => {
    requests++;
    const direct =
      new URL(route.request().url()).searchParams.get("directModes") === "BIKE";
    await (direct ? directGate : transitGate);
    await route.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#adjust-route")).toBeEnabled();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#destination")).toHaveValue("Ziel");
  await page.locator("#origin").fill("Unbestätigter Start");
  const requestCount = requests;
  await page.locator("#calculate").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Bitte Start aus den Vorschlägen auswählen",
  );
  expect(requests).toBe(requestCount);
  await expect(page.locator("#journey-panel")).toHaveClass(/is-loading/);
  releaseDirect();
  await expect(page.locator(".route-choice")).not.toHaveCount(0);
  await expect(page.locator("#origin")).toHaveValue("Unbestätigter Start");
  await expect(page.locator("#origin")).toBeFocused();
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#journey-panel")).toHaveClass(/is-loading/);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
  await page.locator("#origin").fill("Unbestätigter Start");
  releaseTransit();
  await expectPlanningComplete(page);
  await expect(page.locator("#origin")).toHaveValue("Unbestätigter Start");
  await expect(page.locator("#origin")).toBeFocused();
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await expect(page.locator(".route-choice")).not.toHaveCount(0);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
});

test("submitting edits during optimization replaces the search and ignores late results", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      headers: cors,
      json: [...places, { name: "Park", lat: 48.16, lon: 11.62 }],
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let newDirectRequests = 0;
  let oldTransitStarted = false;
  await page.route("**/api/v6/plan?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const direct = params.get("directModes") === "BIKE";
    const old = params.get("toPlace")?.includes("48.175");
    if (old && !direct) {
      oldTransitStarted = true;
      await gate;
    }
    if (!old && direct) newDirectRequests++;
    await route.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator(".route-choice")).not.toHaveCount(0);
  await expect.poll(() => oldTransitStarted).toBe(true);
  await expect(page.locator("#journey-panel")).toHaveClass(/is-loading/);
  await page.locator("#adjust-route").click();
  await choose(page, "destination", "Park");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-destination")).toHaveText("Park");
  expect(newDirectRequests).toBe(1);
  const link = page.url();
  release();
  await page.waitForTimeout(200);
  await expect(page.locator("#route-destination")).toHaveText("Park");
  expect(page.url()).toBe(link);
  await expect(page.locator("#route-editor")).not.toBeVisible();
});

test("a late location failure does not reset an open edit dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(_success: unknown, fail: (error: unknown) => void) {
          (window as any).failPlanningLocation = () => fail({ code: 2 });
        },
      },
    });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Manueller Entwurf");
  await page.evaluate(() => (window as any).failPlanningLocation());
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#origin")).toHaveValue("Manueller Entwurf");
  await expect(page.locator("#origin")).toBeFocused();
  await expect(page.locator("#destination")).toHaveValue("Ziel");
});

test("choice labels keep arrival times for both search modes and update dates without changing IDs", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const labels = await page.evaluate(async () => {
    const modulePath = "/src/journey-view.ts";
    const { JourneyView } = await import(modulePath);
    const origin = {
      name: "Start",
      detail: "",
      latitude: 48.13,
      longitude: 11.57,
    };
    const destination = { ...origin, name: "Ziel", latitude: 48.17 };
    const makeJourney = (
      id: string,
      arrival: string,
      minutes: number,
    ): Journey => {
      const end = Date.parse(arrival) / 1000,
        start = end - minutes * 60;
      return {
        id,
        origin,
        destination,
        departure: start,
        arrival: end,
        transfers: 0,
        isDirect: true,
        legs: [
          {
            id,
            kind: "bike",
            from: origin,
            to: destination,
            start,
            end,
            distance: 6800,
            coordinates: [origin, destination],
          },
        ],
      };
    };
    const journeys = [
      makeJourney("one", "2026-09-04T23:50:00+02:00", 55),
      makeJourney("two", "2026-09-04T23:55:00+02:00", 45),
      makeJourney("comparison", "2026-09-04T23:59:00+02:00", 80),
    ];
    const state: PlanningState = {
      journeys,
      selected: journeys[1],
      queriedAt: Date.now() / 1000,
      request: {
        origin,
        destination,
        timing: "depart",
        time: journeys[0].departure,
      },
      busy: false,
      locating: false,
      restored: false,
      message: "",
      issues: [],
    };
    const view = new JourneyView(() => {});
    const texts = () =>
      Array.from(
        document.querySelectorAll("#choices .route-choice-time"),
        (b) => b.textContent!.trim(),
      );
    view.render(state, 60);
    const departure = texts();
    state.request!.timing = "arrive";
    view.render(state, 60);
    const arrival = texts();
    document.querySelector<HTMLButtonElement>('[data-journey="two"]')!.focus();
    journeys[1].arrival += 600;
    journeys[1].legs[0].end += 600;
    view.render(state, 60);
    return {
      departure,
      arrival,
      updated: texts(),
      selected: document
        .querySelector('[aria-pressed="true"].route-choice')
        ?.getAttribute("data-journey"),
      focused: (document.activeElement as HTMLElement)?.dataset.journey,
      accessible: document
        .querySelector('[data-journey="two"]')
        ?.getAttribute("aria-label"),
      decorative: document
        .querySelector('[data-journey="comparison"] .icon')
        ?.getAttribute("aria-hidden"),
    };
  });
  expect(labels.departure).toEqual([
    "23:50 an · Ab 22:55 · 55 min",
    "23:55 an · Ab 23:10 · 45 min",
    "· 23:59 an · Ab 22:39 · 1 h 20 min",
  ]);
  expect(labels.arrival).toEqual(labels.departure);
  expect(labels.updated).toEqual([
    "23:50 an · Ab 22:55 · 55 min",
    "5. Sept. 00:05 an · Ab 4. Sept. 23:10 · 55 min",
    "· 23:59 an · Ab 22:39 · 1 h 20 min",
  ]);
  expect(labels.selected).toBe("two");
  expect(labels.focused).toBe("two");
  expect(labels.accessible).toContain(
    "Ankunft 5. Sept. 00:05, Abfahrt 4. Sept. 23:10, Gesamtdauer 55 min",
  );
  expect(labels.decorative).toBe("true");
});

test("better alternatives replace automatic selection", async ({ page }) => {
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: direct });
    else {
      await gate;
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("1 h 1 min");
  release();
  await expectPlanningComplete(page);
  await expect(page.locator("#choices .route-choice-time")).toHaveText([
    "10:53 an · Ab 10:00 · 53 min",
    "· 11:01 an · Ab 10:00 · 1 h 1 min",
  ]);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toHaveText("10:53 an · Ab 10:00 · 53 min");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("53 min");
  await page.locator(".route-choice[aria-pressed=true]").press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("1 h 1 min");
});
test("failed refresh preserves selected journey", async ({ page }) => {
  await setup(page);
  await plan(page);
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 503, headers: cors }),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText("nicht verfügbar");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
});
test("dark appearance, large text and reduced motion remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setup(page);
  await plan(page);
  await page.addStyleTag({ content: ":root {font-size: 24px !important;}" });
  const card = page.locator(".route-choice[aria-pressed=true]");
  await expect(card.locator(".route-choice-arrival")).toHaveText("10:32 an");
  await expect(card.locator(".route-choice-schedule")).toHaveText(
    "Ab 10:00 · 32 min",
  );
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(page.locator("#adjust-route")).toBeVisible();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#route-editor")).toBeVisible();
  await page.locator("#cancel-adjust").click();
  await page.screenshot({
    path: "test-results/app-dark-large.png",
    fullPage: true,
  });
});

test("adjustment actions remain reachable in a short keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await setup(page);
  await page.locator("#search-adjust").click();
  await page.locator("#origin").focus();
  await expect(page.locator("#search-adjust")).toBeHidden();
  await page.locator(".search-focus-back").click();
  await expect(page.locator("#search-adjust")).toBeInViewport({ ratio: 1 });
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").scrollIntoViewIfNeeded();
  await expect(page.locator("#time-clock")).toBeInViewport();
  await page.locator("#time-apply").click();
  await expect(page.locator("#search-adjust")).toBeInViewport({ ratio: 1 });
});

test("focused dialog fields stay inside the scroll area when the keyboard opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").focus();
  await page.locator("#adjust-route").press("Enter");
  await page.locator("#destination").fill("Zi");
  await page
    .locator("#destination")
    .evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));

  // Unlike resizing the page, an iOS keyboard shrinks the visual viewport
  // while leaving the layout viewport intact.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", {
      configurable: true,
      value: 365,
    });
    Object.defineProperty(window.visualViewport!, "offsetTop", {
      configurable: true,
      value: 40,
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  });
  const expectFieldInside = async (id: string, withLabel = true) => {
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, withLabel }) => {
            const field = document.getElementById(id) as HTMLInputElement;
            const bounds = document
              .querySelector(".search-content")!
              .getBoundingClientRect();
            const input = field.getBoundingClientRect();
            const label = field.labels![0].getBoundingClientRect();
            if (field.classList.contains("search-focus-input")) {
              const viewport = window.visualViewport!;
              const results = document
                .getElementById(`${id}-options`)!
                .getBoundingClientRect();
              return (
                input.top >= viewport.offsetTop &&
                input.bottom <= viewport.offsetTop + viewport.height &&
                results.bottom <= viewport.offsetTop + viewport.height
              );
            }
            return (
              Math.min(input.top, withLabel ? label.top : input.top) >=
                bounds.top - 1 && input.bottom <= bounds.bottom + 1
            );
          },
          { id, withLabel },
        ),
      )
      .toBe(true);
    await expect(page.locator(`#${id}`)).toBeFocused();
  };
  await expectFieldInside("destination");
  await expect(page.locator("#destination")).toHaveValue("Zi");
  expect(
    await page
      .locator("#destination")
      .evaluate((input: HTMLInputElement) => input.selectionStart),
  ).toBe(1);

  await page.locator(".search-focus-back").click();
  await page.locator("#origin").focus();
  await expectFieldInside("origin");
  await page.locator(".search-focus-back").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").scrollIntoViewIfNeeded();
  await expect(page.locator("#time-clock")).toBeInViewport();
  await page.locator("#time-cancel").click();
  await choose(page, "destination", "Ziel");
  await page.locator("#destination").focus();
  await expectFieldInside("destination");
  await expect(page.locator("#destination")).toHaveValue("Ziel");

  await page.addStyleTag({ content: ":root { font-size: 24px; }" });
  await page.evaluate(() =>
    window.visualViewport!.dispatchEvent(new Event("resize")),
  );
  await expectFieldInside("destination", false);
  await page.locator(".search-focus-back").click();
  const actionsVisible = await page.evaluate(() => {
    const actions = document
      .querySelector("#planning-actions")!
      .getBoundingClientRect();
    const viewport = window.visualViewport!;
    return (
      actions.top >= viewport.offsetTop &&
      actions.bottom <= viewport.offsetTop + viewport.height
    );
  });
  expect(actionsVisible).toBe(true);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#adjust-route")).toBeFocused();
});

for (const code of [0, 1, 2, 3]) {
  test(`location button requests access immediately: ${code}`, async ({
    page,
  }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (
            success: (p: unknown) => void,
            fail: (e: unknown) => void,
          ) => {
            if (code)
              fail({
                code,
                message:
                  "Origin does not have permission to use Geolocation service",
              });
            else success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    }, code);
    await setup(page, false);
    await page.locator("#search-adjust").click();
    await page.locator("#origin-location").click();
    if (!code) {
      await expect(page.locator("#adjust-status")).toBeEmpty();
      await expect(page.locator("#adjust-status")).toHaveCSS("display", "none");
      await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
      await expect(page.locator("#adjust-location-announcement")).toHaveText(
        "Standort ermittelt",
      );
    } else {
      await expect(page.locator("#adjust-status")).toContainText(
        [
          "",
          "Standortzugriff nicht erlaubt",
          "Standort nicht verfügbar",
          "Standortabfrage dauert zu lange",
        ][code],
      );
      await expect(page.locator("#adjust-location-announcement")).toBeEmpty();
      await expect(page.locator("#adjust-status")).not.toContainText(
        "Diagnose:",
      );
      await expect(page.locator("#adjust-status")).not.toContainText(
        "Geolocation service",
      );
    }
    if (code) await expect(page.locator("#adjust-location-help")).toBeVisible();
    else await expect(page.locator("#adjust-location-help")).toBeHidden();
    await expect(page.locator("#origin-location")).toBeEnabled();
    await expect(page.locator("#route-editor")).toBeVisible();
  });
}

test("location success stays quiet after retry and cancelled replies cannot announce success", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(
          success: (position: unknown) => void,
          fail: (error: unknown) => void,
        ) {
          if (++calls === 1) {
            fail({ code: 1 });
            return;
          }
          window.addEventListener(
            "resolve-location",
            () =>
              success({
                coords: { latitude: 48.132, longitude: 11.5756 },
              }),
            { once: true },
          );
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  const button = page.locator("#origin-location");
  const announcement = page.locator("#adjust-location-announcement");
  await button.click();
  await expect(page.locator("#adjust-location-help")).toBeVisible();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator("#adjust-status")).toContainText(
    "Standort wird ermittelt",
  );
  await expect(page.locator("#adjust-location-help")).toBeHidden();
  await expect(announcement).toBeEmpty();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await expect(button).toBeEnabled();
  await expect(page.locator("#adjust-status")).toBeEmpty();
  await expect(announcement).toHaveText("Standort ermittelt");
  await choose(page, "origin", "Start");
  await expect(announcement).toBeEmpty();
  await button.click();
  await choose(page, "origin", "Start");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(announcement).toBeEmpty();
  await button.click();
  await page.locator("#search-adjust").click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await page.locator("#search-adjust").click();
  await expect(announcement).toBeEmpty();
  await expect(page.locator("#adjust-status")).toBeEmpty();
  await expect(button).toBeEnabled();
});

test("cancelled location request does not overwrite manual start feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) => {
          window.addEventListener("fail-location", () => fail({ code: 1 }), {
            once: true,
          });
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeDisabled();
  await choose(page, "origin", "Start");
  await page.evaluate(() => window.dispatchEvent(new Event("fail-location")));
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#adjust-status")).toHaveText("");
  await expect(page.locator("#origin-location")).toBeEnabled();
});

test("map location help persists and clears on retry; manual origin clears dialog help", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({ state: "prompt", onchange: null }),
      },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback, fail: PositionErrorCallback) {
          const id = ++calls;
          queueMicrotask(() => {
            if (id === 2)
              success({
                coords: { latitude: 48.132, longitude: 11.5756, accuracy: 10 },
                timestamp: Date.now(),
              } as GeolocationPosition);
            else
              fail({
                code: 1,
                message: "User denied Geolocation",
              } as GeolocationPositionError);
          });
          return id;
        },
        clearWatch() {},
        getCurrentPosition(
          _success: PositionCallback,
          fail: PositionErrorCallback,
        ) {
          fail({
            code: 1,
            message: "User denied Geolocation",
          } as GeolocationPositionError);
        },
      },
    });
  });
  await page.locator("#tab-route").click();
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeVisible();
  await expect(page.locator("#map-location-error a")).toHaveAttribute(
    "href",
    "hilfe.html#standort",
  );
  await page.waitForTimeout(6200);
  await expect(page.locator("#map-location-error")).toBeVisible();
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeHidden();
  await page.locator("#adjust-route").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#adjust-location-help")).toBeVisible();
  await choose(page, "origin", "Start");
  await expect(page.locator("#adjust-location-help")).toBeHidden();
  await page.locator("#calculate").click();
  await expect(page.locator("#route-editor")).toBeHidden();
  await expectPlanningComplete(page);
});

test("help opens direct topics and fits narrow screens with enlarged text", async ({
  page,
}) => {
  await page.goto("/hilfe.html#standort-freigabe");
  await expect(page.locator("#standort-freigabe")).toHaveAttribute("open", "");
  await expect(page.locator("#standort-freigabe summary")).toBeInViewport();
  await page.locator("#standort-freigabe summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#standort-freigabe")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.addStyleTag({ content: "html { font-size: 24px; }" });
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 1660]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test("favorites and recent places share all searches and remain available offline", async ({
  page,
  context,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#destination").fill("Ziel");
  await page
    .getByRole("button", { name: "Ziel: Favorit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ziel: Favorit", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(requests).toBe(0);
  await page.locator("#destination").fill("");
  await expect(page.locator("#destination-options")).toContainText("Favoriten");
  await page.locator("#search-adjust").click();
  await page.locator("#origin").fill("");
  await expect(page.locator("#origin-options")).toContainText("Favoriten");
  await choose(page, "origin", "Start");
  await addStop(page);
  await page.locator("#via-0").fill("");
  await expect(page.locator("#via-0-options")).toContainText(
    "Zuletzt verwendet",
  );
  await expect(page.locator("#via-0-options .place-select")).toHaveCount(3);
  await page.locator("#search-adjust").click();
  await page.reload();
  await expect(page.locator("#destination-options")).toContainText("Favoriten");
  await expect(page.locator("#destination-options")).toContainText(
    "Zuletzt verwendet",
  );
  await context.setOffline(true);
  await page.locator("#destination").fill("Zi");
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    1,
  );
  await expect(page.locator("#destination-options")).toContainText("Ziel");
  await page.screenshot({
    path: "test-results/favorites-offline.png",
    fullPage: true,
  });
});

test("two-character search requests twelve results; prefill keeps cursor and makes no request", async ({
  page,
}) => {
  await setup(page);
  const searches: URL[] = [];
  await page.route("**/api/v1/geocode?*", (r) => {
    searches.push(new URL(r.request().url()));
    return r.fulfill({
      headers: cors,
      json: Array.from({ length: 15 }, (_, i) => ({
        name: `Ziel ${i}`,
        lat: 48.175 + i / 10000,
        lon: 11.6,
      })),
    });
  });
  await page.locator("#destination").fill("Zi");
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    12,
  );
  expect(searches[0].searchParams.get("numResults")).toBe("12");
  expect(searches[0].searchParams.get("place")).toBe("48.1372,11.5756");
  await page
    .getByRole("button", {
      name: "Ziel 0 ins Suchfeld übernehmen",
      exact: true,
    })
    .click();
  await expect(page.locator("#destination")).toHaveValue("Ziel 0 ");
  await expect(page.locator("#destination")).toBeFocused();
  expect(
    await page
      .locator("#destination")
      .evaluate((e: HTMLInputElement) => e.selectionStart),
  ).toBe(7);
  expect(searches).toHaveLength(1);
  await page.locator("#destination").press("Enter");
  await expect.poll(() => searches.length).toBe(2);
});

test("settings errors retain old results and their original offline snapshot", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const priorChoices = await page.locator(".route-choice").count();
  await expectSelectedJourneySaved(page);
  const original = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("foldroute-offline", 2);
      r.onsuccess = () => resolve(r.result);
    });
    const value = await new Promise<any>((resolve) => {
      const r = db.transaction("state").objectStore("state").get("last");
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return value;
  });
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 500, headers: cors }),
  );
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4.5");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(priorChoices);
  await page.locator("#recover-planning").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(priorChoices);
  await page.locator("#close-route").click();
  await openCachedJourney(page, page.locator("#open-saved"));
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4.5");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
          .foldingDuration,
    ),
  ).toBe(270);
  expect(original.settings.foldingDuration).toBe(180);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBeNull();
});

test("clearing local data requires confirmation and removes all app records", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#destination").fill("Ziel");
  await page
    .getByRole("button", { name: "Ziel: Favorit", exact: true })
    .click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await openSettingsSection(page, "data");
  await page.locator("#clear-data").click();
  await page.locator("#cancel-delete-data").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await openSettingsSection(page, "data");
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("#open-saved")).toBeHidden();
  await page.reload();
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    0,
  );
  await expect(page.locator("#open-saved")).toBeHidden();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("foldroute.routing.v1"),
      localStorage.getItem("foldroute.routing.v3"),
    ]),
  ).toEqual([null, null]);
});

test("late-departure notice appears only after search completes and opens settings", async ({
  page,
}) => {
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].startTime = direct.direct[0].legs[0].startTime =
    "2026-09-04T09:00:00Z";
  direct.direct[0].endTime = direct.direct[0].legs[0].endTime =
    "2026-09-04T09:32:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : { itineraries: [], direct: [] },
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(page.locator("#late-departure")).toContainText("1 h nach");
  await page.locator("#late-settings").click();
  await expect(page.locator("#settings-view")).toBeVisible();
});

test("a past fixed departure survives settings recalculation and manual refresh", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").fill("10:00");
  await page.locator("#time-apply").click();
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:01:00Z"));
  const requests: URL[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests.push(new URL(r.url()));
  });
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#tab-route").click();
  await expectPlanningComplete(page);
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests
      .filter((url) => url.searchParams.get("directModes") === "BIKE")
      .every((url) => url.searchParams.get("time") === "2026-09-04T08:00:00Z"),
  ).toBe(true);
  const count = requests.length;
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  expect(requests.length).toBeGreaterThan(count);
  expect(
    requests
      .filter((url) => url.searchParams.get("directModes") === "BIKE")
      .every((url) => url.searchParams.get("time") === "2026-09-04T08:00:00Z"),
  ).toBe(true);
  await expect(page.locator("#route-editor")).toBeHidden();
});

test("long direct rides are labeled comparisons and suitable transit is preferred", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  const direct = structuredClone(fixture.direct);
  direct.direct[0].endTime = direct.direct[0].legs[0].endTime =
    "2026-09-04T08:46:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toHaveText("10:53 an · Ab 10:00 · 53 min");
  await page.getByRole("button", { name: /Fahrradvergleich: 46 Min/ }).click();
  await expect(page.locator("#cycling-comparison")).toHaveText(
    "46 Min. Radfahrt · 16 Min. über deinem Radlimit",
  );
  await expect(
    page.locator(".route-choice[aria-pressed=true]"),
  ).toHaveAccessibleName(/16 Min. über deinem Radlimit/);
  await expect(
    page.locator(".route-choice[aria-pressed=true]"),
  ).toBeInViewport();
});

test("transit renders before a pending comparison and an explicit comparison stays selected", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (r) => {
    const direct =
      new URL(r.request().url()).searchParams.get("directModes") === "BIKE";
    if (direct) await pending;
    await r.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("53 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen optimieren …");
  release();
  await expectPlanningComplete(page);
  await page.getByRole("button", { name: /Fahrradvergleich:/ }).click();
  await expect(
    page.locator(".route-choice[aria-pressed=true]"),
  ).toHaveAccessibleName(/Fahrradvergleich/);
});

// Planning links carry the request, independently of the selected result.
test("planning URL reloads fixed endpoints without location access and keeps now dynamic", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = page.url();
  const params = new URL(link).searchParams;
  expect(params.get("from")).toBe("48.132000,11.575600");
  expect(params.get("fromName")).toBe("Startpunkt");
  expect(params.has("time")).toBe(false);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition() {
          throw new Error("Shared link must not locate");
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Startpunkt");
  await page.clock.setFixedTime(new Date("2026-09-04T08:05:00Z"));
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:00");
  await page.locator("#time-trigger").click();
  await page.locator("#time-now").click();
  await page.locator("#time-apply").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:05");
  await page.locator("#cancel-adjust").click();
  expect(page.url()).toBe(link);
  const direct = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  expect(new URL((await direct).url()).searchParams.get("time")).toBe(
    "2026-09-04T08:05:00Z",
  );
  await expectPlanningComplete(page);
  expect(page.url()).toBe(link);
  expect(errors).toEqual([]);
});

test("legacy links use personal preferences and edits survive Back and reload", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = new URL(page.url());
  link.searchParams.set("v", "1");
  for (const [key, value] of Object.entries({
    ...defaults,
    maxCyclingMinutes: 17,
    cyclingSpeedKilometersPerHour: 22,
  }))
    link.searchParams.set(key, String(value));
  const planned = page.waitForRequest("**/api/v6/plan?*");
  await page.goto(link.href);
  expect(new URL((await planned).url()).searchParams.get("cyclingSpeed")).toBe(
    (defaults.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
  );
  await expectPlanningComplete(page);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("60");
  await page.locator("#foldingDuration").fill("4");
  await page.goBack();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await page.goForward();
  await page.locator("#save-settings").click();
  await expectPlanningComplete(page);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({ maxCyclingMinutes: 60, foldingDuration: 240 });
  await page.reload();
  await expectPlanningComplete(page);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
});

test("Back and Forward restore distinct submitted plans without result history entries", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const first = page.url();
  const length = await page.evaluate(() => history.length);
  await page.locator(".route-choice").last().click();
  expect(page.url()).toBe(first);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.locator("#adjust-route").click();
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({
      headers: cors,
      json: [{ name: "Weiteres Ziel", lat: 48.176, lon: 11.6 }],
    }),
  );
  await choose(page, "destination", "Weiteres Ziel");
  await page
    .locator("#route-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expectPlanningComplete(page);
  const second = page.url();
  expect(new URL(second).searchParams.get("toName")).toBe("Weiteres Ziel");
  await page.goBack();
  await expectPlanningComplete(page);
  expect(page.url()).toBe(first);
  await page.goForward();
  await expectPlanningComplete(page);
  expect(page.url()).toBe(second);
});

test("invalid links never start API searches or change personal settings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const url = new URL(page.url());
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  const preferences = await page.evaluate(() =>
    localStorage.getItem("foldroute.routing.v3"),
  );
  url.searchParams.set("v", "999");
  await page.goto(url.href);
  await expect(page.locator("#place-status")).toContainText("ungültig");
  expect(requests).toBe(0);
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
  url.searchParams.set("v", "3");
  url.searchParams.set("timing", "depart");
  url.searchParams.set("time", "not-a-date");
  await page.goto(url.href);
  await expect(page.locator("#place-status")).toContainText("ungültig");
  expect(requests).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("foldroute.routing.v3")),
  ).toBe(preferences);
});

for (const timing of ["depart", "arrive"] as const)
  test(`a valid past ${timing} link preserves its time and can start cycling now`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    const preferences = await page.evaluate(() =>
      localStorage.getItem("foldroute.routing.v3"),
    );
    const url = new URL(page.url());
    url.searchParams.set("timing", timing);
    url.searchParams.set("time", "2026-09-03T08:00:00Z");
    const direct = structuredClone(fixture.direct);
    for (const item of [direct.direct[0], ...direct.direct[0].legs]) {
      item.startTime = new Date(
        Date.parse(item.startTime) - 86400000,
      ).toISOString();
      item.endTime = new Date(
        Date.parse(item.endTime) - 86400000,
      ).toISOString();
    }
    const transit = shiftedTransitFixture(1440);
    const requests: URL[] = [];
    await page.route("**/api/v6/plan?*", (r) => {
      requests.push(new URL(r.request().url()));
      return r.fulfill({
        headers: cors,
        json:
          new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
            ? direct
            : transit,
      });
    });
    await page.goto(url.href);
    await expectPlanningComplete(page);
    await expect(page.locator("#route-editor")).toBeHidden();
    expect(
      requests
        .find((r) => r.searchParams.get("directModes") === "BIKE")
        ?.searchParams.get("time"),
    ).toBe("2026-09-03T08:00:00Z");
    expect(Date.parse(new URL(page.url()).searchParams.get("time")!)).toBe(
      Date.parse("2026-09-03T08:00:00Z"),
    );
    if (timing === "arrive") {
      await page
        .locator(".route-choice")
        .filter({ hasText: "U6" })
        .first()
        .click();
      await expect(page.locator("#navigation-start")).toBeDisabled();
      await expect(page.locator("#navigation-start-notice")).toContainText(
        "liegt zurück",
      );
    }
    await page.locator('.route-choice[data-journey="bike-1"]').click();
    await expect(page.locator("#navigation-start")).toBeEnabled();
    const count = requests.length;
    await page.locator("#navigation-start").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { NavigationStore } = await import("/src/navigation-store.ts");
          return new NavigationStore().read();
        }),
      )
      .toMatchObject({
        request: { timing, time: Date.parse("2026-09-03T08:00:00Z") / 1000 },
        journey: { departure: Date.parse("2026-09-04T08:00:00Z") / 1000 },
      });
    expect(requests.length).toBe(count);
    expect(
      await page.evaluate(() => localStorage.getItem("foldroute.routing.v3")),
    ).toBe(preferences);
  });

for (const problem of ["empty", "service"] as const)
  test(`past ${problem} searches keep the chosen time through recovery`, async ({
    page,
  }) => {
    await setup(page);
    const url = routeURL(page.url(), {
      request: {
        origin: {
          name: "Start",
          detail: "",
          latitude: places[0].lat,
          longitude: places[0].lon,
        },
        destination: {
          name: "Ziel",
          detail: "",
          latitude: places[1].lat,
          longitude: places[1].lon,
        },
        timing: "arrive",
        time: Date.parse("2026-09-03T08:00:00Z") / 1000,
      },
    });
    let failing = true;
    const requests: URL[] = [];
    await page.route("**/api/v6/plan?*", (r) => {
      const query = new URL(r.request().url());
      requests.push(query);
      return r.fulfill(
        failing
          ? {
              status: problem === "service" ? 503 : 200,
              headers: cors,
              json: { direct: [], itineraries: [] },
            }
          : {
              headers: cors,
              json:
                query.searchParams.get("directModes") === "BIKE"
                  ? fixture.direct
                  : fixture.multimodal,
            },
      );
    });
    await page.goto(url.href);
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect(page.locator("#planning-recovery")).toBeVisible();
    await expect(page.locator("#route-editor")).toBeHidden();
    if (problem === "empty") {
      await expect(page.locator("#status")).toHaveText(
        "Für diesen Zeitpunkt wurden keine passenden Verbindungen gefunden.",
      );
      await expect(page.locator("#recover-planning")).toHaveText(
        "Route anpassen",
      );
    } else {
      await expect(page.locator("#status")).toContainText(
        "Routingdienst vorübergehend nicht verfügbar",
      );
      await expect(page.locator("#recover-planning")).toHaveText(
        "Erneut versuchen",
      );
    }
    failing = false;
    await page.locator("#recover-planning").click();
    if (problem === "empty") {
      await expect(page.locator("#route-editor")).toBeVisible();
      await expect(page.locator("#when")).toHaveValue("2026-09-03T10:00");
      await page.locator("#calculate").click();
    }
    await expectPlanningComplete(page);
    expect(
      requests
        .filter((r) => r.searchParams.get("directModes") === "BIKE")
        .every((r) => r.searchParams.get("time") === "2026-09-03T08:00:00Z"),
    ).toBe(true);
    await expect(page.locator("#route-editor")).toBeHidden();
    expect(Date.parse(new URL(page.url()).searchParams.get("time")!)).toBe(
      Date.parse("2026-09-03T08:00:00Z"),
    );
  });

test("copy planning link provides a selectable fallback when clipboard is denied", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(
    () =>
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      }) &&
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () =>
            Promise.reject(new DOMException("Denied", "NotAllowedError")),
        },
      }),
  );
  await plan(page);
  await page.locator("#route-more").click();
  await page.locator("#share-plan").click();
  await expect(page.locator("#plan-link-value")).toBeVisible();
  await expect(page.locator("#plan-link-value")).toHaveValue(page.url());
  expect(
    await page
      .locator("#plan-link-value")
      .evaluate(
        (input: HTMLInputElement) =>
          input.selectionEnd! - input.selectionStart!,
      ),
  ).toBe(page.url().length);
});

test("abandoned location lookup cannot publish placeholder coordinates or rewrite the URL", async ({
  page,
}) => {
  await setup(page, false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success: (result: unknown) => void) {
          (window as unknown as { finishLocation: () => void }).finishLocation =
            () => success({ coords: { latitude: 48.132, longitude: 11.5756 } });
        },
      },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  expect(new URL(page.url()).searchParams.has("from")).toBe(false);
  await page.locator("#close-route").click();
  await page.evaluate(() =>
    (window as unknown as { finishLocation: () => void }).finishLocation(),
  );
  await expect(page.locator("#search-view")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
});

test("copy succeeds and planning details fit the desktop sidebar", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 900, height: 844 });
  await page.evaluate(
    () =>
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      }) &&
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copiedLink = text;
          },
        },
      }),
  );
  await plan(page);
  await page.locator("#route-more").click();
  await page.locator("#share-plan").click();
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-link",
    page.url(),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(900);
  await page.screenshot({ path: "test-results/planning-link-desktop.png" });
});

for (const mode of ["depart", "arrive"] as const)
  test(`confirmed now fill keeps its fixed ${mode} minute through planning and refresh`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
    await page.locator("#adjust-route").click();
    await page.locator("#time-trigger").click();
    await page.locator(`#time-${mode}`).click();
    await page.locator("#time-now").click();
    await page.clock.setFixedTime(new Date("2026-09-04T08:09:45Z"));
    await page.locator("#time-apply").click();
    const query = page.waitForRequest((r) =>
      r.url().includes("directModes=BIKE"),
    );
    await page.locator("#calculate").click();
    const params = new URL((await query).url()).searchParams;
    expect(params.get("time")).toBe("2026-09-04T08:07:00Z");
    expect(params.get("arriveBy")).toBe(String(mode === "arrive"));
    await expectPlanningComplete(page);
    expect(new URL(page.url()).searchParams.get("timing")).toBe(mode);
    expect(Date.parse(new URL(page.url()).searchParams.get("time")!)).toBe(
      Date.parse("2026-09-04T08:07:00Z"),
    );
    await page.clock.setFixedTime(new Date("2026-09-04T08:12:45Z"));
    const refreshed = page.waitForRequest((r) =>
      r.url().includes("directModes=BIKE"),
    );
    await page.locator("#route-more").click();
    await page.locator("#refresh-route").click();
    const refreshedParams = new URL((await refreshed).url()).searchParams;
    expect(refreshedParams.get("time")).toBe("2026-09-04T08:07:00Z");
    expect(refreshedParams.get("arriveBy")).toBe(String(mode === "arrive"));
    await expectPlanningComplete(page);
  });

for (const mode of ["depart", "arrive"] as const)
  test(`fixed ${mode} link preserves the chosen UTC instant and local form time`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    const link = new URL(page.url());
    link.searchParams.set("timing", mode);
    link.searchParams.set("time", "2026-09-04T09:00:00Z");
    const query = page.waitForRequest((r) =>
      r.url().includes("directModes=BIKE"),
    );
    await page.goto(link.href);
    const params = new URL((await query).url()).searchParams;
    expect(params.get("time")).toBe("2026-09-04T09:00:00Z");
    expect(params.get("arriveBy")).toBe(String(mode === "arrive"));
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await page.locator("#adjust-route").click();
    await expect(page.locator("#timing")).toHaveValue(mode);
    await expect(page.locator("#when")).toHaveValue("2026-09-04T11:00");
  });

test("three regular routes keep their places and comparison is an optional fourth", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tab-settings").click();
  await expect(page.locator("#showCyclingComparison")).toBeChecked();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  const transit = structuredClone(fixture.multimodal);
  transit.itineraries = [0, 1, 2].map((i) => {
    const route = structuredClone(fixture.multimodal.itineraries[0]);
    route.id = `transit-${i}`;
    for (const leg of route.legs)
      if (leg.mode === "SUBWAY") leg.routeShortName = `U${i + 1}`;
    return route;
  });
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : transit,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator(".route-choice").last()).toHaveAccessibleName(
    /Fahrradvergleich:/,
  );
  await expect(
    page
      .locator(".route-choice")
      .last()
      .locator(".route-choice-arrival .icon svg"),
  ).toHaveCount(1);
  await page.locator(".route-choice").last().click();
  await openSelectedDetails(page);
  await expect(page.locator("#result-back")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#journey-heading")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect
    .poll(
      async () =>
        (await page.locator("#journey-panel").boundingBox())?.height ?? 0,
    )
    .toBeGreaterThan(550);
  await page.screenshot({ path: "test-results/fourth-comparison-mobile.png" });
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "options");
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(3);
  await expect(page.locator("#cycling-comparison")).toBeHidden();
  expect(
    new URL(page.url()).searchParams.get("showCyclingComparison"),
  ).toBeNull();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
          .showCyclingComparison,
    ),
  ).toBe(false);
  await page.reload();
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(3);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#showCyclingComparison")).not.toBeChecked();
});

test("hidden comparison arriving first does not finish the search before transit", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await openSettingsSection(page, "options");
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (r) => {
    const direct =
      new URL(r.request().url()).searchParams.get("directModes") === "BIKE";
    if (!direct) await gate;
    await r.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  const response = page.waitForResponse((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await choose(page, "destination", "Ziel");
  await response;
  await expect(page.locator("#journey-panel")).toHaveClass(/is-loading/);
  await expect(page.locator(".route-choice")).toHaveCount(0);
  release();
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#cycling-comparison")).toBeHidden();
});

test("only hidden comparisons produce an empty-result message", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await openSettingsSection(page, "options");
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : { itineraries: [], direct: [] },
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText("Keine passende Route");
  await expect(page.locator(".route-choice")).toHaveCount(0);
});

function viaPolyline(points: number[][]): string {
  let result = "",
    previous = [0, 0];
  for (const point of points)
    point.forEach((n, i) => {
      const rounded = Math.round(n * 1e6),
        delta = rounded - previous[i];
      previous[i] = rounded;
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
        value >>>= 5;
      }
      result += String.fromCharCode(value + 63);
    });
  return result;
}
async function setupVia(page: Page) {
  await setup(page);
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({
      headers: cors,
      json: [
        ...places,
        { name: "Café", lat: 48.15, lon: 11.58 },
        { name: "See", lat: 48.16, lon: 11.59 },
        { name: "Park", lat: 48.17, lon: 11.595 },
      ],
    }),
  );
  await page.route("**/api/v6/plan?*", (r) => {
    const params = new URL(r.request().url()).searchParams;
    if (params.get("directModes") !== "BIKE")
      return r.fulfill({ headers: cors, json: { itineraries: [] } });
    const a = params.get("fromPlace")!.split(",").map(Number),
      b = params.get("toPlace")!.split(",").map(Number);
    const instant = Date.parse(params.get("time")!);
    const start =
      params.get("arriveBy") === "true" ? instant - 20 * 60000 : instant;
    const end = start + 20 * 60000,
      polyline = { points: viaPolyline([a, b]), precision: 6 };
    return r.fulfill({
      headers: cors,
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
                from: { name: "START", lat: a[0], lon: a[1] },
                to: { name: "END", lat: b[0], lon: b[1] },
                startTime: new Date(start).toISOString(),
                endTime: new Date(end).toISOString(),
                distance: 5000,
                legGeometry: polyline,
                steps: [
                  {
                    relativeDirection: "DEPART",
                    distance: 5000,
                    streetName: "Weg",
                    polyline,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });
}

test("adding only a stop preserves the original now search minute", async ({
  page,
}) => {
  await setupVia(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:10:45Z"));
  await page.locator("#adjust-route").click();
  await addStop(page);
  await choose(page, "via-0", "Café");
  const query = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#calculate").click();
  expect(new URL((await query).url()).searchParams.get("time")).toBe(
    "2026-09-04T08:07:00Z",
  );
  await expectPlanningComplete(page);
  const params = new URL(page.url()).searchParams;
  expect(params.get("timing")).toBe("depart");
  expect(params.get("via1Name")).toBe("Café");
  expect(Date.parse(params.get("time")!)).toBe(
    Date.parse("2026-09-04T08:07:00Z"),
  );
});

test("editing a saved now result uses its original search time without starting a search", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:10:45Z"));
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:00");
  await expect(page.locator("#when")).toHaveValue("2026-09-04T10:00");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  expect(requests).toBe(0);
});

test("reordered stop keeps keyboard focus visible after motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await setup(page);
  await page.locator("#search-adjust").click();
  for (let index = 0; index < 3; index++) {
    await addStop(page);
    await page.locator(`#via-${index}`).press("Escape");
  }
  await expectMotionSettled(page.locator("#route-editor"));
  const row = page.locator("#via-2").locator("..");
  const up = row.getByRole("button", { name: /nach oben/ });
  await up.evaluate((button) => button.scrollIntoView({ block: "start" }));
  const otherRowsMove = await up.evaluate((button) => {
    (button as HTMLButtonElement).click();
    const row = button.closest(".stop-editor-row")!;
    return [...document.querySelectorAll(".stop-editor-row")].some(
      (other) => other !== row && other.getAnimations().length > 0,
    );
  });
  expect(otherRowsMove).toBe(true);
  await expect(up).toBeFocused();
  await expectMotionSettled(row);
  await expect
    .poll(() =>
      up.evaluate((button) => {
        const scrollport = button
          .closest(".search-content")!
          .getBoundingClientRect();
        const focused = button.getBoundingClientRect();
        return (
          focused.top >= scrollport.top - 1 &&
          focused.bottom <= scrollport.bottom + 1
        );
      }),
    )
    .toBe(true);
});

test("free stops edit, reorder, reverse and cancel without changing the active plan", async ({
  page,
}) => {
  await setupVia(page);
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await page.locator("#adjust-route").click();
  for (const [i, name] of ["Café", "See", "Park"].entries()) {
    await addStop(page);
    await choose(page, `via-${i}`, name);
  }
  await expect(page.locator("#add-stop")).toBeDisabled();
  await page
    .getByRole("button", { name: "Zwischenziel 3 nach oben", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator("#via-fields > div:not([hidden]) input[type=search]")
        .evaluateAll((inputs) =>
          inputs.map((i) => (i as HTMLInputElement).value),
        ),
    )
    .toEqual(["Café", "Park", "See"]);
  await page.locator("#swap").click();
  await expect
    .poll(() =>
      page
        .locator("#via-fields > div:not([hidden]) input[type=search]")
        .evaluateAll((inputs) =>
          inputs.map((i) => (i as HTMLInputElement).value),
        ),
    )
    .toEqual(["See", "Park", "Café"]);
  await page
    .getByRole("button", { name: "Zwischenziel 2 entfernen", exact: true })
    .click();
  await expect(page.locator("#add-stop")).toBeEnabled();
  await page.locator("#cancel-adjust").click();
  expect(new URL(page.url()).searchParams.get("v")).toBe("3");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#via-fields > div:not([hidden])")).toHaveCount(0);
});

for (const width of [320, 393, 1280]) {
  test(`stop duration editor is compact, validates and preserves durations at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setupVia(page);
    await page.locator("#search-adjust").click();
    await choose(page, "origin", "Start");
    await choose(page, "destination", "Ziel");
    await addStop(page);
    await choose(page, "via-0", "Café");
    const toggle = page.locator(
      '.stop-stay-toggle[aria-controls="via-0-stay"]',
    );
    await expect(toggle).toHaveText("AufenthaltOhne Pause");
    await expect(
      page.getByRole("button", { name: "Zwischenziel 1 nach oben" }),
    ).toBeHidden();
    await expect(page.locator("#via-0-stay")).toBeHidden();
    for (const [hours, minutes, summary] of [
      ["0", "0", "Ohne Pause"],
      ["0", "15", "15 Min."],
      ["1", "0", "1 Std."],
      ["16", "40", "16 Std. 40 Min."],
      ["24", "0", "24 Std."],
    ]) {
      await toggle.click();
      await expect(page.locator("#via-0-hours")).toBeFocused();
      await page.locator("#via-0-hours").fill(hours);
      await page.locator("#via-0-minutes").fill(minutes);
      await toggle.click();
      await expect(page.locator("#via-0-stay")).toBeHidden();
      await expect(toggle).toContainText(summary);
      await page.locator("#search-adjust").click();
      await page.locator("#search-adjust").click();
      await expect(toggle).toContainText(summary);
      await expect(page.locator("#via-0-stay")).toBeHidden();
      await expect(page.locator("#via-0-hours")).toHaveValue(hours);
      await expect(page.locator("#via-0-minutes")).toHaveValue(minutes);
    }
    await page.screenshot({
      path: test.info().outputPath("stop-collapsed.png"),
    });
    await toggle.click();
    for (const [hours, minutes, field] of [
      ["-1", "0", "hours"],
      ["1.5", "0", "hours"],
      ["0", "60", "minutes"],
      ["24", "1", "minutes"],
    ]) {
      await page.locator("#via-0-hours").fill(hours);
      await page.locator("#via-0-minutes").fill(minutes);
      await page.locator("#calculate").click();
      await expect(page.locator("#via-0-stay-error")).toBeVisible();
      await expect(page.locator(`#via-0-${field}`)).toBeFocused();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    await page.locator("#via-0-hours").fill("");
    await page.locator("#via-0-minutes").fill("");
    await page.locator("#search-adjust").click();
    await page.locator("#search-adjust").click();
    await expect(toggle).toContainText("Ohne Pause");
    await expect(page.locator("#via-0-stay")).toBeVisible();
    await page.locator("#via-0-minutes").fill("15");
    await addStop(page);
    await choose(page, "via-1", "See");
    await page
      .getByRole("button", { name: "Zwischenziel 1 nach unten", exact: true })
      .click();
    await expect(page.locator("#via-0-stay")).toBeVisible();
    await expect(page.locator("#via-0-minutes")).toHaveValue("15");
    await expect(
      page.locator(".stop-heading label").filter({ hasText: "Zwischenziel 2" }),
    ).toHaveAttribute("for", "via-0");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator("#via-0-minutes").scrollIntoViewIfNeeded();
    expect(
      await page
        .locator("#route-editor")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("stop-expanded-large-text.png"),
    });
    await page
      .getByRole("button", { name: "Zwischenziel 2 entfernen", exact: true })
      .click();
    await expect(page.locator("#planner-more")).toBeFocused();
    await page.locator("#search-adjust").click();
    await page.locator("#search-adjust").click();
    await expect(page.locator("#via-1")).toHaveValue("See");
    await expect(page.locator("#via-0")).toBeHidden();
  });
}
test("mobile stop planning shares and reloads pauses and restores the complete offline trip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupVia(page);
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await addStop(page);
  await choose(page, "via-0", "Café");
  await page.locator('.stop-stay-toggle[aria-controls="via-0-stay"]').click();
  await page.locator("#via-0-minutes").fill("10");
  await page.locator("#search-adjust").click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("50 min");
  expect(new URL(page.url()).searchParams.get("v")).toBe("3");
  expect(new URL(page.url()).searchParams.get("via1Stay")).toBe("10");
  await expect(page.locator("#journey-detail")).toContainText(
    "Geplanter Aufenthalt: 10 min",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("50 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#via-0")).toHaveValue("Café");
  await expect(page.locator("#via-0-minutes")).toHaveValue("10");
  await page.locator("#cancel-adjust").click();
  await expect
    .poll(
      async () => (await page.locator("#journey-panel").boundingBox())!.height,
    )
    .toBeGreaterThan(550);
  await page.screenshot({
    path: `test-results/via-mobile-${test.info().project.name}.png`,
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("foldroute-offline", 2);
        return await new Promise((resolve) => {
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("state")) {
              db.close();
              resolve(false);
              return;
            }
            const tx = db.transaction("state");
            const saved = tx.objectStore("state").get("last");
            saved.onsuccess = () => resolve(saved.result?.version === 4);
            tx.oncomplete = () => db.close();
          };
          request.onerror = () => resolve(false);
        });
      }),
    )
    .toBe(true);
  // Simulate offline inside the page while leaving the local test server reachable.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", { get: () => false }),
  );
  await page.goto("/");
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("50 min");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open").first()).toContainText("Café");
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#journey-detail")).toContainText(
    "Geplanter Aufenthalt: 10 min",
  );
});

test("history deduplicates routes, restores without requests and replans from fixed points", async ({
  page,
  context,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator("#tab-route").click();
  await page.locator(".route-choice").last().click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.goto("/");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-open small")).toHaveCount(0);
  await expect(page.locator(".history-open strong")).toHaveCount(1);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests++;
  });
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = () => {
      throw new Error("Archive must not request location");
    };
  });
  await openCachedJourney(page, page.locator(".history-open").last());
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#route-origin")).toHaveText("Startpunkt");
  await page.goBack();
  await expect(page.locator("#history-view")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#saved-notice")).toBeVisible();
  expect(requests).toBe(0);
  await context.setOffline(true);
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#replan-saved")).toBeDisabled();
  expect(requests).toBe(0);
  await context.setOffline(false);
  const queried = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#replan-saved").click();
  const url = new URL((await queried).url());
  expect(url.searchParams.get("fromPlace")?.split(",").map(Number)).toEqual([
    48.132, 11.5756,
  ]);
  await expectPlanningComplete(page);
  await expect(page.locator("#saved-notice")).toBeHidden();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.screenshot({
    path: `test-results/history-${test.info().project.name}.png`,
  });
});

for (const width of [320, 393, 1280]) {
  test(`history offers accessible deletion and undo at ${width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 320 ? "light" : "dark" });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").click();
    await expect(page.locator(".history-origin")).toContainText("Startpunkt");
    await expect(page.locator(".history-destination")).toHaveText("Ziel");
    await expect(page.locator(".history-timestamp")).toHaveText(
      "Geplant heute, 10:00",
    );
    await expect(page.locator("#history-edit")).toHaveCount(0);
    const heading = await page.locator("#history-heading").boundingBox();
    expect(heading!.height > 1).toBe(width >= 900);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: test.info().outputPath("history-list.png") });
    const positions = () =>
      page
        .locator(".history-row")
        .evaluate((row) =>
          [
            row,
            ...row.querySelectorAll(
              ".history-origin, .history-destination, .history-chevron",
            ),
          ].map((element) => element.getBoundingClientRect().toJSON()),
        );
    const beforeHover = await positions();
    await page.locator(".history-open").hover();
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "1");
    expect(await positions()).toEqual(beforeHover);
    await page.mouse.move(0, 0);
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "0");
    await page.locator(".history-open").focus();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator(".history-remove")).toBeFocused();
    await expect(page.locator(".history-open")).toHaveCSS("transform", "none");
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: test.info().outputPath("history-delete.png"),
    });
    await page.keyboard.press("Enter");
    await expect(page.locator("#history-empty")).toBeVisible();
    await expect(page.locator("#history-heading")).toBeFocused();
    await expect(page.locator("#history-undo")).toBeVisible();
    await page.locator("#history-undo-button").click();
    await expect(page.locator(".history-open")).toBeFocused();
    await expect(page.locator("#history-undo")).toBeHidden();
    await openCachedJourney(page, page.locator(".history-open"));
    await expect(page.locator("#history-view")).toBeHidden();
  });
}
test("history deletion and disabling persist without restoring deleted calculations", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator(".route-choice").last().click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "data");
  await page.locator("#delete-saved").click();
  await page.locator("#cancel-delete-history").click();
  await expect(page.locator("#delete-saved")).toBeEnabled();
  await openSettingsSection(page, "data");
  await page.locator("#delete-saved").click();
  await page.locator("#confirm-delete-history").click();
  await expect(page.locator("#delete-saved")).toBeDisabled();
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung ausgeschaltet",
  );
  await page.goto("/");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await expect(page.locator("#history-empty")).toContainText(
    "Speicherung ausgeschaltet",
  );
});

test("history storage caps entries atomically and guards pending writes during deletion", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = (await store.read()).snapshot;
    await store.clear();
    const routeSnapshot = (i: number) => {
      const result = structuredClone(snapshot);
      result.request.destination.longitude += i * 0.001;
      result.savedAt += i;
      return result;
    };
    await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        store.save(routeSnapshot(i), `calculation-${i}`),
      ),
    );
    const full = await store.read();
    await store.save(
      {
        ...routeSnapshot(10),
        savedAt: snapshot.savedAt + 100,
        journey: { ...snapshot.journey, id: "changed" },
      },
      "calculation-10",
    );
    const updated = await store.read();
    const pending = store.save(snapshot, "late");
    await store.clear();
    await pending;
    const cleared = await store.read();
    await store.remove("deleted");
    await store.save(snapshot, "deleted");
    const afterDelete = await store.read();
    return {
      ids: full.entries.map((e: { id: string }) => e.id),
      count: updated.entries.length,
      selected: updated.entries.find(
        (e: { id: string }) => e.id === "calculation-10",
      ).snapshot.journey.id,
      cleared: cleared.entries.length,
      afterDelete: afterDelete.entries.length,
    };
  });
  expect(result.ids).toHaveLength(20);
  expect(result.ids[0]).toBe("calculation-20");
  expect(result.ids).not.toContain("calculation-0");
  expect(result.count).toBe(20);
  expect(result.selected).toBe("changed");
  expect(result.cleared).toBe(0);
  expect(result.afterDelete).toBe(0);
});

for (const width of [320, 390, 430, 1479]) {
  test(`results and itinerary keep actions accessible at ${width}px`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 844 });
    await plan(page);
    await expect(page.locator(".route-choice").first()).toBeInViewport({
      ratio: 1,
    });
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    await openSelectedDetails(page);
    await page
      .locator("#panel-content")
      .evaluate((e) => (e.scrollTop = e.scrollHeight));
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    if (width < 900) {
      await page.locator("#result-back").click();
      await expect(page.locator("#panel-details")).toBeHidden();
      await expect(
        page.locator(".route-choice-row.selected .route-detail-link"),
      ).toBeFocused();
    }
    await expect(page.locator("#route-more")).toBeVisible();
  });
}

test("small itinerary screens keep archived actions reachable", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  for (const [width, height, fontSize] of [
    [844, 390, 16],
    [390, 844, 24],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (size) => (document.documentElement.style.fontSize = `${size}px`),
      fontSize,
    );
    await page.locator("#route-more").scrollIntoViewIfNeeded();
    await page.locator("#replan-saved").scrollIntoViewIfNeeded();
    await expect(page.locator("#replan-saved")).toBeInViewport({ ratio: 1 });
    await page.locator("#route-more").click();
    await expect(page.locator("#navigation-start")).toBeInViewport({
      ratio: 1,
    });
    await page.keyboard.press("Escape");
    for (const id of ["adjust-route", "result-back"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
    }
  }
});

test("browser navigation restores itinerary, list and map without another search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/v6/plan")) requests++;
  });
  const selected = page.locator('.route-choice[aria-pressed="true"]');
  const id = await selected.getAttribute("data-journey");
  const historyLength = await page.evaluate(() => history.length);
  await selected.click();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await openSelectedDetails(page);
  await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 80));
  const scroll = await page
    .locator("#panel-content")
    .evaluate((e) => e.scrollTop);
  await showMap(page);
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
  await expect(page.locator("#panel-content")).toHaveJSProperty(
    "scrollTop",
    scroll,
  );
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await expect(selected).toHaveAttribute("data-journey", id!);
  await expect(
    page.locator(".route-choice-row.selected .route-detail-link"),
  ).toBeFocused();
  await page.goForward();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#map-preview")).toBeVisible();
  expect(requests).toBe(0);
});

for (const outcome of ["complete", "cancel", "error"] as const) {
  test(`route status spinner follows ${outcome} and respects reduced motion`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width: 390, height: 844 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v6/plan?*", async (route) => {
      const direct =
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE";
      if (!direct || outcome === "error") await gate;
      if (outcome === "error")
        await route.fulfill({ status: 500, headers: cors });
      else
        await route.fulfill({
          headers: cors,
          json: direct ? fixture.direct : fixture.multimodal,
        });
    });
    await choose(page, "destination", "Ziel");
    if (outcome !== "error")
      await expect(page.locator("#status")).toHaveText(
        "Verbindungen optimieren …",
      );
    else
      await expect(page.locator("#status")).toHaveText(
        "Verbindungen werden gesucht …",
      );
    const animation = () =>
      page
        .locator("#status")
        .evaluate((e) => getComputedStyle(e, "::before").animationName);
    await expect.poll(animation).toBe("route-loading");
    await expect(page.locator("#status")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    await expect.poll(animation).toBe("route-loading");
    await expect(page.locator("#status")).toBeVisible();
    await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(animation).toBe("none");
    expect(
      await page
        .locator("#status")
        .evaluate((e) => getComputedStyle(e, "::before").content),
    ).toBe('""');
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(animation).toBe("route-loading");
    if (outcome === "cancel") await page.locator("#close-route").click();
    release();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect.poll(animation).toBe("none");
    expect(
      await page
        .locator("#status")
        .evaluate((e) => getComputedStyle(e, "::before").content),
    ).toBe("none");
    if (outcome === "complete") {
      for (let i = 0; i < 3; i++) {
        await expectPlanningComplete(page);
      }
    } else if (outcome === "cancel") {
      await expect(page.locator("#destination")).toBeVisible();
      await expect(page.locator(".route-choice")).toHaveCount(0);
    } else {
      await expect(page.locator("#status")).toContainText("nicht beantworten");
      await expect(page.locator("#status")).toBeVisible();
    }
  });
}

test("history normalizes persisted duplicates and guards stable IDs against late updates", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const storagePath = "/src/storage.ts";
    const { localDatabase } = await import(storagePath);
    const store = new OfflineStore();
    const snapshot = (await store.read()).snapshot;
    const newer = { ...snapshot, savedAt: snapshot.savedAt + 10 };
    const db = await localDatabase.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(
        {
          version: 1,
          entries: [
            { id: "older", snapshot },
            { id: "stable", snapshot: newer },
          ],
        },
        "history",
      );
      tx.objectStore("state").put(snapshot, "last");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const normalized = await store.read();
    const persisted = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const history = tx.objectStore("state").get("history");
      const last = tx.objectStore("state").get("last");
      tx.oncomplete = () =>
        resolve({ history: history.result, last: last.result });
      tx.onabort = () => reject(tx.error);
    });
    await store.save(
      { ...newer, savedAt: newer.savedAt + 1 },
      "new-calculation",
    );
    const stable = (await store.read()).entries[0].id;
    const stale = await store.save(snapshot, "late");
    await store.remove(stable);
    const resurrected = await store.save(
      { ...newer, savedAt: newer.savedAt + 2 },
      "new-calculation",
    );
    const removed = (await store.read()).entries.length;
    const recreated = await store.save(
      { ...newer, savedAt: newer.savedAt + 3 },
      "deliberate-new-calculation",
    );
    return {
      invalid: normalized.invalid,
      normalized: normalized.entries.length,
      persisted: persisted.history.entries.length,
      last: persisted.last.savedAt === newer.savedAt,
      stable,
      stale,
      resurrected,
      removed,
      recreated,
    };
  });
  expect(result).toEqual({
    invalid: false,
    normalized: 1,
    persisted: 1,
    last: true,
    stable: "stable",
    stale: false,
    resurrected: false,
    removed: 0,
    recreated: true,
  });
});

test("history deletion during a pending recalculation does not resurrect the route", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (route) => {
    await gate;
    await route.fallback();
  });
  const started = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await started;
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  release();
  await expectPlanningComplete(page);
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
});

test("history deletion while locating survives the location response", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (success) => {
      (window as any).resolveHistoryLocation = () =>
        success({
          coords: { latitude: 48.132, longitude: 11.5756 },
        } as GeolocationPosition);
    };
  });
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  await page.locator("#tab-history").click();
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.evaluate(() => (window as any).resolveHistoryLocation());
  await expectPlanningComplete(page);
  await expect(page.locator(".history-row")).toHaveCount(0);
});

test("spinner rotation keeps scroll geometry stable in every panel size", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("directModes") !== "BIKE"
    )
      await gate;
    await route.fallback();
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen optimieren …");
  for (const [width, height, fontSize] of [
    [390, 844, 16],
    [515, 600, 16],
    [320, 568, 24],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size + "px";
    }, fontSize);
    for (const screen of ["list", "detail"]) {
      if (screen === "detail") await openSelectedDetails(page);
      await expectMotionSettled(page.locator("#panel-details"));
      await expectMotionSettled(page.locator("#choices"));
      await expectMotionSettled(page.locator("#panel-content"));
      const samples = await page.evaluate(async () => {
        const panel = document.getElementById("journey-panel")!;
        // Let measured fixed-header height select the normal or full-panel fallback.
        for (let frame = 0; frame < 3; frame++)
          await new Promise(requestAnimationFrame);
        const content = panel.classList.contains("result-scroll-all")
          ? panel
          : document.getElementById("panel-content")!;
        const probe = document.createElement("style");
        document.head.append(probe);
        const samples = [];
        for (const angle of [0, 45, 90, 135, 180, 225, 270, 315, 360]) {
          probe.textContent = `.journey-panel.is-loading #status::before {
            animation: none; transform: rotate(${angle}deg);
          }`;
          const actions = document
            .querySelector(".panel-actions")!
            .getBoundingClientRect();
          const bounds = panel.getBoundingClientRect();
          samples.push({
            scrollAll: content === panel,
            height: content.clientHeight,
            scrollHeight: content.scrollHeight,
            width: content.clientWidth,
            scrollWidth: content.scrollWidth,
            panelHeight: bounds.height,
            actionsTop: actions.top,
            actionsVisible:
              actions.top >= bounds.top && actions.bottom <= bounds.bottom,
          });
        }
        probe.remove();
        return samples;
      });
      for (const sample of samples) {
        expect(sample).toEqual(samples[0]);
        if (!sample.scrollAll) expect(sample.actionsVisible).toBe(true);
        expect(sample.scrollWidth).toBe(sample.width);
      }
      if (fontSize === 24 && screen === "detail") {
        expect(samples[0].scrollHeight).toBeGreaterThan(samples[0].height);
        const scroller = page.locator(
          samples[0].scrollAll ? "#journey-panel" : "#panel-content",
        );
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(await scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
        await expect(page.locator("#navigation-start")).toBeInViewport({
          ratio: 1,
        });
      }
      if (screen === "detail") await page.locator("#result-back").click();
    }
  }
  release();
  await expectPlanningComplete(page);
});

test("route markers identify endpoints and ordered stops with accessible popups", async ({
  page,
  context,
}) => {
  await setupVia(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  for (const [i, name] of ["Café", "See", "Park"].entries()) {
    await addStop(page);
    await choose(page, `via-${i}`, name);
  }
  await page.locator("#search-adjust").click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await showMap(page);
  await expect(page.locator("#map .route-marker")).toHaveCount(5);
  await expect(page.locator(".route-marker-stop")).toHaveText(["1", "2", "3"]);
  await expect(page.locator("#map .leaflet-tooltip")).toHaveCount(0);
  const marker = page.getByRole("button", {
    name: "Zwischenstopp 1: Café",
    exact: true,
  });
  const size = await marker.boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);
  await marker.click();
  await expect(page.locator(".route-marker-info")).toHaveText(
    "Zwischenstopp 1: Café",
  );
  await expect(page.locator("#panel-handle")).toHaveCount(0);
  await page.locator(".leaflet-popup-close-button").click();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".route-marker-info")).toHaveText(
    "Zwischenstopp 1: Café",
  );
  await page.locator(".leaflet-popup-close-button").click();
  await marker.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".route-marker-info")).toBeVisible();
  await page.locator(".leaflet-popup-close-button").click();

  await page.locator("#result-back").click();
  await page.locator("#adjust-route").click();
  await page
    .getByRole("button", { name: "Zwischenziel 3 nach oben", exact: true })
    .click();
  await page.locator("#swap").click();
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await showMap(page);
  await expect(
    page.getByRole("button", { name: "Start: Ziel", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "Ziel: Start", exact: true }),
  ).toBeAttached();
  for (const [i, name] of ["See", "Park", "Café"].entries())
    await expect(
      page.getByRole("button", {
        name: `Zwischenstopp ${i + 1}: ${name}`,
        exact: true,
      }),
    ).toBeAttached();
  await expectPlanningComplete(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toHaveCount(2);
  await context.setOffline(true);
  await openCachedJourney(page, page.locator(".history-open").first());
  await showMap(page);
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await expect(page.locator("#map .route-marker")).toHaveCount(5);
  await expect(page.locator(".route-marker-stop")).toHaveText(["1", "2", "3"]);
  await page.screenshot({
    path: `test-results/route-markers-${test.info().project.name}.png`,
  });
});

test("coincident route places share their symbols and safely rendered place names", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const modulePath = "/src/map-view.ts";
    const { RouteMap } = await import(modulePath);
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    const origin = {
      name: "<img src=x onerror=alert(1)>",
      detail: "",
      latitude: 48.132,
      longitude: 11.5756,
    };
    const stop = { id: "same", place: origin, stayMinutes: 0 };
    const journey = {
      id: "coincident",
      origin,
      destination: origin,
      departure: 1000,
      arrival: 1060,
      transfers: 0,
      isDirect: true,
      legs: [
        {
          kind: "stop",
          stop,
          from: origin,
          to: origin,
          start: 1000,
          end: 1060,
          distance: 0,
          coordinates: [origin],
        },
      ],
    };
    const map = new RouteMap(
      () => {},
      () => {
        document.getElementById("journey-panel")!.dataset.size = "collapsed";
      },
    );
    map.show([journey], journey, false);
  });
  await expect(page.locator("#map .route-marker")).toHaveCount(1);
  await expect(page.locator(".route-marker-start")).toHaveCount(1);
  await expect(page.locator(".route-marker-destination")).toHaveCount(1);
  await expect(page.locator(".route-marker-stop")).toHaveText("1");
  await page.locator("#map .route-marker").click();
  await expect(page.locator(".route-marker-info p")).toHaveText([
    "Start: <img src=x onerror=alert(1)>",
    "Zwischenstopp 1: <img src=x onerror=alert(1)>",
    "Ziel: <img src=x onerror=alert(1)>",
  ]);
  await expect(page.locator(".route-marker-info img")).toHaveCount(0);
  await expect(page.locator("#panel-handle")).toHaveCount(0);
});

for (const outcome of ["success", "cancel", "error"] as const) {
  test(`native share handles ${outcome} and prevents duplicate requests`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.evaluate(() => {
      const state = {
        calls: 0,
        copied: "",
        data: null as unknown,
        finish: (_outcome: string) => {},
      };
      (window as any).shareProbe = state;
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: (data: unknown) => {
          state.calls++;
          state.data = data;
          return new Promise<void>((resolve, reject) => {
            state.finish = (outcome) => {
              if (outcome === "success") resolve();
              else
                reject(
                  new DOMException(
                    outcome,
                    outcome === "cancel" ? "AbortError" : "NotAllowedError",
                  ),
                );
            };
          });
        },
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            state.copied = text;
          },
        },
      });
    });
    await page.locator("#route-more").click();
    await page
      .getByRole("button", { name: "Planung teilen", exact: true })
      .click();
    await expect(page.locator("#share-plan")).toBeDisabled();
    await page
      .locator("#share-plan")
      .evaluate((e: HTMLButtonElement) => e.click());
    expect(await page.evaluate(() => (window as any).shareProbe.calls)).toBe(1);
    expect(await page.evaluate(() => (window as any).shareProbe.data)).toEqual({
      title: "FoldRoute",
      url: page.url(),
    });
    await page.evaluate(
      (outcome) => (window as any).shareProbe.finish(outcome),
      outcome,
    );
    await expect(page.locator("#share-plan")).toBeEnabled();
    expect(await page.evaluate(() => (window as any).shareProbe.copied)).toBe(
      outcome === "error" ? page.url() : "",
    );
    await expect(page.locator("#plan-link-fallback")).toBeHidden();
  });
}

test("desktop actions menu supports keyboard sharing and manual copying", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1280, height: 844 });
  await plan(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    document.documentElement.style.fontSize = "24px";
  });
  {
    await page.locator("#route-more").click();
    await page.locator("#share-plan").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#plan-link-value")).toBeVisible();
    await expect(page.locator("#plan-link-value")).toBeFocused();
    await expect(page.locator("#plan-link-value")).toHaveValue(page.url());
    await expect(page.locator("#route-actions-dialog")).not.toBeVisible();
    await expect(page.locator("#route-more")).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1280);
  }
  await page.screenshot({
    path: `test-results/share-panel-${test.info().project.name}.png`,
  });
});

async function expectRouteFits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = document.getElementById("map")!.getBoundingClientRect();
        const panel = document
          .getElementById("journey-panel")!
          .getBoundingClientRect();
        const left = innerWidth >= 900 ? panel.right : map.left;
        const bottom = innerWidth >= 900 ? map.bottom : panel.top;
        const controls = document
          .getElementById("map-controls")!
          .getBoundingClientRect();
        return [...document.querySelectorAll("#map .route-marker")].every(
          (element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= left - 1 &&
              box.right <= controls.left - 8 + 1 &&
              box.top >= map.top - 1 &&
              box.bottom <= bottom + 1
            );
          },
        );
      }),
    )
    .toBe(true);
}

for (const [width, height] of [
  [320, 844],
  [844, 390],
  [1479, 986],
]) {
  test(`route fit restores the route and preserves panel state at ${width}x${height}`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height });
    // A fixed origin avoids unrelated, asynchronous history address lookups
    // while this test asserts that map fitting makes no API requests.
    await page.locator("#search-adjust").click();
    await choose(page, "origin", "Start");
    await page.locator("#search-adjust").click();
    await plan(page);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = () => {
        throw new Error("Route fit must not request GPS");
      };
    });
    await showMap(page);
    await expectRouteFits(page);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator("#map").focus();
      await page.keyboard.press("+");
      await page.keyboard.press("ArrowLeft");
      await page.locator("#panel-content").evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      const scroll = await page
        .locator("#panel-content")
        .evaluate((e) => e.scrollTop);
      await page
        .getByRole("button", { name: /^(Gesamte Route|Alle Routen) anzeigen$/ })
        .click();
      await expectRouteFits(page);
      await expect(page.locator("#map")).toHaveJSProperty("inert", false);
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
      const location = (await page.locator("#map-location").boundingBox())!;
      const route = (await page.locator("#map-route").boundingBox())!;
      expect(route.x).toBe(location.x);
      expect(route.y - location.y - location.height).toBe(8);
      expect([
        route.width,
        route.height,
        location.width,
        location.height,
      ]).toEqual([48, 48, 48, 48]);
      const hadTouchClass = await page
        .locator("#map")
        .evaluate((map) => map.classList.contains("leaflet-touch"));
      for (const touch of [false, true]) {
        await page.locator("#map").evaluate((map, enabled) => {
          map.classList.toggle("leaflet-touch", enabled);
        }, touch);
        const zoom = (await page
          .locator(".leaflet-control-zoom")
          .boundingBox())!;
        expect(zoom.x + zoom.width / 2).toBeCloseTo(
          route.x + route.width / 2,
          1,
        );
        expect(zoom.y).toBeGreaterThanOrEqual(route.y + route.height);
      }
      await page.locator("#map").evaluate((map, enabled) => {
        map.classList.toggle("leaflet-touch", enabled);
      }, hadTouchClass);
      if (width < 900) {
        const panel = (await page.locator("#journey-panel").boundingBox())!;
        expect(route.y + route.height).toBeLessThanOrEqual(panel.y);
      }
      await expect(page.locator("#map-route")).toBeInViewport({ ratio: 1 });
    }
    // Leaflet finishes its keyboard zoom on an animation frame after input.
    await page.waitForTimeout(350);
    await expectRouteFits(page);
    expect(requests).toEqual([]);
    await page.screenshot({
      path: `test-results/route-fit-${width}-${test.info().project.name}.png`,
    });
    if (width < 900) await page.locator("#result-back").click();
    await page.locator("#close-route").click();
    await expect(page.locator("#map-route")).toBeHidden();
  });
}

test("route fit overrides a pending location response and works offline with stops", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    let next = 0;
    navigator.geolocation.watchPosition = (success) => {
      (window as any).finishMapLocation = () =>
        success({
          coords: { latitude: 52.52, longitude: 13.405, accuracy: 10 },
          timestamp: Date.now(),
        } as GeolocationPosition);
      return ++next;
    };
    navigator.geolocation.clearWatch = () => {};
  });
  await setupVia(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await addStop(page);
  await choose(page, "via-0", "Café");
  await page.locator("#search-adjust").click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await showMap(page);
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location")).toBeDisabled();
  await page.locator("#map-route").click();
  await expect(page.locator("#map-location")).toBeEnabled();
  await expectRouteFits(page);
  await page.evaluate(() => (window as any).finishMapLocation());
  await expectRouteFits(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toHaveCount(1);
  await context.setOffline(true);
  await openCachedJourney(page, page.locator(".history-open"));
  await showMap(page);
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await page.locator("#map-route").focus();
  await page.keyboard.press("Enter");
  await expectRouteFits(page);
  await expect(page.locator(".route-marker-stop")).toHaveText("1");
});

for (const width of [390, 1479]) {
  for (const archived of [false, true]) {
    test(`map background leaves result navigation unchanged at ${width}, archived=${archived}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 986 });
      await setup(page);
      await plan(page);
      if (archived) {
        await page.locator("#tab-history").click();
        await openCachedJourney(page, page.locator(".history-open").first());
      }
      await showMap(page);
      const panel = page.locator("#journey-panel");
      const initial = await panel.boundingBox();
      await page
        .locator("#map")
        .click({ position: { x: width >= 900 ? width - 140 : 20, y: 60 } });
      expect(await panel.boundingBox()).toEqual(initial);
      await expect(page.locator("#panel-handle")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("stable-map.png") });
    });
  }
}

for (const width of [320, 390, 430]) {
  test(`mobile preview edits in its header and starts in its footer at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await plan(page);
    await expectPlanningComplete(page);
    await expect(page.locator("#share-plan")).toBeHidden();
    await expect(page.locator("#refresh-route")).toBeHidden();
    await expect(page.locator(".panel-tools #close-route")).toBeVisible();
    await expect(page.locator(".panel-actions #navigation-start")).toHaveText(
      "Los",
    );
    await expect(page.locator(".panel-actions #adjust-route")).toHaveCount(0);
    await page.locator("#adjust-route").click();
    const request = page.waitForRequest("**/api/v6/plan?*");
    await page.locator("#calculate").click();
    await request;
    await expectPlanningComplete(page);
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(page.locator(".panel-tools #close-route")).toBeVisible();
    await page.locator("#route-more").click();
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#route-more")).toBeFocused();
    await page.locator("#close-route").click();
    await expect(page.locator("#destination")).toBeVisible();
    await expect(page.locator("#destination")).toBeFocused();
    await expect(page.locator("#map-view")).toBeHidden();
  });
}

test("new GPS planning enriches history without renaming the active origin", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(
      navigator.geolocation,
    );
    (window as any).gpsRequests = 0;
    navigator.geolocation.getCurrentPosition = (...args) => {
      (window as any).gpsRequests++;
      return original(...args);
    };
  });
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({
      headers: cors,
      json: [
        {
          type: "ADDRESS",
          lat: 48.132,
          lon: 11.5756,
          street: "Marienplatz",
          houseNumber: "22",
          areas: [{ name: "München", default: true }],
        },
      ],
    }),
  );
  await plan(page);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await expect(page.locator("#result-context")).toHaveText(
    "Aktueller Standort → Ziel",
  );
  await expect(page.locator("#adjust-route")).toHaveAccessibleDescription(
    /Aktueller Standort Ziel/,
  );
  const gpsRequests = await page.evaluate(() => (window as any).gpsRequests);
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  expect(
    await page.evaluate(() => (window as any).gpsRequests),
  ).toBeGreaterThan(gpsRequests);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
  await page
    .locator("#route-editor")
    .evaluate((dialog: HTMLDialogElement) => dialog.close());
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open").first()).toContainText(
    "Marienplatz 22, München",
  );
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#route-origin")).toHaveText(
    "Marienplatz 22, München",
  );
  await page.locator("#adjust-route").click();
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Start");
  await page.locator("#adjust-route").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeEnabled();
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
});

test("mobile refresh returns to comparison and preserves old results on failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await openSelectedDetails(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v6/plan?*", async (route) => {
    await gate;
    await route.fulfill({ status: 503, headers: cors });
  });
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await expect(page.locator("#stale-notice")).toBeVisible();
  await expect(page.locator(".route-choice").first()).toBeVisible();
  release();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#stale-notice")).toBeVisible();
  await expect(page.locator("#refresh-route")).toHaveText("Erneut versuchen");
  await openSelectedDetails(page);
  await expect(page.locator("#journey-heading")).toContainText("32 min");
});

for (const width of [320, 390]) {
  for (const fromDetail of [false, true]) {
    test(`map actions separate comparison and details at ${width}, fromDetail=${fromDetail}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 650 });
      await setup(page);
      await plan(page);
      const selected = page.locator(".route-choice").last();
      await selected.click();
      const id = await selected.getAttribute("data-journey");
      const scrollPosition = () =>
        page.evaluate(() => {
          const panel = document.getElementById("journey-panel")!;
          return (
            panel.classList.contains("result-scroll-all")
              ? panel
              : document.getElementById("panel-content")!
          ).scrollTop;
        });
      const position = await scrollPosition();
      let requests = 0;
      page.on("request", (request) => {
        if (request.url().includes("/api/v6/plan?")) requests++;
      });
      if (fromDetail) await openSelectedDetails(page);
      await showMap(page);
      await expect(page.locator("#result-back")).toHaveText(
        "‹ Alle Verbindungen",
      );
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect(selected).toBeFocused();
      await expect.poll(scrollPosition).toBe(position);
      await page.goBack();
      await expect(page.locator("#map-view")).toHaveAttribute(
        "data-result-screen",
        "map",
      );
      await page.goForward();
      await expect(page.locator("#choices")).toBeVisible();
      await expect(selected).toHaveAttribute("data-journey", id!);
      await showMap(page);
      await page.locator("#map-open-details").click();
      await expect(page.locator("#panel-details")).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      expect(requests).toBe(0);
    });
  }
}

for (const origin of ["history", "search"]) {
  test(`saved map returns to Strecken from ${origin}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").click();
    await expect(page.locator(".history-open")).toHaveCount(1);
    if (origin === "search") {
      await page.goto("/");
      await openCachedJourney(page, page.locator("#open-saved"));
    } else await openCachedJourney(page, page.locator(".history-open"));
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v6/plan?")) requests++;
    });
    await showMap(page);
    await expect(page.locator("#result-back")).toHaveText("‹ Strecken");
    await page.locator("#result-back").click();
    await expect(page.locator("#history-view")).toBeVisible();
    await expect(page.locator(".history-open")).toBeFocused();
    await page.goBack();
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "map",
    );
    await page.goForward();
    await expect(page.locator("#history-view")).toBeVisible();
    await page.goBack();
    await page.locator("#map-open-details").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    expect(requests).toBe(0);
  });
}

test("map itinerary action returns directly to comparison after reading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await openSelectedDetails(page);
  await showMap(page);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
  await showMap(page);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
});

test("browser back closes the route actions dialog with the preview", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#route-more").click();
  await expect(page.locator("#route-actions-dialog")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#route-actions-dialog")).toBeHidden();
  await expect(page.locator("#search-view")).toBeVisible();
});

test("history undo preserves snapshots, blocks late writes and respects replacement and clearing", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const base = (await store.read()).snapshot;
    await store.clear();
    await store.save(base, "original");
    const before = (await store.read()).entries[0];
    const token = await store.remove(before.id);
    const restored = await store.restoreDeleted(token);
    const after = (await store.read()).entries[0];
    const late = await store.save(
      { ...base, savedAt: base.savedAt + 1 },
      "original",
    );
    const newerToken = await store.remove(before.id);
    await store.save({ ...base, savedAt: base.savedAt + 2 }, "newer");
    const newer = await store.restoreDeleted(newerToken);
    const current = (await store.read()).entries[0].id;
    const clearedToken = await store.remove(current);
    await store.clear();
    const cleared = await store.restoreDeleted(clearedToken);
    await store.save(base, "disable");
    const disabledToken = await store.remove("disable");
    await store.setEnabled(false);
    await store.setEnabled(true);
    const disabled = await store.restoreDeleted(disabledToken);
    await store.save(base, "capacity");
    const capacityToken = await store.remove("capacity");
    for (let i = 1; i <= 20; i++) {
      const snapshot = structuredClone(base);
      snapshot.request.destination.longitude += i * 0.01;
      await store.save(snapshot, `other-${i}`);
    }
    const full = await store.restoreDeleted(capacityToken);
    return {
      restored,
      exact: JSON.stringify(before) === JSON.stringify(after),
      late,
      newer,
      current,
      cleared,
      disabled,
      full,
      count: (await store.read()).entries.length,
    };
  });
  expect(result).toEqual({
    restored: "restored",
    exact: true,
    late: false,
    newer: "newer",
    current: "newer",
    cleared: "unavailable",
    disabled: "unavailable",
    full: "unavailable",
    count: 20,
  });
});

test("history undo expires and storage failure keeps the row", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await page.locator(".history-remove").focus();
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as any).restoreHistoryTransactions = () => {
      IDBDatabase.prototype.transaction = original;
    };
    IDBDatabase.prototype.transaction = function () {
      throw new Error("Storage unavailable");
    };
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#toast")).toContainText("nicht gelöscht");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator("#history-undo")).toBeHidden();
  await page.evaluate(() => (window as any).restoreHistoryTransactions());
  await page.keyboard.press("Enter");
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#history-undo-button").focus();
  await page.clock.fastForward(9000);
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#tab-history").focus();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(8100);
  await expect(page.locator("#history-undo")).toBeHidden();
});

test.describe("history touch gestures", () => {
  test.use({ hasTouch: true, viewport: { width: 393, height: 852 } });

  // Synthetic pointer input allows the same gesture checks in Chromium and WebKit.
  // Native pointer capture is stubbed because synthetic pointers aren't OS-owned.
  async function swipe(page: Page, dx: number, dy = 0) {
    await expect(page.locator(".history-row").first()).toBeVisible();
    await page.evaluate(
      ({ dx, dy }) => {
        const row = document.querySelector<HTMLElement>(".history-row")!;
        row.setPointerCapture = () => {};
        const target = row.querySelector(".history-open")!;
        const send = (type: string, x: number, y: number) =>
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: "touch",
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        send("pointerdown", 250, 200);
        send("pointermove", 250 + dx, 200 + dy);
        // Implicit capture on the child is released when the row takes over.
        send("lostpointercapture", 250 + dx, 200 + dy);
        send("pointerup", 250 + dx, 200 + dy);
        if (Math.abs(dx) > Math.abs(dy))
          target.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
      },
      { dx, dy },
    );
  }
  test("native touch keeps dragging across pointer capture transfer", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Native touch injection uses CDP; capture regression also covered in WebKit below.",
    );
    await setup(page);
    await plan(page);
    await page.evaluate(() =>
      localStorage.setItem("foldroute.historySwipeSeen.v1", "true"),
    );
    await page.reload();
    await page.locator("#tab-history").tap();
    const row = page.locator(".history-row").first();
    await expect(row).toBeVisible();
    let box!: { x: number; y: number; width: number; height: number };
    await expect
      .poll(async () => {
        const bounds = await row.boundingBox();
        if (bounds) box = bounds;
        return bounds?.width ?? 0;
      })
      .toBeGreaterThan(100);
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width - 35,
      y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (const distance of [15, 30, 50, 75, 95])
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - distance, y }],
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(row).toHaveClass(/swipe-open/);
    await expect(page.locator("#history-view")).toBeVisible();
    await page.locator(".history-remove").tap();
    await expect(page.locator(".history-row")).toHaveCount(0);
    await client.detach();
  });
  test("swipe reveals only; vertical scroll and short drag do not open or delete", async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.evaluate(() =>
      localStorage.setItem("foldroute.historySwipeSeen.v1", "true"),
    );
    await page.reload();
    await page.locator("#tab-history").click();
    await swipe(page, -15, 70);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -20);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await expect(page.locator(".history-row")).toHaveClass(/swipe-open/);
    await expect(page.locator("#history-view")).toBeVisible();
    await expect(page.locator(".history-row")).toHaveCount(1);
    await swipe(page, 80);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await page.keyboard.press("Escape");
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await page.locator(".history-remove").tap();
    await expect(page.locator(".history-row")).toHaveCount(0);
    await page.locator("#history-undo-button").tap();
    await expect(page.locator(".history-row")).toHaveCount(1);
  });
  test("losing the row capture still cancels the gesture", async ({ page }) => {
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await page
      .locator(".history-row")
      .first()
      .evaluate((row) => {
        row.setPointerCapture = () => {};
        const child = row.querySelector(".history-open")!;
        const event = (type: string, x: number) =>
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 9,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: x,
            clientY: 100,
          });
        child.dispatchEvent(event("pointerdown", 250));
        child.dispatchEvent(event("pointermove", 170));
        row.dispatchEvent(event("lostpointercapture", 170));
        row.dispatchEvent(event("pointerup", 170));
      });
    await expect(page.locator(".history-row")).not.toHaveClass(
      /swipe-open|swipe-dragging/,
    );
    await expect(page.locator("#history-view")).toBeVisible();
  });
  test("first visit animates once and interruption cannot open the journey", async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await expect(page.locator(".swipe-demo")).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("foldroute.historySwipeSeen.v1"),
        ),
      )
      .toBe("true");
    await page.locator(".history-open").tap();
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
    await expect(page.locator("#history-view")).toBeVisible();
    await page.reload();
    await page.locator("#tab-history").tap();
    await page.clock.fastForward(2500);
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
  });
  test("reduced motion skips demonstration without disabling deletion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await page.clock.fastForward(2500);
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("foldroute.historySwipeSeen.v1"),
      ),
    ).toBeNull();
    await swipe(page, -90);
    await expect(page.locator(".history-row")).toHaveClass(/swipe-open/);
    await expect(page.locator(".history-open")).toHaveCSS(
      "transition-duration",
      "0s",
    );
  });
});

test("history undo restores only the latest deletion and clearing invalidates it", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = structuredClone((await store.read()).snapshot);
    snapshot.request.destination.longitude += 0.05;
    snapshot.request.destination.name = "Anderes Ziel";
    snapshot.journey.destination.name = "Anderes Ziel";
    snapshot.savedAt += 1;
    await store.save(snapshot, "second");
  });
  await page.reload();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(2);
  await page.locator(".history-remove").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#history-undo-button").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-destination")).toHaveText("Ziel");
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#history-undo")).toBeHidden();
});

test("desktop history keeps long routes readable beside delete action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 852 });
  await setup(page);
  await plan(page);
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = structuredClone((await store.read()).snapshot);
    const origin =
      "Daglfinger Straße 99a, München – Eingang am Fahrradparkplatz";
    const destination = "Frankfurt (Main) Süd – Ausgang zur Schweizer Straße";
    snapshot.request.origin.name = snapshot.journey.origin.name = origin;
    snapshot.request.destination.name = snapshot.journey.destination.name =
      destination;
    await store.clear();
    await store.save(snapshot, "long-route");
  });
  await page.reload();
  await page.locator("#tab-history").click();
  const row = page.locator('.history-row[data-history-id="long-route"]');
  await expect(row).toBeVisible();
  await row.hover();
  await expect(row.locator(".history-remove")).toHaveCSS("opacity", "1");
  expect(
    await row.evaluate((element) => {
      const button = element.querySelector(".history-open")!;
      const content = button.getBoundingClientRect();
      const action = element
        .querySelector(".history-remove")!
        .getBoundingClientRect();
      return (
        button.scrollWidth <= button.clientWidth &&
        content.right + 12 <= action.left &&
        action.width >= 44 &&
        action.height >= 44
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("history-desktop-long-route.png"),
  });
  await row.locator(".history-remove").click();
  await expect(row).toHaveCount(0);
  await page.locator("#history-undo-button").click();
  await expect(row.locator(".history-destination")).toContainText(
    "Frankfurt (Main) Süd",
  );
});

test("successful save retry clears its error without a success message", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const save = OfflineStore.prototype.save;
    (window as any).failJourneySave = true;
    OfflineStore.prototype.save = function (...args: any[]) {
      if ((window as any).failJourneySave)
        return Promise.reject(new Error("Storage blocked"));
      return save.apply(this, args);
    };
  });
  await plan(page);
  await expect(page.locator("#storage-message")).toContainText(
    "nicht offline gespeichert",
  );
  await page.evaluate(() => {
    (window as any).failJourneySave = false;
  });
  await page.locator("#close-route").click();
  await plan(page);
  await expectSelectedJourneySaved(page);
  await expect(page.locator("#storage-message")).toBeEmpty();
  await expect(page.locator("#toast")).toBeHidden();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#storage-message")).toBeHidden();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung ausgeschaltet",
  );
  await page.locator("#offline-enabled").check();
  await expect(page.locator("#storage-message")).toBeEmpty();
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#offline-enabled")).toBeEnabled();
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const setEnabled = OfflineStore.prototype.setEnabled;
    OfflineStore.prototype.setEnabled = function (...args: any[]) {
      OfflineStore.prototype.setEnabled = setEnabled;
      return Promise.reject(new Error("Storage blocked"));
    };
  });
  await page.locator("#offline-enabled").click();
  await expect(page.locator("#storage-message")).toContainText(
    "Offline-Einstellung konnte nicht gespeichert",
  );
  await expect(page.locator("#offline-enabled")).toBeChecked();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung ausgeschaltet",
  );
  await page.locator("#offline-enabled").check();
  await expect(page.locator("#storage-message")).toBeEmpty();
  await expect(page.locator("#toast")).toBeHidden();
});

test("silent storage success preserves an unrelated settings warning", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "foldroute.routing.v3")
        throw new DOMException("Blocked", "SecurityError");
      return getItem.call(this, key);
    };
  });
  await setup(page);
  await expect(page.locator("#storage-message")).toContainText(
    "nur für diese Sitzung",
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expectSelectedJourneySaved(page);
  await expect(page.locator("#storage-message")).toContainText(
    "nur für diese Sitzung",
  );
  await page.locator("#tab-settings").click();
  await page.locator("#cyclingSpeedKilometersPerHour").fill("20");
  await page.locator("#cyclingSpeedKilometersPerHour").blur();
  await expect(page.locator("#storage-message")).toBeEmpty();
  await expect(page.locator("#toast")).toBeHidden();
});
