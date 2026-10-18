import { openCachedJourney, expectMotionSettled } from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import {
  defaults,
  type Journey,
  type Leg,
  type Place,
  type RouteRequest,
} from "../../src/model";
import { distance } from "../../src/geometry";
import { mockRasterBasemap } from "./basemap";
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
    await expect(page.locator("#navigation-location-status")).toContainText(
      "Standort erneut anfragen",
    );
    await expect(page.locator("#navigation-alternative")).toBeHidden();
    await page.locator("#navigation-locate").click();
    await expect(page.locator("#navigation-alternative")).toBeVisible();
    await expect(page.locator("#navigation-status")).toContainText(
      "Bitte zum Übernehmen bestätigen",
    );
    await expect(page.getByRole("tab", { name: /^S1 nach/ })).toHaveCount(1);
    await page.locator("#navigation-accept").click();
    await expect(page.locator("#navigation-status")).toBeEmpty();
    await expect(page.locator("#navigation-alternative")).toBeHidden();
    await expect(page.getByRole("tab", { name: /^S1 nach/ })).toHaveCount(0);
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
    const acceptedID = await page.evaluate(async () => {
      const { NavigationStore } = await import("/src/navigation-store.ts");
      return (await new NavigationStore().read())!.journey.id;
    });
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("#navigation-start")).toBeFocused();
    await expect(page.locator("#choices .route-choice")).toHaveCount(1);
    await expect(page.locator("#choices .route-choice")).toHaveAttribute(
      "data-journey",
      acceptedID,
    );
    await expect(page.locator("#saved-notice")).toBeHidden();
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
async function setup(
  page: Page,
  multimodal = false,
  start = true,
  requestOverrides: Partial<RouteRequest> = {},
  selectedJourney = route(multimodal),
) {
  await page.clock.install({ time: new Date(now * 1000) });
  await page.addInitScript(() => {
    const watchers = new Map<number, PositionCallback>();
    const errors = new Map<number, PositionErrorCallback>();
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
      stopped: 0,
      quickLookups: 0,
      cachedAt: undefined as number | undefined,
      lastWatchOptions: undefined as PositionOptions | undefined,
      lastQuickOptions: undefined as PositionOptions | undefined,
      get active() {
        return watchers.size;
      },
      silent: false,
      spoken: [] as string[],
      cancelled: 0,
      fail(code: number) {
        for (const error of errors.values())
          error({ code } as GeolocationPositionError);
      },
      push(
        latitude: number,
        longitude: number,
        heading = 90,
        accuracy = 10,
        age = 0,
      ) {
        coords = { ...coords, latitude, longitude, heading, accuracy };
        for (const success of watchers.values())
          success({
            coords,
            timestamp: Date.now() - age,
          } as GeolocationPosition);
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
        watchPosition(
          success: PositionCallback,
          error: PositionErrorCallback,
          options?: PositionOptions,
        ) {
          const key = ++id;
          watchers.set(key, success);
          errors.set(key, error);
          probe.started++;
          probe.lastWatchOptions = options;
          setTimeout(() => {
            if (!probe.silent)
              success({ coords, timestamp: Date.now() } as GeolocationPosition);
          }, 0);
          return key;
        },
        clearWatch(key: number) {
          probe.stopped++;
          watchers.delete(key);
          errors.delete(key);
        },
        getCurrentPosition(
          success: PositionCallback,
          _error?: PositionErrorCallback,
          options?: PositionOptions,
        ) {
          probe.quickLookups++;
          probe.lastQuickOptions = options;
          if (probe.cachedAt !== undefined || !probe.silent)
            success({
              coords,
              timestamp: probe.cachedAt ?? Date.now(),
            } as GeolocationPosition);
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
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
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
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await page.evaluate(
    async ({ journey, settings, time, requestOverrides }) => {
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
            ...requestOverrides,
          },
        },
        "test",
      );
    },
    {
      journey: selectedJourney,
      settings: defaults,
      time: now,
      requestOverrides,
    },
  );
  await page.reload();
  await openCachedJourney(page, page.locator("#open-saved"));
  if (!start) return;
  await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await expect(page.locator("#navigation-storage-status")).toBeEmpty();
}

function guidanceRoute(singleStep = false): Journey {
  const journey = route();
  const coordinates = singleStep
    ? [
        a,
        { ...a, longitude: 11.0008 },
        { ...a, longitude: 11.0008, latitude: 48.0006 },
        { ...a, longitude: 11.003, latitude: 48.0006 },
      ]
    : [
        a,
        { ...a, longitude: 11.00005 },
        { ...a, longitude: 11.0001 },
        { ...a, longitude: 11.001 },
        { ...a, longitude: 11.0108 },
        { ...a, longitude: 11.0108, latitude: 48.002 },
        { ...a, longitude: 11.0143, latitude: 48.002 },
      ];
  const to = { ...coordinates.at(-1)!, name: "Ziel" };
  const leg = journey.legs[0];
  leg.to = to;
  leg.coordinates = coordinates;
  leg.end = now + 900;
  leg.distance = coordinates
    .slice(1)
    .reduce((sum, p, i) => sum + distance(coordinates[i], p), 0);
  leg.maneuvers = singleStep
    ? [
        {
          direction: "CONTINUE",
          streetName: "",
          coordinates,
          distance: leg.distance,
        },
      ]
    : coordinates.slice(1).map((p, i) => ({
        direction: "CONTINUE",
        streetName: i === 4 ? "Am Isarufer" : i === 5 ? "Zum Bahnhof" : "",
        coordinates: [coordinates[i], p],
        distance: distance(coordinates[i], p),
      }));
  journey.destination = to;
  journey.arrival = leg.end;
  return journey;
}

for (const width of [390, 1280]) {
  test(`next actual turn stays visible across short straight steps at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, false, false, {}, guidanceRoute());
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").click();
    const instruction = page.locator("#navigation-instruction");
    const meters = page.locator("#navigation-distance");
    await expect(instruction).toHaveText("Links abbiegen auf Am Isarufer");
    await expect(page.locator("#navigation-arrow")).toHaveText("↰");
    await expect(meters).toHaveText("805 m");
    for (const longitude of [
      11.00005, 11.0001, 11.001, 11.0054, 11.0098, 11.0106,
    ]) {
      await page.clock.runFor(20000);
      await page.evaluate(
        (longitude) => (window as any).navProbe.push(48, longitude),
        longitude,
      );
      await expect(instruction).toHaveText("Links abbiegen auf Am Isarufer");
      const expected =
        Math.round(
          distance(
            { latitude: 48, longitude },
            { latitude: 48, longitude: 11.0108 },
          ) / 5,
        ) * 5;
      await expect(meters).toHaveText(`${expected} m`);
    }
    const spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(
      spoken.filter((text) => text.includes("Links abbiegen")),
    ).toHaveLength(2);
    expect(spoken.some((text) => text.includes("Geradeaus"))).toBe(false);
    await page.screenshot({ path: info.outputPath("next-turn-countdown.png") });
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.0108));
    await expect(instruction).toHaveText("Rechts abbiegen auf Zum Bahnhof");
    await expect(page.locator("#navigation-arrow")).toHaveText("↱");
    await expect(meters).toHaveText("220 m");
  });

  test(`two inferred turns in one source step have separate announcements and survive GPS loss and resume at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, false, false, {}, guidanceRoute(true));
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").click();
    const instruction = page.locator("#navigation-instruction");
    const meters = page.locator("#navigation-distance");
    await expect(instruction).toHaveText("Links abbiegen");
    await expect(meters).toHaveText("60 m");
    await page.clock.runFor(5000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.0008));
    await expect(instruction).toHaveText("Rechts abbiegen");
    await expect(meters).toHaveText("65 m");
    let spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(
      spoken.filter((text) => text.includes("Links abbiegen")),
    ).toHaveLength(1);
    expect(
      spoken.filter((text) => text.includes("Rechts abbiegen")),
    ).toHaveLength(1);
    await page.evaluate(() => (window as any).navProbe.fail(2));
    await expect(meters).toBeEmpty();
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48.0003, 11.0008));
    await expect(meters).toHaveText("35 m");
    await page.evaluate(() => (window as any).navProbe.hide(true));
    await page.reload();
    await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
    await page.evaluate(() => (window as any).navProbe.push(48.0003, 11.0008));
    await page.locator("#navigation-resume").click();
    await expect(instruction).toHaveText("Rechts abbiegen");
    await expect(meters).toHaveText("35 m");
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48.0006, 11.0008));
    await expect(instruction).toHaveText("Nach Ziel");
    await expect(meters).toHaveText("165 m");
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48.0006, 11.003));
    await expect(instruction).toHaveText("Ziel erreicht");
    spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(spoken).toContain("Ziel erreicht");
    expect(spoken.some((text) => /In .*Metern Ziel erreicht/.test(text))).toBe(
      false,
    );
  });
}
async function complete(page: Page) {
  if (!(await page.locator("#navigation-complete").isVisible()))
    await page.locator("#navigation-details-toggle").click();
  await page.locator("#navigation-complete").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-confirm")).toBeHidden();
}

function stationJourney() {
  const journey = route(true);
  const train = journey.legs[2];
  const between = (part: number, name: string): Place => ({
    name,
    detail: "",
    stopId: `station-${part}`,
    latitude: c.latitude + ((d.latitude - c.latitude) * part) / 3,
    longitude: c.longitude + ((d.longitude - c.longitude) * part) / 3,
  });
  train.transitStops = [
    c,
    between(1, "Stadtmitte"),
    between(2, "Rathaus"),
    d,
  ].map((stop, i) => ({ ...stop, scheduledArrival: now + 300 + i * 100 }));
  train.coordinates = train.transitStops;
  return journey;
}

