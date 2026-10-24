import { openCachedJourney } from "./assertions";
import { expect, type Page } from "@playwright/test";
import {
  defaults,
  type Journey,
  type Leg,
  type Place,
  type RouteRequest,
} from "../../src/model";
import { distance } from "../../src/geometry";
import { openStorageSeed } from "./app-fixture";
export const now = Date.parse("2026-10-06T10:00:00Z") / 1000;
export const a: Place = {
  name: "Start",
  detail: "",
  latitude: 48,
  longitude: 11,
};
export const b: Place = {
  name: "Kreuzung",
  detail: "",
  latitude: 48,
  longitude: 11.002,
};
export const c: Place = {
  name: "Bahnhof",
  detail: "",
  latitude: 48.002,
  longitude: 11.002,
  stopId: "A",
};
export const d: Place = {
  name: "Ausstieg",
  detail: "",
  latitude: 48.003,
  longitude: 11.004,
  stopId: "D",
};
export const e: Place = {
  name: "Café",
  detail: "",
  latitude: 48.0033,
  longitude: 11.004,
};
export const f: Place = {
  name: "Ziel",
  detail: "",
  latitude: 48.004,
  longitude: 11.006,
};
export function encoded(points: number[][]) {
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

export function route(multimodal = false): Journey {
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

export async function setup(
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
      refreshLookups: 0,
      // Unscripted refreshes stay silent; individual tests supply new measurements.
      refreshSilent: true,
      cachedAt: undefined as number | undefined,
      lastWatchOptions: undefined as PositionOptions | undefined,
      lastQuickOptions: undefined as PositionOptions | undefined,
      lastRefreshOptions: undefined as PositionOptions | undefined,
      get active() {
        return watchers.size;
      },
      silent: false,
      // Getters keep init-script ordering independent of the context mock.
      get spoken() {
        return window.testSpeech.spoken;
      },
      get cancelled() {
        return window.testSpeech.cancelled;
      },
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
          if (options?.enableHighAccuracy) {
            probe.refreshLookups++;
            probe.lastRefreshOptions = options;
            if (probe.refreshSilent) return;
          } else {
            probe.quickLookups++;
            probe.lastQuickOptions = options;
          }
          if (probe.cachedAt !== undefined || !probe.silent)
            success({
              coords,
              timestamp: probe.cachedAt ?? Date.now(),
            } as GeolocationPosition);
        },
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
  await openStorageSeed(page);
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
  await page.goto("/");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await openCachedJourney(page, page.locator("#open-saved"));
  if (!start) return;
  await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await expect(page.locator("#navigation-storage-status")).toBeEmpty();
}

export function guidanceRoute(singleStep = false): Journey {
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

export async function complete(page: Page) {
  if (!(await page.locator("#navigation-complete").isVisible()))
    await page.locator("#navigation-details-toggle").click();
  await page.locator("#navigation-complete").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-confirm")).toBeHidden();
}

export function stationJourney() {
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

export async function stationRail(page: Page, selector: string) {
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

export async function expectTabVisible(
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

export async function expectCurrentTabAligned(page: Page) {
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

export async function expectMobileCredit(page: Page) {
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

export async function expectNavigationBasemap(page: Page) {
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

export async function openNavigationCredit(page: Page, index = 1) {
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

export async function savedActive(page: Page) {
  return page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    return !!(await new NavigationStore().read());
  });
}

export async function savedProgress(page: Page) {
  return page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    return (await new NavigationStore().read())?.progress;
  });
}

export async function startSelected(page: Page) {
  if (!(await page.locator(".panel-actions #navigation-start").isVisible()))
    await page.locator("#route-more").click();
  await page.locator("#navigation-start").click();
}
