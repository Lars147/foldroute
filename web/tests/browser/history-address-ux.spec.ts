import { test, expect, type Page } from "@playwright/test";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
const match = {
  type: "ADDRESS",
  lat: 48.132,
  lon: 11.5756,
  street: "Marienplatz",
  houseNumber: "22",
  areas: [{ name: "München", default: true }],
};
async function seed(page: Page) {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.addInitScript(() => {
    const geo = {
      getCurrentPosition() {
        throw new Error("Unexpected GPS request");
      },
      watchPosition() {
        throw new Error("Unexpected GPS watch");
      },
      clearWatch() {},
    };
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: geo,
    });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "prompt", onchange: null }) },
    });
  });
  await page.goto("/");
  await page.evaluate(async (fixture) => {
    const { OfflineStore } = await import("/src/offline.ts");
    const { defaults } = await import("/src/model.ts");
    const { mapResponse, baseVariants } = await import("/src/transitous.ts");
    const request = {
      origin: {
        name: "Startpunkt",
        detail: "",
        latitude: 48.132,
        longitude: 11.5756,
      },
      destination: {
        name: "Daglfing",
        detail: "",
        latitude: 48.175,
        longitude: 11.6,
      },
      timing: "depart",
      time: 1788508800,
    };
    const snapshot = {
      version: 3,
      savedAt: 1788508800,
      request,
      settings: defaults,
      journey: mapResponse(fixture.direct, request, defaults, baseVariants[0])
        .journeys[0],
    };
    await new OfflineStore().save(snapshot, "saved-route");
  }, fixture);
  await page.reload();
}
const read = (page: Page) =>
  page.evaluate(async () => {
    const { OfflineStore } = await import("/src/offline.ts");
    return new OfflineStore().read();
  });

test("backfills an old start address, keeps route data intact and opens it offline", async ({
  page,
}) => {
  let lookups = 0,
    plans = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/v6/plan")) plans++;
  });
  await page.route("**/api/v1/reverse-geocode?*", async (r) => {
    lookups++;
    await r.fulfill({
      json: [match],
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await seed(page);
  const before = await read(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toContainText(
    "Marienplatz 22, München → Daglfing",
  );
  const after = await read(page);
  expect(after.entries[0].snapshot).toEqual(before.entries[0].snapshot);
  expect(after.entries[0].id).toBe(before.entries[0].id);
  expect(lookups).toBe(1);
  expect(plans).toBe(0);
  await page.reload();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toContainText(
    "Marienplatz 22, München",
  );
  await page.context().setOffline(true);
  await page.locator(".history-open").click();
  await expect(page.locator("#panel-details")).toContainText(
    "Marienplatz 22, München",
  );
  expect(lookups).toBe(1);
  expect(plans).toBe(0);
});

test("a deleted history entry stays deleted after a delayed address response", async ({
  page,
}) => {
  let release!: () => void;
  let requested!: () => void;
  const started = new Promise<void>((r) => {
    requested = r;
  });
  await page.route("**/api/v1/reverse-geocode?*", async (route) => {
    requested();
    await new Promise<void>((r) => {
      release = r;
    });
    await route.fulfill({
      json: [match],
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await seed(page);
  await page.locator("#tab-history").click();
  await started;
  await page
    .getByRole("button", { name: "Fahrt nach Daglfing löschen" })
    .click();
  release();
  await expect(page.locator(".history-open")).toHaveCount(0);
  expect((await read(page)).entries).toEqual([]);
});

test("storage rejects stale enrichment after a newer calculation or disabling history", async ({
  page,
}) => {
  await seed(page);
  const results = await page.evaluate(async () => {
    const { OfflineStore } = await import("/src/offline.ts");
    const store = new OfflineStore();
    const old = (await store.read()).entries[0];
    const newer = structuredClone(old.snapshot);
    newer.savedAt++;
    await store.save(newer, "new-calculation");
    const stale = await store.updateNames(old, { origin: "Old address" });
    const current = (await store.read()).entries[0];
    await store.setEnabled(false);
    const disabled = await store.updateNames(current, {
      origin: "Late address",
    });
    return { stale, disabled, entries: (await store.read()).entries };
  });
  expect(results).toEqual({ stale: false, disabled: false, entries: [] });
});
