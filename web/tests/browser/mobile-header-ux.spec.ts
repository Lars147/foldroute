import { test, expect, type Page } from "./test";
import {
  expectPlanningComplete,
  openSelectedDetails,
  showConnections,
} from "./assertions";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };

async function setup(page: Page) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  const headers = { "Access-Control-Allow-Origin": "*" };
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      headers,
      json: [{ name: "Ziel", lat: 48.175, lon: 11.6 }],
    }),
  );
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({
      headers,
      json:
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await page.goto("/");
}

for (const width of [320, 390, 430]) {
  test(`mobile screens reclaim header space and retain offline status at ${width}`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await expect(page.locator(".app-header")).toBeHidden();
    await expect(page.locator("#header-settings")).toHaveCount(0);
    expect((await page.locator("#search-heading").boundingBox())!.y).toBe(28);
    for (const [tab, heading] of [
      ["history", "history-heading"],
      ["settings", "settings-heading"],
    ]) {
      await page.locator(`#tab-${tab}`).click();
      const box = (await page
        .locator(tab === "settings" ? ".settings-heading-row" : `#${heading}`)
        .boundingBox())!;
      // History deliberately retains only a screen-reader heading on mobile.
      if (tab === "history") expect(box.height).toBe(1);
      else expect(box.y).toBe(28);
    }
    await page.context().setOffline(true);
    await expect(page.locator("#connection")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await page.locator(".settings-heading-row").boundingBox())!.y,
      )
      .toBeGreaterThan(28);
    expect(
      (await page.locator("#connection").boundingBox())!.height,
    ).toBeLessThan(32);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await expect
      .poll(async () => {
        const status = (await page.locator("#connection").boundingBox())!;
        const heading = (await page
          .locator(".settings-heading-row")
          .boundingBox())!;
        return heading.y >= status.y + status.height + 27;
      })
      .toBe(true);
    await page.screenshot({ path: info.outputPath("offline-large-text.png") });
    await page.context().setOffline(false);
    await expect(page.locator("#connection")).toBeHidden();
    await expect
      .poll(
        async () =>
          (await page.locator(".settings-heading-row").boundingBox())!.y,
      )
      .toBe(28);
    await page.locator("#tab-route").focus();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator("#tab-history")).toBeFocused();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator("#tab-settings")).toBeFocused();
  });
}

test("route header stays fixed when browser history opens and closes details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#destination").fill("Ziel");
  await page.locator("#destination-options .place-select").click();
  await expectPlanningComplete(page);
  await openSelectedDetails(page);
  await page.locator("#result-back").click();
  const header = page.locator("#result-header");
  const initial = (await header.boundingBox())!;
  for (let visit = 0; visit < 2; visit++) {
    await openSelectedDetails(page);
    await expect(page.locator("#journey-heading")).toBeFocused();
    expect(await header.boundingBox()).toEqual(initial);
    await page.goBack();
    await expect(page.locator("#choices")).toBeVisible();
    await expect(
      page.locator(".route-choice-row.selected .route-detail-link"),
    ).toBeFocused();
    expect(await header.boundingBox()).toEqual(initial);
    await page.goForward();
    await expect(page.locator("#panel-details")).toBeVisible();
    expect(await header.boundingBox()).toEqual(initial);
    await page.locator("#result-back").click();
    await expect(page.locator("#choices")).toBeVisible();
    expect(await header.boundingBox()).toEqual(initial);
  }
});

test("map and accordion use reclaimed space across offline, desktop and landscape", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#destination").fill("Ziel");
  await page.locator("#destination-options .place-select").click();
  await expectPlanningComplete(page);
  await expect
    .poll(async () => (await page.locator("#map").boundingBox())!.y)
    .toBe(0);
  await openSelectedDetails(page);
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile-map.png") });
  await page.context().setOffline(true);
  await expect
    .poll(async () => {
      const badge = (await page.locator("#connection").boundingBox())!;
      return (await page.locator("#map").boundingBox())!.y - badge.height;
    })
    .toBe(0);
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect(page.locator(".app-header")).toBeVisible();
  await expect(page.locator("#header-settings")).toHaveCount(0);
  await expect(page.locator("#tab-settings")).toBeVisible();
  await expect
    .poll(async () => (await page.locator("#map").boundingBox())!.y)
    .toBe(64);
  const header = (await page.locator(".app-header").boundingBox())!;
  const badge = (await page.locator("#connection").boundingBox())!;
  expect(badge.y + badge.height).toBeLessThanOrEqual(header.y + header.height);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.context().setOffline(false);
  await expect
    .poll(async () => (await page.locator("#map").boundingBox())!.y)
    .toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
