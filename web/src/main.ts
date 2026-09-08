import "./style.css";
import {
  defaults,
  ranges,
  modes,
  validSettings,
  errorText,
  type RoutingSettings,
  type RouteRequest,
  type Place,
  type Timing,
} from "./model";
import { ApiClient } from "./transitous";
import { PlaceSearch, locate } from "./search";
import { PlanningSession, type PlanningState } from "./planning-state";
import { RouteMap } from "./map-view";
import { JourneyView } from "./journey-view";
import { OfflineStore, type SavedJourney } from "./offline";
import { el, node, icon, localDate, clock, dateLabel } from "./ui";
import { setupPWA } from "./pwa";

type View = "search" | "map" | "settings";
let view: View = "search",
  settings: RoutingSettings = structuredClone(defaults),
  settingsDraft = structuredClone(settings);
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
  dialog = el<HTMLDialogElement>("adjust-dialog");
const storageKey = "foldroute.routing.v1";
try {
  const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  if (validSettings(value)) settings = value;
} catch {
  el("storage-message").textContent =
    "Einstellungen gelten nur für diese Sitzung.";
}
settingsDraft = structuredClone(settings);
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
  if (view === next) {
    if (next === "map") requestAnimationFrame(() => routeMap.resize());
    return;
  }
  if (next !== "search") destination.cancel();
  if (next !== "map") {
    mapLocationRequest?.abort();
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
  if (next === "map") {
    routeMap.show(session.state.journeys, session.state.selected);
    requestAnimationFrame(() => routeMap.resize());
  }
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
  try {
    if (await store.save(snapshot)) {
      if (offlineEnabled) {
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
  if (state.selected && state.request && !state.restored) {
    const key = JSON.stringify([state.selected.id, state.queriedAt]);
    if (key !== persistKey) {
      persistKey = key;
      activeSnapshot = {
        version: 1,
        savedAt: state.queriedAt,
        request: structuredClone(state.request),
        settings: structuredClone(settings),
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
);
destination.input.addEventListener(
  "input",
  () => (el("search-empty").hidden = destination.input.value.length > 0),
);
const draftOrigin = new PlaceSearch("origin", api, el("adjust-status"), () => {
  useLocation = false;
});
const draftDestination = new PlaceSearch(
  "adjust-destination",
  api,
  el("adjust-status"),
  () => {},
);
let useLocation = true;
function contextUI() {
  el("search-context").textContent =
    `${originOverride?.name ?? "Aktueller Standort"} · ${timing === "now" ? "Jetzt" : `${timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(time)}, ${clock(time)}`}`;
}
async function start(place: Place) {
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
    el("adjust-status").textContent =
      "Standort nicht verfügbar. Wähle deinen Start.";
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
  dialog.showModal();
  el<HTMLButtonElement>("update-now").disabled = true;
}
function closeAdjust() {
  draftOrigin.cancel();
  draftDestination.cancel();
  dialog.close();
  el<HTMLButtonElement>("update-now").disabled = session.state.busy;
}
dialog.addEventListener("close", () => {
  draftOrigin.cancel();
  draftDestination.cancel();
  el<HTMLButtonElement>("update-now").disabled = session.state.busy;
});
el("search-adjust").onclick = () => openAdjust();
el("adjust-route").onclick = () => openAdjust();
el("cancel-adjust").onclick = closeAdjust;
el("origin-location").onclick = () => {
  useLocation = true;
  draftOrigin.set();
  draftOrigin.input.value = "Aktueller Standort";
  el("adjust-status").textContent = "Standort wird beim Berechnen ermittelt.";
};
draftOrigin.input.addEventListener("input", () => (useLocation = false));
el("swap").onclick = () => {
  if (!draftOrigin.value || !draftDestination.value) {
    el("adjust-status").textContent = "Zum Tauschen beide Orte auswählen.";
    return;
  }
  const origin = draftOrigin.value;
  draftOrigin.set(draftDestination.value);
  draftDestination.set(origin);
  useLocation = false;
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
      seconds < Date.now() / 1000 - 60)
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
    el("adjust-status").textContent =
      "Standort nicht verfügbar. Wähle deinen Start.";
  }
};
el("refresh-route").onclick = async () => {
  const request = session.state.request;
  if (!request) return;
  const result = await session.calculate(
    request,
    settings,
    request.origin.name === "Aktueller Standort",
  );
  if (result === "location-error") openAdjust(request.destination);
};
el("close-route").onclick = () => {
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
el("map-location").onclick = async () => {
  mapLocationRequest?.abort();
  mapLocationRequest = new AbortController();
  const signal = mapLocationRequest.signal;
  const button = el<HTMLButtonElement>("map-location");
  button.disabled = true;
  try {
    routeMap.center(await locate(signal));
  } catch (error) {
    if (!signal.aborted) toast(errorText(error));
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
};

const labels: Record<keyof typeof ranges, string> = {
  cyclingSpeedKilometersPerHour: "Radgeschwindigkeit",
  maxCyclingAccessMinutes: "Rad zum / vom ÖPNV",
  maxWalkingMinutes: "Fußweg zum / vom ÖPNV",
  foldDuration: "Zeit zum Falten",
  unfoldDuration: "Zeit zum Entfalten",
  maxBikeTransfers: "Radverbindungen zwischen Linien",
  maxBikeTransferMinutes: "Je Radverbindung",
};
function settingsUI() {
  el("settings-fields").replaceChildren();
  for (const [key, [min, max, step]] of Object.entries(ranges)) {
    const k = key as keyof typeof ranges,
      divisor = k === "foldDuration" || k === "unfoldDuration" ? 60 : 1;
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
    input.value = String(settingsDraft[k] / divisor);
    input.required = true;
    input.oninput = () => {
      if (input.checkValidity())
        settingsDraft[k] = Number(input.value) * divisor;
    };
    label.append(copy, input);
    el("settings-fields").append(label);
  }
  el("modes").replaceChildren(node("legend", "Verkehrsmittel"));
  for (const [key, mode] of Object.entries(modes)) {
    const label = node("label", "", "toggle-row"),
      input = node("input");
    input.type = "checkbox";
    input.checked = !settingsDraft.excludedTransitModes.includes(
      key as keyof typeof modes,
    );
    input.dataset.mode = key;
    input.onchange = () => {
      settingsDraft.excludedTransitModes = Array.from(
        el("modes").querySelectorAll<HTMLInputElement>("input"),
      )
        .filter((i) => !i.checked)
        .map((i) => i.dataset.mode as keyof typeof modes);
    };
    label.append(node("span", mode.name), input);
    el("modes").append(label);
  }
  el("settings-summary").textContent =
    `${settings.cyclingSpeedKilometersPerHour} km/h · ${settings.foldDuration / 60} / ${settings.unfoldDuration / 60} min Falten / Entfalten`;
  el("save-settings").textContent = session.state.selected
    ? "Übernehmen & neu berechnen"
    : "Einstellungen übernehmen";
}
function openSettings() {
  beforeSettings = view === "settings" ? beforeSettings : view;
  settingsDraft = structuredClone(settings);
  settingsUI();
  show("settings");
}
el("tab-settings").onclick = openSettings;
el("header-settings").onclick = openSettings;
el("tab-route").onclick = () => {
  show(session.state.selected || session.state.busy ? "map" : "search");
};
el("discard-settings").onclick = () => show(beforeSettings);
el("reset-settings").onclick = () => {
  settingsDraft = structuredClone(defaults);
  settingsUI();
};
el("settings-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!validSettings(settingsDraft)) return;
  const changed = JSON.stringify(settings) !== JSON.stringify(settingsDraft);
  settings = structuredClone(settingsDraft);
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    el("storage-message").textContent =
      "Einstellungen gelten nur für diese Sitzung.";
    toast("Einstellungen konnten nicht dauerhaft gespeichert werden.");
  }
  show(session.state.selected ? "map" : beforeSettings);
  settingsUI();
  if (changed && session.state.request) {
    if (navigator.onLine)
      await session.calculate(
        session.state.request,
        settings,
        session.state.request.origin.name === "Aktueller Standort",
      );
    else
      toast(
        "Einstellungen übernommen. Neue Berechnung ist wieder online möglich.",
      );
  }
};
el("offline-enabled").onchange = async () => {
  const checkbox = el<HTMLInputElement>("offline-enabled");
  const enabled = checkbox.checked,
    previous = offlineEnabled;
  storageGeneration++;
  checkbox.disabled = true;
  offlineEnabled = enabled;
  try {
    await store.setEnabled(enabled);
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
settingsUI();
contextUI();
connectionChanged();
setupPWA();

function visualViewportChanged() {
  document.documentElement.style.setProperty(
    "--visual-height",
    `${window.visualViewport?.height ?? innerHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--visual-top",
    `${window.visualViewport?.offsetTop ?? 0}px`,
  );
}
window.visualViewport?.addEventListener("resize", visualViewportChanged);
window.visualViewport?.addEventListener("scroll", visualViewportChanged);
visualViewportChanged();