async function stationRail(page: Page, selector: string) {
  return page.locator(selector).evaluate((list) => {
    const top = list.getBoundingClientRect().top;
    const rows = [
      ...list.querySelectorAll<HTMLElement>(
        ".navigation-station:not([data-leaving])",
      ),
    ].map((row) => {
      const marker = row.querySelector<HTMLElement>(
        ".navigation-station-marker",
      )!;
      const dot = getComputedStyle(marker, "::before");
      const line = getComputedStyle(row, "::before");
      return {
        index: Number(row.dataset.index),
        name: row.querySelector(".navigation-station-name")!.textContent,
        reached: row.dataset.reached,
        y:
          marker.getBoundingClientRect().top -
          top +
          parseFloat(dot.top) +
          parseFloat(dot.height) / 2,
        dotX:
          marker.getBoundingClientRect().left +
          parseFloat(dot.left) +
          parseFloat(dot.width) / 2,
        lineX:
          row.getBoundingClientRect().left +
          parseFloat(line.left) +
          parseFloat(line.width) / 2,
        width: parseFloat(line.width),
      };
    });
    const filled = parseFloat(
      (list as HTMLElement).style.getPropertyValue("--station-progress"),
    );
    let progress = rows[0]?.index ?? 0;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i],
        b = rows[i + 1];
      if (filled >= a.y) progress = a.index;
      if (b && filled >= a.y && filled < b.y) {
        progress =
          a.index + ((b.index - a.index) * (filled - a.y)) / (b.y - a.y);
        break;
      }
    }
    return { rows, filled, progress };
  });
}

for (const width of [320, 390, 1280])
  test(`station rail fills with the visible marker, waits at stops and corrects with GPS at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({
      reducedMotion: "no-preference",
      colorScheme: width === 320 ? "dark" : "light",
    });
    const journey = stationJourney(),
      train = journey.legs[2];
    delete train.transitReference;
    train.end = now + 340;
    train.transitStops!.forEach((stop, i) => {
      stop.arrival = now + 300 + [0, 10, 30, 40][i];
      stop.departure = now + 300 + [0, 14, 32, 40][i];
      delete stop.scheduledArrival;
    });
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await page.clock.pauseAt(new Date((now + 300) * 1000));
    for (let i = 0; i < 2; i++) {
      await page.clock.runFor(1000);
      await page.evaluate(
        (point) =>
          (window as any).navProbe.push(point.latitude, point.longitude),
        c,
      );
    }
    const before = await savedProgress(page);
    await page.evaluate(() => {
      (window as any).navProbe.silent = true;
      (window as any).navProbe.fail(2);
    });
    const selector =
      width < 900
        ? "#navigation-stations-preview"
        : "#navigation-stations-detail";
    await page.clock.runFor(2100);
    const first = await stationRail(page, selector);
    expect(first.progress).toBeCloseTo(0.41, 1);
    expect(first.rows.map((row) => row.reached)).toEqual(
      width < 900
        ? ["true", "false", "false"]
        : ["true", "false", "false", "false"],
    );
    for (const row of first.rows) {
      expect(row.width).toBe(4);
      expect(row.dotX).toBeCloseTo(row.lineX, 2);
    }
    if (width < 900)
      expect(first.rows.map((row) => row.name)).toEqual([
        "Bahnhof",
        "Stadtmitte",
        "Ausstieg",
      ]);
    const originalRow = await page
      .locator(`${selector} .navigation-station`)
      .first()
      .elementHandle();
    await page.clock.runFor(700);
    expect((await stationRail(page, selector)).progress).toBeGreaterThan(
      first.progress,
    );
    expect(await originalRow!.evaluate((row) => row.isConnected)).toBe(true);
    await page.screenshot({
      path: info.outputPath("station-rail-between-stops.png"),
    });
    // Arrival fills the circle; the segment stays still throughout the dwell.
    await page.clock.runFor(5900);
    const dwell = await stationRail(page, selector);
    expect(dwell.progress).toBeCloseTo(1, 2);
    expect(dwell.rows[1].reached).toBe("true");
    await page.clock.runFor(1000);
    expect((await stationRail(page, selector)).filled).toBe(dwell.filled);
    if (width < 900) {
      await page.clock.runFor(2350);
      const rail = page.locator(selector);
      await expect(rail).toHaveAttribute("data-shifting", "true");
      const halfway = await rail.evaluate((list) => {
        const leaving = list.querySelector<HTMLElement>(
          "[data-leaving].navigation-station",
        )!;
        const animations = list.getAnimations({ subtree: true });
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = 0;
        }
        const initial = leaving
          .querySelector(".navigation-station-marker")!
          .getBoundingClientRect().top;
        const height = leaving.getBoundingClientRect().height;
        for (const animation of animations) animation.currentTime = 450;
        return {
          initial,
          midway: leaving
            .querySelector(".navigation-station-marker")!
            .getBoundingClientRect().top,
          height,
          midwayHeight: leaving.getBoundingClientRect().height,
          hidden: leaving.getAttribute("aria-hidden"),
          opacity: getComputedStyle(leaving).opacity,
          clipped: getComputedStyle(list).overflowY,
          connected: leaving.isConnected,
        };
      });
      expect(halfway.connected).toBe(true);
      expect(halfway.hidden).toBe("true");
      expect(halfway.clipped).toBe("hidden");
      expect(halfway.opacity).toBe("1");
      expect(halfway.midway).toBeLessThan(halfway.initial - 2);
      expect(halfway.midwayHeight).toBeGreaterThan(0);
      expect(halfway.midwayHeight).toBeLessThan(halfway.height);
      await page.screenshot({
        path: info.outputPath("station-rail-haltwechsel.png"),
      });
      if (width === 390) await page.emulateMedia({ reducedMotion: "reduce" });
      else
        await rail.evaluate((list) =>
          list
            .getAnimations({ subtree: true })
            .forEach((animation) => animation.finish()),
        );
      await expect(rail.locator("[data-leaving]")).toHaveCount(0);
      expect(
        await rail.evaluate(
          (list) => list.getAnimations({ subtree: true }).length,
        ),
      ).toBe(0);
      if (width === 390)
        await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(rail).toHaveAttribute("data-continuation", "true");
      const continuation = await rail
        .locator(".navigation-station")
        .first()
        .evaluate((row) => ({
          lineTop: parseFloat(getComputedStyle(row, "::before").top),
          dotTop:
            row
              .querySelector(".navigation-station-marker")!
              .getBoundingClientRect().top - row.getBoundingClientRect().top,
        }));
      expect(continuation.lineTop).toBe(0);
      expect(continuation.dotTop).toBeGreaterThanOrEqual(0);
      await page.clock.runFor(1650);
    } else await page.clock.runFor(4000);
    const departing = await stationRail(page, selector);
    expect(departing.progress).toBeGreaterThan(1);
    expect(departing.progress).toBeLessThan(1.2);
    if (width < 900)
      expect(departing.rows.map((row) => row.name)).toEqual([
        "Stadtmitte",
        "Rathaus",
        "Ausstieg",
      ]);
    const mapPoint = await page
      .locator("#navigation-map")
      .evaluate((el) => JSON.parse(el.dataset.position!));
    expect(departing.progress).toBeCloseTo(
      (3 * distance(c, mapPoint)) / distance(c, d),
      2,
    );
    // A correction backwards starts at the visible rail position and also takes two seconds.
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      c,
    );
    expect((await stationRail(page, selector)).progress).toBeCloseTo(
      departing.progress,
      2,
    );
    await page.clock.runFor(1000);
    const middle = await stationRail(page, selector);
    expect(middle.progress).toBeGreaterThan(0);
    expect(middle.progress).toBeLessThan(departing.progress);
    await page.clock.runFor(1100);
    expect((await stationRail(page, selector)).progress).toBeCloseTo(0, 2);
    expect(await savedProgress(page)).toEqual(before);
    await page.evaluate(() => (window as any).navProbe.fail(2));
    await page.clock.fastForward(50000);
    await page.clock.runFor(2100);
    const exit = await stationRail(page, selector);
    expect(exit.progress).toBeCloseTo(3, 2);
    expect(exit.rows.at(-1)!.reached).toBe("true");
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Ausstieg: Ausstieg",
    );
    expect(await savedProgress(page)).toEqual(before);
    await page.screenshot({
      path: info.outputPath("station-rail-progress.png"),
    });
  });

for (const width of [320, 390, 844, 1280])
  test(`departure and station progress remain visible with collapsed details at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    const journey = stationJourney();
    await setup(page, true, true, {}, journey);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "S1 · in 5 Min.",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Abfahrt 12:05",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Gleis 4",
    );
    await page.clock.runFor(60000);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "S1 · in 4 Min.",
    );
    await complete(page);
    await complete(page);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Nächster Halt: Stadtmitte",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Noch 3 Halte",
    );
    const preview = page.locator(
      width < 900
        ? "#navigation-stations-preview"
        : "#navigation-stations-detail",
    );
    await expect(preview).toBeVisible();
    const station = journey.legs[2].transitStops![1];
    await page.clock.runFor(1000);
    await page.evaluate(
      (stop) => (window as any).navProbe.push(stop.latitude, stop.longitude),
      station,
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Noch 3 Halte",
    );
    await page.clock.runFor(1000);
    await page.evaluate(
      (stop) => (window as any).navProbe.push(stop.latitude, stop.longitude),
      station,
    );
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Nächster Halt: Rathaus",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Noch 2 Halte",
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await page.evaluate(
      (stop) =>
        (window as any).navProbe.push(stop.latitude, stop.longitude, 90, 500),
      station,
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "GPS ungenau Position geschätzt",
    );
    await expect(
      page.locator("#navigation-stations-announcement"),
    ).not.toContainText("Stationsfortschritt pausiert");
    await page.clock.runFor(61000);
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "Kein GPS Position geschätzt",
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Noch 2 Halte",
    );
    await page.screenshot({ path: info.outputPath("stations-paused.png") });
    const next = journey.legs[2].transitStops![2];
    for (let i = 0; i < 2; i++) {
      await page.clock.runFor(1000);
      await page.evaluate(
        (stop) => (window as any).navProbe.push(stop.latitude, stop.longitude),
        next,
      );
    }
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Noch 1 Halt",
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await page.clock.runFor(2100);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(
      page.locator("#navigation-stations-detail .navigation-station"),
    ).toHaveCount(4);
    await expect(
      page.locator("#navigation-stations-detail [data-state=passed]"),
    ).toHaveCount(3);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-summary-arrival")).toContainText(
      "Am Ziel",
    );
    if (width < 900)
      await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
    await expect(page.locator("#navigation-end")).toBeVisible();
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({ path: info.outputPath("stations-progress.png") });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    if (width === 320) {
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      await expect(page.locator("#navigation-context-title")).toBeVisible();
      await expect(page.locator("#navigation-end")).toBeInViewport();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: info.outputPath("stations-large-text.png"),
      });
    }
  });

