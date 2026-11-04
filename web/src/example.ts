import type { AppPresentation } from "./app-presentation";
import { exampleRecording } from "./example-data";
import { JourneyView, type JourneyNavigation } from "./journey-view";
import { RouteMap } from "./map-view";
import type { PlanningState } from "./planning-state";
import { el, icon } from "./ui";

export function startExample(presentation: AppPresentation): Promise<void> {
  // This entrypoint deliberately does not initialize planning, location or journey storage.
  document.title = "FoldRoute · Beispielroute";
  document.body.dataset.view = "map";
  document.body.dataset.example = "bike-transfer";
  el("search-view").hidden = true;
  presentation.workspace.setHidden("map-view", false);
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
    if (!element.querySelector("svg"))
      element.append(icon(element.dataset.icon!));
  });
  document.querySelector<HTMLElement>(".app-tabs")!.hidden = true;

  const { journey, request, settings } = exampleRecording;
  const state: PlanningState = {
    journeys: [journey],
    selected: journey,
    request,
    resultSettings: settings,
    queriedAt: 0,
    busy: false,
    locating: false,
    restored: false,
    message: "",
    issues: [],
  };
  const routeMap = new RouteMap(
    () => {},
    () => {},
    presentation.workspace,
  );
  const journeyView = new JourneyView(
    () => {},
    "example",
    presentation.workspace,
  );
  function drawMap() {
    if (journeyView.mapVisible)
      routeMap.show(
        [journey],
        journey,
        navigator.onLine,
        "example-bike-transfer",
      );
  }
  function saveScreen(push = false) {
    history[push ? "pushState" : "replaceState"](
      { exampleView: journeyView.snapshot() },
      "",
    );
  }
  journeyView.onLayoutChange = drawMap;
  let sheetHistoryClosing = false;
  journeyView.onPositionChange = () => {
    if (!sheetHistoryClosing) saveScreen();
  };
  journeyView.onSheetChange = (action) => {
    if (action === "open") {
      const base = journeyView.snapshot();
      delete base.sheet;
      history.replaceState({ exampleView: base }, "");
      saveScreen(true);
    } else if (action === "close" && history.state?.exampleView?.sheet) {
      sheetHistoryClosing = true;
      history.back();
    } else saveScreen();
  };
  window.addEventListener("popstate", (event) => {
    const closing =
      (sheetHistoryClosing || journeyView.sheetOpen) &&
      !event.state?.exampleView?.sheet;
    sheetHistoryClosing = false;
    journeyView.restoreNavigation(
      event.state?.exampleView as JourneyNavigation | undefined,
      !closing,
    );
    if (closing) journeyView.focusSheetTrigger();
    saveScreen();
  });
  for (const event of ["online", "offline"])
    window.addEventListener(event, drawMap);

  presentation.workspace.setCommand("map-route", () => routeMap.fitRoute());
  presentation.workspace.setAttribute(
    "close-route",
    "aria-label",
    "Zur Landingpage",
  );
  presentation.workspace.setCommand("close-route", () =>
    location.assign(new URL("../#idee", location.href)),
  );

  journeyView.render(state, settings.maxCyclingMinutes);
  journeyView.restoreNavigation(
    history.state?.exampleView as JourneyNavigation | undefined,
  );
  saveScreen();
  requestAnimationFrame(() => journeyView.focusSelection());

  return Promise.resolve();
}
