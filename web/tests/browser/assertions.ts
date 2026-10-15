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
    await page.locator(".route-choice-row.selected .route-detail-link").click();
}
export async function showMap(page: Page) {
  if (await page.evaluate(() => innerWidth >= 900)) return;
  if (
    (await page.locator("#map-view").getAttribute("data-result-screen")) !==
    "map"
  )
    await page.locator("#panel-map-toggle").click();
}

export async function openSettingsSection(
  page: Page,
  section: "options" | "modes" | "data" | "help",
) {
  const group = page.locator(`#settings-${section}`);
  if ((await group.getAttribute("open")) === null)
    await group.locator(":scope > summary").click();
}

export async function expectSelectedJourneySaved(page: Page) {
  const selectedID = await page
    .locator(".route-choice[aria-pressed=true]")
    .getAttribute("data-journey");
  expect(selectedID).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string | undefined>((resolve, reject) => {
            const open = indexedDB.open("foldroute-offline", 2);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const request = db
                .transaction("state")
                .objectStore("state")
                .get("last");
              request.onerror = () => {
                db.close();
                reject(request.error);
              };
              request.onsuccess = () => {
                db.close();
                resolve(request.result?.journey?.id);
              };
            };
          }),
      ),
    )
    .toBe(selectedID);
}
