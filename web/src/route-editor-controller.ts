import { flushSync } from "svelte";
import { appPresentation } from "./app-presentation";
import { PlaceSearch, locate } from "./search";
import { TimePicker, parseLocalMinute, timeSummary } from "./time-picker";
import { StopEditor } from "./stop-editor";
import { PlannerActions } from "./planner-actions";
import { el, localDate, dateLabel, clock, setLocationFeedback } from "./ui";
import { reveal, stopMotionWithin } from "./motion";
import {
  errorText,
  type Place,
  type Timing,
  type RouteStop,
  type RouteRequest,
} from "./model";
import type { ApiClient } from "./transitous";
import type { PlaceBook } from "./places";
import type { PlanningState } from "./planning-state";
interface EditorContext {
  origin?: Place;
  stops: RouteStop[];
  timing: Timing;
  time: number;
}
interface RouteEditorDependencies {
  presentation?: { setExpanded(value: boolean): void };
  api: ApiClient;
  book: PlaceBook;
  notify(message: string): void;
  context(): EditorContext;
  planningState(): PlanningState;
  view(): string;
  historyPosition(): number;
  show(view: "search" | "map", push?: boolean): unknown;
  writeHistory(push?: boolean): void;
  cancelNavigationCheck(): void;
  cancelMapCenter(): void;
  changed(): void;
  start(place: Place): Promise<void>;
  homeFocusTarget(): HTMLElement;
}
export class RouteEditorController {
  private readonly events = new AbortController();
  private disposed = false;

