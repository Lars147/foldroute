import { SettingsValidation } from "./settings-validation";
import {
  parseSharedDestination,
  readShareURL,
  shareKeys,
  unsupportedShare,
  type SharePayload,
} from "./shared-destination";
import { HistorySwipe } from "./history-swipe";
import { HistoryUndo } from "./history-undo";
import { HistoryNameQueue } from "./history-names";
import { historySnapshot } from "./offline";
import {
  NavigationSession,
  type PreparedNavigation,
} from "./navigation-session";
import { assessConnection, blocksNavigation } from "./connection-assessment";
import { NavigationView } from "./navigation-ui";
import { NavigationStore, type NavigationSnapshot } from "./navigation-store";
import { audioPreferenceKey } from "./navigation-guidance";
import { ScreenAwake } from "./screen-awake";
import { LiveLocation, fixPlace } from "./live-location";
import { TimePicker, parseLocalMinute, timeSummary } from "./time-picker";
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
let historyPosition = Number.isSafeInteger(history.state?.position)
  ? (history.state.position as number)
  : 0;
let restoringSettingsPosition: number | undefined;
let view: View = "search",
  settings: RoutingSettings = structuredClone(defaults);
let settingsReplanPending = false;
let activePlan: RouteLink | undefined;
let activePlanId: string | undefined;
const planResults = new Map<
  string,
  { plan: RouteLink; state: PlanningState; settingsReplanPending: boolean }
>();
const navigationRestoreRequested = history.state?.navigation === true;
const initialLink = readRouteURL(new URL(location.href));
const initialShare = readShareURL(new URL(location.href));
const sharedStorageKey = "foldroute.sharedDestination.v1";
let pendingShared: { id: string; payload: SharePayload } | undefined;
let sharedResume: NavigationSnapshot | undefined;
let sharedInitialized = false;
try {
  const raw = localStorage.getItem(sharedStorageKey);
  if (raw) {
    const item = JSON.parse(raw);
    if (
      typeof item.id === "string" &&
      item.payload &&
      ["title", "text", "url"].every(
        (key) =>
          item.payload[key] === undefined ||
          typeof item.payload[key] === "string",
      )
    )
      pendingShared = item;
  }
} catch {
  /* An incoming share remains usable without persistent storage. */
}
if (initialShare) {
  pendingShared = { id: crypto.randomUUID(), payload: initialShare };
  try {
    localStorage.setItem(sharedStorageKey, JSON.stringify(pendingShared));
  } catch {
    /* Session-only import. */
  }
  const cleanURL = new URL(location.href);
  for (const key of shareKeys) cleanURL.searchParams.delete(key);
  history.replaceState(history.state, "", cleanURL);
}
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
const settingsValidation = new SettingsValidation(el("settings-form"));
const screenAwakeKey = "foldroute.screenAwake";
let keepScreenAwake = true;
const storageKey = "foldroute.routing.v3";
const legacyStorageKey = "foldroute.routing.v1";
type StorageMessageSource =
  "settings" | "save" | "toggle" | "disabled" | "history" | "load";
let storageMessageSource: StorageMessageSource | undefined;
function storageMessage(source: StorageMessageSource, message: string) {
  storageMessageSource = source;
  el("storage-message").textContent = message;
}
function clearStorageMessage(...sources: StorageMessageSource[]) {
  if (storageMessageSource && sources.includes(storageMessageSource)) {
    storageMessageSource = undefined;
    el("storage-message").textContent = "";
  }
  if (toastStorageSource && sources.includes(toastStorageSource)) {
    clearTimeout(toastTimer);
    el("toast").hidden = true;
    toastStorageSource = undefined;
  }
}

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
  storageMessage("settings", "Einstellungen gelten nur für diese Sitzung.");
}
document
  .querySelectorAll<HTMLElement>("[data-icon]")
  .forEach((element) => element.append(icon(element.dataset.icon!)));
