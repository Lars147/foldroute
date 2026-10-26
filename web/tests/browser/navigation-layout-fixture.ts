import type { Page } from "@playwright/test";
import { now, stationJourney } from "./navigation-fixture";
import type { Journey, TransitStop } from "../../src/model";
import type { NavigationProgress } from "../../src/navigation-engine";
import { transitStopKey } from "../../src/transit-stops";

interface LayoutOptions {
  time?: number;
  journey?: Journey;
  progress?: Partial<NavigationProgress>;
  theme?: "light" | "dark";
  automaticLocation?: boolean;
  audioEnabled?: boolean;
}

// Layout starts at a prepared state; integration tests drive the actual session
// through GPS, timers, storage and application navigation.
export async function mountNavigationFixture(
  page: Page,
  legIndex = 2,
  options: LayoutOptions = {},
) {
  await page.clock.setFixedTime(
    new Date((options.time ?? now + (legIndex === 2 ? 302 : 0)) * 1000),
  );
  if (options.theme)
    await page.addInitScript(
      (theme) => localStorage.setItem("foldroute.appearance", theme),
      options.theme,
    );
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'import "/src/style.css";',
    }),
  );
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ journey, legIndex, options }) => {
      const { NavigationView } = await import("/src/navigation-ui.ts");
      const { NavigationSession } = await import("/src/navigation-session.ts");
      const { NavigationEngine, navigationJourney } =
        await import("/src/navigation-engine.ts");
      const { ApiClient } = await import("/src/transitous.ts");
      const { defaults } = await import("/src/model.ts");
      const view = new NavigationView(
        () => {},
        () => {},
        {
          audioEnabled: options.audioEnabled,
          locationAutoRefresh: () => !!options.automaticLocation,
        },
      );
      const session = new NavigationSession({
        changed: () => view.render(),
        locate: async () => {
          throw new Error("Layout fixture must not request GPS");
        },
        resumeEnabled: () => false,
        statisticsEnabled: () => false,
        api: new ApiClient(),
      });
      const showLeg = (index: number) => {
        session.engine = new NavigationEngine(navigationJourney(journey), {
          legIndex: index,
          maneuverIndex: 0,
          meters: 0,
          confirmedStops: [],
          ...options.progress,
        });
        view.render();
      };
      const setLocation = (state: "missing" | "inaccurate" | "current") => {
        const from = session.engine!.leg.from;
        session.updateLocation(
          state === "missing"
            ? undefined
            : {
                latitude: from.latitude,
                longitude: from.longitude,
                accuracy: state === "inaccurate" ? 500 : 10,
                timestamp: Date.now(),
                heading: 90,
              },
          state === "missing" ? undefined : state,
        );
      };
      showLeg(legIndex);
      session.settings = defaults;
      session.request = {
        origin: journey.origin,
        destination: journey.destination,
        timing: "now",
        time: journey.departure,
      };
      document.getElementById("search-view")!.hidden = true;
      document.body.dataset.view = "navigation";
      (window as any).navigationFixture = {
        view,
        session,
        showLeg,
        setLocation,
      };
      await view.show(session);
    },
    { journey: options.journey ?? stationJourney(), legIndex, options },
  );
}

/** Synthetic long-trip and cancellation fixtures, available only to tests. */
export async function mountTransitFixture(
  page: Page,
  options: {
    longTrip?: boolean;
    cancellation?: "trip" | "boarding" | "alighting";
    estimated?: boolean;
    theme?: "light" | "dark";
  } = {},
) {
  const boarding = options.cancellation === "boarding";
  const time = now + (boarding ? 0 : 302);
  const start = boarding
    ? time + 300
    : time - (options.longTrip ? 20 * 120 + 135 : 60);
  const names = [
    "Ostbahnhof",
    "Rosenheimer Platz",
    "Isartor",
    "Marienplatz",
    "Karlsplatz",
    "Hauptbahnhof",
    "Hackerbrücke",
    "Donnersbergerbrücke",
    "Hirschgarten",
    "Laim",
    "Pasing",
  ];
  const stops: TransitStop[] = Array.from(
    { length: options.longTrip ? 41 : 11 },
    (_, i) => ({
      name: options.longTrip
        ? i % 4 === 0
          ? names[i / 4]
          : `Testhalt ${String(Math.floor(i / 4) * 3 + (i % 4)).padStart(2, "0")}`
        : names[i],
      latitude: 48.13,
      longitude: 11.6 - i * 0.003,
      detail: "",
      stopId: `layout-${i}`,
      arrival: start + i * 120 + (i ? 60 : 0),
      departure: start + i * 120 + (i ? 90 : 0),
      cancelled:
        (boarding && i === 0) ||
        (options.cancellation === "alighting" &&
          i === (options.longTrip ? 40 : 10)),
    }),
  );
  const origin = stops[0],
    destination = stops.at(-1)!;
  const end = destination.arrival!;
  const journey: Journey = {
    id: "transit-layout",
    origin,
    destination,
    departure: start - 180,
    arrival: end + 180,
    isDirect: false,
    transfers: 0,
    legs: [
      {
        kind: "fold",
        from: origin,
        to: origin,
        start: start - 180,
        end: start,
        distance: 0,
        coordinates: [origin],
      },
      {
        kind: "transit",
        mode: "SUBURBAN",
        from: origin,
        to: destination,
        start,
        end,
        distance: 11200,
        coordinates: stops,
        line: "S8",
        headsign: "Herrsching",
        platform: "11",
        arrivalPlatform: "5",
        realtime: true,
        transitStops: stops,
        transitStatus: {
          updatedAt: time,
          ...(options.cancellation
            ? { cancelled: true, cancellationReason: options.cancellation }
            : {}),
        },
      },
      {
        kind: "unfold",
        from: destination,
        to: destination,
        start: end,
        end: end + 180,
        distance: 0,
        coordinates: [destination],
      },
    ],
  };
  const index = options.longTrip ? 20 : 0;
  await mountNavigationFixture(page, boarding ? 0 : 1, {
    journey,
    time,
    theme: options.theme ?? "dark",
    automaticLocation: true,
    audioEnabled: false,
    progress: {
      transitStop: transitStopKey(stops, index),
      transitDepartedStop: options.longTrip
        ? transitStopKey(stops, index)
        : undefined,
    },
  });
  await page.evaluate(
    ({ options, point }) => {
      const { session, view } = (window as any).navigationFixture;
      const update = (timestamp = Date.now()) => {
        if (!options.estimated)
          session.updateLocation(
            { ...point, accuracy: 10, timestamp, heading: 270 },
            "current",
          );
        view.render();
      };
      update(Date.now() - 1000);
      update();
      setInterval(update, 1000);
    },
    {
      options,
      point: {
        latitude: stops[index].latitude,
        longitude: stops[index].longitude - (options.longTrip ? 0.0015 : 0),
      },
    },
  );
  // The warning belongs to the real session/UI, not a standalone demo entrypoint.
  await page.evaluate(async () => {
    const { session, view } = (window as any).navigationFixture;
    const { transitDisruption } = await import("/src/transit-refresh.ts");
    session.disruption = transitDisruption(
      session.engine.journey,
      session.engine.progress.legIndex,
      Date.now() / 1000,
    );
    view.render();
  });
  if (options.longTrip)
    await page.locator("#navigation-details-toggle").click();
}
