import { HistorySwipe } from "./history-swipe";
import { HistoryUndo } from "./history-undo";
import { HistoryNameQueue } from "./history-names";
import { historySnapshot } from "./offline";
import { NavigationSession } from "./navigation-session";
import { NavigationView } from "./navigation-ui";
import { NavigationStore, type NavigationSnapshot } from "./navigation-store";
import { audioPreferenceKey } from "./navigation-guidance";
import { ScreenAwake } from "./screen-awake";
import { LiveLocation, fixPlace } from "./live-location";
import { TimePicker, timeSummary } from "./time-picker";
import { StopEditor } from "./stop-editor";
import "./style.css";
import {
  defaults,
  ranges,
  modes,
  validSettings,
  migrateSettings,
  errorText,
  type RoutingSettings,
  type RouteRequest,
  type RouteStop,
  type Place,
  type Timing,
} from "./model";
import { ApiClient } from "./transitous";
import { PlaceSearch, locate, clearSearchLocation } from "./search";
import { PlanningSession, type PlanningState } from "./planning-state";
import { RouteMap } from "./map-view";
import { JourneyView, type JourneyNavigation } from "./journey-view";
import {
  OfflineStore,
  sameHistoryRoute,
  type SavedJourney,
  type HistoryEntry,
} from "./offline";
import {
  el,
  node,
  icon,
  localDate,
  clock,
  dateLabel,
  historyPlannedAt,
} from "./ui";
import { setupPWA } from "./pwa";
import { PlaceBook } from "./places";
import { localDatabase } from "./storage";
import {
  readRouteURL,
  routeURL,
  type RouteLink,
  type ParsedRouteLink,
} from "./route-url";

type View = "search" | "map" | "settings" | "history";
let historyEntries: HistoryEntry[] = [];
let historyMutationPending = false;
const historySwipe = new HistorySwipe(el("history-list"));
const historyUndo = new HistoryUndo(
  el("history-undo"),
  el<HTMLButtonElement>("history-undo-button"),
);
let openedHistoryId: string | undefined;
const suppressedCalculations = new Set<string>();
let currentSaveSuppressed = false;
let sharingPlan = false;
let planningWasBusy = false;
let navigationRevision = 0;
let view: View = "search",
  settings: RoutingSettings = structuredClone(defaults);
let settingsReplanPending = false;
let personalSettings: RoutingSettings;
let temporarySettings = false;
let activePlan: RouteLink | undefined;
let activePlanId: string | undefined;
const planResults = new Map<
  string,
  { plan: RouteLink; state: PlanningState; settingsReplanPending: boolean }
>();
const navigationRestoreRequested = history.state?.navigation === true;
const initialLink = readRouteURL(new URL(location.href));
let originOverride: Place | undefined,
  timing: Timing = "now",
  time = Date.now() / 1000;
let stops: RouteStop[] = [];
let storageGeneration = 0;
let saved: SavedJourney | undefined,
  offlineEnabled = true,
  persistKey = "",
  activeSnapshot: SavedJourney | undefined;
let beforeSettings: View = "search",
  mapLocationRequest: AbortController | undefined;
const api = new ApiClient(),
  store = new OfflineStore(),
  book = new PlaceBook(),
  dialog = el<HTMLDialogElement>("adjust-dialog");
const screenAwakeKey = "foldroute.screenAwake";
let keepScreenAwake = true;
const storageKey = "foldroute.routing.v3";
const legacyStorageKey = "foldroute.routing.v1";
try {
  keepScreenAwake = localStorage.getItem(screenAwakeKey) !== "false";
  const current = localStorage.getItem(storageKey),
    legacy = localStorage.getItem(legacyStorageKey);
  const value = migrateSettings(JSON.parse(current ?? legacy ?? "null"));
  if (value) {
    settings = value;
    if (!current && legacy) {
      localStorage.setItem(storageKey, JSON.stringify(settings));
      localStorage.removeItem(legacyStorageKey);
    }
  }
} catch {
  el("storage-message").textContent =
    "Einstellungen gelten nur für diese Sitzung.";
}
personalSettings = structuredClone(settings);
document
  .querySelectorAll<HTMLElement>("[data-icon]")
  .forEach((element) => element.append(icon(element.dataset.icon!)));
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  el("toast").textContent = message;
  el("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el("toast").hidden = true), 6000);
}
const routeMap = new RouteMap(
  (id) => session.select(id),
  () => {},
);
let navigation: NavigationSession | undefined;
let navigationView: NavigationView | undefined;
const navigationStore = new NavigationStore();
let navigationLaunchGeneration = 0;
let navigationStart:
  | {
      journey: import("./model").Journey;
      request: RouteRequest;
      settings: RoutingSettings;
      restored?: NavigationSnapshot;
    }
  | undefined;
