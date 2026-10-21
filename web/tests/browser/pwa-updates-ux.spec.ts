import { expect, test, type Page } from "@playwright/test";
import { withUpdateServer } from "./pwa-server";
import { expectPlanningComplete } from "./assertions";
import { defaults } from "../../src/model";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };

test.beforeEach(async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  // WebKit cannot route requests intercepted by a service worker. Mock the app's
  // fetch boundary while leaving real service-worker downloads untouched.
  await context.addInitScript((recording) => {
    const fetcher = window.fetch.bind(window);
    const planningGate = new Promise<void>((resolve) => {
      window.addEventListener("test:finish-planning", () => resolve(), {
        once: true,
      });
    });
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (url.hostname === "api.transitous.org") {
        if (url.pathname === "/api/v1/geocode")
          return json([{ name: "Ziel", lat: 48.175, lon: 11.6 }]);
        if (url.pathname === "/api/v6/plan") {
          await planningGate;
          const direct = structuredClone(recording);
          const start = new Date().toISOString();
          const end = new Date(Date.now() + 1920000).toISOString();
          direct.direct[0].startTime = start;
          direct.direct[0].endTime = end;
          direct.direct[0].legs[0].startTime = start;
          direct.direct[0].legs[0].endTime = end;
          return json(direct);
        }
        return json([]);
      }
      if (url.hostname === "tiles.openfreemap.org")
        throw new TypeError("Test basemap unavailable");
      return fetcher(input, init);
    };
  }, fixture.direct);
});

async function discover(page: Page) {
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.ready).update();
  });
  await expect(page.locator("#tab-settings")).toHaveAttribute(
    "aria-label",
    "Einstellungen, Update verfügbar",
  );
}

test("updates preserve drafts, dismiss for the session and activate from settings", async ({
  page,
}) => {
  await withUpdateServer(page, async (release) => {
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
    await expect(page.locator("#update-banner")).toBeHidden();
    const legacyCached = () =>
      page.evaluate(
        async () =>
          !!(await caches.match(new URL("splash/legacy.png", location.href), {
            ignoreSearch: true,
          })),
      );
    expect(await legacyCached()).toBe(true);
    await page.locator("#destination").fill("Ungespeicherter Entwurf");
    release.revision = 2;
    await discover(page);
    await expect(page.locator("#update-banner")).toBeHidden();
    await expect(page.locator("#destination")).toHaveValue(
      "Ungespeicherter Entwurf",
    );
    await page.locator("#destination").fill("");
    if (await page.locator(".search-focus-back").isVisible())
      await page.locator(".search-focus-back").click();
    await expect(page.locator("#update-banner")).toBeVisible();
    await expect(page.locator("#update-now")).toBeEnabled();
    await page.locator("#update-later").click();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.reload();
    await expect(page.locator("#app-startup")).toBeHidden();
    await expect(page.locator("#update-banner")).toBeHidden();
    await expect(page.locator("#tab-settings .update-badge")).toBeVisible();
    await page.locator("#tab-settings").click();
    await expect(page.locator("#settings-update-now")).toBeVisible();
    let loads = 0;
    page.on("load", () => loads++);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#settings-update-now").click(),
    ]);
    await expect(page.locator("#app-startup")).toBeHidden();
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
    expect(loads).toBe(1);
    expect(await legacyCached()).toBe(false);
  });
});

for (const draft of ["destination", "editor"] as const) {
  test(`settings update directly with an open ${draft} draft`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: draft === "destination" ? 390 : 1280,
      height: 900,
    });
    await withUpdateServer(page, async (release) => {
      if (draft === "destination") {
        await page.locator("#destination").fill("Ungespeicherter Entwurf");
        if (await page.locator(".search-focus-back").isVisible())
          await page.locator(".search-focus-back").click();
      } else {
        await page.locator("#search-adjust").click();
        await expect(page.locator("#origin")).toBeVisible();
      }
      await page.locator("#tab-settings").click();
      release.revision = 2;
      await page.locator("#check-updates").click();
      await expect(page.locator("#update-availability")).toBeVisible();
      await expect(page.locator("#update-description")).toHaveText(
        "Zum Aktualisieren wird die App neu geladen.",
      );
      await expect(page.locator("#settings-update-now")).toBeVisible();
      await expect(page.locator("#update-banner")).toBeHidden();
      if (draft === "destination")
        await expect(page.locator("#destination")).toHaveValue(
          "Ungespeicherter Entwurf",
        );
      let loads = 0;
      page.on("load", () => loads++);
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("#settings-update-now").click(),
      ]);
      await expect(page.locator("#app-startup")).toBeHidden();
      await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
      expect(loads).toBe(1);
    });
  });
}

