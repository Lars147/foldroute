import { test, expect, type Page } from "@playwright/test";
import { expectPlanningComplete, openSettingsSection } from "./assertions";
import { defaults } from "../../src/model";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };

const cors = { "Access-Control-Allow-Origin": "*" };
const place = {
  name: "Sweet Spot",
  lat: 48.175,
  lon: 11.6,
  areas: [
    { name: "München", unique: true },
    { name: "Altstadt-Lehel", adminLevel: 9 },
  ],
};
async function setup(page: Page, matches = [place]) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  await page.addInitScript(
    (settings) => {
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(settings));
      const geo = navigator.geolocation;
      const single = geo.getCurrentPosition.bind(geo),
        watch = geo.watchPosition.bind(geo);
      const stamped = (success: PositionCallback) => (p: GeolocationPosition) =>
        success({
          coords: p.coords,
          timestamp: Date.now(),
        } as GeolocationPosition);
      geo.getCurrentPosition = (success, error, options) =>
        single(stamped(success), error, options);
      geo.watchPosition = (success, error, options) =>
        watch(stamped(success), error, options);
    },
    { ...defaults, cyclingSpeedKilometersPerHour: 18, maxCyclingMinutes: 60 },
  );
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({ json: matches, headers: cors }),
  );
  await page.route("**/api/v1/reverse-geocode?*", (r) =>
    r.fulfill({ json: [], headers: cors }),
  );
  const requests: URL[] = [];
  await page.route("**/api/v6/plan?*", (r) => {
    const url = new URL(r.request().url());
    requests.push(url);
    return r.fulfill({
      headers: cors,
      json:
        url.searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    });
  });
  return requests;
}

test("shared address selects a unique place, searches now and uses own settings", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/?shareText=Sweet+Spot+M%C3%BCnchen");
  await expectPlanningComplete(page);
  await expect(page.locator("#shared-dialog")).toBeHidden();
  expect(page.url()).not.toContain("shareText");
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every((r) => r.searchParams.get("arriveBy") === "false"),
  ).toBe(true);
  expect(requests[0].searchParams.get("cyclingSpeed")).toBe("5.000");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("foldroute.sharedDestination.v1"),
    ),
  ).toBeNull();
  await page.screenshot({ path: test.info().outputPath("shared-route.png") });
});

test("ambiguous shared places stay selectable with district details", async ({
  page,
}) => {
  const requests = await setup(page, [
    place,
    {
      ...place,
      name: "Sweet Spot Süd",
      lat: 48.18,
      areas: [{ name: "Isarvorstadt", adminLevel: 9 }],
    },
  ]);
  await page.goto("/?shareTitle=Sweet+Spot");
  const choices = page.locator("#shared-destination-options .place-select");
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toContainText("Altstadt-Lehel");
  const inputBounds = await page.locator("#shared-destination").boundingBox();
  expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(390);
  expect(requests).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("shared-choices.png") });
  await choices.first().click();
  await expectPlanningComplete(page);
});

test("short links are not fetched; editable address remains available after cancel", async ({
  page,
}) => {
  await setup(page);
  let fetched = false;
  await page.route("https://maps.app.goo.gl/**", (r) => {
    fetched = true;
    return r.abort();
  });
  await page.goto("/?shareUrl=https%3A%2F%2Fmaps.app.goo.gl%2Fabc");
  await expect(page.locator("#shared-error")).toContainText(
    "Bitte Ziel eingeben",
  );
  await page.locator("#shared-cancel").click();
  await expect(page.locator("#shared-pending")).toBeVisible();
  await page.locator("#shared-pending").click();
  await page.locator("#shared-destination").fill("Sweet Spot");
  await page.locator("#shared-destination-options .place-select").click();
  await expectPlanningComplete(page);
  expect(fetched).toBe(false);
});

