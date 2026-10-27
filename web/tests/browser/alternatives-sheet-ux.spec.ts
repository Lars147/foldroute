import { test, expect, type Page } from "./test";
import { preview } from "./journey-preview-fixture";
import { setup, plan } from "./planner-fixture";
import { showMap, expectMotionSettled } from "./assertions";

const sheet = (page: Page) =>
  page.getByRole("dialog", { name: /Alternativen|Reiseablauf/ });
async function component(page: Page, width = 390, height = 844) {
  await page.setViewportSize({ width, height });
  await preview(page);
  await page.locator("#panel-map-toggle").click();
  await page.locator("#result-back").click();
  await expect(sheet(page)).toBeVisible();
  await expectMotionSettled(page.locator("#alternatives-dialog"));
}

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [844, 390],
] as const)
  test(`sheet opens above the map with a fixed header and scrolling body at ${width}`, async ({
    page,
  }) => {
    await component(page, width, height);
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "map",
    );
    await expect(page.locator("#choices")).toBeVisible();
    await expect(page.locator("#alternatives-close")).toBeInViewport();
    const dialogBounds = (await sheet(page).boundingBox())!;
    expect(dialogBounds.x).toBeCloseTo(0, 0);
    expect(dialogBounds.width).toBeCloseTo(width, 0);
    expect(dialogBounds.y + dialogBounds.height).toBeCloseTo(height, 0);
    const header = page.locator(".alternatives-header");
    const before = await header.boundingBox();
    await page.locator("#alternatives-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect
      .poll(() =>
        page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
      )
      .toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(before);
    await page.mouse.click(4, 4);
    await expect(sheet(page)).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("alternatives-sheet.png"),
    });
    await page.locator("#alternatives-close").click();
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator("#result-back")).toBeFocused();
    await expect(page.locator("#choices")).toBeHidden();
  });

test("details preview keeps the selected route and returns to the list position", async ({
  page,
}) => {
  await component(page, 390, 600);
  await page.locator("#alternatives-body").evaluate((body) => {
    body.scrollTop = 130;
  });
  const selected = await page
    .locator('.route-choice[aria-pressed="true"]')
    .getAttribute("data-journey");
  const details = page.locator(
    '.route-detail-link[data-detail-journey="third"]',
  );
  await details.scrollIntoViewIfNeeded();
  const scroll = await page
    .locator("#alternatives-body")
    .evaluate((body) => body.scrollTop);
  await details.click();
  await expect(page.locator("#alternatives-title")).toHaveText("Reiseablauf");
  await expect(page.locator("#alternatives-footer")).toBeVisible();
  const detail = await page.locator("#journey-detail > :first-child").elementHandle();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    view.render(state, 30);
  });
  expect(
    await detail!.evaluate((element) => element.isConnected),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).uxPreview.state.selected.id),
  ).toBe(selected);
  await page.locator("#alternatives-back").click();
  await expect(page.locator("#alternatives-title")).toHaveText("Alternativen");
  await expect(details).toBeFocused();
  expect(
    await page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
  ).toBeCloseTo(scroll, 0);
  await details.click();
  await page.locator("#alternatives-select").click();
  await expect(sheet(page)).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).uxPreview.state.selected.id),
  ).toBe("third");
  await page.locator("#result-back").click();
  await expect(
    page.locator('.route-choice[data-journey="third"]'),
  ).toBeFocused();
});

test("card selection closes the sheet and closing a detail preview discards it", async ({
  page,
}) => {
  await component(page);
  await page.locator('.route-choice[data-journey="best"]').click();
  await expect(sheet(page)).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).uxPreview.state.selected.id),
  ).toBe("best");
  await page.locator("#result-back").click();
  await page.locator('.route-detail-link[data-detail-journey="third"]').click();
  await page.locator("#alternatives-close").click();
  expect(
    await page.evaluate(() => (window as any).uxPreview.state.selected.id),
  ).toBe("best");
  await expect(page.locator("#map-preview-summary")).toContainText("50 min");
});

