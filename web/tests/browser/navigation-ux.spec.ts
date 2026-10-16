import { openCachedJourney } from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import { defaults, type Journey, type Leg, type Place } from "../../src/model";
import { distance } from "../../src/geometry";
const now = Date.parse("2026-10-06T10:00:00Z") / 1000;
const a: Place = { name: "Start", detail: "", latitude: 48, longitude: 11 };
const b: Place = {
  name: "Kreuzung",
  detail: "",
  latitude: 48,
  longitude: 11.002,
};
const c: Place = {
  name: "Bahnhof",
  detail: "",
  latitude: 48.002,
  longitude: 11.002,
  stopId: "A",
};
const d: Place = {
  name: "Ausstieg",
  detail: "",
  latitude: 48.003,
  longitude: 11.004,
  stopId: "D",
};
const e: Place = {
  name: "Café",
  detail: "",
  latitude: 48.0033,
  longitude: 11.004,
};
const f: Place = {
  name: "Ziel",
  detail: "",
  latitude: 48.004,
  longitude: 11.006,
};
function encoded(points: number[][]) {
  let result = "";
  const previous = [0, 0];
  for (const point of points)
    point.forEach((value, axis) => {
      const rounded = Math.round(value * 1e5);
      const delta = rounded - previous[axis];
      previous[axis] = rounded;
      let bits = delta < 0 ? ~(delta << 1) : delta << 1;
      while (bits >= 32) {
        result += String.fromCharCode((32 | (bits & 31)) + 63);
        bits >>>= 5;
      }
      result += String.fromCharCode(bits + 63);
    });
  return result;
}

