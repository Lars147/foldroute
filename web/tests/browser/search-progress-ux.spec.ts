import { expect, test, type Page } from "./test";
import recording from "../../src/data/bike-transfer.json" with { type: "json" };
import type { PlanningRoutePreview, RouteRequest } from "../../src/model";
import { routeURL } from "../../src/route-url";
import {
  expectMotionSettled,
  openSelectedDetails,
  showMap,
  showConnections,
} from "./assertions";
import {
  expectRouteFitUnchanged,
  expectRouteFits,
  expectMapSettled,
} from "./planner-fixture";

// Keep the real application/session/view and control only the planner stream.
// The stream deliberately allows a late response after its signal is aborted.
async function open(
  page: Page,
  clock = false,
  request = recording.request as RouteRequest,
) {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({
      json: [],
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.route("**/src/planner.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: [
        'import { exampleRecording } from "/src/example-data.ts";',
        "export async function* planRoutes(request, settings, signal, client) {",
        "  window.searchControlRuns = (window.searchControlRuns ?? 0) + 1;",
        "  const queue = []; let wake;",
        "  const control = window.searchControl = {",
        "    aborted: false, publish(event) { queue.push(event); wake?.(); }",
        "  };",
        '  signal.addEventListener("abort", () => { control.aborted = true; }, { once: true });',
        '  yield { journeys: [], status: "searching", phase: "base", incompletePhases: [], issues: [] };',
        "  while (true) {",
        "    if (!queue.length) await new Promise(resolve => { wake = resolve; });",
        "    const event = queue.shift(); wake = undefined;",
        "    if (event.error) throw new Error(event.error);",
        "    if (event.retryAt) client.retryAt = event.retryAt;",
        "    const journeys = (event.ids ?? []).map((id, index) => ({",
        "      ...structuredClone(exampleRecording.journey), id,",
        "      arrival: exampleRecording.journey.arrival + index * 60,",
        "      legs: exampleRecording.journey.legs.map((leg, legIndex) => ({ ...leg,",
        "        coordinates: event.detourIds?.includes(id) && legIndex === 0",
        "          ? [...leg.coordinates, { latitude: exampleRecording.journey.origin.latitude - 0.3, longitude: exampleRecording.journey.origin.longitude }]",
        "          : leg.coordinates",
        "      }))",
        "    }));",
        "    if (request.stops?.length) for (const journey of journeys) {",
        "      const places = [request.origin, ...request.stops.map(stop => stop.place), request.destination];",
        "      let start = journey.departure; journey.legs = [];",
        "      for (let i = 0; i < places.length - 1; i++) {",
        '        journey.legs.push({ kind: "bike", from: places[i], to: places[i + 1], start, end: start + 600, distance: 1000, coordinates: [places[i], places[i + 1]] });',
        "        start += 600; const stop = request.stops[i];",
        "        if (stop) {",
        '          journey.legs.push({ kind: "stop", stop, from: stop.place, to: stop.place, start, end: start + stop.stayMinutes * 60, distance: 0, coordinates: [stop.place] });',
        "          start += stop.stayMinutes * 60;",
        "        }",
        "      }",
        "      Object.assign(journey, { origin: request.origin, destination: request.destination, arrival: start, transfers: 0, isDirect: true });",
        "    }",
        '    yield { issues: [], incompletePhases: [], status: "searching", ...event, journeys };',
        '    if (event.status === "complete" || event.status === "partial") return;',
        "  }",
        "}",
      ].join("\n"),
    }),
  );
  const url = routeURL(new URL("http://localhost/"), {
    request,
  });
  const time = new Date(recording.journey.departure * 1000 - 60_000);
  if (clock) await page.clock.install({ time });
  else await page.clock.setFixedTime(time);
  await page.goto(url.pathname + url.search);
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await expect(page.locator("#status")).toHaveText(
    "Verbindungen werden gesucht …",
  );
}

async function publish(
  page: Page,
  event: {
    phase: string;
    activeSection?: number;
    routePreview?: PlanningRoutePreview;
    ids?: string[];
    detourIds?: string[];
    status?: string;
    incompletePhases?: string[];
    issues?: string[];
    retryAt?: number;
    error?: string;
  },
) {
  await page.evaluate(
    (event) => (window as any).searchControl.publish(event),
    event,
  );
}

const viaRequest: RouteRequest = {
  ...(recording.request as RouteRequest),
  stops: [
    {
      id: "coffee",
      place: {
        ...recording.request.origin,
        name: "sweet spot kaffee",
        latitude:
          (recording.request.origin.latitude +
            recording.request.destination.latitude) /
          2,
        longitude:
          (recording.request.origin.longitude +
            recording.request.destination.longitude) /
          2,
      },
      stayMinutes: 15,
    },
  ],
};

test("closing before first results cancels the calculation and ignores late results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.locator("#close-route").click();
  await expect(page.locator("#search-view")).toBeVisible();
  expect(await page.evaluate(() => (window as any).searchControl.aborted)).toBe(
    true,
  );
  await publish(page, {
    phase: "walking",
    ids: ["late-result"],
    status: "complete",
  });
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("#map-view")).toBeHidden();
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await expect(page.locator("#search-empty")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Laufende Routenberechnung öffnen|Aktuelle Route öffnen/,
    }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(1);
});

const requestMarkerPositions = (page: Page) =>
  page.locator("#map .route-marker").evaluateAll((markers) =>
    markers.map((marker) => {
      const { x, y } = marker.getBoundingClientRect();
      return { x, y };
    }),
  );

function provisionalRoute(
  request: RouteRequest,
  startSection = 0,
  endSection = 1,
  detour = false,
): PlanningRoutePreview {
  const places = [
    request.origin,
    ...(request.stops ?? []).map((s) => s.place),
    request.destination,
  ];
  return {
    startSection,
    endSection,
    legs: places.slice(startSection, endSection).map((from, offset) => {
      const to = places[startSection + offset + 1];
      return {
        kind: "bike",
        from,
        to,
        start: request.time + offset * 600,
        end: request.time + (offset + 1) * 600,
        distance: 1000,
        coordinates:
          detour && offset === 0
            ? [
                from,
                { latitude: from.latitude - 0.3, longitude: from.longitude },
                to,
              ]
            : [from, to],
      };
    }),
  };
}

