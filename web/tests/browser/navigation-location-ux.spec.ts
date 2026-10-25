import { test, expect } from "./test";
import {
  now,
  setup,
  complete,
  stationJourney,
  openNavigationCredit,
  savedActive,
} from "./navigation-fixture";

for (const width of [390, 1280])
  test(`stationary navigation keeps its location fresh through single lookups at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.evaluate(() => {
      (window as any).navProbe.refreshSilent = false;
    });
    const instruction = await page
      .locator("#navigation-instruction")
      .innerText();
    const watches = await page.evaluate(() => (window as any).navProbe.started);
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(35000);
      await expect(page.locator("#navigation-gps-status")).toBeHidden();
      await expect(page.locator("#navigation-location-status")).toBeEmpty();
      await expect(page.locator("#navigation-map")).toHaveAttribute(
        "data-position-source",
        "gps",
      );
    }
    expect(
      await page.evaluate(() => (window as any).navProbe.refreshLookups),
    ).toBeGreaterThanOrEqual(4);
    expect(await page.evaluate(() => (window as any).navProbe.started)).toBe(
      watches,
    );
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
    expect(
      await page.evaluate(() => (window as any).navProbe.lastRefreshOptions),
    ).toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
  });

test("frequent inaccurate GPS samples do not suppress automatic navigation recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const before = await page.evaluate(
    () => (window as any).navProbe.refreshLookups,
  );
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => (window as any).navProbe.push(48, 11, 90, 500));
    await page.clock.fastForward(10000);
  }
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "GPS ungenau",
  );
  expect(
    await page.evaluate(() => (window as any).navProbe.refreshLookups),
  ).toBeGreaterThanOrEqual(before + 4);
  await expect(page.locator("#navigation-locate")).toBeHidden();
});

test("silent single lookups retain the stale warning and recover on a fresh measurement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await page.evaluate(() => {
    (window as any).navProbe.cachedAt = Date.now();
    (window as any).navProbe.refreshSilent = false;
  });
  await page.clock.runFor(70000);
  await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Letzter Standort nicht aktuell. Automatischer Fortschritt pausiert.",
  );
  await expect(page.locator("#navigation-locate")).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Standort wird automatisch erneut angefragt.",
  );
  expect(
    await page.evaluate(() => (window as any).navProbe.refreshLookups),
  ).toBe(2);
  await page.evaluate(() => {
    (window as any).navProbe.cachedAt = undefined;
  });
  await page.clock.runFor(30000);
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toBeEmpty();
});

test("automatic navigation lookups pause in the background and resume after a fresh foreground fix", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => {
    (window as any).navProbe.refreshSilent = false;
  });
  await page.clock.runFor(35000);
  const lookups = await page.evaluate(
    () => (window as any).navProbe.refreshLookups,
  );
  await page.evaluate(() => (window as any).navProbe.hide(true));
  await page.clock.runFor(70000);
  expect(
    await page.evaluate(() => (window as any).navProbe.refreshLookups),
  ).toBe(lookups);
  await page.evaluate(() => (window as any).navProbe.hide(false));
  await page.clock.runFor(35000);
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).navProbe.refreshLookups),
  ).toBeGreaterThan(lookups);
});

test("GPS loss freezes the display without a usable timeline", async ({
  page,
}) => {
  const journey = stationJourney();
  const train = journey.legs[2];
  delete train.transitReference;
  train.transitStops![1].arrival = now - 60;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  // A bad intermediate timestamp makes this interval unclear. Later consistent
  // anchors can resume the timetable without waiting for GPS or new trip data.
  await page.clock.pauseAt(new Date((now + 350) * 1000));
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(page.locator("#navigation-station-status")).toContainText(
    "Stationsstand unklar",
  );
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "Kein GPS Kartenposition geschätzt",
  );
  await page.clock.runFor(2100);
  const held = await map.getAttribute("data-position");
  await page.clock.fastForward(40000);
  await expect(map).toHaveAttribute("data-position", held!);
  await expect(page.locator("#navigation-station-status")).toContainText(
    "Stationsstand unklar",
  );
  await page.clock.fastForward(110000);
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Nächster Halt: Ausstieg",
  );
  await expect(page.locator("#navigation-station-status")).toBeEmpty();
  await page.clock.runFor(2100);
  await expect(map).not.toHaveAttribute("data-position", held!);
});

for (const colorScheme of ["light", "dark"] as const)
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [844, 390],
    [1280, 900],
  ])
    test(`GPS status stays compact and clears on recovery (${width}x${height}, ${colorScheme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await setup(page);
      const status = page.locator("#navigation-gps-status");
      await expect(status).toBeHidden();
      await page.evaluate(() => (window as any).navProbe.push(48, 11, 90, 500));
      await expect(status).toHaveText("GPS ungenau");
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(page.locator("#navigation-alert")).toBeHidden();
      if (width < 900) {
        await expect(page.locator("#navigation-details")).toBeHidden();
        await expect(page.locator("#navigation-locate")).toBeHidden();
      }
      const bounds = await page.evaluate(() => {
        const status = document
          .getElementById("navigation-gps-status")!
          .getBoundingClientRect();
        const header = document
          .getElementById("navigation-top")!
          .getBoundingClientRect();
        const controls = document
          .querySelector(".navigation-map-controls")!
          .getBoundingClientRect();
        const panel = document
          .getElementById("navigation-panel")!
          .getBoundingClientRect();
        return {
          left: status.left,
          center: status.x + status.width / 2,
          gap: status.top - header.bottom,
          height: status.height,
          panelGap: panel.top - status.bottom,
          overlapsControls:
            status.left < controls.right &&
            status.right > controls.left &&
            status.top < controls.bottom &&
            status.bottom > controls.top,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      // Short mobile layouts put GPS beside the horizontal map controls.
      if (width < 900 && height <= 500) expect(bounds.left).toBeCloseTo(12, 0);
      else expect(bounds.center).toBeCloseTo(width / 2, 0);
      expect(bounds.gap).toBeGreaterThanOrEqual(7);
      expect(bounds.height).toBeLessThanOrEqual(34);
      expect(bounds.panelGap).toBeGreaterThan(0);
      expect(bounds.overlapsControls).toBe(false);
      expect(bounds.overflow).toBe(false);
      await page.evaluate(() => {
        (window as any).gpsAnnouncements = 0;
        new MutationObserver((records) => {
          (window as any).gpsAnnouncements += records.length;
        }).observe(document.getElementById("navigation-gps-status")!, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      await page.clock.runFor(7000);
      await expect(status).toBeVisible();
      expect(await page.evaluate(() => (window as any).gpsAnnouncements)).toBe(
        0,
      );
      if (width === 390)
        await page.screenshot({
          path: test.info().outputPath(`gps-status-${colorScheme}.png`),
        });
      await page.evaluate(() => (window as any).navProbe.fail(2));
      await expect(status).toHaveText("Kein GPS");
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      await expect(page.locator("#navigation-location-status")).toContainText(
        "Standort nicht verfügbar",
      );
      await expect(page.locator("#navigation-locate")).toBeHidden();
      await expect(page.locator("#navigation-location-status")).toContainText(
        "Standort wird automatisch erneut angefragt.",
      );
      await page.evaluate(() => (window as any).navProbe.push(48, 11));
      await expect(status).toBeHidden();
      await expect(page.locator("#navigation-location-status")).toBeEmpty();
      await expect(page.locator("#navigation-location")).toBeHidden();
      await expect(page.locator("#navigation-alert")).toBeHidden();
    });

test("manual recovery stays available when automatic fresh lookups are unavailable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
      configurable: true,
      value: undefined,
    });
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
  await page.locator("#navigation-details-toggle").click();
  await page.locator("#navigation-locate").click();
  await expect(page.locator("#navigation-locate")).toBeDisabled();
  await page.clock.runFor(12100);
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Standortabfrage dauert zu lange.",
  );
  await expect(page.locator("#navigation-locate")).toBeEnabled();
  await expect(page.locator("#navigation-alert")).toBeHidden();
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-gps-status")).toBeVisible();
  await expect(page.locator("#navigation-locate")).toBeHidden();
  await page.evaluate(() => (window as any).navProbe.push(48, 11));
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-location-status")).toBeEmpty();
});

test("denied permission explains recovery only in location details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => (window as any).navProbe.fail(1));
  await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
  await expect(page.locator("#navigation-alert")).toBeHidden();
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Standortzugriff nicht erlaubt",
  );
  await expect(
    page
      .locator("#navigation-location-status")
      .getByRole("link", { name: "Hilfe zum Standort" }),
  ).toHaveAttribute("href", "hilfe.html#standort");
  const help = page.locator("#navigation-location-status .location-help");
  await help.focus();
  await page.evaluate(() => (window as any).navProbe.fail(1));
  await expect(help).toBeFocused();
  await page.locator("#navigation-locate").click();
  await page.clock.runFor(10);
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toBeEmpty();
});

for (const [creditIndex, returned] of [
  [1, "focus"],
  [0, "visibility"],
  [1, "pageshow"],
] as const)
  test(`navigation location resumes once after a credit overlay returns through ${returned}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, true);
    const instruction = await page
      .locator("#navigation-instruction")
      .innerText();
    const phase = await page.locator(".navigation-phase.current").innerText();
    const started = await page.evaluate(() => (window as any).navProbe.started);
    let planned = 0;
    await page.route("**/api/v6/plan?*", (route) => {
      planned++;
      return route.fulfill({ json: { direct: [], itineraries: [] } });
    });
    await openNavigationCredit(page, creditIndex);
    if (returned === "pageshow")
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent("pagehide", { persisted: true }),
        ),
      );
    if (returned === "visibility")
      await page.evaluate(() => (window as any).navProbe.hide(true));
    await page.clock.runFor(1000);
    await page.evaluate((event) => {
      if (event === "visibility") (window as any).navProbe.hide(false);
      else if (event === "pageshow")
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      else window.dispatchEvent(new Event("focus"));
    }, returned);
    await expect
      .poll(() => page.evaluate(() => (window as any).navProbe.active))
      .toBe(1);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
      (window as any).navProbe.hide(false);
    });
    await page.clock.runFor(10);
    expect(await page.evaluate(() => (window as any).navProbe.started)).toBe(
      started + 1,
    );
    expect(
      await page.evaluate(
        () => (window as any).navProbe.lastWatchOptions.maximumAge,
      ),
    ).toBe(0);
    await expect(page.locator("#navigation-gps-status")).toBeVisible();
    await page.evaluate(() =>
      (window as any).navProbe.push(48, 11, 90, 10, 1000),
    );
    await expect(page.locator("#navigation-gps-status")).toBeVisible();
    await page.evaluate(() => (window as any).navProbe.push(48, 11));
    await expect(page.locator("#navigation-gps-status")).toBeHidden();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
    await expect(page.locator(".navigation-phase.current")).toHaveText(phase);
    expect(planned).toBe(0);
  });

test("location retry recovers a credit overlay and then restores automatic refreshing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => {
    (window as any).navProbe.cachedAt = Date.now();
  });
  await openNavigationCredit(page);
  await page.clock.runFor(1000);
  await page.locator("#navigation-details-toggle").click();
  const retry = page.locator("#navigation-locate");
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText("Standort wird gesucht …");
  expect(
    await page.evaluate(
      () => (window as any).navProbe.lastQuickOptions.maximumAge,
    ),
  ).toBe(0);
  await expect(page.locator("#navigation-gps-status")).toBeVisible();
  await page.clock.runFor(12100);
  await expect(retry).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "dauert zu lange",
  );
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Standort wird automatisch erneut angefragt.",
  );
  const started = await page.evaluate(() => (window as any).navProbe.started);
  await page.evaluate(() => {
    (window as any).navProbe.cachedAt = undefined;
    (window as any).navProbe.refreshSilent = false;
    (window as any).navProbe.silent = false;
  });
  await page.clock.runFor(30000);
  expect(await page.evaluate(() => (window as any).navProbe.started)).toBe(
    started,
  );
  expect(await page.evaluate(() => (window as any).navProbe.active)).toBe(1);
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toBeEmpty();
  await expect(page.locator("#navigation-location")).toBeHidden();
});

test("overlay return without permission queries waits for an explicit fresh retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => {
          throw new Error("unsupported");
        },
      },
    });
  });
  await openNavigationCredit(page);
  await page.clock.runFor(1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(10);
  expect(await page.evaluate(() => (window as any).navProbe.active)).toBe(0);
  await page.locator("#navigation-details-toggle").click();
  await page.locator("#navigation-locate").click();
  await expect(page.locator("#navigation-locate")).toBeDisabled();
  expect(await page.evaluate(() => (window as any).navProbe.active)).toBe(1);
  await page.evaluate(() => (window as any).navProbe.push(48, 11));
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
});

test("retry after denied location retains the restored section", async ({
  page,
}) => {
  await setup(page, true);
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await page.evaluate(() => {
    (window as any).savedGeo = navigator.geolocation;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(
          _success: PositionCallback,
          error: PositionErrorCallback,
        ) {
          setTimeout(
            () =>
              error({ code: 1, message: "denied" } as GeolocationPositionError),
            0,
          );
          return 1;
        },
        clearWatch() {},
        getCurrentPosition(
          _success: PositionCallback,
          error: PositionErrorCallback,
        ) {
          error({ code: 1, message: "denied" } as GeolocationPositionError);
        },
      },
    });
  });
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-start-retry")).toBeVisible();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: (window as any).savedGeo,
    }),
  );
  await page.locator("#navigation-start-retry").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
});

test("explains a silent location provider and offers retry after the deadline", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition() {
          return 1;
        },
        clearWatch() {},
        getCurrentPosition() {},
      },
    });
  });
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-start-notice")).toHaveText(
    "Standort wird geprüft …",
  );
  await page.clock.runFor(3100);
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "Warte auf einen genauen Standort",
  );
  await page.clock.runFor(9000);
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "Standortabfrage dauert zu lange",
  );
  await expect(page.locator("#navigation-start-retry")).toBeVisible();
  await expect(page.locator("#navigation-view")).toBeHidden();
});

test("interrupted startup can retry location after returning from the background", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.goto("/");
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await page.evaluate(() => {
    (window as any).savedGeo = navigator.geolocation;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition: () => 1,
        clearWatch() {},
        getCurrentPosition() {},
      },
    });
  });
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-start-notice")).toHaveText(
    "Standort wird geprüft …",
  );
  await page.evaluate(() => (window as any).navProbe.hide(true));
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: (window as any).savedGeo,
    });
    (window as any).navProbe.hide(false);
  });
  await page.clock.runFor(10);
  await expect(page.locator("#navigation-start-retry")).toBeVisible();
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "unterbrochen",
  );
  await page.locator("#navigation-start-retry").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
});