test("updates preserve list scroll and an unavailable preview returns to alternatives", async ({
  page,
}) => {
  await component(page, 390, 600);
  await page.locator("#alternatives-body").evaluate((body) => {
    body.scrollTop = 150;
  });
  const before = await page
    .locator("#alternatives-body")
    .evaluate((body) => body.scrollTop);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys.push({ ...structuredClone(state.journeys[0]), id: "later" });
    view.render(state, 30);
  });
  await expect(
    page.locator('.route-choice[data-journey="later"]'),
  ).toBeAttached();
  expect(
    await page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
  ).toBeCloseTo(before, 0);
  await page.evaluate(() => {
    const { view } = (window as any).uxPreview;
    const navigation = view.snapshot();
    view.closeAlternatives();
    view.restoreNavigation(navigation);
  });
  expect(
    await page.locator("#alternatives-body").evaluate((body) => body.scrollTop),
  ).toBeCloseTo(before, 0);
  await page.locator('.route-detail-link[data-detail-journey="third"]').click();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys = state.journeys.filter(
      (journey: any) => journey.id !== "third",
    );
    view.render(state, 30);
  });
  await expect(page.locator("#alternatives-title")).toHaveText("Alternativen");
  await expect(page.locator("#alternatives-announcement")).toContainText(
    "nicht mehr verfügbar",
  );
});

test("resizing to desktop restores the normal list without accepting a preview", async ({
  page,
}) => {
  await component(page);
  await page.locator('.route-detail-link[data-detail-journey="third"]').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#panel-content #choices")).toBeVisible();
  await expect(page.locator("#panel-content #panel-details")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).uxPreview.state.selected.id),
  ).toBe("selected");
  await expect(page.locator("#journey-heading")).toContainText("55 min");
});

test("browser back and forward manage one overlay entry and escape restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await showMap(page);
  const url = page.url();
  const position = await page.evaluate(() => history.state.position);
  await page.locator("#result-back").click();
  await expect(sheet(page)).toBeVisible();
  await page.locator(".route-detail-link").last().click();
  await expect(page.locator("#alternatives-title")).toHaveText("Reiseablauf");
  await page.goBack();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#result-back")).toBeFocused();
  expect(page.url()).toBe(url);
  await page.goForward();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator("#alternatives-title")).toHaveText("Reiseablauf");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#result-back")).toBeFocused();
  await page.locator("#result-back").click();
  await page.locator(".route-choice").first().click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#result-back")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position);
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position - 1);
});

test("resizing to desktop consumes the overlay history entry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await showMap(page);
  const position = await page.evaluate(() => history.state.position);
  await page.locator("#result-back").click();
  await expect(sheet(page)).toBeVisible();
  await page.locator(".route-detail-link").last().click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sheet(page)).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position);
  await expect(page.locator('.route-choice[aria-pressed="true"]')).toBeFocused();
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => history.state.position))
    .toBe(position - 1);
});

