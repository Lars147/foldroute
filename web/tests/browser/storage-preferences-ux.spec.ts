import { expect, test, type Page } from "@playwright/test";
import { openStorageSeed } from "./app-fixture";
import { openSettingsSection } from "./assertions";
import type { StoragePreferences } from "../../src/storage-preferences";

async function seed(
  page: Page,
  preferences?: StoragePreferences,
  legacy = true,
  navigation = true,
) {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await openStorageSeed(page);
  return page.evaluate(
    async ({ preferences, legacy, navigation }) => {
      const { localDatabase } = await import("/src/storage.ts");
      const { exampleRecording } = await import("/src/example-data.ts");
      const { navigationJourney } = await import("/src/navigation-engine.ts");
      const snapshot = {
        version: 3 as const,
        savedAt: Date.now() / 1000,
        request: exampleRecording.request,
        settings: exampleRecording.settings,
        journey: exampleRecording.journey,
      };
      const active = {
        ...snapshot,
        version: 1 as const,
        sessionId: "retained-navigation",
        resumeEpoch: 0,
        journey: navigationJourney(snapshot.journey),
        progress: {
          legIndex: 0,
          maneuverIndex: 0,
          meters: 0,
          confirmedStops: [],
        },
      };
      const summary = {
        id: "existing-trip",
        originName: "A",
        destinationName: "B",
        arrivedAt: 1000,
        elapsedSeconds: 60,
        distanceMeters: 500,
        sinceResume: false,
        storageEpoch: 0,
      };
      const db = await localDatabase.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("state", "readwrite"),
          store = tx.objectStore("state");
        store.put(legacy, "enabled");
        if (preferences) store.put(preferences, "storagePreferences");
        store.put(
          { version: 1, entries: [{ id: "retained-route", snapshot }] },
          "history",
        );
        store.put(snapshot, "last");
        if (navigation) store.put(active, "activeNavigation");
        store.put(
          {
            version: 1,
            completedIds: [summary.id],
            distanceMeters: 500,
            elapsedSeconds: 60,
          },
          "navigationStatistics",
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      return { snapshot, active, summary };
    },
    { preferences, legacy, navigation },
  );
}

test("history deletion blocks late writes from a previously active calculation", async ({
  page,
}) => {
  const existing = await seed(page, {
    history: true,
    navigation: false,
    statistics: true,
  });
  const result = await page.evaluate(async (snapshot) => {
    const { OfflineStore } = await import("/src/offline.ts");
    const writer = new OfflineStore();
    await writer.save(snapshot, "old-calculation");
    await new OfflineStore().clear();
    const old = await writer.save(snapshot, "old-calculation");
    const fresh = await writer.save(snapshot, "new-calculation");
    return { old, fresh, entries: (await writer.read()).entries.length };
  }, existing.snapshot);
  expect(result).toEqual({ old: false, fresh: true, entries: 1 });
});

async function contents(page: Page) {
  return page.evaluate(async () => {
    const { localDatabase } = await import("/src/storage.ts");
    const db = await localDatabase.open();
    return new Promise<Record<string, any>>((resolve, reject) => {
      const tx = db.transaction("state"),
        store = tx.objectStore("state");
      const result: Record<string, any> = {};
      for (const key of [
        "history",
        "activeNavigation",
        "navigationStatistics",
        "storagePreferences",
      ])
        store.get(key).onsuccess = (event) => {
          result[key] = (event.target as IDBRequest).result ?? null;
        };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
    });
  });
}

test("concurrent preference changes retain every independent choice", async ({
  page,
}) => {
  await seed(page, { history: true, navigation: true, statistics: true });
  await page.evaluate(async () => {
    const { OfflineStore } = await import("/src/offline.ts");
    const { StoragePreferencesStore } =
      await import("/src/storage-preferences.ts");
    await Promise.all([
      new OfflineStore().setEnabled(false),
      new StoragePreferencesStore().set("navigation", false),
      new StoragePreferencesStore().set("statistics", false),
    ]);
  });
  const data = await contents(page);
  expect(data.storagePreferences).toEqual({
    history: false,
    navigation: false,
    statistics: false,
  });
  expect(data.history.entries).toHaveLength(1);
  expect(data.activeNavigation).not.toBeNull();
  expect(data.navigationStatistics.completedIds).toHaveLength(1);
});

for (const kind of ["navigation", "statistics"] as const)
  test(`${kind} preference rolls back visibly if storage fails`, async ({
    page,
  }) => {
    await seed(page, { history: true, navigation: false, statistics: true });
    await page.goto("/");
    await page.locator("#tab-settings").click();
    const before = await contents(page);
    await page.evaluate(async () => {
      const { StoragePreferencesStore } =
        await import("/src/storage-preferences.ts");
      StoragePreferencesStore.prototype.set = async () => {
        throw new Error("Storage unavailable");
      };
    });
    const checkbox = page.locator(
      kind === "navigation"
        ? "#navigation-storage-enabled"
        : "#statistics-enabled",
    );
    await expect(checkbox).toBeChecked({ checked: kind === "statistics" });
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: kind === "statistics" });
    await expect(checkbox).toBeEnabled();
    await expect(page.locator("#storage-message")).toContainText(
      "konnte nicht geändert werden",
    );
    expect(await contents(page)).toEqual(before);
  });

