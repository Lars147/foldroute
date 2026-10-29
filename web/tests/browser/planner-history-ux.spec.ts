import {
  showConnections,
  openCachedJourney,
  openSettingsSection,
  showMap,
  expectPlanningComplete,
  expectSelectedJourneySaved,
  expectMotionSettled,
} from "./assertions";
import { test, expect, type Page } from "./test";
import { setup, choose, plan, cors } from "./planner-fixture";

test("settings errors retain old results and their original offline snapshot", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const priorChoices = await page.locator(".route-choice").count();
  await expectSelectedJourneySaved(page);
  const original = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("foldroute-offline", 2);
      r.onsuccess = () => resolve(r.result);
    });
    const value = await new Promise<any>((resolve) => {
      const r = db.transaction("state").objectStore("state").get("last");
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return value;
  });
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 500, headers: cors }),
  );
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4.5");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(priorChoices);
  await page.locator("#recover-planning").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(priorChoices);
  await page.locator("#close-route").click();
  await openCachedJourney(page, page.locator("#open-saved"));
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4.5");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
          .foldingDuration,
    ),
  ).toBe(270);
  expect(original.settings.foldingDuration).toBe(180);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBeNull();
});

test("Back and Forward restore distinct submitted plans without result history entries", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await showConnections(page);
  const first = page.url();
  const length = await page.evaluate(() => history.length);
  await page.locator(".route-choice").last().click();
  expect(page.url()).toBe(first);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await showMap(page);
  await page.locator("#adjust-route").click();
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({
      headers: cors,
      json: [{ name: "Weiteres Ziel", lat: 48.176, lon: 11.6 }],
    }),
  );
  await choose(page, "destination", "Weiteres Ziel");
  await page
    .locator("#route-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expectPlanningComplete(page);
  const second = page.url();
  expect(new URL(second).searchParams.get("toName")).toBe("Weiteres Ziel");
  await page.goBack();
  await expectPlanningComplete(page);
  expect(page.url()).toBe(first);
  await page.goForward();
  await expectPlanningComplete(page);
  expect(page.url()).toBe(second);
});

test("editing a saved now result uses its original search time without starting a search", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  await page.clock.setFixedTime(new Date("2026-09-04T08:10:45Z"));
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await showMap(page);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:00");
  await expect(page.locator("#when")).toHaveValue("2026-09-04T10:00");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  expect(requests).toBe(0);
});

test("history deduplicates routes, restores without requests and replans from fixed points", async ({
  page,
  context,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator("#tab-route").click();
  await showConnections(page);
  await page.locator(".route-choice").last().click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.goto("/");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-open small")).toHaveCount(0);
  await expect(page.locator(".history-open strong")).toHaveCount(1);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests++;
  });
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = () => {
      throw new Error("Archive must not request location");
    };
  });
  await openCachedJourney(page, page.locator(".history-open").last());
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#route-origin")).toHaveText("Startpunkt");
  await showMap(page);
  await page.goBack();
  await expect(page.locator("#history-view")).toBeVisible();
  await page.goForward();
  await page.locator("#map-open-details").click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  expect(requests).toBe(0);
  await showMap(page);
  await context.setOffline(true);
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#replan-saved")).toBeDisabled();
  expect(requests).toBe(0);
  await context.setOffline(false);
  await showMap(page);
  const queried = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#replan-saved").click();
  const url = new URL((await queried).url());
  expect(url.searchParams.get("fromPlace")?.split(",").map(Number)).toEqual([
    48.132, 11.5756,
  ]);
  await expectPlanningComplete(page);
  await expect(page.locator("#saved-notice")).toBeHidden();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.screenshot({
    path: `test-results/history-${test.info().project.name}.png`,
  });
});