const liveLocation = new LiveLocation((fix, quality) => {
  routeMap.updateLocation(fix, quality);
  navigation?.updateLocation(fix, quality);
});
const historyAddressApi = new ApiClient();
const historyNames = new HistoryNameQueue(
  (coordinate, signal) => historyAddressApi.reversePlace(coordinate, signal),
  async (entry, names) => {
    const generation = storageGeneration;
    if (await store.updateNames(entry, names)) {
      if (generation === storageGeneration) await reloadHistory();
    }
  },
);
function syncHistoryNames() {
  historyNames.setActive(
    pagePresent && !document.hidden && navigator.onLine && offlineEnabled,
  );
  if (view === "history") historyNames.enqueue(historyEntries);
}
const screenAwake = new ScreenAwake();
let pagePresent = true;
function syncLiveLocation() {
  syncHistoryNames();
  const arrived =
    navigationView?.visible && navigation?.engine?.phase === "arrived";
  navigation?.setForeground(
    pagePresent && !document.hidden && !!navigationView?.visible,
  );
  screenAwake.setActive(
    keepScreenAwake &&
      !arrived &&
      pagePresent &&
      view === "map" &&
      !document.hidden &&
      !dialog.open,
  );
  liveLocation.setActive(
    pagePresent &&
      view === "map" &&
      (journeyView.mapVisible || !!navigationView?.visible) &&
      !document.hidden &&
      !dialog.open &&
      !arrived,
  );
}
function cancelMapCenter() {
  mapLocationRequest?.abort();
  mapLocationRequest = undefined;
  liveLocation.cancelCenter();
  el<HTMLButtonElement>("map-location").disabled = false;
}
routeMap.onManualMove = cancelMapCenter;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelMapCenter();
    navigationView?.pause();
  }
  syncLiveLocation();
});
window.addEventListener("pagehide", () => {
  pagePresent = false;
  navigationView?.pause();
  cancelMapCenter();
  syncLiveLocation();
});
window.addEventListener("pageshow", () => {
  pagePresent = true;
  syncLiveLocation();
});
const journeyView = new JourneyView((id) => session.select(id));
const session = new PlanningSession(api, renderPlanning, (request, options) => {
  openedHistoryId = undefined;
  activePlan = structuredClone({ request, settings: options });
  activePlanId ??= crypto.randomUUID();
  writeHistory();
});
journeyView.onDetailsOpened = () => session.holdSelection();
journeyView.onLayoutChange = () => {
  if (!journeyView.mapVisible) cancelMapCenter();
  syncLiveLocation();
  if (view === "map" && journeyView.mapVisible) showRouteMap(session.state);
};
journeyView.onPositionChange = () => {
  if (view === "map" && history.state?.planId === activePlanId)
    history.replaceState(
      { ...history.state, journeyNavigation: journeyView.snapshot() },
      "",
    );
};
journeyView.onNavigate = (screen, replace) => {
  navigationRevision++;
  if (
    replace &&
    screen === "detail" &&
    journeyView.screen === "map" &&
    journeyView.backScreen === "detail" &&
    (history.state?.resultDepth ?? 0) > 0
  ) {
    history.back();
    return;
  }
  const depth = history.state?.resultDepth ?? 0;
  writeHistory();
  journeyView.showScreen(screen);
  writeHistory(!replace, replace ? depth : depth + 1);
};
journeyView.onBack = () => {
  if ((history.state?.resultDepth ?? 0) > 0) {
    history.back();
  } else if (journeyView.screen === "detail" && journeyView.savedOrigin) {
    history.back();
  } else {
    journeyView.showScreen(journeyView.backScreen);
    writeHistory();
  }
};
navigation = new NavigationSession({
  api,
  store: navigationStore,
  locate: () => liveLocation.center(true),
  storageEnabled: () => offlineEnabled,
  changed: () => {
    navigationView?.render();
    if (navigationView?.visible) {
      el<HTMLButtonElement>("update-now").disabled = true;
      if (navigation?.engine?.phase === "arrived") syncLiveLocation();
    }
  },
});
navigationView = new NavigationView(
  () => void endNavigation(),
  (replan) => void launchNavigation(replan),
);
el("navigation-locate").onclick = async () => {
  if (!navigation!.engine) {
    await launchNavigation();
    return;
  }
  const engine = navigation!.engine;
  const generation = navigationLaunchGeneration;
  try {
    await liveLocation.center(true);
    if (
      generation !== navigationLaunchGeneration ||
      navigation!.engine !== engine
    )
      return;
    navigation!.message = "";
    await navigation!.resumeAlternativeAfterLocation();
    navigationView!.render();
  } catch (error) {
    if (
      generation !== navigationLaunchGeneration ||
      navigation!.engine !== engine
    )
      return;
    navigation!.message = errorText(error);
    navigationView!.render();
  }
};
async function launchNavigation(replan = false, restored?: NavigationSnapshot) {
  const generation = ++navigationLaunchGeneration;
  if (!navigationView!.visible) {
    const state = session.state;
    if (!restored && (!state.selected || !state.request)) return;
    navigationStart = restored
      ? { ...restored, restored }
      : {
          journey: structuredClone(state.selected!),
          request: structuredClone(state.request!),
          settings: structuredClone(state.resultSettings ?? settings),
        };
    settingsReplanPending = false;
    session.stop("");
    show("map", false);
    document.body.dataset.navigation = "active";
    el("map-view").hidden = true;
    history.pushState(
      { ...history.state, navigation: true },
      "",
      location.href,
    );
  }
  if (!navigationStart) return;
  try {
    const showing = navigationView!.show(navigation!);
    syncLiveLocation();
    await showing;
    if (generation !== navigationLaunchGeneration || !navigationView!.visible)
      return;
    const start = navigationStart;
    await navigation!.start(
      start.journey,
      start.request,
      start.settings,
      replan ? undefined : start.restored,
      replan,
    );
    navigationView!.render();
    el("navigation-instruction").focus({ preventScroll: true });
  } catch (error) {
    if (generation !== navigationLaunchGeneration) return;
    navigation!.message =
      error instanceof DOMException && error.name === "AbortError"
        ? "Navigationsstart unterbrochen. Bitte erneut versuchen."
        : errorText(error);
    navigation!.retryAvailable = !navigation!.distantStart;
    navigationView!.render();
  }
}
async function endNavigation() {
  navigationLaunchGeneration++;
  const journey = navigation?.engine?.journey;
  const request = navigation?.request;
  const options = navigation?.settings;
  navigationView!.hide();
  delete document.body.dataset.navigation;
  try {
    await navigation!.stop();
  } catch {
    toast(
      "Navigation beendet. Gespeicherter Zustand konnte nicht gelöscht werden.",
    );
  }
  if (journey && request && options) {
    activePlan = structuredClone({ request, settings: options });
    restorePlanContext(
      activePlan,
      temporarySettings || !!navigationStart?.restored,
    );
    session.restore(
      journey,
      activePlan.request,
      Date.now() / 1000,
      activePlan.settings,
    );
    settingsUI();
  }
  el("map-view").hidden = false;
  showRouteMap(session.state);
  journeyView.showScreen("detail", false);
  syncLiveLocation();
  writeHistory();
  renderPlanning(session.state);
  el("navigation-start").focus({ preventScroll: true });
}
el("navigation-start").onclick = () => void launchNavigation();

