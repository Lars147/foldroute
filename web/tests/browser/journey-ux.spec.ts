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
  await page.route("https://tiles.openfreemap.org/**", (route) =>
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
    // Main owns start availability. Mount a ready footer for these isolated
    // JourneyView layout checks; planner tests exercise the actual transitions.
    document.querySelector<HTMLElement>(".panel-actions")!.hidden = false;
    document.getElementById("navigation-start")!.hidden = false;
    view.render(state, 30);
  });
}

for (const width of [320, 390, 1280]) {
  test(`planning context stays grouped and accessible at ${width}`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.request.origin.name = "Aktueller Standort";
      state.request.destination.name = "Bahnhofstraße 3a";
      view.render(state, 30);
    });
    const context = page.locator(".planning-context");
    if (width < 900) {
      await expect(page.locator("#result-nav")).toBeHidden();
      await expect(
        context.getByRole("button", { name: "Karte anzeigen" }),
      ).toBeVisible();
      await expect(page.locator("#panel-map-toggle")).toHaveText("Karte");
    }
    await expect(
      context.getByRole("button", { name: "Route anpassen" }),
    ).toBeVisible();
    await expect(context.getByRole("heading", { level: 1 })).toHaveText(
      "Aktueller Standort → Bahnhofstraße 3a",
    );
    await page.locator("#result-context").focus();
    await expect(page.locator("#result-context")).toBeFocused();
    await expect(context).toHaveCSS("outline-style", "none");
    await expect(page.locator("#result-context")).toHaveCSS(
      "outline-style",
      "none",
    );
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator("#adjust-route")).toBeFocused();
    await expect(page.locator("#adjust-route")).toHaveCSS(
      "outline-style",
      "none",
    );
    await page.locator("#adjust-route").blur();
    await page.screenshot({ path: info.outputPath("planning-context.png") });

    // Long place names and all planning metadata must remain readable with large text.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { state, view } = (window as any).uxPreview;
      state.request.origin.name = "München Hauptbahnhof, Ausgang Arnulfstraße";
      state.request.destination.name = "Bahnhofstraße 3a, 82166 Gräfelfing";
      state.request.timing = "arrive";
      state.request.stops = [state.request.origin, state.request.destination];
      state.restored = true;
      view.render(state, 30);
    });
    await expect(page.locator("#route-request-meta")).toContainText("Ankunft");
    await expect(page.locator("#route-request-meta")).toContainText(
      "2 Zwischenstopps",
    );
    await expect(page.locator("#result-stand")).toContainText("Gespeichert:");
    expect(
      await page.evaluate(() => {
        const ids = ["route-origin", "route-destination", "route-request-meta"];
        return (
          ids.every((id) => {
            const element = document.getElementById(id)!;
            return (
              element.scrollWidth <= element.clientWidth &&
              element.scrollHeight <= element.clientHeight
            );
          }) && document.documentElement.scrollWidth <= innerWidth
        );
      }),
    ).toBe(true);
    for (const id of [
      "adjust-route",
      "route-more",
      "close-route",
      ...(width < 900 ? ["panel-map-toggle"] : []),
    ]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: info.outputPath("planning-context-large-text.png"),
    });
  });
}

test("map action follows mobile view and stays unique across desktop resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  const toggle = page.getByRole("button", { name: "Karte anzeigen" });
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect(page.locator("#panel-map-toggle")).toBeHidden();
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await expect(page.locator("#result-nav #panel-map-toggle")).toBeVisible();
  await toggle.click();
  await page.locator("#map-open-details").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#panel-map-toggle")).toBeHidden();
  await expect(page.locator("#result-nav")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#result-nav #panel-map-toggle")).toBeVisible();
  await page.locator("#result-back").click();
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await expect(page.locator("#panel-map-toggle")).toHaveCount(1);
});

