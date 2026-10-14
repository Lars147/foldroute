import { test, expect, type Page } from "@playwright/test";

async function preview(page: Page) {
  // Isolate the component: the application entrypoint would create a second
  // JourneyView with competing resize/focus observers on these same elements.
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'import "/src/style.css"; import { icon } from "/src/ui.ts"; document.querySelectorAll("[data-icon]").forEach(element => element.append(icon(element.dataset.icon)));',
    }),
  );
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/src/journey-view.ts";
    const { JourneyView } = await import(path);
    const from = { name: "Start", detail: "", latitude: 48, longitude: 11 };
    const to = { ...from, name: "Ziel", latitude: 48.1 };
    const departure = Date.parse("2026-09-11T08:00:00Z") / 1000;
    const makeJourney = (id: string, duration: number, direct = false) => ({
      id,
      origin: from,
      destination: to,
      departure,
      arrival: departure + duration * 60,
      transfers: direct ? 0 : 1,
      isDirect: direct,
      legs: (direct
        ? [["bike", duration]]
        : [
            ["bike", 10],
            ["fold", 2],
            ["transit", duration - 20],
            ["unfold", 2],
            ["bike", 4],
            ["walk", 2],
          ]
      ).map(([kind, minutes]) => ({
        kind,
        from,
        to,
        start: departure,
        end: departure + Number(minutes) * 60,
        distance: 1000,
        coordinates: [from, to],
      })),
    });
    const journeys = [
      makeJourney("best", 50),
      makeJourney("selected", 55),
      makeJourney("third", 60),
      makeJourney("comparison", 65, true),
    ];
    const state = {
      journeys,
      selected: journeys[1],
      request: {
        origin: from,
        destination: to,
        timing: "now",
        time: departure,
      },
      queriedAt: departure,
      busy: false,
      locating: false,
      message: "",
      issues: [],
      restored: false,
    };
    const view = new JourneyView((id: string) => {
      state.selected = journeys.find((j) => j.id === id)!;
      view.render(state, 30);
    });
    view.onDetailsOpened = () => {
      document.body.dataset.detailOpens = String(
        Number(document.body.dataset.detailOpens ?? 0) + 1,
      );
    };
    (window as any).uxPreview = { state, view };
    document.body.dataset.view = "map";
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    view.render(state, 30);
  });
}

for (const width of [320, 390, 768, 1280]) {
  test(`separate results and itinerary remain readable at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await expect(page.locator(".route-choice")).toHaveCount(4);
    await expect(page.locator(".route-recommendation")).toHaveText(
      "Früheste Ankunft",
    );
    await expect(
      page.locator("#panel-handle, .route-details-button"),
    ).toHaveCount(0);
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`list-${width}.png`) });
    await page.locator('[data-journey="best"]').click();
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(page.locator("#journey-heading")).toBeFocused();
    await expect(page.locator("#journey-effort")).toContainText("14 min Rad");
    expect(
      await page
        .locator(".journey-legs small")
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    if (width < 900) {
      await expect(page.locator("#choices")).toBeHidden();
      await expect(page.locator("#map")).toHaveJSProperty("inert", true);
      await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 150));
      const scroll = await page
        .locator("#panel-content")
        .evaluate((e) => e.scrollTop);
      await page.locator("#result-back").click();
      await expect(page.locator('[data-journey="best"]')).toBeFocused();
      await page.locator('[data-journey="best"]').click();
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
      await page.locator("#panel-map-toggle").click();
      await expect(page.locator("#map")).toHaveJSProperty("inert", false);
      await expect(page.locator("#map-preview")).toBeVisible();
      await page.locator("#result-back").click();
      await expect(page.locator("#panel-details")).toBeVisible();
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
    } else {
      await expect(page.locator("#choices")).toBeVisible();
      await expect(page.locator("#panel-map-toggle")).toBeHidden();
    }
    await page.screenshot({ path: info.outputPath(`itinerary-${width}.png`) });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("same-ID updates retain reading position and keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-journey="selected"]').click();
  await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 160));
  const scroll = await page
    .locator("#panel-content")
    .evaluate((e) => e.scrollTop);
  await page.locator("#adjust-route").focus();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys[1].legs[0].end += 60;
    view.render(state, 30);
  });
  await expect(page.locator("#journey-effort")).toContainText("15 min Rad");
  await expect(page.locator("#adjust-route")).toBeFocused();
  await expect(page.locator("#panel-content")).toHaveJSProperty(
    "scrollTop",
    scroll,
  );
});

test("desktop resize preserves selection and returns to mobile itinerary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-journey="third"]').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#choices")).toBeVisible();
  await expect(page.locator("#panel-details")).toBeVisible();
  await expect(page.locator("#map")).toHaveJSProperty("inert", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#choices")).toBeHidden();
  await expect(page.locator("#journey-heading")).toContainText("1 h");
});

for (const [width, height] of [
  [320, 568],
  [844, 390],
  [390, 844],
]) {
  test(`large text keeps content and actions reachable at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await preview(page);
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "24px"),
    );
    await page.locator('[data-journey="selected"]').click();
    await page.locator("#adjust-route").scrollIntoViewIfNeeded();
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    await page.locator("#result-back").scrollIntoViewIfNeeded();
    await page.locator("#result-back").click();
    await page.locator('[data-journey="comparison"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-journey="comparison"]')).toBeInViewport({
      ratio: 1,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