function updateLinkUI() {
  el("share-plan").hidden = !activePlan;
  el<HTMLButtonElement>("share-plan").disabled =
    session.state.locating || sharingPlan;
}
function writeHistory(
  push = false,
  resultDepth = push ? 0 : (history.state?.resultDepth ?? 0),
) {
  history[push ? "pushState" : "replaceState"](
    {
      view,
      planId: activePlanId,
      historyId: openedHistoryId,
      resultDepth,
      journeyNavigation: journeyView.snapshot(),
    },
    "",
    routeURL(location.href, activePlan),
  );
  el("plan-link-fallback").hidden = true;
  updateLinkUI();
}
function releasePlan() {
  openedHistoryId = undefined;
  activePlan = undefined;
  activePlanId = undefined;
  temporarySettings = false;
  settings = structuredClone(personalSettings);
  settingsUI();
}
function beginPlanning() {
  navigationRevision++;
  activePlan = undefined;
  activePlanId = crypto.randomUUID();
  settingsReplanPending = false;
  journeyView.reset();
  session.clear();
  activeSnapshot = undefined;
  persistKey = "";
  if (view === "map") writeHistory(true);
  else show("map");
  journeyView.focusSelection();
}
async function restoreLink(
  parsed: ParsedRouteLink,
  next: View = "map",
  id?: string,
) {
  journeyView.reset();
  settingsReplanPending = false;
  session.clear();
  activeSnapshot = undefined;
  persistKey = "";
  releasePlan();
  if (parsed.kind !== "plan") {
    originOverride = undefined;
    destination.set();
    stops = [];
    timing = "now";
    time = Date.now() / 1000;
    contextUI();
    show(next === "settings" || next === "history" ? next : "search", false);
    writeHistory();
    el("place-status").textContent =
      parsed.kind === "invalid"
        ? "Der Planungslink ist unvollständig oder ungültig. Bitte eine neue Route planen."
        : "";
    return;
  }
  activePlan = structuredClone(parsed.plan);
  activePlanId = id ?? crypto.randomUUID();
  temporarySettings = true;
  settings = structuredClone(activePlan.settings);
  const request = activePlan.request;
  originOverride = request.origin;
  destination.set(request.destination);
  stops = structuredClone(request.stops ?? []);
  timing = request.timing;
  time = request.time;
  settingsUI();
  contextUI();
  const previousResult = planResults.get(activePlanId);
  if (
    previousResult &&
    routeURL(location.href, previousResult.plan).href ===
      routeURL(location.href, activePlan).href
  ) {
    settingsReplanPending = previousResult.settingsReplanPending;
    session.restoreContext(previousResult.state);
    show(next === "settings" || next === "history" ? next : "map", false);
    if (view === "map") journeyView.focusSelection();
    writeHistory();
    return;
  }
  session.prepare(
    request,
    navigator.onLine
      ? ""
      : "Für diese Planung brauchst du Internet. Plane danach über „Route anpassen“ erneut.",
  );
  show(next === "settings" || next === "history" ? next : "map", false);
  if (view === "map") journeyView.focusSelection();
  writeHistory();
  if (next === "settings") {
    settingsReplanPending = true;
    return;
  }
  if (request.timing !== "now" && request.time < Date.now() / 1000) {
    const message =
      "Der Zeitpunkt dieses Links liegt in der Vergangenheit. Bitte einen neuen Zeitpunkt wählen.";
    session.stop(message);
    if (view === "map") {
      openAdjust(request.destination);
      el("adjust-status").textContent = message;
    }
    return;
  }
  if (navigator.onLine) await session.calculate(request, settings, false);
}
function show(next: View, push = true) {
  el<HTMLDialogElement>("route-actions-dialog").close();
  if (navigationView?.visible) {
    navigationView.confirmEnd();
    return;
  }
  if (push) navigationRevision++;
  const replan =
    view === "settings" &&
    next !== "settings" &&
    settingsReplanPending &&
    !!session.state.request;
  if (replan) updateSettingsReplanPending(false);
  if (view === next) {
    if (next === "map") requestAnimationFrame(() => routeMap.resize());
    return;
  }
  if (next !== "search") destination.cancel();
  if (next !== "map") {
    mapLocationRequest?.abort();
    el("map-location-error").hidden = true;
    el<HTMLButtonElement>("map-location").disabled = false;
  }
  view = next;
  syncLiveLocation();
  document.body.dataset.view = next;
  el("search-view").hidden = next !== "search";
  el("map-view").hidden = next !== "map";
  el("settings-view").hidden = next !== "settings";
  el("history-view").hidden = next !== "history";
  historySwipe.setActive(next === "history");
  for (const tab of ["route", "history", "settings"]) {
    const active =
      tab === "route" ? next === "search" || next === "map" : tab === next;
    if (active) el(`tab-${tab}`).setAttribute("aria-current", "page");
    else el(`tab-${tab}`).removeAttribute("aria-current");
  }
  if (push) writeHistory(true);
  if (next === "search") {
    destination.activate();
    updateSearchEmpty();
  }
  if (next === "map") {
    showRouteMap(session.state);
    requestAnimationFrame(() => routeMap.resize());
  }
  if (replan) void refreshRoute(false);
}
window.addEventListener("popstate", async (event) => {
  const revision = ++navigationRevision;
  const navigation = event.state?.journeyNavigation as
    JourneyNavigation | undefined;
  if (navigationView?.visible) {
    history.pushState(
      { ...history.state, navigation: true },
      "",
      location.href,
    );
    navigationView.confirmEnd();
    return;
  }
  if (dialog.open) closeAdjust();
  const next: View =
    event.state?.view === "history"
      ? "history"
      : event.state?.view === "settings"
        ? "settings"
        : event.state?.view === "search"
          ? "search"
          : "map";
  if (event.state?.historyId) {
    const entry = historyEntries.find(
      (item) => item.id === event.state.historyId,
    );
    if (entry) {
      if (openedHistoryId !== entry.id)
        openSnapshot(
          entry.snapshot,
          entry.id,
          false,
          next === "map",
          event.state.planId,
        );
      show(next, false);
      journeyView.restoreNavigation(navigation, next === "map");
    } else {
      show("history", false);
      toast("Diese gespeicherte Fahrt ist nicht mehr vorhanden.");
    }
    return;
  }
  if (event.state?.planId === activePlanId) {
    show(next === "map" && !session.state.request ? "search" : next, false);
    journeyView.restoreNavigation(navigation, next === "map");
    writeHistory();
  } else {
    await restoreLink(
      readRouteURL(new URL(location.href)),
      next,
      event.state?.planId,
    );
    if (revision !== navigationRevision) return;
    journeyView.restoreNavigation(navigation, next === "map");
    writeHistory();
  }
});
function historyUI() {
  if (historySwipe.deferRender(historyUI)) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusedId =
    focused?.closest<HTMLElement>(".history-row")?.dataset.historyId;
  const focusedRemove = focused?.classList.contains("history-remove");
  el("history-list").replaceChildren();
  el("history-empty").hidden = historyEntries.length > 0;
  el("history-empty").textContent = offlineEnabled
    ? "Noch keine Fahrten. Erfolgreiche Planungen werden hier automatisch gespeichert."
    : "Speicherung ausgeschaltet. Aktiviere sie in den Einstellungen, um deine nächsten Planungen zu behalten.";
  el<HTMLButtonElement>("delete-saved").disabled = !historyEntries.length;
  for (const entry of historyEntries) {
    const { journey, request } = historySnapshot(entry);
    const row = node("li", "", "history-row");
    row.dataset.historyId = entry.id;
    const open = node("button", "", "history-open");
    const origin =
      journey.origin.name === "Aktueller Standort"
        ? "Startpunkt"
        : journey.origin.name;
    const description = `Von ${origin} nach ${journey.destination.name}${request.stops?.length ? `, über ${request.stops.map((stop) => stop.place.name).join(", ")}` : ""}`;
    if (open instanceof HTMLButtonElement) {
      open.type = "button";
      open.setAttribute(
        "aria-label",
        `Gespeicherte Planung öffnen: ${description}`,
      );
      open.onclick = () => openSnapshot(entry.snapshot, entry.id);
    }
    const originLine = node("span", "", "history-origin");
    const marker = node("span", "", "route-origin-marker");
    marker.setAttribute("aria-hidden", "true");
    originLine.append(marker, node("span", origin));
    const destinationLine = node("strong", "", "history-destination");
    destinationLine.append(
      icon("flag"),
      node("span", journey.destination.name),
    );
    open.append(originLine, destinationLine);
    if (request.stops?.length)
      open.append(
        node(
          "small",
          `Über ${request.stops.map((stop) => stop.place.name).join(" · ")}`,
        ),
      );
    const plannedAt = new Date(entry.snapshot.savedAt * 1000);
    const timestamp = node(
      "time",
      historyPlannedAt(entry.snapshot.savedAt),
      "history-timestamp",
    );
    timestamp.dateTime = plannedAt.toISOString();
    timestamp.id = `history-time-${entry.id}`;
    open.setAttribute("aria-describedby", timestamp.id);
    open.append(timestamp);
    const remove = node("button", "", "history-remove");
    remove.append(
      icon("trash"),
      node("span", "Löschen", "history-remove-label"),
    );
    remove.title = "Fahrt löschen";
    remove.type = "button";
    remove.setAttribute("aria-label", `Fahrt löschen: ${description}`);
    remove.onclick = () => void deleteHistoryEntry(entry.id);
    const chevron = icon("chevron");
    chevron.classList.add("history-chevron");
    open.append(chevron);
    row.append(open, remove);
    el("history-list").append(row);
    if (entry.id === focusedId)
      (focusedRemove
        ? row.querySelector<HTMLButtonElement>(".history-remove")
        : open
      )?.focus({ preventScroll: true });
  }
  historySwipe.ready();
}
async function reloadHistory() {
  const generation = storageGeneration;
  const result = await store.read();
  if (generation !== storageGeneration) return;
  historyEntries = result.entries;
  saved = result.snapshot;
  savedUI();
  if (view === "history") historyNames.enqueue(historyEntries);
}
async function deleteHistoryEntry(id: string) {
  if (historyMutationPending) return;
  historyMutationPending = true;
  const generation = ++storageGeneration;
  historyNames.clear();
  const index = historyEntries.findIndex((item) => item.id === id);
  const entry = historyEntries[index];
  try {
    const token = await store.remove(id);
    if (generation !== storageGeneration || !token) return;
    const request = activePlan?.request ?? session.state.request;
    if (entry && request && sameHistoryRoute(entry.snapshot.request, request))
      suppressCurrentSave();
    historySwipe.close();
    await reloadHistory();
    if (generation !== storageGeneration) return;
    historyUndo.show(async () => {
      if (historyMutationPending) return;
      historyMutationPending = true;
      const restoreGeneration = ++storageGeneration;
      try {
        const result = await store.restoreDeleted(token);
        if (restoreGeneration !== storageGeneration) return;
        await reloadHistory();
        if (restoreGeneration !== storageGeneration) return;
        if (result === "restored") {
          if (view === "history")
            Array.from(
              el("history-list").querySelectorAll<HTMLElement>(".history-row"),
            )
              .find((row) => row.dataset.historyId === id)
              ?.querySelector<HTMLButtonElement>(".history-open")
              ?.focus({ preventScroll: true });
          toast("Fahrt wiederhergestellt.");
        } else
          toast(
            result === "newer"
              ? "Diese Strecke ist bereits gespeichert. Die aktuelle Planung bleibt erhalten."
              : "Fahrt konnte nicht wiederhergestellt werden. Der Verlauf ist voll oder wurde geändert.",
          );
      } catch {
        toast(
          "Fahrt konnte nicht wiederhergestellt werden. Speicher nicht verfügbar.",
        );
      } finally {
        historyMutationPending = false;
      }
    });
    if (view === "history") {
      const buttons =
        el("history-list").querySelectorAll<HTMLButtonElement>(".history-open");
      (
        buttons[Math.min(index, buttons.length - 1)] ?? el("history-heading")
      ).focus({ preventScroll: true });
    }
  } catch {
    toast("Fahrt konnte nicht gelöscht werden. Bitte erneut versuchen.");
  } finally {
    historyMutationPending = false;
  }
}
function suppressCurrentSave() {
  currentSaveSuppressed = true;
  if (session.state.calculationId)
    suppressedCalculations.add(session.state.calculationId);
  activeSnapshot = undefined;
}
function savedUI() {
  historyUI();
  el("open-saved").hidden = !saved;
  el("saved-description").textContent = saved
    ? `${saved.journey.destination.name} · ${dateLabel(saved.savedAt)}, ${clock(saved.savedAt)}`
    : "";
  el<HTMLButtonElement>("delete-saved").disabled = !saved;
  el("offline-empty").hidden = navigator.onLine || !!saved;
  el<HTMLInputElement>("offline-enabled").checked = offlineEnabled;
}
async function persist(snapshot: SavedJourney, id: string) {
  const generation = storageGeneration;
  try {
    if (await store.save(snapshot, id)) {
      if (offlineEnabled && generation === storageGeneration) {
        await reloadHistory();
        historyNames.enqueue(
          historyEntries.filter((entry) => entry.calculationId === id),
        );
        el("storage-message").textContent =
          "Letzte Reise auf diesem Gerät gespeichert.";
      }
    }
  } catch {
    el("storage-message").textContent =
      "Reise konnte nicht offline gespeichert werden.";
    toast(
      "Offline-Speicherung nicht verfügbar. Deine Online-Reise bleibt nutzbar.",
    );
  }
}
function showRouteMap(state: PlanningState) {
  if (!journeyView.mapVisible) return;
  routeMap.show(
    state.journeys,
    state.selected,
    navigator.onLine,
    JSON.stringify([state.calculationId ?? state.queriedAt, state.request]),
  );
}
function renderPlanning(state: PlanningState) {
  if (activePlanId && activePlan && state.selected) {
    planResults.set(activePlanId, {
      ...structuredClone({ plan: activePlan, state }),
      settingsReplanPending:
        planResults.get(activePlanId)?.settingsReplanPending ?? false,
    });
    if (planResults.size > 32)
      planResults.delete(planResults.keys().next().value!);
  }
  if (state.busy && !planningWasBusy) currentSaveSuppressed = false;
  planningWasBusy = state.busy;
  updateLinkUI();
  journeyView.render(
    state,
    state.resultSettings?.maxCyclingMinutes ?? settings.maxCyclingMinutes,
  );
  if (view === "map") showRouteMap(state);
  if (
    state.selected &&
    state.request &&
    state.resultSettings &&
    !state.restored &&
    !state.staleReason &&
    !currentSaveSuppressed &&
    state.calculationId &&
    !suppressedCalculations.has(state.calculationId)
  ) {
    const key = JSON.stringify([state.selected, state.calculationId]);
    if (key !== persistKey) {
      persistKey = key;
      activeSnapshot = {
        version: state.request.stops?.length ? 4 : 3,
        savedAt: state.queriedAt,
        request: structuredClone(state.request),
        settings: structuredClone(state.resultSettings),
        journey: state.selected,
      };
      if (offlineEnabled) void persist(activeSnapshot, state.calculationId);
    }
  }
  el("replan-saved").hidden = !state.restored;
  el<HTMLButtonElement>("replan-saved").disabled =
    !navigator.onLine || state.busy;
  el<HTMLButtonElement>("update-now").disabled =
    state.busy || dialog.open || !!navigationView?.visible;
}
const destination = new PlaceSearch(
  "destination",
  api,
  el("place-status"),
  (place) => {
    destination.input.blur();
    void start(place);
  },
  book,
  toast,
  false,
);
function updateSearchEmpty() {
  el("search-empty").hidden =
    destination.input.value.trim().length > 0 || book.entries.length > 0;
}
destination.input.addEventListener("input", updateSearchEmpty);
book.subscribe(updateSearchEmpty);
const draftOrigin = new PlaceSearch(
  "origin",
  api,
  el("adjust-status"),
  (place) => {
    cancelDraftLocation();
    useLocation = place.name === "Aktueller Standort";
    keepDialogFieldVisible();
  },
  book,
  toast,
);
const draftDestination = new PlaceSearch(
  "adjust-destination",
  api,
  el("adjust-status"),
  () => keepDialogFieldVisible(),
  book,
  toast,
);
const stopEditor = new StopEditor(api, book, toast);
let useLocation = true;
let adjustMode: "context" | "replan" = "context";
let draftLocationRequest: AbortController | undefined;
function cancelDraftLocation() {
  draftLocationRequest?.abort();
  draftLocationRequest = undefined;
  el<HTMLButtonElement>("origin-location").disabled = false;
}
function contextUI() {
  el("search-context").textContent =
    `${originOverride?.name ?? "Aktueller Standort"}${stops.length ? ` · ${stops.length} Zwischenziel${stops.length > 1 ? "e" : ""}` : ""} · ${timing === "now" ? "Jetzt" : `${timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(time)}, ${clock(time)}`}`;
}
async function start(place: Place) {
  settingsReplanPending = false;
  if (!navigator.onLine) {
    el("place-status").textContent =
      "Für neue Routen brauchst du eine Internetverbindung.";
    return;
  }
  beginPlanning();
  const result = await session.calculate(
    {
      origin: originOverride ?? {
        name: "Aktueller Standort",
        detail: "",
        latitude: 0,
        longitude: 0,
      },
      destination: place,
      stops: structuredClone(stops),
      timing,
      time,
    },
    settings,
    !originOverride,
  );
  if (result === "location-error" && view === "map" && !dialog.open) {
    openAdjust(place);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
    draftOrigin.input.focus();
  }
}
function openAdjust(target?: Place) {
  destination.cancel();
  const request = structuredClone(
    session.state.pendingRequest ?? session.state.request,
  );
  adjustMode = activePlan || request ? "replan" : "context";
  el("use-context").hidden = adjustMode !== "context";
  stopEditor.set(structuredClone(request ? (request.stops ?? []) : stops));
  draftOrigin.set(request?.origin ?? originOverride);
  useLocation =
    !draftOrigin.value || draftOrigin.value.name === "Aktueller Standort";
  if (useLocation && !draftOrigin.value)
    draftOrigin.input.value = "Aktueller Standort";
  draftDestination.set(target ?? request?.destination ?? destination.value);
  const draftTiming = request?.timing ?? timing;
  el<HTMLInputElement>("timing").value = draftTiming;
  el<HTMLInputElement>("when").value = localDate(
    new Date(
      (draftTiming === "now"
        ? Date.now() / 1000 + 3600
        : (request?.time ?? time)) * 1000,
    ),
  );
  updateTiming();
  el("adjust-status").textContent = "";
  el("adjust-location-help").hidden = true;
  dialog.showModal();
  el("adjust-heading").focus({ preventScroll: true });
  cancelMapCenter();
  syncLiveLocation();
  if (!draftOrigin.value) draftOrigin.activate();
  if (!draftDestination.value) draftDestination.activate();
  el<HTMLButtonElement>("update-now").disabled = true;
}
function closeAdjust() {
  cancelDraftLocation();
  draftOrigin.cancel();
  draftDestination.cancel();
  stopEditor.cancel();
  dialog.close();
  el<HTMLButtonElement>("update-now").disabled =
    session.state.busy || !!navigationView?.visible;
}
dialog.addEventListener("close", () => {
  syncLiveLocation();
  cancelDraftLocation();
  draftOrigin.cancel();
  draftDestination.cancel();
  stopEditor.cancel();
  el<HTMLButtonElement>("update-now").disabled =
    session.state.busy || !!navigationView?.visible;
});
el("search-adjust").onclick = () => openAdjust();
el("adjust-route").onclick = () => openAdjust();
el("cancel-adjust").onclick = closeAdjust;
dialog.addEventListener("input", () => {
  el("adjust-location-help").hidden = true;
});
el("origin-location").onclick = async () => {
  el("adjust-location-help").hidden = true;
  cancelDraftLocation();
  const controller = new AbortController();
  draftLocationRequest = controller;
  useLocation = true;
  draftOrigin.set();
  draftOrigin.input.value = "Aktueller Standort";
  el<HTMLButtonElement>("origin-location").disabled = true;
  el("adjust-status").textContent =
    "Standort wird ermittelt … Bitte Zugriff erlauben, falls danach gefragt wird.";
  try {
    const place = await locate(controller.signal);
    if (!controller.signal.aborted) {
      draftOrigin.set(place);
      el("adjust-status").textContent =
        "Standort verfügbar. Du kannst jetzt die Route berechnen.";
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      el("adjust-status").textContent = errorText(error);
      el("adjust-location-help").hidden = false;
    }
  } finally {
    if (draftLocationRequest === controller) cancelDraftLocation();
  }
};
draftOrigin.input.addEventListener("input", () => {
  cancelDraftLocation();
  useLocation = false;
});
el("swap").onclick = () => {
  if (!draftOrigin.value || !draftDestination.value) {
    el("adjust-status").textContent = "Zum Tauschen beide Orte auswählen.";
    return;
  }
  stopEditor.reverse();
  const origin = draftOrigin.value;
  draftOrigin.set(draftDestination.value);
  draftDestination.set(origin);
  useLocation = draftOrigin.value?.name === "Aktueller Standort";
};
function updateTiming() {
  el("time-summary").textContent = timeSummary(
    el<HTMLInputElement>("timing").value as Timing,
    el<HTMLInputElement>("when").value,
  );
}
new TimePicker(updateTiming);
el("timezone").textContent =
  "Alle Zeiten: " + Intl.DateTimeFormat().resolvedOptions().timeZone;