for (const width of [320, 393, 1280]) {
  test(`history offers accessible deletion and undo at ${width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 320 ? "light" : "dark" });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").click();
    await expect(page.locator(".history-origin")).toContainText("Startpunkt");
    await expect(page.locator(".history-destination")).toHaveText("Ziel");
    await expect(page.locator(".history-timestamp")).toHaveText(
      "Geplant heute, 10:00",
    );
    await expect(page.locator("#history-edit")).toHaveCount(0);
    const heading = await page.locator("#history-heading").boundingBox();
    expect(heading!.height > 1).toBe(width >= 900);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: test.info().outputPath("history-list.png") });
    const positions = () =>
      page
        .locator(".history-row")
        .evaluate((row) =>
          [
            row,
            ...row.querySelectorAll(
              ".history-origin, .history-destination, .history-chevron",
            ),
          ].map((element) => element.getBoundingClientRect().toJSON()),
        );
    const beforeHover = await positions();
    await page.locator(".history-open").hover();
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "1");
    expect(await positions()).toEqual(beforeHover);
    await page.mouse.move(0, 0);
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "0");
    await page.locator(".history-open").focus();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator(".history-remove")).toBeFocused();
    await expect(page.locator(".history-open")).toHaveCSS("transform", "none");
    await expect(page.locator(".history-remove")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: test.info().outputPath("history-delete.png"),
    });
    await page.keyboard.press("Enter");
    await expect(page.locator("#history-empty")).toBeVisible();
    await expect(page.locator("#history-heading")).toBeFocused();
    await expect(page.locator("#history-undo")).toBeVisible();
    await page.locator("#history-undo-button").click();
    await expect(page.locator(".history-open")).toBeFocused();
    await expect(page.locator("#history-undo")).toBeHidden();
    await openCachedJourney(page, page.locator(".history-open"));
    await expect(page.locator("#history-view")).toBeHidden();
  });
}
test("history deletion and disabling persist without restoring deleted calculations", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await showConnections(page);
  await page.locator(".route-choice").last().click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "data");
  await page.locator("#delete-saved").click();
  await page.locator("#cancel-delete-history").click();
  await expect(page.locator("#delete-saved")).toBeEnabled();
  await openSettingsSection(page, "data");
  await page.locator("#delete-saved").click();
  await page.locator("#confirm-delete-history").click();
  await expect(page.locator("#delete-saved")).toBeDisabled();
  await page.locator("#tab-route").click();
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Speicherung ausgeschaltet",
  );
  await page.goto("/");
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator("#history-empty")).toBeHidden();
});

test("history storage caps entries atomically and guards pending writes during deletion", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = (await store.read()).snapshot;
    await store.clear();
    const routeSnapshot = (i: number) => {
      const result = structuredClone(snapshot);
      result.request.destination.longitude += i * 0.001;
      result.savedAt += i;
      return result;
    };
    await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        store.save(routeSnapshot(i), `calculation-${i}`),
      ),
    );
    const full = await store.read();
    await store.save(
      {
        ...routeSnapshot(10),
        savedAt: snapshot.savedAt + 100,
        journey: { ...snapshot.journey, id: "changed" },
      },
      "calculation-10",
    );
    const updated = await store.read();
    const pending = store.save(snapshot, "late");
    await store.clear();
    await pending;
    const cleared = await store.read();
    await store.remove("deleted");
    await store.save(snapshot, "deleted");
    const afterDelete = await store.read();
    return {
      ids: full.entries.map((e: { id: string }) => e.id),
      count: updated.entries.length,
      selected: updated.entries.find(
        (e: { id: string }) => e.id === "calculation-10",
      ).snapshot.journey.id,
      cleared: cleared.entries.length,
      afterDelete: afterDelete.entries.length,
    };
  });
  expect(result.ids).toHaveLength(20);
  expect(result.ids[0]).toBe("calculation-20");
  expect(result.ids).not.toContain("calculation-0");
  expect(result.count).toBe(20);
  expect(result.selected).toBe("changed");
  expect(result.cleared).toBe(0);
  expect(result.afterDelete).toBe(0);
});

test("small itinerary screens keep archived actions reachable", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await openCachedJourney(page, page.locator(".history-open").first());
  for (const [width, height, fontSize] of [
    [844, 390, 16],
    [390, 844, 24],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (size) => (document.documentElement.style.fontSize = `${size}px`),
      fontSize,
    );
    await showMap(page);
    await page.locator("#route-more").scrollIntoViewIfNeeded();
    await page.locator("#replan-saved").scrollIntoViewIfNeeded();
    await expect(page.locator("#replan-saved")).toBeInViewport({ ratio: 1 });
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").scrollIntoViewIfNeeded();
    await expect(page.locator("#navigation-start")).toBeInViewport({
      ratio: 0.99,
    });
    await page.keyboard.press("Escape");
    for (const id of ["adjust-route", "result-back"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
    }
  }
});

test("history normalizes persisted duplicates and guards stable IDs against late updates", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expectSelectedJourneySaved(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const storagePath = "/src/storage.ts";
    const { localDatabase } = await import(storagePath);
    const store = new OfflineStore();
    const snapshot = (await store.read()).snapshot;
    const newer = { ...snapshot, savedAt: snapshot.savedAt + 10 };
    const db = await localDatabase.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(
        {
          version: 1,
          entries: [
            { id: "older", snapshot },
            { id: "stable", snapshot: newer },
          ],
        },
        "history",
      );
      tx.objectStore("state").put(snapshot, "last");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const normalized = await store.read();
    const persisted = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const history = tx.objectStore("state").get("history");
      const last = tx.objectStore("state").get("last");
      tx.oncomplete = () =>
        resolve({ history: history.result, last: last.result });
      tx.onabort = () => reject(tx.error);
    });
    await store.save(
      { ...newer, savedAt: newer.savedAt + 1 },
      "new-calculation",
    );
    const stable = (await store.read()).entries[0].id;
    const stale = await store.save(snapshot, "late");
    await store.remove(stable);
    const resurrected = await store.save(
      { ...newer, savedAt: newer.savedAt + 2 },
      "new-calculation",
    );
    const removed = (await store.read()).entries.length;
    const recreated = await store.save(
      { ...newer, savedAt: newer.savedAt + 3 },
      "deliberate-new-calculation",
    );
    return {
      invalid: normalized.invalid,
      normalized: normalized.entries.length,
      persisted: persisted.history.entries.length,
      last: persisted.last.savedAt === newer.savedAt,
      stable,
      stale,
      resurrected,
      removed,
      recreated,
    };
  });
  expect(result).toEqual({
    invalid: false,
    normalized: 1,
    persisted: 1,
    last: true,
    stable: "stable",
    stale: false,
    resurrected: false,
    removed: 0,
    recreated: true,
  });
});

test("history deletion during a pending recalculation does not resurrect the route", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (route) => {
    await gate;
    await route.fallback();
  });
  const started = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await started;
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  release();
  await expectPlanningComplete(page);
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-route").click();
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
});

test("history deletion while locating survives the location response", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (success) => {
      (window as any).resolveHistoryLocation = () =>
        success({
          coords: { latitude: 48.132, longitude: 11.5756 },
        } as GeolocationPosition);
    };
  });
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  await page.locator("#tab-history").click();
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.evaluate(() => (window as any).resolveHistoryLocation());
  await expectPlanningComplete(page);
  await expect(page.locator(".history-row")).toHaveCount(0);
});

for (const width of [390, 1479]) {
  for (const archived of [false, true]) {
    test(`map background leaves result navigation unchanged at ${width}, archived=${archived}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 986 });
      await setup(page);
      await plan(page);
      if (archived) {
        await page.locator("#tab-history").click();
        await openCachedJourney(page, page.locator(".history-open").first());
      }
      await showMap(page);
      const panel = page.locator("#journey-panel");
      const initial = await panel.boundingBox();
      await page
        .locator("#map")
        .click({ position: { x: width >= 900 ? width - 140 : 20, y: 60 } });
      expect(await panel.boundingBox()).toEqual(initial);
      await expect(page.locator("#panel-handle")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("stable-map.png") });
    });
  }
}