for (const width of [320, 390, 768, 1280]) {
  test(`separate results and itinerary remain readable at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await expect(page.locator(".route-choice")).toHaveCount(4);
    await expect(page.locator("#choices .route-recommendation")).toHaveText(
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
    await page.locator(".route-choice-row.selected .route-detail-link").click();
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
      await expect(
        page.locator(".route-choice-row.selected .route-detail-link"),
      ).toBeFocused();
      await page.locator('[data-journey="best"]').click();
      await page
        .locator(".route-choice-row.selected .route-detail-link")
        .click();
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
      await page.locator("#panel-map-toggle").click();
      await expect(page.locator("#map")).toHaveJSProperty("inert", false);
      await expect(page.locator("#map-preview")).toBeVisible();
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      await page
        .locator(".route-choice-row.selected .route-detail-link")
        .click();
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

for (const [width, height] of [
  [320, 844],
  [390, 844],
  [844, 390],
]) {
  test(`map summary keeps route symbols and metrics at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      for (const journey of state.journeys) {
        for (const leg of journey.legs)
          if (leg.kind === "transit") {
            leg.mode = "SUBURBAN";
            leg.line = "S6";
          }
      }
      view.render(state, 30);
    });
    await page.locator('[data-journey="best"]').click();
    const card = page.locator('[data-journey="best"]');
    const arrival = await card.locator(".route-choice-arrival").innerText();
    const schedule = await card.locator(".route-choice-schedule").innerText();
    const lineColor = await card
      .locator(".route-line")
      .evaluate((e) => getComputedStyle(e).color);
    await page.locator("#panel-map-toggle").click();
    const summary = page.locator("#map-preview-summary");
    await expect(summary.locator(".route-choice-arrival")).toHaveText(arrival);
    await expect(summary.locator(".route-choice-schedule")).toHaveText(
      schedule,
    );
    await expect(summary.locator(".route-recommendation")).toHaveText(
      "Früheste Ankunft",
    );
    await expect(summary.locator(".route-line")).toHaveText("S6");
    await expect(summary.locator(".route-line")).toHaveCSS("color", lineColor);
    await expect(
      summary.locator('.route-stage[data-kind="bike"] .icon'),
    ).toHaveCount(2);
    await expect(
      summary.locator('.route-stage[data-kind="walk"] .icon'),
    ).toHaveCount(1);
    await expect(
      summary.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveText("14 min");
    await expect(
      summary.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveText("2 min");
    await expect(
      summary.locator('.route-effort-metric[data-kind="transfer"]'),
    ).toHaveText("1 Umst.");
    await expect(summary.locator(".sr-only")).toContainText(
      "14 min Rad · 2 min Fuß · 1 Umstieg",
    );
    await expect(summary.getByRole("button")).toHaveCount(0);
    await expect(page.locator("#result-freshness")).toBeVisible();
    await expect(page.locator("#map-preview-status")).toBeHidden();
    await page.screenshot({ path: info.outputPath("map-summary.png") });
    await page.locator("#map-open-details").scrollIntoViewIfNeeded();
    await expect(page.locator("#map-open-details")).toBeInViewport({
      ratio: 1,
    });
    await page.locator("#map-open-details").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    await page.locator("#result-back").click();
    await page.locator('[data-journey="comparison"]').click();
    await page.locator("#panel-map-toggle").click();
    await expect(summary.locator(".route-choice-arrival .icon")).toHaveCount(1);
    await expect(summary.locator(".route-recommendation")).toHaveCount(0);
    await expect(
      summary.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(summary.locator(".sr-only")).toContainText("Fahrradvergleich");
  });
}

