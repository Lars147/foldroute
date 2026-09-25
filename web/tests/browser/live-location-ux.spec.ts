import { test, expect, type Page } from "@playwright/test";
import { defaults } from "../../src/model";
import { routeURL } from "../../src/route-url";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
import { expectPlanningComplete } from "./assertions";

async function setup(page: Page, permission = "granted") {
  await page.clock.install({ time: new Date("2026-09-04T08:00:00Z") });
  await page.addInitScript((state) => {
    let next = 0;
    const watches = new Map<number, PositionCallback>();
    const errors = new Map<number, PositionErrorCallback>();
    const status = { state, onchange: null as (() => void) | null };
    const probe = {
      started: 0,
      stopped: 0,
      permission(value: string) {
        status.state = value;
        status.onchange?.();
      },
      push(latitude: number, accuracy: number, age = 0) {
        for (const callback of watches.values())
          callback({
            coords: { latitude, longitude: 11.5756, accuracy },
            timestamp: Date.now() - age,
          } as GeolocationPosition);
      },
      fail() {
        for (const callback of errors.values())
          callback({ code: 2 } as GeolocationPositionError);
      },
      hide(hidden: boolean) {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => hidden,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };
    (window as any).liveProbe = probe;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => status },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback, error: PositionErrorCallback) {
          probe.started++;
          watches.set(++next, success);
          errors.set(next, error);
          return next;
        },
        clearWatch(id: number) {
          probe.stopped++;
          watches.delete(id);
          errors.delete(id);
        },
        getCurrentPosition() {
          throw new Error("This fixed-origin plan must not query its origin");
        },
      },
    });
  }, permission);
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  const link = routeURL("https://example.test/", {
    request: {
      origin: {
        name: "Start",
        detail: "",
        latitude: 48.132,
        longitude: 11.5756,
      },
      destination: {
        name: "Ziel",
        detail: "",
        latitude: 48.175,
        longitude: 11.6,
      },
      timing: "now",
      time: Date.parse("2026-09-04T08:00:00Z") / 1000,
    },
    settings: { ...defaults, maxCyclingMinutes: 60, maxBikeTransfers: 0 },
  });
  await page.goto("/" + link.search);
  await expectPlanningComplete(page);
}
const push = (page: Page, latitude: number, accuracy: number, age = 0) =>
  page.evaluate(
    (args) => (window as any).liveProbe.push(...args),
    [latitude, accuracy, age],
  );
const marker = (page: Page) => page.locator(".live-location-marker");

