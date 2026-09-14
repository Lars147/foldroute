import { test, expect, type Page } from "@playwright/test";

async function preview(page: Page) {
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

test("choices compare movement effort, preserve focus and update unchanged journey IDs", async ({
  page,
}) => {
  await preview(page);
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator(".route-choice-effort").first()).toHaveText(
    "14 min Rad · 2 min Fuß · 1 Umstieg",
  );
  await expect(page.locator(".route-choice-effort").last()).toHaveText(
    "1 h 5 min Rad · 0 min Fuß · 0 Umstiege",
  );
  await expect(
    page.locator(".route-choice").last().locator(".icon"),
  ).toHaveAttribute("aria-hidden", "true");
  await page.locator('[data-journey="selected"]').focus();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys[1].legs[0].end += 60;
    view.render(state, 30);
  });
  await expect(
    page.locator('[data-journey="selected"] .route-choice-effort'),
  ).toContainText("15 min Rad");
  await expect(page.locator('[data-journey="selected"]')).toBeFocused();
});

test("opening details is intentional and a better connection stays explicitly selectable", async ({
  page,
}) => {
  await preview(page);
  await expect(page.locator("#better-connection")).toHaveCount(0);
  await page.evaluate(() => (window as any).uxPreview.view.setSize("expanded"));
  expect(
    await page.locator("body").getAttribute("data-detail-opens"),
  ).toBeNull();
  await page.locator("#panel-size").click();
  await page.locator("#panel-size").click();
  await expect(page.locator("body")).toHaveAttribute("data-detail-opens", "1");
  await page.locator('[data-journey="best"]').focus();
  await page.locator('[data-journey="best"]').press("Enter");
  await expect(page.locator('[data-journey="best"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#better-connection")).toHaveCount(0);
  await expect(page.locator('[data-journey="best"]')).toBeFocused();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.selected = state.journeys[1];
    state.journeys[1].arrival = state.journeys[0].arrival;
    view.render(state, 30);
  });
  await expect(page.locator("#better-connection")).toHaveCount(0);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 844, height: 360 },
]) {
  test(`large text keeps four choices and actions reachable ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await preview(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const button of await page.locator(".route-choice").all()) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const id of ["adjust-route", "refresh-route", "close-route"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("full-height panel can reveal the map without losing its route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 360 });
  await preview(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const panel = page.locator("#journey-panel");
  await expect(panel).toHaveClass(/panel-full-height/);
  await expect(page.locator("#map-location")).toHaveJSProperty("inert", true);
  const toggle = page.locator("#panel-map-toggle");
  await toggle.click();
  await expect(panel).toHaveClass(/panel-map-only/);
  await expect(page.locator("#map-location")).toHaveJSProperty("inert", false);
  await expect(page.locator("#map-location")).toBeInViewport();
  await expect(toggle).toHaveAccessibleName("Reise anzeigen");
  await toggle.click();
  await expect(panel).not.toHaveClass(/panel-map-only/);
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator('[data-journey="selected"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
