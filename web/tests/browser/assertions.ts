import { expect, type Page, type Locator } from "@playwright/test";

// Exercise the full editor through an existing route, without making a routing request.
export async function openRecordedRouteEditor(page: Page) {
  await page.evaluate(async () => {
    const storePath = "/src/offline.ts";
    const recordingPath = "/src/example-data.ts";
    const { OfflineStore } = await import(storePath);
    const { exampleRecording } = await import(recordingPath);
    await new OfflineStore().save(
      {
        version: 3,
        savedAt: Date.now() / 1000,
        request: exampleRecording.request,
        settings: exampleRecording.settings,
        journey: exampleRecording.journey,
      },
      "inline-editor-test",
    );
  });
  await page.reload();
  await openCachedJourney(page, page.locator("#open-saved"));
  await page.locator("#adjust-route").click();
  await expect(page.locator("#route-editor")).toHaveAttribute(
    "data-mode",
    "replan",
  );
}

// Measure final geometry after an entrance without disabling the animation.
export async function expectMotionSettled(element: Locator) {
  await expect
    .poll(() => element.evaluate((node) => node.getAnimations().length))
    .toBe(0);
}

export async function expectPlanningComplete(page: Page) {
  await expect(page.locator(".route-choice").first()).toBeAttached();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  const status = page.locator("#status");
  await expect(status).toHaveText(/^(?:Suche abgeschlossen\.)?$/);
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-search-status",
    "complete",
  );
}

async function closeAlternatives(page: Page) {
  if (
    (await page.locator("#alternatives-dialog").getAttribute("open")) === null
  )
    return;
  await page.locator("#alternatives-close").click();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => !!history.state?.journeyNavigation?.alternatives),
    )
    .toBe(false);
}

export async function openSelectedDetails(page: Page) {
  await closeAlternatives(page);
  if (await page.evaluate(() => innerWidth >= 900)) {
    await page.locator("#panel-details").scrollIntoViewIfNeeded();
    return;
  }
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    /^(list|detail|map)$/,
  );
  const screen = await page
    .locator("#map-view")
    .getAttribute("data-result-screen");
  if (screen === "map") await page.locator("#map-open-details").click();
  else if (screen !== "detail")
    await page.locator(".route-choice-row.selected .route-detail-link").click();
}
export async function showMap(page: Page) {
  await closeAlternatives(page);
  if (await page.evaluate(() => innerWidth >= 900)) return;
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    /^(list|detail|map)$/,
  );
  if (
    (await page.locator("#map-view").getAttribute("data-result-screen")) !==
    "map"
  )
    await page.locator("#panel-map-toggle").click();
}

export async function showConnections(page: Page) {
  if (
    (await page.locator("#alternatives-dialog").getAttribute("open")) !== null
  )
    return;
  if (await page.evaluate(() => innerWidth >= 900)) return;
  // matchMedia updates the result layout asynchronously after viewport changes.
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    /^(list|detail|map)$/,
  );
  if (
    (await page.locator("#map-view").getAttribute("data-result-screen")) !==
    "list"
  )
    await page.locator("#result-back").click();
}

export async function openSettingsSection(
  page: Page,
  section: "options" | "optimization" | "modes" | "data" | "help",
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

export async function addStop(page: Page) {
  await page.locator("#planner-more").click();
  await page.locator("#add-stop").click();
}
