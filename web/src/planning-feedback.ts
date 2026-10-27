import type { PlanningState } from "./planning-state";
import { planningProgress, planningRequestPreview } from "./planning-progress";
import { el } from "./ui";
import { rateLimitMessage } from "./model";
import { RetryCountdown } from "./retry-countdown";

export const planningReadyMessage = "Verbindungen gefunden";
export type PlanningToastStage = "searching" | "ready" | "optimizing" | "error";

/** Live status shares the toast channel and keeps the mobile map panel clear. */
export class PlanningFeedback {
  private readonly toastHome = el("toast").parentElement!;
  private announced = new Set<string>();
  private previousCalculation?: string;
  private wasOptimizing = false;
  private wasBusy = false;
  private searchSequence = 0;
  private searchingId = "";
  private readyId?: string;
  private state?: PlanningState;
  private frame?: number;
  private countdown = new RetryCountdown();

  constructor(
    private notify: (
      id: string,
      message: string,
      stage: PlanningToastStage,
    ) => boolean,
    private dismiss: () => void,
    private visible: () => boolean,
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
      el("toast"),
      document.querySelector<HTMLElement>(".panel-actions")!,
    ])
      observer.observe(element);
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
    this.moveToast(this.toastHome);
  }

  private moveToast(parent: HTMLElement) {
    const toast = el("toast");
    if (toast.parentElement === parent) return;
    const focused = toast.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    parent.prepend(toast);
    focused?.focus({ preventScroll: true });
  }

  releaseRecovery() {
    const recovery = el("planning-recovery");
    if (!recovery.dataset.planningToast) return;
    const focused = recovery.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    delete recovery.dataset.planningToast;
    this.showRecoveryIcon(false);
    // Hide completed actions before moving them into the scrollable results.
    // Otherwise scroll anchoring can capture their temporary inline height.
    recovery.hidden = !this.state?.recovery || !!this.state?.busy;
    const map =
      !matchMedia("(min-width: 900px)").matches &&
      el("map-view").dataset.resultScreen === "map";
    if (el<HTMLDialogElement>("alternatives-dialog").open)
      el("alternatives-body").prepend(recovery);
    else if (this.state && planningRequestPreview(this.state))
      el("search-preview-feedback").prepend(recovery);
    else el(map ? "map-preview-status" : "stale-notice").after(recovery);
    const message = this.state ? planningProgress(this.state).message : "";
    el("status").textContent = message;
    el("map-preview-status").textContent = message;
    el("map-preview-status").hidden = !message;
    focused?.focus({ preventScroll: true });
  }

  private attachRecovery() {
    const recovery = el("planning-recovery");
    if (recovery.parentElement === el("toast")) return;
    const focused = recovery.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    recovery.dataset.planningToast = "true";
    this.showRecoveryIcon(true);
    el("toast").append(recovery);
    el("status").textContent = "";
    el("map-preview-status").textContent = "";
    el("map-preview-status").hidden = true;
    focused?.focus({ preventScroll: true });
  }

  private showRecoveryIcon(show: boolean) {
    const button = el<HTMLButtonElement>("recover-planning");
    button.classList.toggle("icon-button", show);
    el("recovery-label").classList.toggle("sr-only", show);
    if (show) {
      button.setAttribute("aria-label", "Erneut versuchen");
      button.title = "Erneut versuchen";
    } else {
      button.removeAttribute("aria-label");
      button.removeAttribute("title");
    }
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
    this.countdown.clear();
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
        const label = el("toast").querySelector<HTMLElement>(
          ".planning-toast-message",
        );
        if (label && rateLimitMessage(state.failures))
          this.countdown.render(label, state.recovery?.retryAt ?? 0);
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
    const toast = el("toast");
    const desktop = matchMedia("(min-width: 900px)").matches;
    const mapElement = el("map-view");
    const mapScreen =
      !desktop &&
      !mapElement.hidden &&
      mapElement.dataset.resultScreen === "map";
    toast.toggleAttribute("data-map-toast", mapScreen);
    const planning = !!toast.dataset.planningId;
    if (el<HTMLDialogElement>("alternatives-dialog").open) {
      toast.removeAttribute("data-map-toast");
      this.moveToast(el("alternatives-feedback-slot"));
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
      if (slot.parentElement !== parent) {
        const focused = slot.contains(document.activeElement)
          ? (document.activeElement as HTMLElement)
          : undefined;
        el("status").before(slot);
        focused?.focus({ preventScroll: true });
      }
      this.moveToast(slot);
      return true;
    }
    this.restoreToast();
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
    toast.style.setProperty("--planning-toast-width", `${width}px`);
    if (mapScreen) {
      const top = Math.max(viewTop + 12, controls.top);
      const tabs = document
        .querySelector<HTMLElement>(".app-tabs")!
        .getBoundingClientRect();
      const bottom = Math.min(
        viewBottom - 8,
        (sidePanel ? tabs.top : panel.top) - 12,
      );
      toast.style.setProperty("--planning-toast-top", `${top}px`);
      toast.style.setProperty(
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
    toast.style.setProperty(
      "--planning-toast-left",
      `${center - toastWidth / 2}px`,
    );
    toast.style.setProperty("--planning-toast-top", `${top}px`);
    return true;
  }
}