for (const failed of [false, true])
  test(`request preview follows breakpoints without planner updates while ${failed ? "failed" : "searching"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await open(page, true, viaRequest);
    if (failed)
      await publish(page, {
        phase: "via",
        error: "Dienst vorübergehend nicht erreichbar.",
      });
    await page.locator("#route-more").focus();
    const before = await page.evaluate(() => ({
      url: location.href,
      history: history.length,
    }));
    for (const width of [900, 899, 1280, 390, 900, 899]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator("#map-view")).toHaveAttribute(
        "data-result-screen",
        width < 900 ? "map" : "desktop",
      );
      await expect(page.locator("#search-preview")).toBeVisible();
      await expect(page.locator("#map")).toBeVisible();
      await expect(page.locator("#map-controls")).toBeVisible();
      expect(
        await page.locator("#map").evaluate((element) => element.inert),
      ).toBe(false);
      await expect(page.locator("#route-more")).toBeFocused();
    }
    expect(
      await page.evaluate(() => ({
        url: location.href,
        history: history.length,
      })),
    ).toEqual(before);
    expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(
      1,
    );
    await expect(page.locator("#search-preview-title")).toHaveText(
      failed ? "Keine Verbindung verfügbar" : "Verbindungen werden gesucht …",
    );
    await expect(page.locator("#navigation-start")).toBeHidden();
  });

for (const width of [390, 1280])
  for (const interaction of ["focus", "popup"] as const)
    test(`request markers retain ${interaction} through streamed geometry and results at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, true, viaRequest);
      await expect(page.locator("#map .route-marker")).toHaveCount(3);
      await expect(page.locator("#map-error")).toBeVisible();
      await expectMapSettled(page);
      const markers = await page.locator("#map .route-marker").elementHandles();
      const marker = page.getByRole("button", {
        name: "Zwischenstopp 1: sweet spot kaffee",
        exact: true,
      });
      await marker.focus();
      if (interaction === "popup") {
        await page.keyboard.press("Space");
        await expect(page.locator("#map .route-marker-info")).toHaveText(
          "Zwischenstopp 1: sweet spot kaffee",
        );
        await page.clock.runFor(400);
      }
      const expectMarkersRetained = async () => {
        for (const [index, original] of markers.entries())
          expect(
            await page
              .locator("#map .route-marker")
              .nth(index)
              .evaluate((current, previous) => current === previous, original),
          ).toBe(true);
        if (interaction === "focus") await expect(marker).toBeFocused();
        else
          await expect(page.locator("#map .route-marker-info")).toHaveText(
            "Zwischenstopp 1: sweet spot kaffee",
          );
      };
      for (const [endSection, detour] of [
        [1, false],
        [1, true],
        [2, true],
      ] as const) {
        await publish(page, {
          phase: "via",
          activeSection: 1,
          routePreview: provisionalRoute(viaRequest, 0, endSection, detour),
        });
        await expect(
          page.locator("#map .planning-route-preview-line"),
        ).toHaveCount(endSection);
        await expectMarkersRetained();
      }
      await page.evaluate(async () => {
        const path = "/src/map-style.ts";
        const { mapStyle } = await import(path);
        mapStyle.set("dark");
      });
      await expect(page.locator("html")).toHaveAttribute(
        "data-map-style",
        "dark",
      );
      await expectMarkersRetained();
      await publish(page, { phase: "via", ids: ["first"], status: "complete" });
      await expect(page.locator("#search-preview")).toBeHidden();
      await expect(
        page.locator("#map .planning-route-preview-line"),
      ).toHaveCount(0);
      await expectMarkersRetained();
    });

for (const [width, height, fontSize] of [
  [320, 844, 16],
  [390, 844, 16],
  [844, 390, 16],
  [1280, 844, 16],
  [320, 844, 32],
]) {
  test(`provisional route grows without moving the camera at ${width}x${height} with ${fontSize}px text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await open(page, true, viaRequest);
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, fontSize);
    await expect(page.locator("#map-error")).toBeVisible();
    await expectMapSettled(page);
    const positions = await requestMarkerPositions(page);
    await page.locator("#route-more").focus();
    const first = provisionalRoute(viaRequest);
    first.legs[0].kind = "walk";
    await publish(page, {
      phase: "via",
      activeSection: 1,
      routePreview: first,
    });
    const lines = page.locator("#map .planning-route-preview-line");
    await expect(lines).toHaveCount(1);
    await expect(lines).toHaveAttribute("stroke-opacity", "0.7");
    await expect(lines).toHaveAttribute("stroke-dasharray", "3 8");
    await expect(lines).not.toHaveClass(/leaflet-interactive/);
    await expect(
      page.locator("#map .leaflet-overlay-pane svg path"),
    ).toHaveCount(2);
    await expect(page.locator("#map .route-marker")).toHaveCount(3);
    await expect(page.locator("#search-preview-hint")).toHaveText(
      "Die angezeigte Teilroute ist vorläufig und kann sich noch ändern.",
    );
    await expect(page.locator("#search-preview-detail")).toHaveText(
      `sweet spot kaffee → ${viaRequest.destination.name} wird geprüft.`,
    );
    await expect(page.locator(".route-choice")).toHaveCount(0);
    await expect(page.locator("#navigation-start")).toBeHidden();
    await expect(page.locator("#map-open-details")).toBeHidden();
    await expect(page.locator("#result-back")).toBeHidden();
    await expect(page.locator("#toast")).toBeHidden();
    await expectMapSettled(page);
    expect(await requestMarkerPositions(page)).toEqual(positions);
    await page.locator("#search-preview-hint").scrollIntoViewIfNeeded();
    await expect(page.locator("#search-preview-hint")).toBeInViewport({
      ratio: 0.99,
    });
    await page.screenshot({ path: info.outputPath("provisional-route.png") });
    await page.clock.fastForward(10_100);
    await expect(page.locator("#search-preview-hint")).toHaveText(
      "Die angezeigte Teilroute ist vorläufig und kann sich noch ändern.",
    );
    await publish(page, {
      phase: "via",
      activeSection: 1,
      routePreview: provisionalRoute(viaRequest, 0, 2, true),
    });
    await expect(lines).toHaveCount(2);
    await expectMapSettled(page);
    expect(await requestMarkerPositions(page)).toEqual(positions);
    await expect(page.locator("#route-more")).toBeFocused();
    await expect(page.locator("#navigation-start")).toBeHidden();
    await publish(page, { phase: "via", ids: ["first"], status: "complete" });
    await expect(lines).toHaveCount(0);
    await expect(page.locator("#search-preview")).toBeHidden();
    await expect(page.locator("#navigation-start")).toBeVisible();
    await expectRouteFits(page);
    await expectRouteFitUnchanged(page);
  });
}

test("arrival preview starts at the destination and explicit fit includes its detour", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const request: RouteRequest = { ...viaRequest, timing: "arrive" };
  await open(page, true, request);
  await expectMapSettled(page);
  const positions = await requestMarkerPositions(page);
  await publish(page, {
    phase: "via",
    activeSection: 0,
    routePreview: provisionalRoute(request, 1, 2, true),
  });
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    1,
  );
  await expect(page.locator("#search-preview-detail")).toHaveText(
    `${request.origin.name} → sweet spot kaffee wird geprüft.`,
  );
  await expectMapSettled(page);
  expect(await requestMarkerPositions(page)).toEqual(positions);
  await expect(page.locator("#map-route")).toHaveAccessibleName(
    "Orte und Teilroute anzeigen",
  );
  await page.locator("#map-route").click();
  await expectMapSettled(page);
  expect(await requestMarkerPositions(page)).not.toEqual(positions);
  const line = (await page
    .locator("#map .planning-route-preview-line")
    .boundingBox())!;
  const panel = (await page.locator("#journey-panel").boundingBox())!;
  const controls = (await page.locator("#map-controls").boundingBox())!;
  expect(line.y).toBeGreaterThanOrEqual(0);
  expect(line.y + line.height).toBeLessThan(panel.y);
  expect(line.x).toBeGreaterThanOrEqual(0);
  expect(line.x + line.width).toBeLessThan(controls.x);
  await expectRouteFits(page);
  await expectRouteFitUnchanged(page);
});

test("offline interruption clears a provisional route before retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true, viaRequest);
  await publish(page, {
    phase: "via",
    activeSection: 1,
    routePreview: provisionalRoute(viaRequest),
  });
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    1,
  );
  await page.context().setOffline(true);
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    0,
  );
  await expect(page.locator("#search-preview-hint")).toBeHidden();
  await expect(page.locator("#map .route-marker")).toHaveCount(3);
  const retry = page.locator("#search-preview-feedback #recover-planning");
  await expect(retry).toBeDisabled();
  await page.context().setOffline(false);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator("#search-preview-spinner")).toBeVisible();
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    0,
  );
  await publish(page, {
    phase: "via",
    routePreview: provisionalRoute(viaRequest),
  });
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    1,
  );
});

for (const [width, height, fontSize] of [
  [320, 844, 16],
  [390, 844, 16],
  [844, 390, 16],
  [1280, 844, 16],
  [320, 844, 32],
]) {
  test(`request map explains long searches at ${width}x${height} with ${fontSize}px text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({
      colorScheme: width === 390 ? "dark" : "light",
      reducedMotion: "reduce",
    });
    await open(page, true, viaRequest);
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, fontSize);
    await publish(page, { phase: "via", activeSection: 0 });
    await expect(page.locator("#search-preview")).toBeVisible();
    await expect(page.locator("#search-preview-detail")).toHaveText(
      `${viaRequest.origin.name} → sweet spot kaffee wird geprüft.`,
    );
    await expect(page.locator("#search-preview-hint")).toBeHidden();
    await expect(page.locator("#toast")).toBeHidden();
    await expect(page.locator("#navigation-start")).toBeHidden();
    await expect(page.locator("#map-open-details")).toBeHidden();
    await expect(page.locator("#result-back")).toBeHidden();
    await expect(page.locator("#map .route-marker")).toHaveCount(3);
    await expect(
      page.locator(
        '#map .route-marker[aria-label="Zwischenstopp 1: sweet spot kaffee"]',
      ),
    ).toBeVisible();
    await expect(
      page.locator("#map .leaflet-overlay-pane svg path"),
    ).toHaveCount(0);
    await expect(page.locator("#map-route")).toHaveAccessibleName(
      "Alle Orte anzeigen",
    );
    await expect(page.locator("#map-error")).toBeVisible();
    await expectRouteFits(page);
    await expectRouteFitUnchanged(page);
    const positions = await requestMarkerPositions(page);
    await page.locator("#route-more").focus();
    await page.clock.fastForward(10_100);
    await expect(page.locator("#search-preview-hint")).toHaveText(
      "Mit Zwischenzielen stimmen wir mehrere Teilstrecken und Zeiten aufeinander ab.",
    );
    await expect(page.locator("#search-preview-hint")).toBeVisible();
    await page.locator("#search-preview-hint").scrollIntoViewIfNeeded();
    await expect(page.locator("#search-preview-hint")).toBeInViewport({
      ratio: 0.99,
    });
    await publish(page, { phase: "via", activeSection: 1 });
    await expect(page.locator("#search-preview-detail")).toHaveText(
      `sweet spot kaffee → ${viaRequest.destination.name} wird geprüft.`,
    );
    await expectMapSettled(page);
    expect(await requestMarkerPositions(page)).toEqual(positions);
    await expect(page.locator("#route-more")).toBeFocused();
    await expect(page.locator("#search-preview-spinner")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.screenshot({ path: info.outputPath("request-map-search.png") });
    await publish(page, { phase: "via", ids: ["first"], status: "complete" });
    await expect(page.locator("#search-preview")).toBeHidden();
    await expect(page.locator("#navigation-start")).toBeVisible();
    await expect(page.locator("#route-more")).toBeFocused();
    await expectRouteFits(page);
    await expectRouteFitUnchanged(page);
    if (width < 900) await expect(page.locator("#toast")).toBeHidden();
    else
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "ready",
      );
  });
}