test("new GPS planning enriches history without renaming the active origin", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(
      navigator.geolocation,
    );
    (window as any).gpsRequests = 0;
    navigator.geolocation.getCurrentPosition = (...args) => {
      (window as any).gpsRequests++;
      return original(...args);
    };
  });
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({
      headers: cors,
      json: [
        {
          type: "ADDRESS",
          lat: 48.132,
          lon: 11.5756,
          street: "Marienplatz",
          houseNumber: "22",
          areas: [{ name: "München", default: true }],
        },
      ],
    }),
  );
  await plan(page);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await expect(page.locator("#result-context")).toHaveText(
    "Aktueller Standort → Ziel",
  );
  await expect(page.locator("#adjust-route")).toHaveAccessibleDescription(
    /Aktueller Standort Ziel/,
  );
  const gpsRequests = await page.evaluate(() => (window as any).gpsRequests);
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  expect(
    await page.evaluate(() => (window as any).gpsRequests),
  ).toBeGreaterThan(gpsRequests);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
  await showMap(page);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
  await page.locator("#cancel-adjust").click();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open").first()).toContainText(
    "Marienplatz 22, München",
  );
  await openCachedJourney(page, page.locator(".history-open").first());
  await expect(page.locator("#route-origin")).toHaveText(
    "Marienplatz 22, München",
  );
  await showMap(page);
  await page.locator("#adjust-route").click();
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Start");
  await showMap(page);
  await page.locator("#adjust-route").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeEnabled();
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Aktueller Standort");
});