test("manual search distinguishes current, failed, offline and downloading updates", async ({
  page,
  context,
}) => {
  await withUpdateServer(page, async (release) => {
    await page.locator("#tab-settings").click();
    const card = page.locator("#app-updates");
    const check = page.locator("#check-updates");
    const status = page.locator("#update-status");
    await expect(card).toHaveCount(1);
    await expect(
      card.getByRole("heading", { name: "App-Updates", level: 2 }),
    ).toBeVisible();
    await expect(card).not.toHaveAttribute("data-update-available");
    const initialCard = await card.boundingBox();
    const firstSettings = await page
      .locator("#settings-form .group")
      .first()
      .boundingBox();
    expect(initialCard!.y + initialCard!.height).toBeLessThanOrEqual(
      firstSettings!.y,
    );
    await check.focus();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText("Du bist auf dem neuesten Stand.");
    release.failCheck = true;
    await check.click();
    await expect(status).toContainText("konnten nicht geprüft werden");
    await expect(check).toBeEnabled();
    await context.setOffline(true);
    await expect(status).toContainText("Offline");
    await expect(check).toBeDisabled();
    release.failCheck = false;
    await context.setOffline(false);
    await expect(status).toHaveText("Du bist auf dem neuesten Stand.");
    release.revision = 2;
    release.installDelay = 1500;
    const checksBefore = release.checks;
    await check.click();
    await expect(status).toHaveText("Update wird heruntergeladen …");
    await expect(page.locator("#settings-update-now")).toBeHidden();
    await page.locator("#foldingDuration").focus();
    await expect(status).toContainText("Neue Version verfügbar.");
    await expect(page.locator("#foldingDuration")).toBeFocused();
    await expect(card).toHaveAttribute("data-update-available");
    await expect(page.locator("#update-availability")).toBeVisible();
    await expect(check).toBeHidden();
    await expect(card.locator("button:visible")).toHaveCount(1);
    expect((await card.boundingBox())!.y).toBe(initialCard!.y);
    expect(release.checks - checksBefore).toBe(1);
    await expect(page.locator("#settings-update-now")).toBeEnabled();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#foldingDuration").fill("0");
    await expect(page.locator("#foldingDuration")).toHaveValue("0");
    await expect(status).toContainText(
      "Zum Aktualisieren wird die App neu geladen.",
    );
    await expect(page.locator("#settings-update-now")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#settings-update-now").click(),
    ]);
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
  });
});

test("banner hides for editors, dialogs and other tabs, and reloads when clicked", async ({
  page,
}) => {
  await withUpdateServer(page, async (release) => {
    release.revision = 2;
    await discover(page);
    await expect(page.locator("#update-banner")).toBeVisible();
    await page.locator("#search-adjust").click();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#time-trigger").click();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#time-cancel").click();
    await page.locator("#search-adjust").click();
    await expect(page.locator("#update-banner")).toBeVisible();
    await page.locator("#tab-history").click();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#tab-settings").click();
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#tab-route").click();
    await expect(page.locator("#update-banner")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#update-now").click(),
    ]);
    await expect(page.locator("#app-startup")).toBeHidden();
    await expect(page.locator("#update-banner")).toBeHidden();
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
  });
});

test("pending updates do not interrupt planning, route preview or real navigation", async ({
  page,
  context,
}) => {
  await page.clock.setFixedTime(new Date());
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  await page.addInitScript(() => {
    // Native mock positions can use a different clock in WebKit.
    const fresh =
      (success: PositionCallback) => (position: GeolocationPosition) =>
        success({
          coords: position.coords,
          timestamp: Date.now(),
        } as GeolocationPosition);
    const get = navigator.geolocation.getCurrentPosition.bind(
      navigator.geolocation,
    );
    const watch = navigator.geolocation.watchPosition.bind(
      navigator.geolocation,
    );
    navigator.geolocation.getCurrentPosition = (success, error, options) =>
      get(fresh(success), error, options);
    navigator.geolocation.watchPosition = (success, error, options) =>
      watch(fresh(success), error, options);
  });
  await withUpdateServer(page, async (release) => {
    await page.evaluate(
      (settings) =>
        localStorage.setItem("foldroute.routing.v3", JSON.stringify(settings)),
      { ...defaults, maxCyclingMinutes: 60 },
    );
    await page.reload();
    await page.locator("#destination").fill("Ziel");
    await page.locator("#destination-options .place-select").click();
    release.revision = 2;
    await discover(page);
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#tab-settings").click();
    await expect(page.locator("#update-status")).toContainText(
      "Routensuche beendet",
    );
    await expect(page.locator("#settings-update-now")).toBeHidden();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:finish-planning")),
    );
    await page.locator("#tab-route").click();
    await expectPlanningComplete(page);
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#navigation-start").click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-navigation",
      "active",
    );
    await expect(page.locator("#navigation-instruction")).not.toContainText(
      "vorbereitet",
    );
    await discover(page);
    await expect(page.locator("#update-banner")).toBeHidden();
    // A stale click must also fail the guard, even if presentation has not caught up.
    await page
      .locator("#update-now")
      .evaluate((button: HTMLButtonElement) => button.click());
    expect(
      await page.evaluate(
        async () => !!(await navigator.serviceWorker.ready).waiting,
      ),
    ).toBe(true);
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-navigation",
      "active",
    );
    await expect(page.locator("#update-banner")).toBeHidden();
    await page.locator("#tab-settings").click();
    await expect(page.locator("#settings-update-now")).toBeVisible();
  });
});