test("map summary keeps midnight dates and changing status without repeating its timestamp", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.selected.departure = Date.parse("2026-09-11T23:50:00+02:00") / 1000;
    state.selected.arrival = state.selected.departure + 55 * 60;
    view.render(state, 30);
  });
  await page.locator("#panel-map-toggle").click();
  const summary = page.locator("#map-preview-summary");
  await expect(summary.locator(".route-choice-arrival")).toHaveText(
    "12. Sept. 00:45 an",
  );
  await expect(summary.locator(".route-choice-schedule")).toHaveText(
    "Ab 11. Sept. 23:50 · 55 min",
  );
  for (const [updates, message] of [
    [
      { busy: true, message: "Verbindungen optimieren" },
      "Verbindungen optimieren",
    ],
    [
      {
        busy: false,
        staleReason:
          "Zeitlimit erreicht. Bisherige Ergebnisse bleiben erhalten.",
      },
      "Zeitlimit erreicht. Bisherige Ergebnisse bleiben erhalten.",
    ],
    [{ restored: true }, "Zeiten wurden nicht aktualisiert."],
  ] as const) {
    await page.evaluate((updates) => {
      const { state, view } = (window as any).uxPreview;
      Object.assign(state, updates);
      view.render(state, 30);
    }, updates);
    await expect(page.locator("#map-preview-status")).toContainText(message);
    expect(
      (await page.locator("#map-preview-status").boundingBox())!.y,
    ).toBeLessThan((await summary.boundingBox())!.y);
  }
  await expect(page.locator("#result-stand")).toContainText("Gespeichert:");
  await expect(page.locator("#map-preview-status")).not.toContainText(
    "Gespeicherter Stand",
  );
});

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
  await expect(
    card.locator('.route-stage[data-symbol="bus"] .icon'),
  ).toHaveCount(1);
  await expect(
    card.locator(".route-stage").filter({ hasText: "RE 1" }).locator(".icon"),
  ).toHaveCount(0);
  await expect(
    card.locator(".route-stage").filter({ hasText: "ÖPNV" }).locator(".icon"),
  ).toHaveCount(1);
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
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await page.locator("#result-back").click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveCSS("border-color", "rgb(117, 87, 0)");
  await expect(page.locator('.route-choice[aria-pressed="true"]')).toHaveCount(
    1,
  );
  await page.locator("#panel-map-toggle").click();
  const mapSummary = page.locator("#map-preview-summary");
  await expect(mapSummary.locator(".route-line")).toHaveText([
    "42",
    "RE 1",
    "ÖPNV",
  ]);
  await expect(mapSummary.locator(".route-stop-name")).toHaveText(
    "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
  );
  await expect(
    mapSummary.locator('.route-effort-metric[data-kind="transfer"]'),
  ).toHaveText("2 Umst.");
  expect(
    await mapSummary.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.locator("#map-open-details").scrollIntoViewIfNeeded();
  await expect(page.locator("#map-open-details")).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("map-summary-large-text.png"),
  });
});

