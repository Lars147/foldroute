import { appPresentation } from "./app-presentation";
import type { JourneyWorkspaceApi } from "./journey-workspace-presentation";
import type { PlanningState } from "./planning-state";
import { planningProgress, planningRequestPreview } from "./planning-progress";
import { el } from "./ui";
import { rateLimitMessage } from "./model";

export const planningReadyMessage = "Verbindungen gefunden";
export type PlanningToastStage = "searching" | "ready" | "optimizing" | "error";

/** Live status shares the toast channel and keeps the mobile map panel clear. */
export class PlanningFeedback {
  private announced = new Set<string>();
  private previousCalculation?: string;
  private wasOptimizing = false;
  private wasBusy = false;
  private searchSequence = 0;
  private searchingId = "";
  private readyId?: string;
  private state?: PlanningState;
  private frame?: number;

  constructor(
    private notify: (
      id: string,
      message: string,
      stage: PlanningToastStage,
    ) => boolean,
    private dismiss: () => void,
    private visible: () => boolean,
    private workspace: JourneyWorkspaceApi = appPresentation().workspace,
  ) {
    const schedule = () => {
      if (!this.visible()) {
        this.readyId = undefined;
        this.dismiss();
      }
      if (this.frame !== undefined) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        this.position();
      });
    };
    const observer = new ResizeObserver(schedule);
    for (const element of [
      el("map-view"),
      el("connection"),
      el("journey-panel"),
      el("map-controls"),
      el("result-header"),
      el("map-open-details"),
      document.querySelector<HTMLElement>(".panel-actions")!,
    ])
      observer.observe(element);
    let observedToast = el("toast");
    observer.observe(observedToast);
    this.workspace.subscribeStructure(() => {
      const current = el("toast");
      if (current === observedToast) return;
      observer.unobserve(observedToast);
      observedToast = current;
      observer.observe(current);
      schedule();
    });
    document.addEventListener("scroll", schedule, true);
    const visibilityChanged = () => {
      if (this.visible()) this.render();
      schedule();
    };
    window.addEventListener("resize", visibilityChanged);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    document.addEventListener("visibilitychange", visibilityChanged);
    new MutationObserver(visibilityChanged).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-view",
        "data-navigation",
        "data-result-screen",
        "open",
      ],
    });
  }

  update(state: PlanningState) {
    this.state = state;
    const progress = planningProgress(state);
    if (state.busy && !this.wasBusy)
      this.searchingId = `searching-${++this.searchSequence}`;
    this.wasBusy = state.busy;
    if (
      this.visible() &&
      progress.ready &&
      this.wasOptimizing &&
      this.previousCalculation === state.calculationId &&
      state.searchStatus === "complete"
    )
      el("planning-announcement").textContent =
        "Routenoptimierung abgeschlossen.";
    else if (
      this.previousCalculation !== state.calculationId ||
      !this.visible() ||
      !progress.ready
    )
      el("planning-announcement").textContent = "";
    this.previousCalculation = state.calculationId;
    this.wasOptimizing = progress.optimizing;
    this.render();
  }

  /** Resume live status after a transient toast expires; never replay a readiness notice. */
  resume() {
    this.readyId = undefined;
    this.render();
  }

  interrupt() {
    this.readyId = undefined;
    this.releaseRecovery();
    this.restoreToast();
  }

  restoreToast() {
    this.workspace.setToastPlacement("root");
  }
  releaseRecovery() {
    if (!el("planning-recovery").dataset.planningToast) return;
    const focused = document.activeElement?.id;
    this.workspace.setRecoveryToast(false);
    this.workspace.setAttribute(
      "planning-recovery",
      "data-planning-toast",
      undefined,
    );
    this.showRecoveryIcon(false);
    this.workspace.setHidden(
      "planning-recovery",
      !this.state?.recovery || !!this.state?.busy,
    );
    const message = this.state ? planningProgress(this.state).message : "";
    this.workspace.setText("status", message);
    this.workspace.setText("map-preview-status", message);
    this.workspace.setHidden("map-preview-status", !message);
    if (focused === "recover-planning")
      el(focused).focus({ preventScroll: true });
  }
  private attachRecovery() {
    const focused = document.activeElement?.id;
    this.workspace.setRecoveryToast(true);
    this.workspace.setAttribute(
      "planning-recovery",
      "data-planning-toast",
      "true",
    );
    this.showRecoveryIcon(true);
    this.workspace.setText("status", "");
    this.workspace.setText("map-preview-status", "");
    this.workspace.setHidden("map-preview-status", true);
    if (focused === "recover-planning")
      el(focused).focus({ preventScroll: true });
  }
  private showRecoveryIcon(show: boolean) {
    this.workspace.toggleClass("recover-planning", "icon-button", show);
    this.workspace.toggleClass("recovery-label", "sr-only", show);
    this.workspace.setAttribute(
      "recover-planning",
      "aria-label",
      show ? "Erneut versuchen" : undefined,
    );
    this.workspace.setAttribute(
      "recover-planning",
      "title",
      show ? "Erneut versuchen" : undefined,
    );
  }
  private render() {
    const slot = el("planning-feedback-slot");
    const panel = el("journey-panel");
    const inSheet = el<HTMLDialogElement>("alternatives-dialog").open;
    const container = inSheet
      ? el("alternatives-body")
      : panel.classList.contains("result-scroll-all")
        ? panel
        : el("panel-content");
    const anchor = el(el("panel-details").hidden ? "choices" : "panel-details");
    const preserve =
      !matchMedia("(min-width: 900px)").matches &&
      container.scrollTop > 0 &&
      (inSheet || slot.parentElement === el("panel-content"));
    const top = preserve ? anchor.getBoundingClientRect().top : undefined;
    this.renderStatus();
    // Keep the reading position when an inline message changes height or disappears.
    if (
      top !== undefined &&
      (inSheet || slot.parentElement === el("panel-content"))
    ) {
      const change = anchor.getBoundingClientRect().top - top;
      if (change) container.scrollTop += change;
    }
  }

  private renderStatus() {
    this.workspace.setToastRetryAt(0);
    if (!this.state) return;
    const state = this.state;
    const progress = planningProgress(state);
    const id = state.calculationId;
    const desktop = matchMedia("(min-width: 900px)").matches;
    const firstReady = progress.ready && !!id && !this.announced.has(id);
    if (firstReady) {
      this.announced.add(id!);
      if (this.announced.size > 32)
        this.announced.delete(this.announced.values().next().value!);
    }
    if (!this.visible() || (!progress.ready && !progress.loading)) {
      this.readyId = undefined;
      this.dismiss();
      return;
    }
    if (firstReady && !desktop)
      el("planning-announcement").textContent = planningReadyMessage;
    if (progress.loading) {
      this.readyId = undefined;
      if (planningRequestPreview(state)) this.dismiss();
      else this.notify(this.searchingId, state.message, "searching");
    } else if (state.searchStatus === "partial") {
      this.readyId = undefined;
      if (this.notify(id!, progress.message, "error")) {
        this.attachRecovery();
        if (rateLimitMessage(state.failures))
          this.workspace.setToastRetryAt(state.recovery?.retryAt ?? 0);
      }
    } else {
      if (
        firstReady &&
        desktop &&
        this.notify(id!, planningReadyMessage, "ready")
      )
        this.readyId = id;
      const toast = el("toast");
      const showingReady =
        desktop &&
        this.readyId === id &&
        !toast.hidden &&
        toast.dataset.planningId === id &&
        toast.dataset.planningStage === "ready";
      if (!showingReady) {
        this.readyId = undefined;
        if (progress.optimizing)
          this.notify(id!, "Routenoptimierung läuft …", "optimizing");
        else this.dismiss();
      }
    }
    this.position();
  }

  position(): boolean {
    let toast = el("toast");
    const desktop = matchMedia("(min-width: 900px)").matches;
    const mapElement = el("map-view");
    const mapScreen =
      !desktop &&
      !mapElement.hidden &&
      mapElement.dataset.resultScreen === "map";
    this.workspace.setToastMap(mapScreen);
    const planning = !!toast.dataset.planningId;
    if (el<HTMLDialogElement>("alternatives-dialog").open) {
      this.workspace.setToastMap(false);
      this.workspace.setToastPlacement("sheet");
      return true;
    }
    if (toast.parentElement === el("alternatives-feedback-slot"))
      this.restoreToast();
    if (toast.hidden || (!planning && !mapScreen)) return true;
    if (planning && !this.visible()) {
      this.dismiss();
      return false;
    }
    if (
      !desktop &&
      !mapScreen &&
      this.state &&
      planningProgress(this.state).ready
    ) {
      const slot = el("planning-feedback-slot");
      const parent = el("panel-content");
      this.workspace.setToastPlacement("inline");
      return true;
    }
    this.restoreToast();
    toast = el("toast");
    const viewport = window.visualViewport;
    const viewLeft = viewport?.offsetLeft ?? 0;
    const viewTop = viewport?.offsetTop ?? 0;
    const viewRight = viewLeft + (viewport?.width ?? innerWidth);
    const viewBottom = viewTop + (viewport?.height ?? innerHeight);
    const map = mapElement.getBoundingClientRect();
    const panel = el("journey-panel").getBoundingClientRect();
    const controls = el("map-controls").getBoundingClientRect();
    const mapStyle = getComputedStyle(mapElement);
    const sidePanel =
      mapScreen &&
      mapStyle.getPropertyValue("--map-panel-layout").trim() === "side";
    const left =
      desktop || sidePanel
        ? Math.max(viewLeft, panel.right) + 12
        : Math.max(
            viewLeft,
            map.left + (mapScreen ? parseFloat(mapStyle.paddingLeft) : 0),
          ) + 16;
    const right =
      desktop || mapScreen
        ? Math.min(viewRight, controls.left) - 12
        : viewRight - 16;
    const center = mapScreen
      ? ((sidePanel ? Math.max(viewLeft, panel.right) : viewLeft) + viewRight) /
        2
      : (left + right) / 2;
    // Reserve equal space on both sides so the controls limit width, not alignment.
    const width = Math.max(0, 2 * Math.min(center - left, right - center));
    this.workspace.setToastStyle("--planning-toast-width", `${width}px`);
    if (mapScreen) {
      const top = Math.max(viewTop + 12, controls.top);
      const tabs = document
        .querySelector<HTMLElement>(".app-tabs")!
        .getBoundingClientRect();
      const bottom = Math.min(
        viewBottom - 8,
        (sidePanel ? tabs.top : panel.top) - 12,
      );
      this.workspace.setToastStyle("--planning-toast-top", `${top}px`);
      this.workspace.setToastStyle(
        "--map-toast-height",
        `${Math.max(0, bottom - top)}px`,
      );
    }
    const height = toast.getBoundingClientRect().height;
    let top = mapScreen
      ? Math.max(viewTop + 12, controls.top)
      : Math.max(map.top, viewTop) + 12;
    if (!desktop && !mapScreen) {
      const action = document.querySelector<HTMLElement>(".panel-actions")!;
      const bounds = action.getBoundingClientRect();
      const tabs = document
        .querySelector<HTMLElement>(".app-tabs")!
        .getBoundingClientRect();
      const bottom = Math.min(viewBottom, tabs.top);
      const anchor =
        bounds.height > 0 && bounds.bottom > viewTop && bounds.top < bottom
          ? bounds.top
          : bottom;
      top = anchor - height - 12;
    }
    if (width < 120 || top < viewTop + 8 || top + height > viewBottom - 8) {
      this.dismiss();
      return false;
    }
    const toastWidth = toast.getBoundingClientRect().width;
    this.workspace.setToastStyle(
      "--planning-toast-left",
      `${center - toastWidth / 2}px`,
    );
    this.workspace.setToastStyle("--planning-toast-top", `${top}px`);
    return true;
  }
}