for (const width of [390, 1280])
  test(`station arrival times prefer updates and fall back to the timetable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = stationJourney();
    const train = journey.legs[2];
    const stops = train.transitStops!;
    delete stops[0].scheduledArrival;
    stops[0].scheduledDeparture = now + 300;
    stops[1].arrival = now + 420;
    stops[2].scheduledArrival = now + 480;
    stops.splice(
      3,
      0,
      {
        ...stops[2],
        name: "Entfallener Halt",
        stopId: "cancelled",
        cancelled: true,
      },
      {
        ...d,
        name: "Ohne Ankunftszeit",
        stopId: "untimed",
        departure: now + 550,
      },
    );
    train.coordinates = stops;
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    const list = page.locator(
      width < 900
        ? "#navigation-stations-preview"
        : "#navigation-stations-detail",
    );
    await expect(list.locator("time")).toHaveText(
      width < 900 ? ["12:07", "12:10"] : ["12:07", "12:08", "12:10"],
    );
    await expect(list.locator("time").first()).toHaveAttribute(
      "aria-label",
      "Ankunft 12:07",
    );
    await expect(list.locator("time").nth(1)).toHaveAttribute(
      "aria-label",
      width < 900
        ? "Ankunft laut Fahrplan 12:10"
        : "Ankunft laut Fahrplan 12:08",
    );
    await expect(list.locator("time").first()).toHaveAttribute(
      "datetime",
      new Date((now + 420) * 1000).toISOString(),
    );
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    const details = page.locator("#navigation-stations-detail");
    await expect(details.locator(".navigation-station")).toHaveCount(6);
    for (const name of ["Bahnhof", "Entfallener Halt", "Ohne Ankunftszeit"])
      await expect(
        details
          .locator(".navigation-station")
          .filter({ hasText: name })
          .locator("time"),
      ).toHaveCount(0);
    // A later trip refresh changes the times without advancing stations by the clock.
    const iso = (time: number) => new Date(time * 1000).toISOString();
    await page.route("**/api/v6/trip?*", (r) =>
      r.fulfill({
        json: {
          legs: [
            {
              from: {
                ...stops[0],
                lat: stops[0].latitude,
                lon: stops[0].longitude,
                scheduledDeparture: iso(now + 300),
                departure: iso(now + 300),
              },
              intermediateStops: stops.slice(1, -1).map((stop) => ({
                ...stop,
                lat: stop.latitude,
                lon: stop.longitude,
                scheduledArrival:
                  stop.scheduledArrival === undefined
                    ? undefined
                    : iso(stop.scheduledArrival),
                arrival:
                  stop.arrival === undefined
                    ? undefined
                    : iso(stop.arrival + 60),
                departure:
                  stop.departure === undefined
                    ? undefined
                    : iso(stop.departure),
              })),
              to: {
                ...d,
                lat: d.latitude,
                lon: d.longitude,
                scheduledArrival: iso(now + 600),
                arrival: iso(now + 660),
              },
              realTime: true,
            },
          ],
        },
      }),
    );
    await page.clock.runFor(61000);
    await expect(details.locator("time")).toHaveText([
      "12:08",
      "12:08",
      "12:11",
    ]);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Nächster Halt: Stadtmitte",
    );
    if (width < 900) {
      await page.locator("#navigation-details-toggle").click();
      await expect(list.locator("time")).toHaveText(["12:08", "12:11"]);
    }
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("station-arrival-times.png"),
    });
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`station list remains reachable with long names and large text (${colorScheme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.emulateMedia({ colorScheme });
    const journey = stationJourney();
    const train = journey.legs[2];
    const stops = train.transitStops!;
    stops[1].name =
      "Weinmeisterstraße / Museumsinsel – Ausgang Hackescher Markt";
    stops.splice(3, 0, {
      ...stops[2],
      name: "Jannowitzbrücke",
      stopId: "extra-station",
      latitude: (stops[2].latitude + d.latitude) / 2,
      longitude: (stops[2].longitude + d.longitude) / 2,
    });
    train.to = stops[4] = {
      ...d,
      name: "Heinrich-Heine-Straße / Michaelkirchplatz – Ausgang Köpenicker Straße",
      scheduledArrival: now + 600,
    };
    train.coordinates = stops;
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    await page.locator("#navigation-details-toggle").click();
    const preview = page.locator("#navigation-stations-preview");
    await expect(preview.locator(".navigation-station")).toHaveCount(3);
    await expect(preview.locator(".navigation-station-gap")).toHaveText(
      "Weitere Zwischenhalte",
    );
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({ path: info.outputPath("stations-long-names.png") });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "200%"),
    );
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.locator("#navigation-panel").hover();
    await page.mouse.wheel(0, 2000);
    await expect(
      preview.locator(".navigation-station").last(),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("stations-long-names-large-text.png"),
    });
  });

test("station progress survives resuming and shows cancelled stops without counting them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney();
  journey.legs[2].transitStops![2].cancelled = true;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 2 Halte",
  );
  const stop = journey.legs[2].transitStops![1];
  for (let i = 0; i < 2; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      stop,
    );
  }
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 1 Halt",
  );
  await expect(
    page.locator("#navigation-stations-detail [data-state=cancelled]"),
  ).toContainText("Halt entfällt");
  await page.reload();
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 1 Halt",
  );
  await expect(page.locator("#navigation-context-status")).not.toContainText(
    "Stationsfortschritt pausiert",
  );
});

