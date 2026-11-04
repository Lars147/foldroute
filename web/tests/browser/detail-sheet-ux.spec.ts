import { test, expect } from "./test";
import { preview } from "./journey-preview-fixture";
import { setup, plan, choose, cors, fixture } from "./planner-fixture";
import {
  expectMotionSettled,
  expectSelectedJourneySaved,
  openCachedJourney,
  openSelectedDetails,
  showMap,
} from "./assertions";

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [844, 390],
] as const)
  test(`selected itinerary uses a scrolling sheet above the map at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await preview(page);
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "map",
    );
    await expect(page.locator("#choices")).toBeHidden();
    await expect(page.locator("#panel-map-toggle")).toHaveCount(0);
    await openSelectedDetails(page);
    const sheet = page.getByRole("dialog", { name: "Reiseablauf" });
    await expectMotionSettled(sheet);
    const bounds = (await sheet.boundingBox())!;
    expect(bounds.x).toBeCloseTo(0, 0);
    expect(bounds.width).toBeCloseTo(width, 0);
    expect(bounds.y + bounds.height).toBeCloseTo(height, 0);
    await expect(page.locator("#alternatives-title")).toBeFocused();
    await expect(page.locator("#alternatives-back")).toBeHidden();
    await expect(page.locator("#alternatives-footer")).toBeHidden();
    await expect(
      sheet.getByRole("button", { name: "Navigation starten" }),
    ).toHaveCount(0);
    const header = await page.locator(".alternatives-header").boundingBox();
    await page.locator("#alternatives-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    expect(await page.locator(".alternatives-header").boundingBox()).toEqual(
      header,
    );
    await expect(page.locator("#alternatives-close")).toBeInViewport();
    await page.mouse.click(4, 4);
    await expect(sheet).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("detail-sheet.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.locator("#map-open-details")).toBeFocused();
    await expect(page.locator("#map-preview-summary")).toContainText("55 min");
    await expect(page.locator("#choices")).toBeHidden();
  });

test("reading position survives updates, browser back, forward and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await setup(page);
  await plan(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v6/plan?")) requests++;
  });
  const position = await page.evaluate(() => history.state.position);
  await openSelectedDetails(page);
  await page.locator("#alternatives-body").evaluate((body) => {
    body.scrollTop = 150;
  });
  const scroll = await page
    .locator("#alternatives-body")
    .evaluate((body) => body.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => history.state.journeyNavigation.sheet.scrollTop),
    )
    .toBe(scroll);
  await page.goBack();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#map-open-details")).toBeFocused();
  await page.goForward();
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "detail",
  );
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect
    .poll(() =>
      page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
    )
    .toBe(scroll);
  await page.locator("#alternatives-close").click();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position);
  await expect(page.locator("#map-open-details")).toBeFocused();
  expect(requests).toBe(0);
  await page.goForward();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.reload();
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "detail",
  );
});

test("live updates preserve details and disappearing selection closes them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await preview(page);
  await openSelectedDetails(page);
  await page.locator("#alternatives-body").evaluate((body) => {
    body.scrollTop = 130;
  });
  const scroll = await page
    .locator("#alternatives-body")
    .evaluate((body) => body.scrollTop);
  const first = await page
    .locator("#journey-detail > :first-child")
    .elementHandle();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys.push({ ...structuredClone(state.journeys[0]), id: "new" });
    view.render(state, 30);
  });
  expect(await first!.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
  ).toBe(scroll);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys = state.journeys.filter(
      (journey: any) => journey.id !== state.selected.id,
    );
    state.selected = state.journeys[0];
    view.render(state, 30);
  });
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#map-open-details")).toBeFocused();
});

test("scroll events during modal mounting cannot turn the base history entry into a sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  const position = await page.evaluate(() => history.state.position);
  await page.evaluate(() => {
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      show.call(this);
      if (this.id === "alternatives-dialog")
        document
          .getElementById("journey-panel")!
          .dispatchEvent(new Event("scroll"));
    };
  });
  await openSelectedDetails(page);
  await page.locator("#alternatives-close").click();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position);
  await expect(page.locator("#map-open-details")).toBeFocused();
  await page.goForward();
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "detail",
  );
});

test("desktop resize closes the overlay and shrinking returns to the map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  const position = await page.evaluate(() => history.state.position);
  await openSelectedDetails(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#panel-content #choices")).toBeVisible();
  await expect(page.locator("#panel-content #panel-details")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#choices")).toBeHidden();
});

test("offline history opens details over the map and returns to history after closing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "detail",
  );
  await expect(page.locator("#saved-notice")).toContainText(
    "Zeiten wurden nicht aktualisiert",
  );
  await showMap(page);
  await expect(page.locator("#map-open-details")).toBeFocused();
  await page.goBack();
  await expect(page.locator("#history-view")).toBeVisible();
});

test("a restored alternative preview returns focus to its details button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await page.locator("#result-back").click();
  const details = page.locator(".route-detail-link").last();
  const id = await details.getAttribute("data-detail-journey");
  const selected = await page
    .locator('.route-choice[aria-pressed="true"]')
    .getAttribute("data-journey");
  await details.click();
  await page.reload();
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "preview",
  );
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await page.locator("#alternatives-back").click();
  await expect(
    page.locator(`.route-detail-link[data-detail-journey="${id}"]`),
  ).toBeFocused();
  await expect(
    page.locator('.route-choice[aria-pressed="true"]'),
  ).toHaveAttribute("data-journey", selected!);
});

test("legacy details use the selected journey of the restored plan", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  const firstUrl = page.url();
  const firstId = await page
    .locator('.route-choice[aria-pressed="true"]')
    .getAttribute("data-journey");
  await page.locator("#adjust-route").click();
  await page.goBack();
  await expect(page.locator("#map-view")).toBeVisible();
  await page.evaluate(() => {
    const state = structuredClone(history.state);
    state.journeyNavigation.screen = "detail";
    state.journeyNavigation.mapReturn = "list";
    delete state.journeyNavigation.sheet;
    history.replaceState(state, "");
  });
  await page.goForward();
  await expect(page.locator("#route-editor")).toBeVisible();
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      headers: cors,
      json: [{ name: "Weiteres Ziel", lat: 48.176, lon: 11.6 }],
    }),
  );
  await page.route("**/api/v6/plan?*", (route) => {
    const direct =
      new URL(route.request().url()).searchParams.get("directModes") === "BIKE";
    const response = structuredClone(
      direct ? fixture.direct : fixture.multimodal,
    );
    for (const [index, journey] of [
      ...(response.direct ?? []),
      ...(response.itineraries ?? []),
    ].entries())
      journey.id = `second-${index}`;
    return route.fulfill({ headers: cors, json: response });
  });
  await choose(page, "destination", "Weiteres Ziel");
  await page
    .locator("#route-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("#route-destination")).toHaveText("Weiteres Ziel");
  await expect
    .poll(() =>
      page
        .locator('.route-choice[aria-pressed="true"]')
        .getAttribute("data-journey"),
    )
    .not.toBe(firstId);
  await page.goBack();
  await expect(page).toHaveURL(firstUrl);
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect(page.locator("#alternatives-dialog")).toHaveAttribute(
    "data-mode",
    "detail",
  );
  await expect
    .poll(() =>
      page.evaluate(() => history.state.journeyNavigation.sheet?.journeyId),
    )
    .toBe(firstId);
});

for (const reducedMotion of ["reduce", "no-preference"] as const)
  test(`large text and focus remain usable in dark mode with ${reducedMotion}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion });
    await preview(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await openSelectedDetails(page);
    const sheet = page.locator("#alternatives-dialog");
    await expectMotionSettled(sheet);
    expect(
      await sheet.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.locator("#alternatives-close").focus();
    const close = (await page.locator("#alternatives-close").boundingBox())!;
    const symbol = (await page
      .locator("#alternatives-close .icon")
      .boundingBox())!;
    expect(symbol.y + symbol.height / 2).toBeCloseTo(
      close.y + close.height / 2,
      0,
    );
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#alternatives-body")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#alternatives-close")).toBeFocused();
    await expect(page.locator("#journey-detail")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("detail-sheet-large-text.png"),
    });
  });