function readContext(): boolean {
  cancelDraftLocation();
  if (!useLocation && !draftOrigin.value) {
    el("adjust-status").textContent =
      "Bitte Start aus den Vorschlägen auswählen.";
    draftOrigin.input.focus();
    return false;
  }
  const selectedTiming = el<HTMLInputElement>("timing").value as Timing,
    date = new Date(el<HTMLInputElement>("when").value),
    seconds =
      selectedTiming === "now" ? Date.now() / 1000 : date.getTime() / 1000;
  if (
    selectedTiming !== "now" &&
    (!Number.isFinite(seconds) ||
      localDate(date) !== el<HTMLInputElement>("when").value ||
      seconds < Date.now() / 1000)
  ) {
    el("adjust-status").textContent =
      "Bitte einen aktuellen oder zukünftigen Zeitpunkt wählen.";
    return false;
  }
  const draftStops = stopEditor.read();
  if (!draftStops) return false;
  stops = draftStops;
  originOverride = useLocation ? undefined : draftOrigin.value;
  timing = selectedTiming;
  time = seconds;
  contextUI();
  return true;
}
el("use-context").onclick = () => {
  if (adjustMode !== "context") return;
  if (readContext()) {
    closeAdjust();
    toast("Start, Zwischenziele und Zeitpunkt übernommen.");
  }
};
el("route-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!draftDestination.value) {
    el("adjust-status").textContent =
      "Bitte Ziel aus den Vorschlägen auswählen.";
    return;
  }
  if (!readContext()) return;
  const target = draftDestination.value;
  destination.set(target);
  closeAdjust();
  beginPlanning();
  const result = await session.calculate(
    {
      origin: originOverride ?? {
        name: "Aktueller Standort",
        detail: "",
        latitude: 0,
        longitude: 0,
      },
      destination: target,
      stops: structuredClone(stops),
      timing,
      time,
    },
    settings,
    !originOverride,
  );
  if (result === "location-error" && view === "map" && !dialog.open) {
    openAdjust(target);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
  }
};
async function refreshRoute(interactive = true) {
  if (view === "map") {
    journeyView.reset();
    el("result-context").focus({ preventScroll: true });
    writeHistory(false, 0);
  }
  const request = activePlan?.request ?? session.state.request;
  if (!request) return;
  if (request.timing !== "now" && request.time < Date.now() / 1000) {
    const message = "Bitte einen aktuellen oder zukünftigen Zeitpunkt wählen.";
    session.stop(message);
    if (interactive && view === "map") {
      openAdjust(request.destination);
      el("adjust-status").textContent = message;
    }
    return;
  }
  if (activePlan && openedHistoryId) {
    openedHistoryId = undefined;
    activePlanId = crypto.randomUUID();
    writeHistory(true);
  }
  const result = await session.calculate(
    request,
    settings,
    request.origin.name === "Aktueller Standort",
  );
  if (
    result === "location-error" &&
    interactive &&
    view === "map" &&
    !dialog.open
  ) {
    openAdjust(request.destination);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
  }
}
el("refresh-route").onclick = () => void refreshRoute();
el("close-route").onclick = () => {
  settingsReplanPending = false;
  session.clear();
  releasePlan();
  mapLocationRequest?.abort();
  destination.set();
  originOverride = undefined;
  stops = [];
  timing = "now";
  time = Date.now() / 1000;
  contextUI();
  el("search-empty").hidden = false;
  el("place-status").textContent = "";
  show("search");
  writeHistory();
  destination.input.focus({ preventScroll: true });
};
el("dismiss-location-error").onclick = () => {
  el("map-location-error").hidden = true;
};
el("map-route").onclick = () => {
  if (!session.state.selected) return;
  mapLocationRequest?.abort();
  mapLocationRequest = undefined;
  el<HTMLButtonElement>("map-location").disabled = false;
  el("map-location-error").hidden = true;
  liveLocation.cancelCenter();
  routeMap.fitRoute();
};
el("map-location").onclick = async () => {
  el("map-location-error").hidden = true;
  mapLocationRequest?.abort();
  mapLocationRequest = new AbortController();
  const signal = mapLocationRequest.signal;
  const button = el<HTMLButtonElement>("map-location");
  button.disabled = true;
  try {
    const fix = await liveLocation.center();
    if (!signal.aborted) routeMap.center(fixPlace(fix));
  } catch (error) {
    if (!signal.aborted) {
      el("map-location-error-text").textContent = errorText(error);
      el("map-location-error").hidden = false;
    }
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
};

const labels: Record<keyof typeof ranges, string> = {
  cyclingSpeedKilometersPerHour: "Radgeschwindigkeit",
  maxCyclingMinutes: "Maximale Radzeit je Etappe",
  maxWalkingMinutes: "Fußweg zum / vom ÖPNV",
  foldingDuration: "Falten / Entfalten",
  maxBikeTransfers: "Radverbindungen zwischen Linien",
};
function settingsUI() {
  el("settings-fields").replaceChildren();
  for (const [key, [min, max, step]] of Object.entries(ranges)) {
    const k = key as keyof typeof ranges,
      divisor = k === "foldingDuration" ? 60 : 1;
    const label = node("label", "", "setting-row"),
      copy = node("span", labels[k]);
    copy.append(
      node(
        "small",
        k === "cyclingSpeedKilometersPerHour"
          ? "km/h"
          : k === "maxBikeTransfers"
            ? "Maximale Anzahl"
            : "Minuten" + (k.startsWith("max") ? " · maximal" : ""),
      ),
    );
    const input = node("input");
    input.type = "number";
    input.id = k;
    input.min = String(min / divisor);
    input.max = String(max / divisor);
    input.step = String(step / divisor);
    input.value = String(settings[k] / divisor);
    input.required = true;
    input.oninput = () => {
      if (input.checkValidity())
        applySettings({ ...settings, [k]: Number(input.value) * divisor });
    };
    if (k === "maxCyclingMinutes") {
      const hint = node(
        "small",
        "Gilt für jede Radetappe deiner ÖPNV-Reise. Falten, Entfalten und Anschlusspuffer kommen hinzu. Längere reine Fahrradrouten können zusätzlich zum Vergleich erscheinen.",
      );
      hint.id = "cycling-limit-hint";
      copy.append(hint);
      input.setAttribute("aria-describedby", hint.id);
    }
    label.append(copy, input);
    el("settings-fields").append(label);
    if (k === "maxCyclingMinutes") {
      const toggle = node("label", "", "toggle-row");
      const text = node("span", "Fahrradvergleich anzeigen");
      text.append(
        node(
          "small",
          "Längere reine Fahrradrouten zusätzlich anzeigen. Fahrradrouten innerhalb deines Radlimits bleiben sichtbar.",
        ),
      );
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.id = "showCyclingComparison";
      checkbox.checked = settings.showCyclingComparison;
      checkbox.onchange = () =>
        applySettings({ ...settings, showCyclingComparison: checkbox.checked });
      toggle.append(text, checkbox);
      el("settings-fields").append(toggle);
    }
  }
  el("modes").replaceChildren(node("legend", "Verkehrsmittel"));
  for (const [key, mode] of Object.entries(modes)) {
    const label = node("label", "", "toggle-row"),
      input = node("input");
    input.type = "checkbox";
    input.checked = !settings.excludedTransitModes.includes(
      key as keyof typeof modes,
    );
    input.dataset.mode = key;
    input.onchange = () => {
      const excludedTransitModes = Array.from(
        el("modes").querySelectorAll<HTMLInputElement>("input"),
      )
        .filter((i) => !i.checked)
        .map((i) => i.dataset.mode as keyof typeof modes);
      applySettings({ ...settings, excludedTransitModes });
    };
    label.append(node("span", mode.name), input);
    el("modes").append(label);
  }
  settingsSummary();
}
function settingsSummary() {
  el("settings-summary").textContent =
    `${settings.cyclingSpeedKilometersPerHour} km/h · ${settings.foldingDuration / 60} min je Falten und Entfalten. ${temporarySettings ? "Einstellungen gelten nur für diese Planung." : "Änderungen werden gespeichert."}${session.state.request ? " Beim Verlassen wird einmal neu berechnet. Bisherige Ergebnisse bleiben bis dahin erhalten." : ""}`;
}
function updateSettingsReplanPending(pending: boolean) {
  settingsReplanPending = pending;
  const previousResult = activePlanId
    ? planResults.get(activePlanId)
    : undefined;
  if (previousResult) previousResult.settingsReplanPending = pending;
}
function applySettings(next: RoutingSettings) {
  if (!validSettings(next) || JSON.stringify(settings) === JSON.stringify(next))
    return;
  const firstChange = !settingsReplanPending;
  settings = structuredClone(next);
  if (activePlan) {
    if (firstChange) {
      openedHistoryId = undefined;
      activePlanId = crypto.randomUUID();
    }
    activePlan = { ...activePlan, settings: structuredClone(settings) };
    writeHistory(firstChange);
  }
  if (session.state.request) {
    session.invalidateForSettings();
    updateSettingsReplanPending(true);
    activeSnapshot = undefined;
    persistKey = "";
  }
  if (temporarySettings) {
    settingsSummary();
    return;
  }
  personalSettings = structuredClone(settings);
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
    localStorage.removeItem(legacyStorageKey);
  } catch {
    toast(
      "Einstellungen konnten nicht dauerhaft gespeichert werden. Sie gelten für diese Sitzung.",
    );
  }
  settingsSummary();
}
function openSettings() {
  beforeSettings = view === "settings" ? beforeSettings : view;
  settingsUI();
  show("settings");
}
el("tab-history").onclick = () => {
  show("history");
  void reloadHistory().catch(() =>
    toast("Fahrten konnten nicht geladen werden."),
  );
};
el("tab-settings").onclick = openSettings;
el("header-settings").onclick = openSettings;
el("late-settings").onclick = openSettings;
el("tab-route").onclick = () => {
  show(session.state.request ? "map" : "search");
};
el("reset-settings").onclick = () => {
  applySettings(structuredClone(defaults));
  settingsUI();
};
el("settings-form").onsubmit = (event) => {
  event.preventDefault();
  show(
    beforeSettings === "history"
      ? "history"
      : session.state.request
        ? "map"
        : beforeSettings,
  );
};
el("clear-data").onclick = () => {
  el("delete-data-status").textContent = "";
  el<HTMLDialogElement>("delete-data-dialog").showModal();
};
el("cancel-delete-data").onclick = () =>
  el<HTMLDialogElement>("delete-data-dialog").close();