test("request map retains errors, retry and manual camera across the first result", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true, viaRequest);
  await expect(page.locator("#map .route-marker")).toHaveCount(3);
  await publish(page, {
    phase: "via",
    routePreview: provisionalRoute(viaRequest),
  });
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    1,
  );
  await expectMapSettled(page);
  await publish(page, {
    phase: "base",
    error: "Der Dienst hat nicht rechtzeitig geantwortet.",
  });
  await expect(page.locator("#search-preview-title")).toHaveText(
    "Keine Verbindung verfügbar",
  );
  await expect(page.locator("#search-preview-detail")).toHaveText(
    "Der Dienst hat nicht rechtzeitig geantwortet.",
  );
  await expect(page.locator("#search-preview-spinner")).toBeHidden();
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    0,
  );
  const retry = page.locator("#search-preview-feedback #recover-planning");
  await expect(retry).toBeVisible();
  await expect(page.locator("#map .route-marker")).toHaveCount(3);
  await retry.click();
  await expect(page.locator("#search-preview-spinner")).toBeVisible();
  await expect(page.locator("#search-preview-hint")).toBeHidden();
  await expect(page.locator("#recover-planning")).toBeHidden();
  await expectMapSettled(page);
  await page.locator("#map").focus();
  await page.keyboard.press("ArrowRight");
  await page.clock.runFor(400);
  await expectMapSettled(page);
  const positions = await requestMarkerPositions(page);
  await publish(page, {
    phase: "via",
    routePreview: provisionalRoute(viaRequest, 0, 1, true),
  });
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    1,
  );
  await expectMapSettled(page);
  expect(await requestMarkerPositions(page)).toEqual(positions);
  await publish(page, { phase: "base", ids: ["first"] });
  await expect(page.locator("#search-preview")).toBeHidden();
  await expectMapSettled(page);
  expect(await requestMarkerPositions(page)).toEqual(positions);
  await expect(page.locator("#map")).toBeFocused();
  await expect(page.locator("#toast")).toHaveText("Routenoptimierung läuft …");
});

test("search wait timer survives progress and resets for a new request, ignoring late results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true, viaRequest);
  await page.clock.fastForward(6000);
  await publish(page, {
    phase: "via",
    activeSection: 1,
    routePreview: provisionalRoute(viaRequest),
  });
  await page.clock.fastForward(4100);
  await expect(page.locator("#search-preview-hint")).toBeVisible();
  await page.evaluate(() => {
    (window as any).previousSearchControl = (window as any).searchControl;
  });
  await page.locator("#adjust-route").click();
  await page.locator("#calculate").click();
  await expect(page.locator("#search-preview-hint")).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).previousSearchControl.aborted),
  ).toBe(true);
  await page.evaluate(
    (routePreview) =>
      (window as any).previousSearchControl.publish({
        ids: ["late"],
        status: "complete",
        phase: "via",
        activeSection: 1,
        routePreview,
      }),
    provisionalRoute(viaRequest),
  );
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await expect(page.locator("#map .planning-route-preview-line")).toHaveCount(
    0,
  );
  await expect(page.locator("#search-preview-title")).toHaveText(
    "Verbindungen werden gesucht …",
  );
  await page.clock.fastForward(9900);
  await expect(page.locator("#search-preview-hint")).toBeHidden();
  await page.clock.fastForward(200);
  await expect(page.locator("#search-preview-hint")).toBeVisible();
});