for (const width of [390, 1280]) {
  test(`navigation keeps target arrival in details and compact current sections at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route();
    journey.legs.push({
      kind: "walk",
      from: c,
      to: d,
      start: now + 60,
      end: now + 180,
      distance: 200,
      coordinates: [c, d],
    });
    journey.destination = d;
    journey.arrival = now + 180;
    await setup(page, false, true, {}, journey);
    if (width < 900) {
      await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
      await expect(page.locator("#navigation-summary-label")).toBeVisible();
      await expect(page.locator("#navigation-summary-label")).toHaveText(
        "Reisedetails",
      );
    }
    await expect(page.locator("#navigation-summary-arrival")).toHaveText(
      "Am Ziel 12:03",
    );
    await expect(
      page.locator("#navigation-details-toggle"),
    ).not.toHaveAttribute("aria-describedby", /navigation-summary-arrival/);
    await expect(page.locator("#navigation-remaining")).toBeHidden();
    await expect(page.locator("#navigation-remaining")).toBeEmpty();
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-summary-arrival")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Gesamte Reise" }),
    ).toBeVisible();
    const details = page.locator("#navigation-section-content");
    await expect(details).toHaveText("Geplant: 1 min · 370 m");
    await expect(page.locator("#navigation-stage")).toHaveClass("sr-only");
    await expect(page.locator("#navigation-complete")).toBeVisible();
    const walk = page.getByRole("tab", { name: /^Zu Fuß nach Ausstieg/ });
    const progress = await savedProgress(page);
    const spoken = await page.evaluate(() => [
      ...(window as any).navProbe.spoken,
    ]);
    await walk.click();
    await expect(details).toContainText("Zu Fuß bis Ausstieg");
    await expect(details).toContainText("Von Bahnhof");
    await expect(details).toContainText("12:01 – 12:03");
    await expect(page.locator("#navigation-summary-arrival")).toHaveText(
      "Am Ziel 12:03",
    );
    await expect(page.locator("#navigation-complete")).toBeHidden();
    expect(await savedProgress(page)).toEqual(progress);
    expect(await page.evaluate(() => (window as any).navProbe.spoken)).toEqual(
      spoken,
    );
    // The selected preview becomes current through real position updates.
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.002));
    await page.clock.runFor(12000);
    await page.evaluate(() => (window as any).navProbe.push(48.002, 11.002, 0));
    await expect(walk).toHaveAttribute("aria-selected", "true");
    await expect(walk).toHaveAttribute("aria-current", "step");
    await expect(details).toHaveText("Geplant: 2 min · 200 m");
    await expect(page.locator("#navigation-complete")).toBeVisible();
    await expect(
      page.locator("#navigation-view").getByText(/^Am Ziel /),
    ).toHaveCount(1);
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("compact-current-section.png"),
    });
  });

  test(`missed arrival target stays visible outside the details at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route();
    journey.legs[0].end = journey.arrival = now + 180;
    await setup(
      page,
      false,
      true,
      { timing: "arrive", time: now + 120 },
      journey,
    );
    const warning = "Gewünschte Ankunft 12:02 wird nicht erreicht.";
    if (width < 900) {
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
      await expect(page.locator("#navigation-alert-summary")).toHaveText(
        warning,
      );
      await expect(page.locator("#navigation-alert-summary")).toBeVisible();
      await page.locator("#navigation-alert-open").click();
    }
    await expect(page.locator("#navigation-arrival-warning")).toHaveText(
      warning,
    );
    await expect(page.locator("#navigation-arrival-warning")).toBeVisible();
    await expect(page.locator("#navigation-summary-arrival")).toHaveText(
      "Am Ziel 12:03",
    );
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("missed-arrival-target.png"),
    });
  });

  test(`departure hides repeated stop names and keeps other boarding places at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route(true);
    journey.legs[0].to = { ...c, name: "Zugang", stopId: "entrance" };
    await setup(page, true, true, {}, journey);
    await expect(page.locator("#navigation-context-detail")).toHaveText(
      "Abfahrt 12:05 · Bahnhof · Gleis 4",
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await complete(page);
    await expect(page.locator("#navigation-detail")).toHaveText("Bahnhof");
    await expect(page.locator("#navigation-context-detail")).toHaveText(
      "Abfahrt 12:05 · Gleis 4",
    );
    await page.getByRole("tab", { name: /^S1 nach/ }).click();
    await expect(page.locator("#navigation-transit-status")).toContainText(
      "Echtzeit · Stand",
    );
    await expect(
      page.locator("#navigation-section-content .detail-source"),
    ).toHaveCount(0);
  });
}

test("GPS loss removes the duplicate pause text while transit warnings remain visible", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney();
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  const boarding = journey.legs[2].transitStops![0];
  for (let i = 0; i < 2; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(
      (stop) => (window as any).navProbe.push(stop.latitude, stop.longitude),
      boarding,
    );
  }
  await page.locator("#navigation-details-toggle").click();
  await page.clock.runFor(61000);
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "Kein GPS Position geschätzt",
  );
  await expect(page.locator("#navigation-context-status")).toBeEmpty();
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 3 Halte",
  );
  await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  await page.clock.runFor(61000);
  await expect(page.locator("#navigation-context-status")).toContainText(
    "Abruf fehlgeschlagen",
  );
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 3 Halte",
  );
  await expect(page.locator("#navigation-view")).not.toContainText(
    "Stationsfortschritt pausiert",
  );
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Abruf fehlgeschlagen",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "anhand der Fahrzeiten geschätzt",
  );
  await expectMotionSettled(page.locator("#navigation-panel"));
  await page.screenshot({
    path: info.outputPath("gps-loss-transit-warning.png"),
  });
});

for (const width of [320, 390, 1280])
  test(`GPS loss estimates stations and glides the map without confirming progress at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const journey = stationJourney();
    const train = journey.legs[2];
    delete train.transitReference;
    train.transitStatus = { updatedAt: now };
    train.start = now + 300;
    train.end = now + 330;
    train.transitStops!.forEach((stop, i) => {
      stop.arrival = now + 300 + [0, 8, 20, 30][i];
      stop.departure = now + 300 + [0, 12, 22, 30][i];
      delete stop.scheduledArrival;
    });
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await page.clock.pauseAt(new Date((now + 300) * 1000));
    const boarding = train.transitStops![0];
    for (let i = 0; i < 2; i++) {
      await page.clock.runFor(1000);
      await page.evaluate(
        (point) =>
          (window as any).navProbe.push(point.latitude, point.longitude),
        boarding,
      );
    }
    const before = await savedProgress(page);
    await page.evaluate(() => {
      (window as any).navProbe.silent = true;
      (window as any).navProbe.fail(2);
    });
    const map = page.locator("#navigation-map");
    await expect(map).toHaveAttribute("data-position-source", "estimated");
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "Kein GPS Position geschätzt",
    );
    const position = () =>
      map.evaluate((el) => JSON.parse(el.dataset.position!));
    await page.clock.runFor(2100);
    const first = await position();
    await page.clock.runFor(160);
    const second = await position();
    expect(distance(first, second)).toBeGreaterThan(0.1);
    expect(distance(first, second)).toBeLessThan(10);
    // Manual camera movement pauses following while the marker keeps moving.
    await map.press("ArrowRight");
    await page.clock.runFor(400);
    await expect(map).toHaveAttribute("data-following", "false");
    const camera = await map.getAttribute("data-center");
    await page.clock.runFor(1000);
    await expect(map).toHaveAttribute("data-center", camera!);
    await page.locator("#navigation-center").click();
    await expect(map).toHaveAttribute("data-following", "true");
    const beforeHidden = await position();
    await page.evaluate(() => (window as any).navProbe.hide(true));
    await page.clock.runFor(1000);
    expect(await position()).toEqual(beforeHidden);
    await page.evaluate(() => (window as any).navProbe.hide(false));
    expect(distance(await position(), beforeHidden)).toBeLessThan(1);
    await page.clock.fastForward(8000);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Nächster Halt: Rathaus",
    );
    await expect(
      page.locator("#navigation-stations-announcement"),
    ).toContainText("Stationsstand geschätzt");
    expect(await savedProgress(page)).toEqual(before);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-stations-detail")).toContainText(
      "Voraussichtlich passiert",
    );
    await expect(page.locator("#navigation-location-status")).toContainText(
      "anhand der Fahrzeiten geschätzt",
    );
    // Even a correction back to an earlier GPS position glides from the visible point.
    const estimated = await position();
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      boarding,
    );
    await expect(map).toHaveAttribute("data-position-source", "gps");
    expect(distance(estimated, await position())).toBeLessThan(1);
    await page.clock.runFor(1000);
    const halfway = await position();
    expect(distance(halfway, boarding)).toBeGreaterThan(1);
    expect(distance(halfway, boarding)).toBeLessThan(
      distance(estimated, boarding),
    );
    await page.clock.runFor(1100);
    expect(distance(await position(), boarding)).toBeLessThan(1);
    expect(await savedProgress(page)).toEqual(before);
    // At the scheduled exit, only the presentation reaches the exit.
    await page.evaluate(() => {
      (window as any).navProbe.silent = true;
      (window as any).navProbe.fail(2);
    });
    await page.clock.fastForward(20000);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Ausstieg: Ausstieg",
    );
    await expect(page.locator("#navigation-view")).not.toContainText(
      "Hier aussteigen",
    );
    expect(await savedProgress(page)).toEqual(before);
    const badge = await page.locator("#navigation-gps-status").boundingBox();
    const controls = await page
      .locator(".navigation-map-controls")
      .boundingBox();
    expect(badge!.x + badge!.width).toBeLessThan(controls!.x);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("estimated-navigation.png"),
    });
  });

test("live trip delays correct the estimated marker and stations without changing confirmed progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const journey = stationJourney();
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.locator("#navigation-details-toggle").click();
  await page.clock.pauseAt(new Date((now + 450) * 1000));
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await page.clock.runFor(2100);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  const before = await savedProgress(page);
  const stops = journey.legs[2].transitStops!;
  const raw = (i: number, arrival: number) => ({
    name: stops[i].name,
    stopId: stops[i].stopId,
    lat: stops[i].latitude,
    lon: stops[i].longitude,
    scheduledArrival: new Date((now + 300 + i * 100) * 1000).toISOString(),
    arrival: new Date((now + arrival) * 1000).toISOString(),
  });
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({
      json: {
        legs: [
          {
            from: {
              ...raw(0, 300),
              scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              departure: new Date((now + 300) * 1000).toISOString(),
            },
            intermediateStops: [raw(1, 580), raw(2, 640)],
            to: raw(3, 700),
            realTime: true,
          },
        ],
      },
    }),
  );
  await page.clock.fastForward(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Stadtmitte",
  );
  const map = page.locator("#navigation-map");
  const position = () => map.evaluate((el) => JSON.parse(el.dataset.position!));
  const from = await position();
  await page.clock.runFor(1000);
  const middle = await position();
  await page.clock.runFor(1100);
  const corrected = await position();
  expect(distance(from, middle)).toBeGreaterThan(1);
  expect(distance(from, corrected)).toBeGreaterThan(distance(from, middle));
  expect(await savedProgress(page)).toEqual(before);
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(
    page.locator("#navigation-stations-preview [data-state=next] time"),
  ).toHaveText("12:09");
});

test("estimated navigation respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const journey = stationJourney();
  const train = journey.legs[2];
  delete train.transitReference;
  train.start = now + 300;
  train.end = now + 360;
  train.transitStops!.forEach((stop, i) => {
    stop.arrival = now + 300 + i * 20;
    delete stop.scheduledArrival;
  });
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.clock.pauseAt(new Date((now + 300) * 1000));
  await page.evaluate(() => (window as any).navProbe.fail(2));
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await page.locator("#navigation-details-toggle").click();
  await page.clock.runFor(32);
  const position = await map.getAttribute("data-position");
  const rail = page.locator("#navigation-stations-preview");
  const fill = await rail.evaluate((el) =>
    el.style.getPropertyValue("--station-progress"),
  );
  await page.clock.runFor(160);
  await expect(map).toHaveAttribute("data-position", position!);
  expect(
    await rail.evaluate((el) =>
      el.style.getPropertyValue("--station-progress"),
    ),
  ).toBe(fill);
  await page.clock.runFor(1000);
  await expect(map).not.toHaveAttribute("data-position", position!);
  expect(
    await rail.evaluate((el) =>
      el.style.getPropertyValue("--station-progress"),
    ),
  ).not.toBe(fill);
  await page.clock.fastForward(21000);
  await page.clock.runFor(1000);
  await expect(rail).toHaveAttribute("data-continuation", "true");
  expect(
    await rail.evaluate((list) => list.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await expect(rail.locator("[data-leaving]")).toHaveCount(0);
});

test("station rail uses GPS without a usable timetable and skips cancelled circles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const journey = stationJourney(),
    train = journey.legs[2];
  delete train.transitReference;
  train.transitStops![1].arrival = now - 60;
  train.transitStops![2].cancelled = true;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.clock.pauseAt(new Date((now + 300) * 1000));
  await page.evaluate(
    (point) => (window as any).navProbe.push(point.latitude, point.longitude),
    c,
  );
  await page.clock.runFor(2100);
  const middle = {
    latitude: (c.latitude + train.transitStops![1].latitude) / 2,
    longitude: (c.longitude + train.transitStops![1].longitude) / 2,
  };
  await page.evaluate(
    (point) => (window as any).navProbe.push(point.latitude, point.longitude),
    middle,
  );
  await page.clock.runFor(2100);
  expect(
    (await stationRail(page, "#navigation-stations-detail")).progress,
  ).toBeCloseTo(0.5, 2);
  await expect(
    page.locator("#navigation-stations-detail [data-state=cancelled]"),
  ).toHaveAttribute("data-reached", "false");
  await page.evaluate(() => (window as any).navProbe.fail(2));
  const frozen = (await stationRail(page, "#navigation-stations-detail"))
    .filled;
  await page.clock.fastForward(10000);
  expect((await stationRail(page, "#navigation-stations-detail")).filled).toBe(
    frozen,
  );
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
  await page.evaluate(() => (window as any).navProbe.fail(2));
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-position-source",
    "last-known",
  );
  await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
});

