import { expect, type Page } from "@playwright/test";

export async function expectPlanningComplete(page: Page) {
  await expect(page.locator(".route-choice").first()).toBeAttached();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#status")).toHaveCSS("display", "none");
}

export async function resizeOverview(page: Page) {
  if (await page.evaluate(() => innerWidth >= 900)) return;
  const size = await page.locator("#journey-panel").getAttribute("data-size");
  await page
    .locator("#panel-handle")
    .press(size === "expanded" ? "ArrowDown" : "ArrowUp");
}
export async function toggleSelectedDetails(page: Page) {
  await page
    .locator(".route-choice-row.selected .route-details-button")
    .click();
}
