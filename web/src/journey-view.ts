import { DialogController } from "./dialog-controller";
import { flushSync } from "svelte";
import { appPresentation } from "./app-presentation";
import type { JourneyWorkspaceApi } from "./journey-workspace-presentation";
import { journeyTimeRange, journeyEndpointTime } from "./journey-time";
export { journeyTimeRange, journeyEndpointTime } from "./journey-time";
import { type JourneyPresentation } from "./journey-detail-view";
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
  rateLimitMessage,
} from "./model";
import { type PlanningState } from "./planning-state";
import { planningProgress } from "./planning-progress";
import { SearchPreview } from "./search-preview";
import { el, clock, duration, dateLabel } from "./ui";
export interface JourneySheet {
  mode: "alternatives" | "preview" | "detail";
  journeyId?: string;
  scrollTop: number;
  listScrollTop?: number;
}

export interface JourneyNavigation {
  screen: "map";
  savedOrigin?: "search" | "history";
  positions: Record<string, number>;
  sheet?: JourneySheet;
}

interface LegacyJourneyNavigation {
  screen: "list" | "detail" | "map";
  savedOrigin?: "search" | "history";
  positions: Record<string, number>;
  alternatives?: { previewId?: string; scrollTop: number };
}

/** History entries from an older tab can still contain full-screen results. */
export function normalizeJourneyNavigation(
  value?: JourneyNavigation | LegacyJourneyNavigation,
  selectedId?: string,
  hasJourneys = false,
): JourneyNavigation {
  const navigation: JourneyNavigation = {
    screen: "map",
    savedOrigin: value?.savedOrigin,
    positions: { ...value?.positions },
  };
  if (value && "sheet" in value && value.sheet)
    navigation.sheet = structuredClone(value.sheet);
  else if (value && "alternatives" in value && value.alternatives) {
    const { previewId, scrollTop } = value.alternatives;
    navigation.sheet = previewId
      ? {
          mode: "preview",
          journeyId: previewId,
          scrollTop: 0,
          listScrollTop: scrollTop,
        }
      : { mode: "alternatives", scrollTop };
  } else if (value?.screen === "detail" && selectedId)
    navigation.sheet = {
      mode: "detail",
      journeyId: selectedId,
      scrollTop: value.positions[`detail:${selectedId}`] ?? 0,
    };
  else if (value?.screen === "list" && hasJourneys)
    navigation.sheet = {
      mode: "alternatives",
      scrollTop: value.positions.list ?? 0,
    };
  return navigation;
}

export class JourneyView {
  onDetailsOpened?: () => void;
  onBack?: () => void;
  onSheetChange?: (action: "open" | "update" | "close") => void;
  onLayoutChange?: () => void;
  onPositionChange?: () => void;
  private key = "";
  private displayedID?: string;
  private restored = false;
  private hadChoices = false;
  private requestPreview = false;
  private requestMapReady = false;
  private readonly searchPreview: SearchPreview;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private navigation: JourneyNavigation = {
    screen: "map",
    positions: {},
  };
  private readonly desktop = matchMedia("(min-width: 900px)");
  private get detailPanel() {
    return el("panel-details");
  }
  private readonly alternativesDialog = el<HTMLDialogElement>(
    "alternatives-dialog",
  );
  private lastState?: PlanningState;
  private lastCyclingLimit = 30;
  private sheetCalculationId?: string;
  private sheetDetailKey = "";
  private renderedDetailKey = "";
  private sheetAnchor?: { id: string; top: number };
  private sheetReturnTrigger = "result-back";

