import {
  addStop,
  openCachedJourney,
  openSelectedDetails,
  showMap,
  showConnections,
  expectPlanningComplete,
} from "./assertions";
import { test, expect } from "./test";
import { routeURL } from "../../src/route-url";
import {
  setup,
  choose,
  plan,
  cors,
  fixture,
  expectRecoveryButtons,
  locationCenterError,
  setupVia,
  expectRouteFits,
  expectMapSettled,
  expectRouteFitUnchanged,
  runMapClock,
} from "./planner-fixture";

for (const [width, height] of [
  [320, 844],
  [390, 844],
  [425, 812],
  [844, 390],
  [1280, 844],
]) {
  test(`fresh results open the route map without an extra history entry at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await setup(page);
    await plan(page);
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      width < 900 ? "map" : "desktop",
    );
    if (width < 900)
      await expect(page.locator("#map-preview-heading")).toBeFocused();
    await expectRouteFits(page);
    await expectRouteFitUnchanged(page);
    if (width < 900) {
      await expect(page.locator("#map-preview-heading")).toHaveText(
        "Früheste Ankunft",
      );
      await expect(page.locator("#map-preview-summary")).toContainText(
        "32 min",
      );
      await page.locator("#result-back").scrollIntoViewIfNeeded();
      await expect(page.locator("#result-back")).toBeInViewport({
        ratio: 0.99,
      });
      await page.locator("#map-open-details").scrollIntoViewIfNeeded();
      await expect(page.locator("#map-open-details")).toBeInViewport({
        ratio: 1,
      });
      expect(await page.evaluate(() => history.state.resultDepth)).toBe(0);
      await page.screenshot({
        path: info.outputPath("initial-result-map.png"),
      });
      await page.goBack();
      await expect(page.locator("#search-view")).toBeVisible();
      await page.goForward();
      await expect(page.locator("#map-view")).toHaveAttribute(
        "data-result-screen",
        "map",
      );
      await showConnections(page);
      await expect(page.locator("#choices")).toBeVisible();
      await expect(
        page.locator(".route-choice[aria-pressed=true]"),
      ).toBeFocused();
      await page.locator("#map-preview-summary").evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await showMap(page);
      await page.locator("#map-open-details").scrollIntoViewIfNeeded();
      await expect(page.locator("#map-open-details")).toBeInViewport({
        ratio: 1,
      });
    } else {
      await expect(page.locator("#choices")).toBeVisible();
      await expect(page.locator("#panel-details")).toBeVisible();
    }
  });
}

test("arrival search opens the latest suitable departure on the mobile map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const link = routeURL(page.url(), {
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
      timing: "arrive",
      time: Date.parse("2026-09-04T08:50:00Z") / 1000,
    },
  });
  await page.goto(link.href);
  await expectPlanningComplete(page);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#map-preview-heading")).toHaveText(
    "Späteste Abfahrt",
  );
  await expect(page.locator(".route-choice").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("map start exposes distant-origin recovery and its offline state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await choose(page, "destination", "Ziel");
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await page.clock.setFixedTime(new Date("2026-09-04T08:02:00Z"));
  await page.context().setGeolocation({ latitude: 49.132, longitude: 11.5756 });
  await page.locator("#navigation-start").click();
  const notice = page.locator("#map-preview-feedback #navigation-start-notice");
  const search = page.locator("#map-preview-feedback #navigation-search-now");
  await expect(notice).toContainText("über 25 km entfernt");
  await expect(search).toHaveText("Ab hier suchen");
  await expect(search).toBeEnabled();
  await expect(
    page.locator("#map-preview-actions #navigation-start"),
  ).toBeDisabled();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await expectRecoveryButtons(page, "navigation-search-now");
  await page.context().setOffline(true);
  await expect(search).toBeDisabled();
  await expect(notice).toContainText("Internet");
  await page.context().setOffline(false);
  await expect(search).toBeEnabled();
  await expect(notice).not.toContainText("Internet");
});

for (const width of [320, 390, 1280]) {
  test(`live start keeps Los disabled during location checking and retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await plan(page);
    await page.locator("#tab-settings").click();
    await page.clock.setFixedTime(new Date("2026-09-04T08:02:00Z"));
    await page.evaluate(() => {
      (window as any).savedGeo = navigator.geolocation;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition(
            _success: PositionCallback,
            error: PositionErrorCallback,
          ) {
            (window as any).rejectStartLocation = () =>
              error({ code: 1, message: "denied" } as GeolocationPositionError);
            return 1;
          },
          clearWatch() {},
        },
      });
    });
    await page.locator("#save-settings").click();
    const start = page.locator("#navigation-start");
    const ready = (await start.boundingBox())!;
    await start.click();
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(start).toHaveText("Wird geprüft …");
    await expect(start).toHaveAttribute("aria-busy", "true");
    const checking = (await start.boundingBox())!;
    expect(checking.width).toBe(ready.width);
    expect(checking.height).toBe(ready.height);
    await expect(page.locator("#navigation-start-notice")).toHaveText(
      "Standort wird geprüft …",
    );
    await page.evaluate(() => (window as any).rejectStartLocation());
    await expect(start).toHaveText("Los");
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(
      /Standortzugriff nicht erlaubt/,
    );
    await expect(page.locator("#route-start-summary")).toBeHidden();
    await expect(page.locator("#navigation-start-retry")).toBeVisible();
    await expect(page.locator("#navigation-start-retry")).toHaveCSS(
      "background-color",
      "rgb(255, 212, 59)",
    );
    await expectRecoveryButtons(page, "navigation-start-retry");
    await expect(page.locator("#navigation-view")).toBeHidden();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.locator("#navigation-start-retry").scrollIntoViewIfNeeded();
    await expectRecoveryButtons(page, "navigation-start-retry");
    await page.screenshot({
      path: test.info().outputPath("retry-start-large-text.png"),
    });
    await page.evaluate(() =>
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: (window as any).savedGeo,
      }),
    );
    await page.locator("#navigation-start-retry").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
  });
}

