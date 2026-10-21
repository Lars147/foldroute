import { test, expect } from "@playwright/test";
import { type Place } from "../../src/model";
import { distance } from "../../src/geometry";
import { expectMotionSettled } from "./assertions";
import { mockRasterBasemap } from "./basemap";
import {
  now,
  b,
  c,
  d,
  e,
  f,
  encoded,
  route,
  setup,
  complete,
  stationJourney,
  stationRail,
  expectNavigationBasemap,
  savedActive,
  savedProgress,
  startSelected,
} from "./navigation-fixture";

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

for (const width of [390])
  test(`station rail fills with the visible marker, waits at stops and corrects with GPS at ${width}px`, async ({
    page,
  }, info) => {
    // Replay movement, dwell, row transitions and GPS corrections in both engines.
    test.setTimeout(60000);
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
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "Voraussichtlich an: Stadtmitte",
    );
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
    // One GPS point can move the map; the station rail waits for a second
    // plausible point before correcting its estimated progress.
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      c,
    );
    await page.clock.runFor(1000);
    await expect(page.locator("#navigation-context-status")).toContainText(
      "Stationsstand geschätzt",
    );
    const beforeConfirmation = await stationRail(page, selector);
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      c,
    );
    expect((await stationRail(page, selector)).progress).toBeCloseTo(
      beforeConfirmation.progress,
      2,
    );
    await page.clock.runFor(1000);
    const middle = await stationRail(page, selector);
    expect(middle.progress).toBeGreaterThan(0);
    expect(middle.progress).toBeLessThan(beforeConfirmation.progress);
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

for (const width of [390])
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
    await page.clock.fastForward(60000);
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
    await expect(page.locator("#navigation-context-status")).toContainText(
      "Stationsstand geschätzt",
    );
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "GPS ungenau Kartenposition geschätzt",
    );
    await expect(
      page.locator("#navigation-stations-announcement"),
    ).not.toContainText("Stationsfortschritt pausiert");
    await page.clock.fastForward(61000);
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "Kein GPS Kartenposition geschätzt",
    );
    await expect(page.locator("#navigation-context-status")).toContainText(
      "Stationsstand geschätzt",
    );
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
      width < 900 ? "Ankunft 12:10" : "Ankunft laut Fahrplan 12:08",
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
    await page.clock.fastForward(61000);
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
  await page.clock.fastForward(61000);
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "Kein GPS Kartenposition geschätzt",
  );
  await expect(page.locator("#navigation-context-status")).toContainText(
    "Stationsstand geschätzt",
  );
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Noch 3 Halte",
  );
  await expect(page.locator("#navigation-summary-arrival")).toBeHidden();
  await page.route("**/api/v6/trip?*", (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  await page.clock.fastForward(61000);
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

for (const width of [390])
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
      "Kein GPS Kartenposition geschätzt",
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

test("station entrances away from the track do not block estimates after signal loss", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney();
  const train = journey.legs[2];
  delete train.transitReference;
  train.transitStops = structuredClone(train.transitStops);
  // Move the station sideways from the track while preserving its route order.
  train.transitStops![1].latitude += 0.0013;
  train.transitStops![1].longitude -= 0.00145;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.locator("#navigation-details-toggle").click();
  await page.clock.pauseAt(new Date((now + 450) * 1000));
  const before = await savedProgress(page);
  await context.setOffline(true);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "Kein GPS Kartenposition geschätzt",
  );
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  await page.clock.fastForward(51000);
  await context.setOffline(false);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Ausstieg",
  );
  expect(await savedProgress(page)).toEqual(before);
});

test("GPS outside the train route does not freeze station estimates through a connection loss", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney();
  delete journey.legs[2].transitReference;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.locator("#navigation-details-toggle").click();
  await page.clock.pauseAt(new Date((now + 450) * 1000));
  const before = await savedProgress(page);
  await page.evaluate(() => (window as any).navProbe.push(48.012, 11.002));
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "Kartenposition geschätzt",
  );
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  await context.setOffline(true);
  await page.clock.runFor(2100);
  await context.setOffline(false);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  expect(await savedProgress(page)).toEqual(before);
  const stop = journey.legs[2].transitStops![2];
  for (let i = 0; i < 2; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(
      (point) => (window as any).navProbe.push(point.latitude, point.longitude),
      stop,
    );
  }
  await expect(map).toHaveAttribute("data-position-source", "gps");
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Ausstieg",
  );
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
  await page.clock.runFor(1000);
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
  await expect(page.locator("#navigation-context-status")).toContainText(
    "Stationsstand unklar",
  );
  const frozen = (await stationRail(page, "#navigation-stations-detail"))
    .filled;
  await page.clock.fastForward(10000);
  expect((await stationRail(page, "#navigation-stations-detail")).filled).toBe(
    frozen,
  );
});

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

test("GPS badge separates estimated position through loss and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  const journey = stationJourney();
  delete journey.legs[2].transitReference;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.locator("#navigation-details-toggle").click();
  const status = page.locator("#navigation-gps-status");
  const primary = page.locator("#navigation-gps-primary");
  const secondary = page.locator("#navigation-gps-estimate");
  await page.evaluate(
    (point) =>
      (window as any).navProbe.push(point.latitude, point.longitude, 90, 500),
    c,
  );
  await expect(status).toHaveText("GPS ungenau Kartenposition geschätzt");
  await expect(primary).toHaveText("GPS ungenau");
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await expect(status).toHaveText("Kein GPS Kartenposition geschätzt");
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
  expect(await page.evaluate(() => (window as any).gpsBadgeChanges)).toBe(0);
  // A street/preparation section keeps the warning, without an estimated train position.
  await complete(page);
  await expect(status).toHaveText("Kein GPS");
  await expect(secondary).toBeHidden();
  await expect(secondary).toBeEmpty();
  await expect(status).toHaveCSS("background-color", "rgb(255, 212, 59)");
  await page.evaluate(
    (point) => (window as any).navProbe.push(point.latitude, point.longitude),
    d,
  );
  await expect(status).toBeHidden();
  await expect(primary).toBeEmpty();
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
  await page.clock.fastForward(60000);
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
test("GPS advances street legs, fresh transit waits for confirmed exit, stops remain explicit", async ({
  page,
}) => {
  test.setTimeout(60000);
  // This covers navigation decisions across a full journey; short dedicated
  // cases above verify animation without replaying minutes of animation frames.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page, true, true, {}, stationJourney());
  async function gps(point: Place, elapsed: number) {
    // Automatic leg transitions need the intermediate ticks and trip refreshes.
    // A jump models inactivity instead and would test different behavior.
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
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung Altstadt",
  );
  await gps(d, 1000);
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
  await page.clock.fastForward(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · in 2 Min.",
  );
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Abfahrt 12:02",
  );
  await page.clock.fastForward(61000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · in <1 Min.",
  );
  await page.clock.runFor(30000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · Abfahrtszeit überschritten",
  );
  cancelled = true;
  await page.clock.fastForward(61000);
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
