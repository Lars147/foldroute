import { test, expect } from "./test";
import { waitForAppReady } from "./app-fixture";
async function open(page: import("./test").Page) {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await waitForAppReady(page);
  await page.locator("#tab-settings").click();
  await page.locator("#settings-data > summary").click();
}
async function backup(page: import("./test").Page) {
  return page.evaluate(async () =>
    (await import("/src/backup-storage.ts")).createBackup(),
  );
}
test("download and restore all durable data after a fresh installation", async ({
  page,
}) => {
  await open(page);
  await seedHistory(page);
  const value = await backup(page);
  value.settings["foldroute.appearance"] = "dark";
  value.storage = { history: false, navigation: false, statistics: false };
  value.places = [
    {
      id: "home",
      favorite: true,
      place: { name: "Zuhause", detail: "", latitude: 48, longitude: 11 },
    },
  ];
  value.statistics = {
    version: 1,
    completedIds: ["trip"],
    distanceMeters: 1200,
    elapsedSeconds: 600,
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(page.getByRole("dialog")).toContainText("1 Orte");
  await page
    .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
    .click();
  await waitForAppReady(page);
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const restored = await backup(page);
  expect(restored.places).toEqual(value.places);
  expect(restored.statistics).toEqual(value.statistics);
  expect(restored.history).toEqual(value.history);
  expect(restored.storage).toEqual(value.storage);
  await page.locator("#tab-settings").click();
  await page.locator("#settings-data > summary").click();
  await page
    .getByRole("button", { name: "Daten sichern", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Sicherungsdatei herunterladen" })
    .click();
  expect((await download).suggestedFilename()).toMatch(
    /^foldroute-sicherung-.*\.json$/,
  );
});
test("invalid files and cancellation preserve existing data", async ({
  page,
}) => {
  await open(page);
  const before = await backup(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.locator(".backup-actions [role=status]")).toContainText(
    "Ungültige",
  );
  await input.setInputFiles({
    name: "good.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(before)),
  });
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  const after = await backup(page);
  expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
});
test("another open FoldRoute window blocks replacement", async ({
  page,
  context,
}) => {
  await open(page);
  const before = await backup(page);
  const second = await context.newPage();
  await second.goto("/");
  await waitForAppReady(second);
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(before)),
  });
  await page
    .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "andere FoldRoute-Fenster schließen",
  );
  const after = await backup(page);
  expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
  await second.close();
});
test("startup rolls back an interrupted preference write before controllers load", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const { backupKeys } = await import("/src/backup-codec.ts");
    const { localDatabase } = await import("/src/storage.ts");
    const old = Object.fromEntries(
      backupKeys.map((k) => [k, localStorage.getItem(k)]),
    );
    old["foldroute.appearance"] = "light";
    const db = await localDatabase.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(old, "backupRollback");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    localStorage.setItem("foldroute.backupPending", "true");
    localStorage.setItem("foldroute.appearance", "dark");
  });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("foldroute.backupPending")),
  ).toBeNull();
});

for (const failure of ["preferences", "database"] as const)
  test(`${failure} write failure rolls back both stores`, async ({ page }) => {
    await open(page);
    const before = await backup(page);
    const value = structuredClone(before);
    value.settings["foldroute.appearance"] = "dark";
    value.places = [
      {
        id: "new",
        favorite: true,
        place: { name: "Neu", detail: "", latitude: 49, longitude: 12 },
      },
    ];
    await page.locator('input[type="file"]').setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
    await page.evaluate((kind) => {
      if (kind === "preferences") {
        const original = Storage.prototype.setItem;
        let failed = false;
        Storage.prototype.setItem = function (key, value) {
          if (!failed && key === "foldroute.appearance" && value === "dark") {
            failed = true;
            throw new DOMException("Injected quota", "QuotaExceededError");
          }
          original.call(this, key, value);
        };
      } else {
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (stores, mode, options) {
          const tx = original.call(this, stores, mode, options);
          if (
            mode === "readwrite" &&
            Array.isArray(stores) &&
            stores.includes("places")
          )
            queueMicrotask(() => tx.abort());
          return tx;
        };
      }
    }, failure);
    await page
      .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Vorhandene Daten ersetzen",
        exact: true,
      }),
    ).toBeEnabled();
    const after = await backup(page);
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("foldroute.backupPending"),
      ),
    ).toBeNull();
  });