async function expectTabVisible(
  page: Page,
  selector = '[aria-selected="true"]',
) {
  await expect
    .poll(() =>
      page.locator("#navigation-phases").evaluate((strip, selector) => {
        const bounds = strip.getBoundingClientRect();
        const selected = strip.querySelector(selector)!.getBoundingClientRect();
        return (
          selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1
        );
      }, selector),
    )
    .toBe(true);
}

async function expectCurrentTabAligned(page: Page) {
  await expectTabVisible(page, '[aria-current="step"]');
  await expect
    .poll(() =>
      page.locator("#navigation-phases").evaluate((strip) => {
        const current = strip.querySelector('[aria-current="step"]')!;
        const gap =
          current.getBoundingClientRect().left -
          strip.getBoundingClientRect().left;
        const atEnd =
          strip.scrollWidth - strip.clientWidth - strip.scrollLeft <= 1;
        return (
          Math.abs(gap - 24) <= 1 ||
          atEnd ||
          (current === strip.firstElementChild && strip.scrollLeft <= 1)
        );
      }),
    )
    .toBe(true);
}

for (const width of [320, 390, 1280])
  test(`section tabs preview details independently of live navigation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    const tabs = page.getByRole("tab");
    const fold = tabs.nth(1),
      train = tabs.nth(2),
      unfold = tabs.nth(3),
      lastBike = tabs.nth(6);
    await expect(tabs).toHaveCount(7);
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await expect(tabs.nth(0)).toHaveAttribute("aria-current", "step");
    const currentBorder = await tabs
      .nth(0)
      .locator(".navigation-phase-symbol")
      .evaluate((symbol) => getComputedStyle(symbol).borderTopColor);
    const instruction = await page
      .locator("#navigation-instruction")
      .innerText();
    const spoken = await page.evaluate(() => [
      ...(window as any).navProbe.spoken,
    ]);
    const progress = await savedProgress(page);
    await train.click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveAttribute("aria-current", "step");
    await expect(tabs.nth(0).locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(train.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-stage")).toHaveText(
      "S1 · Abschnitt 3 von 7",
    );
    const detail = page.locator("#navigation-section-content");
    await expect(page.locator("#navigation-transit-status")).toContainText(
      "Echtzeit",
    );
    await expect(detail.locator(".detail-source")).toHaveCount(0);
    await expect(page.locator("#navigation-stage")).toHaveClass("sr-only");
    await expect(
      detail.locator('[data-kind="fold"], [data-kind="unfold"]'),
    ).toHaveCount(0);
    await expect(detail).toContainText("Richtung Altstadt");
    await expect(detail).toContainText("Bahnhof");
    await expect(detail).toContainText("Ausstieg");
    await expect(detail).toContainText("Gleis / Steig 4");
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await page
      .locator("#navigation-complete")
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#navigation-confirm")).not.toBeVisible();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
    expect(await savedProgress(page)).toEqual(progress);
    expect(await page.evaluate(() => (window as any).navProbe.spoken)).toEqual(
      spoken,
    );
    await train.click();
    await expect(page.getByRole("tabpanel")).toBeVisible();

    // Actual folding gets its own current marker while the train preview stays open.
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.002));
    await page.clock.runFor(12000);
    await page.evaluate(() => (window as any).navProbe.push(48.002, 11.002, 0));
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await expect(fold).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expect(fold.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(tabs.nth(0).locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await fold.click();
    await expect(detail).toContainText("Falten");
    await expect(detail).toContainText("Bahnhof");
    await expect(detail.locator('[data-kind="transit"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Rad gefaltet",
    );
    await complete(page);
    await expect(train).toHaveAttribute("aria-current", "step");
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expectCurrentTabAligned(page);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Ausgestiegen",
    );

    await lastBike.click();
    await expect(detail).toContainText("Rad bis Ziel");
    await expect(detail).toContainText("169 m");
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await page.evaluate(() =>
      setInterval(() => (window as any).navProbe.push(48.003, 11.004), 10000),
    );
    // Exercise each periodic GPS sample without rendering ten minutes of frames.
    for (let i = 0; i < 60; i++) await page.clock.fastForward(10000);
    await expect(unfold).toHaveAttribute("aria-current", "step");
    await expect(lastBike).toHaveAttribute("aria-selected", "true");
    await expect(lastBike).toBeFocused();
    await expectCurrentTabAligned(page);
    await expect(unfold.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(lastBike.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(detail).toContainText("Rad bis Ziel");
    if (width < 900) {
      await page.locator("#navigation-details-toggle").click();
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(unfold).toHaveAttribute("aria-selected", "true");
      await expect(lastBike).toHaveAttribute("aria-selected", "false");
      await expectTabVisible(page);
      await expectCurrentTabAligned(page);
    }
    await unfold.click();
    await expect(unfold).toBeFocused();
    await expect(detail).toContainText("Entfalten");
    await expect(detail.locator('[data-kind="walk"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Rad entfaltet",
    );
    await tabs.nth(4).click();
    await expect(detail).toContainText("Zu Fuß bis Café");
    await expect(detail.locator('[data-kind="unfold"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toBeHidden();
  });

for (const width of [320, 390])
  test(`section tabs align current progress on resume and stop at the natural end at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route(true);
    journey.legs = journey.legs.slice(0, 5);
    journey.legs[4].kind = "bike";
    journey.destination = e;
    journey.arrival = journey.legs.at(-1)!.end;
    await setup(page, true, true, {}, journey);
    const tabs = page.getByRole("tab");
    const strip = page.locator("#navigation-phases");
    await expectCurrentTabAligned(page);
    expect(await strip.evaluate((element) => element.scrollLeft)).toBe(0);
    await complete(page);
    await complete(page);
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);

    await tabs.last().click();
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await page.locator("#navigation-details-toggle").click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expectCurrentTabAligned(page);

    await expect.poll(() => savedProgress(page)).toMatchObject({ legIndex: 2 });
    await page.reload();
    await page.locator("#navigation-resume").click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await complete(page);
    await complete(page);
    await expect(tabs.last()).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await expect
      .poll(() =>
        strip.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().right -
              element.lastElementChild!.getBoundingClientRect().right -
              parseFloat(getComputedStyle(element).paddingRight),
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
  });

test("section tabs support keyboard navigation, collapsed summary order and resume", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page, true);
  const tabs = page.getByRole("tab");
  await expectMotionSettled(page.locator("#navigation-panel"));
  await expect(page.locator("#navigation-details")).toBeHidden();
  const summary = await page.locator("#navigation-summary").boundingBox();
  const strip = await page.getByRole("tablist").boundingBox();
  expect(strip!.y).toBeGreaterThanOrEqual(summary!.y + summary!.height);
  const tabSizes = await tabs.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }),
  );
  expect(
    tabSizes.every((bounds) => bounds.width >= 48 && bounds.height >= 48),
    JSON.stringify(tabSizes),
  ).toBe(true);
  await expect(tabs.nth(0)).toHaveAttribute("tabindex", "0");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    (await tabs.nth(1).getAttribute("id")) as string,
  );
  await page.keyboard.press("End");
  await expect(tabs.nth(6)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(6)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await expect(tabs.nth(6)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toBeFocused();
  await expectTabVisible(page);
  await page.keyboard.press("Space");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tabpanel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-details-toggle")).toBeFocused();

  await tabs.nth(1).click();
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await page.locator("#navigation-resume").click();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-details")).toBeHidden();
});