test("initial search can recover after going offline without losing the request map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true);
  await page.clock.fastForward(10_100);
  await expect(page.locator("#search-preview-hint")).toHaveText(
    "Die Suche dauert etwas länger. Wir prüfen weiter passende Verbindungen.",
  );
  await page.context().setOffline(true);
  await expect(page.locator("#search-preview-detail")).toHaveText(
    "Offline. Die Verbindungssuche wurde unterbrochen.",
  );
  await expect(page.locator("#search-preview-spinner")).toBeHidden();
  await expect(page.locator("#map .route-marker")).toHaveCount(2);
  const retry = page.locator("#search-preview-feedback #recover-planning");
  await expect(retry).toBeVisible();
  await expect(retry).toBeDisabled();
  await page.context().setOffline(false);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator("#search-preview-spinner")).toBeVisible();
  await expect(page.locator("#search-preview-hint")).toBeHidden();
  await publish(page, { phase: "base", ids: ["first"], status: "complete" });
  await expect(page.locator("#search-preview")).toBeHidden();
  await expect(page.locator("#navigation-start")).toBeVisible();
});

for (const status of ["searching", "complete"] as const) {
  test(`mobile results skip visual readiness when search is ${status}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, true);
    await page.evaluate(() => {
      (window as any).toastStages = [];
      new MutationObserver((records) => {
        for (const record of records)
          if (record.attributeName === "data-planning-stage")
            (window as any).toastStages.push(record.oldValue);
      }).observe(document.getElementById("toast")!, {
        attributes: true,
        attributeOldValue: true,
      });
    });
    await publish(page, { phase: "base", ids: ["first"], status });
    const toast = page.locator("#toast");
    await expect(page.locator("#map-preview-summary")).toBeVisible();
    if (status === "complete") await expect(toast).toBeHidden();
    else
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
    await expect(page.locator("#planning-announcement")).toHaveText(
      "Verbindungen gefunden",
    );
    expect(
      await page.evaluate(() => (window as any).toastStages),
    ).not.toContain("ready");
    await showConnections(page);
    await openSelectedDetails(page);
    await showMap(page);
    await page.setViewportSize({ width: 1280, height: 844 });
    if (status === "complete") await expect(toast).toBeHidden();
    else
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
  });
}

for (const [width, height, fontSize] of [
  [320, 844, 16],
  [390, 844, 16],
  [844, 390, 16],
  [320, 568, 32],
]) {
  test(`mobile map toasts stay above the route panel at ${width}x${height} with ${fontSize}px text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    await page.evaluate((fontSize) => {
      const style = document.documentElement.style;
      style.fontSize = `${fontSize}px`;
      for (const edge of ["top", "left", "right", "bottom"])
        style.setProperty(`--safe-${edge}`, edge === "top" ? "24px" : "8px");
    }, fontSize);
    await publish(page, { phase: "bike-transfers", ids: ["first"] });
    const toast = page.locator("#toast");
    await expect(toast).toHaveText("Routenoptimierung läuft …");
    await expectFeedbackPosition(page, width);
    await expect(page.locator("#map-error")).toBeVisible();
    const panel = page.locator("#journey-panel");
    const panelHeight = (await panel.boundingBox())!.height;
    await publish(page, {
      phase: "bike-transfers",
      ids: ["first"],
      status: "complete",
    });
    await expect(toast).toBeHidden();
    await expect
      .poll(async () => (await panel.boundingBox())!.height)
      .toBe(panelHeight);
    await page.locator("#route-more").click();
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expectFeedbackPosition(page, width);
    expect((await panel.boundingBox())!.height).toBe(panelHeight);
    await expect(toast.locator(".toast-countdown")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("map-toast-top.png") });
    await page.clock.fastForward(6001);
    await expect(toast).toBeHidden();
  });
}

test("map error toast follows the offline banner and keeps retry reachable with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
    document.documentElement.style.setProperty("--safe-top", "24px");
  });
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    status: "partial",
    incompletePhases: ["walking"],
    issues: ["Der Dienst hat nicht rechtzeitig geantwortet."],
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "error",
  );
  await expectFeedbackPosition(page, 390);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("#connection")).toBeVisible();
  await expectFeedbackPosition(page, 390);
  const banner = (await page.locator("#connection").boundingBox())!;
  const toast = (await page.locator("#toast").boundingBox())!;
  expect(toast.y).toBeGreaterThanOrEqual(banner.y + banner.height + 12);
  await expect(page.locator("#toast #recover-planning")).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.locator("#connection")).toBeHidden();
  await expectFeedbackPosition(page, 390);
  await page.locator("#toast #recover-planning").click();
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
});

test("finished optimization drops discarded detours before the route-fit button is clicked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 425, height: 812 });
  await open(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first", "detour"],
    detourIds: ["detour"],
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await expectRouteFitUnchanged(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first"],
    status: "complete",
  });
  await expect(page.locator("#toast")).toBeHidden();
  await expectRouteFitUnchanged(page);
});

test("request map stays open for the first result and preserves explicit choices during optimization", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first", "alternative"],
  });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#map-preview-summary")).toBeVisible();
  await showConnections(page);
  await page.locator('[data-journey="alternative"]').click();
  await publish(page, {
    phase: "bike-transfers",
    ids: ["improved", "first", "alternative"],
  });
  await expect(page.locator('[data-journey="improved"]')).toBeAttached();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await showConnections(page);
  await expect(page.locator("#choices")).toBeVisible();
  await expect(page.locator('[data-journey="alternative"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await openSelectedDetails(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["improved", "first", "alternative"],
    status: "complete",
  });
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#panel-details")).toBeVisible();
  await expect(page.locator('[data-journey="alternative"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("refresh keeps the map and closes old details when current results arrive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await publish(page, { phase: "base", ids: ["original"], status: "complete" });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  const refresh = async (run: number) => {
    await page.locator("#route-more").click();
    await page.locator("#refresh-route").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).searchControlRuns))
      .toBe(run);
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "map",
    );
    await expect(page.locator("#map-preview-status")).toBeVisible();
  };
  await refresh(2);
  await publish(page, { phase: "base", ids: ["fresh"], status: "complete" });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator('[data-journey="fresh"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await refresh(3);
  await publish(page, { phase: "base", error: "Verbindung fehlgeschlagen" });
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#map-preview-status")).toBeVisible();
  await page.locator("#recover-planning").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).searchControlRuns))
    .toBe(4);
  await openSelectedDetails(page);
  await publish(page, { phase: "base", ids: ["latest"], status: "complete" });
  await expect(page.locator('[data-journey="latest"]')).toBeAttached();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
});