el("confirm-delete-data").onclick = async () => {
  historyUndo.clear();
  const button = el<HTMLButtonElement>("confirm-delete-data");
  button.disabled = true;
  storageGeneration++;
  historyNames.clear();
  settingsReplanPending = false;
  session.clear();
  destination.cancel();
  draftOrigin.cancel();
  draftDestination.cancel();
  stopEditor.cancel();
  cancelDraftLocation();
  mapLocationRequest?.abort();
  activeSnapshot = undefined;
  persistKey = "";
  book.reset();
  clearSearchLocation();
  try {
    await localDatabase.clearAll();
    historySwipe.resetHint();
    localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
    localStorage.removeItem(screenAwakeKey);
    localStorage.removeItem(audioPreferenceKey);
    keepScreenAwake = true;
    el<HTMLInputElement>("keep-screen-awake").checked = true;
    saved = undefined;
    historyEntries = [];
    offlineEnabled = true;
    personalSettings = structuredClone(defaults);
    releasePlan();
    planResults.clear();
    originOverride = undefined;
    stops = [];
    timing = "now";
    time = Date.now() / 1000;
    destination.set();
    draftOrigin.set();
    draftDestination.set();
    savedUI();
    settingsUI();
    contextUI();
    el<HTMLDialogElement>("delete-data-dialog").close();
    show("search");
    writeHistory();
    toast("Alle lokalen Daten gelöscht.");
  } catch {
    el("delete-data-status").textContent =
      "Daten konnten nicht vollständig gelöscht werden. Bitte erneut versuchen.";
  } finally {
    button.disabled = false;
  }
};
el<HTMLInputElement>("keep-screen-awake").checked = keepScreenAwake;
el("keep-screen-awake").onchange = () => {
  keepScreenAwake = el<HTMLInputElement>("keep-screen-awake").checked;
  syncLiveLocation();
  try {
    localStorage.setItem(screenAwakeKey, String(keepScreenAwake));
  } catch {
    toast("Einstellung gilt nur für diese Sitzung.");
  }
};
el("offline-enabled").onchange = async () => {
  const checkbox = el<HTMLInputElement>("offline-enabled");
  const enabled = checkbox.checked,
    previous = offlineEnabled;
  const generation = ++storageGeneration;
  checkbox.disabled = true;
  offlineEnabled = enabled;
  if (!enabled) {
    historyNames.clear();
    historyUndo.clear();
  }
  syncHistoryNames();
  try {
    await store.setEnabled(enabled);
    if (generation !== storageGeneration) return;
    if (!enabled) {
      suppressCurrentSave();
      saved = undefined;
      historyEntries = [];
      el("storage-message").textContent =
        "Fahrten gelöscht. Speicherung ausgeschaltet.";
    } else {
      el("storage-message").textContent =
        "Die nächsten Planungen werden auf diesem Gerät gespeichert.";
      if (activeSnapshot && session.state.calculationId)
        await persist(activeSnapshot, session.state.calculationId);
    }
    savedUI();
  } catch {
    if (generation !== storageGeneration) return;
    offlineEnabled = previous;
    syncHistoryNames();
    savedUI();
    el("storage-message").textContent =
      "Offline-Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.";
    toast(
      "Speicher nicht verfügbar. Änderung konnte nicht dauerhaft übernommen werden.",
    );
  } finally {
    checkbox.disabled = false;
  }
};
el("delete-saved").onclick = () => {
  el("delete-history-status").textContent = "";
  el<HTMLDialogElement>("delete-history-dialog").showModal();
};
el("cancel-delete-history").onclick = () =>
  el<HTMLDialogElement>("delete-history-dialog").close();