for (const origin of ["history", "search"]) {
  test(`saved map returns to its origin from ${origin}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").click();
    await expect(page.locator(".history-open")).toHaveCount(1);
    if (origin === "search") {
      await page.goto("/");
      await openCachedJourney(page, page.locator("#open-saved"));
    } else await openCachedJourney(page, page.locator(".history-open"));
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v6/plan?")) requests++;
    });
    await showMap(page);
    await expect(page.locator("#result-back")).toHaveText(
      origin === "history" ? "Verlauf" : "Zur Suche",
    );
    await expect(page.locator("#map-preview-heading")).toHaveText(
      "Gespeicherte Route",
    );
    await expect(
      page.locator("#map-preview-actions #replan-saved"),
    ).toBeVisible();
    await expect(page.locator("#map-preview-status")).toBeVisible();
    await page.locator("#route-more").click();
    await expect(
      page.locator("#route-actions-dialog #navigation-start"),
    ).toBeVisible();
    await expect(page.locator("#route-action-stand")).toContainText(
      "Gespeichert:",
    );
    await page.keyboard.press("Escape");
    await page.locator("#result-back").click();
    await expect(page.locator(`#${origin}-view`)).toBeVisible();
    if (origin === "history")
      await expect(page.locator(".history-open")).toBeFocused();
    await page.goBack();
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "map",
    );
    await page.goForward();
    await expect(page.locator(`#${origin}-view`)).toBeVisible();
    await page.goBack();
    await page.locator("#map-open-details").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    expect(requests).toBe(0);
  });
}

test("history undo preserves snapshots, blocks late writes and respects replacement and clearing", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const result = await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const base = (await store.read()).snapshot;
    await store.clear();
    await store.save(base, "original");
    const before = (await store.read()).entries[0];
    const token = await store.remove(before.id);
    const restored = await store.restoreDeleted(token);
    const after = (await store.read()).entries[0];
    const late = await store.save(
      { ...base, savedAt: base.savedAt + 1 },
      "original",
    );
    const newerToken = await store.remove(before.id);
    await store.save({ ...base, savedAt: base.savedAt + 2 }, "newer");
    const newer = await store.restoreDeleted(newerToken);
    const current = (await store.read()).entries[0].id;
    const clearedToken = await store.remove(current);
    await store.clear();
    const cleared = await store.restoreDeleted(clearedToken);
    await store.save(base, "disable");
    const disabledToken = await store.remove("disable");
    await store.setEnabled(false);
    await store.setEnabled(true);
    const disabled = await store.restoreDeleted(disabledToken);
    await store.save(base, "capacity");
    const capacityToken = await store.remove("capacity");
    for (let i = 1; i <= 20; i++) {
      const snapshot = structuredClone(base);
      snapshot.request.destination.longitude += i * 0.01;
      await store.save(snapshot, `other-${i}`);
    }
    const full = await store.restoreDeleted(capacityToken);
    return {
      restored,
      exact: JSON.stringify(before) === JSON.stringify(after),
      late,
      newer,
      current,
      cleared,
      disabled,
      full,
      count: (await store.read()).entries.length,
    };
  });
  expect(result).toEqual({
    restored: "restored",
    exact: true,
    late: false,
    newer: "newer",
    current: "newer",
    cleared: "unavailable",
    disabled: "unavailable",
    full: "unavailable",
    count: 20,
  });
});

test("history undo expires and storage failure keeps the row", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-history").click();
  await page.locator(".history-remove").focus();
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as any).restoreHistoryTransactions = () => {
      IDBDatabase.prototype.transaction = original;
    };
    IDBDatabase.prototype.transaction = function () {
      throw new Error("Storage unavailable");
    };
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#toast")).toContainText("nicht gelöscht");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator("#history-undo")).toBeHidden();
  await page.evaluate(() => (window as any).restoreHistoryTransactions());
  await page.keyboard.press("Enter");
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#history-undo-button").focus();
  await page.clock.fastForward(9000);
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#tab-history").focus();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(8100);
  await expect(page.locator("#history-undo")).toBeHidden();
});

