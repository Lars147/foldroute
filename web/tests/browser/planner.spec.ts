import {
  addStop,
  openSettingsSection,
  openSelectedDetails,
  showMap,
  showConnections,
  expectPlanningComplete,
  expectSelectedJourneySaved,
  expectMotionSettled,
} from "./assertions";
import { test, expect } from "@playwright/test";
import { defaults } from "../../src/model";
import type { PlanningState } from "../../src/planning-state";
import { routeURL } from "../../src/route-url";
import daglResults from "../fixtures/geocode-dagl.json" with { type: "json" };
import {
  setup,
  choose,
  plan,
  cors,
  places,
  fixture,
  shiftedTransitFixture,
  trackPlanning,
} from "./planner-fixture";

for (const width of [390, 1280]) {
  test(`initial search keeps start actions hidden through empty results at ${width}px`, async ({
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
    await expect(start).toBeHidden();
    await expect(start).toBeDisabled();
    await expect(page.locator("#search-preview-title")).toHaveText(
      "Verbindungen werden gesucht …",
    );
    await expect(page.locator("#search-preview-spinner")).toBeVisible();
    await expect(page.locator("#search-preview")).toBeVisible();
    await expect(page.locator("#route-start-summary")).toBeHidden();
    release();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect(page.locator(".route-choice")).toHaveCount(0);
    await expect(start).toBeHidden();
    await expect(start).toBeDisabled();
    await expect(page.locator("#search-preview-title")).toHaveText(
      "Keine Verbindung verfügbar",
    );
    await expect(page.locator("#search-preview-detail")).not.toBeEmpty();
    await expect(page.locator("#search-preview-detail")).toBeVisible();
    await expect(page.locator("#search-preview-spinner")).toBeHidden();
    await expect(page.locator("#navigation-start-notice")).toBeHidden();
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
  await showConnections(page);
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
    await showConnections(page);
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
  await page.locator("#settings-optimization > summary").click();
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
test("closing the route cancels optimization and ignores delayed responses", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const planning = await trackPlanning(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let requested = 0;
  let replied = 0;
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: fixture.direct });
    else {
      requested++;
      await gate;
      await r.fulfill({ headers: cors, json: fixture.multimodal });
      replied++;
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await showConnections(page);
  await expect(page.locator("#adjust-route")).toBeEnabled();
  await expect(page.locator("#navigation-start")).toBeVisible();
  await expect(page.locator("#navigation-start")).toBeEnabled();
  await expect(page.locator(".panel-tools #close-route")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Suche abbrechen", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => requested).toBeGreaterThan(0);
  await page.locator("#close-route").click();
  await expect(page.locator("#destination")).toBeVisible();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  release();
  await planning.finished();
  await expect.poll(() => replied).toBe(requested);
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
    const planning = await trackPlanning(page);
    let releaseTransit!: () => void;
    const transitGate = new Promise<void>(
      (resolve) => (releaseTransit = resolve),
    );
    let requested = 0;
    let replied = 0;
    await page.route("**/api/v6/plan?*", async (route) => {
      const direct =
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE";
      if (!direct) {
        requested++;
        await transitGate;
      }
      await route.fulfill({
        headers: cors,
        json: direct ? fixture.direct : fixture.multimodal,
      });
      if (!direct) replied++;
    });
    await choose(page, "destination", "Ziel");
    await expect(page.locator(".route-choice")).not.toHaveCount(0);
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-search-status",
      "searching",
    );
    await openSelectedDetails(page);
    await expect(page.locator("#navigation-start")).toBeEnabled();
    await expect.poll(() => requested).toBeGreaterThan(0);
    await page.locator("#navigation-start").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
    await expect(page.locator("#toast")).toBeHidden();
    const savedJourney = () =>
      page.evaluate(async () => {
        const { NavigationStore } = await import("/src/navigation-store.ts");
        return (await new NavigationStore().read())?.journey;
      });
    await expect.poll(savedJourney).toBeTruthy();
    const chosen = await savedJourney();
    expect(chosen!.legs.every((leg) => leg.kind !== "transit")).toBe(true);
    releaseTransit();
    await planning.finished();
    await expect.poll(() => replied).toBe(requested);
    expect(await savedJourney()).toEqual(chosen);
    await expect(page.locator("#navigation-view")).toBeVisible();
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  });
}
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

test("help starts collapsed and opens topics through links and browser history", async ({
  page,
}, info) => {
  await page.goto("/hilfe.html");
  await expect(page.locator("details[open]")).toHaveCount(0);
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 1660]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: info.outputPath(`help-overview-${colorScheme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.goto("/hilfe.html#navigation");
  await expect(page.locator("#navigation-start")).toHaveAttribute("open", "");
  await expect(page.locator("#navigation-start summary")).toBeInViewport();
  const locationLink = page.getByRole("link", {
    name: "Standortfreigabe",
    exact: true,
  });
  await locationLink.click();
  await expect(page).toHaveURL(/hilfe\.html#standort$/);
  const locationAnswer = page.locator("#standort-freigabe");
  await expect(locationAnswer).toHaveAttribute("open", "");
  await expect(locationAnswer.locator("summary")).toBeInViewport();
  await locationAnswer.locator("summary").click();
  await expect(locationAnswer).not.toHaveAttribute("open", "");
  await page.goBack();
  await expect(page).toHaveURL(/hilfe\.html#navigation$/);
  await expect(page.locator("#navigation-start")).toHaveAttribute("open", "");
  await expect(page.locator("#navigation-start summary")).toBeInViewport();
  await page.goForward();
  await expect(page).toHaveURL(/hilfe\.html#standort$/);
  await expect(locationAnswer).toHaveAttribute("open", "");
  await expect(locationAnswer.locator("summary")).toBeInViewport();
  await locationAnswer.locator("summary").click();
  await locationLink.click();
  await expect(page).toHaveURL(/hilfe\.html#standort$/);
  await expect(locationAnswer).toHaveAttribute("open", "");
  await expect(locationAnswer.locator("summary")).toBeInViewport();
});

test("help opens legacy topics and fits narrow screens with enlarged text", async ({
  page,
}, info) => {
  await page.goto("/hilfe.html#standort-verfuegbar");
  await expect(page.locator("#standort-freigabe")).toHaveAttribute("open", "");
  await expect(page.locator("#standort-freigabe summary")).toBeInViewport();
  await page.locator("#standort-freigabe summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#standort-freigabe")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator("details").evaluateAll((answers) => {
    for (const answer of answers) answer.setAttribute("open", "");
  });
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 1660]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator(".help-header").screenshot({
        path: info.outputPath(`help-header-${colorScheme}-${width}-200.png`),
      });
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
  await setup(page, false);
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
  expect(searches[0].searchParams.has("place")).toBe(false);
  expect(searches[0].searchParams.has("placeBias")).toBe(false);
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

for (const width of [390, 1280])
  test(`place suggestions keep nearby stops and districts together as the query grows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await page.route("**/api/v1/geocode?*", (route) => {
      const query = new URL(route.request().url()).searchParams.get("text");
      return route.fulfill({
        headers: cors,
        json:
          query === "Paris"
            ? [
                { name: "Paris", lat: 48.8534951, lon: 2.3483915 },
                { name: "París", lat: 48.1390531, lon: 11.5584052 },
              ]
            : daglResults,
      });
    });
    const names = page.locator("#destination-options .place-select strong");
    for (const query of ["dag", "dagl", "daglf"]) {
      await page.locator("#destination").fill(query);
      await expect(names).toHaveCount(daglResults.length);
      await expect(names.nth(0)).toHaveText("Daglfing");
      await expect(names.nth(1)).toHaveText("Daglfing");
      await expect(names.nth(2)).toHaveText("Daglung");
    }
    await page.locator("#destination").fill("Paris");
    await expect(names).toHaveText(["Paris", "París"]);
  });

for (const width of [390, 1280])
  test(`place suggestions use the selected start or fresh GPS without location requests while typing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      (window as any).searchLocationRequests = 0;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (descriptor) =>
        descriptor.name === "geolocation"
          ? Promise.resolve({ state: "prompt" } as PermissionStatus)
          : query(descriptor);
      const geo = navigator.geolocation;
      const original = geo.getCurrentPosition.bind(geo);
      geo.getCurrentPosition = (success, error, options) => {
        (window as any).searchLocationRequests++;
        original(success, error, options);
      };
    });
    await setup(page);
    await page.route("**/api/v1/geocode?*", (route) =>
      route.fulfill({
        headers: cors,
        json: [
          { name: "Berlin Hbf", lat: 52.525, lon: 13.369 },
          { name: "Ziel", lat: 52.53, lon: 13.4 },
        ],
      }),
    );
    const search = async (id: "origin" | "destination", text: string) => {
      const request = page.waitForRequest(
        (r) =>
          r.url().includes("/api/v1/geocode?") &&
          new URL(r.url()).searchParams.get("text") === text,
      );
      await page.locator(`#${id}`).fill(text);
      const params = new URL((await request).url()).searchParams;
      await expect(page.locator(`#${id}-options .place-select`)).toHaveCount(2);
      await page.keyboard.press("Escape");
      return params;
    };
    const expectCenter = (
      params: URLSearchParams,
      center: string | null,
      bias = "2",
    ) => {
      expect(params.get("place")).toBe(center);
      expect(params.get("placeBias")).toBe(center ? bias : null);
    };

    expectCenter(await search("destination", "Zi"), null);
    expect(
      await page.evaluate(() => (window as any).searchLocationRequests),
    ).toBe(0);
    await page.locator("#search-adjust").click();
    await page.locator("#origin-location").click();
    await expect(page.locator("#adjust-location-announcement")).toHaveText(
      "Standort ermittelt",
    );
    expectCenter(await search("destination", "Zie"), "48.132,11.5756");

    await choose(page, "origin", "Berlin Hbf");
    expectCenter(await search("destination", "Ziel"), "52.525,13.369", "2");

    // An unfinished new start must not keep biasing towards the previous start.
    expectCenter(await search("origin", "Ha"), "48.132,11.5756");
    expectCenter(
      await search("destination", "Ziel ort"),
      "48.132,11.5756",
      "2",
    );
    await choose(page, "origin", "Berlin Hbf");

    // The explicitly chosen start remains useful when the GPS cache expires.
    await page.clock.setFixedTime(new Date("2026-09-04T08:01:01Z"));
    expectCenter(await search("destination", "Zie"), "52.525,13.369");
    expectCenter(await search("origin", "Ham"), null);
    expectCenter(await search("destination", "Zi"), null);
    expect(
      await page.evaluate(() => (window as any).searchLocationRequests),
    ).toBe(1);
  });