  readonly destination: PlaceSearch;
  readonly draftOrigin: PlaceSearch;
  readonly stopEditor: StopEditor;
  readonly plannerActions: PlannerActions;
  readonly timePicker: TimePicker;
  useLocation = true;
  adjustMode: "context" | "replan" = "context";
  editorExpanded = false;
  editorInitialized = false;
  editorReturnPosition?: number;
  draftLocationRequest?: AbortController;
  private draftLocationMessage =
    "Standort wird ermittelt … Bitte Zugriff erlauben, falls danach gefragt wird.";
  private editorScrollFrame?: number;
  private routeConnectionObserver: ResizeObserver;
  private view: { setExpanded(value: boolean): void };
  private unsubscribeBook: () => void;
  private unmountView: () => void;
  private readonly dialog = el<HTMLDialogElement>("time-dialog");
  private get originOverride() {
    return this.dependencies.context().origin;
  }
  private get stops() {
    return this.dependencies.context().stops;
  }
  private get timing() {
    return this.dependencies.context().timing;
  }
  private get time() {
    return this.dependencies.context().time;
  }
  private element = el;
  constructor(private dependencies: RouteEditorDependencies) {
    this.view = dependencies.presentation ?? appPresentation().editor;
    this.unmountView = () => {};
    this.destination = new PlaceSearch(
      "destination",
      this.dependencies.api,
      el("place-status"),
      (place) => {
        this.destination.input.blur();
        if (!this.editorExpanded && this.adjustMode !== "replan")
          void this.dependencies.start(place);
      },
      this.dependencies.book,
      this.dependencies.notify,
      {
        showCurrentLocation: false,
        getSearchCenter: () => {
          const origin = this.editorInitialized
            ? this.useLocation
              ? undefined
              : this.draftOrigin.value
            : this.originOverride;
          return origin?.name === "Aktueller Standort" ? undefined : origin;
        },
        onDismiss: () => {
          if (
            this.dependencies.view() !== "search" ||
            this.editorExpanded ||
            this.adjustMode === "replan"
          )
            return;
          el("place-status").textContent = "";
          this.destination.activate();
          this.updateSearchEmpty();
          this.dependencies.homeFocusTarget().focus({ preventScroll: true });
        },
      },
    );
    this.draftOrigin = new PlaceSearch(
      "origin",
      this.dependencies.api,
      el("adjust-status"),
      (place) => {
        this.cancelDraftLocation();
        this.useLocation = place.name === "Aktueller Standort";
        this.keepEditorFieldVisible();
      },
      this.dependencies.book,
      this.dependencies.notify,
      { focusDriven: true },
    );
    this.stopEditor = new StopEditor(
      this.dependencies.api,
      this.dependencies.book,
      this.dependencies.notify,
    );
    this.plannerActions = new PlannerActions(
      () => {
        this.destination.cancel();
        this.draftOrigin.cancel();
        this.stopEditor.cancel();
      },
      () => this.stopEditor.add(),
    );
    el("search-adjust").addEventListener(
      "click",
      () => {
        if (this.editorExpanded) {
          this.setEditorExpanded(false);
          this.dependencies.writeHistory();
          el("search-adjust").focus({ preventScroll: true });
        } else this.openAdjust("context");
      },
      { signal: this.events.signal },
    );
    el("adjust-route").addEventListener(
      "click",
      () => this.openAdjust("replan"),
      { signal: this.events.signal },
    );
    el("cancel-adjust").addEventListener("click", this.closeAdjust, {
      signal: this.events.signal,
    });
    el("route-form").addEventListener(
      "input",
      () => {
        el("adjust-status").querySelector(".location-help")?.remove();
      },
      { signal: this.events.signal },
    );
    el("route-form").addEventListener("focusout", this.editorSummary, {
      signal: this.events.signal,
    });
    el("search-view").addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          (this.editorExpanded || this.adjustMode === "replan")
        ) {
          event.preventDefault();
          this.closeAdjust();
        }
      },
      { signal: this.events.signal },
    );
    el("origin-location").addEventListener(
      "click",
      async () => {
        this.cancelDraftLocation();
        const controller = new AbortController();
        this.draftLocationRequest = controller;
        this.useLocation = true;
        this.draftOrigin.set();
        this.draftOrigin.input.value = "Aktueller Standort";
        el<HTMLButtonElement>("origin-location").disabled = true;
        el("adjust-status").textContent = this.draftLocationMessage;
        try {
          const place = await locate(controller.signal);
          if (!controller.signal.aborted) {
            this.draftOrigin.set(place);
            el("adjust-status").textContent = "";
            el("adjust-location-announcement").textContent =
              "Standort ermittelt";
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setLocationFeedback(
              el("adjust-status"),
              errorText(error),
              true,
              "adjust-location-help",
            );
          }
        } finally {
          if (this.draftLocationRequest === controller) {
            this.draftLocationRequest = undefined;
            el<HTMLButtonElement>("origin-location").disabled = false;
            this.dependencies.changed();
          }
        }
      },
      { signal: this.events.signal },
    );
    this.draftOrigin.input.addEventListener(
      "input",
      () => {
        this.cancelDraftLocation();
        this.useLocation = false;
      },
      { signal: this.events.signal },
    );
    el("swap").addEventListener(
      "click",
      () => {
        if (!this.draftOrigin.value || !this.destination.value) {
          el("adjust-status").textContent =
            "Zum Tauschen beide Orte auswählen.";
          return;
        }
        this.stopEditor.reverse();
        const origin = this.draftOrigin.value;
        this.draftOrigin.set(this.destination.value);
        this.destination.set(origin);
        this.useLocation =
          this.draftOrigin.value?.name === "Aktueller Standort";
      },
      { signal: this.events.signal },
    );
    el("route-form").addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();
        this.cancelEditorSearches();
        if (!this.destination.value) {
          el("place-status").textContent =
            "Bitte Ziel aus den Vorschlägen auswählen.";
          this.destination.input.focus();
          return;
        }
        if (!this.editorInitialized) this.initializeEditor();
        const target = this.destination.value;
        await this.dependencies.start(target);
      },
      { signal: this.events.signal },
    );
    this.timePicker = new TimePicker(this.updateTiming);
    this.destination.input.addEventListener("input", this.updateSearchEmpty, {
      signal: this.events.signal,
    });
    this.unsubscribeBook = this.dependencies.book.subscribe(
      this.updateSearchEmpty,
    );
    this.routeConnectionObserver = new ResizeObserver(
      this.updateRouteConnection,
    );
    for (const selector of [
      ".route-places-frame",
      ".route-editor-origin",
      "#route-editor-destination",
      "#via-fields",
      "#destination-field",
    ])
      this.routeConnectionObserver.observe(document.querySelector(selector)!);
    this.element("route-form").addEventListener(
      "focusin",
      this.keepEditorFieldVisible,
      { signal: this.events.signal },
    );
    window.visualViewport?.addEventListener(
      "resize",
      this.visualViewportChanged,
      { signal: this.events.signal },
    );
    window.visualViewport?.addEventListener(
      "scroll",
      this.visualViewportChanged,
      { signal: this.events.signal },
    );
    window.addEventListener("resize", this.visualViewportChanged, {
      signal: this.events.signal,
    });
    this.visualViewportChanged();
  }
  updateSearchEmpty = () => {
    el("search-empty").hidden =
      this.destination.input.value.trim().length > 0 ||
      this.dependencies.book.entries.length > 0;
  };
  cancelDraftLocation = () => {
    if (
      this.draftLocationRequest &&
      el("adjust-status").textContent === this.draftLocationMessage
    )
      el("adjust-status").textContent = "";
    this.draftLocationRequest?.abort();
    this.draftLocationRequest = undefined;
    el("adjust-location-announcement").textContent = "";
    el<HTMLButtonElement>("origin-location").disabled = false;
  };
  contextUI = () => {
    el("search-context").textContent =
      `${this.originOverride?.name ?? "Aktueller Standort"}${this.stops.length ? ` · ${this.stops.length} Zwischenziel${this.stops.length > 1 ? "e" : ""}` : ""} · ${this.timing === "now" ? "Jetzt" : `${this.timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(this.time)}, ${clock(this.time)}`}`;
  };
  cancelEditorSearches = () => {
    this.plannerActions.close();
    this.cancelDraftLocation();
    this.destination.cancel();
    this.draftOrigin.cancel();
    this.stopEditor.cancel();
  };
  initializeEditor = (request?: RouteRequest, target?: Place) => {
    if (this.disposed) return;
    this.cancelEditorSearches();
    this.stopEditor.set(
      structuredClone(request ? (request.stops ?? []) : this.stops),
    );
    this.draftOrigin.set(request?.origin ?? this.originOverride);
    this.useLocation =
      !this.draftOrigin.value ||
      this.draftOrigin.value.name === "Aktueller Standort";
    if (this.useLocation && !this.draftOrigin.value)
      this.draftOrigin.input.value = "Aktueller Standort";
    if (target ?? request?.destination)
      this.destination.set(target ?? request?.destination);
    const resolved =
      request &&
      (this.dependencies.planningState().pendingRequest
        ? this.dependencies.planningState().pendingRequestResolved === true
        : !!this.dependencies.planningState().selected);
    const requestedTiming = request?.timing ?? this.timing;
    el<HTMLInputElement>("timing").value =
      requestedTiming === "now" && resolved ? "depart" : requestedTiming;
    el<HTMLInputElement>("when").value = localDate(
      new Date(
        (requestedTiming === "now" && !resolved
          ? Date.now() / 1000
          : (request?.time ?? this.time)) * 1000,
      ),
    );
    this.editorInitialized = true;
    this.updateTiming();
    el("adjust-status").textContent = "";
    el("adjust-location-announcement").textContent = "";
  };
  editorSummary = () => {
    if (!this.editorInitialized) return;
    const count = this.stopEditor.count;
    el("search-context").textContent = [
      this.draftOrigin.value?.name ??
        (this.useLocation ? "Aktueller Standort" : "Start wählen"),
      ...(count ? [`${count} Zwischenziel${count > 1 ? "e" : ""}`] : []),
      timeSummary(
        el<HTMLInputElement>("timing").value as Timing,
        el<HTMLInputElement>("when").value,
      ),
    ].join(" · ");
  };
  resetEditor = () => {
    this.adjustMode = "context";
    this.editorInitialized = false;
    this.editorReturnPosition = undefined;
    this.setEditorExpanded(false);
  };
  setEditorExpanded = (expanded: boolean) => {
    if (this.disposed) return;
    this.cancelEditorSearches();
    this.editorExpanded = expanded;
    const targetField = el("destination-field");
    flushSync(() => this.view.setExpanded(expanded));
    el("swap").hidden = !expanded;
    targetField.querySelector<HTMLElement>(".destination-marker")!.hidden =
      !expanded;
    this.destination.input.placeholder = expanded
      ? "Ziel wählen"
      : "Adresse, Ort oder Haltestelle";
    el("route-editor").dataset.mode = this.adjustMode;
    el("search-view").dataset.editorMode = this.adjustMode;
    el("search-adjust").setAttribute("aria-expanded", String(expanded));
    el("planning-actions").hidden = !expanded && this.adjustMode !== "replan";
    el("cancel-adjust").hidden = this.adjustMode !== "replan";
    el("calculate").textContent =
      this.adjustMode === "replan" ? "Route neu berechnen" : "Route berechnen";
    el("search-heading").textContent =
      this.adjustMode === "replan" ? "Route anpassen" : "Wohin geht’s?";
    el("home-places").hidden = expanded || this.adjustMode === "replan";
    this.destination.setFocusDriven(expanded || this.adjustMode === "replan");
    this.editorSummary();
    if (
      !expanded &&
      this.adjustMode !== "replan" &&
      this.dependencies.view() === "search"
    ) {
      this.destination.activate();
      this.updateSearchEmpty();
    }
    if (expanded)
      reveal(document.querySelector<HTMLElement>(".route-editor-frame")!, {
        y: 8,
      });
    this.dependencies.changed();
  };
  openAdjust = (mode: "context" | "replan", target?: Place) => {
    this.dependencies.cancelNavigationCheck();
    if (mode === "replan") {
      this.editorReturnPosition = this.dependencies.historyPosition();
      this.adjustMode = "replan";
      this.initializeEditor(
        structuredClone(
          this.dependencies.planningState().pendingRequest ??
            this.dependencies.planningState().request,
        ),
        target,
      );
    } else if (!this.editorInitialized) this.initializeEditor();
    this.setEditorExpanded(true);
    this.dependencies.show("search", false);
    this.dependencies.writeHistory(
      mode === "replan" || !history.state?.routeEditor,
    );
    el(mode === "replan" ? "search-heading" : "search-adjust").focus({
      preventScroll: true,
    });
    this.dependencies.cancelMapCenter();
  };
  closeAdjust = () => {
    this.cancelEditorSearches();
    if (this.adjustMode === "replan") {
      if (
        this.editorReturnPosition !== undefined &&
        this.editorReturnPosition < this.dependencies.historyPosition()
      ) {
        history.go(
          this.editorReturnPosition - this.dependencies.historyPosition(),
        );
        return;
      }
      this.adjustMode = "context";
      this.editorInitialized = false;
      this.editorReturnPosition = undefined;
      this.setEditorExpanded(false);
      this.dependencies.show("map", false);
      this.dependencies.writeHistory();
      el("adjust-route").focus({ preventScroll: true });
    } else {
      this.setEditorExpanded(false);
      this.dependencies.writeHistory();
      el("search-adjust").focus({ preventScroll: true });
    }
  };
  updateTiming = () => {
    el("time-summary").textContent = timeSummary(
      el<HTMLInputElement>("timing").value as Timing,
      el<HTMLInputElement>("when").value,
    );
    this.editorSummary();
  };
  readContext = () => {
    this.cancelDraftLocation();
    if (!this.useLocation && !this.draftOrigin.value) {
      el("adjust-status").textContent =
        "Bitte Start aus den Vorschlägen auswählen.";
      this.draftOrigin.input.focus();
      return;
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
      el("adjust-status").textContent =
        "Bitte einen gültigen Zeitpunkt wählen.";
      el("time-trigger").focus();
      return;
    }
    const draftStops = this.stopEditor.read();
    if (!draftStops) return;
    return {
      origin: this.useLocation ? undefined : this.draftOrigin.value,
      stops: draftStops,
      timing: selectedTiming,
      time: seconds,
    };
  };
  validateEditor = () => {
    const context = this.readContext();
    if (context) return context;
    // Hidden fields cannot receive focus. Reveal them before reporting the error.
    this.setEditorExpanded(true);
    this.readContext();
  };
  updateRouteConnection = () => {
    if (this.disposed) return;
    const field = el("destination-field");
    el("route-form").style.setProperty(
      "--destination-height",
      `${field.getBoundingClientRect().height}px`,
    );
    const card = document.querySelector<HTMLElement>(".route-places-frame")!;
    if (!this.editorExpanded || !card.getClientRects().length) return;
    const origin = el("origin-location").getBoundingClientRect();
    const target = document
      .querySelector<HTMLElement>(".destination-marker")!
      .getBoundingClientRect();
    const lineStart = origin.top + origin.height / 2;
    const end = target.top + target.height / 2;
    const connection =
      document.querySelector<HTMLElement>(".route-connection")!;
    connection.style.top = `${lineStart - card.getBoundingClientRect().top - card.clientTop}px`;
    connection.style.bottom = "auto";
    connection.style.height = `${Math.max(0, end - lineStart)}px`;
  };
  keepEditorFieldVisible = () => {
    if (this.disposed) return;
    if (document.body.classList.contains("search-focus-mode")) return;
    if (this.editorScrollFrame !== undefined)
      cancelAnimationFrame(this.editorScrollFrame);
    this.editorScrollFrame = requestAnimationFrame(() => {
      this.editorScrollFrame = undefined;
      const field = document.activeElement;
      const body = document.querySelector<HTMLElement>(".search-content")!;
      if (
        this.dependencies.view() !== "search" ||
        !this.editorExpanded ||
        !(
          field instanceof HTMLInputElement ||
          field instanceof HTMLSelectElement
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
  };
  visualViewportChanged = () => {
    if (this.disposed) return;
    el("search-view").classList.toggle(
      "compact",
      (window.visualViewport?.height ?? innerHeight) < 700,
    );
    document.documentElement.style.setProperty(
      "--visual-width",
      `${window.visualViewport?.width ?? innerWidth}px`,
    );
    document.documentElement.style.setProperty(
      "--visual-left",
      `${window.visualViewport?.offsetLeft ?? 0}px`,
    );
    this.dialog.classList.toggle(
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
    this.keepEditorFieldVisible();
  };
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelEditorSearches();
    this.events.abort();
    this.routeConnectionObserver.disconnect();
    this.unsubscribeBook();
    this.destination.dispose();
    this.draftOrigin.dispose();
    this.stopEditor.dispose();
    this.plannerActions.dispose();
    this.timePicker.dispose();
    if (this.editorScrollFrame !== undefined)
      cancelAnimationFrame(this.editorScrollFrame);
    stopMotionWithin(el("route-editor-host"));
    this.unmountView();
  }
}
