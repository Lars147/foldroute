import { expectPlanningComplete } from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import { defaults, type Journey } from "../../src/model";
import type { PlanningState } from "../../src/planning-state";
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
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  if (geolocation) {
    await page.context().grantPermissions(["geolocation"]);
    await page
      .context()
      .setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  }
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
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
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expectPlanningComplete(page);
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
    await page.locator("#map-location").click({ position: { x: 24, y: 4 } });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    for (const size of ["expanded", "normal", "expanded"]) {
      await page.locator("#panel-size").click();
      await expect(page.locator("#journey-panel")).toHaveAttribute(
        "data-size",
        size,
      );
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
      // Check after the CSS transition too, not only at its first frame.
      await page.waitForTimeout(300);
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    // A very short landscape viewport can leave no usable map at all.
    // Keep the focus for when the map becomes visible again.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    await expect(page.locator("html")).toHaveAttribute(
      "data-location-calls",
      "1",
    );
  });

test("manual map gestures release location focus; button restores it and route change resets it", async ({
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
  await page.locator("#panel-size").click();
  await page.waitForTimeout(300);
  // Route fitting may move the marker again during the panel transition;
  // only continued location centering (within 2px) would be a regression.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator("#panel-size").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".leaflet-control-zoom-in").click();
  await page.waitForTimeout(300);
  await page.locator("#panel-size").click();
  await page.waitForTimeout(300);
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".route-choice").last().click();
  // Expanded details intentionally defer fitting the tiny remaining map area.
  // Return to the overview to observe that the route change released focus.
  await page.locator("#panel-size").click();
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
});

