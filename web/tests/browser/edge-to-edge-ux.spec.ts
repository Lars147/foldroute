import { test, expect, type Page } from "./test";
import { expectMotionSettled, showMap } from "./assertions";
import {
  setup,
  plan,
  runMapClock,
  expectMapSettled,
  expectRouteFits,
  locationCenterError,
} from "./planner-fixture";

const layouts = [
  { width: 320, height: 568, font: 16, top: 0, bottom: 0, side: 0 },
  { width: 390, height: 844, font: 16, top: 59, bottom: 34, side: 0 },
  { width: 430, height: 932, font: 32, top: 62, bottom: 34, side: 0 },
  { width: 844, height: 500, font: 16, top: 0, bottom: 21, side: 59 },
];

async function insets(page: Page, layout = layouts[1]) {
  await page.addStyleTag({
    content: `:root {
      font-size: ${layout.font}px;
      --safe-top: ${layout.top}px;
      --safe-bottom: ${layout.bottom}px;
      --safe-left: ${layout.side}px;
      --safe-right: ${layout.side}px;
    }`,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.standalone = "";
  });
}

for (const layout of layouts)
  for (const theme of ["light", "dark"] as const)
    test(`mobile map fills ${layout.width}x${layout.height} with ${layout.font}px text and safe controls in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({
        width: layout.width,
        height: layout.height,
      });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await setup(page);
      await insets(page, layout);
      await plan(page);
      await runMapClock(page);
      await showMap(page);
      await expectMapSettled(page);

      const map = page.locator("#map");
      const tabs = page.locator(".app-tabs");
      const panel = page.locator("#journey-panel");
      await expect(map).toHaveJSProperty("clientHeight", layout.height);
      const bounds = (await map.boundingBox())!;
      expect(bounds).toEqual({
        x: 0,
        y: 0,
        width: layout.width,
        height: layout.height,
      });
      const bar = (await tabs.boundingBox())!;
      expect(bar.height).toBe(Math.max(56, layout.font * 3.5));
      expect(bar.x).toBeGreaterThanOrEqual(layout.side + 12);
      expect(bar.x + bar.width).toBeLessThanOrEqual(
        layout.width - layout.side - 12,
      );
      expect(bar.y + bar.height).toBeLessThanOrEqual(
        layout.height - layout.bottom - 4,
      );
      const card = (await panel.boundingBox())!;
      expect(card.y).toBeGreaterThanOrEqual(layout.top);
      expect(card.y + card.height).toBeLessThanOrEqual(bar.y - 11);
      const controls = (await page.locator("#map-controls").boundingBox())!;
      expect(controls.y).toBe(layout.top + (layout.height > 500 ? 38 : 14));
      if (layout.width < 600)
        expect(controls.y + controls.height).toBeLessThanOrEqual(card.y - 7);
      expect(controls.x + controls.width).toBeLessThanOrEqual(
        layout.width - layout.side - 12,
      );
      await expect(tabs).toBeInViewport();
      for (const button of await tabs.locator("button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      await expectRouteFits(page);
      await page.locator("#map-route").click();
      await expectRouteFits(page);
      await page.locator("#map-open-details").scrollIntoViewIfNeeded();
      await expect(page.locator("#map-open-details")).toBeInViewport();
      await page.screenshot({ path: info.outputPath("mobile-map.png") });

      if (layout.font === 16) {
        await page.locator("#map-location").click();
        await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
      }
      for (const name of ["history", "settings", "route"]) {
        await page.locator(`#tab-${name}`).click();
        await expect(page.locator(`#tab-${name}`)).toHaveAttribute(
          "aria-current",
          "page",
        );
        await expectMotionSettled(page.locator(".tab-indicator"));
        const highlight = (await page.locator(".tab-indicator").boundingBox())!;
        const button = (await page.locator(`#tab-${name}`).boundingBox())!;
        expect(highlight.x).toBeCloseTo(button.x, 0);
        expect(highlight.y).toBeCloseTo(button.y, 0);
        expect(highlight.width).toBeCloseTo(button.width, 0);
        expect(highlight.height).toBeCloseTo(button.height, 0);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(layout.width);
    });

test("details, search, time dialog and offline banner respect iPhone safe areas", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await insets(page);
  await plan(page);
  await runMapClock(page);
  await showMap(page);
  await page.locator("#map-open-details").click();
  const detail = (await page.locator("#alternatives-dialog").boundingBox())!;
  expect(detail.y).toBeGreaterThanOrEqual(59);
  expect(detail.y + detail.height).toBe(844);
  expect(
    await page
      .locator("#alternatives-body")
      .evaluate((body) => parseFloat(getComputedStyle(body).paddingBottom)),
  ).toBeGreaterThanOrEqual(34);
  await showMap(page);
  await context.setOffline(true);
  await expect(page.locator("#connection")).toBeVisible();
  const banner = (await page.locator("#connection").boundingBox())!;
  expect(banner.y).toBe(59);
  await expect
    .poll(async () => (await page.locator("#map-controls").boundingBox())!.y)
    .toBeGreaterThanOrEqual(banner.y + banner.height + 38);
  await page.locator("#map-route").click();
  await expectRouteFits(page);
  await context.setOffline(false);
  await page.locator("#map-open-details").click();
  await showMap(page);
  await page.locator("#close-route").click();
  await page.locator("#destination").click();
  expect((await page.locator(".search-focus-back").boundingBox())!.y).toBe(67);
  expect((await page.locator("#destination").boundingBox())!.y).toBe(119);
  await page.locator(".search-focus-back").click();
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  const dialog = (await page.locator("#time-dialog").boundingBox())!;
  expect(dialog.y).toBe(59);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(844 - 34);
  await page.locator("#time-cancel").click();
  await expect(
    page.locator('meta[name="apple-mobile-web-app-status-bar-style"]'),
  ).toHaveAttribute("content", "black-translucent");
});

test("desktop keeps its full-width navigation and map frame", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await setup(page);
  await plan(page);
  const bar = (await page.locator(".app-tabs").boundingBox())!;
  expect(bar).toEqual({ x: 0, y: 780, width: 1280, height: 64 });
  const map = (await page.locator("#map").boundingBox())!;
  expect(map.y).toBe(64);
  expect(map.y + map.height).toBe(780);
  await expectRouteFits(page);
});