el("confirm-delete-history").onclick = async () => {
  historyUndo.clear();
  const button = el<HTMLButtonElement>("confirm-delete-history");
  button.disabled = true;
  storageGeneration++;
  historyNames.clear();
  suppressCurrentSave();
  try {
    await store.clear();
    await reloadHistory();
    el<HTMLDialogElement>("delete-history-dialog").close();
    el("storage-message").textContent = "Fahrtenverlauf gelöscht.";
  } catch {
    el("delete-history-status").textContent =
      "Löschen fehlgeschlagen. Bitte erneut versuchen.";
  } finally {
    button.disabled = false;
  }
};
function restorePlanContext(plan: RouteLink, temporary = true) {
  settings = structuredClone(plan.settings);
  temporarySettings = temporary;
  // Restored endpoints stay fixed even if their original label came from GPS.
  for (const place of [plan.request.origin, plan.request.destination]) {
    if (place.name === "Aktueller Standort")
      place.name = place === plan.request.origin ? "Startpunkt" : "Zielpunkt";
  }
  destination.set(plan.request.destination);
  originOverride = plan.request.origin;
  stops = structuredClone(plan.request.stops ?? []);
  timing = plan.request.timing;
  time = plan.request.time;
  contextUI();
}
function openSnapshot(
  snapshot: SavedJourney,
  id?: string,
  push = true,
  focus = true,
  planId?: string,
) {
  const origin = view === "history" ? "history" : "search";
  journeyView.reset("detail", origin);
  const entry = historyEntries.find((entry) => entry.id === id);
  if (entry) snapshot = historySnapshot(entry);
  settingsReplanPending = false;
  openedHistoryId = id;
  activePlan = {
    request: structuredClone(snapshot.request),
    settings: migrateSettings(snapshot.settings)!,
  };
  restorePlanContext(activePlan);
  activePlanId = planId ?? crypto.randomUUID();
  session.restore(
    snapshot.journey,
    activePlan.request,
    snapshot.savedAt,
    activePlan.settings,
  );
  settingsUI();
  if (view === "map") {
    if (push) writeHistory(true);
  } else show("map", push);
  if (focus) journeyView.focusSelection();
}
function openSaved(focus = true) {
  if (saved) openSnapshot(saved, historyEntries[0]?.id, true, focus);
}
el("open-saved").onclick = () => openSaved();
el("replan-saved").onclick = async () => {
  if (!activePlan || !navigator.onLine) return;
  journeyView.reset();
  const request = structuredClone(activePlan.request);
  request.timing = "now";
  request.time = Date.now() / 1000;
  timing = "now";
  time = request.time;
  openedHistoryId = undefined;
  activePlanId = crypto.randomUUID();
  activePlan = { request, settings: structuredClone(settings) };
  writeHistory(true);
  contextUI();
  await session.calculate(request, settings, false);
};
function updateConnectionHeight() {
  document.documentElement.style.setProperty(
    "--connection-height",
    `${el("connection").getBoundingClientRect().height}px`,
  );
}
new ResizeObserver(updateConnectionHeight).observe(el("connection"));
function connectionChanged() {
  syncHistoryNames();
  el("connection").hidden = navigator.onLine;
  updateConnectionHeight();
  navigationView?.render();
  if (navigator.onLine) void navigation?.refresh();
  savedUI();
  el<HTMLButtonElement>("replan-saved").disabled =
    !navigator.onLine || session.state.busy;
  if (view === "map") {
    journeyView.render(
      session.state,
      session.state.resultSettings?.maxCyclingMinutes ??
        settings.maxCyclingMinutes,
    );
    showRouteMap(session.state);
  }
  if (!navigator.onLine && session.state.busy)
    session.stop("Offline. Bereits gefundene Verbindungen bleiben verfügbar.");
}
window.addEventListener("online", connectionChanged);
window.addEventListener("offline", connectionChanged);
void store
  .read()
  .then(async (result) => {
    if (storageGeneration === 0) offlineEnabled = result.enabled;
    if (!activeSnapshot && storageGeneration === 0) {
      saved = result.snapshot;
      historyEntries = result.entries;
    }
    savedUI();
    if (storageGeneration === 0 && result.enabled) {
      const snapshot = await navigationStore.read();
      const sameLink =
        snapshot &&
        initialLink.kind === "plan" &&
        routeURL(location.href, initialLink.plan).href ===
          routeURL(location.href, {
            request: snapshot.request,
            settings: snapshot.settings,
          }).href;
      if (
        snapshot &&
        !navigationView?.visible &&
        storageGeneration === 0 &&
        navigationLaunchGeneration === 0 &&
        ((!activePlan && initialLink.kind === "none") ||
          navigationRestoreRequested ||
          sameLink)
      ) {
        const resumeDialog = el<HTMLDialogElement>("navigation-resume-dialog");
        el("navigation-resume-summary").textContent =
          `${snapshot.journey.destination.name} · Abschnitt ${snapshot.progress.legIndex + 1}`;
        el("navigation-resume").onclick = () => {
          resumeDialog.close();
          void launchNavigation(false, snapshot);
        };
        const discard = () => {
          resumeDialog.close();
          void navigationStore
            .clear()
            .catch(() =>
              toast("Gespeicherte Navigation konnte nicht gelöscht werden."),
            );
          initializeLink();
        };
        el("navigation-discard").onclick = discard;
        resumeDialog.oncancel = (event) => {
          event.preventDefault();
          discard();
        };
        resumeDialog.showModal();
        return;
      }
    }
    initializeLink();
    if (result.invalid)
      el("storage-message").textContent =
        "Nicht lesbare gespeicherte Fahrten wurden entfernt.";
    if (
      !navigator.onLine &&
      saved &&
      view === "search" &&
      initialLink.kind === "none" &&
      !activePlan
    )
      openSaved(false);
  })
  .catch(() => {
    el("storage-message").textContent =
      "Offline-Speicher nicht verfügbar. Online-Planung bleibt möglich.";
    initializeLink();
  });
