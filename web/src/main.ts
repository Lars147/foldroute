import { RouteEditorController } from "./route-editor-controller";
import type { WorkspaceToast } from "./journey-workspace-presentation";
import type { AppPresentation } from "./app-presentation";
import { flushSync } from "svelte";
import { mountInformationDialogs } from "./information-dialogs";
import { reveal, stopMotionWithin, captureList, reflowList } from "./motion";
import { appearance, type AppearancePreference } from "./appearance";
import { mapStyle } from "./map-style";
import { readShareURL } from "./shared-destination";
import { SettingsController } from "./settings-controller";
import { ShareImportController } from "./share-import-controller";
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
import "./style.css";
import {
  migrateSettings,
  errorText,
  type RoutingSettings,
  type RouteRequest,
  type RouteStop,
  type Place,
  type Timing,
} from "./model";
import { ApiClient } from "./transitous";
import { clearSearchLocation, prepareSearchLocation } from "./search";
import { PlanningSession, type PlanningState } from "./planning-state";
import { planningRequestPreview } from "./planning-progress";
import { RouteMap } from "./map-view";
import {
  JourneyView,
  normalizeJourneyNavigation,
  type JourneyNavigation,
} from "./journey-view";
import {
  OfflineStore,
  sameHistoryRoute,
  type SavedJourney,
  type HistoryEntry,
} from "./offline";
import { el, node, icon, clock, dateLabel, setLocationFeedback } from "./ui";
import { setupPWA } from "./pwa";
import { afterStartup } from "./startup";
import { PlaceBook } from "./places";
import { PlanningFeedback, type PlanningToastStage } from "./planning-feedback";
import { localDatabase } from "./storage";
import {
  StoragePreferencesStore,
  type StoragePreferences,
} from "./storage-preferences";
import {
  readRouteURL,
  routeURL,
  type RouteLink,
  type ParsedRouteLink,
} from "./route-url";