for (const mobile of [false, true])
  test(`accepting an expired alternative requests location, refreshes and waits for confirmation (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, true);
    await page.route("**/api/v6/plan?*", async (r) => {
      const params = new URL(r.request().url()).searchParams;
      if (params.get("directModes") !== "BIKE") {
        await r.fulfill({ json: { direct: [], itineraries: [] } });
        return;
      }
      const from = params.get("fromPlace")!.split(",").map(Number);
      const to = params.get("toPlace")!.split(",").map(Number);
      const startTime = params.get("time")!;
      const endTime = new Date(Date.parse(startTime) + 180000).toISOString();
      await r.fulfill({
        json: {
          direct: [
            {
              id: "alternative",
              startTime,
              endTime,
              transfers: 0,
              legs: [
                {
                  mode: "BIKE",
                  startTime,
                  endTime,
                  from: { name: "START", lat: from[0], lon: from[1] },
                  to: { name: "END", lat: to[0], lon: to[1] },
                  distance: distance(
                    { latitude: from[0], longitude: from[1] },
                    { latitude: to[0], longitude: to[1] },
                  ),
                  legGeometry: { points: encoded([from, to]), precision: 5 },
                },
              ],
            },
          ],
          itineraries: [],
        },
      });
    });
    await page.route("**/api/v6/trip?*", (r) =>
      r.fulfill({
        json: {
          legs: [
            {
              from: {
                stopId: "A",
                scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              },
              to: {
                stopId: "D",
                scheduledArrival: new Date((now + 600) * 1000).toISOString(),
              },
              cancelled: true,
            },
          ],
        },
      }),
    );
    await page.clock.runFor(55000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11));
    await page.clock.runFor(5000);
    if (mobile) {
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(page.locator("#navigation-alternative")).toBeHidden();
      await expect(page.locator("#navigation-alert-open")).toContainText(
        "Verbindung ansehen",
      );
      await page.locator("#navigation-alert-open").click();
    }
    await expect(page.locator("#navigation-alternative")).toBeVisible();
    await page.clock.runFor(121000);
    await page.locator("#navigation-accept").click();
    await expect(page.locator("#navigation-status")).toContainText(
      "Standort erneut anfragen",
    );
    await expect(page.locator("#navigation-alternative")).toBeHidden();
    await page.locator("#navigation-locate").click();
    await expect(page.locator("#navigation-alternative")).toBeVisible();
    await expect(page.locator("#navigation-status")).toContainText(
      "Bitte zum Übernehmen bestätigen",
    );
    await expect(page.locator("#navigation-phases")).toContainText("ÖPNV");
    await page.locator("#navigation-accept").click();
    await expect(page.locator("#navigation-status")).toBeEmpty();
    await expect(page.locator("#navigation-alternative")).toBeHidden();
    await expect(page.locator("#navigation-phases")).not.toContainText("ÖPNV");
    if (mobile) await expect(page.locator("#navigation-details")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { NavigationStore } = await import("/src/navigation-store.ts");
          const snapshot = await new NavigationStore().read();
          return snapshot?.journey.legs.some((l: any) => l.kind === "transit");
        }),
      )
      .toBe(false);
  });
function route(multimodal = false): Journey {
  const legs: Leg[] = [
    {
      kind: "bike",
      from: a,
      to: c,
      start: now,
      end: now + 60,
      distance: 370,
      coordinates: [a, b, c],
      maneuvers: [
        {
          direction: "DEPART",
          streetName: "Erste Straße",
          distance: 149,
          coordinates: [a, b],
        },
        {
          direction: "LEFT",
          streetName: "Zweite Straße",
          distance: 222,
          coordinates: [b, c],
        },
      ],
    },
  ];
  if (multimodal)
    legs.push(
      {
        kind: "fold",
        from: c,
        to: c,
        start: now + 60,
        end: now + 180,
        distance: 0,
        coordinates: [c],
      },
      {
        kind: "transit",
        from: c,
        to: d,
        start: now + 300,
        end: now + 600,
        distance: 0,
        coordinates: [c, d],
        line: "S1",
        headsign: "Altstadt",
        platform: "2",
        realtime: true,
        transitReference: {
          tripId: "train-1",
          fromId: "A",
          toId: "D",
          scheduledDeparture: now + 300,
          scheduledArrival: now + 600,
        },
      },
      {
        kind: "unfold",
        from: d,
        to: d,
        start: now + 600,
        end: now + 780,
        distance: 0,
        coordinates: [d],
      },
      {
        kind: "walk",
        from: d,
        to: e,
        start: now + 780,
        end: now + 810,
        distance: 34,
        coordinates: [d, e],
      },
      {
        kind: "stop",
        from: e,
        to: e,
        start: now + 810,
        end: now + 870,
        distance: 0,
        coordinates: [e],
        stop: { id: "coffee", place: e, stayMinutes: 1 },
      },
      {
        kind: "bike",
        from: e,
        to: f,
        start: now + 870,
        end: now + 950,
        distance: 169,
        coordinates: [e, f],
      },
    );
  return {
    id: "navigation-test",
    origin: a,
    destination: multimodal ? f : c,
    departure: now,
    arrival: legs.at(-1)!.end,
    legs,
    isDirect: !multimodal,
    transfers: 0,
  };
}
async function setup(page: Page, multimodal = false) {
  await page.clock.install({ time: new Date(now * 1000) });
  await page.addInitScript(() => {
    const watchers = new Map<number, PositionCallback>();
    let id = 0;
    let coords = {
      latitude: 48,
      longitude: 11,
      accuracy: 10,
      heading: 90,
      speed: 4,
    };
    const probe = {
      started: 0,
      spoken: [] as string[],
      cancelled: 0,
      push(latitude: number, longitude: number, heading = 90, accuracy = 10) {
        coords = { ...coords, latitude, longitude, heading, accuracy };
        for (const success of watchers.values())
          success({ coords, timestamp: Date.now() } as GeolocationPosition);
      },
      hide(hidden: boolean) {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => hidden,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };
    (window as any).navProbe = probe;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted", onchange: null }) },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback) {
          const key = ++id;
          watchers.set(key, success);
          probe.started++;
          setTimeout(
            () =>
              success({ coords, timestamp: Date.now() } as GeolocationPosition),
            0,
          );
          return key;
        },
        clearWatch(key: number) {
          watchers.delete(key);
        },
        getCurrentPosition(success: PositionCallback) {
          success({ coords, timestamp: Date.now() } as GeolocationPosition);
        },
      },
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        constructor(public text: string) {}
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [],
        cancel: () => probe.cancelled++,
        speak: (utterance: { text: string }) =>
          probe.spoken.push(utterance.text),
      },
    });
  });
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({
      json: {
        legs: [
          {
            from: {
              stopId: "A",
              scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              departure: new Date((now + 300) * 1000).toISOString(),
              track: "4",
            },
            to: {
              stopId: "D",
              scheduledArrival: new Date((now + 600) * 1000).toISOString(),
              arrival: new Date((now + 600) * 1000).toISOString(),
            },
            realTime: true,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ journey, settings, time }) => {
      const { OfflineStore } = await import("/src/offline.ts");
      await new OfflineStore().save(
        {
          version: journey.legs.some((l: any) => l.stop) ? 4 : 3,
          savedAt: time,
          journey,
          settings,
          request: {
            origin: journey.origin,
            destination: journey.destination,
            timing: "now",
            time,
            stops: journey.legs.flatMap((l: any) => (l.stop ? [l.stop] : [])),
          },
        },
        "test",
      );
    },
    { journey: route(multimodal), settings: defaults, time: now },
  );
  await page.reload();
  await openCachedJourney(page, page.locator("#open-saved"));
  await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await expect(page.locator("#navigation-storage-status")).toBeEmpty();
}
async function complete(page: Page) {
  if (!(await page.locator("#navigation-complete").isVisible()))
    await page.locator("#navigation-details-toggle").click();
  await page.locator("#navigation-complete").click();
  await page.locator("#navigation-confirm-yes").click();
}
for (const [width, height] of [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
])
  test(`compact mobile navigation keeps the map accessible at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await setup(page, true);
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await expect(page.locator("#navigation-alert")).toBeHidden();
    const bounds = await page.evaluate(() => {
      const top = document
        .getElementById("navigation-top")!
        .getBoundingClientRect();
      const panel = document
        .getElementById("navigation-panel")!
        .getBoundingClientRect();
      const end = document
        .getElementById("navigation-end")!
        .getBoundingClientRect();
      return {
        top: top.bottom,
        bottom: panel.top,
        panelHeight: panel.height,
        endWidth: end.width,
        endHeight: end.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(bounds.panelHeight).toBeLessThanOrEqual(88);
    expect(bounds.endWidth).toBeGreaterThanOrEqual(44);
    expect(bounds.endHeight).toBeGreaterThanOrEqual(44);
    expect(bounds.overflow).toBe(false);
    if (width === 390)
      expect(bounds.bottom - bounds.top).toBeGreaterThanOrEqual(height * 0.6);
    await page.screenshot({
      path: test.info().outputPath(`compact-${width}.png`),
    });
    await page.locator("#navigation-details-toggle").press("Enter");
    await expect(page.locator("#navigation-details")).toBeVisible();
    await expect(page.locator("#navigation-complete")).toBeVisible();
    await page.locator("#navigation-details-toggle").press("Escape");
    await expect(page.locator("#navigation-details")).toBeHidden();
    const grip = await page.locator("#navigation-details-toggle").boundingBox();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 15);
    await page.mouse.down();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y - 40, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(page.locator("#navigation-details")).toBeVisible();
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-details")).toBeHidden();
    await page.evaluate(() => (window as any).navProbe.push(48, 11, 90, 500));
    await expect(page.locator("#navigation-alert-summary")).toContainText(
      "Standort ungenau",
    );
    await expect(page.locator("#navigation-details")).toBeHidden();
    await page.locator("#navigation-alert-open").click();
    await expect(page.locator("#navigation-location-status")).toBeVisible();
  });

test("mobile details resize without recentering a manually moved map and keep stop actions visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.locator("#navigation-map").press("ArrowRight");
  await page.clock.runFor(400);
  const center = await page
    .locator("#navigation-map")
    .getAttribute("data-center");
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-details")).toBeVisible();
  await page.clock.runFor(400);
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-center",
    center!,
  );
  for (let index = 0; index < 5; index++) await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(page.locator("#navigation-complete")).toBeVisible();
  await expect(page.locator("#navigation-complete")).toHaveText("Weiterfahren");
  await page.locator("#navigation-complete").click();
  await expect(page.locator("#navigation-instruction")).not.toHaveText(
    "Zwischenziel erreicht",
  );
});