for (const [width, height] of [
  [320, 986],
  [390, 986],
  [844, 500],
  [1479, 986],
])
  test(`location stays centered in visible map ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await setup(page);
    await plan(page);
    await runMapClock(page);
    await page.evaluate(() => {
      document.documentElement.dataset.locationCalls = "0";
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition: navigator.geolocation.watchPosition.bind(
            navigator.geolocation,
          ),
          clearWatch: navigator.geolocation.clearWatch.bind(
            navigator.geolocation,
          ),
          getCurrentPosition: (success: (value: unknown) => void) => {
            const root = document.documentElement;
            root.dataset.locationCalls = String(
              Number(root.dataset.locationCalls) + 1,
            );
            success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    });
    if (await page.locator("#map-location").evaluate((e) => e.inert))
      await page.locator("#panel-map-toggle").click();
    await page.locator("#map-location").click({ position: { x: 24, y: 4 } });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    if (width < 900) {
      await page.locator("#result-back").click();
      await showMap(page);
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    // A very short landscape viewport can leave no usable map at all.
    // Keep the focus for when the map becomes visible again.
    await page.setViewportSize({ width: 844, height: 390 });
    await expectMapSettled(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await showMap(page);
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    await expect(page.locator("html")).toHaveAttribute(
      "data-location-calls",
      "0",
    );
  });

test("manual map gestures release location focus; button restores it and route selection retains it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 986 });
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await runMapClock(page);
  await expect(page.locator(".route-choice")).toHaveCount(2);
  await showMap(page);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  const map = await page.locator("#map").boundingBox();
  await page.mouse.move(map!.x + 100, map!.y + 150);
  await page.mouse.down();
  await page.mouse.move(map!.x + 180, map!.y + 180, { steps: 12 });
  await page.mouse.up();
  // Content-sized panels change route fitting after gestures. A retained
  // location focus would center within 2px, regardless of the panel height.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await expectMapSettled(page);
  // Route fitting may move the marker again during the panel transition;
  // only continued location centering (within 2px) would be a regression.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".leaflet-control-zoom-in").click();
  await expectMapSettled(page);
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator("#result-back").click();
  await page.locator(".route-choice").last().click();
  await showMap(page);
  // Switching alternatives retains the explicitly requested location view.
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
});

test("location denial keeps destination and allows a manual start", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // Keep watchPosition available to the shared timestamp-normalizing fixture.
    navigator.geolocation.getCurrentPosition = (_success, fail) =>
      fail?.({
        code: 1,
        message: "Permission denied",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#destination")).toHaveValue("Ziel");
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#route-origin")).toHaveText("Start");
  expect(errors).toEqual([]);
});
test("a draft opened while locating stays now until reopened after time resolution", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    geo.getCurrentPosition = (success) => {
      (window as any).resolvePlanningLocation = () =>
        success({
          coords: { latitude: 48.132, longitude: 11.5756, accuracy: 10 },
          timestamp: Date.now(),
        } as GeolocationPosition);
    };
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#search-preview-title")).toHaveText(
    "Standort wird ermittelt …",
  );
  await expect(page.locator("#search-preview-spinner")).toBeVisible();
  await expect(page.locator("#navigation-start")).toBeHidden();
  await expect(page.locator("#map")).toBeHidden();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  await page.clock.setFixedTime(new Date("2026-09-04T08:07:45Z"));
  await page.evaluate(() => (window as any).resolvePlanningLocation());
  await expectPlanningComplete(page);
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  await page.locator("#cancel-adjust").click();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:07");
});

test("a late location failure does not reset an open edit dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(_success: unknown, fail: (error: unknown) => void) {
          (window as any).failPlanningLocation = () => fail({ code: 2 });
        },
      },
    });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Manueller Entwurf");
  await page.evaluate(() => (window as any).failPlanningLocation());
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#origin")).toHaveValue("Manueller Entwurf");
  await expect(page.locator("#origin")).toBeFocused();
  await expect(page.locator("#destination")).toHaveValue("Ziel");
});

for (const code of [0, 1, 2, 3]) {
  test(`location button requests access immediately: ${code}`, async ({
    page,
  }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (
            success: (p: unknown) => void,
            fail: (e: unknown) => void,
          ) => {
            if (code)
              fail({
                code,
                message:
                  "Origin does not have permission to use Geolocation service",
              });
            else success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    }, code);
    await setup(page, false);
    await page.locator("#search-adjust").click();
    await page.locator("#origin-location").click();
    if (!code) {
      await expect(page.locator("#adjust-status")).toBeEmpty();
      await expect(page.locator("#adjust-status")).toHaveCSS("display", "none");
      await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
      await expect(page.locator("#adjust-location-announcement")).toHaveText(
        "Standort ermittelt",
      );
    } else {
      await expect(page.locator("#adjust-status")).toContainText(
        [
          "",
          "Standortzugriff nicht erlaubt",
          "Standort nicht verfügbar",
          "Standortabfrage dauert zu lange",
        ][code],
      );
      await expect(page.locator("#adjust-location-announcement")).toBeEmpty();
      await expect(page.locator("#adjust-status")).not.toContainText(
        "Diagnose:",
      );
      await expect(page.locator("#adjust-status")).not.toContainText(
        "Geolocation service",
      );
    }
    if (code) await expect(page.locator("#adjust-location-help")).toBeVisible();
    else await expect(page.locator("#adjust-location-help")).toBeHidden();
    await expect(page.locator("#origin-location")).toBeEnabled();
    await expect(page.locator("#route-editor")).toBeVisible();
  });
}

test("location success stays quiet after retry and cancelled replies cannot announce success", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(
          success: (position: unknown) => void,
          fail: (error: unknown) => void,
        ) {
          if (++calls === 1) {
            fail({ code: 1 });
            return;
          }
          window.addEventListener(
            "resolve-location",
            () =>
              success({
                coords: { latitude: 48.132, longitude: 11.5756 },
              }),
            { once: true },
          );
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  const button = page.locator("#origin-location");
  const announcement = page.locator("#adjust-location-announcement");
  await button.click();
  await expect(page.locator("#adjust-location-help")).toBeVisible();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator("#adjust-status")).toContainText(
    "Standort wird ermittelt",
  );
  await expect(page.locator("#adjust-location-help")).toBeHidden();
  await expect(announcement).toBeEmpty();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await expect(button).toBeEnabled();
  await expect(page.locator("#adjust-status")).toBeEmpty();
  await expect(announcement).toHaveText("Standort ermittelt");
  await choose(page, "origin", "Start");
  await expect(announcement).toBeEmpty();
  await button.click();
  await choose(page, "origin", "Start");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(announcement).toBeEmpty();
  await button.click();
  await page.locator("#search-adjust").click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("resolve-location")),
  );
  await page.locator("#search-adjust").click();
  await expect(announcement).toBeEmpty();
  await expect(page.locator("#adjust-status")).toBeEmpty();
  await expect(button).toBeEnabled();
});

test("cancelled location request does not overwrite manual start feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) => {
          window.addEventListener("fail-location", () => fail({ code: 1 }), {
            once: true,
          });
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeDisabled();
  await choose(page, "origin", "Start");
  await page.evaluate(() => window.dispatchEvent(new Event("fail-location")));
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#adjust-status")).toHaveText("");
  await expect(page.locator("#origin-location")).toBeEnabled();
});

test("map location help persists and clears on retry; manual origin clears dialog help", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-04T08:00:00Z") });
  await setup(page);
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({ state: "prompt", onchange: null }),
      },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback, fail: PositionErrorCallback) {
          const id = ++calls;
          queueMicrotask(() => {
            if (id === 2)
              success({
                coords: { latitude: 48.132, longitude: 11.5756, accuracy: 10 },
                timestamp: Date.now(),
              } as GeolocationPosition);
            else
              fail({
                code: 1,
                message: "User denied Geolocation",
              } as GeolocationPositionError);
          });
          return id;
        },
        clearWatch() {},
        getCurrentPosition(
          _success: PositionCallback,
          fail: PositionErrorCallback,
        ) {
          fail({
            code: 1,
            message: "User denied Geolocation",
          } as GeolocationPositionError);
        },
      },
    });
  });
  await page.locator("#tab-route").click();
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeVisible();
  await expect(page.locator("#map-location-error a")).toHaveAttribute(
    "href",
    "hilfe.html#standort",
  );
  await page.clock.fastForward(6200);
  await expect(page.locator("#map-location-error")).toBeVisible();
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeHidden();
  await page.locator("#adjust-route").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#adjust-location-help")).toBeVisible();
  await choose(page, "origin", "Start");
  await expect(page.locator("#adjust-location-help")).toBeHidden();
  await page.locator("#calculate").click();
  await expect(page.locator("#route-editor")).toBeHidden();
  await expectPlanningComplete(page);
});

test("planning URL reloads fixed endpoints without location access and keeps now dynamic", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = page.url();
  const params = new URL(link).searchParams;
  expect(params.get("from")).toBe("48.132000,11.575600");
  expect(params.get("fromName")).toBe("Startpunkt");
  expect(params.has("time")).toBe(false);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition() {
          throw new Error("Shared link must not locate");
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expectPlanningComplete(page);
  await expect(page.locator("#route-origin")).toHaveText("Startpunkt");
  await page.clock.setFixedTime(new Date("2026-09-04T08:05:00Z"));
  await page.locator("#adjust-route").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:00");
  await page.locator("#time-trigger").click();
  await page.locator("#time-now").click();
  await page.locator("#time-apply").click();
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 10:05");
  await page.locator("#cancel-adjust").click();
  expect(page.url()).toBe(link);
  const direct = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  expect(new URL((await direct).url()).searchParams.get("time")).toBe(
    "2026-09-04T08:05:00Z",
  );
  await expectPlanningComplete(page);
  expect(page.url()).toBe(link);
  expect(errors).toEqual([]);
});

test("abandoned location lookup cannot publish placeholder coordinates or rewrite the URL", async ({
  page,
}) => {
  await setup(page, false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success: (result: unknown) => void) {
          (window as unknown as { finishLocation: () => void }).finishLocation =
            () => success({ coords: { latitude: 48.132, longitude: 11.5756 } });
        },
      },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  expect(new URL(page.url()).searchParams.has("from")).toBe(false);
  await page.locator("#close-route").click();
  await page.evaluate(() =>
    (window as unknown as { finishLocation: () => void }).finishLocation(),
  );
  await expect(page.locator("#search-view")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
});

test("request preview stays hidden across breakpoints until location resolves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await setup(page, false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success: PositionCallback) {
          (window as any).finishLocation = () =>
            success({
              coords: { latitude: 48.132, longitude: 11.5756, accuracy: 10 },
              timestamp: Date.now(),
            } as GeolocationPosition);
        },
      },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#search-preview-title")).toHaveText(
    "Standort wird ermittelt …",
  );
  for (const width of [899, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      width < 900 ? "map" : "desktop",
    );
    await expect(page.locator("#map")).toBeHidden();
    expect(
      await page.locator("#map").evaluate((element) => element.inert),
    ).toBe(true);
    await expect(page.locator("#search-preview-title")).toBeVisible();
  }
  await page.evaluate(() => (window as any).finishLocation());
  await expectPlanningComplete(page);
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#map .route-marker")).toHaveCount(2);
});

test("browser navigation restores itinerary, list and map without another search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await openSelectedDetails(page);
  await page.locator("#result-back").click();
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/v6/plan")) requests++;
  });
  const selected = page.locator('.route-choice[aria-pressed="true"]');
  const id = await selected.getAttribute("data-journey");
  const historyLength = await page.evaluate(() => history.length);
  await selected.click();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await openSelectedDetails(page);
  await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 80));
  const scroll = await page
    .locator("#panel-content")
    .evaluate((e) => e.scrollTop);
  await showMap(page);
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
  await expect(page.locator("#panel-content")).toHaveJSProperty(
    "scrollTop",
    scroll,
  );
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await expect(selected).toHaveAttribute("data-journey", id!);
  await expect(
    page.locator(".route-choice-row.selected .route-detail-link"),
  ).toBeFocused();
  await page.goForward();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#map-preview")).toBeVisible();
  expect(requests).toBe(0);
});

test("route markers identify endpoints and ordered stops with accessible popups", async ({
  page,
  context,
}) => {
  await setupVia(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  for (const [i, name] of ["Café", "See", "Park"].entries()) {
    await addStop(page);
    await choose(page, `via-${i}`, name);
  }
  await page.locator("#search-adjust").click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await showMap(page);
  await expect(page.locator("#map .route-marker")).toHaveCount(5);
  await expect(page.locator(".route-marker-stop")).toHaveText(["1", "2", "3"]);
  await expect(page.locator("#map .leaflet-tooltip")).toHaveCount(0);
  const marker = page.getByRole("button", {
    name: "Zwischenstopp 1: Café",
    exact: true,
  });
  const size = await marker.boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);
  await marker.click();
  await expect(page.locator(".route-marker-info")).toHaveText(
    "Zwischenstopp 1: Café",
  );
  await expect(page.locator("#panel-handle")).toHaveCount(0);
  await page.locator(".leaflet-popup-close-button").click();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".route-marker-info")).toHaveText(
    "Zwischenstopp 1: Café",
  );
  await page.locator(".leaflet-popup-close-button").click();
  await marker.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".route-marker-info")).toBeVisible();
  await page.locator(".leaflet-popup-close-button").click();

  await page.locator("#adjust-route").click();
  await page
    .getByRole("button", { name: "Zwischenziel 3 nach oben", exact: true })
    .click();
  await page.locator("#swap").click();
  await page.locator("#calculate").click();
  await expectPlanningComplete(page);
  await showMap(page);
  await expect(
    page.getByRole("button", { name: "Start: Ziel", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "Ziel: Start", exact: true }),
  ).toBeAttached();
  for (const [i, name] of ["See", "Park", "Café"].entries())
    await expect(
      page.getByRole("button", {
        name: `Zwischenstopp ${i + 1}: ${name}`,
        exact: true,
      }),
    ).toBeAttached();
  await expectPlanningComplete(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toHaveCount(2);
  await context.setOffline(true);
  await openCachedJourney(page, page.locator(".history-open").first());
  await showMap(page);
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await expect(page.locator("#map .route-marker")).toHaveCount(5);
  await expect(page.locator(".route-marker-stop")).toHaveText(["1", "2", "3"]);
  await page.screenshot({
    path: `test-results/route-markers-${test.info().project.name}.png`,
  });
});

for (const [width, height] of [
  [320, 844],
  [844, 390],
  [1479, 986],
]) {
  test(`route fit restores the route and preserves panel state at ${width}x${height}`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height });
    // A fixed origin avoids unrelated, asynchronous history address lookups
    // while this test asserts that map fitting makes no API requests.
    await page.locator("#search-adjust").click();
    await choose(page, "origin", "Start");
    await page.locator("#search-adjust").click();
    await plan(page);
    await runMapClock(page);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = () => {
        throw new Error("Route fit must not request GPS");
      };
    });
    await showMap(page);
    await expectRouteFits(page);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator("#map").focus();
      await page.keyboard.press("+");
      await page.keyboard.press("ArrowLeft");
      await page.locator("#panel-content").evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
      const scroll = await page
        .locator("#panel-content")
        .evaluate((e) => e.scrollTop);
      await page
        .getByRole("button", { name: /^(Gesamte Route|Alle Routen) anzeigen$/ })
        .click();
      await expectRouteFits(page);
      await expect(page.locator("#map")).toHaveJSProperty("inert", false);
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
      const location = (await page.locator("#map-location").boundingBox())!;
      const route = (await page.locator("#map-route").boundingBox())!;
      expect(route.x).toBe(location.x);
      expect(route.y - location.y - location.height).toBe(8);
      expect([
        route.width,
        route.height,
        location.width,
        location.height,
      ]).toEqual([48, 48, 48, 48]);
      const hadTouchClass = await page
        .locator("#map")
        .evaluate((map) => map.classList.contains("leaflet-touch"));
      for (const touch of [false, true]) {
        await page.locator("#map").evaluate((map, enabled) => {
          map.classList.toggle("leaflet-touch", enabled);
        }, touch);
        const zoom = (await page
          .locator(".leaflet-control-zoom")
          .boundingBox())!;
        expect(zoom.x + zoom.width / 2).toBeCloseTo(
          route.x + route.width / 2,
          1,
        );
        expect(zoom.y).toBeGreaterThanOrEqual(route.y + route.height);
      }
      await page.locator("#map").evaluate((map, enabled) => {
        map.classList.toggle("leaflet-touch", enabled);
      }, hadTouchClass);
      if (width < 900) {
        const panel = (await page.locator("#journey-panel").boundingBox())!;
        const sidebar = await page
          .locator("#map-view")
          .evaluate(
            (map) =>
              getComputedStyle(map)
                .getPropertyValue("--map-panel-layout")
                .trim() === "side",
          );
        if (sidebar)
          expect(route.x).toBeGreaterThanOrEqual(panel.x + panel.width);
        else expect(route.y + route.height).toBeLessThanOrEqual(panel.y);
      }
      await expect(page.locator("#map-route")).toBeInViewport({ ratio: 1 });
    }
    // Leaflet finishes its keyboard zoom on an animation frame after input.
    await expectMapSettled(page);
    await expectRouteFits(page);
    expect(requests).toEqual([]);
    await page.screenshot({
      path: `test-results/route-fit-${width}-${test.info().project.name}.png`,
    });
    await page.locator("#close-route").click();
    await expect(page.locator("#map-route")).toBeHidden();
  });
}

test("route fit overrides a pending location response and works offline with stops", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    let next = 0;
    navigator.geolocation.watchPosition = (success) => {
      (window as any).finishMapLocation = () =>
        success({
          coords: { latitude: 52.52, longitude: 13.405, accuracy: 10 },
          timestamp: Date.now(),
        } as GeolocationPosition);
      return ++next;
    };
    navigator.geolocation.clearWatch = () => {};
  });
  await setupVia(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search-adjust").click();
  await choose(page, "origin", "Start");
  await addStop(page);
  await choose(page, "via-0", "Café");
  await page.locator("#search-adjust").click();
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await showMap(page);
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location")).toBeDisabled();
  await page.locator("#map-route").click();
  await expect(page.locator("#map-location")).toBeEnabled();
  await expectRouteFits(page);
  await page.evaluate(() => (window as any).finishMapLocation());
  await expectRouteFits(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-open")).toHaveCount(1);
  await context.setOffline(true);
  await openCachedJourney(page, page.locator(".history-open"));
  await showMap(page);
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await page.locator("#map-route").focus();
  await page.keyboard.press("Enter");
  await expectRouteFits(page);
  await expect(page.locator(".route-marker-stop")).toHaveText("1");
});

for (const width of [320, 390]) {
  for (const fromDetail of [false, true]) {
    test(`map actions separate comparison and details at ${width}, fromDetail=${fromDetail}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 650 });
      await setup(page);
      await plan(page);
      await showConnections(page);
      const selected = page.locator(".route-choice").last();
      await selected.click();
      const id = await selected.getAttribute("data-journey");
      const scrollPosition = () =>
        page.evaluate(() => {
          const panel = document.getElementById("journey-panel")!;
          return (
            panel.classList.contains("result-scroll-all")
              ? panel
              : document.getElementById("panel-content")!
          ).scrollTop;
        });
      const position = await scrollPosition();
      let requests = 0;
      page.on("request", (request) => {
        if (request.url().includes("/api/v6/plan?")) requests++;
      });
      if (fromDetail) await openSelectedDetails(page);
      await showMap(page);
      await expect(page.locator("#result-back")).toHaveText("Alternativen");
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect(selected).toBeFocused();
      await expect.poll(scrollPosition).toBe(position);
      await page.goBack();
      await expect(page.locator("#map-view")).toHaveAttribute(
        "data-result-screen",
        "map",
      );
      await page.goForward();
      await expect(page.locator("#choices")).toBeVisible();
      await expect(selected).toHaveAttribute("data-journey", id!);
      await showMap(page);
      await page.locator("#map-open-details").click();
      await expect(page.locator("#panel-details")).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      expect(requests).toBe(0);
    });
  }
}

test("map itinerary action returns directly to comparison after reading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await plan(page);
  await openSelectedDetails(page);
  await showMap(page);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
  await showMap(page);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
});
