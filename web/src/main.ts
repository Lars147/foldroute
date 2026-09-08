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
  type Place,
  type Timing,
} from "./model";
import { ApiClient } from "./transitous";
import { PlaceSearch, locate, clearSearchLocation } from "./search";
import { PlanningSession, type PlanningState } from "./planning-state";
import { RouteMap } from "./map-view";
import { JourneyView } from "./journey-view";
import { OfflineStore, type SavedJourney } from "./offline";
import { el, node, icon, localDate, clock, dateLabel } from "./ui";
import { setupPWA } from "./pwa";
import { PlaceBook } from "./places";
import { localDatabase } from "./storage";

type View = "search" | "map" | "settings";
let view: View = "search",
  settings: RoutingSettings = structuredClone(defaults);
let settingsReplanPending = false;
let originOverride: Place | undefined,
  timing: Timing = "now",
  time = Date.now() / 1000;
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
const session = new PlanningSession(api, renderPlanning);
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
  el("tab-route").toggleAttribute("aria-current", next !== "settings");
  if (next !== "settings") el("tab-route").setAttribute("aria-current", "page");
  el("tab-settings").toggleAttribute("aria-current", next === "settings");
  if (next === "settings")
    el("tab-settings").setAttribute("aria-current", "page");
  if (push) history.pushState({ view: next }, "", location.href);
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
history.replaceState({ view: "search" }, "", location.href);
window.addEventListener("popstate", (event) => {
  if (dialog.open) dialog.close();
  const next = event.state?.view as View;
  show(
    next === "settings"
      ? "settings"
      : next === "map" && session.state.request
        ? "map"
        : "search",
    false,
  );
});
function savedUI() {
  el("open-saved").hidden = !saved;
  el("saved-description").textContent = saved
    ? `${saved.journey.destination.name} · ${dateLabel(saved.savedAt)}, ${clock(saved.savedAt)}`
    : "";
  el<HTMLButtonElement>("delete-saved").disabled = !saved;
  el("offline-empty").hidden = navigator.onLine || !!saved;
  el<HTMLInputElement>("offline-enabled").checked = offlineEnabled;
}
async function persist(snapshot: SavedJourney) {
  const generation = storageGeneration;
  try {
    if (await store.save(snapshot)) {
      if (offlineEnabled && generation === storageGeneration) {
        saved = snapshot;
        savedUI();
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
  journeyView.render(state);
  if (view === "map") routeMap.show(state.journeys, state.selected);
  if (
    state.selected &&
    state.request &&
    state.resultSettings &&
    !state.restored
  ) {
    const key = JSON.stringify([state.selected.id, state.queriedAt]);
    if (key !== persistKey) {
      persistKey = key;
      activeSnapshot = {
        version: 3,
        savedAt: state.queriedAt,
        request: structuredClone(state.request),
        settings: structuredClone(state.resultSettings),
        journey: state.selected,
      };
      if (offlineEnabled) void persist(activeSnapshot);
    }
  }
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
let useLocation = true;
let draftLocationRequest: AbortController | undefined;
function cancelDraftLocation() {
  draftLocationRequest?.abort();
  draftLocationRequest = undefined;
  el<HTMLButtonElement>("origin-location").disabled = false;
}
function contextUI() {
  el("search-context").textContent =
    `${originOverride?.name ?? "Aktueller Standort"} · ${timing === "now" ? "Jetzt" : `${timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(time)}, ${clock(time)}`}`;
}
async function start(place: Place) {
  settingsReplanPending = false;
  if (!navigator.onLine) {
    el("place-status").textContent =
      "Für neue Routen brauchst du eine Internetverbindung.";
    return;
  }
  session.clear();
  journeyView.setSize("normal");
  show("map");
  const result = await session.calculate(
    {
      origin: originOverride ?? {
        name: "Aktueller Standort",
        detail: "",
        latitude: 0,
        longitude: 0,
      },
      destination: place,
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
  dialog.close();
  el<HTMLButtonElement>("update-now").disabled = session.state.busy;
}
dialog.addEventListener("close", () => {
  cancelDraftLocation();
  draftOrigin.cancel();
  draftDestination.cancel();
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
  originOverride = useLocation ? undefined : draftOrigin.value;
  timing = selectedTiming;
  time = seconds;
  contextUI();
  return true;
}
el("use-context").onclick = () => {
  if (readContext()) {
    closeAdjust();
    toast("Start und Zeitpunkt übernommen.");
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
  show("map");
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
  const request = session.state.request;
  if (!request) return;
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
  mapLocationRequest?.abort();
  destination.set();
  originOverride = undefined;
  timing = "now";
  time = Date.now() / 1000;
  contextUI();
  el("search-empty").hidden = false;
  el("place-status").textContent = "";
  show("search");
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
        "Gilt für jede Radetappe deiner ÖPNV-Reise. Falten, Entfalten und Anschlusspuffer kommen hinzu.",
      );
      hint.id = "cycling-limit-hint";
      copy.append(hint);
      input.setAttribute("aria-describedby", hint.id);
    }
    label.append(copy, input);
    el("settings-fields").append(label);
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
    `${settings.cyclingSpeedKilometersPerHour} km/h · ${settings.foldingDuration / 60} min je Falten und Entfalten. Änderungen werden gespeichert; beim Verlassen wird neu berechnet.`;
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
  show(session.state.request ? "map" : beforeSettings);
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
    offlineEnabled = true;
    settings = structuredClone(defaults);
    originOverride = undefined;
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
      saved = undefined;
      el("storage-message").textContent =
        "Gespeicherte Reise gelöscht. Offline-Speicherung ausgeschaltet.";
    } else {
      el("storage-message").textContent =
        "Die nächste gewählte Reise wird offline gespeichert.";
      if (activeSnapshot) await persist(activeSnapshot);
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
el("delete-saved").onclick = async () => {
  storageGeneration++;
  try {
    await store.clear();
    saved = undefined;
    savedUI();
    el("storage-message").textContent = "Gespeicherte Reise gelöscht.";
  } catch {
    el("storage-message").textContent =
      "Löschen fehlgeschlagen. Bitte erneut versuchen.";
  }
};
function openSaved() {
  if (!saved) return;
  session.restore(saved.journey, saved.request, saved.savedAt);
  destination.set(saved.request.destination);
  originOverride =
    saved.request.origin.name === "Aktueller Standort"
      ? undefined
      : saved.request.origin;
  timing = saved.request.timing;
  time = saved.request.time;
  contextUI();
  journeyView.setSize("normal");
  show("map");
}
el("open-saved").onclick = openSaved;
function connectionChanged() {
  el("connection").hidden = navigator.onLine;
  savedUI();
  if (view === "map") {
    journeyView.render(session.state);
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
    if (!activeSnapshot && storageGeneration === 0) saved = result.snapshot;
    savedUI();
    if (result.invalid)
      el("storage-message").textContent =
        "Eine nicht lesbare gespeicherte Reise wurde entfernt.";
    if (!navigator.onLine && saved && view === "search") openSaved();
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
