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
    const selected = page.locator('.route-choice[aria-pressed="true"]');
    await expect(selected.locator(".route-stage")).toHaveCount(4);
    await expect(selected.locator(".route-line")).toHaveText("ÖPNV");
    await expect(
      selected.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveText("14 min");
    await expect(
      selected.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveText("2 min");
    await expect(
      selected.locator('.route-effort-metric[data-kind="transfer"]'),
    ).toHaveText("1 Umst.");
    const comparison = page.locator('[data-journey="comparison"]');
    await expect(
      comparison.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(comparison).toHaveAccessibleName(/0 min Fuß · 0 Umstiege/);
    await expect(
      page.locator("#panel-handle, .route-details-button"),
    ).toHaveCount(0);
    await page.locator("#route-more").click();
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.keyboard.press("Escape");
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

test("symbol routes preserve bus lines, transfers, stops and older snapshots", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await preview(page);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    const journey = state.journeys[0];
    const transit = journey.legs.find((leg: any) => leg.kind === "transit");
    transit.mode = "BUS";
    transit.line = "42";
    journey.legs.splice(
      journey.legs.indexOf(transit) + 1,
      0,
      { ...transit, kind: "wait" },
      { ...transit, mode: "REGIONAL_RAIL", line: "RE 1" },
      { ...transit, mode: undefined, line: undefined },
      {
        ...transit,
        kind: "stop",
        from: {
          ...transit.from,
          name: "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
        },
      },
    );
    journey.transfers = 2;
    state.restored = true;
    document.documentElement.style.fontSize = "24px";
    view.render(state);
  });
  const card = page.locator('[data-journey="best"]');
  await expect(card.locator(".route-line")).toHaveText(["42", "RE 1", "ÖPNV"]);
  await expect(card.locator('.route-stage[data-symbol="bus"]')).toHaveCount(1);
  await expect(card.locator('.route-stage[data-symbol="transit"]')).toHaveCount(
    2,
  );
  await expect(card.locator(".route-stage")).toHaveCount(7);
  await expect(card.locator(".route-stop-name")).toHaveText(
    "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
  );
  await expect(card.locator(".route-stop-name marktplatz")).toHaveCount(0);
  await expect(
    card.locator('.route-effort-metric[data-kind="transfer"]'),
  ).toHaveText("2 Umst.");
  await expect(card).toHaveAccessibleName(
    /14 min Rad · 2 min Fuß · 2 Umstiege\. Rad → 42 → RE 1 → ÖPNV → Stopp:/,
  );
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("symbol-route-large-text.png"),
  });
  await page.locator('[data-journey="best"]').click();
  await page.locator("#result-back").click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveCSS("border-color", "rgb(255, 212, 59)");
  await expect(page.locator('.route-choice[aria-pressed="true"]')).toHaveCount(
    1,
  );
});

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
for (const width of [320, 390, 1280]) {
  test(`one start action follows selection and the menu returns focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await expect(page.locator("#route-origin")).toHaveText("Start");
    await expect(page.locator("#route-destination")).toHaveText("Ziel");
    await expect(page.locator("#route-start-duration")).toHaveText("55 min");
    await expect(page.locator("#navigation-start")).toHaveAccessibleName(
      "Navigation starten",
    );
    await expect(page.locator(".panel-actions .primary:visible")).toHaveCount(
      1,
    );
    await expect(page.locator(".panel-actions #adjust-route")).toHaveCount(0);
    await page.locator('[data-journey="best"]').click();
    await expect(page.locator("#route-start-duration")).toHaveText("50 min");
    await expect(page.locator("#route-start-arrival")).toContainText("10:50");
    if (width < 900) {
      await expect(page.locator("#navigation-start")).toBeInViewport({
        ratio: 1,
      });
      await expect(page.locator("#route-request-meta")).toBeVisible();
    }
    await page.locator("#route-more").click();
    await expect(page.locator("#route-actions-dialog")).toBeVisible();
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#route-more")).toBeFocused();
    await expect(page.locator("#route-actions-dialog")).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath("preview-start.png"),
    });
  });
}