test("mobile guidance wraps long names and large text without losing controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await setup(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    document.getElementById("navigation-instruction")!.textContent =
      "Links abbiegen auf Bürgermeister-Friedrich-Wilhelm-Straße";
  });
  await expect(page.locator("#navigation-end")).toBeInViewport();
  await expect(page.locator("#navigation-center")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("large-text.png") });
  await page.locator("#navigation-end").click();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
});
async function savedActive(page: Page) {
  return page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    return !!(await new NavigationStore().read());
  });
}
async function savedProgress(page: Page) {
  return page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    return (await new NavigationStore().read())?.progress;
  });
}
for (const width of [390, 1280])
  test(`ending confirmation preserves progress and restores focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setup(page);
    await expect.poll(() => savedActive(page)).toBe(true);
    const progress = await savedProgress(page);
    const end = page.locator("#navigation-end");
    const dialog = page.getByRole("dialog", { name: "Navigation beenden?" });
    const keepGoing = dialog.getByRole("button", { name: "Weiter navigieren" });
    const finish = dialog.getByRole("button", { name: "Beenden", exact: true });
    await end.focus();
    await end.press("Enter");
    await expect(dialog).toHaveAccessibleDescription(
      "Die Route bleibt verfügbar.",
    );
    await expect(keepGoing).toBeFocused();
    await expect(finish).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    if (width < 900) {
      expect(844 - bounds.y - bounds.height).toBeCloseTo(12, 0);
      expect((await keepGoing.boundingBox())!.y).toBeLessThan(
        (await finish.boundingBox())!.y,
      );
    } else {
      expect(bounds.y + bounds.height / 2).toBeCloseTo(422, 0);
      expect((await keepGoing.boundingBox())!.x).toBeLessThan(
        (await finish.boundingBox())!.x,
      );
    }
    await page.screenshot({
      path: test.info().outputPath("end-confirmation.png"),
    });
    // Enter initially continues instead of ending the active navigation.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    await end.press("Enter");
    await keepGoing.click();
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    await end.press("Enter");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    expect(await savedProgress(page)).toEqual(progress);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
    await end.press("Enter");
    // The native modal keeps underlying controls inert in both browsers.
    await end.evaluate((element) => element.focus());
    await expect(keepGoing).toBeFocused();
    await finish.focus();
    await expect(finish).toBeFocused();
    await finish.press("Enter");
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect.poll(() => savedActive(page)).toBe(false);
    await expect(page.locator("#map-view")).toBeVisible();
    await expect(page.locator("#replan-saved")).toBeFocused();
  });

test("browser back dismisses an open navigation confirmation without losing progress", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  const progress = await savedProgress(page);
  const historyLength = await page.evaluate(() => history.length);
  const end = page.locator("#navigation-end");
  const dialog = page.locator("#navigation-confirm");
  await end.focus();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#navigation-confirm-no")).toBeFocused();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(end).toBeFocused();
  await end.press("Enter");
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(end).toBeFocused();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await savedProgress(page)).toEqual(progress);
  await expect(page.locator("#navigation-view")).toBeVisible();
});

test("section confirmation keeps its labels and placement after cancelling navigation end", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-no").click();
  await page.locator("#navigation-details-toggle").click();
  const completeSection = page.locator("#navigation-complete");
  await completeSection.focus();
  await completeSection.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Abschnitt beenden?" });
  await expect(
    dialog.getByRole("button", { name: "Bestätigen" }),
  ).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Abbrechen" })).toBeVisible();
  expect((await dialog.boundingBox())!.y).toBeCloseTo(12, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(completeSection).toBeFocused();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
});

for (const [width, height, largeText] of [
  [320, 320, true],
  [844, 390, false],
] as const)
  test(`ending confirmation remains usable at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: Math.max(height, 568) });
    await setup(page);
    await page.locator("#navigation-end").click();
    // Resize an open dialog, including enlarged text in a very short viewport.
    await page.setViewportSize({ width, height });
    if (largeText)
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
    await page.clock.runFor(200);
    const dialog = page.locator("#navigation-confirm");
    await expect(page.locator("#navigation-confirm-no")).toBeFocused();
    await expect
      .poll(async () => {
        const bounds = (await dialog.boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeCloseTo(height - 12, 0);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(12);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 11);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    for (const id of ["navigation-confirm-no", "navigation-confirm-yes"]) {
      const button = page.locator(`#${id}`);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator("#navigation-confirm-no").scrollIntoViewIfNeeded();
    await page.locator("#navigation-confirm-no").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#navigation-view")).toBeVisible();
  });
for (const width of [390, 1280])
  test(`rotating navigation, speech, user camera and finish at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".app-tabs")).toBeHidden();
    await expect(page.locator("#navigation-map canvas")).toBeVisible();
    await expect(page.locator("#navigation-map")).toHaveAttribute(
      "data-bearing",
      "90",
    );
    await expect.poll(() => savedActive(page)).toBe(true);
    await page.locator("#navigation-audio").click();
    await expect(page.locator("#navigation-audio")).toHaveAttribute(
      "aria-label",
      "Ton einschalten",
    );
    await expect(page.locator("#navigation-audio")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("#navigation-audio svg")).toBeVisible();
    const map = page.locator("#navigation-map");
    await expect(map).toHaveAttribute("data-zoom", "17");
    await map.press("-");
    await page.clock.runFor(400);
    await expect(map).toHaveAttribute("data-zoom", "16");
    await expect(map).toHaveAttribute("data-following", "false");
    await expect(page.locator("#navigation-center")).toHaveAttribute(
      "title",
      "Standort folgen",
    );
    await page.locator("#navigation-center").click();
    await expect(map).toHaveAttribute("data-following", "true");
    await expect(page.locator("#navigation-center")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(map).toHaveAttribute("data-zoom", "17");
    await page.screenshot({ path: test.info().outputPath("navigation.png") });
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-no").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
    await complete(page);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Ziel erreicht",
    );
    await expect.poll(() => savedActive(page)).toBe(false);
    await page.locator("#navigation-end").click();
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#map-view")).toBeVisible();
    expect(errors).toEqual([]);
  });
test("following restores the current section zoom after progressing with a manual camera", async ({
  page,
}) => {
  await setup(page, true);
  const map = page.locator("#navigation-map");
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Fold retains the cycling default.
  await expect(map).toHaveAttribute("data-zoom", "16");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "17");
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Transit changes its default while following is paused.
  await expect(map).toHaveAttribute("data-zoom", "16");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "15");
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Unfold.
  await complete(page); // Walk.
  await expect(map).toHaveAttribute("data-zoom", "14");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "18");
  await page.clock.runFor(1000);
  await expect(map).toHaveAttribute("data-zoom", "18");
});
test("mobile touch drag moves the unfocused map and following restores its center", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const map = page.locator("#navigation-map");
  await page.locator("#navigation-end").focus();
  const initial = await map.getAttribute("data-center");
  expect(initial).toBeTruthy();
  await expect(map).toHaveCSS("touch-action", "none");
  await page.evaluate(() => {
    const target = document.elementFromPoint(100, 220)!;
    if (!target.closest("#navigation-map")) throw new Error("Map is covered");
    for (const [type, x, y] of [
      ["pointerdown", 100, 220],
      ["pointermove", 120, 225],
      ["pointermove", 180, 250],
      ["pointerup", 180, 250],
    ] as const) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      );
    }
  });
  await page.clock.runFor(400);
  await expect(map).toHaveAttribute("data-following", "false");
  await expect(map).not.toHaveAttribute("data-center", initial!);
  const moved = await map.getAttribute("data-center");
  await page.evaluate(() => (window as any).navProbe.push(48, 11));
  await expect(map).toHaveAttribute("data-center", moved!);
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-center", initial!);
  await expect(map).toHaveAttribute("data-zoom", "17");
});
test("requires confirmation after reload and resumes offline without fresh transit claims", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("#navigation-network-status")).toContainText(
    "Offline",
  );
  await page.evaluate(() => (window as any).navProbe.hide(true));
  await expect(page.locator("#navigation-location-status")).toContainText(
    "pausiert",
  );
  await page.evaluate(() => (window as any).navProbe.hide(false));
  await page.clock.runFor(10);
  await expect(page.locator("#navigation-map canvas")).toBeVisible();
});
test("completes a multimodal journey with live platform, stop confirmation and waiting", async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.locator("#navigation-transit-status")).toContainText(
    "Echtzeit",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung Altstadt",
  );
  await expect(page.locator("#navigation-detail")).toContainText("Gleis 4");
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt entfalten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText("Zu Fuß");
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await page.locator("#navigation-complete").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Auf Weiterfahrt warten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "Mit dem Rad nach Ziel",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Ziel erreicht",
  );
});
test("browser back confirms ending and storage opt-out prevents recovery", async ({
  page,
}) => {
  await setup(page);
  await page.goBack();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#replan-saved")).toBeFocused();
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await page.locator("#tab-route").click();
  await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  expect(await savedActive(page)).toBe(false);
});

test("GPS advances street legs, timers advance fresh transit, stops remain explicit", async ({
  page,
}) => {
  test.setTimeout(60000);
  await setup(page, true);
  async function gps(point: Place, elapsed: number) {
    await page.clock.runFor(elapsed);
    await page.evaluate(
      ({ latitude, longitude }) =>
        (window as any).navProbe.push(latitude, longitude),
      point,
    );
  }
  await gps(b, 10000);
  await gps(c, 20000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await gps(c, 270000);
  await page.clock.runFor(1100);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung Altstadt",
  );
  await gps(d, 300000);
  await page.clock.runFor(1100);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt entfalten",
  );
  await gps(d, 180000);
  await page.clock.runFor(1100);
  await expect(page.locator("#navigation-instruction")).toContainText("Zu Fuß");
  await gps(e, 30000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await gps(e, 90000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await page.locator("#navigation-complete").click();
  await gps(f, 80000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Ziel erreicht",
  );
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
  await expect(page.locator("#navigation-locate")).toBeVisible();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Navigation konnte nicht starten",
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: (window as any).savedGeo,
    }),
  );
  await page.locator("#navigation-locate").click();
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
  await expect(page.locator("#navigation-status")).toHaveText(
    "Standort wird geprüft …",
  );
  await page.clock.runFor(3100);
  await expect(page.locator("#navigation-status")).toContainText(
    "Warte auf einen genauen Standort",
  );
  await page.clock.runFor(9000);
  await expect(page.locator("#navigation-status")).toContainText(
    "Standortabfrage dauert zu lange",
  );
  await expect(page.locator("#navigation-locate")).toBeVisible();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Navigation konnte nicht starten",
  );
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
  await expect(page.locator("#navigation-status")).toHaveText(
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
  await expect(page.locator("#navigation-locate")).toBeVisible();
  await expect(page.locator("#navigation-status")).toContainText(
    "unterbrochen",
  );
  await page.locator("#navigation-locate").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
});

test("interrupted trip lookup offers a startup retry after returning", async ({
  page,
}) => {
  await setup(page, true);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.goto("/");
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/v6/trip?*", async (r) => {
    requested = true;
    await gate;
    await r.fulfill({ json: { legs: [] } });
  });
  await page.locator("#navigation-resume").click();
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => (window as any).navProbe.hide(true));
  release();
  await page.evaluate(() => (window as any).navProbe.hide(false));
  await page.clock.runFor(10);
  await expect(page.locator("#navigation-retry")).toBeVisible();
  await page.locator("#navigation-retry").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
});

test("ending resumed navigation restores stops without replacing personal preferences", async ({
  page,
}) => {
  await setup(page, true);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.evaluate(async (defaults) => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    const store = new NavigationStore();
    const snapshot = (await store.read())!;
    snapshot.settings = {
      ...defaults,
      cyclingSpeedKilometersPerHour: 21,
      maxCyclingMinutes: 45,
    };
    await store.save(snapshot);
    localStorage.setItem("foldroute.routing.v3", JSON.stringify(defaults));
  }, defaults);
  await page.goto("/");
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");
  await expect(page.locator(".stop-editor-row:visible")).toHaveCount(1);
  await expect(page.locator("#via-0")).toHaveValue("Café");
  await page.locator("#cancel-adjust").click();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#cyclingSpeedKilometersPerHour")).toHaveValue(
    String(defaults.cyclingSpeedKilometersPerHour),
  );
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue(
    String(defaults.maxCyclingMinutes),
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toEqual(defaults);
  await page.locator("#tab-route").click();
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  const planned = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#replan-saved").click();
  const params = new URL((await planned).url()).searchParams;
  expect(params.get("cyclingSpeed")).toBe(
    (defaults.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
  );
});