test("same-ID updates retain reading position and keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-journey="selected"]').click();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
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
  await page.locator(".route-choice-row.selected .route-detail-link").click();
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
    await page.locator(".route-choice-row.selected .route-detail-link").click();
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

for (const width of [320, 390, 1280]) {
  test(`selection stays in place and only Details opens the itinerary at ${width}`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-11T08:00:00Z"));
    await preview(page);
    const first = page.locator('[data-journey="best"]');
    const details = page.locator(
      ".route-choice-row.selected .route-detail-link",
    );
    await expect(page.locator(".route-detail-link:visible")).toHaveCount(1);
    await first.scrollIntoViewIfNeeded();
    const geometry = () =>
      page.locator(".route-choice-row").evaluateAll((rows) =>
        rows.map((row) => {
          const box = row.getBoundingClientRect();
          return { top: box.top, height: box.height };
        }),
      );
    const before = await geometry();
    const scroll = await page
      .locator("#panel-content")
      .evaluate((e) => e.scrollTop);
    await first.click();
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#choices")).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect(page.locator("#panel-content")).toHaveJSProperty(
      "scrollTop",
      scroll,
    );
    await expect(page.locator("body")).not.toHaveAttribute("data-detail-opens");
    expect((await details.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(first.locator(".route-choice-arrival")).toHaveText("10:50 an");
    await expect(first.locator(".route-choice-schedule")).toHaveText(
      "Ab 10:00 · 50 min",
    );
    expect(
      await first.evaluate((card) => {
        const detail = card
          .parentElement!.querySelector(".route-detail-link")!
          .getBoundingClientRect();
        return [...card.querySelectorAll(".route-effort-metric")].every(
          (metric) => {
            const box = metric.getBoundingClientRect();
            return box.right <= detail.left || box.bottom <= detail.top;
          },
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("minimal-details.png") });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-journey="selected"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#choices")).toBeVisible();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(details).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#journey-heading")).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute(
      "data-detail-opens",
      "1",
    );
    if (width < 900) {
      await expect(page.locator("#choices")).toBeHidden();
      await page.locator("#result-back").click();
      await expect(details).toBeFocused();
    }
  });
}

for (const width of [320, 390, 1280]) {
  test(`open itinerary groups preparation and exposes boarding at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const selected = state.selected;
      const from = selected.origin;
      const station = { ...from, name: "München Pasing – Bahnhofsvorplatz" };
      const next = {
        ...from,
        name: "München Hauptbahnhof, Ausgang Arnulfstraße",
      };
      const end = { ...from, name: "Karlsplatz (Stachus)" };
      let time = Date.parse("2026-10-15T21:40:00Z") / 1000;
      const step = (
        kind: string,
        minutes: number,
        origin: any,
        destination: any,
        extra = {},
      ) => {
        const start = time;
        time += minutes * 60;
        return {
          kind,
          start,
          end: time,
          from: origin,
          to: destination,
          distance: 1000,
          coordinates: [origin, destination],
          ...extra,
        };
      };
      selected.departure = time;
      selected.legs = [
        step("bike", 10, from, station),
        step("fold", 3, station, station),
        step("wait", 2, station, station),
        step("transit", 15, station, next, {
          line: "S6",
          headsign: "Ebersberg",
          platform: "4",
          arrivalPlatform: "2",
          realtime: true,
        }),
        step("walk", 3, next, end),
        step("transit", 5, end, end),
        step("stop", 10, end, end, { stop: { place: end, stayMinutes: 10 } }),
        step("unfold", 3, end, end),
        step("bike", 5, end, selected.destination),
      ];
      selected.arrival = time;
      state.request.time = selected.departure;
      state.queriedAt = selected.departure;
      view.render(state, 30);
    });
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    await expect(page.locator(".detail-step")).toHaveCount(9);
    await expect(
      page
        .locator(".journey-section")
        .filter({ has: page.locator('[data-kind="fold"]') }),
    ).toContainText("S6");
    const transit = page.locator('.detail-step[data-kind="transit"]').first();
    await expect(transit.locator(".detail-heading")).toContainText(
      "23:55 · S6",
    );
    await expect(transit).toContainText("Richtung Ebersberg");
    await expect(transit.locator(".detail-platform")).toHaveText([
      "Gleis / Steig 4",
      "Gleis / Steig 2",
    ]);
    await expect(transit.locator(".detail-arrival")).toContainText(
      "16. Okt. 00:10 · Ausstieg",
    );
    await expect(transit.locator(".detail-source")).toHaveText(
      "Echtzeitdaten zum Zeitpunkt der Abfrage",
    );
    await expect(
      page
        .locator('.detail-step[data-kind="transit"]')
        .last()
        .locator(".detail-platform"),
    ).toHaveCount(0);
    await expect(page.locator('.detail-step[data-kind="stop"]')).toContainText(
      "Geplanter Aufenthalt: 10 min",
    );
    await page.screenshot({ path: info.outputPath("open-itinerary.png") });
    await transit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("boarding-and-exit.png") });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { state, view } = (window as any).uxPreview;
      state.restored = true;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-source")).toHaveText(
      "Gespeicherte Fahrplanangabe",
    );
    expect(
      await page
        .locator("#journey-detail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("open-itinerary-large-text.png"),
    });
    if (width < 900) {
      await page.locator("#result-back").click();
      await expect(
        page.locator(".route-choice-row.selected .route-detail-link"),
      ).toBeFocused();
    }
  });
}

for (const width of [320, 390, 1280]) {
  test(`transit details show scheduled and delayed times at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const selected = state.selected;
      const start = Date.parse("2026-10-16T10:35:00Z") / 1000;
      const end = Date.parse("2026-10-16T13:09:00Z") / 1000;
      selected.departure = start;
      selected.arrival = end;
      selected.legs = [
        {
          kind: "transit",
          from: { ...selected.origin, name: "München Hbf" },
          to: { ...selected.destination, name: "Mannheim Hauptbahnhof" },
          start,
          end,
          scheduledStart: start - 900,
          scheduledEnd: end - 300,
          line: "ICE 916",
          headsign: "Dortmund Hbf",
          platform: "13",
          arrivalPlatform: "3",
          realtime: true,
          distance: 0,
          coordinates: [selected.origin, selected.destination],
        },
      ];
      state.request.time = start;
      state.queriedAt = start;
      view.render(state, 30);
    });
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    const transit = page.locator('.detail-step[data-kind="transit"]');
    const departureDelay = transit.locator(
      '.detail-delay[data-event="departure"]',
    );
    const arrivalDelay = transit.locator('.detail-delay[data-event="arrival"]');
    await expect(transit.locator(".detail-heading")).toContainText(
      "Ab 12:20 · ICE 916",
    );
    await expect(transit.locator(".detail-arrival strong")).toContainText(
      "15:04 · Ausstieg",
    );
    await expect(departureDelay.locator('[aria-hidden="true"]')).toHaveText(
      "12:35 · +15 min",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );
    await expect(departureDelay).toHaveCSS("color", "rgb(180, 35, 50)");
    await expect(transit.locator(".detail-heading")).toHaveCSS(
      "text-decoration-line",
      "none",
    );
    await expect(departureDelay.locator(".sr-only")).toHaveText(
      "Voraussichtlich Abfahrt 12:35, 15 Minuten Verspätung.",
    );
    await expect(transit.locator(".detail-source")).toHaveText(
      "Echtzeitdaten zum Zeitpunkt der Abfrage",
    );
    await transit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("delayed-transit.png") });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(
      await page
        .locator("#journey-detail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      await transit
        .locator(".detail-delay")
        .evaluateAll((elements) =>
          elements.every(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ),
    ).toBe(true);
    await transit.locator(".detail-heading").scrollIntoViewIfNeeded();
    await expect(departureDelay).toBeInViewport();
    await page.screenshot({
      path: info.outputPath("delayed-transit-large-text.png"),
    });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.start = train.scheduledStart + 300;
      state.selected.departure = train.start;
      view.render(state, 30);
    });
    await expect(departureDelay.locator('[aria-hidden="true"]')).toHaveText(
      "12:25 · +5 min",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );

    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.transitReference = {
        tripId: "trip",
        fromId: "from",
        toId: "to",
        scheduledDeparture: train.scheduledStart,
        scheduledArrival: train.scheduledEnd,
      };
      delete train.scheduledEnd;
      state.restored = true;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-source")).toHaveText(
      "Gespeicherte Fahrplanangabe",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );
    await expect(departureDelay.locator(".sr-only")).toHaveText(
      "Gespeicherte Prognose: Abfahrt 12:25, 5 Minuten Verspätung.",
    );

    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.start = train.scheduledStart;
      train.end = train.transitReference.scheduledArrival;
      state.selected.departure = train.start;
      state.selected.arrival = train.end;
      state.restored = false;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-delay")).toHaveCount(0);
    await expect(transit.locator(".detail-heading")).toHaveText(
      "Ab 12:20 · ICE 916",
    );
    await expect(transit.locator(".detail-arrival strong")).toHaveText(
      "15:04 · Ausstieg",
    );
  });
}