async function expectFeedbackPosition(page: Page, width: number) {
  await expectMotionSettled(page.locator("#toast"));
  await expect(async () => {
    const geometry = await page.evaluate(() => {
      const feedback = document.getElementById("toast")!;
      const toast = feedback.getBoundingClientRect();
      const panel = document
        .getElementById("journey-panel")!
        .getBoundingClientRect();
      const controls = document
        .getElementById("map-controls")!
        .getBoundingClientRect();
      const map = document.getElementById("map-view")!;
      const sheet = document.getElementById(
        "alternatives-dialog",
      ) as HTMLDialogElement;
      const content = document.getElementById(
        sheet.open
          ? sheet.dataset.mode === "detail"
            ? "panel-details"
            : "choices"
          : map.dataset.resultScreen === "map"
            ? "map-preview-summary"
            : map.dataset.resultScreen === "detail"
              ? "panel-details"
              : "choices",
      )!;
      return {
        left: toast.left,
        right: toast.right,
        top: toast.top,
        bottom: toast.bottom,
        panelRight: panel.right,
        panelTop: panel.top,
        controlsLeft: controls.left,
        controlsTop: controls.top,
        sidePanel:
          getComputedStyle(map)
            .getPropertyValue("--map-panel-layout")
            .trim() === "side",
        mapTop: map.getBoundingClientRect().top,
        inline: feedback.parentElement?.id === "planning-feedback-slot",
        inlineParent: feedback.parentElement?.parentElement?.id,
        sheet: sheet.open,
        sheetHeaderBottom: sheet
          .querySelector("header")!
          .getBoundingClientRect().bottom,
        feedbackParent: feedback.parentElement?.id,
        position: getComputedStyle(feedback).position,
        contentTop: content.getBoundingClientRect().top,
        screen: map.dataset.resultScreen,
        viewport: innerWidth,
      };
    });
    if (geometry.sheet) {
      expect(geometry.feedbackParent).toBe("alternatives-feedback-slot");
      expect(geometry.position).toBe("relative");
      expect(geometry.left).toBeGreaterThanOrEqual(15);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 15);
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.sheetHeaderBottom);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.contentTop + 1);
    } else if (width >= 900 || geometry.screen === "map") {
      expect(geometry.inline).toBe(false);
      expect(geometry.position).toBe("fixed");
      expect(geometry.left).toBeGreaterThanOrEqual(
        width >= 900 || geometry.sidePanel ? geometry.panelRight + 11 : 15,
      );
      expect(geometry.right).toBeLessThanOrEqual(geometry.controlsLeft - 11);
      if (width >= 900) {
        expect((geometry.left + geometry.right) / 2).toBeCloseTo(
          (geometry.panelRight + geometry.controlsLeft) / 2,
          0,
        );
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.mapTop + 11);
      } else {
        expect((geometry.left + geometry.right) / 2).toBeCloseTo(
          ((geometry.sidePanel ? geometry.panelRight : 0) + geometry.viewport) /
            2,
          0,
        );
        expect(geometry.top).toBeCloseTo(geometry.controlsTop, 0);
        if (!geometry.sidePanel)
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.panelTop - 11);
      }
    } else {
      expect(geometry.inline).toBe(true);
      expect(geometry.position).toBe("relative");
      expect(geometry.inlineParent).toBe(
        geometry.screen === "map" ? "map-preview" : "panel-content",
      );
      expect(geometry.left).toBeGreaterThanOrEqual(15);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 15);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.contentTop + 1);
    }
  }).toPass({ timeout: 5000 });
}

async function expectRetryIcon(page: Page) {
  const toast = page.locator("#toast");
  await expect(toast.locator(".toast-countdown")).toHaveCount(0);
  const warning = toast.locator(".planning-toast-warning");
  const dark =
    (await page.locator("html").getAttribute("data-theme")) === "dark";
  const warningColor = dark ? "rgb(255, 209, 138)" : "rgb(138, 75, 8)";
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("aria-hidden", "true");
  await expect(warning).toHaveCSS("color", warningColor);
  await expect(toast).toHaveCSS("border-top-color", warningColor);
  await expect(toast).toHaveCSS("border-top-width", "1px");
  await expect(toast).toHaveCSS(
    "background-color",
    dark ? "rgb(23, 26, 28)" : "rgb(245, 246, 243)",
  );
  await expect(toast).toHaveCSS(
    "color",
    dark ? "rgb(245, 246, 243)" : "rgb(23, 26, 28)",
  );
  const retry = page.locator("#toast #recover-planning");
  await expect(retry).toHaveAccessibleName("Erneut versuchen");
  await expect(retry).toHaveAttribute("title", "Erneut versuchen");
  await expect(retry.locator("#recovery-label")).toHaveClass("sr-only");
  await expect(retry.locator("svg")).toBeVisible();
  await expect(retry).toHaveCSS("text-decoration-line", "none");
  const geometry = await retry.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    const message = document
      .querySelector("#toast .planning-toast-message")!
      .getBoundingClientRect();
    const warning = document
      .querySelector("#toast .planning-toast-warning")!
      .getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      center: (bounds.top + bounds.bottom) / 2,
      messageRight: message.right,
      messageLeft: message.left,
      messageCenter: (message.top + message.bottom) / 2,
      warningRight: warning.right,
      warningCenter: (warning.top + warning.bottom) / 2,
      iconWidth: icon.width,
      iconHeight: icon.height,
    };
  });
  // WebKit can round transformed bounds a few millionths of a pixel below 44.
  expect(geometry.width).toBeGreaterThanOrEqual(44 - 0.01);
  expect(geometry.height).toBeGreaterThanOrEqual(44 - 0.01);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.messageRight + 7);
  expect(geometry.messageLeft).toBeGreaterThanOrEqual(
    geometry.warningRight + 7,
  );
  expect(geometry.warningCenter).toBeCloseTo(geometry.messageCenter, 0);
  expect(geometry.center).toBeCloseTo(geometry.messageCenter, 0);
  expect(geometry.iconWidth).toBeCloseTo(20, 2);
  expect(geometry.iconHeight).toBeCloseTo(20, 2);
}

async function expectCountdownAt(
  page: Page,
  duration: number,
  elapsed: number,
) {
  const countdown = page.locator("#toast .toast-countdown");
  await expect(countdown).toBeVisible();
  await expect(countdown).toHaveAttribute("aria-hidden", "true");
  const geometry = await countdown.locator(".toast-countdown-fill").evaluate(
    (fill, { duration, elapsed }) => {
      const animation = fill.getAnimations()[0];
      if (!animation?.effect)
        throw new Error("Toast countdown animation missing");
      animation.pause();
      const timing = animation.effect.getTiming();
      animation.currentTime = duration * elapsed + timing.delay;
      const track = fill.parentElement!.getBoundingClientRect();
      const bounds = fill.getBoundingClientRect();
      const toast = fill.closest("#toast")!.getBoundingClientRect();
      return {
        duration: timing.duration,
        easing: timing.easing,
        remaining: bounds.width / track.width,
        origin: bounds.left - track.left,
        height: track.height,
        left: track.left - toast.left,
        right: toast.right - track.right,
        bottom: toast.bottom - track.bottom,
      };
    },
    { duration, elapsed },
  );
  expect(geometry.duration).toBe(duration);
  expect(geometry.easing).toBe("linear");
  expect(geometry.remaining).toBeCloseTo(1 - elapsed, 2);
  expect(geometry.origin).toBeCloseTo(0, 2);
  expect(geometry.height).toBeCloseTo(2, 2);
  // Insets include the toast's one-pixel border.
  expect(geometry.left).toBeCloseTo(15, 2);
  expect(geometry.right).toBeCloseTo(15, 2);
  expect(geometry.bottom).toBeCloseTo(5, 2);
}