void book
  .load()
  .catch(() =>
    toast(
      "Favoriten und letzte Orte konnten nicht geladen werden. Online-Planung bleibt möglich.",
    ),
  );
destination.activate();
settingsUI();
contextUI();
connectionChanged();
setupPWA();

let dialogScrollFrame: number | undefined;
function keepDialogFieldVisible() {
  if (document.body.classList.contains("search-focus-mode")) return;
  if (dialogScrollFrame !== undefined) cancelAnimationFrame(dialogScrollFrame);
  dialogScrollFrame = requestAnimationFrame(() => {
    dialogScrollFrame = undefined;
    const field = document.activeElement;
    const body = dialog.querySelector<HTMLElement>(".dialog-body")!;
    if (
      !dialog.open ||
      !(
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement
      ) ||
      !body.contains(field)
    )
      return;

    const bounds = body.getBoundingClientRect();
    const fieldBounds = field.getBoundingClientRect();
    const label = field.labels?.[0];
    const top =
      label && body.contains(label)
        ? Math.min(label.getBoundingClientRect().top, fieldBounds.top)
        : fieldBounds.top;
    const visibleTop = bounds.top + 8;
    const visibleBottom = bounds.bottom - 8;
    // Prefer the whole field when large text leaves too little space for its label.
    const desiredTop =
      fieldBounds.bottom - top <= visibleBottom - visibleTop
        ? top
        : fieldBounds.top;
    if (fieldBounds.bottom > visibleBottom) {
      body.scrollTop += fieldBounds.bottom - visibleBottom;
    } else if (desiredTop < visibleTop) {
      body.scrollTop += desiredTop - visibleTop;
    }
  });
}
dialog.addEventListener("focusin", keepDialogFieldVisible);