test("corrupt raw data cannot silently disappear from an export", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const { localDatabase } = await import("/src/storage.ts");
    const db = await localDatabase.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("places", "readwrite");
      tx.objectStore("places").put({ id: "bad" }, "bad");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  });
  await page
    .getByRole("button", { name: "Daten sichern", exact: true })
    .click();
  await expect(page.locator(".backup-actions [role=status]")).toContainText(
    "Ungültige",
  );
  await expect(
    page.getByRole("link", { name: "Sicherungsdatei herunterladen" }),
  ).toHaveCount(0);
});
test("unavailable localStorage does not prevent ordinary startup", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Denied", "SecurityError");
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException("Denied", "SecurityError");
    };
  });
  await page.goto("/");
  await waitForAppReady(page);
  await expect(page.locator("#search-view")).toBeVisible();
});
test("an open example route also prevents replacement", async ({
  page,
  context,
}) => {
  await open(page);
  const value = await backup(page);
  const demo = await context.newPage();
  await demo.goto("/?example=bike-transfer");
  await waitForAppReady(demo);
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await page
    .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "andere FoldRoute-Fenster schließen",
  );
  await demo.close();
});
test("failed rollback keeps its original journal and blocks further UI mutations", async ({
  page,
}) => {
  await open(page);
  const value = await backup(page);
  value.settings["foldroute.appearance"] = "dark";
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await page.evaluate(() => {
    const set = Storage.prototype.setItem,
      remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "foldroute.appearance")
        throw new DOMException("Denied", "SecurityError");
      set.call(this, k, v);
    };
    Storage.prototype.removeItem = function (k) {
      if (k === "foldroute.appearance")
        throw new DOMException("Denied", "SecurityError");
      remove.call(this, k);
    };
  });
  await page
    .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Wiederherstellung unterbrochen",
  );
  await expect(
    page.getByRole("button", { name: "Abbrechen", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(async () => {
      const { localDatabase } = await import("/src/storage.ts");
      const db = await localDatabase.open();
      return new Promise((resolve) => {
        const req = db
          .transaction("state")
          .objectStore("state")
          .get("backupRollback");
        req.onsuccess = () => resolve(req.result);
      });
    }),
  ).toBeTruthy();
  await page.reload();
  await waitForAppReady(page);
});
test("unsupported locks permit export but never replacement", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    }),
  );
  await open(page);
  const value = await backup(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await page
    .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Browser nicht unterstützt",
  );
});
test("canceling native file sharing does not claim a saved backup", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", {
      value: () => true,
      configurable: true,
    });
    Object.defineProperty(navigator, "share", {
      value: async () => {
        throw new DOMException("Canceled", "AbortError");
      },
      configurable: true,
    });
  });
  await open(page);
  await page
    .getByRole("button", { name: "Daten sichern", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Datei speichern / teilen", exact: true })
    .click();
  await expect(page.locator(".backup-actions [role=status]")).toContainText(
    "Sicherungsdatei bereit",
  );
  await expect(
    page.getByRole("link", { name: "Sicherungsdatei herunterladen" }),
  ).toBeVisible();
});
test("completed import markers do not roll back committed settings", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    localStorage.setItem("foldroute.backupPending", "true");
    localStorage.setItem("foldroute.appearance", "dark");
  });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => localStorage.getItem("foldroute.backupPending")),
  ).toBeNull();
});
test("unexpected lock loss reloads before normal foreground work resumes", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "test-backup-loads",
      String(Number(sessionStorage.getItem("test-backup-loads") ?? 0) + 1),
    ),
  );
  await open(page);
  const thief = await context.newPage();
  await thief.route("**/lock-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Lock test</title>",
    }),
  );
  await thief.goto("/lock-test");
  const navigated = page.waitForEvent(
    "framenavigated",
    (frame) => frame === page.mainFrame(),
  );
  await thief.evaluate(async () => {
    await navigator.locks.request(
      "foldroute-backup-access",
      { steal: true },
      async () => {},
    );
  });
  await page.bringToFront();
  await page
    .evaluate(() => window.dispatchEvent(new Event("focus")))
    .catch(() => {});
  await navigated;
  await waitForAppReady(page);
  expect(
    await page.evaluate(() => sessionStorage.getItem("test-backup-loads")),
  ).toBe("2");
  await thief.close();
});

async function seedHistory(page: import("./test").Page) {
  await page.evaluate(async () => {
    const { localDatabase } = await import("/src/storage.ts");
    const { exampleRecording } = await import("/src/example-data.ts");
    const snapshot = {
      version: 3,
      savedAt: Date.now() / 1000,
      request: exampleRecording.request,
      settings: exampleRecording.settings,
      journey: exampleRecording.journey,
    };
    const db = await localDatabase.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(
        { version: 1, entries: [{ id: "saved-route", snapshot }] },
        "history",
      );
      tx.objectStore("state").put(snapshot, "last");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  });
}
for (const sessionStorageAvailable of [true, false])
  test(`offline restoration starts at home despite imported history and sessionStorage ${sessionStorageAvailable ? "available" : "blocked"}`, async ({
    page,
  }) => {
    await open(page);
    await seedHistory(page);
    const value = await backup(page);
    if (!sessionStorageAvailable) {
      const blockSessionStorage = () => {
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get() {
            throw new DOMException("Session storage blocked", "SecurityError");
          },
        });
      };
      await page.addInitScript(blockSessionStorage);
      await page.evaluate(blockSessionStorage);
    }
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "onLine", {
        value: false,
        configurable: true,
      }),
    );
    let plans = 0;
    await page.route("**/api/v6/plan?*", (route) => {
      plans++;
      return route.abort();
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
    await page
      .getByRole("button", { name: "Vorhandene Daten ersetzen", exact: true })
      .click();
    await expect(page.locator("#search-view")).toBeVisible();
    await waitForAppReady(page);
    expect(new URL(page.url()).search).toBe("");
    expect((await backup(page)).history).toEqual(value.history);
    expect(plans).toBe(0);
  });