for (const width of [320, 390, 1280])
  test(
    "planning feedback keeps results usable at " + width + "px",
    async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({
        colorScheme: width === 390 ? "dark" : "light",
        reducedMotion: width === 320 ? "reduce" : "no-preference",
      });
      await open(page);
      if (width === 320)
        await page.addStyleTag({ content: "html { font-size: 24px; }" });
      const toast = page.locator("#toast");
      await expect(page.locator("#search-preview-title")).toHaveText(
        "Verbindungen werden gesucht …",
      );
      await expect(toast).toBeHidden();
      await expect(toast.locator(".toast-countdown")).toHaveCount(0);
      await expect(page.locator("#status")).toBeHidden();
      await expect(page.locator("#planning-ready")).toHaveCount(0);
      await publish(page, { phase: "base", ids: ["first", "chosen"] });
      await expect(toast).toHaveText(
        width < 900 ? "Routenoptimierung läuft …" : "Verbindungen gefunden",
      );
      await expect(toast).toHaveAttribute(
        "data-planning-stage",
        width < 900 ? "optimizing" : "ready",
      );
      const countdown = toast.locator(".toast-countdown");
      if (width < 900) await expect(countdown).toHaveCount(0);
      else await expect(countdown).toBeVisible();
      await expectFeedbackPosition(page, width);
      await expect(page.locator("#toast .icon")).toHaveCount(
        width < 900 ? 0 : 1,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await expect(page.locator("#journey-panel")).not.toHaveClass(
        /is-loading/,
      );
      await expect(page.locator("#navigation-start")).toBeEnabled();
      await page.screenshot({
        path: info.outputPath("search-results-feedback.png"),
      });
      await showConnections(page);
      await page.locator('.route-choice[data-journey="chosen"]').click();
      await openSelectedDetails(page);
      await expect(page.locator("#panel-details")).toContainText("S8");
      await page.evaluate(() => {
        (window as any).toastMutations = 0;
        new MutationObserver((records) => {
          (window as any).toastMutations += records.length;
        }).observe(document.getElementById("toast")!, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      const control = page.locator(
        width >= 900 ? "#route-more" : "#alternatives-close",
      );
      await control.focus();
      for (const phase of ["bike-transfers", "walking", "via"]) {
        await publish(page, { phase, ids: ["optimized"] });
        await expect(toast).toHaveAttribute(
          "data-planning-stage",
          width < 900 ? "optimizing" : "ready",
        );
        await expect(control).toBeFocused();
        await expect(
          page.locator('.route-choice[aria-pressed="true"]'),
        ).toHaveAttribute("data-journey", "chosen");
        await expect(page.locator("#panel-details")).toBeVisible();
      }
      await showMap(page);
      await expectFeedbackPosition(page, width);
      expect(await page.evaluate(() => (window as any).toastMutations)).toBe(0);
      await expect(page.locator("#toast .planning-toast-spinner")).toHaveCount(
        width < 900 ? 1 : 0,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath("search-feedback.png") });
      await page.locator("#close-route").click();
      await expect(toast).toBeHidden();
      await expect(toast.locator(".toast-countdown")).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as any).searchControl.aborted),
      ).toBe(true);
      await publish(page, {
        phase: "walking",
        ids: ["late"],
        status: "complete",
      });
      await expect(page.locator(".route-choice")).toHaveCount(0);
      await expect(toast).toBeHidden();
      await expect(page.locator("#search-view")).toBeVisible();
    },
  );

test("live feedback follows mobile and desktop layouts without replaying readiness", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, true);
  await publish(page, { phase: "base", ids: ["first"] });
  await expectFeedbackPosition(page, 390);
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  for (const width of [768, 1280, 899, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectFeedbackPosition(page, width);
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
  }
  await openSelectedDetails(page);
  await expectFeedbackPosition(page, 390);
  await showMap(page);
  await expectFeedbackPosition(page, 390);
  await page.locator("#result-back").click();
  await expectFeedbackPosition(page, 390);
});

for (const [width, colorScheme] of [
  [320, "light"],
  [1280, "dark"],
] as const)
  test(`toast countdown preserves duration and motion preference at ${width}px in ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    if (width === 320)
      await page.addStyleTag({ content: "html { font-size: 24px; }" });
    await publish(page, { phase: "base", ids: ["first"] });
    const toast = page.locator("#toast");
    if (width >= 900) {
      await expect(toast).toHaveAttribute("data-planning-stage", "ready");
      await page.clock.runFor(350);
      await expectMotionSettled(toast);
      const original = await toast.locator(".toast-countdown").elementHandle();
      await expectCountdownAt(page, 3000, 0);
      await expectCountdownAt(page, 3000, 0.5);
      await publish(page, { phase: "walking", ids: ["first"] });
      expect(await original!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(
        await toast
          .locator(".toast-countdown-fill")
          .evaluate((fill) => fill.getAnimations()[0].currentTime),
      ).toBe(1500);
      await page.screenshot({
        path: info.outputPath("readiness-countdown.png"),
      });
      await expectCountdownAt(page, 3000, 1);
      await page.clock.fastForward(2650);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(
        false,
      );
    }
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);

    await page.locator("#route-more").click();
    await page.clock.runFor(350);
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expect(page.locator(".history-feedback > #toast")).toBeVisible();
    const deadline = await page.evaluate(() => performance.now() + 6000);
    await page.clock.runFor(350);
    await expectMotionSettled(toast);
    await expectCountdownAt(page, 6000, 0);
    await expectCountdownAt(page, 6000, 0.5);
    await page.clock.fastForward(2650);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.runFor(32);
    await expect(toast.locator(".toast-countdown")).toBeHidden();
    // WebKit delivers media-query changes after rendering; wait before toggling back.
    await expect(toast.locator(".toast-countdown")).toHaveCSS(
      "--toast-elapsed",
      /^[1-9]\d*(?:\.\d+)?ms$/,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.runFor(32);
    await expect(toast.locator(".toast-countdown")).toBeVisible();
    await expect
      .poll(() =>
        toast
          .locator(".toast-countdown-fill")
          .evaluate(
            (fill) => fill.getAnimations()[0]?.effect?.getTiming().delay ?? 0,
          ),
      )
      .toBeLessThanOrEqual(-3000);
    const resumed = await toast
      .locator(".toast-countdown-fill")
      .evaluate((fill) => {
        const animation = fill.getAnimations()[0];
        animation.pause();
        // Native animation time and Playwright's clock advance independently.
        // Inspect the restart at time zero to verify its preserved elapsed offset.
        animation.currentTime = 0;
        return {
          progress: animation.effect!.getComputedTiming().progress,
          elapsed: -animation.effect!.getTiming().delay,
        };
      });
    expect(resumed.elapsed).toBeGreaterThanOrEqual(3000);
    expect(resumed.progress).toBeCloseTo(resumed.elapsed / 6000, 3);
    await page.screenshot({ path: info.outputPath("message-countdown.png") });
    await expectCountdownAt(page, 6000, 1);
    const remaining = await page.evaluate(
      (deadline) => deadline - performance.now(),
      deadline,
    );
    await page.clock.fastForward(remaining - 1);
    await expect(toast).toHaveText("Planungslink kopiert.");
    await page.clock.fastForward(1);
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
    await expectFeedbackPosition(page, width);
  });

for (const status of ["searching", "complete"])
  test(`readiness lasts exactly three seconds when search is ${status}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await publish(page, { phase: "base", ids: ["first"], status });
    const toast = page.locator("#toast");
    await expect(toast).toHaveAttribute("data-planning-stage", "ready");
    await expect(toast.locator(".toast-countdown")).toBeHidden();
    await page.clock.fastForward(1500);
    if (status === "searching")
      await publish(page, { phase: "walking", ids: ["first"] });
    await page.clock.fastForward(1499);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-planning-stage", "ready");
    await page.clock.fastForward(1);
    if (status === "complete") await expect(toast).toBeHidden();
    else {
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
      await expect(toast).toHaveText("Routenoptimierung läuft …");
    }
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
  });