test.describe("history touch gestures", () => {
  test.use({ hasTouch: true, viewport: { width: 393, height: 852 } });

  // Synthetic pointer input allows the same gesture checks in Chromium and WebKit.
  // Native pointer capture is stubbed because synthetic pointers aren't OS-owned.
  async function swipe(page: Page, dx: number, dy = 0) {
    await expect(page.locator(".history-row").first()).toBeVisible();
    await page.evaluate(
      ({ dx, dy }) => {
        const row = document.querySelector<HTMLElement>(".history-row")!;
        row.setPointerCapture = () => {};
        const target = row.querySelector(".history-open")!;
        const send = (type: string, x: number, y: number) =>
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: "touch",
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        send("pointerdown", 250, 200);
        send("pointermove", 250 + dx, 200 + dy);
        // Implicit capture on the child is released when the row takes over.
        send("lostpointercapture", 250 + dx, 200 + dy);
        send("pointerup", 250 + dx, 200 + dy);
        if (Math.abs(dx) > Math.abs(dy))
          target.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
      },
      { dx, dy },
    );
  }
  test("native touch keeps dragging across pointer capture transfer", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Native touch injection uses CDP; capture regression also covered in WebKit below.",
    );
    await setup(page);
    await plan(page);
    await page.evaluate(() =>
      localStorage.setItem("foldroute.historySwipeSeen.v1", "true"),
    );
    await page.reload();
    await page.locator("#tab-history").tap();
    await page.evaluate(() => {
      (window as any).nativeTouchEvents = [];
      for (const type of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "lostpointercapture",
        "click",
      ])
        window.addEventListener(type, (event) => {
          (window as any).nativeTouchEvents.push({
            type,
            target: (event.target as Element).getAttribute("class"),
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            time: performance.now(),
          });
        });
    });
    const row = page.locator(".history-row").first();
    await expect(row).toBeVisible();
    let box!: { x: number; y: number; width: number; height: number };
    await expect
      .poll(async () => {
        const bounds = await row.boundingBox();
        if (bounds) box = bounds;
        return bounds?.width ?? 0;
      })
      .toBeGreaterThan(100);
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width - 35,
      y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (const distance of [15, 30, 50, 75, 95]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - distance, y }],
      });
      // Give the browser a frame per movement, as a physical touch would.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(row).toHaveClass(/swipe-open/);
    await expect(page.locator("#history-view")).toBeVisible();
    await expectMotionSettled(row.locator(".history-open"));
    const events = await page.evaluate(() => (window as any).nativeTouchEvents);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "lostpointercapture",
          target: "history-open",
          trusted: true,
        }),
        expect.objectContaining({
          type: "pointermove",
          target: expect.stringContaining("history-row"),
          trusted: true,
        }),
      ]),
    );
    // Verify native capture here. The cross-browser swipe test below verifies
    // tapping Delete; Chromium's CDP touch emulator can swallow a follow-up tap.
    await expect(page.locator(".history-remove")).toBeInViewport();
    await test.info().attach("native-touch-events", {
      body: JSON.stringify(events),
      contentType: "application/json",
    });
    await client.detach();
  });
  test("swipe reveals only; vertical scroll and short drag do not open or delete", async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.evaluate(() =>
      localStorage.setItem("foldroute.historySwipeSeen.v1", "true"),
    );
    await page.reload();
    await page.locator("#tab-history").click();
    await swipe(page, -15, 70);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -20);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await expect(page.locator(".history-row")).toHaveClass(/swipe-open/);
    await expect(page.locator("#history-view")).toBeVisible();
    await expect(page.locator(".history-row")).toHaveCount(1);
    await swipe(page, 80);
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await page.keyboard.press("Escape");
    await expect(page.locator(".history-row")).not.toHaveClass(/swipe-open/);
    await swipe(page, -80);
    await page.locator(".history-remove").tap();
    await expect(page.locator(".history-row")).toHaveCount(0);
    await expectMotionSettled(page.locator("#history-undo"));
    await page.locator("#history-undo-button").tap();
    await expect(page.locator(".history-row")).toHaveCount(1);
  });
  test("losing the row capture still cancels the gesture", async ({ page }) => {
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await page
      .locator(".history-row")
      .first()
      .evaluate((row) => {
        row.setPointerCapture = () => {};
        const child = row.querySelector(".history-open")!;
        const event = (type: string, x: number) =>
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 9,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: x,
            clientY: 100,
          });
        child.dispatchEvent(event("pointerdown", 250));
        child.dispatchEvent(event("pointermove", 170));
        row.dispatchEvent(event("lostpointercapture", 170));
        row.dispatchEvent(event("pointerup", 170));
      });
    await expect(page.locator(".history-row")).not.toHaveClass(
      /swipe-open|swipe-dragging/,
    );
    await expect(page.locator("#history-view")).toBeVisible();
  });
  test("first visit animates once and interruption cannot open the journey", async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await expect(page.locator(".swipe-demo")).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("foldroute.historySwipeSeen.v1"),
        ),
      )
      .toBe("true");
    await page.locator(".history-open").tap();
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
    await expect(page.locator("#history-view")).toBeVisible();
    await page.reload();
    await page.locator("#tab-history").tap();
    await page.clock.fastForward(2500);
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
  });
  test("reduced motion skips demonstration without disabling deletion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page);
    await plan(page);
    await page.locator("#tab-history").tap();
    await page.clock.fastForward(2500);
    await expect(page.locator(".swipe-demo")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("foldroute.historySwipeSeen.v1"),
      ),
    ).toBeNull();
    await swipe(page, -90);
    await expect(page.locator(".history-row")).toHaveClass(/swipe-open/);
    await expect(page.locator(".history-open")).toHaveCSS(
      "transition-duration",
      "0s",
    );
  });
});

