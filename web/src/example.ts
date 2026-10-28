import { exampleRecording } from "./example-data";
import { JourneyView, type JourneyNavigation } from "./journey-view";
import { RouteMap } from "./map-view";
import type { PlanningState } from "./planning-state";
import { el, icon, node } from "./ui";
import { renderRequestStops } from "./route-request";

export const startupReady = Promise.resolve();

// This entrypoint deliberately does not initialize planning, location or journey storage.
document.title = "FoldRoute · Beispielroute";
document.body.dataset.view = "map";
document.body.dataset.example = "bike-transfer";
el("search-view").hidden = true;
el("map-view").hidden = false;
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
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
);
const journeyView = new JourneyView(() => {}, "example");
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

const places = node("div", "", "route-request example-route-request");
const names = node("span", "", "route-request-places");
const chain = node("span", "", "route-request-chain");
const origin = node("span", "", "route-request-point route-request-origin");
const originSymbol = node("span", "", "route-request-marker");
originSymbol.setAttribute("aria-hidden", "true");
const originMarker = node("span", "", "route-origin-marker");
originSymbol.append(originMarker);
origin.append(
  originSymbol,
  node("span", request.origin.name, "example-origin"),
);
const stops = node("span", "", "route-request-stops");
renderRequestStops(stops, request.stops);
const destination = node(
  "span",
  "",
  "route-request-point route-request-destination",
);
const destinationSymbol = node("span", "", "route-request-marker");
destinationSymbol.setAttribute("aria-hidden", "true");
const destinationMarker = icon("flag");
destinationMarker.classList.add("route-destination-marker");
destinationSymbol.append(destinationMarker);
destination.append(
  destinationSymbol,
  node("span", request.destination.name, "example-destination"),
);
chain.append(origin, stops, destination);
names.append(chain);
places.append(names);
el("adjust-route").before(places);

el("map-route").onclick = () => routeMap.fitRoute();
el("close-route").setAttribute("aria-label", "Zur Landingpage");
el("close-route").onclick = () =>
  location.assign(new URL("../#idee", location.href));

journeyView.render(state, settings.maxCyclingMinutes);
journeyView.restoreNavigation(
  history.state?.exampleView as JourneyNavigation | undefined,
);
saveScreen();
requestAnimationFrame(() => journeyView.focusSelection());