function visualViewportChanged() {
  document.documentElement.style.setProperty(
    "--visual-width",
    `${window.visualViewport?.width ?? innerWidth}px`,
  );
  document.documentElement.style.setProperty(
    "--visual-left",
    `${window.visualViewport?.offsetLeft ?? 0}px`,
  );
  dialog.classList.toggle(
    "compact",
    (window.visualViewport?.height ?? innerHeight) < 500,
  );
  document.documentElement.style.setProperty(
    "--visual-height",
    `${window.visualViewport?.height ?? innerHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--visual-top",
    `${window.visualViewport?.offsetTop ?? 0}px`,
  );
  keepDialogFieldVisible();
}
window.visualViewport?.addEventListener("resize", visualViewportChanged);
window.visualViewport?.addEventListener("scroll", visualViewportChanged);
window.addEventListener("resize", visualViewportChanged);
visualViewportChanged();

// Read links after every form and dialog handler is ready. Offline storage must
// never replace an explicitly linked planning request with an unrelated trip.
function initializeLink() {
  if (navigationLaunchGeneration > 0) return;
  if (initialLink.kind !== "none") void restoreLink(initialLink);
  else writeHistory();
}
el("share-plan").onclick = async () => {
  if (!activePlan || session.state.locating || sharingPlan) return;
  const link = routeURL(location.href, activePlan).href;
  sharingPlan = true;
  el("plan-link-fallback").hidden = true;
  updateLinkUI();
  try {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "FoldRoute", url: link });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(link);
        toast("Planungslink kopiert.");
        return;
      } catch {
        // A denied clipboard still allows manual copying below.
      }
    }
    // Do not display a stale link if the plan changed while sharing.
    if (!activePlan || routeURL(location.href, activePlan).href !== link)
      return;
    const input = el<HTMLInputElement>("plan-link-value");
    input.value = link;
    el("plan-link-fallback").hidden = false;
    el("panel-content").scrollTop = 0;
    input.focus();
    input.select();
  } finally {
    sharingPlan = false;
    updateLinkUI();
  }
};