test("history undo restores only the latest deletion and clearing invalidates it", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = structuredClone((await store.read()).snapshot);
    snapshot.request.destination.longitude += 0.05;
    snapshot.request.destination.name = "Anderes Ziel";
    snapshot.journey.destination.name = "Anderes Ziel";
    snapshot.savedAt += 1;
    await store.save(snapshot, "second");
  });
  await page.reload();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(2);
  await page.locator(".history-remove").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#history-undo-button").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-destination")).toHaveText("Ziel");
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#history-undo")).toBeVisible();
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#history-undo")).toBeHidden();
});

test("desktop history keeps long routes readable beside delete action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 852 });
  await setup(page);
  await plan(page);
  await page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    const store = new OfflineStore();
    const snapshot = structuredClone((await store.read()).snapshot);
    const origin =
      "Daglfinger Straße 99a, München – Eingang am Fahrradparkplatz";
    const destination = "Frankfurt (Main) Süd – Ausgang zur Schweizer Straße";
    snapshot.request.origin.name = snapshot.journey.origin.name = origin;
    snapshot.request.destination.name = snapshot.journey.destination.name =
      destination;
    await store.clear();
    await store.save(snapshot, "long-route");
  });
  await page.reload();
  await page.locator("#tab-history").click();
  const row = page.locator('.history-row[data-history-id="long-route"]');
  await expect(row).toBeVisible();
  await row.hover();
  await expect(row.locator(".history-remove")).toHaveCSS("opacity", "1");
  expect(
    await row.evaluate((element) => {
      const button = element.querySelector(".history-open")!;
      const content = button.getBoundingClientRect();
      const action = element
        .querySelector(".history-remove")!
        .getBoundingClientRect();
      return (
        button.scrollWidth <= button.clientWidth &&
        content.right + 12 <= action.left &&
        action.width >= 44 &&
        action.height >= 44
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("history-desktop-long-route.png"),
  });
  await row.locator(".history-remove").click();
  await expect(row).toHaveCount(0);
  await page.locator("#history-undo-button").click();
  await expect(row.locator(".history-destination")).toContainText(
    "Frankfurt (Main) Süd",
  );
});

test("silent storage success preserves an unrelated settings warning", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "foldroute.routing.v3")
        throw new DOMException("Blocked", "SecurityError");
      return getItem.call(this, key);
    };
  });
  await setup(page);
  await expect(page.locator("#storage-message")).toContainText(
    "nur für diese Sitzung",
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expectSelectedJourneySaved(page);
  await expect(page.locator("#storage-message")).toContainText(
    "nur für diese Sitzung",
  );
  await page.locator("#tab-settings").click();
  await page.locator("#cyclingSpeedKilometersPerHour").fill("20");
  await page.locator("#cyclingSpeedKilometersPerHour").blur();
  await expect(page.locator("#storage-message")).toBeEmpty();
  await expect(page.locator("#toast")).toBeHidden();
});