test("mobile search switches directly to optimization without shifting the sheet header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true);
  await page.clock.fastForward(7000);
  await expect(page.locator("#search-preview")).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden();
  await publish(page, { phase: "base", ids: ["first"] });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await showConnections(page);
  await expectFeedbackPosition(page, 390);
  const header = await page.locator(".alternatives-header").boundingBox();
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await expect(page.locator("#toast")).toHaveText("Routenoptimierung läuft …");
  await expect(page.locator("#toast .planning-toast-spinner")).toHaveCSS(
    "animation-name",
    "route-loading",
  );
  await expectFeedbackPosition(page, 390);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#toast .planning-toast-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await publish(page, { phase: "walking", ids: ["first"] });
  await page.clock.fastForward(7000);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await publish(page, { phase: "walking", ids: ["first"], status: "complete" });
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#planning-announcement")).toHaveText(
    "Routenoptimierung abgeschlossen.",
  );
  expect(
    (await page.locator(".alternatives-header").boundingBox())!.height,
  ).toBe(header!.height);
  await expect(page.locator("#toast")).toBeHidden();
});

for (const target of ["editor", "history"])
  test(
    "leaving for " + target + " hides feedback and resumes only optimization",
    async ({ page }) => {
      await open(page);
      await publish(page, { phase: "base", ids: ["first"] });
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "ready",
      );
      await page
        .locator(target === "editor" ? "#adjust-route" : "#tab-history")
        .click();
      await expect(page.locator("#toast")).toBeHidden();
      await publish(page, { phase: "walking", ids: ["first"] });
      await page
        .locator(target === "editor" ? "#cancel-adjust" : "#tab-route")
        .click();
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "optimizing",
      );
    },
  );

test("user messages take priority over searching and readiness toasts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await open(page, true);
  await publish(page, { phase: "base", ids: ["first"], status: "complete" });
  const readinessCountdown = await page
    .locator("#toast .toast-countdown")
    .elementHandle();
  await page.locator("#route-more").click();
  await page.locator("#share-plan").click();
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  expect(
    await readinessCountdown!.evaluate((element) => element.isConnected),
  ).toBe(false);
  await expect(page.locator("#toast .toast-countdown")).toHaveCount(1);
  await expect(page.locator("#toast .toast-countdown-fill")).toHaveCSS(
    "animation-duration",
    "6s",
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toBeVisible();
  await expect(page.locator("#status")).toHaveText(
    "Verbindungen werden gesucht …",
  );
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await publish(page, { phase: "base", ids: ["new"] });
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await page.clock.fastForward(3000);
  await expect(page.locator("#toast")).toHaveText("Routenoptimierung läuft …");
});

test("partial optimization keeps retry reachable across map and details during a server pause", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true);
  await publish(page, { phase: "via", ids: ["first"] });
  await showMap(page);
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    incompletePhases: ["bike-transfers"],
    issues: ["Der Dienst bittet um eine Pause."],
  });
  await expect(page.locator("#issues")).toBeEmpty();
  await expect(page.locator("#map-preview-status")).toBeHidden();
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    status: "partial",
    incompletePhases: ["walking"],
    issues: ["Der Dienst bittet um eine Pause."],
    retryAt: await page.evaluate(() => Date.now() / 1000 + 60),
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "error",
  );
  await expect(page.locator("#toast .planning-toast-message")).toHaveText(
    "Routenoptimierung: Anfragelimit des Dienstes erreicht.",
  );
  await expect(page.locator("#map-preview-status")).toBeHidden();
  await expect(page.locator("#toast #recover-planning")).toBeVisible();
  await expectRetryIcon(page);
  await expectFeedbackPosition(page, 390);
  await expect(page.locator("#recover-planning")).toBeVisible();
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await expect(page.locator("#recovery-wait")).toBeVisible();
  const cooldown = await page.locator("#recovery-wait").boundingBox();
  const button = await page.locator("#recover-planning").boundingBox();
  expect(cooldown!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#toast .planning-toast-message")).toHaveText(
    "Routenoptimierung: Anfragelimit des Dienstes erreicht.",
  );
  await expect(page.locator("#toast #recover-planning")).toBeVisible();
  await expectFeedbackPosition(page, 390);
  await expect(page.locator("#issues")).toBeHidden();
  await page.clock.fastForward(60_100);
  await expect(page.locator("#recover-planning")).toBeEnabled();
  await expect(page.locator("#recovery-wait")).toBeHidden();
  await expectRetryIcon(page);
  await expectFeedbackPosition(page, 390);
});