export function startApplication(presentation: AppPresentation): Promise<void> {
  const clearPointerFocus = () => {
    delete document.documentElement.dataset.focusInput;
  };
  const routeSearchInput = (target: EventTarget | null) =>
    target instanceof HTMLInputElement &&
    target.type === "search" &&
    target.closest(".route-editor-places")
      ? target
      : undefined;
  window.addEventListener(
    "pointerdown",
    (event) => {
      document.documentElement.dataset.focusInput = "pointer";
      routeSearchInput(event.target)?.removeAttribute("data-keyboard-focus");
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
        clearPointerFocus();
    },
    true,
  );
  window.addEventListener(
    "click",
    (event) => {
      // Keyboard and assistive-technology clicks may have no preceding key event.
      if (event.isTrusted && event.detail === 0) clearPointerFocus();
    },
    true,
  );
  // Remember how a field was entered so typing after a click does not add a ring.
  window.addEventListener("focusin", (event) => {
    routeSearchInput(event.target)?.toggleAttribute(
      "data-keyboard-focus",
      document.documentElement.dataset.focusInput !== "pointer",
    );
  });
  window.addEventListener("focusout", (event) => {
    routeSearchInput(event.target)?.removeAttribute("data-keyboard-focus");
  });

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
  let view: View = "search";
  let pwa: ReturnType<typeof setupPWA> | undefined;
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
  let originOverride: Place | undefined,
    timing: Timing = "now",
    time = Date.now() / 1000;
  let stops: RouteStop[] = [];
  let storageGeneration = 0;
  let saved: SavedJourney | undefined,
    historyEnabled = true,
    navigationStorageEnabled = true,
    statisticsEnabled = true,
    persistKey = "",
    activeSnapshot: SavedJourney | undefined;
  let beforeSettings: View = "search",
    mapLocationRequest: AbortController | undefined;
  const api = new ApiClient(),
    store = new OfflineStore(),
    storagePreferencesStore = new StoragePreferencesStore(),
    book = new PlaceBook(),
    dialog = el<HTMLDialogElement>("time-dialog");
  const screenAwakeKey = "foldroute.screenAwake";
  let keepScreenAwake = true;
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
      clearToastCountdown();
      toastModel = { ...toastModel, visible: false };
      presentToast();
      toastStorageSource = undefined;
      planningFeedback.resume();
    }
  }

  try {
    keepScreenAwake = localStorage.getItem(screenAwakeKey) !== "false";
  } catch {
    storageMessage("settings", "Einstellungen gelten nur für diese Sitzung.");
  }
  const settingsController = new SettingsController(
    el("settings-view"),
    {
      changed: routingSettingsChanged,
      replanContext: () => ({
        pending: settingsReplanPending,
        hasRequest: !!session.state.request,
      }),
      close: () => {
        show(
          beforeSettings === "history"
            ? "history"
            : session.state.request
              ? "map"
              : beforeSettings,
        );
      },
      storageError: (message, initial) =>
        initial
          ? storageMessage("settings", message)
          : toast(message, "settings"),
      stored: () => clearStorageMessage("settings"),
    },
    presentation.settings,
  );

  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
    if (!element.querySelector("svg"))
      element.append(icon(element.dataset.icon!));
  });
  let toastTimer: ReturnType<typeof setTimeout>;
  let toastStorageSource: StorageMessageSource | undefined;
  let toastModel: WorkspaceToast = { visible: false, message: "" };
  function presentToast() {
    presentation.workspace.updateToast(toastModel);
  }
  function clearToastCountdown() {
    clearTimeout(toastTimer);
    toastModel = { ...toastModel, countdown: undefined };
    presentToast();
  }
  function clearPlanningToast() {
    if (!toastModel.planningId) return;
    clearToastCountdown();
    planningFeedback.releaseRecovery();
    toastModel = { visible: false, message: toastModel.message };
    presentToast();
    planningFeedback.restoreToast();
    presentation.workspace.setAttribute("status", "aria-live", "polite");
  }
  function toast(
    message: string,
    source?: StorageMessageSource,
    planningId?: string,
    stage?: PlanningToastStage,
  ) {
    if (planningId && toastModel.visible && !toastModel.planningId)
      return false;
    if (
      planningId &&
      toastModel.visible &&
      toastModel.planningId === planningId &&
      toastModel.stage === stage &&
      toastModel.message === message
    )
      return true;
    clearToastCountdown();
    planningFeedback.releaseRecovery();
    toastStorageSource = source;
    if (!planningId) planningFeedback.interrupt();
    toastModel = { visible: true, message, planningId, stage };
    presentToast();
    presentation.workspace.setAttribute(
      "status",
      "aria-live",
      stage ? "off" : "polite",
    );
    if (planningFeedback.position()) {
      reveal(el("toast"), { y: 8 });
      if (!stage || stage === "ready") {
        const duration = stage === "ready" ? 3000 : 6000;
        toastModel = {
          ...toastModel,
          countdown: { duration, deadline: performance.now() + duration },
        };
        presentToast();
        toastTimer = setTimeout(() => {
          clearToastCountdown();
          if (!toastModel.planningId) {
            toastModel = { ...toastModel, visible: false };
            presentToast();
          }
          planningFeedback.resume();
        }, duration);
      }
      return true;
    }
    return false;
  }
  const planningFeedback = new PlanningFeedback(
    (id, message, stage) => toast(message, undefined, id, stage),
    clearPlanningToast,
    () =>
      view === "map" &&
      !document.hidden &&
      !navigationChecking &&
      !navigationView?.visible &&
      !document.querySelector("dialog[open]:not(#alternatives-dialog)"),
    presentation.workspace,
  );
  const routeMap = new RouteMap(
    (id) => session.select(id),
    () => {},
    presentation.workspace,
  );
  let navigation: NavigationSession | undefined;
  let navigationView: NavigationView | undefined;
  let hasNavigationStatistics = false;
  let hasSavedNavigation = false;
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
  const liveLocation = new LiveLocation((fix, quality, error) => {
    routeMap.updateLocation(fix, quality);
    navigation?.updateLocation(fix, quality, error);
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
      pagePresent && !document.hidden && navigator.onLine && historyEnabled,
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
    presentation.workspace.setDisabled("map-location", false);
  }
  routeMap.onManualMove = cancelMapCenter;
  function suspendPage() {
    pagePresent = false;
    if (navigationChecking) cancelNavigationCheck(true);
    navigationView?.pause();
    cancelMapCenter();
    syncLiveLocation();
  }
  function resumePage() {
    if (document.hidden) return;
    pagePresent = true;
    syncLiveLocation();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspendPage();
    else resumePage();
  });
  window.addEventListener("pagehide", suspendPage);
  window.addEventListener("pageshow", resumePage);
  window.addEventListener("focus", () => {
    if (!pagePresent) resumePage();
  });
  const journeyView = new JourneyView(
    (id) => {
      cancelNavigationCheck();
      session.select(id);
    },
    "live",
    presentation.workspace,
  );
  const session = new PlanningSession(
    api,
    renderPlanning,
    (request, options) => {
      openedHistoryId = undefined;
      activePlan = structuredClone({ request, settings: options });
      activePlanId ??= crypto.randomUUID();
      writeHistory();
    },
  );
  journeyView.onDetailsOpened = () => session.holdSelection();
  let sheetHistoryClosing = false;
  journeyView.onSheetChange = (action) => {
    navigationRevision++;
    if (action === "open") {
      cancelNavigationCheck();
      // Focus and scroll events can fire while the dialog is mounting. Keep the
      // underlying entry on the map even if a position update already saved it.
      const base = journeyView.snapshot();
      delete base.sheet;
      history.replaceState({ ...history.state, journeyNavigation: base }, "");
      writeHistory(true, history.state?.resultDepth ?? 0);
    } else if (action === "close" && history.state?.journeyNavigation?.sheet) {
      sheetHistoryClosing = true;
      history.back();
    } else writeHistory();
  };
  journeyView.onLayoutChange = () => {
    if (!journeyView.mapVisible) cancelMapCenter();
    syncLiveLocation();
    if (view === "map" && journeyView.mapVisible) showRouteMap(session.state);
    renderNavigationCheck();
  };
  journeyView.onPositionChange = () => {
    if (
      !sheetHistoryClosing &&
      view === "map" &&
      history.state?.planId === activePlanId
    )
      history.replaceState(
        { ...history.state, journeyNavigation: journeyView.snapshot() },
        "",
      );
  };
  journeyView.onBack = () => {
    cancelNavigationCheck();
    navigationRevision++;
    const origin = journeyView.savedOrigin;
    if (origin) {
      writeHistory();
      show(origin);
      if (origin === "history") {
        const row = [
          ...el("history-list").querySelectorAll<HTMLElement>(".history-row"),
        ].find((item) => item.dataset.historyId === openedHistoryId);
        (
          row?.querySelector<HTMLElement>(".history-open") ??
          el("history-heading")
        ).focus({ preventScroll: true });
      }
    } else if (historyPosition > 0) history.back();
    else show("search");
  };
  navigation = new NavigationSession({
    api,
    store: navigationStore,
    locate: (options) => liveLocation.center(true, options),
    resumeEnabled: () => navigationStorageEnabled,
    statisticsEnabled: () => statisticsEnabled,
    routingSettings: () => settingsController.value,
    changed: () => {
      if (navigation?.engine) {
        if (navigation.engine.phase === "arrived") hasSavedNavigation = false;
        else if (navigationStorageEnabled) hasSavedNavigation = true;
      }
      if (navigation?.statistics)
        hasNavigationStatistics = navigation.statistics.completedIds.length > 0;
      pwa?.refresh();
      navigationView?.render();
      if (!navigationView?.visible) renderNavigationCheck();
      if (navigationView?.visible) {
        if (navigation?.engine?.phase === "arrived") syncLiveLocation();
      }
    },
  });
  navigationView = new NavigationView(
    () => void endNavigation(),
    (replan) => void launchNavigation(replan),
    {
      locationAutoRefresh: () => liveLocation.automaticRefreshActive,
      presentation,
    },
  );
  navigationView.root.addEventListener("click", (event) => {
    if (
      !navigationView?.visible ||
      !(event.target instanceof Element) ||
      !event.target.closest(".navigation-credit a") ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    suspendPage();
  });
  el("navigation-locate").onclick = async () => {
    resumePage();
    if (!navigation!.engine) {
      await launchNavigation();
      return;
    }
    await navigation!.retryLocation();
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
    pwa?.refresh();
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
    presentation.workspace.setHidden(
      "route-start-summary",
      !selected || unavailable,
    );
    presentation.workspace.setHidden(
      "replan-saved",
      !state.restored || !selected || navigationChecking || blocked || !!error,
    );
    const text = navigationChecking
      ? navigation.message || "Verbindung wird geprüft …"
      : error ||
        (assessment?.status === "unknown" && !prepared
          ? ""
          : (assessment?.message ?? ""));
    const notice = el("navigation-start-notice");
    presentation.workspace.updateStartNotice(
      text +
        ((blocked || distant) && !navigator.onLine
          ? " Neue Verbindungen benötigen Internet."
          : ""),
      !!error && navigation.needsLocation,
    );
    presentation.workspace.setHidden(
      "navigation-start-notice",
      !notice.textContent,
    );
    const search = el<HTMLButtonElement>("navigation-search-now");
    presentation.workspace.setHidden(
      "navigation-search-now",
      !selected || !(blocked || distant) || navigationChecking,
    );
    presentation.workspace.setDisabled(
      "navigation-search-now",
      !navigator.onLine || navigationChecking,
    );
    presentation.workspace.setText(
      "navigation-search-now",
      distant ? "Ab hier suchen" : "Ab jetzt suchen",
    );
    const button = el<HTMLButtonElement>("navigation-start");
    presentation.workspace.setHidden(
      "navigation-start",
      state.restored ? !selected || unavailable : !currentPlanning || !selected,
    );
    const retry = el<HTMLButtonElement>("navigation-start-retry");
    presentation.workspace.setHidden(
      "navigation-start-retry",
      !selected || !error || blocked || distant || navigationChecking,
    );
    presentation.workspace.setText(
      "navigation-start-retry",
      navigation.needsLocation
        ? "Standort erneut anfragen"
        : "Erneut versuchen",
    );
    const recovery = el("navigation-start-recovery");
    presentation.workspace.setHidden(
      "navigation-start-recovery",
      !!search.hidden && !!retry.hidden,
    );
    presentation.workspace.setDisabled(
      "navigation-start",
      !selected || !state.request || navigationChecking || unavailable,
    );
    presentation.workspace.setClass(
      "navigation-start",
      state.restored ? "secondary" : "primary",
    );
    presentation.workspace.setAttribute(
      "navigation-start",
      "aria-label",
      navigationChecking
        ? "Wird geprüft …"
        : state.restored
          ? "Mit gespeicherter Route starten"
          : "Navigation starten",
    );
    presentation.workspace.setAttribute(
      "navigation-start",
      "aria-busy",
      String(navigationChecking),
    );
    if (notice.hidden)
      presentation.workspace.setAttribute(
        "navigation-start",
        "aria-describedby",
        undefined,
      );
    else
      presentation.workspace.setAttribute(
        "navigation-start",
        "aria-describedby",
        notice.id,
      );
    presentation.workspace.updateStart(navigationChecking, state.restored);
    presentation.workspace.setHidden(
      "panel-actions",
      !!(
        (!currentPlanning || !selected) &&
        notice.hidden &&
        recovery.hidden &&
        el("replan-saved").hidden
      ),
    );
  }
  setInterval(() => {
    if (view === "map" && !document.hidden && !navigationView?.visible)
      renderNavigationCheck();
  }, 5000);
  async function launchNavigation(
    replan = false,
    restored?: NavigationSnapshot,
  ) {
    journeyView.dismissSheet();
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
    }
    const state = session.state;
    if (!restored && (!state.selected || !state.request)) return;
    navigationStart = restored
      ? { ...restored, restored }
      : {
          journey: structuredClone(state.selected!),
          request: structuredClone(state.request!),
          settings: structuredClone(
            state.resultSettings ?? settingsController.value,
          ),
        };
    const generation = ++navigationLaunchGeneration;
    navigationCheckKey = navigationContextKey();
    navigationCheckError = "";
    preparedNavigation = undefined;
    navigationChecking = true;
    settingsReplanPending = false;
    session.stop("");
    if (!restored) syncLiveLocation();
    renderNavigationCheck();
    try {
      const start = navigationStart;
      const preparing = navigation!.prepareStart(
        start.journey,
        start.request,
        start.settings,
        start.restored,
        replan,
      );
      if (restored) syncLiveLocation();
      const prepared = await preparing;
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
      presentation.workspace.setHidden("map-view", true);
      syncLiveLocation();
      await showing;
      if (generation !== navigationLaunchGeneration || !navigationView!.visible)
        return;
      if (!navigation!.activateStart(prepared)) {
        navigationView!.hide();
        delete document.body.dataset.navigation;
        presentation.workspace.setHidden("map-view", false);
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
        presentation.workspace.setHidden("map-view", false);
      }
    } finally {
      if (generation === navigationLaunchGeneration) {
        navigationChecking = false;
        syncLiveLocation();
        renderNavigationCheck();
      }
    }
  }
  presentation.workspace.setCommand(
    "navigation-start-retry",
    () => void launchNavigation(),
  );
  presentation.workspace.setCommand("navigation-search-now", async () => {
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
    activePlan = {
      request,
      settings: structuredClone(settingsController.value),
    };
    restorePlanContext(activePlan);
    journeyView.dismissSheet();
    writeHistory(true);
    await session.calculate(
      request,
      settingsController.value,
      request.origin.name === "Aktueller Standort",
    );
  });
  async function endNavigation() {
    navigationLaunchGeneration++;
    navigationStart = undefined;
    const arrived = navigation?.engine?.phase === "arrived";
    const journey = navigation?.engine?.journey;
    const request = navigation?.request;
    const options = navigation?.settings;
    const routeChanged = navigation?.routeChanged ?? false;
    navigationView!.hide();
    delete document.body.dataset.navigation;
    try {
      await navigation!.stop();
      hasSavedNavigation = false;
      savedUI();
    } catch {
      toast(
        "Navigation beendet. Gespeicherter Zustand konnte nicht gelöscht werden.",
      );
    }
    if (arrived) {
      closeRoute(false, el("search-heading"));
      return;
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
      settingsController.render();
    }
    presentation.workspace.setHidden("map-view", false);
    showRouteMap(session.state);
    const resultNavigation = journeyView.snapshot();
    delete resultNavigation.savedOrigin;
    journeyView.restoreNavigation({
      ...resultNavigation,
      screen: "map",
    });
    syncLiveLocation();
    writeHistory(false, 0);
    renderPlanning(session.state);
    cancelNavigationCheck();
    routeMap.resize();
    routeMap.fitRoute();
    const primary = el<HTMLButtonElement>(
      !el("navigation-search-now").hidden
        ? "navigation-search-now"
        : "navigation-start",
    );
    if (primary.disabled || primary.hidden) journeyView.focusSelection();
    else primary.focus({ preventScroll: true });
  }
  presentation.workspace.setCommand(
    "navigation-start",
    () => void launchNavigation(),
  );

  function updateLinkUI() {
    presentation.workspace.setHidden("share-plan", !activePlan);
    presentation.workspace.setDisabled(
      "share-plan",
      session.state.locating || sharingPlan,
    );
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
        routeEditor:
          view === "search" &&
          (routeEditor.editorExpanded || routeEditor.adjustMode === "replan")
            ? {
                mode: routeEditor.adjustMode,
                expanded: routeEditor.editorExpanded,
                returnPosition: routeEditor.editorReturnPosition,
              }
            : undefined,
      },
      "",
      routeURL(location.href, activePlan),
    );
    presentation.workspace.setHidden("plan-link-fallback", true);
    updateLinkUI();
  }
  function releasePlan() {
    openedHistoryId = undefined;
    activePlan = undefined;
    activePlanId = undefined;
    settingsController.render();
  }
  function beginPlanning(replaceEditor = false) {
    journeyView.dismissSheet();
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
    else if (replaceEditor) {
      show("map", false);
      writeHistory();
    } else show("map");
    journeyView.focusSelection();
  }
  async function restoreLink(
    parsed: ParsedRouteLink,
    next: View = "map",
    id?: string,
  ) {
    routeEditor.resetEditor();
    journeyView.reset();
    settingsReplanPending = false;
    session.clear();
    activeSnapshot = undefined;
    persistKey = "";
    releasePlan();
    if (parsed.kind !== "plan") {
      originOverride = undefined;
      routeEditor.destination.set();
      stops = [];
      timing = "now";
      time = Date.now() / 1000;
      routeEditor.contextUI();
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
      settings: structuredClone(settingsController.value),
    };
    activePlanId = id ?? crypto.randomUUID();
    const request = activePlan.request;
    originOverride = request.origin;
    routeEditor.destination.set(request.destination);
    stops = structuredClone(request.stops ?? []);
    timing = request.timing;
    time = request.time;
    settingsController.render();
    routeEditor.contextUI();
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
    if (navigator.onLine) {
      const calculation = session.calculate(
        request,
        settingsController.value,
        false,
      );
      await calculation;
    }
  }
  function show(next: View, push = true) {
    if (next !== "map") journeyView.dismissSheet();
    if (next !== view) cancelNavigationCheck();
    if (restoringSettingsPosition !== undefined) return false;
    if (
      view === "settings" &&
      next !== "settings" &&
      !settingsController.validate()
    )
      return false;
    el<HTMLDialogElement>("route-actions-dialog").close();
    routeEditor.plannerActions.close();
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
    if (next !== "search") {
      routeEditor.cancelEditorSearches();
      routeEditor.timePicker.close(false);
    }
    if (next !== "map") {
      mapLocationRequest?.abort();
      el("map-location-error").hidden = true;
      presentation.workspace.setDisabled("map-location", false);
    }
    stopMotionWithin(el(`${view}-view`));
    view = next;
    syncLiveLocation();
    document.body.dataset.view = next;
    el("search-view").hidden = next !== "search";
    presentation.workspace.setHidden("map-view", next !== "map");
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
      if (!routeEditor.editorExpanded && routeEditor.adjustMode !== "replan")
        routeEditor.destination.activate();
      else routeEditor.destination.cancel();
      routeEditor.updateSearchEmpty();
    }
    if (next === "map") {
      showRouteMap(session.state);
      requestAnimationFrame(() => routeMap.resize());
    }
    if (replan) void refreshRoute(false);
    if (!document.body.classList.contains("search-focus-mode"))
      if (next === "map")
        reveal(
          el(
            matchMedia("(min-width: 900px)").matches
              ? "panel-content"
              : "map-preview-summary",
          ),
        );
      else if (next === "settings") {
        reveal(el("settings-form"), { y: 8 });
        reveal(el("app-settings"), { y: 8 });
      } else if (next === "history") {
        reveal(el("history-list"));
        reveal(el("history-empty"));
      } else reveal(document.querySelector<HTMLElement>(".search-content")!);
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
      // Native history scroll restoration runs after popstate.
      requestAnimationFrame(() => settingsController.validate());
      return;
    }
    if (view === "settings" && !settingsController.validate()) {
      restoringSettingsPosition = historyPosition;
      history.go(historyPosition - position);
      return;
    }
    historyPosition = position;
    const revision = ++navigationRevision;
    // Normalize legacy detail pages after their plan has been restored, so their
    // sheet uses that plan's selected journey rather than the one being left.
    const navigation = event.state?.journeyNavigation as
      JourneyNavigation | undefined;
    if (
      (sheetHistoryClosing || journeyView.sheetOpen) &&
      event.state?.view === "map" &&
      event.state?.planId === activePlanId &&
      !normalizeJourneyNavigation(
        navigation,
        session.state.selected?.id,
        !!session.state.journeys.length,
      ).sheet
    ) {
      sheetHistoryClosing = false;
      journeyView.restoreNavigation(navigation, false);
      journeyView.focusSheetTrigger();
      writeHistory();
      return;
    }
    sheetHistoryClosing = false;
    if (navigationView?.visible) {
      history.pushState(
        { ...history.state, navigation: true, position: ++historyPosition },
        "",
        location.href,
      );
      if (!navigationView.dismissConfirmation()) navigationView.confirmEnd();
      return;
    }
    if (dialog.open) routeEditor.timePicker.close(false);
    const next: View =
      event.state?.view === "history"
        ? "history"
        : event.state?.view === "settings"
          ? "settings"
          : event.state?.view === "search"
            ? "search"
            : "map";
    const editing = next === "search" ? event.state?.routeEditor : undefined;
    if (editing) {
      if (event.state?.planId !== activePlanId) {
        await restoreLink(
          readRouteURL(new URL(location.href)),
          "map",
          event.state?.planId,
        );
        if (revision !== navigationRevision) return;
      }
      const wasEditing =
        routeEditor.adjustMode === editing.mode &&
        routeEditor.editorInitialized;
      routeEditor.adjustMode = editing.mode === "replan" ? "replan" : "context";
      routeEditor.editorReturnPosition = editing.returnPosition;
      if (!wasEditing)
        routeEditor.initializeEditor(
          routeEditor.adjustMode === "replan"
            ? structuredClone(
                session.state.pendingRequest ?? session.state.request,
              )
            : undefined,
        );
      routeEditor.setEditorExpanded(editing.expanded === true);
      show("search", false);
      writeHistory();
      el("search-adjust").focus({ preventScroll: true });
      return;
    }
    const returningFromEditor =
      view === "search" && routeEditor.adjustMode === "replan";
    if (returningFromEditor) {
      routeEditor.adjustMode = "context";
      routeEditor.editorInitialized = false;
      routeEditor.editorReturnPosition = undefined;
    }
    routeEditor.setEditorExpanded(false);
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
        if (returningFromEditor && next === "map")
          el("adjust-route").focus({ preventScroll: true });
      } else {
        show("history", false);
        toast("Diese gespeicherte Strecke ist nicht mehr vorhanden.");
      }
      return;
    }
    if (event.state?.planId === activePlanId) {
      show(
        next === "map" &&
          !session.state.request &&
          !session.state.pendingRequest
          ? "search"
          : next,
        false,
      );
      journeyView.restoreNavigation(navigation, next === "map");
      writeHistory();
      if (returningFromEditor && next === "map")
        el("adjust-route").focus({ preventScroll: true });
      else if (next === "search")
        el("search-adjust").focus({ preventScroll: true });
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
    const before =
      historyMutationPending && view === "history"
        ? captureList(el("history-list"), "historyId")
        : undefined;
    const focused = document.activeElement as HTMLElement | null;
    const focusedId =
      focused?.closest<HTMLElement>(".history-row")?.dataset.historyId;
    const focusedRemove = focused?.classList.contains("history-remove");
    stopMotionWithin(el("history-list"));
    el("history-empty").hidden = historyEntries.length > 0;
    el("history-empty").textContent = historyEnabled
      ? "Noch keine Strecken. Erfolgreiche Planungen werden hier automatisch gespeichert."
      : "Streckenverlauf ausgeschaltet. Aktiviere ihn in den Einstellungen, um neue Planungen zu behalten.";
    el<HTMLButtonElement>("delete-saved").disabled = !historyEntries.length;
    presentation.updateHistory({
      entries: historyEntries,
      online: navigator.onLine,
      open: (entry) => {
        void openStoredRoute(entry.snapshot, entry.id);
      },
      remove: (id) => {
        void deleteHistoryEntry(id);
      },
    });
    flushSync();
    if (focusedId) {
      const row = Array.from(
        el("history-list").querySelectorAll<HTMLElement>(".history-row"),
      ).find((element) => element.dataset.historyId === focusedId);
      row
        ?.querySelector<HTMLButtonElement>(
          focusedRemove ? ".history-remove" : ".history-open",
        )
        ?.focus({ preventScroll: true });
    }
    historySwipe.ready();
    if (before) reflowList(el("history-list"), before, "historyId");
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
                el("history-list").querySelectorAll<HTMLElement>(
                  ".history-row",
                ),
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
          el("history-list").querySelectorAll<HTMLButtonElement>(
            ".history-open",
          );
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
    el<HTMLButtonElement>("delete-saved").disabled = !saved;
    el("offline-empty").hidden = navigator.onLine || !!saved;
    el<HTMLInputElement>("offline-enabled").checked = historyEnabled;
    el<HTMLInputElement>("navigation-storage-enabled").checked =
      navigationStorageEnabled;
    el<HTMLInputElement>("statistics-enabled").checked = statisticsEnabled;
    el<HTMLButtonElement>("delete-navigation").disabled = !hasSavedNavigation;
    el<HTMLButtonElement>("delete-statistics").disabled =
      !hasNavigationStatistics;
  }
  async function persist(snapshot: SavedJourney, id: string) {
    const generation = storageGeneration;
    try {
      if (await store.save(snapshot, id)) {
        if (historyEnabled && generation === storageGeneration) {
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
    const preview = planningRequestPreview(state);
    routeMap.show(
      state.journeys,
      state.selected,
      navigator.onLine,
      preview
        ? JSON.stringify(["request", preview])
        : JSON.stringify([
            state.calculationId ?? state.queriedAt,
            state.request,
          ]),
      !state.busy,
      preview,
      preview ? state.routePreview : undefined,
    );
  }
  function renderPlanning(state: PlanningState) {
    planningFeedback.update(state);
    if (state.busy && !planningWasBusy) currentSaveSuppressed = false;
    planningWasBusy = state.busy;
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
    updateLinkUI();
    journeyView.render(
      state,
      state.resultSettings?.maxCyclingMinutes ??
        settingsController.value.maxCyclingMinutes,
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
        if (historyEnabled) void persist(activeSnapshot, state.calculationId);
      }
    }
    presentation.workspace.setHidden(
      "replan-saved",
      !state.restored || !state.selected,
    );
    presentation.workspace.setDisabled(
      "replan-saved",
      !navigator.onLine || state.busy,
    );
    pwa?.refresh();
    renderNavigationCheck();
    planningFeedback.position();
  }
  const routeEditor = new RouteEditorController({
    presentation: presentation.editor,
    api,
    book,
    notify: toast,
    context: () => ({ origin: originOverride, stops, timing, time }),
    planningState: () => session.state,
    view: () => view,
    historyPosition: () => historyPosition,
    show,
    writeHistory,
    cancelNavigationCheck,
    cancelMapCenter,
    changed: () => pwa?.refresh(),
    start,
    homeFocusTarget,
  });
  const shareImport = new ShareImportController(
    document,
    {
      api,
      book,
      notify: toast,
      beforeAccept: routeEditor.resetEditor,
      navigation: {
        active: () => !!navigationView?.visible,
        end: endNavigation,
        resume: (snapshot) => launchNavigation(false, snapshot),
        clearSaved: () => navigationStore.clear(),
      },
      prepareDestination: (place) => {
        routeEditor.destination.set(place);
        originOverride = undefined;
        stops = [];
        timing = "now";
        time = Date.now() / 1000;
        routeEditor.contextUI();
      },
      startDestination: async (place) => {
        routeEditor.updateSearchEmpty();
        await start(place);
      },
    },
    initialShare,
  );

  async function start(place: Place) {
    const context = routeEditor.editorInitialized
      ? routeEditor.validateEditor()
      : { origin: originOverride, stops, timing, time };
    if (!context) return;
    if (!navigator.onLine) {
      el(
        routeEditor.editorExpanded ? "adjust-status" : "place-status",
      ).textContent = "Für neue Routen brauchst du eine Internetverbindung.";
      return;
    }
    originOverride = context.origin;
    stops = context.stops;
    timing = context.timing;
    time = timing === "now" ? Date.now() / 1000 : context.time;
    settingsReplanPending = false;
    routeEditor.adjustMode = "context";
    routeEditor.editorReturnPosition = undefined;
    routeEditor.setEditorExpanded(false);
    routeEditor.contextUI();
    beginPlanning(!!history.state?.routeEditor);
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
      settingsController.value,
      !originOverride,
    );
    if (result === "location-error" && view === "map" && !dialog.open) {
      routeEditor.openAdjust("replan", place);
      setLocationFeedback(
        el("adjust-status"),
        session.state.message,
        true,
        "adjust-location-help",
      );
      routeEditor.draftOrigin.input.focus();
    }
  }

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
      settingsController.value,
      request.origin.name === "Aktueller Standort",
    );
    if (
      result === "location-error" &&
      interactive &&
      view === "map" &&
      !dialog.open
    ) {
      routeEditor.openAdjust("replan", request.destination);
      setLocationFeedback(
        el("adjust-status"),
        session.state.message,
        true,
        "adjust-location-help",
      );
    }
  }
  presentation.workspace.setCommand("refresh-route", () => void refreshRoute());
  function homeFocusTarget(): HTMLElement {
    return matchMedia("(max-width: 899px)").matches
      ? el("search-heading")
      : routeEditor.destination.input;
  }
  function closeRoute(push = true, focus: HTMLElement = homeFocusTarget()) {
    settingsReplanPending = false;
    session.clear();
    releasePlan();
    mapLocationRequest?.abort();
    routeEditor.destination.set();
    routeEditor.adjustMode = "context";
    routeEditor.editorInitialized = false;
    routeEditor.editorReturnPosition = undefined;
    routeEditor.setEditorExpanded(false);
    originOverride = undefined;
    stops = [];
    timing = "now";
    time = Date.now() / 1000;
    routeEditor.contextUI();
    el("search-empty").hidden = false;
    el("place-status").textContent = "";
    show("search", push);
    writeHistory(false, 0);
    focus.focus({ preventScroll: true });
  }
  presentation.workspace.setCommand("close-route", () => closeRoute());
  mountInformationDialogs();
  el("dismiss-location-error").onclick = () => {
    el("map-location-error").hidden = true;
  };
  presentation.workspace.setCommand("map-route", () => {
    if (!session.state.selected && !planningRequestPreview(session.state))
      return;
    mapLocationRequest?.abort();
    mapLocationRequest = undefined;
    presentation.workspace.setDisabled("map-location", false);
    el("map-location-error").hidden = true;
    liveLocation.cancelCenter();
    routeMap.fitRoute();
  });
  presentation.workspace.setCommand("map-location", async () => {
    el("map-location-error").hidden = true;
    mapLocationRequest?.abort();
    mapLocationRequest = new AbortController();
    const signal = mapLocationRequest.signal;
    const button = el<HTMLButtonElement>("map-location");
    presentation.workspace.setDisabled("map-location", true);
    pwa?.refresh();
    try {
      const fix = await liveLocation.center();
      if (!signal.aborted) routeMap.center(fixPlace(fix));
    } catch (error) {
      if (!signal.aborted) {
        el("map-location-error-text").textContent = errorText(error);
        el("map-location-error").hidden = false;
      }
    } finally {
      if (!signal.aborted)
        presentation.workspace.setDisabled("map-location", false);
      pwa?.refresh();
    }
  });

  function updateSettingsReplanPending(pending: boolean) {
    settingsReplanPending = pending;
    const previousResult = activePlanId
      ? planResults.get(activePlanId)
      : undefined;
    if (previousResult) previousResult.settingsReplanPending = pending;
  }
  function routingSettingsChanged(_next: RoutingSettings) {
    const firstChange = !settingsReplanPending;
    if (activePlan) {
      if (firstChange) {
        openedHistoryId = undefined;
        activePlanId = crypto.randomUUID();
      }
      activePlan = {
        ...activePlan,
        settings: structuredClone(settingsController.value),
      };
      writeHistory(firstChange);
    }
    if (session.state.request) {
      session.invalidateForSettings();
      updateSettingsReplanPending(true);
      activeSnapshot = undefined;
      persistKey = "";
    }
  }
  function openSettings() {
    if (view === "settings") return;
    beforeSettings = view;
    settingsController.render();
    show("settings");
  }
  el("tab-history").onclick = () => {
    if (show("history") === false) return;
    void reloadHistory().catch(() =>
      toast("Strecken konnten nicht geladen werden."),
    );
  };
  el("tab-settings").onclick = openSettings;
  presentation.workspace.setCommand("late-settings", openSettings);
  el("tab-route").onclick = () => {
    show(
      session.state.request || session.state.pendingRequest ? "map" : "search",
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
    routeEditor.resetEditor();
    mapLocationRequest?.abort();
    activeSnapshot = undefined;
    persistKey = "";
    book.reset();
    clearSearchLocation();
    try {
      await localDatabase.clearAll();
      clearStorageMessage("toggle", "disabled", "history", "save");
      hasNavigationStatistics = false;
      shareImport.clearPersisted();
      historySwipe.resetHint();
      settingsController.clearPersisted();
      localStorage.removeItem(screenAwakeKey);
      localStorage.removeItem(audioPreferenceKey);
      appearance.reset();
      mapStyle.reset();
      keepScreenAwake = true;
      el<HTMLInputElement>("keep-screen-awake").checked = true;
      saved = undefined;
      historyEntries = [];
      historyEnabled = true;
      navigationStorageEnabled = true;
      statisticsEnabled = true;
      hasSavedNavigation = false;
      settingsController.resetAfterDataClear();
      releasePlan();
      planResults.clear();
      originOverride = undefined;
      stops = [];
      timing = "now";
      time = Date.now() / 1000;
      routeEditor.destination.set();
      routeEditor.draftOrigin.set();
      savedUI();
      settingsController.render();
      routeEditor.contextUI();
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
  function appearanceUI() {
    for (const input of document.querySelectorAll<HTMLInputElement>(
      'input[name="appearance"]',
    ))
      input.checked = input.value === appearance.preference;
    const segments = document.querySelector<HTMLElement>(
      ".appearance-segments",
    )!;
    if (segments.dataset.appearance !== appearance.preference)
      segments.dataset.appearance = appearance.preference;
  }
  appearance.onChange = appearanceUI;
  appearance.onStorageError = () =>
    toast("Darstellung gilt nur für diese Sitzung.");
  appearanceUI();
  if (appearance.storageFailed)
    storageMessage("settings", "Einstellungen gelten nur für diese Sitzung.");
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="appearance"]',
  ))
    input.onchange = () => {
      if (input.checked) appearance.set(input.value as AppearancePreference);
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
  const storageControls: Record<keyof StoragePreferences, string> = {
    history: "offline-enabled",
    navigation: "navigation-storage-enabled",
    statistics: "statistics-enabled",
  };
  const storageLabels: Record<keyof StoragePreferences, string> = {
    history: "Streckenverlauf",
    navigation: "Wiederaufnahme",
    statistics: "Fahrtstatistik",
  };
  for (const key of Object.keys(
    storageControls,
  ) as (keyof StoragePreferences)[]) {
    const checkbox = el<HTMLInputElement>(storageControls[key]);
    checkbox.onchange = async () => {
      const previous = {
        history: historyEnabled,
        navigation: navigationStorageEnabled,
        statistics: statisticsEnabled,
      };
      const enabled = checkbox.checked;
      const generation = localDatabase.generation;
      checkbox.disabled = true;
      if (key === "history") {
        storageGeneration++;
        historyEnabled = enabled;
        historyUndo.clear();
        if (!enabled) historyNames.clear();
        syncHistoryNames();
      } else if (key === "navigation") navigationStorageEnabled = enabled;
      else statisticsEnabled = enabled;
      try {
        if (key === "history") await store.setEnabled(enabled);
        else await storagePreferencesStore.set(key, enabled);
        if (generation !== localDatabase.generation) return;
        clearStorageMessage("toggle", "disabled");
        storageMessage(
          "toggle",
          `${storageLabels[key]}: Speicherung ${enabled ? "eingeschaltet" : "ausgeschaltet"}. Vorhandene Daten bleiben erhalten.`,
        );
        if (key === "history") {
          persistKey = "";
          await reloadHistory();
        }
        savedUI();
      } catch {
        if (generation !== localDatabase.generation) return;
        if (key === "history") historyEnabled = previous.history;
        else if (key === "navigation")
          navigationStorageEnabled = previous.navigation;
        else statisticsEnabled = previous.statistics;
        syncHistoryNames();
        savedUI();
        storageMessage(
          "toggle",
          "Speichereinstellung konnte nicht geändert werden. Bitte erneut versuchen.",
        );
        toast(
          "Speicher nicht verfügbar. Änderung konnte nicht dauerhaft übernommen werden.",
          "toggle",
        );
      } finally {
        checkbox.disabled = false;
      }
    };
  }
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
  let deleteStorageKind: "navigation" | "statistics" = "navigation";
  for (const kind of ["navigation", "statistics"] as const) {
    el(`delete-${kind}`).onclick = () => {
      deleteStorageKind = kind;
      el("delete-storage-heading").textContent =
        kind === "navigation"
          ? "Gespeicherten Navigationsstand löschen?"
          : "Fahrtstatistik löschen?";
      el("delete-storage-description").textContent =
        kind === "navigation"
          ? "Der gespeicherte Stand zum Fortsetzen einer Fahrt wird entfernt. Streckenverlauf, Fahrtstatistik und Einstellungen bleiben erhalten."
          : "Gesamtstrecke und Fahrzeit abgeschlossener Fahrten werden zurückgesetzt. Streckenverlauf, Navigationsstand und Einstellungen bleiben erhalten.";
      el("confirm-delete-storage").textContent =
        kind === "navigation"
          ? "Navigationsstand löschen"
          : "Fahrtstatistik löschen";
      el("delete-storage-status").textContent = "";
      el<HTMLDialogElement>("delete-storage-dialog").showModal();
    };
  }
  el("cancel-delete-storage").onclick = () =>
    el<HTMLDialogElement>("delete-storage-dialog").close();
  el("confirm-delete-storage").onclick = async () => {
    const button = el<HTMLButtonElement>("confirm-delete-storage");
    button.disabled = true;
    try {
      if (deleteStorageKind === "navigation") {
        await navigationStore.clear();
        hasSavedNavigation = false;
        shareImport.clearResume();
      } else {
        await navigationStore.clearStatistics();
        hasNavigationStatistics = false;
        if (navigation) navigation.statistics = undefined;
      }
      savedUI();
      el<HTMLDialogElement>("delete-storage-dialog").close();
      storageMessage(
        "history",
        deleteStorageKind === "navigation"
          ? "Gespeicherter Navigationsstand gelöscht."
          : "Fahrtstatistik gelöscht.",
      );
    } catch {
      el("delete-storage-status").textContent =
        "Löschen fehlgeschlagen. Bitte erneut versuchen.";
    } finally {
      button.disabled = false;
    }
  };
  function restorePlanContext(plan: RouteLink, freezeLocation = true) {
    routeEditor.resetEditor();
    // Restored endpoints stay fixed even if their original label came from GPS.
    for (const place of freezeLocation
      ? [plan.request.origin, plan.request.destination]
      : []) {
      if (place.name === "Aktueller Standort")
        place.name = place === plan.request.origin ? "Startpunkt" : "Zielpunkt";
    }
    routeEditor.destination.set(plan.request.destination);
    originOverride = plan.request.origin;
    stops = structuredClone(plan.request.stops ?? []);
    timing = plan.request.timing;
    time = plan.request.time;
    routeEditor.contextUI();
  }
  function openSnapshot(
    snapshot: SavedJourney,
    id?: string,
    push = true,
    focus = true,
    planId?: string,
  ) {
    const origin = view === "history" ? "history" : "search";
    journeyView.reset(origin);
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
    settingsController.render();
    if (view === "map") {
      if (push) writeHistory(true);
    } else show("map", push);
    if (push) journeyView.openDetails();
    if (focus) journeyView.focusSelection();
  }
  function openSaved(focus = true) {
    if (saved) openSnapshot(saved, historyEntries[0]?.id, true, focus);
  }
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
    const plan = {
      request,
      settings: structuredClone(settingsController.value),
    };
    restorePlanContext(plan);
    openedHistoryId = undefined;
    beginPlanning();
    activePlan = plan;
    session.prepare(request);
    writeHistory();
    await session.calculate(request, settingsController.value, false);
  }
  presentation.workspace.setCommand("replan-saved", () => {
    if (activePlan && navigator.onLine)
      void replanStoredRequest(activePlan.request);
  });
  presentation.workspace.setCommand("recover-planning", async () => {
    const recovery = session.state.recovery;
    if (!recovery || session.state.busy) return;
    if (recovery.action === "adjust") {
      routeEditor.openAdjust("replan", recovery.request.destination);
      el("adjust-status").textContent = session.state.message;
      return;
    }
    if (!navigator.onLine || (recovery.retryAt ?? 0) > Date.now() / 1000)
      return;
    if (recovery.mode === "optimization") {
      await session.resumeOptimization();
      return;
    }
    const request = structuredClone(recovery.request);
    const result = await session.calculate(
      request,
      settingsController.value,
      request.origin.name === "Aktueller Standort",
    );
    if (result === "location-error" && view === "map" && !dialog.open) {
      routeEditor.openAdjust("replan", request.destination);
      setLocationFeedback(
        el("adjust-status"),
        session.state.message,
        true,
        "adjust-location-help",
      );
    }
  });
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
    if (navigator.onLine) void navigation?.refresh("online");
    savedUI();
    presentation.workspace.setDisabled(
      "replan-saved",
      !navigator.onLine || session.state.busy,
    );
    if (view === "map") {
      journeyView.render(
        session.state,
        session.state.resultSettings?.maxCyclingMinutes ??
          settingsController.value.maxCyclingMinutes,
      );
      showRouteMap(session.state);
    }
    if (!navigator.onLine && session.state.busy) {
      const request = planningRequestPreview(session.state);
      session.stop(
        request
          ? "Offline. Die Verbindungssuche wurde unterbrochen."
          : "Offline. Bereits gefundene Verbindungen bleiben verfügbar.",
        request
          ? { action: "retry", request: structuredClone(request) }
          : undefined,
      );
    }
  }
  window.addEventListener("online", connectionChanged);
  window.addEventListener("offline", connectionChanged);
  const restoredStartup = store
    .read()
    .then(async (result) => {
      if (storageGeneration === 0) {
        historyEnabled = result.preferences.history;
        navigationStorageEnabled = result.preferences.navigation;
        statisticsEnabled = result.preferences.statistics;
      }
      const generation = storageGeneration;
      try {
        const { statistics } = await navigationStore.readStatistics();
        if (generation === storageGeneration)
          hasNavigationStatistics = statistics.completedIds.length > 0;
      } catch {
        // Route restoration remains available when statistics cannot be read.
      }
      if (!activeSnapshot && storageGeneration === 0) {
        saved = result.snapshot;
        historyEntries = result.entries;
      }
      const snapshot = await navigationStore.read(true);
      hasSavedNavigation = !!snapshot;
      savedUI();
      if (storageGeneration === 0 && navigationStorageEnabled) {
        if (snapshot && initialShare && navigationLaunchGeneration === 0) {
          shareImport.setResume(snapshot);
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
          const resumeDialog = el<HTMLDialogElement>(
            "navigation-resume-dialog",
          );
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
              .then(() => {
                hasSavedNavigation = false;
                savedUI();
              })
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
          afterStartup(() => {
            if (
              storageGeneration === 0 &&
              navigationLaunchGeneration === 0 &&
              !navigationView?.visible
            )
              resumeDialog.showModal();
          });
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
  const placesStartup = book
    .load()
    .catch(() =>
      toast(
        "Favoriten und letzte Orte konnten nicht geladen werden. Online-Planung bleibt möglich.",
      ),
    );
  const startupReady = Promise.all([restoredStartup, placesStartup]).then(
    () => {
      afterStartup(() => {
        if (view === "search" && !originOverride) void prepareSearchLocation();
        if (
          matchMedia(
            "(min-width: 900px) and (hover: hover) and (pointer: fine)",
          ).matches &&
          view === "search" &&
          !routeEditor.editorExpanded &&
          !navigationView?.visible &&
          !shareImport.hasPending &&
          !document.querySelector("dialog[open]") &&
          document.activeElement === document.body
        )
          routeEditor.destination.input.focus({ preventScroll: true });
      });
    },
  );
  routeEditor.destination.activate();
  settingsController.render();
  routeEditor.contextUI();
  connectionChanged();
  pwa = setupPWA({
    context: () => {
      const editingSearch =
        routeEditor.editorExpanded ||
        routeEditor.adjustMode === "replan" ||
        ((view === "search" ||
          (view === "settings" && beforeSettings === "search")) &&
          routeEditor.destination.input.value.trim().length > 0);
      const blockedReason =
        navigationView?.visible || navigationChecking
          ? "Nach Ende der Navigation kannst du die App aktualisieren."
          : session.state.busy
            ? "Warte zuerst, bis die Routensuche beendet ist."
            : session.state.locating ||
                routeEditor.draftLocationRequest ||
                (mapLocationRequest &&
                  !mapLocationRequest.signal.aborted &&
                  el<HTMLButtonElement>("map-location").disabled)
              ? "Warte zuerst, bis die Standortabfrage beendet ist."
              : sharingPlan
                ? "Beende zuerst die aktuelle Eingabe."
                : undefined;
      const draftReason = editingSearch
        ? "Beende zuerst die aktuelle Eingabe."
        : el("settings-form").querySelector("input:invalid")
          ? "Korrigiere zuerst die ungültigen Einstellungen."
          : undefined;
      return { home: view === "search", blockedReason, draftReason };
    },
    notify: (message) => {
      if (!navigationView?.visible) toast(message);
    },
  });

  // Read links after every form and dialog handler is ready. Offline storage must
  // never replace an explicitly linked planning request with an unrelated trip.
  function initializeLink() {
    if (navigationLaunchGeneration > 0) return;
    if (shareImport.initializeInitialShare()) {
      // The share controller owns presentation and its initial-once guard.
    } else if (initialLink.kind !== "none") {
      const navigation = history.state?.journeyNavigation as
        JourneyNavigation | undefined;
      const planId = history.state?.planId;
      const revision = navigationRevision;
      void restoreLink(initialLink, "map", planId).then(() => {
        if (navigation && revision === navigationRevision && view === "map") {
          journeyView.restoreNavigation(navigation, true);
          writeHistory();
        }
      });
    } else writeHistory();
  }
  presentation.workspace.setCommand("share-plan", async () => {
    if (!activePlan || session.state.locating || sharingPlan) return;
    const link = routeURL(location.href, activePlan).href;
    sharingPlan = true;
    presentation.workspace.setHidden("plan-link-fallback", true);
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
      presentation.workspace.setHidden("plan-link-fallback", false);
      el("panel-content").scrollTop = 0;
      input.focus();
      input.select();
    } finally {
      sharingPlan = false;
      updateLinkUI();
    }
  });

  return startupReady;
}
