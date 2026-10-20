import { expect, type Page } from "@playwright/test";
import { defaults, type RoutingSettings } from "../../src/model";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
import { openApp } from "./app-fixture";
import { expectPlanningComplete } from "./assertions";

export { fixture };
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
};
export const places = [
  { name: "Start", lat: 48.132, lon: 11.5756 },
  { name: "Ziel", lat: 48.175, lon: 11.6 },
];

export async function setup(
  page: Page,
  geolocation = true,
  settings: Partial<RoutingSettings> = {},
) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  if (geolocation) {
    await page.context().grantPermissions(["geolocation"]);
    await page
      .context()
      .setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  }
  // Native geolocation timestamps use the host clock; keep them on page time.
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
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({ headers: cors, json: [] }),
  );
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({ headers: cors, json: places }),
  );
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({
      headers: cors,
      json:
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await openApp(page, { ...defaults, maxCyclingMinutes: 60, ...settings });
}

export async function choose(page: Page, id: string, name: string) {
  await page.locator(`#${id}`).fill(name);
  await page
    .locator(`#${id}-options .place-select`)
    .filter({ hasText: name })
    .click();
}

export async function plan(page: Page) {
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expectPlanningComplete(page);
}

// Observe the actual application task, including response parsing, generator
// consumption and synchronous UI updates. A fulfilled HTTP request alone does
// not establish that a late result has been accepted or discarded.
export async function trackPlanning(page: Page) {
  await page.evaluate(async () => {
    const { PlanningSession } = await import("/src/planning-state.ts");
    const calculate = PlanningSession.prototype.calculate;
    const runs: Promise<unknown>[] = [];
    (window as any).planningRuns = runs;
    PlanningSession.prototype.calculate = function (...args) {
      const task = calculate.apply(this, args);
      runs.push(task);
      return task;
    };
  });
  return {
    finished: (index = 0) =>
      page.evaluate(async (index) => {
        const task = (window as any).planningRuns[index];
        if (!task) throw new Error(`Planning run ${index} never started`);
        await task;
      }, index),
  };
}

export async function runMapClock(page: Page) {
  // Leaflet measures RAF pan duration with Date. A fixed Date would keep its
  // animation alive forever, even though real animation frames keep running.
  await page.clock.setSystemTime(await page.evaluate(() => Date.now()));
}

export async function expectMapSettled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const map = document.getElementById("map")!;
        const panel = document.getElementById("journey-panel")!;
        const sample = () =>
          JSON.stringify(
            [map, panel, ...map.querySelectorAll(".route-marker")].map(
              (element) => {
                const box = element.getBoundingClientRect();
                return [box.x, box.y, box.width, box.height];
              },
            ),
          );
        const before = sample();
        // Zoom starts on the next RAF; ResizeObserver can schedule a follow-up
        // fit. Observe both frames before declaring the geometry stable.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return (
          !map.querySelector(".leaflet-pan-anim, .leaflet-zoom-anim") &&
          !panel
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running") &&
          before === sample()
        );
      }),
    )
    .toBe(true);
}

export async function expectRouteFitUnchanged(page: Page) {
  await expectMapSettled(page);
  const positions = () =>
    page.locator("#map .route-marker").evaluateAll((markers) =>
      markers.map((marker) => {
        const { x, y } = marker.getBoundingClientRect();
        return { x, y };
      }),
    );
  const initial = await positions();
  expect(initial.length).toBeGreaterThan(0);
  for (let click = 0; click < 2; click++) {
    await page.locator("#map-route").click();
    await expectMapSettled(page);
    const current = await positions();
    expect(current).toHaveLength(initial.length);
    current.forEach((position, index) => {
      expect(Math.abs(position.x - initial[index].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(position.y - initial[index].y)).toBeLessThanOrEqual(1);
    });
  }
}

export function shiftedTransitFixture(minutes: number) {
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

export async function expectRecoveryButtons(page: Page, actionId: string) {
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

export async function locationCenterError(page: Page) {
  return page.evaluate(() => {
    const map = document.getElementById("map")!.getBoundingClientRect(),
      panel = document.getElementById("journey-panel")!.getBoundingClientRect(),
      marker = document
        .querySelector("#map .route-marker-start")!
        .getBoundingClientRect(),
      safe = getComputedStyle(document.getElementById("map-view")!),
      sidebar =
        innerWidth >= 900 ||
        safe.getPropertyValue("--map-panel-layout").trim() === "side";
    const x = sidebar
        ? (panel.right + map.right - parseFloat(safe.paddingRight)) / 2
        : (map.left +
            map.right +
            parseFloat(safe.paddingLeft) -
            parseFloat(safe.paddingRight)) /
          2,
      y = sidebar
        ? (map.top +
            map.bottom +
            parseFloat(safe.paddingTop) -
            parseFloat(safe.paddingBottom)) /
          2
        : (map.top + panel.top + parseFloat(safe.paddingTop)) / 2;
    return Math.hypot(
      marker.x + marker.width / 2 - x,
      marker.y + marker.height / 2 - y,
    );
  });
}

export function viaPolyline(points: number[][]): string {
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

export async function setupVia(page: Page) {
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

export async function expectRouteFits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = document.getElementById("map")!.getBoundingClientRect();
        const panel = document
          .getElementById("journey-panel")!
          .getBoundingClientRect();
        const safe = getComputedStyle(document.getElementById("map-view")!);
        const sidebar =
          innerWidth >= 900 ||
          safe.getPropertyValue("--map-panel-layout").trim() === "side";
        const left = sidebar
          ? panel.right
          : map.left + parseFloat(safe.paddingLeft);
        const top = map.top + parseFloat(safe.paddingTop);
        const bottom = sidebar
          ? map.bottom - parseFloat(safe.paddingBottom)
          : panel.top;
        const controls = document
          .getElementById("map-controls")!
          .getBoundingClientRect();
        return [...document.querySelectorAll("#map .route-marker")].every(
          (element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= left - 1 &&
              box.right <= controls.left - 8 + 1 &&
              box.top >= top - 1 &&
              box.bottom <= bottom + 1
            );
          },
        );
      }),
    )
    .toBe(true);
}