for (const reducedMotion of ["reduce", "no-preference"] as const)
  test(`large text and keyboard focus stay inside the sheet with ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await component(page, 320, 568);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await expect(page.locator("#alternatives-close")).toBeInViewport();
    expect(
      await sheet(page).evaluate(
        (dialog) => dialog.scrollWidth <= dialog.clientWidth,
      ),
    ).toBe(true);
    await page.locator("#alternatives-close").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".route-detail-link").last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#alternatives-close")).toBeFocused();
    const header = (await page.locator(".alternatives-header").boundingBox())!;
    await page.mouse.move(header.x + header.width / 2, header.y + 12);
    await page.mouse.down();
    await page.mouse.move(header.x + header.width / 2, header.y + 180, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(sheet(page)).toBeVisible();
    await page.locator(".route-detail-link").last().click();
    await expect(page.locator("#alternatives-back")).toBeInViewport();
    await expect(page.locator("#alternatives-select")).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("alternatives-large-text.png"),
    });
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
  });

test("optimization errors and retry remain accessible inside the modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(async () => {
    const { PlanningSession } = await import("/src/planning-state.ts");
    const calculate = PlanningSession.prototype.calculate;
    PlanningSession.prototype.calculate = function (...args) {
      (window as any).sheetPlanning = this;
      return calculate.apply(this, args);
    };
  });
  await plan(page);
  await page.evaluate(() => {
    const session = (window as any).sheetPlanning;
    const original = session.state.journeys[0];
    session.state.journeys.push(
      ...Array.from({ length: 12 }, (_, index) => ({
        ...structuredClone(original),
        id: `extra-${index}`,
      })),
    );
    session.stop("");
  });
  await showMap(page);
  await page.locator("#result-back").click();
  await expectMotionSettled(page.locator("#alternatives-dialog"));
  await page.locator("#alternatives-body").evaluate((body) => {
    body.scrollTop = 180;
  });
  const before = (await page.locator("#choices").boundingBox())!.y;
  await page.evaluate(() => {
    const session = (window as any).sheetPlanning;
    session.state.searchStatus = "partial";
    session.state.phase = "bike-transfers";
    session.state.incompletePhases = ["bike-transfers"];
    session.state.issues = [
      "Suche nach weiteren Rad-Umstiegen: Zeitlimit erreicht.",
    ];
    session.stop("Routenoptimierung: Zeitlimit erreicht", {
      action: "retry",
      mode: "optimization",
      request: structuredClone(session.state.request),
    });
  });
  const toast = page.locator("#alternatives-feedback-slot #toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Zeitlimit erreicht");
  // WebKit may round a restored scroll offset to a whole CSS pixel.
  expect(
    Math.abs((await page.locator("#choices").boundingBox())!.y - before),
  ).toBeLessThanOrEqual(1);
  await expect(
    page.locator("#alternatives-dialog #recover-planning"),
  ).toBeVisible();
  await expect(
    page.locator("#alternatives-dialog #recover-planning"),
  ).toBeEnabled();
  await page.locator(".route-detail-link").last().click();
  await expect(page.locator("#alternatives-title")).toHaveText("Reiseablauf");
  await expect(toast).toBeVisible();
  await expect(
    page.locator("#alternatives-dialog #recover-planning"),
  ).toBeVisible();
  await page.evaluate(() => {
    const session = (window as any).sheetPlanning;
    session.stop(session.state.message, session.state.recovery);
  });
  await expect(
    page.locator("#alternatives-dialog #recover-planning"),
  ).toBeVisible();
  await page.locator("#alternatives-close").click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#toast")).toBeVisible();
  expect(
    await page
      .locator("#toast")
      .evaluate((toast) => !!toast.closest("#alternatives-dialog")),
  ).toBe(false);
});

test("a new search closes the component overlay without retaining a preview", async ({
  page,
}) => {
  await component(page);
  await page.locator('.route-detail-link[data-detail-journey="third"]').click();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    view.render(
      {
        ...state,
        calculationId: "next-calculation",
        pendingRequest: state.request,
        busy: true,
      },
      30,
    );
  });
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#panel-content #choices")).toBeAttached();
});

test("offline alternatives preserve the map camera and still allow selection", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await showMap(page);
  const camera = () =>
    page.locator("#map .leaflet-map-pane").getAttribute("style");
  const before = await camera();
  await page.locator("#result-back").click();
  await context.setOffline(true);
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator("#choices .route-choice").first()).toBeEnabled();
  await page.locator("#alternatives-close").click();
  await expect(sheet(page)).toBeHidden();
  expect(await camera()).toBe(before);
  await page.locator("#result-back").click();
  await page.locator("#choices .route-choice").first().click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#map-preview")).toBeVisible();
});