test("section tabs present folding and unfolding as five peer sections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route(true);
  journey.legs = journey.legs.slice(0, 5);
  journey.legs[4].kind = "bike";
  journey.destination = e;
  journey.arrival = journey.legs.at(-1)!.end;
  await setup(page, true, true, {}, journey);
  const tabs = page.getByRole("tab");
  const detail = page.locator("#navigation-section-content");
  await expect(tabs).toHaveCount(5);
  await expect(tabs).toHaveText(["Rad", "Falten", "S1", "Entfalten", "Rad"]);
  await expect(
    tabs.locator('.navigation-phase-symbol[aria-hidden="true"]'),
  ).toHaveCount(5);
  await expect(tabs.nth(0).locator('[data-icon="bike"] svg')).toBeVisible();
  await expect(tabs.nth(1).locator('[data-icon="fold"] svg')).toBeVisible();
  await expect(tabs.nth(2).locator('[data-icon="transit"] svg')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("five-tabs-collapsed.png"),
  });
  await tabs.nth(1).click();
  await expect(detail.locator('[data-kind="fold"]')).toBeVisible();
  await expect(detail.locator('[data-kind="transit"]')).toHaveCount(0);
  await expect(page.locator("#navigation-stage")).toHaveText(
    "Falten · Abschnitt 2 von 5",
  );
  await expect(page.locator("#navigation-complete")).toBeHidden();
  await tabs.nth(2).click();
  await expect(
    detail.locator('[data-kind="fold"], [data-kind="unfold"]'),
  ).toHaveCount(0);
  await tabs.nth(3).click();
  await expect(tabs.nth(3).locator('[data-icon="unfold"] svg')).toBeVisible();
  await expect(detail.locator('[data-kind="unfold"]')).toBeVisible();
  await expect(detail.locator('[data-kind="bike"]')).toHaveCount(0);
  await expect(page.locator("#navigation-stage")).toHaveText(
    "Entfalten · Abschnitt 4 von 5",
  );
  await tabs.nth(4).click();
  await expect(detail.locator('[data-kind="unfold"]')).toHaveCount(0);
  await expect(detail).toContainText("Rad bis Café");
});

test("section tabs keep separate train details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route(true);
  const second = {
    ...structuredClone(journey.legs[2]),
    from: d,
    to: f,
    line: "U3",
    headsign: "Fürstenried West",
    platform: "1",
    arrivalPlatform: "8",
    realtime: false,
    start: now + 900,
    end: now + 1020,
    transitReference: undefined,
  };
  journey.legs = [
    ...journey.legs.slice(0, 3),
    second,
    ...journey.legs
      .slice(3)
      .map((leg) => ({ ...leg, start: leg.start + 420, end: leg.end + 420 })),
  ];
  journey.arrival = journey.legs.at(-1)!.end;
  await setup(page, true, true, {}, journey);
  await page.getByRole("tab", { name: /^U3 nach/ }).click();
  const details = page.locator("#navigation-section-content");
  await expect(details).toContainText("Richtung Fürstenried West");
  await expect(details).toContainText("Gleis / Steig 8");
  await expect(page.locator("#navigation-transit-status")).toContainText("U3");
  await expect(details).not.toContainText("Altstadt");
  await page.getByRole("tab", { name: /^S1 nach/ }).click();
  await expect(details).toContainText("Richtung Altstadt");
  await expect(details).not.toContainText("Fürstenried West");
});

for (const mode of ["BUS", "COACH"])
  test(`section tabs retain the line label alongside the bus symbol for ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const journey = route(true);
    journey.legs[2].mode = mode;
    journey.legs[2].line = mode === "BUS" ? "52" : "X35";
    await setup(page, true, true, {}, journey);
    const tab = page.getByRole("tab", {
      name: new RegExp(`^${journey.legs[2].line} nach`),
    });
    await expect(tab).toHaveText(journey.legs[2].line!);
    await expect(tab.locator('[data-icon="bus"] svg')).toBeVisible();
    await tab.click();
    await expect(page.locator("#navigation-section-content")).toContainText(
      journey.legs[2].line!,
    );
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`section tabs retain focus and scrolling through live updates (${colorScheme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme });
    await setup(page, true);
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "24px"),
    );
    const current = page.getByRole("tab", { name: /^Rad nach Bahnhof/ });
    const train = page.getByRole("tab", { name: /^S1 nach/ });
    const activeColor = await current.evaluate(
      (tab) => getComputedStyle(tab).color,
    );
    const inactiveColor = await train.evaluate(
      (tab) => getComputedStyle(tab).color,
    );
    expect(activeColor).not.toBe(inactiveColor);
    await train.click();
    await expect(train).toBeFocused();
    await expect(train).toHaveCSS("color", activeColor);
    await expect(train).toHaveCSS("font-weight", "650");
    await expect(train).toHaveCSS("border-bottom-color", activeColor);
    await expect(current).toHaveAttribute("aria-current", "step");
    await expect(current).toHaveCSS("color", inactiveColor);
    await expect(current).toHaveCSS("font-weight", "500");
    await expect(current).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    const currentSymbol = current.locator(".navigation-phase-symbol");
    const brand = await currentSymbol.evaluate((symbol) => {
      const style = getComputedStyle(symbol);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(brand.foreground).not.toBe(brand.background);
    await expect(train.locator(".navigation-phase-symbol")).not.toHaveCSS(
      "background-color",
      brand.background,
    );
    await expect(train.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-end")).toBeVisible();
    await expectMobileCredit(page);
    const scroll = await page.evaluate(() => {
      const details = document.getElementById("navigation-details")!;
      details.scrollTop = 45;
      return {
        details: details.scrollTop,
        tabs: document.getElementById("navigation-phases")!.scrollLeft,
      };
    });
    await page.clock.runFor(61000);
    await expect(train).toBeFocused();
    await expect(train).toHaveAttribute("aria-selected", "true");
    expect(
      await page.locator("#navigation-details").evaluate((e) => e.scrollTop),
    ).toBe(scroll.details);
    expect(
      await page.locator("#navigation-phases").evaluate((e) => e.scrollLeft),
    ).toBe(scroll.tabs);
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
    await expect(train).toBeFocused();
    await expect(page.locator("#navigation-section-content")).toContainText(
      "S1",
    );
    await page.screenshot({
      path: test.info().outputPath(`section-tabs-${colorScheme}.png`),
    });
  });

async function expectMobileCredit(page: Page) {
  await expect
    .poll(() =>
      page.locator(".navigation-credit").evaluate((credit) => {
        const bounds = credit.getBoundingClientRect();
        const panel = document
          .getElementById("navigation-panel")!
          .getBoundingClientRect();
        const controls = document
          .querySelector(".navigation-map-controls")!
          .getBoundingClientRect();
        const overlapsControls =
          bounds.top < controls.bottom && bounds.bottom > controls.top;
        return {
          gapWithinTolerance: Math.abs(panel.top - bounds.bottom - 6) <= 1,
          rightAligned:
            Math.abs(
              bounds.right -
                (overlapsControls ? controls.left - 8 : panel.right),
            ) <= 1,
          inViewport:
            bounds.top >= 0 &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight,
        };
      }),
    )
    .toEqual({
      gapWithinTolerance: true,
      rightAligned: true,
      inViewport: true,
    });
  for (const link of await page.locator(".navigation-credit a").all())
    await link.click({ trial: true });
}

test("System appearance changes navigation panels without resetting progress", async ({
  page,
}, info) => {
  const mapStyles: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://tiles.openfreemap.org/styles/"))
      mapStyles.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await setup(page);
  await expect.poll(() => mapStyles.length).toBeGreaterThan(0);
  expect(mapStyles.every((url) => url.endsWith("/positron"))).toBe(true);
  const initialStyles = [...mapStyles];
  const instruction = await page.locator("#navigation-instruction").innerText();
  const phase = await page.locator(".navigation-phase.current").innerText();
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
  await page.screenshot({ path: info.outputPath("navigation-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(23, 26, 28)",
  );
  await expect(page.locator("#navigation-map")).toHaveCSS(
    "background-color",
    "rgb(238, 240, 235)",
  );
  expect(mapStyles).toEqual(initialStyles);
  await expect(page.locator("#navigation-instruction")).toHaveText(instruction);
  await expect(page.locator(".navigation-phase.current")).toHaveText(phase);
  await page.screenshot({ path: info.outputPath("navigation-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("#navigation-instruction")).toHaveText(instruction);
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
});

async function expectNavigationBasemap(page: Page) {
  await expect
    .poll(() =>
      page.locator("#navigation-map canvas").evaluateAll((canvases) =>
        canvases
          .filter((canvas) => canvas.getBoundingClientRect().width > 0)
          .map((canvas) => {
            const context = (canvas as HTMLCanvasElement).getContext("2d")!;
            return [...context.getImageData(16, 16, 1, 1).data];
          }),
      ),
    )
    .toContainEqual([12, 150, 90, 255]);
}

test("navigation keeps loaded basemap pixels through connection changes and GPS updates", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await mockRasterBasemap(page);
  await page.evaluate(async () => {
    const { mapStyle } = await import("/src/map-style.ts");
    mapStyle.set("liberty");
  });
  await page.clock.runFor(1000);
  await expectNavigationBasemap(page);
  const instruction = await page.locator("#navigation-instruction").innerText();
  for (const offline of [true, false, true, false]) {
    await context.setOffline(offline);
    await page.evaluate(() => (window as any).navProbe.push(48, 11));
    await page.clock.runFor(1000);
    await expectNavigationBasemap(page);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
  }
});

test("navigation keeps a basemap that finishes loading after going offline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await mockRasterBasemap(page);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "https://tiles.openfreemap.org/styles/liberty",
    async (route) => {
      await ready;
      await route.fallback();
    },
  );
  const requested = page.waitForRequest(
    "https://tiles.openfreemap.org/styles/liberty",
  );
  await page.evaluate(async () => {
    const { mapStyle } = await import("/src/map-style.ts");
    mapStyle.set("liberty");
  });
  await requested;
  // Keep fixture responses reachable to simulate a style finishing from an in-flight request.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  release();
  await page.clock.runFor(1000);
  await expectNavigationBasemap(page);
  await expect(page.locator("#navigation-network-status")).toContainText(
    "Offline",
  );
});

test("map style selection keeps manual navigation camera and progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.route("https://tiles.openfreemap.org/styles/**", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#eef0eb" },
          },
        ],
      },
    }),
  );
  await page.locator("#navigation-map").press("ArrowRight");
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
  );
  await page.clock.runFor(1000);
  const camera = await page.locator("#navigation-map").evaluate((element) => ({
    center: element.dataset.center,
    zoom: element.dataset.zoom,
    bearing: element.dataset.bearing,
  }));
  const instruction = await page.locator("#navigation-instruction").innerText();
  await page
    .getByRole("button", { name: "Kartenstil wählen", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Karte anpassen",
    exact: true,
  });
  await expect(panel).toHaveCSS("left", "0px");
  await expect(panel).toHaveCSS("bottom", "0px");
  await expect(panel).toHaveCSS("width", "390px");
  for (const [name, value] of [
    ["Straßenkarte", "liberty"],
    ["Dunkel", "dark"],
    ["Positron", "positron"],
  ]) {
    await panel.getByRole("radio", { name, exact: true }).check();
    await expect(panel).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-map-style", value);
    await expect(page.locator("#navigation-map")).toHaveAttribute(
      "data-following",
      "false",
    );
    expect(
      await page.locator("#navigation-map").evaluate((element) => ({
        center: element.dataset.center,
        zoom: element.dataset.zoom,
        bearing: element.dataset.bearing,
      })),
    ).toEqual(camera);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
  }
  await panel
    .getByRole("button", { name: "Kartenstile schließen", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await page
    .getByRole("button", { name: "Standort folgen", exact: true })
    .click();
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "true",
  );
});

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
    await expect(page.locator(".navigation-panel")).toHaveCSS("bottom", "12px");
    await expectMobileCredit(page);
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
    // Departure and platform stay visible alongside the arrival time.
    expect(bounds.panelHeight).toBeLessThanOrEqual(180);
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
    await expectMobileCredit(page);
    await page.locator("#navigation-details-toggle").press("Escape");
    await expect(page.locator("#navigation-details")).toBeHidden();
    // Measure the pointer path after the deliberate sheet transition settles.
    await expect
      .poll(() =>
        page
          .locator("#navigation-panel")
          .evaluate((panel) => panel.getAnimations().length),
      )
      .toBe(0);
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
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "GPS ungenau",
    );
    await expect(page.locator("#navigation-alert")).toBeHidden();
    await expectMobileCredit(page);
    await page.screenshot({
      path: test.info().outputPath("gps-status-credits.png"),
    });
    await expect(page.locator("#navigation-details")).toBeHidden();
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-location-status")).toBeVisible();
    await expectMobileCredit(page);
    await page.screenshot({
      path: test.info().outputPath("expanded-credits.png"),
    });
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
      expect(bounds.center).toBeCloseTo(width / 2, 0);
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
      await expect(page.locator("#navigation-locate")).toBeVisible();
      await page.evaluate(() => (window as any).navProbe.push(48, 11));
      await expect(status).toBeHidden();
      await expect(page.locator("#navigation-location-status")).toBeEmpty();
      await expect(page.locator("#navigation-location")).toBeHidden();
      await expect(page.locator("#navigation-alert")).toBeHidden();
    });

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [320, 390, 1280])
    test(`GPS badge separates the estimated position on brand yellow (${width}px, ${colorScheme})`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      const journey = stationJourney();
      delete journey.legs[2].transitReference;
      await setup(page, true, true, {}, journey);
      await complete(page);
      await complete(page);
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      const status = page.locator("#navigation-gps-status");
      const primary = page.locator("#navigation-gps-primary");
      const secondary = page.locator("#navigation-gps-estimate");
      await page.evaluate(
        (point) =>
          (window as any).navProbe.push(
            point.latitude,
            point.longitude,
            90,
            500,
          ),
        c,
      );
      await expect(status).toHaveText("GPS ungenau Position geschätzt");
      await expect(primary).toHaveText("GPS ungenau");
      await expect(primary).toHaveCSS("font-size", "14px");
      await expect(primary).toHaveCSS("font-weight", "600");
      await expect(primary).toHaveCSS("color", "rgb(23, 26, 28)");
      await expect(secondary).toHaveText("Position geschätzt");
      await expect(secondary).toHaveCSS("font-size", "12px");
      await expect(secondary).toHaveCSS("font-weight", "400");
      await expect(secondary).toHaveCSS("color", "rgb(23, 26, 28)");
      await expect(status).toHaveCSS("background-color", "rgb(255, 212, 59)");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toHaveAttribute("aria-atomic", "true");
      const checkBounds = async () => {
        const bounds = await status.evaluate((element) => {
          const badge = element.getBoundingClientRect();
          const main = element.querySelector("strong")!.getBoundingClientRect();
          const detail = element.querySelector("span")!.getBoundingClientRect();
          const controls = document
            .querySelector(".navigation-map-controls")!
            .getBoundingClientRect();
          return {
            primaryBottom: main.bottom,
            secondaryTop: detail.top,
            right: badge.right,
            controlsLeft: controls.left,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(bounds.secondaryTop).toBeGreaterThan(bounds.primaryBottom);
        expect(bounds.right).toBeLessThan(bounds.controlsLeft);
        expect(bounds.overflow).toBe(false);
      };
      await checkBounds();
      await page.evaluate(() => {
        (window as any).navProbe.silent = true;
        (window as any).navProbe.fail(2);
      });
      await expect(status).toHaveText("Kein GPS Position geschätzt");
      await page.evaluate(() => {
        (window as any).gpsBadgeChanges = 0;
        new MutationObserver((records) => {
          (window as any).gpsBadgeChanges += records.length;
        }).observe(document.getElementById("navigation-gps-status")!, {
          childList: true,
          characterData: true,
          attributes: true,
          subtree: true,
        });
      });
      await page.clock.runFor(3000);
      expect(await page.evaluate(() => (window as any).gpsBadgeChanges)).toBe(
        0,
      );
      if (width === 390)
        await page.screenshot({
          path: info.outputPath(`gps-estimate-${colorScheme}.png`),
        });
      if (width === 320) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await checkBounds();
      }
      // A street/preparation section keeps the warning, without an estimated train position.
      await complete(page);
      await expect(status).toHaveText("Kein GPS");
      await expect(secondary).toBeHidden();
      await expect(secondary).toBeEmpty();
      await expect(status).toHaveCSS("background-color", "rgb(255, 212, 59)");
      await page.evaluate(
        (point) =>
          (window as any).navProbe.push(point.latitude, point.longitude),
        d,
      );
      await expect(status).toBeHidden();
      await expect(primary).toBeEmpty();
    });

test("a location timeout stays in details and clears when the watch recovers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(() => {
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

async function openNavigationCredit(page: Page, index = 1) {
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    // Model Safari's overlay without navigating the test page away.
    document.addEventListener("click", (event) => {
      if ((event.target as Element).closest(".navigation-credit a"))
        event.preventDefault();
    });
  });
  await page.locator(".navigation-credit a").nth(index).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).navProbe.active))
    .toBe(0);
  await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
}

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