for (const legacy of [false, true])
  test(`legacy storage=${legacy} migrates all three switches without removing data`, async ({
    page,
  }) => {
    await seed(page, undefined, legacy, false);
    await page.goto("/");
    await page.locator("#tab-settings").click();
    for (const id of [
      "offline-enabled",
      "navigation-storage-enabled",
      "statistics-enabled",
    ])
      await expect(page.locator(`#${id}`)).toBeChecked({ checked: legacy });
    const data = await contents(page);
    expect(data.history.entries).toHaveLength(1);
    expect(data.navigationStatistics.completedIds).toHaveLength(1);
    expect(data.storagePreferences).toEqual({
      history: legacy,
      navigation: legacy,
      statistics: legacy,
    });
  });

test("three switches preserve existing data across opt-out and reload", async ({
  page,
}) => {
  await seed(page, { history: true, navigation: false, statistics: true });
  await page.goto("/");
  await page.locator("#tab-settings").click();
  const before = await contents(page);
  await page.locator("#navigation-storage-enabled").check();
  await page.locator("#navigation-storage-enabled").uncheck();
  await page.locator("#statistics-enabled").uncheck();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText(
    "Streckenverlauf: Speicherung ausgeschaltet. Vorhandene Daten bleiben erhalten.",
  );
  await expect(page.locator("#offline-enabled")).toBeEnabled();
  await page.reload();
  await page.locator("#tab-settings").click();
  for (const id of [
    "offline-enabled",
    "navigation-storage-enabled",
    "statistics-enabled",
  ])
    await expect(page.locator(`#${id}`)).not.toBeChecked();
  const after = await contents(page);
  expect(after.history).toEqual(before.history);
  expect(after.activeNavigation).toEqual(before.activeNavigation);
  expect(after.navigationStatistics).toEqual(before.navigationStatistics);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
});

for (let combination = 0; combination < 8; combination++) {
  const preferences = {
    history: !!(combination & 1),
    navigation: !!(combination & 2),
    statistics: !!(combination & 4),
  };
  test(`independent writes for preferences ${JSON.stringify(preferences)}`, async ({
    page,
  }) => {
    const existing = await seed(page, preferences);
    const result = await page.evaluate(
      async ({ snapshot, active, summary }) => {
        const { OfflineStore } = await import("/src/offline.ts");
        const { NavigationStore } = await import("/src/navigation-store.ts");
        const history = new OfflineStore(),
          navigation = new NavigationStore();
        snapshot.request.destination = {
          ...snapshot.request.destination,
          name: "New destination",
          longitude: snapshot.request.destination.longitude + 0.01,
        };
        await history.save(snapshot, "new-route");
        active.progress.meters = 25;
        await navigation.save(active);
        await navigation.completeTrip({ ...summary, id: "new-trip" });
        return {
          history: (await history.read()).entries.length,
          navigation: (await navigation.read(true))!.progress.meters,
          statistics: (await navigation.readStatistics()).statistics
            .completedIds.length,
          resumable: !!(await navigation.read()),
        };
      },
      existing,
    );
    expect(result).toEqual({
      history: preferences.history ? 2 : 1,
      navigation: preferences.navigation ? 25 : 0,
      statistics: preferences.statistics ? 2 : 1,
      resumable: preferences.navigation,
    });
  });
}