for (const width of [320, 390, 768, 1479])
  test(`responsive app flow ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 986 });
    await setup(page);
    await plan(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "normal",
    );
    const normalHeight = (await page.locator("#journey-panel").boundingBox())!
      .height;
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "expanded",
    );
    await expect(page.locator("#journey-detail")).toContainText("Rad");
    if (width < 900) {
      const panel = (await page.locator("#journey-panel").boundingBox())!;
      const routeButton = (await page.locator("#map-route").boundingBox())!;
      expect(panel.height).toBeGreaterThan(normalHeight);
      expect(panel.y).toBeGreaterThanOrEqual(
        routeButton.y + routeButton.height,
      );
    }
    await page.screenshot({
      path: `test-results/app-${width}.png`,
      fullPage: true,
    });
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "normal",
    );
    await expect(page.locator("#adjust-route")).toBeInViewport();
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
  await expect(page.locator("#route-duration")).toContainText("32 min");
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
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("adjustments are drafts and cancellation preserves results", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Other");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
});
test("settings persist immediately and replan once on leaving", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
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
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#maxWalkingMinutes").fill("3");
  const cycling = page.getByLabel("Maximale Radzeit je Etappe", {
    exact: false,
  });
  await expect(cycling).toHaveCount(1);
  await expect(cycling).toHaveAttribute("min", "1");
  await expect(cycling).toHaveAttribute("max", "60");
  await cycling.fill("17");
  await expect(page.locator(".route-choice")).toHaveCount(0);
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
test("cancel retains progressive results and ignores delayed responses", async ({
  page,
}) => {
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
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#cancel").click();
  await expect(page.locator("#status")).toContainText("abgebrochen");
  await page.waitForTimeout(1700);
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expect(page.locator("#status")).toContainText("abgebrochen");
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
      Array.from(document.querySelectorAll(".route-choice"), (b) =>
        b.textContent!.trim(),
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
    "23:50 · 55 min",
    "23:55 · 45 min",
    "· 23:59 · 1 h 20 min",
  ]);
  expect(labels.arrival).toEqual(labels.departure);
  expect(labels.updated).toEqual([
    "4. Sept. 23:50 · 55 min",
    "5. Sept. 00:05 · 55 min",
    "· 4. Sept. 23:59 · 1 h 20 min",
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
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("1 h 1 min");
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveText([
    "10:53 · 53 min",
    "· 11:01 · 1 h 1 min",
  ]);
  await expect(page.locator(".route-choice[aria-pressed=true]")).toHaveText(
    "10:53 · 53 min",
  );
  await expect(page.locator("#route-duration")).toContainText("53 min");
  await page.locator("#panel-summary").press("ArrowRight");
  await expect(page.locator("#route-duration")).toContainText("1 h 1 min");
});
test("failed refresh preserves selected journey", async ({ page }) => {
  await setup(page);
  await plan(page);
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 503, headers: cors }),
  );
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText("nicht verfügbar");
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("dark appearance, large text and reduced motion remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setup(page);
  await plan(page);
  await page.locator("#panel-size").click();
  await page.addStyleTag({ content: ":root {font-size: 24px !important;}" });
  expect(
    await page.locator("#route-arrival").evaluate((element) => {
      const groups = [...element.querySelectorAll(".route-time")].map((group) =>
        group.getBoundingClientRect(),
      );
      return (
        groups[0].bottom <= groups[1].top ||
        groups[0].right + 8 <= groups[1].left
      );
    }),
  ).toBe(true);
  await expect(page.locator("#adjust-route")).toBeVisible();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#adjust-dialog")).toBeVisible();
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
  await expect(page.locator("#calculate")).toBeInViewport({ ratio: 1 });
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").scrollIntoViewIfNeeded();
  await expect(page.locator("#when")).toBeInViewport();
  await expect(page.locator("#use-context")).toBeInViewport({ ratio: 1 });
});

test("focused dialog fields stay inside the scroll area when the keyboard opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#search-adjust").focus();
  await page.locator("#search-adjust").press("Enter");
  await page.locator("#adjust-destination").fill("Zi");
  await page
    .locator("#adjust-destination")
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
              .querySelector(".dialog-body")!
              .getBoundingClientRect();
            const input = field.getBoundingClientRect();
            const label = field.labels![0].getBoundingClientRect();
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
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Zi");
  expect(
    await page
      .locator("#adjust-destination")
      .evaluate((input: HTMLInputElement) => input.selectionStart),
  ).toBe(1);

  await page.locator("#origin").focus();
  await expectFieldInside("origin");
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").focus();
  await expectFieldInside("when");
  await choose(page, "adjust-destination", "Ziel");
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");

  await page.addStyleTag({ content: ":root { font-size: 24px; }" });
  await page.evaluate(() =>
    window.visualViewport!.dispatchEvent(new Event("resize")),
  );
  await expectFieldInside("adjust-destination", false);
  const actionsVisible = await page.evaluate(() => {
    const actions = document
      .querySelector(".dialog-actions")!
      .getBoundingClientRect();
    const viewport = window.visualViewport!;
    return (
      actions.top >= viewport.offsetTop &&
      actions.bottom <= viewport.offsetTop + viewport.height
    );
  });
  expect(actionsVisible).toBe(true);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#search-adjust")).toBeFocused();
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
    await expect(page.locator("#adjust-status")).toContainText(
      [
        "Standort verfügbar",
        "Standortzugriff nicht erlaubt",
        "Standort konnte nicht ermittelt werden",
        "Standortabfrage dauert zu lange",
      ][code],
    );
    if (code) {
      await expect(page.locator("#adjust-status")).toContainText(
        `Diagnose: Standortfehler ${code} – Origin does not have permission to use Geolocation service`,
      );
    }
    if (code) await expect(page.locator("#adjust-location-help")).toBeVisible();
    else await expect(page.locator("#adjust-location-help")).toBeHidden();
    await expect(page.locator("#origin-location")).toBeEnabled();
    await expect(page.locator("#adjust-dialog")).toBeVisible();
  });
}

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
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (value: unknown) => void,
          fail: (error: unknown) => void,
        ) => {
          calls++;
          if (calls === 2)
            success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          else fail({ code: 1, message: "User denied Geolocation" });
        },
      },
    });
  });
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
  await expect(page.locator("#adjust-dialog")).toBeHidden();
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
  await page.locator("#adjust-destination").fill("");
  await expect(page.locator("#adjust-destination-options")).toContainText(
    "Zuletzt verwendet",
  );
  await expect(
    page.locator("#adjust-destination-options .place-select"),
  ).toHaveCount(3);
  await page.locator("#cancel-adjust").click();
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

test("settings errors keep old offline snapshot but never restore invalidated options", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expect(page.locator("#storage-message")).toContainText("gespeichert");
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
  await page.goBack();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await page.locator("#close-route").click();
  await page.locator("#open-saved").click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
          .foldingDuration,
    ),
  ).toBe(270);
  expect(original.settings.foldingDuration).toBe(180);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("180");
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
  await page.locator("#clear-data").click();
  await page.locator("#cancel-delete-data").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("#open-saved")).toBeHidden();
  await page.reload();
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    1,
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

test("an expired fixed departure requires adjustment and sends no new plan requests", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").fill("2026-09-04T10:00");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:01:00Z"));
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#tab-route").click();
  await expect(page.locator("#status")).toContainText("zukünftigen Zeitpunkt");
  await expect(page.locator(".route-choice")).toHaveCount(0);
  expect(requests).toBe(0);
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
  await expect(page.locator(".route-choice[aria-pressed=true]")).toHaveText(
    "10:53 · 53 min",
  );
  await page.getByRole("button", { name: /Fahrradvergleich: 46 Min/ }).click();
  await expect(page.locator("#cycling-comparison")).toHaveText(
    "46 Min. Radfahrt · 16 Min. über deinem Radlimit",
  );
  await page.locator("#panel-size").click();
  await page.locator("#panel-size").click();
  await expect(page.locator("#option-title")).toContainText(
    "16 Min. über deinem Radlimit",
  );
  await expect(page.locator("#option-title")).toBeInViewport();
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
  await expect(page.locator("#route-duration")).toContainText("53 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen optimieren …");
  release();
  await expectPlanningComplete(page);
  await page.getByRole("button", { name: /Fahrradvergleich:/ }).click();
  await expect(page.locator("#option-title")).toContainText("Fahrradvergleich");
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
  await page.clock.setFixedTime(new Date("2026-09-04T08:05:00Z"));
  const direct = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#refresh-route").click();
  expect(new URL((await direct).url()).searchParams.get("time")).toBe(
    "2026-09-04T08:05:00Z",
  );
  await expectPlanningComplete(page);
  expect(page.url()).toBe(link);
  expect(errors).toEqual([]);
});

test("link options and edits remain temporary, including Back from settings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = new URL(page.url());
  link.searchParams.set("maxCyclingMinutes", "17");
  await page.goto(link.href);
  await expectPlanningComplete(page);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#settings-summary")).toContainText(
    "nur für diese Planung",
  );
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("17");
  await page.locator("#foldingDuration").fill("4");
  let calculations = 0;
  page.on("request", (r) => {
    if (r.url().includes("directModes=BIKE")) calculations++;
  });
  await page.goBack();
  await expectPlanningComplete(page);
  expect(calculations).toBe(1);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("240");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({ maxCyclingMinutes: 60, foldingDuration: 180 });
  await page.locator("#close-route").click();
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("60");
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
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
  await choose(page, "adjust-destination", "Weiteres Ziel");
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

test("expired and invalid links never start API searches or change personal settings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const url = new URL(page.url());
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  url.searchParams.set("timing", "depart");
  url.searchParams.set("time", "2026-09-03T08:00:00Z");
  await page.goto(url.href);
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await expect(page.locator("#adjust-status")).toContainText("Vergangenheit");
  expect(requests).toBe(0);
  url.searchParams.set("v", "999");
  await page.goto(url.href);
  await expect(page.locator("#place-status")).toContainText("ungültig");
  expect(requests).toBe(0);
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
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
  await page.locator("#panel-size").click();
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

test("copy succeeds and planning details fit a narrow mobile viewport", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 844 });
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
  await page.locator("#panel-size").click();
  await page.locator("#share-plan").click();
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-link",
    page.url(),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/planning-link-mobile.png" });
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
    await expect(page.locator("#cancel")).toBeHidden();
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
    page.locator(".route-choice").last().locator(".icon svg"),
  ).toHaveCount(1);
  await page.locator(".route-choice").last().click();
  await expect
    .poll(() =>
      page
        .locator("#panel-content")
        .evaluate((e) => e.scrollHeight - e.clientHeight),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  await page.locator("#panel-size").click();
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
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  await expectPlanningComplete(page);
  await expect(page.locator(".route-choice")).toHaveCount(3);
  await expect(page.locator("#cycling-comparison")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("showCyclingComparison")).toBe(
    "false",
  );
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
  await expect(page.locator("#cancel")).toBeVisible();
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

test("free stops edit, reorder, reverse and cancel without changing the active plan", async ({
  page,
}) => {
  await setupVia(page);
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await page.locator("#adjust-route").click();
  for (const [i, name] of ["Café", "See", "Park"].entries()) {
    await page.locator("#add-stop").click();
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
  expect(new URL(page.url()).searchParams.get("v")).toBe("1");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#via-fields > div:not([hidden])")).toHaveCount(0);
});

test("mobile stop planning shares and reloads pauses and restores the complete offline trip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupVia(page);
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await choose(page, "adjust-destination", "Ziel");
  await page.locator("#add-stop").click();
  await choose(page, "via-0", "Café");
  await page
    .locator("#via-fields > div:not([hidden]) input[type=number]")
    .fill("10");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-duration")).toContainText("50 min");
  expect(new URL(page.url()).searchParams.get("v")).toBe("2");
  expect(new URL(page.url()).searchParams.get("via1Stay")).toBe("10");
  await page.locator("#panel-size").click();
  await expect(page.locator("#journey-detail")).toContainText(
    "Geplanter Aufenthalt: 10 min",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.reload();
  await expect(page.locator("#route-duration")).toContainText("50 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#via-0")).toHaveValue("Café");
  await expect(
    page.locator("#via-fields > div:not([hidden]) input[type=number]"),
  ).toHaveValue("10");
  await page.locator("#cancel-adjust").click();
  await page.locator("#panel-size").click();
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
  await expect(page.locator("#route-duration")).toContainText("50 min");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open").first()).toContainText("Café");
  await page.locator(".history-open").first().click();
  await page.locator("#panel-size").click();
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
  await page.locator(".history-open").last().click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#history-view")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#saved-notice")).toBeVisible();
  expect(requests).toBe(0);
  await context.setOffline(true);
  await page.locator("#tab-history").click();
  await page.locator(".history-open").first().click();
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

test("history deletion and disabling persist without restoring deleted calculations", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-row > button[aria-label]").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator(".route-choice").last().click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#delete-saved").click();
  await page.locator("#cancel-delete-history").click();
  await expect(page.locator("#delete-saved")).toBeEnabled();
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
  await expect(page.locator("#storage-message")).toContainText("gespeichert");
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
  test(`route overview fits its content and pins actions at ${width}px`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 844 });
    await plan(page);
    await expect(page.locator("#panel-details")).toBeHidden();
    await expect(page.locator("#panel-size")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect
      .poll(() =>
        page
          .locator("#panel-content")
          .evaluate((e) => e.scrollHeight - e.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    const checkActions = async () => {
      expect(
        await page.evaluate(() => {
          const panel = document.getElementById("journey-panel")!;
          const bounds = panel.getBoundingClientRect();
          const tabs = document
            .querySelector(".app-tabs")!
            .getBoundingClientRect();
          return (
            ["adjust-route", "refresh-route"].every((id) => {
              const box = document.getElementById(id)!.getBoundingClientRect();
              return (
                box.top >= bounds.top &&
                box.bottom <= bounds.bottom &&
                box.bottom <= tabs.top
              );
            }) && panel.scrollHeight <= panel.clientHeight + 1
          );
        }),
      ).toBe(true);
    };
    await checkActions();
    await page.screenshot({
      path: `test-results/route-overview-${width}-${test.info().project.name}.png`,
    });
    await page.locator("#panel-size").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    await page.locator("#panel-content").evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    await checkActions();
    await page.locator("#panel-size").click();
    await expect(page.locator("#panel-details")).toBeHidden();
    await expect(page.locator("#share-plan")).toBeVisible();
    await expect(page.locator("#panel-content")).toHaveJSProperty(
      "scrollTop",
      0,
    );
    await checkActions();
  });
}

test("small route panels scroll only content, retaining archive actions and warnings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await page.locator(".history-open").first().click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => {
    const notice = document.getElementById("issues")!;
    notice.hidden = false;
    notice.textContent = "Ein wichtiger Hinweis zur Verbindung. ".repeat(20);
  });
  await expect(page.locator("#replan-saved")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      page
        .locator("#panel-content")
        .evaluate((e) => e.scrollHeight > e.clientHeight),
    )
    .toBe(true);
  await page.locator("#panel-content").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  expect(
    await page.evaluate(() =>
      ["journey-panel", "panel-details", "issues"].every(
        (id) =>
          !["auto", "scroll"].includes(
            getComputedStyle(document.getElementById(id)!).overflowY,
          ),
      ),
    ),
  ).toBe(true);
  await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#refresh-route")).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#replan-saved")).toBeInViewport({ ratio: 1 });
});

test("route panel minimizes by dragging and restores an accessible overview", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await plan(page);
  const handle = (await page.locator("#panel-handle").boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2 + 65,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "collapsed",
  );
  await expect(page.locator("#panel-size")).toHaveText("Übersicht öffnen");
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  await page.locator("#panel-size").press("Enter");
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "normal",
  );
  await expect(page.locator("#panel-details")).toHaveJSProperty("inert", true);
  await page.locator("#panel-size").press("Enter");
  await expect(page.locator("#panel-details")).toHaveJSProperty("inert", false);
  await expect(page.locator("#panel-size")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator("#panel-content").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await page.locator("#panel-size").press("Enter");
  await expect(page.locator("#panel-size")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator("#panel-content")).toHaveJSProperty("scrollTop", 0);
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
    await page.locator("#panel-size").click();
    await expect.poll(animation).toBe("route-loading");
    await page.locator("#panel-size").click();
    const handle = (await page.locator("#panel-handle").boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2 + 65,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "collapsed",
    );
    await expect(page.locator("#status")).toBeVisible();
    await expect(page.locator("#cancel")).toBeInViewport({ ratio: 1 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(animation).toBe("none");
    expect(
      await page
        .locator("#status")
        .evaluate((e) => getComputedStyle(e, "::before").content),
    ).toBe('""');
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(animation).toBe("route-loading");
    if (outcome === "cancel") await page.locator("#cancel").click();
    release();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect.poll(animation).toBe("none");
    expect(
      await page
        .locator("#status")
        .evaluate((e) => getComputedStyle(e, "::before").content),
    ).toBe("none");
    await page.locator("#panel-size").click();
    if (outcome === "complete") {
      for (let i = 0; i < 3; i++) {
        await expectPlanningComplete(page);
        await page.locator("#panel-size").click();
      }
    } else {
      await expect(page.locator("#status")).toContainText(
        outcome === "cancel" ? "abgebrochen" : "nicht beantworten",
      );
      await expect(page.locator("#status")).toBeVisible();
    }
  });
}

test("history normalizes persisted duplicates and guards stable IDs against late updates", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expect(page.locator("#storage-message")).toContainText("gespeichert");
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
  await page.locator("#refresh-route").click();
  await started;
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-row > button[aria-label]").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  release();
  await expectPlanningComplete(page);
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
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
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  await page.locator("#tab-history").click();
  await page.locator(".history-row > button[aria-label]").click();
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
    for (const size of ["normal", "collapsed", "expanded"]) {
      const samples = await page.evaluate((size) => {
        const panel = document.getElementById("journey-panel")!;
        panel.dataset.size = size;
        const details = document.getElementById("panel-details")!;
        details.hidden = size !== "expanded";
        details.inert = size !== "expanded";
        const content = document.getElementById("panel-content")!;
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
      }, size);
      for (const sample of samples) {
        expect(sample).toEqual(samples[0]);
        expect(sample.actionsVisible).toBe(true);
        expect(sample.scrollWidth).toBe(sample.width);
      }
      // Short viewports may scroll below the stacked map controls.
      if (fontSize === 16 && height >= 800 && size !== "expanded")
        expect(samples[0].scrollHeight).toBe(samples[0].height);
      if (fontSize === 24 && size === "expanded") {
        expect(samples[0].scrollHeight).toBeGreaterThan(samples[0].height);
        await page.locator("#panel-content").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(
          await page.locator("#panel-content").evaluate((e) => e.scrollTop),
        ).toBeGreaterThan(0);
      }
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
  await choose(page, "adjust-destination", "Ziel");
  for (const [i, name] of ["Café", "See", "Park"].entries()) {
    await page.locator("#add-stop").click();
    await choose(page, `via-${i}`, name);
  }
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
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
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "normal",
  );
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

  await page.locator("#adjust-route").click();
  await page
    .getByRole("button", { name: "Zwischenziel 3 nach oben", exact: true })
    .click();
  await page.locator("#swap").click();
  await page.locator("#calculate").click();
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
  await page.locator(".history-open").first().click();
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
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "normal",
  );
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

test("share remains beside close and manual copying works in every panel size", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 844 });
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
  for (const size of ["normal", "expanded", "collapsed"]) {
    await page.evaluate((size) => {
      document.getElementById("journey-panel")!.dataset.size = size;
      const details = document.getElementById("panel-details")!;
      details.hidden = size !== "expanded";
      details.inert = size !== "expanded";
    }, size);
    await page.locator("#share-plan").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#plan-link-value")).toBeVisible();
    await expect(page.locator("#plan-link-value")).toBeFocused();
    await expect(page.locator("#plan-link-value")).toHaveValue(page.url());
    const share = (await page.locator("#share-plan").boundingBox())!;
    const close = (await page.locator("#close-route").boundingBox())!;
    expect(share.x + share.width).toBeLessThan(close.x);
    expect(share.y).toBe(close.y);
    expect(share.width).toBe(close.width);
    expect(share.height).toBe(close.height);
    await expect(page.locator("#share-plan")).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
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
        return [...document.querySelectorAll("#map .route-marker")].every(
          (element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= left - 1 &&
              box.right <= map.right + 1 &&
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
    await plan(page);
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests++;
    });
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = () => {
        throw new Error("Route fit must not request GPS");
      };
    });
    for (const size of ["normal", "expanded", "collapsed"]) {
      await page.evaluate((size) => {
        document.getElementById("journey-panel")!.dataset.size = size;
        const details = document.getElementById("panel-details")!;
        details.hidden = size !== "expanded";
        details.inert = size !== "expanded";
      }, size);
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
        .getByRole("button", { name: "Gesamte Route anzeigen", exact: true })
        .click();
      await expectRouteFits(page);
      await expect(page.locator("#journey-panel")).toHaveAttribute(
        "data-size",
        size,
      );
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
    expect(requests).toBe(0);
    await page.screenshot({
      path: `test-results/route-fit-${width}-${test.info().project.name}.png`,
    });
    await page.locator("#close-route").click();
    await expect(page.locator("#map-route")).toBeHidden();
  });
}

test("route fit overrides a pending location response and works offline with stops", async ({
  page,
  context,
}) => {
  await setupVia(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await choose(page, "adjust-destination", "Ziel");
  await page.locator("#add-stop").click();
  await choose(page, "via-0", "Café");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (success) => {
      (window as any).finishMapLocation = () =>
        success({
          coords: { latitude: 52.52, longitude: 13.405 },
        } as GeolocationPosition);
    };
  });
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
  await page.locator(".history-open").click();
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await page.locator("#map-route").focus();
  await page.keyboard.press("Enter");
  await expectRouteFits(page);
  await expect(page.locator(".route-marker-stop")).toHaveText("1");
});