  constructor(
    private select: (id: string) => void,
    private readonly presentation: JourneyPresentation = "live",
    private readonly workspace: JourneyWorkspaceApi = appPresentation()
      .workspace,
  ) {
    this.searchPreview = new SearchPreview(this.workspace);
    this.workspace.setCommand("alternatives-close", () => this.closeSheet());
    this.alternativesDialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...this.alternativesDialog.querySelectorAll<HTMLElement>(
          "button, a[href], input, select, textarea, [tabindex]",
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[hidden], [inert]") &&
          element.getClientRects().length,
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    this.alternativesDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeSheet();
    });
    this.workspace.setCommand("alternatives-back", () => {
      const sheet = this.navigation.sheet;
      if (sheet?.mode !== "preview") return;
      this.navigation.sheet = {
        mode: "alternatives",
        scrollTop: sheet.listScrollTop ?? 0,
      };
      this.refreshSheet();
      this.onSheetChange?.("update");
      el("choices")
        .querySelector<HTMLElement>(
          `.route-detail-link[data-detail-journey="${CSS.escape(sheet.journeyId ?? "")}"]`,
        )
        ?.focus({ preventScroll: true });
    });
    this.workspace.setCommand("alternatives-select", () => {
      const sheet = this.navigation.sheet;
      const id = sheet?.mode === "preview" ? sheet.journeyId : undefined;
      if (!id || !this.lastState?.journeys.some((journey) => journey.id === id))
        return;
      this.select(id);
      this.closeSheet();
    });
    el("alternatives-body").addEventListener(
      "scroll",
      () => {
        if (this.navigation.sheet) {
          this.saveSheetPosition();
          this.onPositionChange?.();
        }
      },
      { passive: true },
    );
    this.workspace.setCommand("result-back", () => {
      if (!this.desktop.matches && !this.savedOrigin && !this.example) {
        this.openAlternatives();
        return;
      }
      if (this.onBack) this.onBack();
      else this.openAlternatives();
    });
    this.workspace.setCommand("map-open-details", () => {
      this.openDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("#choices")
      )
        return;
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
    });
    const actionsDialog = el<HTMLDialogElement>("route-actions-dialog");
    const actionsController = new DialogController(actionsDialog);
    const closeActions = () => {
      if (!actionsDialog.open) return;
      actionsController.close();
    };
    this.workspace.setCommand("route-more", () =>
      actionsController.open(el("route-more")),
    );
    this.workspace.setCommand("route-actions-close", closeActions);
    actionsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeActions();
    });
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "#share-plan, #refresh-route, #replan-saved, #navigation-start",
          )
        )
          closeActions();
      },
      { capture: true },
    );
    this.desktop.addEventListener("change", () => {
      if (this.desktop.matches) this.closeSheet(true, false);
      this.applyLayout();
      this.restorePosition();
      const active = document.activeElement as HTMLElement;
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
        if (wasScrolling)
          this.workspace.toggleClass(
            "journey-panel",
            "result-scroll-all",
            false,
          );
        const fixed =
          el("result-header").offsetHeight +
          (el("result-nav").parentElement === panel
            ? el("result-nav").offsetHeight
            : 0) +
          panel.querySelector<HTMLElement>(".panel-actions")!.offsetHeight +
          48;
        const row = Math.max(
          100,
          ...[...el("choices").children].map(
            (e) => e.getBoundingClientRect().height,
          ),
        );
        // Wrapping changes between scroll modes. Leave spare room before
        // returning to the fixed header and footer to avoid resize oscillation.
        const spare = wasScrolling
          ? 2 * parseFloat(getComputedStyle(panel).fontSize)
          : 0;
        this.workspace.toggleClass(
          "journey-panel",
          "result-scroll-all",
          this.desktop.matches &&
            el("map-view").clientHeight < fixed + row + spare,
        );
        if (wasScrolling && panel.classList.contains("result-scroll-all"))
          panel.scrollTop = scrollTop;
      });
    });
    for (const element of [
      el("map-view"),
      el("result-header"),
      el("journey-panel").querySelector<HTMLElement>(".panel-actions")!,
    ])
      observer.observe(element);
    let dynamicObserved = [el("result-nav"), el("choices")];
    dynamicObserved.forEach((element) => observer.observe(element));
    this.workspace.subscribeStructure(() => {
      dynamicObserved.forEach((element) => observer.unobserve(element));
      dynamicObserved = [el("result-nav"), el("choices")];
      dynamicObserved.forEach((element) => observer.observe(element));
    });
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
  get sheetOpen() {
    return this.alternativesDialog.open;
  }
  openAlternatives() {
    if (
      this.desktop.matches ||
      !this.lastState?.journeys.length ||
      this.requestPreview ||
      this.sheetOpen
    )
      return;
    this.openSheet({ mode: "alternatives", scrollTop: 0 });
    const selected = el("choices").querySelector<HTMLElement>(
      '.route-choice[aria-pressed="true"]',
    );
    selected?.scrollIntoView({ block: "nearest" });
    selected?.focus({ preventScroll: true });
  }
  openDetails() {
    if (
      this.desktop.matches ||
      !this.lastState?.selected ||
      this.requestPreview ||
      this.sheetOpen
    )
      return;
    this.onDetailsOpened?.();
    this.openSheet({
      mode: "detail",
      journeyId: this.lastState.selected.id,
      scrollTop: 0,
    });
    el("alternatives-title").focus({ preventScroll: true });
  }
  private openSheet(sheet: JourneySheet) {
    closeMapStylePickers();
    this.navigation.sheet = sheet;
    this.sheetReturnTrigger =
      sheet.mode === "detail" ? "map-open-details" : "result-back";
    this.workspace.setText("alternatives-announcement", "");
    this.sheetCalculationId = this.lastState?.calculationId;
    this.refreshSheet();
    this.onSheetChange?.("open");
  }
  closeSheet(notify = true, focus = true) {
    if (!this.navigation.sheet && !this.sheetOpen) return;
    delete this.navigation.sheet;
    this.refreshSheet();
    if (focus) this.focusSheetTrigger();
    if (notify) this.onSheetChange?.("close");
  }
  focusSheetTrigger() {
    if (this.desktop.matches) this.focusSelection();
    else {
      const trigger = el(this.sheetReturnTrigger);
      (trigger.getClientRects().length
        ? trigger
        : el("map-preview-heading")
      ).focus({ preventScroll: true });
    }
  }
  dismissSheet() {
    if (!this.navigation.sheet && !this.sheetOpen) return;
    this.closeSheet(false, false);
    this.onSheetChange?.("update");
  }
  private refreshSheet() {
    this.key = "";
    if (this.lastState) this.render(this.lastState, this.lastCyclingLimit);
    else this.applyLayout();
  }
  private previewAlternative(id: string) {
    const sheet = this.navigation.sheet;
    if (sheet?.mode !== "alternatives") return;
    this.saveSheetPosition();
    this.navigation.sheet = {
      mode: "preview",
      journeyId: id,
      listScrollTop: sheet.scrollTop,
      scrollTop: 0,
    };
    this.onDetailsOpened?.();
    this.refreshSheet();
    el("alternatives-title").focus({ preventScroll: true });
    this.onSheetChange?.("update");
  }
  private sheetKey(sheet: JourneySheet) {
    return `${sheet.mode}:${sheet.journeyId ?? ""}`;
  }
  private saveSheetPosition() {
    const sheet = this.navigation.sheet;
    if (sheet && this.sheetOpen && this.sheetKey(sheet) === this.sheetDetailKey)
      sheet.scrollTop = el("alternatives-body").scrollTop;
  }
  private renderSheet() {
    let sheet = this.navigation.sheet;
    if (!sheet) {
      if (this.alternativesDialog.open) this.alternativesDialog.close();
      this.sheetDetailKey = "";
      return;
    }
    const journeyId = sheet.journeyId;
    const journey = this.lastState?.journeys.find(
      (journey) => journey.id === journeyId,
    );
    const unavailable = sheet.mode === "preview" && !journey;
    if (unavailable) {
      sheet = this.navigation.sheet = {
        mode: "alternatives",
        scrollTop: sheet.listScrollTop ?? 0,
      };
      this.workspace.setText(
        "alternatives-announcement",
        "Diese Verbindung ist nicht mehr verfügbar. Bitte wähle eine Alternative.",
      );
    }
    const detail = sheet.mode !== "alternatives";
    this.workspace.setAttribute("alternatives-dialog", "data-mode", sheet.mode);
    this.workspace.setText(
      "alternatives-title",
      detail ? "Reiseablauf" : "Alternativen",
    );
    this.workspace.setAttribute(
      "alternatives-close",
      "aria-label",
      detail ? "Reiseablauf schließen" : "Alternativen schließen",
    );
    this.workspace.setAttribute(
      "alternatives-body",
      "aria-label",
      detail ? "Reiseablauf" : "Verbindungen",
    );
    this.workspace.setHidden("alternatives-back", sheet.mode !== "preview");
    this.workspace.setHidden("alternatives-footer", sheet.mode !== "preview");
    const body = el("alternatives-body");
    this.workspace.setHidden("choices", detail);
    this.workspace.setHidden("panel-details", !detail);
    this.workspace.setInert("panel-details", !detail);
    for (const id of [
      "status",
      "saved-notice",
      "stale-notice",
      "issues",
      "planning-recovery",
      "map-error",
      "late-departure",
      "cycling-comparison",
    ] as const)
      this.workspace.setAttribute(
        id,
        "data-sheet-detail-hidden",
        detail &&
          !(
            sheet.mode === "detail" &&
            ["saved-notice", "stale-notice"].includes(id)
          ) &&
          !(id === "planning-recovery" && el(id).dataset.planningToast)
          ? ""
          : undefined,
      );
    if (detail && journey) this.renderDetailContent(journey, this.restored);
    if (!this.alternativesDialog.open) this.alternativesDialog.showModal();
    body.scrollTop = sheet.scrollTop;
    if (!detail && this.sheetAnchor) {
      const row = el("choices")
        .querySelector<HTMLElement>(
          `.route-choice[data-journey="${CSS.escape(this.sheetAnchor.id)}"]`,
        )
        ?.closest<HTMLElement>(".route-choice-row");
      if (row)
        body.scrollTop +=
          row.getBoundingClientRect().top - this.sheetAnchor.top;
    }
    this.sheetAnchor = undefined;
    this.sheetDetailKey = this.sheetKey(sheet);
    sheet.scrollTop = body.scrollTop;
    if (unavailable) {
      el("alternatives-title").focus({ preventScroll: true });
      this.onSheetChange?.("update");
    }
  }
  private get example() {
    return this.presentation === "example";
  }
  get mapVisible() {
    return !this.requestPreview || this.requestMapReady;
  }
  get savedOrigin() {
    return this.navigation.savedOrigin;
  }
  snapshot(): JourneyNavigation {
    this.savePosition();
    return structuredClone(this.navigation);
  }
  restoreNavigation(
    value?: JourneyNavigation | LegacyJourneyNavigation,
    focus = false,
  ) {
    if (this.navigation.sheet)
      this.sheetReturnTrigger =
        this.navigation.sheet.mode === "detail"
          ? "map-open-details"
          : "result-back";
    this.navigation = normalizeJourneyNavigation(
      value,
      this.lastState?.selected?.id,
      !!this.lastState?.journeys.length,
    );
    if (this.desktop.matches) delete this.navigation.sheet;
    if (this.navigation.sheet) {
      this.sheetCalculationId = this.lastState?.calculationId;
      if (this.navigation.sheet.mode !== "alternatives")
        this.onDetailsOpened?.();
      this.sheetReturnTrigger =
        this.navigation.sheet.mode === "detail"
          ? "map-open-details"
          : "result-back";
    }
    this.sheetDetailKey = "";
    this.refreshSheet();
    this.restorePosition();
    if (focus) this.focusSelection();
  }
  reset(savedOrigin?: "search" | "history") {
    this.restoreNavigation({ screen: "map", savedOrigin, positions: {} });
  }
  private scrollContainer() {
    return !this.desktop.matches ||
      el("journey-panel").classList.contains("result-scroll-all")
      ? el("journey-panel")
      : el("panel-content");
  }
  private positionKey() {
    return this.desktop.matches ? "desktop" : "map";
  }
  private savePosition() {
    this.saveSheetPosition();
    this.navigation.positions[this.positionKey()] =
      this.scrollContainer().scrollTop;
  }
  private restorePosition() {
    this.scrollContainer().scrollTop =
      this.navigation.positions[this.positionKey()] ?? 0;
  }
  private applyLayout() {
    const active = document.activeElement as HTMLElement;
    const focusID = active?.id;
    const focusJourney = active?.dataset.journey;
    const focusDetail = active?.dataset.detailJourney;
    const mobile = !this.desktop.matches;
    const map = mobile;
    this.workspace.updateLayout({
      desktop: !mobile,
      requestPreview: this.requestPreview,
      restored: this.restored,
      savedOrigin: this.savedOrigin,
      example: this.example,
      sheetMode: this.navigation.sheet?.mode,
    });
    this.workspace.setAttribute(
      "map-view",
      "data-result-screen",
      mobile ? "map" : "desktop",
    );
    this.workspace.setAttribute(
      "journey-panel",
      "data-request-preview",
      this.requestPreview ? "" : undefined,
    );
    this.workspace.setHidden("choices", mobile || this.requestPreview);
    this.workspace.setHidden(
      "panel-details",
      this.requestPreview || !this.displayedID || mobile,
    );
    this.workspace.setInert("panel-details", !!this.detailPanel.hidden);
    this.workspace.setHidden(
      "result-back",
      this.requestPreview ||
        !mobile ||
        this.example ||
        (!this.savedOrigin && !this.lastState?.journeys.length),
    );
    this.workspace.setClass("result-back", "secondary");
    this.workspace.setText(
      "result-back",
      this.savedOrigin === "history"
        ? "Verlauf"
        : this.savedOrigin === "search"
          ? "Zur Suche"
          : "Alternativen",
    );
    const alternativesTrigger =
      mobile && !this.savedOrigin && !this.example && !this.requestPreview;
    this.workspace.setAttribute(
      "result-back",
      "aria-haspopup",
      alternativesTrigger ? "dialog" : "false",
    );
    this.workspace.setAttribute(
      "result-back",
      "aria-controls",
      alternativesTrigger ? "alternatives-dialog" : undefined,
    );
    this.workspace.setAttribute(
      "result-back",
      "aria-expanded",
      alternativesTrigger
        ? String(
            this.navigation.sheet?.mode === "alternatives" ||
              this.navigation.sheet?.mode === "preview",
          )
        : undefined,
    );
    this.workspace.setHidden("map-preview", !map || this.requestPreview);
    this.workspace.setHidden(
      "map-open-details",
      !this.displayedID || this.requestPreview,
    );
    this.workspace.setAttribute(
      "map-open-details",
      "aria-expanded",
      String(this.navigation.sheet?.mode === "detail"),
    );
    if (this.example) {
      this.workspace.setHidden("panel-actions", map);
      this.workspace.setHidden("example-plan-own", false);
      for (const id of [
        "adjust-route",
        "route-more",
        "map-location",
        "navigation-start",
        "route-start-summary",
      ] as const)
        this.workspace.setHidden(id, true);
      this.workspace.setDisabled("navigation-start", true);
    }
    this.workspace.setHidden("result-context", map);
    this.workspace.setHidden("result-freshness", this.example);
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
    this.renderSheet();
    if (active !== document.body && !active.isConnected) {
      const replacement = focusID
        ? document.getElementById(focusID)
        : focusJourney
          ? el("choices").querySelector<HTMLElement>(
              `.route-choice[data-journey="${CSS.escape(focusJourney)}"]`,
            )
          : focusDetail
            ? el("choices").querySelector<HTMLElement>(
                `.route-detail-link[data-detail-journey="${CSS.escape(focusDetail)}"]`,
              )
            : undefined;
      if (
        replacement?.getClientRects().length &&
        !replacement.closest("[hidden], [inert]")
      )
        replacement.focus({ preventScroll: true });
    }
    this.onLayoutChange?.();
  }
  focusSelection() {
    if (this.sheetOpen) {
      (this.navigation.sheet?.mode === "alternatives"
        ? (el("choices").querySelector<HTMLElement>(
            '.route-choice[aria-pressed="true"]',
          ) ?? el("alternatives-title"))
        : el("alternatives-title")
      ).focus({ preventScroll: true });
      return;
    }
    const target = this.requestPreview
      ? el(this.desktop.matches ? "result-context" : "search-preview-heading")
      : !this.desktop.matches
        ? el("map-preview-heading")
        : (el("choices").querySelector<HTMLElement>(
            '.route-choice[aria-pressed="true"]',
          ) ?? el("result-context"));
    target.focus({ preventScroll: true });
  }
  render(state: PlanningState, cyclingLimit = 30) {
    this.saveSheetPosition();
    const newRequest =
      !!state.pendingRequest &&
      state.pendingRequest !== this.lastState?.pendingRequest;
    // Preserve the visible connection when live results rebuild the shared list.
    this.sheetAnchor = undefined;
    if (
      this.sheetOpen &&
      this.sheetDetailKey === "alternatives:" &&
      this.navigation.sheet?.mode === "alternatives" &&
      el("alternatives-body").scrollTop > 0
    ) {
      const top = el("alternatives-body").getBoundingClientRect().top;
      const row = [
        ...el("choices").querySelectorAll<HTMLElement>(".route-choice-row"),
      ].find((row) => row.getBoundingClientRect().bottom > top);
      const id =
        row?.querySelector<HTMLElement>(".route-choice")?.dataset.journey;
      if (row && id)
        this.sheetAnchor = { id, top: row.getBoundingClientRect().top };
    }
    this.lastState = state;
    this.lastCyclingLimit = cyclingLimit;
    const sheetClosed =
      !!this.navigation.sheet &&
      (this.desktop.matches ||
        state.calculationId !== this.sheetCalculationId ||
        !state.journeys.length ||
        newRequest ||
        (this.navigation.sheet.mode === "detail" &&
          !state.journeys.some(
            (journey) => journey.id === this.navigation.sheet?.journeyId,
          )));
    if (sheetClosed) delete this.navigation.sheet;
    this.workspace.setRetryAt("status", 0);
    this.workspace.setRetryAt("map-preview-status", 0);
    const previewHeadingFocused =
      document.activeElement === el("search-preview-heading");
    const preview = this.searchPreview.render(state);
    this.requestPreview = !!preview;
    this.requestMapReady =
      !!preview && !state.locating && state.pendingRequestResolved !== false;
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
    this.workspace.setText("route-origin", originName);
    this.workspace.setText(
      "route-destination",
      request?.destination.name ?? "Ziel",
    );
    this.workspace.updateStops(request?.stops ?? []);
    this.workspace.setText(
      "route-request-meta",
      this.example
        ? "Beispielroute"
        : request
          ? `${request.timing === "now" ? "Abfahrt jetzt" : `${request.timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`}${request.stops?.length ? ` · ${request.stops.length} ${request.stops.length === 1 ? "Zwischenstopp" : "Zwischenstopps"}` : ""}`
          : "Route bearbeiten",
    );
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
    this.workspace.setText("map-request-meta", mapMeta.join(" · "));
    this.workspace.setHidden("map-request-meta", !mapMeta.length);
    this.workspace.setHidden("route-action-context", !request || this.example);
    this.workspace.setText("route-action-origin", originName);
    this.workspace.setText(
      "route-action-destination",
      request?.destination.name ?? "Ziel",
    );
    this.workspace.setText(
      "route-action-time",
      request
        ? request.timing === "now"
          ? "Abfahrt jetzt"
          : `${request.timing === "arrive" ? "Ankunft bis" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`
        : "",
    );
    this.workspace.setHidden("route-action-stops-row", !request?.stops?.length);
    this.workspace.setText(
      "route-action-stops",
      request?.stops?.map((stop) => stop.place.name).join(" → ") ?? "",
    );
    const selected = state.selected;
    this.workspace.setText(
      "route-start-duration",
      this.example
        ? "Gesamtdauer"
        : selected
          ? duration(selected.arrival - selected.departure)
          : "",
    );
    this.workspace.setText(
      "route-start-arrival",
      selected
        ? this.example
          ? duration(selected.arrival - selected.departure)
          : `${journeyEndpointTime(selected, "arrival")} an`
        : "",
    );
    cyclingLimit = state.resultSettings?.maxCyclingMinutes ?? cyclingLimit;
    const progress = planningProgress(state);
    const errorInToast =
      el("toast").dataset.planningStage === "error" &&
      !el("toast").hidden &&
      el("toast").dataset.planningId === state.calculationId;
    const progressMessage = errorInToast ? "" : progress.message;
    const status = el("status");
    if (status.textContent !== progressMessage)
      this.workspace.setText("status", progressMessage);
    this.workspace.setText("stale-notice", state.staleReason ?? "");
    this.workspace.setHidden("stale-notice", !state.staleReason);
    this.workspace.setText(
      "refresh-route",
      state.staleReason ? "Erneut versuchen" : "Aktualisieren",
    );
    this.workspace.setHidden(
      "refresh-route",
      this.example || state.busy || !!state.recovery || state.restored,
    );
    this.workspace.setDisabled(
      "refresh-route",
      !state.request || !navigator.onLine,
    );
    this.workspace.setDisabled(
      "adjust-route",
      !state.pendingRequest && !state.request,
    );
    const issuesInStatus =
      progress.ready || (state.searchStatus === "partial" && !!state.message);
    this.workspace.setText(
      "issues",
      issuesInStatus ? "" : state.issues.join(" "),
    );
    this.workspace.setHidden("issues", !el("issues").textContent);
    this.workspace.toggleClass("journey-panel", "is-loading", progress.loading);
    this.workspace.setAttribute(
      "journey-panel",
      "data-search-status",
      state.searchStatus ?? "",
    );
    const j = state.selected;
    this.savePosition();
    this.displayedID = j?.id;
    this.workspace.setText(
      "result-context",
      state.request
        ? `${originName} → ${state.request.destination.name}`
        : "Verbindungen",
    );
    this.workspace.setText(
      "result-stand",
      !this.example && state.queriedAt
        ? `${state.restored ? "Gespeichert" : "Stand"}: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}`
        : "",
    );
    this.workspace.setText(
      "route-action-stand",
      el("result-stand").textContent,
    );
    const mapStatus = el("map-preview-status");
    const mapMessage = state.recovery
      ? progressMessage
      : state.restored
        ? `Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`
        : (state.staleReason ?? progressMessage);
    if (mapStatus.textContent !== mapMessage)
      this.workspace.setText("map-preview-status", mapMessage);
    this.workspace.setHidden("map-preview-status", !mapStatus.textContent);
    if (!state.busy && rateLimitMessage(state.failures)) {
      if (status.textContent)
        this.workspace.setRetryAt("status", state.recovery?.retryAt ?? 0);
      if (mapStatus.textContent)
        this.workspace.setRetryAt(
          "map-preview-status",
          state.recovery?.retryAt ?? 0,
        );
    }
    clearTimeout(this.recoveryTimer);
    const recovery = state.recovery;
    this.workspace.setHidden("planning-recovery", !recovery || state.busy);
    const recover = el<HTMLButtonElement>("recover-planning");
    const recoveryLabel =
      recovery?.action === "adjust" ? "Route anpassen" : "Erneut versuchen";
    if (el("recovery-label").textContent !== recoveryLabel)
      this.workspace.setText("recovery-label", recoveryLabel);
    const wait = Math.max(0, (recovery?.retryAt ?? 0) - Date.now() / 1000);
    this.workspace.setDisabled(
      "recover-planning",
      recovery?.action === "retry" && (!navigator.onLine || wait > 0),
    );
    this.workspace.setHidden(
      "recovery-wait",
      !wait ||
        recovery?.action !== "retry" ||
        !!rateLimitMessage(state.failures),
    );
    const waitMessage = wait
      ? `Erneut möglich ab ${clock(recovery!.retryAt!)}.`
      : "";
    if (el("recovery-wait").textContent !== waitMessage)
      this.workspace.setText("recovery-wait", waitMessage);
    if (wait && recovery?.action === "retry")
      this.recoveryTimer = setTimeout(
        () => {
          this.workspace.setDisabled("recover-planning", !navigator.onLine);
          this.workspace.setHidden("recovery-wait", true);
        },
        Math.min(wait * 1000, 2147483647),
      );
    const onlyComparison =
      state.journeys.length > 0 &&
      state.journeys.every(
        (journey) => cyclingExcess(journey, cyclingLimit) > 0,
      );
    if (onlyComparison && !state.busy)
      this.workspace.setText(
        "status",
        this.workspace.setText(
          "map-preview-status",
          `${progressMessage ? progressMessage + " " : ""}Keine Verbindung innerhalb deines Radlimits gefunden. Fahrradroute zum Vergleich.`,
        ),
      );
    if (onlyComparison && !state.busy)
      this.workspace.setHidden("map-preview-status", false);
    this.workspace.setText(
      "cycling-comparison",
      j ? cyclingComparisonLabel(j, cyclingLimit) : "",
    );
    this.workspace.setHidden(
      "cycling-comparison",
      !j || cyclingExcess(j, cyclingLimit) === 0,
    );
    const delay =
      j && !this.example && !state.busy && !state.restored && !state.staleReason
        ? lateDepartureDelay(j, state.request)
        : undefined;
    this.workspace.setHidden("late-departure", delay === undefined);
    this.workspace.setText(
      "late-departure-text",
      delay === undefined
        ? ""
        : `Start erst ${clock(j!.departure)} – ${duration(delay)} nach dem gewünschten Beginn. Größere Suchgrenzen können frühere Verbindungen ermöglichen.`,
    );
    const recommendation = this.example
      ? "Beispielroute"
      : state.request?.timing === "arrive"
        ? "Späteste Abfahrt"
        : "Früheste Ankunft";
    const recommended = state.journeys
      .filter((j) => cyclingExcess(j, cyclingLimit) === 0)
      .sort((a, b) => compare(a, b, state.request?.timing ?? "now"))[0];
    const recommendedID = recommended?.id;
    this.workspace.setText(
      "map-preview-heading",
      !j
        ? "Routensuche"
        : this.example
          ? "Beispielroute"
          : state.restored
            ? "Gespeicherte Route"
            : j && cyclingExcess(j, cyclingLimit) > 0
              ? "Fahrradvergleich"
              : j?.id === recommendedID
                ? recommendation
                : "Ausgewählte Verbindung",
    );
    this.workspace.setHidden("saved-notice", !state.restored);
    if (state.restored)
      this.workspace.setText(
        "saved-notice",
        `Gespeicherter Stand: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}. Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`,
      );
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
      if (sheetClosed) {
        this.focusSheetTrigger();
        this.onSheetChange?.("close");
      }
      return;
    }
    this.key = key;
    const active = document.activeElement as HTMLElement;
    const focused = active?.dataset.journey;
    const focusedDetail = active?.dataset.detailJourney;
    stopMotionWithin(el("choices"));
    flushSync(() =>
      this.workspace.updateChoices({
        journeys: structuredClone(state.journeys),
        selectedId: j?.id,
        recommendedId: recommendedID,
        recommendation,
        restored: state.restored,
        cyclingLimit,
        example: this.example,
        inSheet: !!this.navigation.sheet,
        select: (journey) => this.chooseJourney(journey),
        details: (journey) => this.showJourneyDetails(journey),
      }),
    );
    if (j) {
      const detailJourney =
        state.journeys.find(
          (journey) => journey.id === this.navigation.sheet?.journeyId,
        ) ?? j;
      this.renderDetailContent(detailJourney, state.restored);
      flushSync(() =>
        this.workspace.updateSummary({
          journey: structuredClone(j),
          cyclingLimit,
          example: this.example,
        }),
      );
    } else {
      this.renderedDetailKey = "";
      flushSync(() => {
        this.workspace.updateDetail();
        this.workspace.updateSummary();
      });
    }
    this.workspace.setDisabled("map-open-details", !j);
    this.applyLayout();
    this.restorePosition();
    if (firstResults) reveal(el("choices"), { y: 10 });
    if (
      firstResults &&
      !this.desktop.matches &&
      !el("map-view").hidden &&
      !document.querySelector("dialog[open]") &&
      (active === document.body ||
        active === el("result-context") ||
        active === el("map-preview-heading") ||
        active.closest("#search-preview") ||
        !active.getClientRects().length)
    )
      this.focusSelection();
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
    if (sheetClosed) {
      this.focusSheetTrigger();
      this.onSheetChange?.("close");
    }
  }

  private chooseJourney(journey: Journey) {
    const fromSheet = !!this.navigation.sheet;
    this.savePosition();
    const changed = journey.id !== this.displayedID;
    this.select(journey.id);
    if (fromSheet) {
      this.closeSheet();
      return;
    }
    if (changed) {
      const row = el("choices").querySelector<HTMLElement>(
        ".route-choice-row.selected",
      );
      if (row)
        reveal(row, {
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
  }
  private showJourneyDetails(journey: Journey) {
    if (this.navigation.sheet) {
      this.previewAlternative(journey.id);
      return;
    }
    if (this.desktop.matches) {
      this.onDetailsOpened?.();
      el("journey-heading").focus({ preventScroll: true });
      this.detailPanel.scrollIntoView({ block: "nearest" });
      reveal(el("journey-detail"), { y: 8 });
    } else this.openDetails();
  }

  private renderDetailContent(j: Journey, restored: boolean) {
    const key = JSON.stringify([j, restored]);
    if (key === this.renderedDetailKey) return;
    this.renderedDetailKey = key;
    this.details(j, restored);
    this.workspace.setText(
      "journey-heading",
      this.example
        ? `${duration(j.arrival - j.departure)} gesamt`
        : `${journeyTimeRange(j)} · ${duration(j.arrival - j.departure)}`,
    );
    const effort = journeyEffort(j);
    this.workspace.setText(
      "journey-effort",
      `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`,
    );
  }
  private details(j: Journey, restored: boolean) {
    flushSync(() =>
      this.workspace.updateDetail({
        journey: structuredClone(j),
        restored,
        options: { presentation: this.presentation },
        distance: `${(bikeDistance(j) / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km Rad`,
      }),
    );
  }
}