test("location retry recovers a credit overlay without return events and replaces each silent watch", async ({
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
  await expect(retry).toBeEnabled();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "dauert zu lange",
  );
  const started = await page.evaluate(() => (window as any).navProbe.started);
  await retry.click();
  await expect(retry).toBeDisabled();
  expect(await page.evaluate(() => (window as any).navProbe.started)).toBe(
    started + 1,
  );
  expect(await page.evaluate(() => (window as any).navProbe.active)).toBe(1);
  await page.evaluate(() => (window as any).navProbe.push(48, 11));
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

test("following camera uses final panel geometry during the sheet animation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await setup(page, true);
  const panel = page.locator("#navigation-panel");
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-following", "true");
  await expectMotionSettled(panel);
  const collapsedCenter = await map.getAttribute("data-center");
  const started = await page
    .locator("#navigation-details-toggle")
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      const panel = document.getElementById("navigation-panel")!;
      const animations = panel.getAnimations();
      for (const animation of animations) animation.pause();
      return {
        count: animations.length,
        gap: Math.abs(
          panel.getBoundingClientRect().top -
            (panel.parentElement!.getBoundingClientRect().top +
              panel.offsetTop),
        ),
      };
    });
  expect(started.count).toBeGreaterThan(0);
  expect(started.gap).toBeGreaterThan(20);
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const screen = element.parentElement!;
        const map = document.getElementById("navigation-map")!;
        const finalTop =
          screen.getBoundingClientRect().top +
          element.offsetTop -
          map.getBoundingClientRect().top;
        return Math.abs(
          parseFloat(screen.style.getPropertyValue("--navigation-panel-top")) -
            finalTop,
        );
      }),
    )
    .toBeLessThan(1);
  await expect(map).not.toHaveAttribute("data-center", collapsedCenter!);
  const expandedCenter = await map.getAttribute("data-center");
  await panel.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
  });
  await expectMotionSettled(panel);
  await expect(map).toHaveAttribute("data-center", expandedCenter!);
  await expect(map).toHaveAttribute("data-following", "true");
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
  await expectMobileCredit(page);
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

test("navigation credits move between mobile panel and desktop bottom right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const links = page.locator(".navigation-credit a");
  await expect(links).toHaveCount(4);
  await expect(links.nth(0)).toHaveAttribute(
    "href",
    "https://openfreemap.org/",
  );
  await expect(links.nth(1)).toHaveAttribute(
    "href",
    "https://openmaptiles.org/",
  );
  await expect(links.nth(2)).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  await expect(links.nth(3)).toHaveAttribute(
    "href",
    "https://transitous.org/sources/",
  );
  await expectMobileCredit(page);
  await page.locator("#navigation-map").press("ArrowRight");
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
  );
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#navigation-details")).toBeVisible();
  const credit = page.locator(".navigation-credit");
  await expect(credit).toHaveCSS("bottom", "5px");
  await expect(credit).toHaveCSS("right", "12px");
  await expect(credit).toHaveCSS("transform", "none");
  await expect(credit).toBeInViewport();
  for (const link of await links.all()) await link.click({ trial: true });
  await expect(page.locator(".navigation-panel")).toHaveCSS("bottom", "28px");
  await page.screenshot({
    path: test.info().outputPath("desktop-credits.png"),
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expectMobileCredit(page);
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
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
    await expectMotionSettled(dialog);
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
    await expect(page.locator("#navigation-start")).toBeFocused();
    await expect(page.locator("#navigation-start")).toHaveText("Los");
    await expect(page.locator("#saved-notice")).toBeHidden();
  });