test("activation timeout allows retry without a late unexpected reload", async ({
  page,
}) => {
  await withUpdateServer(page, async (release) => {
    release.revision = 2;
    await discover(page);
    await page.locator("#tab-settings").click();
    await page.clock.install();
    await page.evaluate(() => {
      const original = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message) {
        if (message.type !== "SKIP_WAITING") original.call(this, message);
      };
      window.addEventListener(
        "test:allow-update",
        () => {
          ServiceWorker.prototype.postMessage = original;
        },
        { once: true },
      );
    });
    await page.locator("#settings-update-now").click();
    await expect(page.locator("#update-status")).toHaveText(
      "App wird aktualisiert …",
    );
    await page.clock.fastForward(16000);
    await expect(page.locator("#update-status")).toContainText(
      "nicht rechtzeitig aktiviert",
    );
    await expect(page.locator("#settings-update-now")).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test:allow-update")),
    );
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#settings-update-now").click(),
    ]);
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
  });
});

test("activation in another window never reloads an existing draft", async ({
  page,
  context,
}) => {
  await withUpdateServer(page, async (release) => {
    const other = await context.newPage();
    try {
      await other.goto(release.url);
      await expect(other.locator("#app-startup")).toBeHidden();
      await other.locator("#destination").fill("Entwurf im anderen Fenster");
      let loads = 0;
      other.on("load", () => loads++);
      release.revision = 2;
      await discover(page);
      await expect(other.locator("#tab-settings")).toHaveAccessibleName(
        "Einstellungen, Update verfügbar",
      );
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("#update-now").click(),
      ]);
      await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
      await expect(other.locator("#destination")).toHaveValue(
        "Entwurf im anderen Fenster",
      );
      expect(loads).toBe(0);
      await other.locator("#destination").fill("");
      await expect(other.locator("#update-banner")).toBeVisible();
      await Promise.all([
        other.waitForEvent("load"),
        other.locator("#update-now").click(),
      ]);
      await expect(other.locator("#tab-settings .update-badge")).toBeHidden();
    } finally {
      await other.close();
    }
  });
});

test("a dialog opened during activation defers reload until another confirmation", async ({
  page,
}) => {
  await withUpdateServer(page, async (release) => {
    release.revision = 2;
    await discover(page);
    await page.evaluate(() => {
      const original = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message) {
        original.call(this, message);
        if (message.type === "SKIP_WAITING")
          document
            .querySelector<HTMLDialogElement>("#time-dialog")!
            .showModal();
      };
    });
    let loads = 0;
    page.on("load", () => loads++);
    await page.locator("#update-now").click();
    await expect(page.locator("#time-dialog")).toBeVisible();
    await expect(page.locator("#update-status")).toContainText(
      "Schließe zuerst",
    );
    expect(loads).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await navigator.serviceWorker.ready).waiting === null,
        ),
      )
      .toBe(true);
    await page.locator("#time-cancel").click();
    await expect(page.locator("#update-now")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#update-now").click(),
    ]);
    await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
    expect(loads).toBe(1);
  });
});

for (const width of [320, 390, 1280]) {
  test(`update controls fit large text at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await withUpdateServer(page, async (release) => {
      await page.locator("#tab-settings").click();
      await expect(page.locator("#app-updates")).toBeInViewport({ ratio: 1 });
      await expect(page.locator("#check-updates")).toBeInViewport({ ratio: 1 });
      await expect(page.locator("#settings-update-now")).toBeHidden();
      await page.locator("#tab-route").click();
      release.revision = 2;
      await discover(page);
      await expect(page.locator("#update-now")).toBeInViewport();
      await expect(page.locator("#update-now")).toBeEnabled();
      await page.screenshot({ path: info.outputPath("update-banner.png") });
      await page.locator("#tab-settings").click();
      await page.screenshot({
        path: info.outputPath("update-settings-top.png"),
      });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.locator("#app-updates").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator("#check-updates")).toBeHidden();
      await expect(page.locator("#settings-update-now")).toBeInViewport();
      await page.locator("#settings-update-now").focus();
      await expect(page.locator("#settings-update-now")).toBeFocused();
      await expect
        .poll(async () => {
          const actionBounds = await page
            .locator("#settings-update-now")
            .boundingBox();
          const headerBounds = await page
            .locator(".settings-heading-row")
            .boundingBox();
          return actionBounds!.y - (headerBounds!.y + headerBounds!.height);
        })
        .toBeGreaterThanOrEqual(7);
      await page
        .locator("#app-updates")
        .screenshot({ path: info.outputPath("update-settings.png") });
      await Promise.all([
        page.waitForEvent("load"),
        page.keyboard.press("Enter"),
      ]);
      await expect(page.locator("#tab-settings .update-badge")).toBeHidden();
    });
  });
}