for (const kind of ["history", "navigation", "statistics"] as const)
  test(`confirmed ${kind} deletion affects only its own data`, async ({
    page,
  }) => {
    const existing = await seed(page, {
      history: true,
      navigation: false,
      statistics: true,
    });
    await page.goto("/");
    await page.locator("#tab-settings").click();
    await openSettingsSection(page, "data");
    const before = await contents(page);
    const button = page.locator(
      kind === "history" ? "#delete-saved" : `#delete-${kind}`,
    );
    const dialog = page.locator(
      kind === "history" ? "#delete-history-dialog" : "#delete-storage-dialog",
    );
    await button.click();
    await page.keyboard.press("Escape");
    expect(await contents(page)).toEqual(before);
    await button.click();
    await page
      .locator(
        kind === "history"
          ? "#cancel-delete-history"
          : "#cancel-delete-storage",
      )
      .click();
    expect(await contents(page)).toEqual(before);
    await button.click();
    await dialog
      .locator(
        kind === "history"
          ? "#confirm-delete-history"
          : "#confirm-delete-storage",
      )
      .click();
    await expect(dialog).toBeHidden();
    const after = await contents(page);
    expect(after.storagePreferences).toEqual(before.storagePreferences);
    expect(after.history.entries.length).toBe(kind === "history" ? 0 : 1);
    expect(after.activeNavigation).toEqual(
      kind === "navigation" ? null : before.activeNavigation,
    );
    expect(after.navigationStatistics).toEqual(
      kind === "statistics" ? null : before.navigationStatistics,
    );
    if (kind === "statistics") {
      const blocked = await page.evaluate(async ({ active, summary }) => {
        const { NavigationStore } = await import("/src/navigation-store.ts");
        const { StoragePreferencesStore } =
          await import("/src/storage-preferences.ts");
        await new StoragePreferencesStore().set("navigation", true);
        const store = new NavigationStore();
        await store.save(active);
        return {
          resumed: !!(await store.read()),
          recorded: !!(await store.completeTrip(summary)),
        };
      }, existing);
      expect(blocked).toEqual({ resumed: true, recorded: false });
    }
    if (kind === "navigation") {
      await page.evaluate(async (active) => {
        const { NavigationStore } = await import("/src/navigation-store.ts");
        const { StoragePreferencesStore } =
          await import("/src/storage-preferences.ts");
        await new StoragePreferencesStore().set("navigation", true);
        await new NavigationStore().save(active);
      }, existing.active);
      expect((await contents(page)).activeNavigation).toBeNull();
    }
  });

for (const width of [320, 390, 1280])
  test(`storage settings fit large text at ${width}px`, async ({
    page,
  }, info) => {
    await seed(page, { history: true, navigation: false, statistics: true });
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await page.goto("/");
    await page.locator("#tab-settings").click();
    await page
      .locator("#storage-settings")
      .screenshot({ path: info.outputPath("storage-settings.png") });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const id of [
      "offline-enabled",
      "navigation-storage-enabled",
      "statistics-enabled",
    ]) {
      await page.locator(`#${id}`).focus();
      await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
    }
    await openSettingsSection(page, "data");
    for (const id of [
      "delete-saved",
      "delete-navigation",
      "delete-statistics",
    ]) {
      await page.locator(`#${id}`).click();
      const dialog = page.locator(
        id === "delete-saved"
          ? "#delete-history-dialog"
          : "#delete-storage-dialog",
      );
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const confirm = dialog.locator(
        id === "delete-saved"
          ? "#confirm-delete-history"
          : "#confirm-delete-storage",
      );
      await confirm.focus();
      await expect(confirm).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
    }
  });
