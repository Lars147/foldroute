import {
  renderJourneyDetails,
  type JourneyPresentation,
} from "./journey-detail";
import { closeMapStylePickers } from "./map-style-picker";
import { reveal, stopMotionWithin, motionTime } from "./motion";
import {
  type Journey,
  bikeDistance,
  lateDepartureDelay,
  compare,
  cyclingExcess,
  cyclingComparisonLabel,
  journeyEffort,
  journeyOutline,
  rateLimitMessage,
} from "./model";
import { type PlanningState } from "./planning-state";
import { planningProgress } from "./planning-progress";
import { renderRequestStops } from "./route-request";
import { SearchPreview } from "./search-preview";
import { RetryCountdown } from "./retry-countdown";
import {
  el,
  node,
  clock,
  duration,
  dateLabel,
  icon,
  routeSymbolColor,
} from "./ui";
export type JourneyScreen = "list" | "detail" | "map";

function movePreservingFocus(
  element: HTMLElement,
  parent: Node,
  before: Node | null = null,
) {
  if (
    before === element ||
    (element.parentNode === parent &&
      (!before || element.nextSibling === before))
  )
    return;
  const focused = element.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : undefined;
  parent.insertBefore(element, before);
  focused?.focus({ preventScroll: true });
}

export interface JourneyNavigation {
  screen: JourneyScreen;
  mapReturn: "list" | "detail";
  savedOrigin?: "search" | "history";
  positions: Record<string, number>;
}
export class JourneyView {
  onDetailsOpened?: () => void;
  onNavigate?: (screen: JourneyScreen, replace: boolean) => void;
  onBack?: () => void;
  onLayoutChange?: () => void;
  onPositionChange?: () => void;
  private key = "";
  private displayedID?: string;
  private restored = false;
  private hadChoices = false;
  private requestPreview = false;
  private requestMapReady = false;
  private readonly searchPreview = new SearchPreview();
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private statusCountdown = new RetryCountdown();
  private mapCountdown = new RetryCountdown();
  private navigation: JourneyNavigation = {
    screen: "list",
    mapReturn: "list",
    positions: {},
  };
  private readonly desktop = matchMedia("(min-width: 900px)");
  private readonly detailPanel = el("panel-details");
  private readonly feedbackHomes = new Map<HTMLElement, Comment>();
  constructor(
    private select: (id: string) => void,
    private readonly presentation: JourneyPresentation = "live",
  ) {
    for (const id of [
      "issues",
      "late-departure",
      "cycling-comparison",
      "map-error",
      "navigation-start-notice",
      "navigation-start-recovery",
    ]) {
      const element = el(id);
      const home = document.createComment(`${id} home`);
      element.before(home);
      this.feedbackHomes.set(element, home);
    }
    el("panel-map-toggle").onclick = () => this.requestScreen("map");
    el("result-back").onclick = () => {
      if (this.onBack) this.onBack();
      else this.showScreen("list");
    };
    el("map-open-details").onclick = () => {
      this.onDetailsOpened?.();
      this.requestScreen("detail", true);
    };
    el("choices").onkeydown = (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.matches(".route-choice")
      )
        return;
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [
        ...el("choices").querySelectorAll<HTMLButtonElement>(".route-choice"),
      ];
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      buttons[
        (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
          buttons.length
      ]?.focus();
    };
    const actionsDialog = el<HTMLDialogElement>("route-actions-dialog");
    const closeActions = () => {
      if (!actionsDialog.open) return;
      actionsDialog.close();
      el("route-more").focus({ preventScroll: true });
    };
    el("route-more").onclick = () => actionsDialog.showModal();
    el("route-actions-close").onclick = closeActions;
    actionsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeActions();
    });
    for (const id of [
      "share-plan",
      "refresh-route",
      "replan-saved",
      "navigation-start",
    ]) {
      el(id).addEventListener("click", closeActions, { capture: true });
    }
    this.desktop.addEventListener("change", () => {
      const active = document.activeElement as HTMLElement;
      this.selectPreviewScreen();
      this.applyLayout();
      this.restorePosition();
      if (
        !actionsDialog.open &&
        !document.querySelector(".map-style-panel:popover-open") &&
        !(
          active !== document.body &&
          active.getClientRects().length &&
          !active.closest("[hidden], [inert]")
        )
      )
        this.focusSelection();
    });
    let pending = false;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const panel = el("journey-panel");
        const wasScrolling = panel.classList.contains("result-scroll-all");
        const scrollTop = panel.scrollTop;
        // Always measure the same layout: switching scroll containers changes
        // available width and can otherwise alternate the result every frame.
        if (wasScrolling) panel.classList.remove("result-scroll-all");
        const fixed =
          el("result-header").offsetHeight +
          (el("result-nav").parentElement === panel
            ? el("result-nav").offsetHeight
            : 0) +
          panel.querySelector<HTMLElement>(".panel-actions")!.offsetHeight +
          48;
        const row =
          this.screen === "list"
            ? Math.max(
                100,
                ...[...el("choices").children].map(
                  (e) => e.getBoundingClientRect().height,
                ),
              )
            : 180;
        // Wrapping changes between scroll modes. Leave spare room before
        // returning to the fixed header and footer to avoid resize oscillation.
        const spare = wasScrolling
          ? 2 * parseFloat(getComputedStyle(panel).fontSize)
          : 0;
        panel.classList.toggle(
          "result-scroll-all",
          (this.desktop.matches || this.screen !== "map") &&
            el("map-view").clientHeight < fixed + row + spare,
        );
        if (wasScrolling && panel.classList.contains("result-scroll-all"))
          panel.scrollTop = scrollTop;
      });
    });
    for (const element of [
      el("map-view"),
      el("result-header"),
      el("result-nav"),
      el("choices"),
      el("journey-panel").querySelector<HTMLElement>(".panel-actions")!,
    ])
      observer.observe(element);
    for (const element of [el("panel-content"), el("journey-panel")]) {
      element.addEventListener(
        "scroll",
        () => {
          this.savePosition();
          this.onPositionChange?.();
        },
        { passive: true },
      );
    }
    this.applyLayout();
  }
  get screen() {
    return this.navigation.screen;
  }
  private get example() {
    return this.presentation === "example";
  }
  get mapVisible() {
    return (
      (this.desktop.matches || this.screen === "map") &&
      (!this.requestPreview || this.requestMapReady)
    );
  }
  get savedOrigin() {
    return this.navigation.savedOrigin;
  }
  get backScreen() {
    return this.screen === "map" ? this.navigation.mapReturn : "list";
  }
  snapshot(): JourneyNavigation {
    this.savePosition();
    return structuredClone(this.navigation);
  }
  restoreNavigation(value?: JourneyNavigation, focus = false) {
    const previous = this.screen;
    stopMotionWithin(el("journey-panel"));
    const fromDetail = this.screen === "detail";
    this.navigation =
      value && ["list", "detail", "map"].includes(value.screen)
        ? structuredClone(value)
        : { screen: "list", mapReturn: "list", positions: {} };
    this.applyLayout();
    this.restorePosition();
    if (focus) this.focusSelection(fromDetail);
    if (focus) this.animateScreen(previous);
  }
  reset(screen: JourneyScreen = "list", savedOrigin?: "search" | "history") {
    this.restoreNavigation({
      screen,
      mapReturn: "list",
      savedOrigin,
      positions: {},
    });
  }
  showScreen(screen: JourneyScreen, focus = true) {
    const previous = this.screen;
    stopMotionWithin(el("journey-panel"));
    const fromDetail = this.screen === "detail";
    this.savePosition();
    if (screen === "map" && this.screen !== "map")
      this.navigation.mapReturn = this.screen;
    this.navigation.screen = screen;
    this.applyLayout();
    this.restorePosition();
    if (focus) this.focusSelection(fromDetail);
    this.animateScreen(previous);
  }
  private animateScreen(previous: JourneyScreen) {
    if (previous === this.screen || this.desktop.matches) return;
    const target =
      this.screen === "map"
        ? el("map-preview-summary")
        : this.screen === "detail"
          ? this.detailPanel
          : el("choices");
    const mapChange = previous === "map" || this.screen === "map";
    reveal(target, {
      x: mapChange ? 0 : this.screen === "detail" ? 18 : -18,
      y: mapChange ? 12 : 0,
    });
  }
  private requestScreen(screen: JourneyScreen, replace = false) {
    if (this.onNavigate) this.onNavigate(screen, replace);
    else this.showScreen(screen);
  }
  private selectPreviewScreen() {
    if (this.requestPreview && !this.desktop.matches)
      this.navigation.screen = "map";
  }
  private scrollContainer() {
    return el("journey-panel").classList.contains("result-scroll-all")
      ? el("journey-panel")
      : el("panel-content");
  }
  private positionKey() {
    return this.desktop.matches
      ? "desktop"
      : this.screen === "detail"
        ? `detail:${this.displayedID}`
        : this.screen;
  }
  private savePosition() {
    this.navigation.positions[this.positionKey()] =
      this.scrollContainer().scrollTop;
  }
  private restorePosition() {
    this.scrollContainer().scrollTop =
      this.navigation.positions[this.positionKey()] ?? 0;
  }
  private applyLayout() {
    const active = document.activeElement as HTMLElement;
    const mobile = !this.desktop.matches;
    const map = mobile && this.screen === "map";
    const detail = mobile && this.screen === "detail";
    el("map-view").dataset.resultScreen = mobile ? this.screen : "desktop";
    el("journey-panel").toggleAttribute(
      "data-request-preview",
      this.requestPreview,
    );
    el("choices").hidden = map || detail || this.requestPreview;
    this.detailPanel.hidden =
      this.requestPreview || !this.displayedID || (mobile && !detail);
    this.detailPanel.inert = this.detailPanel.hidden;
    el("result-back").hidden =
      this.requestPreview || !mobile || this.screen === "list";
    el("result-back").className = map ? "secondary" : "text-button";
    el("result-back").textContent = this.example
      ? map
        ? "Beispielroute"
        : "‹ Beispielroute"
      : map
        ? this.savedOrigin
          ? "Verlauf"
          : "Alternativen"
        : this.savedOrigin === "history"
          ? "‹ Verlauf"
          : this.savedOrigin === "search"
            ? "‹ Zur Suche"
            : "‹ Alle Verbindungen";
    const resultNav = el("result-nav");
    const resultHeader = el("result-header");
    const mapActions = el("map-preview-actions");
    if (map) {
      if (resultNav.parentElement !== mapActions)
        movePreservingFocus(resultNav, mapActions, mapActions.firstChild);
    } else if (resultNav.previousElementSibling !== resultHeader) {
      movePreservingFocus(
        resultNav,
        resultHeader.parentElement!,
        resultHeader.nextSibling,
      );
    }
    const mapToggle = el<HTMLButtonElement>("panel-map-toggle");
    const mapToggleParent = el(
      mobile && !map ? "planning-context-footer" : "result-nav",
    );
    if (mapToggle.parentElement !== mapToggleParent)
      mapToggleParent.append(mapToggle);
    mapToggle.hidden = this.requestPreview || !mobile || map;
    mapToggle.disabled = !this.displayedID;
    el("map-preview").hidden = !map || this.requestPreview;
    const recovery = el("planning-recovery");
    const recoveryAnchor = el(
      this.requestPreview
        ? "search-preview-detail"
        : map
          ? "map-preview-status"
          : "stale-notice",
    );
    if (
      !recovery.dataset.planningToast &&
      (this.requestPreview
        ? recovery.parentElement !== el("search-preview-feedback")
        : recovery.previousElementSibling !== recoveryAnchor)
    )
      movePreservingFocus(
        recovery,
        this.requestPreview
          ? el("search-preview-feedback")
          : recoveryAnchor.parentElement!,
        this.requestPreview
          ? el("search-preview-feedback").firstChild
          : recoveryAnchor.nextSibling,
      );
    for (const [element, home] of this.feedbackHomes) {
      if (this.requestPreview && element.id === "map-error")
        movePreservingFocus(element, el("search-preview-feedback"));
      else if (map) movePreservingFocus(element, el("map-preview-feedback"));
      else if (element.previousSibling !== home)
        movePreservingFocus(element, home.parentNode!, home.nextSibling);
    }
    const start = el("navigation-start");
    const startParent = this.restored
      ? el("route-actions-dialog")
      : map
        ? mapActions
        : document.querySelector<HTMLElement>(".panel-actions")!;
    movePreservingFocus(start, startParent);
    const replan = el("replan-saved");
    const replanParent =
      this.restored && map
        ? mapActions
        : document.querySelector<HTMLElement>(".panel-actions")!;
    movePreservingFocus(replan, replanParent);
    if (this.example) {
      const ownRoute = el("example-plan-own");
      const actions = document.querySelector<HTMLElement>(".panel-actions")!;
      actions.hidden = map;
      const parent = map ? mapActions : actions;
      movePreservingFocus(ownRoute, parent);
      ownRoute.hidden = false;
      for (const id of [
        "adjust-route",
        "route-more",
        "map-location",
        "navigation-start",
        "route-start-summary",
      ])
        el(id).hidden = true;
      el<HTMLButtonElement>("navigation-start").disabled = true;
    }
    el("result-context").hidden = detail || map;
    el("result-freshness").hidden = this.example;
    for (const element of [
      el("map"),
      el("map-controls"),
      el("map-location"),
      el("map-route"),
      el("map-style-control"),
      document.querySelector<HTMLElement>(".map-credit")!,
    ]) {
      element.inert = !this.mapVisible;
      element.style.visibility = this.mapVisible ? "" : "hidden";
    }
    if (!this.mapVisible) closeMapStylePickers();
    if (
      active !== document.body &&
      active !== document.activeElement &&
      active.getClientRects().length &&
      !active.closest("[hidden], [inert]")
    )
      active.focus({ preventScroll: true });
    if (
      this.requestPreview &&
      !this.desktop.matches &&
      active === el("result-context")
    )
      el("search-preview-heading").focus({ preventScroll: true });
    this.onLayoutChange?.();
  }
  focusSelection(fromDetail = false) {
    const target = this.requestPreview
      ? el(this.desktop.matches ? "result-context" : "search-preview-heading")
      : !this.desktop.matches && this.screen === "map"
        ? el("map-preview-heading")
        : !this.desktop.matches && this.screen === "detail"
          ? el("journey-heading")
          : (el("choices").querySelector<HTMLElement>(
              fromDetail
                ? ".route-choice-row.selected .route-detail-link"
                : '.route-choice[aria-pressed="true"]',
            ) ?? el("result-context"));
    target.focus({ preventScroll: true });
  }
  render(state: PlanningState, cyclingLimit = 30) {
    this.statusCountdown.clear();
    this.mapCountdown.clear();
    const previewHeadingFocused =
      document.activeElement === el("search-preview-heading");
    const preview = this.searchPreview.render(state);
    this.requestPreview = !!preview;
    this.requestMapReady =
      !!preview && !state.locating && state.pendingRequestResolved !== false;
    this.selectPreviewScreen();
    const firstResults = !this.hadChoices && state.journeys.length > 0;
    this.hadChoices = state.journeys.length > 0;
    const request = state.request;
    this.restored = state.restored;
    // Keep the internal GPS label intact: planning uses it to refresh location.
    const originName =
      request?.origin.name === "Aktueller Standort"
        ? state.restored
          ? "Startpunkt"
          : "Aktueller Standort"
        : (request?.origin.name ?? "Start");
    el("route-origin").textContent = originName;
    el("route-destination").textContent = request?.destination.name ?? "Ziel";
    renderRequestStops(el("route-request-stops"), request?.stops);
    el("route-request-meta").textContent = this.example
      ? "Beispielroute"
      : request
        ? `${request.timing === "now" ? "Abfahrt jetzt" : `${request.timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`}${request.stops?.length ? ` · ${request.stops.length} ${request.stops.length === 1 ? "Zwischenstopp" : "Zwischenstopps"}` : ""}`
        : "Route bearbeiten";
    const mapMeta: string[] = [];
    if (request && !this.example) {
      if (request.timing !== "now") {
        const sameDay =
          new Date(request.time * 1000).toDateString() ===
          new Date().toDateString();
        mapMeta.push(
          `${request.timing === "arrive" ? "Ankunft bis" : "Ab"} ${sameDay ? "" : `${dateLabel(request.time)}, `}${clock(request.time)}`,
        );
      }
      if (request.stops?.length)
        mapMeta.push(
          `${request.stops.length} ${request.stops.length === 1 ? "Zwischenstopp" : "Zwischenstopps"}`,
        );
    }
    el("map-request-meta").textContent = mapMeta.join(" · ");
    el("map-request-meta").hidden = !mapMeta.length;
    el("route-action-context").hidden = !request || this.example;
    el("route-action-origin").textContent = originName;
    el("route-action-destination").textContent =
      request?.destination.name ?? "Ziel";
    el("route-action-time").textContent = request
      ? request.timing === "now"
        ? "Abfahrt jetzt"
        : `${request.timing === "arrive" ? "Ankunft bis" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`
      : "";
    el("route-action-stops-row").hidden = !request?.stops?.length;
    el("route-action-stops").textContent =
      request?.stops?.map((stop) => stop.place.name).join(" → ") ?? "";
    const selected = state.selected;
    el("route-start-duration").textContent = this.example
      ? "Gesamtdauer"
      : selected
        ? duration(selected.arrival - selected.departure)
        : "";
    el("route-start-arrival").textContent = selected
      ? this.example
        ? duration(selected.arrival - selected.departure)
        : `${journeyEndpointTime(selected, "arrival")} an`
      : "";
    cyclingLimit = state.resultSettings?.maxCyclingMinutes ?? cyclingLimit;
    const progress = planningProgress(state);
    const errorInToast =
      el("toast").dataset.planningStage === "error" &&
      !el("toast").hidden &&
      el("toast").dataset.planningId === state.calculationId;
    const progressMessage = errorInToast ? "" : progress.message;
    const status = el("status");
    if (status.textContent !== progressMessage)
      status.textContent = progressMessage;
    el("stale-notice").textContent = state.staleReason ?? "";
    el("stale-notice").hidden = !state.staleReason;
    el("refresh-route").textContent = state.staleReason
      ? "Erneut versuchen"
      : "Aktualisieren";
    el("refresh-route").hidden =
      this.example || state.busy || !!state.recovery || state.restored;
    el<HTMLButtonElement>("refresh-route").disabled =
      !state.request || !navigator.onLine;
    el<HTMLButtonElement>("adjust-route").disabled =
      !state.pendingRequest && !state.request;
    const issuesInStatus =
      progress.ready || (state.searchStatus === "partial" && !!state.message);
    el("issues").textContent = issuesInStatus ? "" : state.issues.join(" ");
    el("issues").hidden = !el("issues").textContent;
    el("journey-panel").classList.toggle("is-loading", progress.loading);
    el("journey-panel").dataset.searchStatus = state.searchStatus ?? "";
    const j = state.selected;
    this.savePosition();
    this.displayedID = j?.id;
    el("result-context").textContent = state.request
      ? `${originName} → ${state.request.destination.name}`
      : "Verbindungen";
    el("result-stand").textContent =
      !this.example && state.queriedAt
        ? `${state.restored ? "Gespeichert" : "Stand"}: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}`
        : "";
    el("route-action-stand").textContent = el("result-stand").textContent;
    const mapStatus = el("map-preview-status");
    const mapMessage = state.recovery
      ? progressMessage
      : state.restored
        ? `Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`
        : (state.staleReason ?? progressMessage);
    if (mapStatus.textContent !== mapMessage)
      mapStatus.textContent = mapMessage;
    mapStatus.hidden = !mapStatus.textContent;
    if (!state.busy && rateLimitMessage(state.failures)) {
      if (status.textContent)
        this.statusCountdown.render(status, state.recovery?.retryAt ?? 0);
      if (mapStatus.textContent)
        this.mapCountdown.render(mapStatus, state.recovery?.retryAt ?? 0);
    }
    clearTimeout(this.recoveryTimer);
    const recovery = state.recovery;
    el("planning-recovery").hidden = !recovery || state.busy;
    const recover = el<HTMLButtonElement>("recover-planning");
    const recoveryLabel =
      recovery?.action === "adjust" ? "Route anpassen" : "Erneut versuchen";
    if (el("recovery-label").textContent !== recoveryLabel)
      el("recovery-label").textContent = recoveryLabel;
    const wait = Math.max(0, (recovery?.retryAt ?? 0) - Date.now() / 1000);
    recover.disabled =
      recovery?.action === "retry" && (!navigator.onLine || wait > 0);
    el("recovery-wait").hidden =
      !wait ||
      recovery?.action !== "retry" ||
      !!rateLimitMessage(state.failures);
    const waitMessage = wait
      ? `Erneut möglich ab ${clock(recovery!.retryAt!)}.`
      : "";
    if (el("recovery-wait").textContent !== waitMessage)
      el("recovery-wait").textContent = waitMessage;
    if (wait && recovery?.action === "retry")
      this.recoveryTimer = setTimeout(
        () => {
          recover.disabled = !navigator.onLine;
          el("recovery-wait").hidden = true;
        },
        Math.min(wait * 1000, 2147483647),
      );
    const onlyComparison =
      state.journeys.length > 0 &&
      state.journeys.every(
        (journey) => cyclingExcess(journey, cyclingLimit) > 0,
      );
    if (onlyComparison && !state.busy)
      el("status").textContent =
        `${progressMessage ? progressMessage + " " : ""}Keine Verbindung innerhalb deines Radlimits gefunden. Fahrradroute zum Vergleich.`;
    el("cycling-comparison").textContent = j
      ? cyclingComparisonLabel(j, cyclingLimit)
      : "";
    el("cycling-comparison").hidden =
      !j || cyclingExcess(j, cyclingLimit) === 0;
    const delay =
      j && !this.example && !state.busy && !state.restored && !state.staleReason
        ? lateDepartureDelay(j, state.request)
        : undefined;
    el("late-departure").hidden = delay === undefined;
    el("late-departure-text").textContent =
      delay === undefined
        ? ""
        : `Start erst ${clock(j!.departure)} – ${duration(delay)} nach dem gewünschten Beginn. Größere Suchgrenzen können frühere Verbindungen ermöglichen.`;
    const recommendation = this.example
      ? "Beispielroute"
      : state.request?.timing === "arrive"
        ? "Späteste Abfahrt"
        : "Früheste Ankunft";
    const recommended = state.journeys
      .filter((j) => cyclingExcess(j, cyclingLimit) === 0)
      .sort((a, b) => compare(a, b, state.request?.timing ?? "now"))[0];
    const recommendedID = recommended?.id;
    el("map-preview-heading").textContent = this.example
      ? "Beispielroute"
      : state.restored
        ? "Gespeicherte Route"
        : j && cyclingExcess(j, cyclingLimit) > 0
          ? "Fahrradvergleich"
          : j?.id === recommendedID
            ? recommendation
            : "Ausgewählte Verbindung";
    el("saved-notice").hidden = !state.restored;
    if (state.restored)
      el("saved-notice").textContent =
        `Gespeicherter Stand: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}. Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`;
    const key = JSON.stringify([
      state.journeys.map((j) => [
        j.id,
        j.departure,
        j.arrival,
        journeyEffort(j),
        j.legs.map(({ coordinates: _coordinates, ...detail }) => detail),
      ]),
      j?.id,
      state.restored,
      state.queriedAt,
      state.request?.timing,
      cyclingLimit,
    ]);
    if (key === this.key) {
      this.applyLayout();
      this.restorePosition();
      return;
    }
    this.key = key;
    const active = document.activeElement as HTMLElement;
    const focused = active?.dataset.journey;
    const focusedDetail = active?.dataset.detailJourney;
    stopMotionWithin(el("choices"));
    el("choices").replaceChildren();
    state.journeys.forEach((journey, index) => {
      const comparison = cyclingExcess(journey, cyclingLimit) > 0;
      const row = node("div", "", "route-choice-row");
      row.classList.toggle("selected", journey.id === j?.id);
      const button = node("button", "", "route-choice");
      const effort = journeyEffort(journey);
      const effortText = this.effortDescription(effort);
      const outline = journeyOutline(journey);
      button.append(
        ...this.summary(
          journey,
          cyclingLimit,
          journey.id === recommendedID && !state.restored
            ? recommendation
            : undefined,
        ),
      );
      button.type = "button";
      button.dataset.journey = journey.id;
      button.setAttribute("aria-pressed", String(journey.id === j?.id));
      button.setAttribute(
        "aria-label",
        this.example
          ? `Beispielroute: Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`
          : `${comparison ? "Fahrradvergleich: " + cyclingComparisonLabel(journey, cyclingLimit) : journey.id === recommendedID ? recommendation : `Alternative ${index + 1}`}: Ankunft ${dateLabel(journey.arrival)} ${clock(journey.arrival)}, Abfahrt ${dateLabel(journey.departure)} ${clock(journey.departure)}, Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`,
      );
      button.onclick = () => {
        this.savePosition();
        const changed = journey.id !== this.displayedID;
        this.select(journey.id);
        if (changed) {
          const selectedRow = el("choices").querySelector<HTMLElement>(
            ".route-choice-row.selected",
          );
          if (selectedRow)
            reveal(selectedRow, {
              y: 0,
              duration: motionTime.selection,
              fromOpacity: 0.75,
            });
          if (this.desktop.matches)
            reveal(el("journey-detail"), {
              y: 4,
              duration: motionTime.selection,
              fromOpacity: 0.75,
            });
        }
      };
      const details = node("button", "Details ›", "route-detail-link");
      details.type = "button";
      details.dataset.detailJourney = journey.id;
      details.setAttribute(
        "aria-label",
        this.example
          ? "Details zur Beispielroute"
          : `Details: Abfahrt ${clock(journey.departure)}, Ankunft ${clock(journey.arrival)}`,
      );
      details.disabled = journey.id !== j?.id;
      details.inert = details.disabled;
      details.onclick = () => {
        this.onDetailsOpened?.();
        if (this.desktop.matches) {
          el("journey-heading").focus({ preventScroll: true });
          this.detailPanel.scrollIntoView({ block: "nearest" });
          reveal(el("journey-detail"), { y: 8 });
        } else this.requestScreen("detail");
      };
      row.append(button, details);
      el("choices").append(row);
    });
    if (j) {
      this.details(j, state.restored);
      const summary = this.example
        ? `${duration(j.arrival - j.departure)} gesamt`
        : `${journeyTimeRange(j)} · ${duration(j.arrival - j.departure)}`;
      el("journey-heading").textContent = summary;
      const effort = journeyEffort(j);
      el("journey-effort").textContent =
        `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
      el("map-preview-summary").replaceChildren(
        ...this.summary(j, cyclingLimit),
      );
    } else {
      el("journey-detail").replaceChildren();
      el("map-preview-summary").replaceChildren();
    }
    el<HTMLButtonElement>("map-open-details").disabled = !j;
    this.applyLayout();
    this.restorePosition();
    if (firstResults) reveal(el("choices"), { y: 10 });
    if (previewHeadingFocused && !preview && state.selected)
      el(this.desktop.matches ? "result-context" : "map-preview-heading").focus(
        { preventScroll: true },
      );
    if (focusedDetail && !el("choices").hidden)
      [
        ...el("choices").querySelectorAll<HTMLButtonElement>(
          ".route-detail-link:not(:disabled)",
        ),
      ]
        .find((b) => b.dataset.detailJourney === focusedDetail)
        ?.focus({ preventScroll: true });
    if (focused && !el("choices").hidden)
      [...el("choices").querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.dataset.journey === focused)
        ?.focus({ preventScroll: true });
  }

  private summary(
    journey: Journey,
    cyclingLimit: number,
    recommendation?: string,
  ) {
    const comparison = cyclingExcess(journey, cyclingLimit) > 0;
    const heading = node("span", "", "route-choice-time");
    const arrival = node(
      "strong",
      this.example
        ? `${duration(journey.arrival - journey.departure)} gesamt`
        : `${journeyEndpointTime(journey, "arrival")} an`,
      "route-choice-arrival",
    );
    const schedule = node(
      "span",
      `Ab ${journeyEndpointTime(journey, "departure")} · ${duration(journey.arrival - journey.departure)}`,
      "route-choice-schedule",
    );
    if (comparison) {
      arrival.style.setProperty("--stage-color", routeSymbolColor("bike"));
      arrival.prepend(icon("bike"), node("span", " · ", "visually-hidden"));
    }
    if (this.example) heading.append(arrival);
    else
      heading.append(arrival, node("span", " · ", "visually-hidden"), schedule);
    const effort = journeyEffort(journey);
    const accessible = node(
      "span",
      `${comparison ? `Fahrradvergleich: ${cyclingComparisonLabel(journey, cyclingLimit)}. ` : ""}${journeyOutline(journey)}. ${this.effortDescription(effort)}`,
      "sr-only",
    );
    return [
      ...(recommendation
        ? [node("span", recommendation, "route-recommendation")]
        : []),
      heading,
      this.choiceOutline(journey),
      this.choiceEffort(effort),
      accessible,
    ];
  }

  private choiceOutline(journey: Journey) {
    const outline = node("span", "", "route-outline");
    outline.setAttribute("aria-hidden", "true");
    for (const leg of journey.legs) {
      if (["fold", "unfold", "wait"].includes(leg.kind)) continue;
      const stage = node("span", "", "route-stage");
      stage.dataset.kind = leg.kind;
      stage.style.setProperty(
        "--stage-color",
        routeSymbolColor(leg.kind, leg.mode),
      );
      if (outline.childElementCount)
        stage.append(node("span", "→", "route-stage-arrow"));
      const symbol =
        leg.kind === "transit" && ["BUS", "COACH"].includes(leg.mode ?? "")
          ? "bus"
          : leg.kind;
      stage.dataset.symbol = symbol;
      const namedRail =
        leg.kind === "transit" &&
        ["SUBURBAN", "SUBWAY", "REGIONAL_RAIL"].includes(leg.mode ?? "") &&
        !!leg.line?.trim();
      if (!namedRail) stage.append(icon(symbol));
      if (leg.kind === "transit")
        stage.append(node("span", leg.line?.trim() || "ÖPNV", "route-line"));
      else if (leg.kind === "stop")
        stage.append(node("span", leg.from.name, "route-stop-name"));
      outline.append(stage);
    }
    return outline;
  }

  private effortDescription(effort: ReturnType<typeof journeyEffort>) {
    const transfers = `${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
    return effort.cyclingSeconds > 0
      ? `${duration(effort.cyclingSeconds)} Rad · ${transfers}`
      : transfers;
  }

  private choiceEffort(effort: ReturnType<typeof journeyEffort>) {
    const summary = node("span", "", "route-choice-effort");
    summary.setAttribute("aria-hidden", "true");
    summary.append(node("span", "Gesamt:", "route-effort-label"));
    const addMetric = (
      name: "bike" | "transfer",
      text: string,
      label: string,
    ) => {
      const metric = node("span", text, "route-effort-metric");
      metric.dataset.kind = name;
      metric.title = label;
      summary.append(metric);
    };
    if (effort.cyclingSeconds > 0)
      addMetric(
        "bike",
        `${duration(effort.cyclingSeconds)} Rad`,
        "Gesamte Zeit auf dem Fahrrad",
      );
    addMetric("transfer", `${effort.transfers} Umst.`, "Anzahl der Umstiege");
    return summary;
  }

  private details(j: Journey, restored: boolean) {
    const list = renderJourneyDetails(j, restored, this.presentation);
    el("journey-detail").replaceChildren(
      node(
        "p",
        `${(bikeDistance(j) / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km Rad`,
        "journey-distance",
      ),
      list,
    );
  }
}

export function journeyEndpointTime(
  journey: Pick<Journey, "departure" | "arrival">,
  endpoint: "departure" | "arrival",
): string {
  const instant = journey[endpoint];
  const crossDay =
    new Date(journey.departure * 1000).toDateString() !==
    new Date(journey.arrival * 1000).toDateString();
  const showDate =
    crossDay ||
    new Date(instant * 1000).toDateString() !== new Date().toDateString();
  return `${showDate ? `${dateLabel(instant)} ` : ""}${clock(instant)}`;
}

export function journeyTimeRange(
  journey: Pick<Journey, "departure" | "arrival">,
): string {
  const departure = new Date(journey.departure * 1000);
  const arrival = new Date(journey.arrival * 1000);
  if (departure.toDateString() !== arrival.toDateString())
    return `${dateLabel(journey.departure)} ${clock(journey.departure)} → ${dateLabel(journey.arrival)} ${clock(journey.arrival)}`;
  const day =
    departure.toDateString() === new Date().toDateString()
      ? ""
      : `${dateLabel(journey.departure)} · `;
  return `${day}${clock(journey.departure)} → ${clock(journey.arrival)}`;
}