let toastTimer: ReturnType<typeof setTimeout>;
let toastStorageSource: StorageMessageSource | undefined;
function toast(message: string, source?: StorageMessageSource) {
  toastStorageSource = source;
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
let navigationChecking = false;
let navigationCheckKey = "";
let navigationCheckError = "";
let preparedNavigation: PreparedNavigation | undefined;
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
  if (navigation && !navigationView?.visible) renderNavigationCheck();
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
    pagePresent &&
      !document.hidden &&
      (!!navigationView?.visible || navigationChecking),
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
      (journeyView.mapVisible ||
        !!navigationView?.visible ||
        navigationChecking) &&
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
    if (navigationChecking) cancelNavigationCheck(true);
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
const journeyView = new JourneyView((id) => {
  cancelNavigationCheck();
  session.select(id);
});
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
  renderNavigationCheck();
};
journeyView.onPositionChange = () => {
  if (view === "map" && history.state?.planId === activePlanId)
    history.replaceState(
      { ...history.state, journeyNavigation: journeyView.snapshot() },
      "",
    );
};
journeyView.onNavigate = (screen, replace) => {
  cancelNavigationCheck();
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
  cancelNavigationCheck();
  if (journeyView.screen === "map") {
    if (journeyView.savedOrigin) {
      navigationRevision++;
      writeHistory();
      show("history");
      const row = [
        ...el("history-list").querySelectorAll<HTMLElement>(".history-row"),
      ].find((item) => item.dataset.historyId === openedHistoryId);
      (
        row?.querySelector<HTMLElement>(".history-open") ??
        el("history-heading")
      ).focus({ preventScroll: true });
    } else journeyView.onNavigate?.("list", false);
    return;
  }
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
  routingSettings: () => settings,
  changed: () => {
    navigationView?.render();
    if (!navigationView?.visible) renderNavigationCheck();
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
function navigationContextKey() {
  return JSON.stringify([
    session.state.selected,
    session.state.request,
    session.state.resultSettings,
  ]);
}
function cancelNavigationCheck(preserveResume = false) {
  if (navigationView?.visible || !navigation) return;
  navigationLaunchGeneration++;
  navigationChecking = false;
  preparedNavigation = undefined;
  navigationCheckKey = "";
  navigationCheckError = "";
  if (!preserveResume) navigationStart = undefined;
  else {
    navigationCheckKey = navigationContextKey();
    navigationCheckError =
      "Navigationsstart unterbrochen. Bitte erneut versuchen.";
  }
  navigation.cancelStart();
  liveLocation.cancelCenter();
  syncLiveLocation();
}
function renderNavigationCheck() {
  if (!navigation || navigationView?.visible) return;
  const state = session.state;
  const selected = state.selected;
  const matching = navigationCheckKey === navigationContextKey();
  const prepared = matching ? preparedNavigation : undefined;
  const assessment = selected
    ? assessConnection(
        prepared?.journey ?? selected,
        prepared?.progress?.legIndex ?? 0,
        Date.now() / 1000,
        {
          fix: navigation.fix,
          onboard:
            !!prepared?.restored &&
            prepared.journey.legs[prepared.progress?.legIndex ?? 0].kind ===
              "transit",
        },
      )
    : undefined;
  const blocked =
    !!assessment && blocksNavigation(assessment) && !prepared?.restored;
  const error = matching ? navigationCheckError : "";
  const distant = !!error && navigation.distantStart;
  const unavailable = blocked || !!error;
  const currentPlanning =
    !state.restored && !!(state.request || state.pendingRequest);
  el("route-start-summary").hidden = !selected || unavailable;
  el("replan-saved").hidden =
    !state.restored || !selected || navigationChecking || blocked || !!error;
  const text = navigationChecking
    ? navigation.message || "Verbindung wird geprüft …"
    : error ||
      (assessment?.status === "unknown" && !prepared
        ? ""
        : (assessment?.message ?? ""));
  const notice = el("navigation-start-notice");
  notice.textContent =
    text +
    ((blocked || distant) && !navigator.onLine
      ? " Neue Verbindungen benötigen Internet."
      : "");
  notice.hidden = !notice.textContent;
  const search = el<HTMLButtonElement>("navigation-search-now");
  search.hidden = !selected || !(blocked || distant) || navigationChecking;
  search.disabled = !navigator.onLine || navigationChecking;
  search.textContent = distant ? "Ab hier suchen" : "Ab jetzt suchen";
  const button = el<HTMLButtonElement>("navigation-start");
  button.hidden = state.restored ? !selected || unavailable : !currentPlanning;
  const retry = el<HTMLButtonElement>("navigation-start-retry");
  retry.hidden =
    !selected || !error || blocked || distant || navigationChecking;
  retry.textContent = navigation.needsLocation
    ? "Standort erneut anfragen"
    : "Erneut versuchen";
  const recovery = el("navigation-start-recovery");
  recovery.hidden = search.hidden && retry.hidden;
  button.disabled =
    !selected || !state.request || navigationChecking || unavailable;
  button.className = state.restored ? "secondary" : "primary";
  button.setAttribute(
    "aria-label",
    navigationChecking
      ? "Wird geprüft …"
      : state.restored
        ? "Mit gespeicherter Route starten"
        : "Navigation starten",
  );
  button.setAttribute("aria-busy", String(navigationChecking));
  if (notice.hidden) button.removeAttribute("aria-describedby");
  else button.setAttribute("aria-describedby", notice.id);
  button.replaceChildren(
    ...(navigationChecking
      ? [document.createTextNode("Wird geprüft …")]
      : state.restored
        ? [document.createTextNode("Mit gespeicherter Route starten")]
        : [icon("location"), document.createTextNode("Los")]),
  );
  document.querySelector<HTMLElement>(".panel-actions")!.hidden =
    !currentPlanning &&
    notice.hidden &&
    recovery.hidden &&
    el("replan-saved").hidden;
}
setInterval(() => {
  if (view === "map" && !document.hidden && !navigationView?.visible)
    renderNavigationCheck();
}, 5000);
async function launchNavigation(replan = false, restored?: NavigationSnapshot) {
  if (navigationChecking) return;
  if (navigationView?.visible && navigation?.engine) {
    if (replan) await navigation.reroute();
    return;
  }
  restored ??=
    session.state.restored &&
    navigationStart?.restored?.journey.id === session.state.selected?.id
      ? navigationStart?.restored
      : undefined;
  if (restored) {
    restorePlanContext({
      request: restored.request,
      settings: restored.settings,
    });
    session.restore(
      restored.journey,
      restored.request,
      restored.savedAt,
      restored.settings,
    );
    show("map", false);
    journeyView.showScreen("detail", false);
  }
  const state = session.state;
  if (!restored && (!state.selected || !state.request)) return;
  navigationStart = restored
    ? { ...restored, restored }
    : {
        journey: structuredClone(state.selected!),
        request: structuredClone(state.request!),
        settings: structuredClone(state.resultSettings ?? settings),
      };
  const generation = ++navigationLaunchGeneration;
  navigationCheckKey = navigationContextKey();
  navigationCheckError = "";
  preparedNavigation = undefined;
  navigationChecking = true;
  settingsReplanPending = false;
  session.stop("");
  syncLiveLocation();
  renderNavigationCheck();
  try {
    const start = navigationStart;
    const prepared = await navigation!.prepareStart(
      start.journey,
      start.request,
      start.settings,
      start.restored,
      replan,
    );
    if (
      generation !== navigationLaunchGeneration ||
      navigationCheckKey !== navigationContextKey()
    )
      return;
    preparedNavigation = prepared;
    if (blocksNavigation(prepared.assessment) && !restored) {
      el("navigation-start-notice").focus({ preventScroll: true });
      return;
    }
    // Commit the checked selection only once it can actually be started.
    const showing = navigationView!.show(navigation!);
    document.body.dataset.navigation = "active";
    el("map-view").hidden = true;
    syncLiveLocation();
    await showing;
    if (generation !== navigationLaunchGeneration || !navigationView!.visible)
      return;
    if (!navigation!.activateStart(prepared)) {
      navigationView!.hide();
      delete document.body.dataset.navigation;
      el("map-view").hidden = false;
      return;
    }
    history.pushState(
      { ...history.state, navigation: true, position: ++historyPosition },
      "",
      location.href,
    );
    navigationView!.render();
    el("navigation-instruction").focus({ preventScroll: true });
  } catch (error) {
    if (generation !== navigationLaunchGeneration) return;
    navigationCheckError =
      error instanceof DOMException && error.name === "AbortError"
        ? "Navigationsstart unterbrochen. Bitte erneut versuchen."
        : errorText(error);
    if (navigationView?.visible && !navigation?.engine) {
      navigationView.hide();
      delete document.body.dataset.navigation;
      el("map-view").hidden = false;
    }
  } finally {
    if (generation === navigationLaunchGeneration) {
      navigationChecking = false;
      syncLiveLocation();
      renderNavigationCheck();
    }
  }
}
el("navigation-start-retry").onclick = () => void launchNavigation();
el("navigation-search-now").onclick = async () => {
  if (!navigator.onLine || !session.state.request) return;
  const request = structuredClone(session.state.request);
  const fromHere = navigation?.distantStart && navigation.fix;
  if (fromHere) request.origin = fixPlace(fromHere);
  request.timing = "now";
  request.time = Date.now() / 1000;
  cancelNavigationCheck();
  writeHistory();
  activePlanId = crypto.randomUUID();
  openedHistoryId = undefined;
  activePlan = { request, settings: structuredClone(settings) };
  restorePlanContext(activePlan);
  journeyView.showScreen("list", false);
  writeHistory(true);
  await session.calculate(
    request,
    settings,
    request.origin.name === "Aktueller Standort",
  );
};
async function endNavigation() {
  navigationLaunchGeneration++;
  navigationStart = undefined;
  const journey = navigation?.engine?.journey;
  const request = navigation?.request;
  const options = navigation?.settings;
  const routeChanged = navigation?.routeChanged ?? false;
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
    openedHistoryId = undefined;
    activePlanId ??= crypto.randomUUID();
    restorePlanContext(activePlan, false);
    session.returnFromNavigation(
      journey,
      activePlan.request,
      activePlan.settings,
      routeChanged,
    );
    settingsUI();
  }
  el("map-view").hidden = false;
  showRouteMap(session.state);
  const resultNavigation = journeyView.snapshot();
  delete resultNavigation.savedOrigin;
  journeyView.restoreNavigation({
    ...resultNavigation,
    screen: "detail",
    mapReturn: "list",
  });
  syncLiveLocation();
  writeHistory(false, 0);
  renderPlanning(session.state);
  cancelNavigationCheck();
  const primary = el<HTMLButtonElement>(
    !el("navigation-search-now").hidden
      ? "navigation-search-now"
      : "navigation-start",
  );
  if (primary.disabled || primary.hidden) journeyView.focusSelection();
  else primary.focus({ preventScroll: true });
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
  if (restoringSettingsPosition !== undefined) return;
  history[push ? "pushState" : "replaceState"](
    {
      position: push ? ++historyPosition : historyPosition,
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
  settingsUI();
}
function beginPlanning() {
  cancelNavigationCheck();
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
  activePlan = {
    request: structuredClone(parsed.plan.request),
    settings: structuredClone(settings),
  };
  activePlanId = id ?? crypto.randomUUID();
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
    // A history entry identifies an exact calculation, including its settings.
    // Restoring that result must not roll back the user's current preferences.
    activePlan = structuredClone(previousResult.plan);
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
  if (navigator.onLine) await session.calculate(request, settings, false);
}
function show(next: View, push = true) {
  if (next !== view) cancelNavigationCheck();
  if (restoringSettingsPosition !== undefined) return false;
  if (
    view === "settings" &&
    next !== "settings" &&
    !settingsValidation.validate()
  )
    return false;
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
  cancelNavigationCheck();
  const position = Number.isSafeInteger(event.state?.position)
    ? (event.state.position as number)
    : historyPosition - 1;
  if (restoringSettingsPosition !== undefined) {
    if (position !== restoringSettingsPosition) {
      history.go(restoringSettingsPosition - position);
      return;
    }
    historyPosition = position;
    restoringSettingsPosition = undefined;
    writeHistory();
    settingsValidation.validate();
    return;
  }
  if (view === "settings" && !settingsValidation.validate()) {
    restoringSettingsPosition = historyPosition;
    history.go(historyPosition - position);
    return;
  }
  historyPosition = position;
  const revision = ++navigationRevision;
  const navigation = event.state?.journeyNavigation as
    JourneyNavigation | undefined;
  if (navigationView?.visible) {
    history.pushState(
      { ...history.state, navigation: true, position: ++historyPosition },
      "",
      location.href,
    );
    if (!navigationView.dismissConfirmation()) navigationView.confirmEnd();
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
      toast("Diese gespeicherte Strecke ist nicht mehr vorhanden.");
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
    ? "Noch keine Strecken. Erfolgreiche Planungen werden hier automatisch gespeichert."
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
        `${navigator.onLine ? "Strecke erneut planen" : "Gespeicherten Stand ansehen"}: ${description}`,
      );
      open.onclick = () => void openStoredRoute(entry.snapshot, entry.id);
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
          "history-via",
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
    remove.title = "Strecke löschen";
    remove.type = "button";
    remove.setAttribute("aria-label", `Strecke löschen: ${description}`);
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
          toast("Strecke wiederhergestellt.");
        } else
          toast(
            result === "newer"
              ? "Diese Strecke ist bereits gespeichert. Die aktuelle Planung bleibt erhalten."
              : "Strecke konnte nicht wiederhergestellt werden. Der Verlauf ist voll oder wurde geändert.",
          );
      } catch {
        toast(
          "Strecke konnte nicht wiederhergestellt werden. Speicher nicht verfügbar.",
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
    toast("Strecke konnte nicht gelöscht werden. Bitte erneut versuchen.");
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
  el("open-saved").querySelector("strong")!.textContent = navigator.onLine
    ? "Letzte Strecke erneut planen"
    : "Letzte Strecke ansehen";
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
        clearStorageMessage("save");
      }
    }
  } catch {
    storageMessage("save", "Reise konnte nicht offline gespeichert werden.");
    toast(
      "Offline-Speicherung nicht verfügbar. Deine Online-Reise bleibt nutzbar.",
      "save",
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
  if (navigationChecking && navigationCheckKey !== navigationContextKey())
    cancelNavigationCheck();
  if (activePlanId && activePlan && (state.request || state.pendingRequest)) {
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
  el("replan-saved").hidden = !state.restored || !state.selected;
  el<HTMLButtonElement>("replan-saved").disabled =
    !navigator.onLine || state.busy;
  el<HTMLButtonElement>("update-now").disabled =
    state.busy || dialog.open || !!navigationView?.visible;
  renderNavigationCheck();
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
const sharedDialog = el<HTMLDialogElement>("shared-dialog");
const sharedNavigationDialog = el<HTMLDialogElement>(
  "shared-navigation-dialog",
);
const sharedSearch = new PlaceSearch(
  "shared-destination",
  api,
  el("shared-status"),
  (place) => void acceptSharedPlace(place),
  book,
  toast,
  false,
);
function sharedUI() {
  el("shared-pending").hidden =
    !pendingShared || sharedDialog.open || sharedNavigationDialog.open;
}
function forgetShared() {
  const id = pendingShared?.id;
  pendingShared = undefined;
  try {
    if (JSON.parse(localStorage.getItem(sharedStorageKey) ?? "null")?.id === id)
      localStorage.removeItem(sharedStorageKey);
  } catch {
    /* Import is already held in the editable planning context. */
  }
  sharedUI();
}
function presentSharedDestination() {
  if (!pendingShared) return;
  const parsed = parseSharedDestination(pendingShared.payload);
  if (parsed.kind === "place") {
    void acceptSharedPlace(parsed.place);
    return;
  }
  sharedSearch.set();
  el("shared-error").textContent =
    parsed.kind === "query"
      ? ""
      : parsed.kind === "invalid"
        ? "Geteiltes Ziel ungültig. Bitte Ziel eingeben."
        : unsupportedShare;
  sharedDialog.showModal();
  sharedUI();
  if (parsed.kind === "query") {
    sharedSearch.searchShared(parsed.query);
    sharedSearch.input.focus();
  }
}
function openSharedDestination() {
  if (!pendingShared) return;
  if (navigationView?.visible || sharedResume) {
    const parsed = parseSharedDestination(pendingShared.payload);
    const label =
      parsed.kind === "place"
        ? parsed.place.name
        : parsed.kind === "query"
          ? parsed.query
          : "das geteilte Ziel";
    el("shared-navigation-description").textContent =
      `Neue Route zu ${label} planen? Die laufende Navigation wird beendet.`;
    sharedNavigationDialog.showModal();
    sharedUI();
  } else presentSharedDestination();
}
async function acceptSharedPlace(place: Place) {
  sharedSearch.cancel();
  sharedDialog.close();
  destination.set(place);
  originOverride = undefined;
  stops = [];
  timing = "now";
  time = Date.now() / 1000;
  contextUI();
  forgetShared();
  updateSearchEmpty();
  await start(place);
}
el("shared-pending").onclick = openSharedDestination;
el("shared-cancel").onclick = () => sharedDialog.close();
el("shared-discard").onclick = () => {
  forgetShared();
  sharedDialog.close();
};
sharedDialog.addEventListener("close", () => {
  sharedSearch.cancel();
  sharedUI();
});
sharedNavigationDialog.addEventListener("close", sharedUI);
const keepSharedNavigation = () => {
  sharedNavigationDialog.close();
  const snapshot = sharedResume;
  sharedResume = undefined;
  if (snapshot) void launchNavigation(false, snapshot);
};
el("shared-navigation-keep").onclick = keepSharedNavigation;
sharedNavigationDialog.oncancel = (event) => {
  event.preventDefault();
  keepSharedNavigation();
};
el("shared-navigation-replace").onclick = async () => {
  sharedNavigationDialog.close();
  if (navigationView?.visible) await endNavigation();
  else if (sharedResume) {
    try {
      await navigationStore.clear();
    } catch {
      toast("Gespeicherte Navigation konnte nicht gelöscht werden.");
      return;
    }
  }
  sharedResume = undefined;
  presentSharedDestination();
};
sharedUI();
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
  el("adjust-location-announcement").textContent = "";
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
  cancelNavigationCheck();
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
  const requestResolved = session.state.pendingRequest
    ? session.state.pendingRequestResolved === true
    : !!session.state.selected;
  const requestedTiming = request?.timing ?? timing;
  const draftTiming =
    requestedTiming === "now" && requestResolved ? "depart" : requestedTiming;
  el<HTMLInputElement>("timing").value = draftTiming;
  el<HTMLInputElement>("when").value = localDate(
    new Date(
      (draftTiming === "now" ? Date.now() / 1000 : (request?.time ?? time)) *
        1000,
    ),
  );
  updateTiming();
  el("adjust-status").textContent = "";
  el("adjust-location-announcement").textContent = "";
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
      el("adjust-status").textContent = "";
      el("adjust-location-announcement").textContent = "Standort ermittelt";
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      el("adjust-status").textContent = errorText(error);
      el("adjust-location-help").hidden = false;
    }
  } finally {
    if (draftLocationRequest === controller) {
      draftLocationRequest = undefined;
      el<HTMLButtonElement>("origin-location").disabled = false;
    }
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
    date = parseLocalMinute(el<HTMLInputElement>("when").value),
    seconds =
      selectedTiming === "now"
        ? Date.now() / 1000
        : date
          ? date.getTime() / 1000
          : NaN;
  if (!Number.isFinite(seconds)) {
    el("adjust-status").textContent = "Bitte einen gültigen Zeitpunkt wählen.";
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
  foldingDuration: "Zeit je Falten / Entfalten",
  maxBikeTransfers: "Radverbindungen zwischen Linien",
};
function settingsUI() {
  el("settings-fields").replaceChildren();
  el("settings-extra-fields").replaceChildren();
  const orderedKeys: (keyof typeof ranges)[] = [
    "cyclingSpeedKilometersPerHour",
    "maxCyclingMinutes",
    "foldingDuration",
    "maxWalkingMinutes",
    "maxBikeTransfers",
  ];
  for (const key of orderedKeys) {
    const [min, max, step] = ranges[key];
    const k = key as keyof typeof ranges,
      divisor = k === "foldingDuration" ? 60 : 1;
    const label = node("label", "", "setting-row"),
      copy = node("span", labels[k]);
    if (k === "maxWalkingMinutes" || k === "maxBikeTransfers")
      copy.append(
        node(
          "small",
          k === "maxBikeTransfers" ? "Maximale Anzahl" : "Maximal je Fußweg",
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
        "Pro Radetappe. Falten, Entfalten und Anschlusspuffer kommen hinzu.",
      );
      hint.id = "cycling-limit-hint";
      copy.append(hint);
      input.setAttribute("aria-describedby", hint.id);
    }
    const value = node("span", "", "setting-value");
    const unit = node(
      "span",
      k === "cyclingSpeedKilometersPerHour"
        ? "km/h"
        : k === "maxBikeTransfers"
          ? ""
          : "min",
      "setting-unit",
    );
    unit.id = `${k}-unit`;
    if (unit.textContent) {
      input.setAttribute(
        "aria-describedby",
        [input.getAttribute("aria-describedby"), unit.id]
          .filter(Boolean)
          .join(" "),
      );
    }
    value.append(input, unit);
    label.append(copy, value);
    settingsValidation.bind(input, label);
    el(
      k === "maxWalkingMinutes" || k === "maxBikeTransfers"
        ? "settings-extra-fields"
        : "settings-fields",
    ).append(label);
  }
  const toggle = node("label", "", "toggle-row");
  const text = node("span", "Fahrradvergleich anzeigen");
  const hint = node(
    "small",
    "Zeigt zusätzlich reine Radstrecken über deinem Radzeitlimit. Kürzere Radstrecken bleiben sichtbar.",
  );
  hint.id = "cycling-comparison-hint";
  text.append(hint);
  const checkbox = node("input");
  checkbox.type = "checkbox";
  checkbox.id = "showCyclingComparison";
  checkbox.setAttribute("role", "switch");
  checkbox.setAttribute("aria-describedby", hint.id);
  checkbox.checked = settings.showCyclingComparison;
  checkbox.onchange = () =>
    applySettings({ ...settings, showCyclingComparison: checkbox.checked });
  toggle.append(text, checkbox);
  el("settings-extra-fields").append(toggle);
  el("modes").replaceChildren();
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
  el("settings-replan").hidden =
    !settingsReplanPending || !session.state.request;
  el("settings-replan").textContent =
    "Die Route wird beim Verlassen neu berechnet.";
  const selected = Object.entries(modes)
    .filter(
      ([key]) =>
        !settings.excludedTransitModes.includes(key as keyof typeof modes),
    )
    .map(([, mode]) => mode.name);
  el("modes-summary").textContent =
    selected.length === Object.keys(modes).length
      ? "Alle Verkehrsmittel"
      : selected.length
        ? selected.join(" · ")
        : "Keine ausgewählt";
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
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
    localStorage.removeItem(legacyStorageKey);
    clearStorageMessage("settings");
  } catch {
    toast(
      "Einstellungen konnten nicht dauerhaft gespeichert werden. Sie gelten für diese Sitzung.",
      "settings",
    );
  }
  settingsSummary();
}
function openSettings() {
  if (view === "settings") return;
  beforeSettings = view;
  settingsUI();
  show("settings");
}
el("tab-history").onclick = () => {
  if (show("history") === false) return;
  void reloadHistory().catch(() =>
    toast("Strecken konnten nicht geladen werden."),
  );
};
el("tab-settings").onclick = openSettings;
el("late-settings").onclick = openSettings;
el("tab-route").onclick = () => {
  show(session.state.request ? "map" : "search");
};
el("reset-settings").onclick = () => {
  applySettings(structuredClone(defaults));
  settingsUI();
};
const settingsHeading = document.querySelector<HTMLElement>(
  ".settings-heading-row",
)!;
new ResizeObserver(() => {
  el("settings-view").style.setProperty(
    "--settings-heading-height",
    `${settingsHeading.getBoundingClientRect().height}px`,
  );
}).observe(settingsHeading);
el("settings-form").addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== target) return;
    if (
      target.getBoundingClientRect().top <
      settingsHeading.getBoundingClientRect().bottom + 8
    )
      target.scrollIntoView({ block: "nearest" });
  });
});
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
    forgetShared();
    localStorage.removeItem(sharedStorageKey);
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
    settings = structuredClone(defaults);
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
    clearStorageMessage("toggle", "disabled");
    if (!enabled) {
      suppressCurrentSave();
      saved = undefined;
      historyEntries = [];
      storageMessage(
        "disabled",
        "Strecken gelöscht. Speicherung ausgeschaltet.",
      );
    } else {
      if (activeSnapshot && session.state.calculationId)
        await persist(activeSnapshot, session.state.calculationId);
    }
    savedUI();
  } catch {
    if (generation !== storageGeneration) return;
    offlineEnabled = previous;
    syncHistoryNames();
    savedUI();
    storageMessage(
      "toggle",
      "Offline-Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.",
    );
    toast(
      "Speicher nicht verfügbar. Änderung konnte nicht dauerhaft übernommen werden.",
      "toggle",
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
    storageMessage("history", "Streckenverlauf gelöscht.");
  } catch {
    el("delete-history-status").textContent =
      "Löschen fehlgeschlagen. Bitte erneut versuchen.";
  } finally {
    button.disabled = false;
  }
};
function restorePlanContext(plan: RouteLink, freezeLocation = true) {
  // Restored endpoints stay fixed even if their original label came from GPS.
  for (const place of freezeLocation
    ? [plan.request.origin, plan.request.destination]
    : []) {
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
el("open-saved").onclick = () => {
  if (saved) void openStoredRoute(saved, historyEntries[0]?.id);
};
async function openStoredRoute(snapshot: SavedJourney, id?: string) {
  if (!navigator.onLine) {
    openSnapshot(snapshot, id);
    return;
  }
  const entry = historyEntries.find((item) => item.id === id);
  await replanStoredRequest(
    (entry ? historySnapshot(entry) : snapshot).request,
  );
}
async function replanStoredRequest(original: RouteRequest) {
  const request = structuredClone(original);
  request.timing = "now";
  request.time = Date.now() / 1000;
  if (request.origin.name === "Aktueller Standort")
    request.origin.name = "Startpunkt";
  if (request.destination.name === "Aktueller Standort")
    request.destination.name = "Zielpunkt";
  const plan = { request, settings: structuredClone(settings) };
  restorePlanContext(plan);
  openedHistoryId = undefined;
  beginPlanning();
  activePlan = plan;
  session.prepare(request);
  writeHistory();
  await session.calculate(request, settings, false);
}
el("replan-saved").onclick = () => {
  if (activePlan && navigator.onLine)
    void replanStoredRequest(activePlan.request);
};
el("recover-planning").onclick = async () => {
  const recovery = session.state.recovery;
  if (!recovery || session.state.busy) return;
  if (recovery.action === "adjust") {
    openAdjust(recovery.request.destination);
    el("adjust-status").textContent = session.state.message;
    return;
  }
  if (!navigator.onLine || (recovery.retryAt ?? 0) > Date.now() / 1000) return;
  const request = structuredClone(recovery.request);
  const result = await session.calculate(
    request,
    settings,
    request.origin.name === "Aktueller Standort",
  );
  if (result === "location-error" && view === "map" && !dialog.open) {
    openAdjust(request.destination);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
  }
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
  renderNavigationCheck();
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
      if (snapshot && initialShare && navigationLaunchGeneration === 0) {
        sharedResume = snapshot;
        initializeLink();
        return;
      }
      const sameLink =
        snapshot &&
        initialLink.kind === "plan" &&
        routeURL(location.href, initialLink.plan).href ===
          routeURL(location.href, {
            request: snapshot.request,
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
      storageMessage(
        "load",
        "Nicht lesbare gespeicherte Strecken wurden entfernt.",
      );
    if (
      !navigator.onLine &&
      saved &&
      view === "search" &&
      initialLink.kind === "none" &&
      !initialShare &&
      !activePlan
    )
      openSaved(false);
  })
  .catch(() => {
    storageMessage(
      "load",
      "Offline-Speicher nicht verfügbar. Online-Planung bleibt möglich.",
    );
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
  if (initialShare && !sharedInitialized) {
    sharedInitialized = true;
    openSharedDestination();
  } else if (initialLink.kind !== "none") void restoreLink(initialLink);
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
