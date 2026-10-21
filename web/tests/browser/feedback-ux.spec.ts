import { expect, test } from "@playwright/test";
import { setup, plan, expectMapSettled } from "./planner-fixture";
import {
  openSettingsSection,
  expectPlanningComplete,
  showMap,
  showConnections,
} from "./assertions";

for (const width of [320, 390, 1280])
  test(`connection footer has balanced spacing and reachable details at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await setup(page);
    await plan(page);
    await showConnections(page);
    const row = page.locator(".route-choice-row.selected");
    const details = row.locator(".route-detail-link");
    const effort = row.locator(".route-choice-effort");
    const card = (await row.boundingBox())!;
    const button = (await details.boundingBox())!;
    const summary = (await effort.boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(
      card.x + card.width - button.x - button.width,
    ).toBeGreaterThanOrEqual(15);
    const lastMetric = (await effort
      .locator(".route-effort-metric")
      .last()
      .boundingBox())!;
    expect(
      button.x >= lastMetric.x + lastMetric.width + 8 ||
        button.y >= lastMetric.y + lastMetric.height,
    ).toBe(true);
    const label = (await effort.locator(".route-effort-label").boundingBox())!;
    expect(label.y - summary.y).toBeLessThanOrEqual(16);
    await row.screenshot({ path: info.outputPath(`connection-${width}.png`) });
  });

test("changed transfer time persists and reaches the next route calculation", async ({
  page,
}) => {
  await setup(page, true, { maxBikeTransfers: 0 });
  await plan(page);
  const times: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v6/plan" &&
      url.searchParams.get("additionalTransferTime") !== null
    )
      times.push(url.searchParams.get("additionalTransferTime")!);
  });
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "options");
  await expect(page.locator("#transferMinutes")).toHaveValue("3");
  await page.locator("#transferMinutes").fill("7");
  await expect(page.locator("#settings-replan")).toBeVisible();
  expect(times).toEqual([]);
  await page.locator("#save-settings").click();
  await expectPlanningComplete(page);
  expect(times.length).toBeGreaterThan(0);
  expect(new Set(times)).toEqual(new Set(["7"]));
  await page.reload();
  await expectPlanningComplete(page);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "options");
  await expect(page.locator("#transferMinutes")).toHaveValue("7");
});

for (const width of [320, 390, 1280]) {
  test(`information dialogs retain settings, focus and layout at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await setup(page);
    await page.locator("#tab-settings").click();
    const url = page.url();
    for (const name of ["licenses", "about"]) {
      if (name === "about") await openSettingsSection(page, "help");
      const opener = page.locator(`#open-${name}`);
      const dialog = page.locator(`#${name}-dialog`);
      await opener.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading").first()).toBeFocused();
      expect(page.url()).toBe(url);
      if (name === "licenses") {
        await expect(dialog).toContainText("Transitous");
        await dialog.locator("#leaflet summary").click();
        await expect(dialog.locator("#leaflet pre")).toContainText(
          "BSD 2-Clause License",
        );
      } else
        await expect(dialog).toContainText("Mit Faltrad und ÖPNV unterwegs.");
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await dialog.locator("[data-close-information]").focus();
      await expect(dialog.locator("[data-close-information]")).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(page.locator("#settings-view")).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "16px";
      });
    }
  });
}

test("double click keeps the overview camera unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 852 });
  await setup(page);
  await plan(page);
  await showMap(page);
  await page.clock.install({ time: new Date("2026-09-04T08:00:00Z") });
  await page.clock.runFor(500);
  await expectMapSettled(page);
  const geometry = () =>
    page
      .locator("#map .leaflet-zoom-animated")
      .evaluateAll((elements) => elements.map((e) => e.getAttribute("style")));
  const before = await geometry();
  await page.locator("#map").dblclick({ position: { x: 700, y: 250 } });
  await page.clock.runFor(1000);
  expect(await geometry()).toEqual(before);
});
