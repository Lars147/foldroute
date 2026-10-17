import { exampleRecording } from "./example-data";
import { JourneyView, type JourneyNavigation } from "./journey-view";
import { RouteMap } from "./map-view";
import type { PlanningState } from "./planning-state";
import { el, icon, node } from "./ui";

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
journeyView.onPositionChange = () => saveScreen();
journeyView.onNavigate = (screen, replace) => {
  if (
    replace &&
    screen === "detail" &&
    journeyView.screen === "map" &&
    journeyView.backScreen === "detail"
  ) {
    history.back();
    return;
  }
  saveScreen();
  journeyView.showScreen(screen);
  saveScreen(!replace);
};
journeyView.onBack = () => history.back();
window.addEventListener("popstate", (event) => {
  journeyView.restoreNavigation(
    event.state?.exampleView as JourneyNavigation | undefined,
    true,
  );
});
for (const event of ["online", "offline"])
  window.addEventListener(event, drawMap);

const places = node("div", "", "route-request example-route-request");
const names = node("span", "", "route-request-places");
const originMarker = node("span", "", "route-origin-marker");
originMarker.setAttribute("aria-hidden", "true");
const destinationMarker = icon("flag");
destinationMarker.classList.add("route-destination-marker");
destinationMarker.setAttribute("aria-hidden", "true");
names.append(
  originMarker,
  node("span", request.origin.name, "example-origin"),
  destinationMarker,
  node("span", request.destination.name, "example-destination"),
);
places.append(names);
el("adjust-route").before(places);

const sources = node("a", "Fahrtdaten");
sources.href = "https://transitous.org/sources/";
document.querySelector(".map-credit")!.append(sources);
el("map-route").onclick = () => routeMap.fitRoute();
el("close-route").setAttribute("aria-label", "Zur Landingpage");
el("close-route").onclick = () =>
  location.assign(
    import.meta.env.DEV ? "/landing/#idee" : new URL("../#idee", location.href),
  );

journeyView.render(state, settings.maxCyclingMinutes);
journeyView.restoreNavigation(
  history.state?.exampleView as JourneyNavigation | undefined,
);
saveScreen();
requestAnimationFrame(() => journeyView.focusSelection());