for (const failure of ["offline", "storage"] as const)
  test(`ending navigation retains Los and the selected route despite ${failure}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await expect.poll(() => savedActive(page)).toBe(true);
    let searches = 0;
    page.on("request", (r) => {
      if (r.url().includes("/v6/plan")) searches++;
    });
    if (failure === "offline") await context.setOffline(true);
    else
      await page.evaluate(async () => {
        const path = "/src/navigation-store.ts";
        const { NavigationStore } = await import(path);
        NavigationStore.prototype.clear = async () => {
          throw new Error("Storage unavailable");
        };
      });
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("#navigation-start")).toBeFocused();
    await expect(page.locator("#navigation-start")).toBeEnabled();
    await expect(page.locator("#navigation-start")).toHaveText("Los");
    await expect(page.locator("#saved-notice")).toBeHidden();
    await expect(page.locator("#result-stand")).toContainText(
      "Stand: 6. Okt., 12:00",
    );
    if (failure === "storage")
      await expect(page.locator("#toast")).toContainText(
        "Gespeicherter Zustand konnte nicht gelöscht werden",
      );
    else {
      await expect.poll(() => savedActive(page)).toBe(false);
      await page.locator("#navigation-start").click();
      await expect(page.locator("#navigation-instruction")).toHaveText(
        "Links abbiegen auf Zweite Straße",
      );
    }
    expect(searches).toBe(0);
  });

test("ending navigation keeps updated transit predictions without an archive warning", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({
      json: {
        legs: [
          {
            from: {
              stopId: "A",
              scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              departure: new Date((now + 360) * 1000).toISOString(),
            },
            to: {
              stopId: "D",
              scheduledArrival: new Date((now + 600) * 1000).toISOString(),
              arrival: new Date((now + 660) * 1000).toISOString(),
            },
            realTime: true,
          },
        ],
      },
    }),
  );
  await startSelected(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-start")).toBeFocused();
  await expect(
    page.locator("#journey-detail .detail-delay").first(),
  ).toContainText("12:06 · +1 min");
  await expect(page.locator("#saved-notice")).toBeHidden();
});

test("ending a cancelled connection offers explicit recovery instead of an archive replan", async ({
  page,
}) => {
  await setup(page, true);
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
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  await page.clock.runFor(60000);
  await expect(page.locator("#navigation-disruption")).toContainText(
    "fällt aus",
  );
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-search-now")).toBeFocused();
  await expect(page.locator("#navigation-start")).toBeDisabled();
  await expect(page.locator("#navigation-search-now")).toHaveText(
    "Ab jetzt suchen",
  );
  await expect(page.locator("#saved-notice")).toBeHidden();
  await expect(page.locator("#replan-saved")).toBeHidden();
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
  await expectMotionSettled(dialog);
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
  await expect(page.locator("#navigation-transit-status")).toBeEmpty();
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung Altstadt",
  );
  await expect(page.locator("#navigation-detail")).toContainText("Gleis 4");
  await expect(page.locator("#navigation-transit-status")).toContainText(
    "Echtzeit",
  );
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
    "Nach Ziel",
  );
  expect(
    await page.evaluate(() => (window as any).navProbe.spoken as string[]),
  ).toContain("Mit dem Rad nach Ziel");
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
  await expect(page.locator("#navigation-start")).toBeFocused();
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await page.locator("#tab-route").click();
  await startSelected(page);
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
  await expect(page.locator("#navigation-start-retry")).toBeVisible();
  await page.locator("#navigation-start-retry").click();
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
  await expect(page.locator("#destination")).toHaveValue("Ziel");
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
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  const params = new URL((await planned).url()).searchParams;
  expect(params.get("cyclingSpeed")).toBe(
    (defaults.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
  );
});

async function startSelected(page: Page) {
  if (!(await page.locator(".panel-actions #navigation-start").isVisible()))
    await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
}

test("arrival deadline and selected train survive a late bike departure without a new route search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  const deadline = route(true).arrival;
  await setup(page, true, false, { timing: "arrive", time: deadline });
  let searches = 0;
  await page.route("**/api/v6/plan?*", async (request) => {
    searches++;
    await request.fulfill({ json: { direct: [], itineraries: [] } });
  });
  await page.clock.runFor(210000);
  await startSelected(page);
  await expect(page.locator("#navigation-view")).toBeVisible();
  await expect(page.locator("#navigation-alert-summary")).toContainText(
    "Anschluss an S1",
  );
  await expect(page.locator("#navigation-alert-summary")).toContainText(
    "gefährdet",
  );
  expect(searches).toBe(0);
  await expect.poll(() => savedActive(page)).toBe(true);
  const saved = await page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    return new NavigationStore().read();
  });
  expect(saved?.request.timing).toBe("arrive");
  expect(saved?.request.time).toBe(deadline);
  expect(
    saved?.journey.legs.find((leg) => leg.kind === "transit")?.transitReference
      ?.tripId,
  ).toBe("train-1");
  await page.screenshot({
    path: test.info().outputPath("connection-at-risk.png"),
  });
});

for (const problem of ["departed", "cancelled"] as const)
  test(`a ${problem} selection stays visible until a new search is explicitly requested`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setup(page, true, false, {
      timing: "arrive",
      time: route(true).arrival,
    });
    if (problem === "departed") await page.clock.runFor(310000);
    else
      await page.route("**/api/v6/trip?*", (r) =>
        r.fulfill({
          json: {
            legs: [
              {
                from: {
                  stopId: "A",
                  scheduledDeparture: new Date(
                    (now + 300) * 1000,
                  ).toISOString(),
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
    const searched: URL[] = [];
    await page.route("**/api/v6/plan?*", async (request) => {
      searched.push(new URL(request.request().url()));
      await request.fulfill({ json: { direct: [], itineraries: [] } });
    });
    await startSelected(page);
    await expect(page.locator("#navigation-start-notice")).toContainText(
      problem === "departed" ? "liegt zurück" : "fällt aus",
    );
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#navigation-search-now")).toBeVisible();
    expect(searched).toHaveLength(0);
    expect(await savedActive(page)).toBe(false);
    await expect(page.locator("#navigation-view-connection")).toHaveCount(0);
    await expect(page.locator("#panel-details")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`connection-${problem}.png`),
    });
    await page.context().setOffline(true);
    await expect(page.locator("#navigation-search-now")).toBeDisabled();
    await expect(page.locator("#navigation-start-notice")).toContainText(
      "Internet",
    );
    await page.context().setOffline(false);
    await page.locator("#navigation-search-now").click();
    await expect.poll(() => searched.length).toBeGreaterThan(0);
    expect(
      searched.every((url) => url.searchParams.get("arriveBy") === "false"),
    ).toBe(true);
    expect(
      searched[0].searchParams.get("fromPlace")!.split(",").map(Number),
    ).toEqual([48, 11]);
    expect(
      searched[0].searchParams.get("toPlace")!.split(",").map(Number),
    ).toEqual([e.latitude, e.longitude]);
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "list",
    );
  });

test("missing trip data starts the same route with uncertainty instead of replacing it", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  let searched = false;
  await page.route("**/api/v6/plan?*", async (r) => {
    searched = true;
    await r.fulfill({ json: { direct: [], itineraries: [] } });
  });
  await startSelected(page);
  await expect(page.locator("#navigation-view")).toBeVisible();
  await expect(page.locator("#navigation-alert-summary")).toContainText(
    "Erreichbarkeit unklar",
  );
  expect(searched).toBe(false);
});

test("departure summary follows live times, expiry and cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  let cancelled = false;
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ json: { itineraries: [], direct: [] } }),
  );
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({
      json: {
        legs: [
          {
            from: {
              stopId: "A",
              scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              departure: new Date((now + 150) * 1000).toISOString(),
            },
            to: {
              stopId: "D",
              scheduledArrival: new Date((now + 600) * 1000).toISOString(),
              arrival: new Date((now + 600) * 1000).toISOString(),
            },
            realTime: true,
            cancelled,
          },
        ],
      },
    }),
  );
  await page.clock.runFor(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · in 2 Min.",
  );
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Abfahrt 12:02",
  );
  await page.clock.runFor(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · in <1 Min.",
  );
  await page.clock.runFor(30000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · Abfahrtszeit überschritten",
  );
  cancelled = true;
  await page.clock.runFor(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · Fahrt fällt aus",
  );
});

test("missing station data stays explicit and departure context clears after the last train", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await complete(page);
  await complete(page);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Stationsdaten nicht verfügbar",
  );
  await expect(page.locator("#navigation-context-detail")).not.toContainText(
    "Halte",
  );
  await expect(page.locator("#navigation-stations-detail")).toBeHidden();
  await complete(page);
  await expect(page.locator("#navigation-context")).toBeHidden();
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-summary-label")).toBeVisible();
  await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-summary-arrival")).toContainText(
    "Am Ziel",
  );
});

test("editing during a delayed start check prevents late navigation activation", async ({
  page,
}) => {
  await setup(page, true, false);
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
  await startSelected(page);
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "Fahrtdaten werden geprüft",
  );
  await expect(page.locator("#navigation-view")).toBeHidden();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#route-editor")).toBeVisible();
  release();
  await page.clock.runFor(2000);
  await expect(page.locator("#navigation-view")).toBeHidden();
  expect(await savedActive(page)).toBe(false);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#panel-details")).toBeVisible();
});