for (const width of [390, 1280]) {
  test(`live point and accuracy change without moving route or camera at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 986 });
    await setup(page);
    const url = page.url();
    await push(page, 48.132, 10);
    await expect(marker(page)).toHaveAttribute("data-quality", "current");
    const start = await page.locator(".route-marker-start").boundingBox();
    const dot = await marker(page).boundingBox();
    const ring = await page.locator(".live-location-accuracy").boundingBox();
    let requests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/")) requests++;
    });
    await push(page, 48.14, 200);
    await expect(marker(page)).toHaveAttribute("data-quality", "inaccurate");
    expect(await marker(page).boundingBox()).not.toEqual(dot);
    expect(await page.locator(".route-marker-start").boundingBox()).toEqual(
      start,
    );
    expect(
      (await page.locator(".live-location-accuracy").boundingBox())!.width,
    ).toBeGreaterThan(ring!.width);
    expect(page.url()).toBe(url);
    expect(requests).toBe(0);
    await page.locator("#map-location").click();
    const centered = await page.locator(".route-marker-start").boundingBox();
    await push(page, 48.145, 20);
    expect(await page.locator(".route-marker-start").boundingBox()).toEqual(
      centered,
    );
    await page.screenshot({
      path: test.info().outputPath("live-location.png"),
    });
  });
}

test("location pauses for hidden page, settings and editing, and resumes once", async ({
  page,
}) => {
  await setup(page);
  await push(page, 48.132, 10);
  await expect
    .poll(() => page.evaluate(() => (window as any).liveProbe.started))
    .toBe(1);
  await page.evaluate(() => (window as any).liveProbe.hide(true));
  expect(await page.evaluate(() => (window as any).liveProbe.stopped)).toBe(1);
  await page.evaluate(() => (window as any).liveProbe.hide(false));
  await expect
    .poll(() => page.evaluate(() => (window as any).liveProbe.started))
    .toBe(2);
  await page.locator("#tab-settings").click();
  expect(await page.evaluate(() => (window as any).liveProbe.stopped)).toBe(2);
  await page.locator("#tab-route").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).liveProbe.started))
    .toBe(3);
  await page.locator("#adjust-route").click();
  expect(await page.evaluate(() => (window as any).liveProbe.stopped)).toBe(3);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as any).liveProbe.started))
    .toBe(4);
});

test("unknown permission does not prompt; explicit centering enables tracking", async ({
  page,
}) => {
  await setup(page, "prompt");
  expect(await page.evaluate(() => (window as any).liveProbe.started)).toBe(0);
  await expect(marker(page)).toHaveCount(0);
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location")).toBeDisabled();
  await push(page, 48.132, 10);
  await expect(marker(page)).toHaveCount(1);
  await expect(page.locator("#map-location")).toBeEnabled();
  await page.evaluate(() => (window as any).liveProbe.permission("denied"));
  await expect(marker(page)).toHaveCount(0);
});

test("old fixes turn grey and recover; route overview beats pending centering", async ({
  page,
}) => {
  await setup(page);
  await push(page, 48.132, 10);
  await page.clock.fastForward(65000);
  await expect(marker(page)).toHaveAttribute("data-quality", "stale");
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location")).toBeDisabled();
  await page.locator("#map-route").click();
  const original = await page.locator(".route-marker-start").boundingBox();
  await push(page, 48.16, 10);
  await expect(marker(page)).toHaveAttribute("data-quality", "current");
  expect(await page.locator(".route-marker-start").boundingBox()).toEqual(
    original,
  );
  await page.context().setOffline(true);
  await push(page, 48.17, 200);
  await expect(marker(page)).toHaveAttribute("data-quality", "inaccurate");
});

async function wakeProbe(page: Page, reject = false) {
  await page.addInitScript((reject) => {
    const probe = { requested: 0, released: 0 };
    (window as any).wakeProbe = probe;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          probe.requested++;
          if (reject) throw new DOMException("Low power", "NotAllowedError");
          const lock = new EventTarget();
          return Object.assign(lock, {
            release: async () => {
              probe.released++;
              lock.dispatchEvent(new Event("release"));
            },
          });
        },
      },
    });
  }, reject);
}
const wakeCounts = (page: Page) =>
  page.evaluate(() => (window as any).wakeProbe);

test("screen stays awake only on visible route and preference persists", async ({
  page,
}) => {
  await wakeProbe(page);
  await setup(page);
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 1, released: 0 });
  await page.evaluate(() => (window as any).liveProbe.hide(true));
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 1, released: 1 });
  await page.evaluate(() => (window as any).liveProbe.hide(false));
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 2, released: 1 });
  await page.locator("#adjust-route").click();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 2, released: 2 });
  await page
    .locator("#adjust-dialog")
    .evaluate((dialog: HTMLDialogElement) => dialog.close());
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 3, released: 2 });
  await page.locator("#tab-settings").click();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 3, released: 3 });
  const toggle = page.locator("#keep-screen-awake");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.locator("#tab-route").click();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 3, released: 3 });
  await page.reload();
  await expectPlanningComplete(page);
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 0, released: 0 });
  await page.locator("#tab-settings").click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.locator("#tab-route").click();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 1, released: 0 });
  await page.locator("#close-route").click();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 1, released: 1 });
});

test("screen lock denial does not interrupt planning", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await wakeProbe(page, true);
  await setup(page);
  await expect(page.locator(".route-choice").first()).toBeVisible();
  await expect
    .poll(() => wakeCounts(page))
    .toEqual({ requested: 1, released: 0 });
  expect(errors).toEqual([]);
});