for (const width of [390, 1280])
  test(`place suggestions use existing permission and refresh after a delayed location at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      (window as any).searchLocationRequests = 0;
      const geo = navigator.geolocation;
      const original = geo.getCurrentPosition.bind(geo);
      geo.getCurrentPosition = (success, error, options) => {
        (window as any).searchLocationRequests++;
        original(
          (position) => {
            window.addEventListener(
              "test:release-search-location",
              () => success(position),
              { once: true },
            );
            (window as any).searchLocationReady = true;
          },
          error,
          options,
        );
      };
    });
    await setup(page);
    const searches: URLSearchParams[] = [];
    await page.route("**/api/v1/geocode?*", (route) => {
      const params = new URL(route.request().url()).searchParams;
      searches.push(params);
      return route.fulfill({
        headers: cors,
        json: params.has("place")
          ? [{ name: "Daglfing", lat: 48.15, lon: 11.65 }]
          : [{ name: "Dag", lat: 29.7, lon: 75.7 }],
      });
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).searchLocationReady))
      .toBe(true);
    await page.locator("#destination").fill("dag");
    await expect(
      page.locator("#destination-options .place-select strong"),
    ).toHaveText("Dag");
    expect(searches[0].has("place")).toBe(false);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:release-search-location")),
    );
    await expect(
      page.locator("#destination-options .place-select strong"),
    ).toHaveText("Daglfing");
    expect(searches.at(-1)!.get("place")).toBe("48.132,11.5756");
    expect(searches.at(-1)!.get("placeBias")).toBe("2");
    await expect(page.locator("#destination")).toHaveValue("dag");
    await page.locator("#destination").fill("dagl");
    await expect.poll(() => searches.at(-1)!.get("text")).toBe("dagl");
    expect(searches.at(-1)!.get("placeBias")).toBe("2");
    expect(
      await page.evaluate(() => (window as any).searchLocationRequests),
    ).toBe(1);
  });

for (const permission of ["denied", "unsupported"] as const)
  test(`place suggestions stay available without GPS when permission is ${permission}`, async ({
    page,
  }) => {
    await page.addInitScript((permission) => {
      (window as any).searchLocationRequests = 0;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (descriptor) => {
        if (descriptor.name !== "geolocation") return query(descriptor);
        if (permission === "unsupported")
          return Promise.reject(new TypeError("Geolocation query unsupported"));
        return Promise.resolve({ state: "denied" } as PermissionStatus);
      };
      navigator.geolocation.getCurrentPosition = () => {
        (window as any).searchLocationRequests++;
      };
    }, permission);
    await setup(page, false);
    const request = page.waitForRequest("**/api/v1/geocode?*");
    await page.locator("#destination").fill("dag");
    const params = new URL((await request).url()).searchParams;
    await expect(
      page.locator("#destination-options .place-select"),
    ).toHaveCount(2);
    expect(params.has("place")).toBe(false);
    expect(params.has("placeBias")).toBe(false);
    expect(
      await page.evaluate(() => (window as any).searchLocationRequests),
    ).toBe(0);
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
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-search-status",
    "searching",
  );
  release();
  await expectPlanningComplete(page);
  await page.getByRole("button", { name: /Fahrradvergleich:/ }).click();
  await expect(
    page.locator(".route-choice[aria-pressed=true]"),
  ).toHaveAccessibleName(/Fahrradvergleich/);
});

// Planning links carry the request, independently of the selected result.
for (const problem of ["empty", "service"] as const)
  test(`past ${problem} searches keep the chosen time through recovery`, async ({
    page,
  }) => {
    await setup(page);
    if (problem === "service")
      await page.clock.install({ time: new Date("2026-09-04T08:00:00Z") });
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
    if (problem === "service") {
      await expect(page.locator("#recover-planning")).toBeDisabled();
      await page.clock.fastForward(16_000);
      await expect(page.locator("#recover-planning")).toBeEnabled();
    }
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
  await showConnections(page);
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
  await page.locator("#settings-optimization > summary").click();
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

test("only hidden comparisons produce an empty-result message", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await openSettingsSection(page, "options");
  await page.locator("#settings-optimization > summary").click();
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

for (const width of [320, 390, 430, 1479]) {
  test(`results and itinerary keep actions accessible at ${width}px`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 844 });
    await plan(page);
    await showConnections(page);
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

for (const outcome of ["complete", "cancel", "error"] as const) {
  test(`route status distinguishes optimization from ${outcome} and respects reduced motion`, async ({
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
      await expect(page.locator("#toast")).toHaveText(
        "Routenoptimierung läuft …",
      );
    else
      await expect(page.locator("#status")).toHaveText(
        "Verbindungen werden gesucht …",
      );
    if (outcome !== "error") await showConnections(page);
    const feedback = page.locator(
      outcome === "error" ? "#search-preview" : "#toast",
    );
    const animation = () =>
      feedback.evaluate((e) => {
        const spinner = e.querySelector<HTMLElement>(
          "#search-preview-spinner, .planning-toast-spinner",
        );
        return !(e as HTMLElement).hidden && spinner && !spinner.hidden
          ? getComputedStyle(spinner).animationName
          : "none";
      });
    await expect.poll(animation).toBe("route-loading");
    await expect(
      outcome === "error"
        ? feedback.locator(':scope > [role="status"]')
        : feedback,
    ).toHaveAttribute("role", "status");
    await expect.poll(animation).toBe("route-loading");
    await expect(feedback).toBeVisible();
    if (outcome === "error") await expect(page.locator("#toast")).toBeHidden();
    await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(animation).toBe("none");
    await expect(
      feedback.locator("#search-preview-spinner, .planning-toast-spinner"),
    ).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(animation).toBe("route-loading");
    if (outcome === "cancel") await page.locator("#close-route").click();
    release();
    await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
    await expect.poll(animation).toBe("none");
    if (outcome === "complete") {
      for (let i = 0; i < 3; i++) {
        await expectPlanningComplete(page);
      }
    } else if (outcome === "cancel") {
      await expect(page.locator("#destination")).toBeVisible();
      await expect(page.locator(".route-choice")).toHaveCount(0);
    } else {
      await expect(page.locator("#search-preview-detail")).toContainText(
        "nicht beantworten",
      );
      await expect(page.locator("#search-preview-detail")).toBeVisible();
    }
  });
}

test("ready results keep scroll geometry stable while alternatives load", async ({
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
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-search-status",
    "searching",
  );
  // Measure the persistent state, away from the readiness toast's expiration.
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
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
      if (screen === "list") await showConnections(page);
      else await openSelectedDetails(page);
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
        const samples = [];
        for (let frame = 0; frame < 9; frame++) {
          await new Promise(requestAnimationFrame);
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
  await showConnections(page);
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
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung eingeschaltet",
  );
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
    "Speichereinstellung konnte nicht geändert werden",
  );
  await expect(page.locator("#offline-enabled")).toBeChecked();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung ausgeschaltet",
  );
  await page.locator("#offline-enabled").check();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung eingeschaltet",
  );
  await expect(page.locator("#toast")).toBeHidden();
});
