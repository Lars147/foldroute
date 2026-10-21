import type { Page } from "@playwright/test";
import { now, stationJourney } from "./navigation-fixture";

// Layout starts at a prepared state; integration tests drive the actual session
// through GPS, timers, storage and application navigation.
export async function previewNavigation(page: Page, legIndex = 2) {
  await page.clock.setFixedTime(
    new Date((now + (legIndex === 2 ? 302 : 0)) * 1000),
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
    async ({ journey, legIndex }) => {
      const { NavigationView } = await import("/src/navigation-ui.ts");
      const { NavigationSession } = await import("/src/navigation-session.ts");
      const { NavigationEngine, navigationJourney } =
        await import("/src/navigation-engine.ts");
      const { ApiClient } = await import("/src/transitous.ts");
      const { defaults } = await import("/src/model.ts");
      const view = new NavigationView(
        () => {},
        () => {},
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
      (window as any).navigationPreview = {
        view,
        session,
        showLeg,
        setLocation,
      };
      await view.show(session);
    },
    { journey: stationJourney(), legIndex },
  );
}
