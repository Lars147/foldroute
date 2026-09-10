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
import { JourneyView } from "./journey-view";
import {
  OfflineStore,
  sameHistoryRoute,
  type SavedJourney,
  type HistoryEntry,
} from "./offline";
import { el, node, icon, localDate, clock, dateLabel } from "./ui";
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
let openedHistoryId: string | undefined;
const suppressedCalculations = new Set<string>();
let currentSaveSuppressed = false;
let planningWasBusy = false;
let view: View = "search",
  settings: RoutingSettings = structuredClone(defaults);
let settingsReplanPending = false;
let personalSettings: RoutingSettings;
let temporarySettings = false;
let activePlan: RouteLink | undefined;
let activePlanId: string | undefined;
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
const storageKey = "foldroute.routing.v3";
const legacyStorageKey = "foldroute.routing.v1";
try {
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
  () => journeyView.setSize("collapsed"),
);
const journeyView = new JourneyView((id) => session.select(id));
const session = new PlanningSession(api, renderPlanning, (request, options) => {
  openedHistoryId = undefined;
  activePlan = structuredClone({ request, settings: options });
  activePlanId ??= crypto.randomUUID();
  writeHistory();
});
function updateLinkUI() {
  el("copy-plan").hidden = !activePlan;
  el<HTMLButtonElement>("copy-plan").disabled = session.state.locating;
}
function writeHistory(push = false) {
  history[push ? "pushState" : "replaceState"](
    { view, planId: activePlanId, historyId: openedHistoryId },
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
  activePlan = undefined;
  activePlanId = crypto.randomUUID();
  settingsReplanPending = false;
  session.clear();
  activeSnapshot = undefined;
  persistKey = "";
  if (view === "map") writeHistory(true);
  else show("map");
}
async function restoreLink(
  parsed: ParsedRouteLink,
  next: View = "map",
  id?: string,
) {
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
  session.prepare(
    request,
    navigator.onLine
      ? ""
      : "Für diese Planung brauchst du Internet. Danach auf Aktualisieren tippen.",
  );
  show(next === "settings" ? "settings" : "map", false);
  writeHistory();
  if (next === "settings") {
    settingsReplanPending = true;
    return;
  }
  if (request.timing !== "now" && request.time < Date.now() / 1000) {
    const message =
      "Der Zeitpunkt dieses Links liegt in der Vergangenheit. Bitte einen neuen Zeitpunkt wählen.";
    session.stop(message);
    openAdjust(request.destination);
    el("adjust-status").textContent = message;
    return;
  }
  if (navigator.onLine) await session.calculate(request, settings, false);
}
function show(next: View, push = true) {
  const replan =
    view === "settings" &&
    next !== "settings" &&
    settingsReplanPending &&
    !!session.state.request;
  if (replan) {
    settingsReplanPending = false;
    next = "map";
  }
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
  document.body.dataset.view = next;
  el("search-view").hidden = next !== "search";
  el("map-view").hidden = next !== "map";
  el("settings-view").hidden = next !== "settings";
  el("history-view").hidden = next !== "history";
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
    routeMap.show(session.state.journeys, session.state.selected);
    requestAnimationFrame(() => routeMap.resize());
  }
  if (replan) void refreshRoute();
}
window.addEventListener("popstate", (event) => {
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
        openSnapshot(entry.snapshot, entry.id, false);
      show(next, false);
    } else {
      show("history", false);
      toast("Diese gespeicherte Fahrt ist nicht mehr vorhanden.");
    }
    return;
  }
  if (next === "history") {
    show("history", false);
    return;
  }
  if (event.state?.planId === activePlanId) {
    show(next === "map" && !session.state.request ? "search" : next, false);
    writeHistory();
  } else {
    void restoreLink(
      readRouteURL(new URL(location.href)),
      next,
      event.state?.planId,
    );
  }
});
function historyUI() {
  el("history-list").replaceChildren();
  el("history-empty").hidden = historyEntries.length > 0;
  el("history-empty").textContent = offlineEnabled
    ? "Noch keine Fahrten. Erfolgreiche Planungen werden hier automatisch gespeichert."
    : "Speicherung ausgeschaltet. Aktiviere sie in den Einstellungen, um deine nächsten Planungen zu behalten.";
  el<HTMLButtonElement>("delete-saved").disabled = !historyEntries.length;
  for (const entry of historyEntries) {
    const { journey, request } = entry.snapshot;
    const row = node("li", "", "history-row");
    const open = node("button", "", "history-open");
    open.type = "button";
    open.append(
      node(
        "strong",
        `${journey.origin.name === "Aktueller Standort" ? "Startpunkt" : journey.origin.name} → ${journey.destination.name}`,
      ),
    );
    if (request.stops?.length)
      open.append(
        node(
          "small",
          `Über ${request.stops.map((stop) => stop.place.name).join(" · ")}`,
        ),
      );
    open.onclick = () => openSnapshot(entry.snapshot, entry.id);
    const remove = node("button", "", "icon-button");
    remove.type = "button";
    remove.setAttribute(
      "aria-label",
      `Fahrt nach ${journey.destination.name} löschen`,
    );
    remove.append(icon("close"));
    remove.onclick = () => void deleteHistoryEntry(entry.id);
    row.append(open, remove);
    el("history-list").append(row);
  }
}
async function reloadHistory() {
  const generation = storageGeneration;
  const result = await store.read();
  if (generation !== storageGeneration) return;
  historyEntries = result.entries;
  saved = result.snapshot;
  savedUI();
}
async function deleteHistoryEntry(id: string) {
  storageGeneration++;
  const entry = historyEntries.find((item) => item.id === id);
  const request = activePlan?.request ?? session.state.request;
  if (entry && request && sameHistoryRoute(entry.snapshot.request, request))
    suppressCurrentSave();
  try {
    await store.remove(id);
    await reloadHistory();
    toast("Fahrt gelöscht.");
  } catch {
    toast("Fahrt konnte nicht gelöscht werden. Bitte erneut versuchen.");
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
function renderPlanning(state: PlanningState) {
  if (state.busy && !planningWasBusy) currentSaveSuppressed = false;
  planningWasBusy = state.busy;
  updateLinkUI();
  journeyView.render(state, settings.maxCyclingMinutes);
  if (view === "map") routeMap.show(state.journeys, state.selected);
  if (
    state.selected &&
    state.request &&
    state.resultSettings &&
    !state.restored &&
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
  el<HTMLButtonElement>("update-now").disabled = state.busy || dialog.open;
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
  journeyView.setSize("normal");
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
  if (result === "location-error") {
    openAdjust(place);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
    draftOrigin.input.focus();
  }
}
function openAdjust(target?: Place) {
  destination.cancel();
  const request = session.state.request;
  stopEditor.set(structuredClone(stops));
  draftOrigin.set(originOverride ?? request?.origin);
  useLocation = !originOverride || originOverride.name === "Aktueller Standort";
  if (useLocation && !draftOrigin.value)
    draftOrigin.input.value = "Aktueller Standort";
  draftDestination.set(target ?? request?.destination ?? destination.value);
  el<HTMLSelectElement>("timing").value = timing;
  el<HTMLInputElement>("when").value = localDate(
    new Date((timing === "now" ? Date.now() / 1000 + 3600 : time) * 1000),
  );
  updateTiming();
  el("adjust-status").textContent = "";
  el("adjust-location-help").hidden = true;
  dialog.showModal();
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
  el<HTMLButtonElement>("update-now").disabled = session.state.busy;
}
dialog.addEventListener("close", () => {
  cancelDraftLocation();
  draftOrigin.cancel();
  draftDestination.cancel();
  stopEditor.cancel();
  el<HTMLButtonElement>("update-now").disabled = session.state.busy;
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
  const hidden = el<HTMLSelectElement>("timing").value === "now";
  el("date-label").hidden = hidden;
  el<HTMLInputElement>("when").required = !hidden;
}
el("timing").onchange = updateTiming;
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
  const selectedTiming = el<HTMLSelectElement>("timing").value as Timing,
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
  journeyView.setSize("normal");
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
  if (result === "location-error") {
    openAdjust(target);
    el("adjust-status").textContent = session.state.message;
    el("adjust-location-help").hidden = false;
  }
};
async function refreshRoute() {
  const request = activePlan?.request ?? session.state.request;
  if (!request) return;
  if (request.timing !== "now" && request.time < Date.now() / 1000) {
    const message = "Bitte einen aktuellen oder zukünftigen Zeitpunkt wählen.";
    session.stop(message);
    openAdjust(request.destination);
    el("adjust-status").textContent = message;
    return;
  }
  const result = await session.calculate(
    request,
    settings,
    request.origin.name === "Aktueller Standort",
  );
  if (result === "location-error") {
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
};
el("cancel").onclick = () => session.stop();
el("dismiss-location-error").onclick = () => {
  el("map-location-error").hidden = true;
};
el("map-location").onclick = async () => {
  el("map-location-error").hidden = true;
  mapLocationRequest?.abort();
  mapLocationRequest = new AbortController();
  const signal = mapLocationRequest.signal;
  const button = el<HTMLButtonElement>("map-location");
  button.disabled = true;
  try {
    routeMap.center(await locate(signal));
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
    `${settings.cyclingSpeedKilometersPerHour} km/h · ${settings.foldingDuration / 60} min je Falten und Entfalten. ${temporarySettings ? "Einstellungen gelten nur für diese Planung; beim Verlassen wird neu berechnet." : "Änderungen werden gespeichert; beim Verlassen wird neu berechnet."}`;
}
function applySettings(next: RoutingSettings) {
  if (!validSettings(next) || JSON.stringify(settings) === JSON.stringify(next))
    return;
  settings = structuredClone(next);
  if (session.state.request) {
    session.invalidateForSettings();
    settingsReplanPending = true;
    activeSnapshot = undefined;
    persistKey = "";
  }
  if (activePlan) {
    activePlan = { ...activePlan, settings: structuredClone(settings) };
    writeHistory();
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
  const button = el<HTMLButtonElement>("confirm-delete-data");
  button.disabled = true;
  storageGeneration++;
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
    localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
    saved = undefined;
    historyEntries = [];
    offlineEnabled = true;
    personalSettings = structuredClone(defaults);
    releasePlan();
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
el("offline-enabled").onchange = async () => {
  const checkbox = el<HTMLInputElement>("offline-enabled");
  const enabled = checkbox.checked,
    previous = offlineEnabled;
  const generation = ++storageGeneration;
  checkbox.disabled = true;
  offlineEnabled = enabled;
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
  const button = el<HTMLButtonElement>("confirm-delete-history");
  button.disabled = true;
  storageGeneration++;
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
function openSnapshot(snapshot: SavedJourney, id?: string, push = true) {
  settingsReplanPending = false;
  openedHistoryId = id;
  activePlan = {
    request: structuredClone(snapshot.request),
    settings: migrateSettings(snapshot.settings)!,
  };
  // Historic coordinates stay fixed, even when their original label was GPS-based.
  for (const place of [
    activePlan.request.origin,
    activePlan.request.destination,
  ]) {
    if (place.name === "Aktueller Standort")
      place.name =
        place === activePlan.request.origin ? "Startpunkt" : "Zielpunkt";
  }
  settings = structuredClone(activePlan.settings);
  temporarySettings = true;
  activePlanId = crypto.randomUUID();
  session.restore(snapshot.journey, activePlan.request, snapshot.savedAt);
  destination.set(activePlan.request.destination);
  originOverride = activePlan.request.origin;
  stops = structuredClone(activePlan.request.stops ?? []);
  timing = activePlan.request.timing;
  time = activePlan.request.time;
  contextUI();
  settingsUI();
  journeyView.setSize("normal");
  if (view === "map") {
    if (push) writeHistory(true);
  } else show("map", push);
}
function openSaved() {
  if (saved) openSnapshot(saved, historyEntries[0]?.id);
}
el("open-saved").onclick = openSaved;
el("replan-saved").onclick = async () => {
  if (!activePlan || !navigator.onLine) return;
  const request = structuredClone(activePlan.request);
  request.timing = "now";
  request.time = Date.now() / 1000;
  timing = "now";
  time = request.time;
  contextUI();
  await session.calculate(request, settings, false);
};
function connectionChanged() {
  el("connection").hidden = navigator.onLine;
  savedUI();
  el<HTMLButtonElement>("replan-saved").disabled =
    !navigator.onLine || session.state.busy;
  if (view === "map") {
    journeyView.render(session.state, settings.maxCyclingMinutes);
    routeMap.show(session.state.journeys, session.state.selected);
  }
  if (!navigator.onLine && session.state.busy)
    session.stop("Offline. Bereits gefundene Verbindungen bleiben verfügbar.");
}
window.addEventListener("online", connectionChanged);
window.addEventListener("offline", connectionChanged);
void store
  .read()
  .then((result) => {
    if (storageGeneration === 0) offlineEnabled = result.enabled;
    if (!activeSnapshot && storageGeneration === 0) {
      saved = result.snapshot;
      historyEntries = result.entries;
    }
    savedUI();
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
      openSaved();
  })
  .catch(() => {
    el("storage-message").textContent =
      "Offline-Speicher nicht verfügbar. Online-Planung bleibt möglich.";
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
if (initialLink.kind !== "none") void restoreLink(initialLink);
else writeHistory();
el("copy-plan").onclick = async () => {
  if (!activePlan || session.state.locating) return;
  const link = routeURL(location.href, activePlan).href;
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(link);
    toast("Planungslink kopiert.");
  } catch {
    const input = el<HTMLInputElement>("plan-link-value");
    input.value = link;
    el("plan-link-fallback").hidden = false;
    input.focus();
    input.select();
  }
};
