import {
  addStop,
  openCachedJourney,
  openSettingsSection,
  openSelectedDetails,
  showMap,
  expectPlanningComplete,
  expectMotionSettled,
} from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import { defaults, type Journey } from "../../src/model";
import type { PlanningState } from "../../src/planning-state";
import { routeURL } from "../../src/route-url";
import {
  setup,
  choose,
  plan,
  cors,
  places,
  fixture,
  shiftedTransitFixture,
  expectRecoveryButtons,
  setupVia,
  trackPlanning,
} from "./planner-fixture";

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
  const planning = await trackPlanning(page);
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
  let oldRequested = 0;
  let oldReplied = 0;
  await page.route("**/api/v6/plan?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const direct = params.get("directModes") === "BIKE";
    const old = params.get("toPlace")?.includes("48.175");
    if (old && !direct) {
      oldTransitStarted = true;
      oldRequested++;
      await gate;
    }
    if (!old && direct) newDirectRequests++;
    await route.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
    if (old && !direct) oldReplied++;
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
  await planning.finished();
  await expect.poll(() => oldReplied).toBe(oldRequested);
  await expect(page.locator("#route-destination")).toHaveText("Park");
  expect(page.url()).toBe(link);
  await expect(page.locator("#route-editor")).not.toBeVisible();
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

async function openStopDuration(page: Page) {
  await setupVia(page);
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await choose(page, "destination", "Ziel");
  await addStop(page);
  await choose(page, "via-0", "Café");
}

test("stop duration editor validates and preserves durations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openStopDuration(page);
  const toggle = page.locator('.stop-stay-toggle[aria-controls="via-0-stay"]');
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
  await page
    .getByRole("button", { name: "Zwischenziel 2 entfernen", exact: true })
    .click();
  await expect(page.locator("#planner-more")).toBeFocused();
  await page.locator("#search-adjust").click();
  await page.locator("#search-adjust").click();
  await expect(page.locator("#via-1")).toHaveValue("See");
  await expect(page.locator("#via-0")).toBeHidden();
});

for (const width of [320, 393, 1280]) {
  test(`stop duration editor layout and errors fit at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openStopDuration(page);
    const toggle = page.locator(
      '.stop-stay-toggle[aria-controls="via-0-stay"]',
    );
    await toggle.click();
    await page.locator("#via-0-minutes").fill("15");
    await toggle.click();
    await expect(toggle).toContainText("15 Min.");
    await expect(page.locator("#via-0-stay")).toBeHidden();
    await expect(toggle).toBeInViewport({ ratio: 0.99 });
    await page.screenshot({ path: info.outputPath("stop-collapsed.png") });
    await toggle.click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator("#via-0-minutes").scrollIntoViewIfNeeded();
    await expect(page.locator("#via-0-minutes")).toBeInViewport({
      ratio: 0.99,
    });
    await expect(page.locator("#via-0-hours")).toBeVisible();
    await page.screenshot({
      path: info.outputPath("stop-expanded-large-text.png"),
    });
    await page.locator("#via-0-hours").fill("24");
    await page.locator("#via-0-minutes").fill("1");
    await page.locator("#calculate").click();
    const error = page.locator("#via-0-stay-error");
    await expect(error).toHaveText(
      "Der Aufenthalt darf höchstens 24 Stunden betragen.",
    );
    await expect(page.locator("#via-0-minutes")).toBeFocused();
    await expect(page.locator("#via-0-minutes")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeInViewport({ ratio: 0.99 });
    expect(
      await page
        .locator("#route-editor")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator("#calculate").scrollIntoViewIfNeeded();
    await expect(page.locator("#calculate")).toBeInViewport({ ratio: 0.99 });
    await page.screenshot({
      path: info.outputPath("stop-error-large-text.png"),
    });
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
    await expect(page.locator("#search-heading")).toBeFocused();
    await expect(page.locator("#destination")).not.toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
    await expect(page.locator("#map-view")).toBeHidden();
  });
}
