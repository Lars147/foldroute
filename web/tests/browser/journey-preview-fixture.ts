import type { Page } from "./test";

export async function preview(page: Page) {
  // Isolate the component: the application entrypoint would create a second
  // JourneyView with competing resize/focus observers on these same elements.
  await page.route("**/src/main.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'import "/src/style.css"; import { icon } from "/src/ui.ts"; document.querySelectorAll("[data-icon]").forEach(element => element.append(icon(element.dataset.icon)));',
    }),
  );
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/src/journey-view.ts";
    const { JourneyView } = await import(path);
    const from = { name: "Start", detail: "", latitude: 48, longitude: 11 };
    const to = { ...from, name: "Ziel", latitude: 48.1 };
    const departure = Date.parse("2026-09-11T08:00:00Z") / 1000;
    const makeJourney = (id: string, duration: number, direct = false) => ({
      id,
      origin: from,
      destination: to,
      departure,
      arrival: departure + duration * 60,
      transfers: direct ? 0 : 1,
      isDirect: direct,
      legs: (direct
        ? [["bike", duration]]
        : [
            ["bike", 10],
            ["fold", 2],
            ["transit", duration - 20],
            ["unfold", 2],
            ["bike", 4],
            ["walk", 2],
          ]
      ).map(([kind, minutes]) => ({
        kind,
        from,
        to,
        start: departure,
        end: departure + Number(minutes) * 60,
        distance: 1000,
        coordinates: [from, to],
      })),
    });
    const journeys = [
      makeJourney("best", 50),
      makeJourney("selected", 55),
      makeJourney("third", 60),
      makeJourney("comparison", 65, true),
    ];
    const state = {
      journeys,
      selected: journeys[1],
      request: {
        origin: from,
        destination: to,
        timing: "now",
        time: departure,
      },
      queriedAt: departure,
      busy: false,
      locating: false,
      message: "",
      issues: [],
      restored: false,
    };
    const view = new JourneyView((id: string) => {
      state.selected = state.journeys.find((j) => j.id === id)!;
      view.render(state, 30);
    });
    view.onDetailsOpened = () => {
      document.body.dataset.detailOpens = String(
        Number(document.body.dataset.detailOpens ?? 0) + 1,
      );
    };
    (window as any).uxPreview = { state, view };
    document.body.dataset.view = "map";
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    // Main owns start availability. Mount a ready footer for these isolated
    // JourneyView layout checks; planner tests exercise the actual transitions.
    document.querySelector<HTMLElement>(".panel-actions")!.hidden = false;
    document.getElementById("navigation-start")!.hidden = false;
    view.render(state, 30);
  });
}
