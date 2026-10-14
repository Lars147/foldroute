import { expect, type Page } from "@playwright/test";

export async function expectPlanningComplete(page: Page) {
  await expect(page.locator(".route-choice").first()).toBeAttached();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#status")).toHaveCSS("display", "none");
}

export async function openSelectedDetails(page: Page) {
  if (await page.evaluate(() => innerWidth >= 900)) {
    await page.locator("#panel-details").scrollIntoViewIfNeeded();
    return;
  }
  const screen = await page
    .locator("#map-view")
    .getAttribute("data-result-screen");
  if (screen === "map") await page.locator("#map-open-details").click();
  else if (screen !== "detail")
    await page.locator('.route-choice[aria-pressed="true"]').click();
}
export async function showMap(page: Page) {
  if (await page.evaluate(() => innerWidth >= 900)) return;
  if (
    (await page.locator("#map-view").getAttribute("data-result-screen")) !==
    "map"
  )
    await page.locator("#panel-map-toggle").click();
}