for (const [cause, message] of [
  [
    "Suche nach weiteren Rad-Umstiegen: Zeitlimit erreicht.",
    "Routenoptimierung: Zeitlimit erreicht",
  ],
  [
    "Prüfung kürzerer Fußwege: Anfragelimit erreicht.",
    "Routenoptimierung: Anfragelimit erreicht.",
  ],
  [
    "Verbindung zum Dienst fehlgeschlagen.",
    "Routenoptimierung nicht vollständig.",
  ],
] as const)
  test(
    "partial search shows " + message + " once across views",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      await open(page);
      await publish(page, {
        phase: "bike-transfers",
        ids: ["first"],
        status: "partial",
        incompletePhases: ["bike-transfers"],
        issues: [cause, cause],
      });
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await expect(page.locator("#issues")).toBeHidden();
      await expect(page.locator("#recover-planning")).toBeEnabled();
      await expectRetryIcon(page);
      await openSelectedDetails(page);
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await showMap(page);
      await expect(page.locator("#map-preview-status")).toBeHidden();
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#toast #recover-planning")).toBeVisible();
      await expectFeedbackPosition(page, 390);
      await expect(page.locator("#recover-planning")).toBeVisible();
      await page.context().setOffline(true);
      await expect(page.locator("#recover-planning")).toBeDisabled();
      await page.context().setOffline(false);
      await expect(page.locator("#recover-planning")).toBeEnabled();
      // Continue the same calculation; current results remain usable.
      await page.locator("#recover-planning").click();
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "optimizing",
      );
      await expect(page.locator("#toast")).toHaveText(
        "Routenoptimierung läuft …",
      );
      await expect(page.locator("#journey-panel")).not.toHaveClass(
        /is-loading/,
      );
      await expect(page.locator("#stale-notice")).toBeHidden();
      await expect(page.locator("#navigation-start")).toBeEnabled();
      await publish(page, {
        phase: "base",
        ids: ["retried"],
        status: "complete",
      });
      await expect(page.locator("#toast")).toBeHidden();
      await expect(page.locator("#stale-notice")).toBeHidden();
      await expect(page.locator("#status")).toBeEmpty();
      await expect(
        page.locator('.route-choice[aria-pressed="true"]'),
      ).toHaveAttribute("data-journey", "first");
    },
  );

for (const width of [390, 1280])
  test(`continuation preserves open details and reading position at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await open(page);
    await publish(page, {
      phase: "walking",
      ids: ["first", "chosen"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Zeitlimit erreicht"],
    });
    await showConnections(page);
    await page.locator('.route-choice[data-journey="chosen"]').click();
    await openSelectedDetails(page);
    await expectMotionSettled(page.locator("#panel-details"));
    await expectMotionSettled(page.locator("#alternatives-dialog"));
    const position = await page.evaluate(() => {
      const panel = document.getElementById("journey-panel")!;
      const container = document.querySelector("#alternatives-dialog[open]")
        ? document.getElementById("alternatives-body")!
        : panel.classList.contains("result-scroll-all")
          ? panel
          : document.getElementById("panel-content")!;
      container.scrollTop = 100;
      return {
        scrollTop: container.scrollTop,
        headingTop: document
          .getElementById("journey-heading")!
          .getBoundingClientRect().top,
      };
    });
    expect(position.scrollTop).toBeGreaterThan(0);
    // Start continuation without scrolling the inline action back into view.
    // The assertion covers background updates while the user reads the details.
    await page
      .locator("#recover-planning")
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(page.locator("#stale-notice")).toBeHidden();
    await publish(page, {
      phase: "walking",
      ids: ["improved"],
      status: "complete",
    });
    await expect(page.locator("#toast")).toBeHidden();
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(
      page.locator('.route-choice[aria-pressed="true"]'),
    ).toHaveAttribute("data-journey", "chosen");
    // Browser anchoring may adjust scrollTop when alternatives above the details change.
    const headingTop = await page
      .locator("#journey-heading")
      .evaluate((element) => element.getBoundingClientRect().top);
    // Scrolling can round the fractional inline row heights to device pixels.
    expect(Math.abs(headingTop - position.headingTop)).toBeLessThanOrEqual(1);
  });

test("completed search keeps errors out of the result area", async ({
  page,
}) => {
  await open(page);
  await publish(page, { phase: "base", ids: ["first"] });
  await publish(page, { phase: "base", ids: ["first"], status: "complete" });
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#status")).toBeHidden();
  await showMap(page);
  const status = page.locator(
    (await page.evaluate(() => innerWidth < 900))
      ? "#map-preview-status"
      : "#status",
  );
  await expect(status).toBeHidden();
});

test("failure before any result shows the original error without readiness", async ({
  page,
}) => {
  await open(page);
  await publish(page, {
    phase: "base",
    error: "Der Dienst konnte die Anfrage nicht beantworten.",
  });
  await expect(page.locator("#status")).toHaveText(
    "Der Dienst konnte die Anfrage nicht beantworten.",
  );
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#recover-planning")).toBeEnabled();
  await expect(page.locator("#recovery-label")).not.toHaveClass(/sr-only/);
  await expect(page.locator("#recover-planning .recovery-icon")).toBeHidden();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator(".route-choice")).toHaveCount(0);
});

for (const width of [320, 1280])
  test(`optimization error persists and resumes after another toast at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    if (width === 320)
      await page.addStyleTag({ content: "html { font-size: 24px; }" });
    await publish(page, {
      phase: "walking",
      ids: ["first"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Prüfung kürzerer Fußwege: Zeitlimit erreicht."],
    });
    const toast = page.locator("#toast");
    const retry = page.locator("#recover-planning");
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expectRetryIcon(page);
    await expectFeedbackPosition(page, width);
    await page.evaluate(() => {
      (window as any).errorToastMutations = 0;
      new MutationObserver((records) => {
        (window as any).errorToastMutations += records.length;
      }).observe(document.getElementById("toast")!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.context().setOffline(true);
    await expect(retry).toBeDisabled();
    await page.context().setOffline(false);
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => (window as any).errorToastMutations)).toBe(
      0,
    );
    await retry.focus();
    await page.clock.fastForward(15000);
    await expect(retry).toBeFocused();
    await expect(toast).toBeVisible();
    await page.screenshot({ path: info.outputPath("optimization-error.png") });
    await page.locator("#route-more").click();
    await expect(toast).toBeHidden();
    await page.locator("#route-actions-close").click();
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expect(page.locator("#route-more")).toBeFocused();
    await page.locator("#route-more").click();
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expect(page.locator("#status")).toHaveText(
      "Routenoptimierung: Zeitlimit erreicht",
    );
    await expect(retry).toBeVisible();
    await expect(page.locator("#toast #recover-planning")).toHaveCount(0);
    await expect(page.locator("#recovery-label")).not.toHaveClass(/sr-only/);
    await expect(retry.locator(".recovery-icon")).toBeHidden();
    await retry.focus();
    await page.clock.fastForward(6100);
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expect(retry).toBeFocused();
    await expectRetryIcon(page);
    await expect(page.locator("#status")).toBeEmpty();
    await expectFeedbackPosition(page, width);
    await retry.click();
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(page.locator("#toast #recover-planning")).toHaveCount(0);
    await publish(page, { phase: "base", ids: ["new"], status: "complete" });
    await expect(toast).toBeHidden();
  });

for (const key of ["Enter", "Space"])
  test(`retry icon continues optimization once with ${key}`, async ({
    page,
    browserName,
  }) => {
    await open(page);
    await publish(page, {
      phase: "walking",
      ids: ["first"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Prüfung kürzerer Fußwege: Zeitlimit erreicht."],
    });
    await expectRetryIcon(page);
    const retry = page.getByRole("button", {
      name: "Erneut versuchen",
      exact: true,
    });
    await page.locator("#tab-settings").focus();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(retry).toBeFocused();
    await expect(retry).toHaveCSS("outline-style", "solid");
    await retry.press(key);
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
    expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(
      2,
    );
    await publish(page, {
      phase: "base",
      ids: ["retried"],
      status: "complete",
    });
    await expect(page.locator("#toast")).toBeHidden();
    expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(
      2,
    );
  });