test("sharing does not silently replace saved navigation and can be deferred", async ({
  page,
}) => {
  const requests = await setup(page);
  const directShare =
    "/?shareUrl=" +
    encodeURIComponent("https://maps.apple.com/?q=Sweet%20Spot&ll=48.175,11.6");
  await page.goto(directShare);
  await expectPlanningComplete(page);
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-view")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open("foldroute-offline", 2);
            open.onsuccess = () => {
              const db = open.result;
              const request = db
                .transaction("state")
                .objectStore("state")
                .get("activeNavigation");
              request.onsuccess = () => {
                db.close();
                resolve(!!request.result);
              };
            };
          }),
      ),
    )
    .toBe(true);
  const before = requests.length;
  await page.goto(directShare);
  await expect(page.locator("#shared-navigation-dialog")).toBeVisible();
  expect(requests.length).toBe(before);
  await page.locator("#shared-navigation-keep").click();
  await expect(page.locator("#navigation-view")).toBeVisible();
  await expect(page.locator("#shared-pending")).toBeVisible();
  await page.locator("#shared-pending").click();
  await page.locator("#shared-navigation-replace").click();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await expectPlanningComplete(page);
});

test("a late shared search cannot override a manually edited destination", async ({
  page,
}) => {
  const requests = await setup(page);
  let release: () => void = () => {};
  let started = false;
  await page.route("**/api/v1/geocode?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("text") === "Sweet Spot"
    ) {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: [place], headers: cors });
    } else
      await route.fulfill({
        json: [{ ...place, name: "Manuelles Ziel" }],
        headers: cors,
      });
  });
  await page.goto("/?shareText=Sweet+Spot");
  await expect.poll(() => started).toBe(true);
  await page.locator("#shared-destination").fill("Manuell");
  release();
  await expect(
    page.locator("#shared-destination-options .place-select"),
  ).toContainText("Manuelles Ziel");
  await expect(page.locator("#shared-dialog")).toBeVisible();
  expect(requests).toHaveLength(0);
});

test("a missing location keeps the shared target available for manual planning", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_success, error) =>
      error?.({
        code: 1,
        message: "Denied",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
  });
  await page.goto(
    "/?shareUrl=" +
      encodeURIComponent(
        "https://maps.apple.com/?q=Sweet%20Spot&ll=48.175,11.6",
      ),
  );
  await expect(page.locator("#origin")).toBeVisible();
  await expect(page.locator("#destination")).toHaveValue("Sweet Spot");
  await expect(page.locator("#adjust-status")).not.toBeEmpty();
});

test("clearing local data also discards a deferred shared destination", async ({
  page,
}) => {
  await setup(page);
  await page.goto(
    "/?shareUrl=" + encodeURIComponent("https://maps.app.goo.gl/abc"),
  );
  await page.locator("#shared-cancel").click();
  await expect(page.locator("#shared-pending")).toBeVisible();
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "data");
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await expect(page.locator("#shared-pending")).toBeHidden();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("foldroute.sharedDestination.v1"),
    ),
  ).toBeNull();
});

test("production share target uses the static subpath and opens offline", async ({
  page,
  browserName,
}) => {
  await setup(page);
  const root = `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
  await page.goto(root);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const manifest = await page.evaluate(async () =>
    fetch(
      document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href,
    ).then((r) => r.json()),
  );
  expect(manifest.share_target).toEqual({
    action: "./",
    method: "GET",
    params: { title: "shareTitle", text: "shareText", url: "shareUrl" },
  });
  await page.reload();
  // WebKit's Playwright offline mode fails navigations before a service worker
  // can respond. Exercise real offline navigation in Chromium (Android engine).
  if (browserName === "chromium") {
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await page.context().setOffline(true);
  }
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", { get: () => false }),
  );
  await page.goto(root + "?shareText=Sweet+Spot");
  await expect(page.locator("#shared-dialog")).toBeVisible();
  await expect(page.locator("#shared-destination")).toHaveValue("Sweet Spot");
  await expect(page.locator("#shared-status")).toContainText("Offline");
  await page.locator(".search-focus-back").click();
  await page.locator("#shared-discard").click();
  await expect(page.locator("#shared-pending")).toBeHidden();
});
