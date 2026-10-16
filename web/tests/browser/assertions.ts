import { expect, type Page, type Locator } from "@playwright/test";

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

// Open the offline copy explicitly when a test exercises archived results or navigation.
export async function openCachedJourney(page: Page, trigger: Locator) {
  await expect(trigger).toBeVisible();
  const target = await trigger.evaluate((button: HTMLElement) => ({
    id: button.id,
    historyId: (button.closest(".history-row") as HTMLElement | null)?.dataset
      .historyId,
  }));
  const online = await page.evaluate(() => navigator.onLine);
  if (online) await page.context().setOffline(true);
  // Offline events rerender the list; resolve the same entry again in the current DOM.
  await page.evaluate(({ id, historyId }) => {
    const button = id
      ? document.getElementById(id)
      : [...document.querySelectorAll<HTMLElement>(".history-row")]
          .find((row) => row.dataset.historyId === historyId)
          ?.querySelector<HTMLElement>(".history-open");
    if (button && button.getClientRects().length) button.click();
  }, target);
  await expect(page.locator("#saved-notice")).toBeVisible();
  if (online) await page.context().setOffline(false);
}
