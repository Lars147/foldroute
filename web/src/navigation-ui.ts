import { appPresentation } from "./app-presentation";
import type { AppPresentation } from "./app-presentation";
import { flushSync } from "svelte";
import type {
  NavigationCompletionModel,
  NavigationFinishSummary,
  NavigationScreenApi,
} from "./navigation-presentation";
import { supportProviders } from "./project-support";
import { UndoNotice } from "./undo-notice";
import { CountdownBar } from "./countdown-bar";
import { CountdownInteraction } from "./countdown-interaction";
import type { NavigationSession } from "./navigation-session";
import {
  reveal,
  resizeHeight,
  settle,
  stopMotion,
  stopMotionWithin,
  motionTime,
} from "./motion";
import type { NavigationMap } from "./navigation-map";
import { NavigationPositionTracker } from "./navigation-position";
import { NavigationCompletion } from "./navigation-completion";
import { NavigationGuidance } from "./navigation-guidance";
import { NavigationStations } from "./navigation-stations";
import { clock, duration, el, node, icon, setLocationFeedback } from "./ui";
import { compare, cyclingExcess, type Leg } from "./model";
import { transitCancellationMessage } from "./transit-cancellation";
import { movement, freshTransit } from "./navigation-engine";
import {
  TransitTimeline,
  TransitPath,
  StationMotion,
  stationCursor,
  type StationCursor,
  type TransitEstimate,
  type TransitEstimateSource,
} from "./navigation-estimate";
import { detailTime } from "./journey-detail";
import { closeMapStylePickers } from "./map-style-picker";
import {
  navigationSections,
  sectionLabel,
  type NavigationSection,
} from "./navigation-sections";

const transitStatus = (transit: Leg) =>
  `${transit.transitStatus?.cancelled ? transitCancellationMessage(transit) : transit.transitStatus?.failure === "network" ? "Abruf fehlgeschlagen" : transit.transitStatus?.failure === "unavailable" ? "Aktualisierung nicht verfügbar" : !freshTransit(transit, Date.now() / 1000) ? "Fahrtdaten veraltet" : transit.realtime ? "Echtzeit" : "Fahrplan"}${transit.transitStatus?.updatedAt ? ` · Stand ${clock(transit.transitStatus.updatedAt)}` : ""}`;
const transitWarning = (transit?: Leg) =>
  transit && !freshTransit(transit, Date.now() / 1000)
    ? transit.transitStatus?.cancelled
      ? `${transit.line || "ÖPNV"}: ${transitCancellationMessage(transit)}.`
      : `${transit.line || "ÖPNV"} · ${transitStatus(transit)}`
    : "";

interface NavigationNotice {
  message: string;
  target: string;
}

export class NavigationView {
  readonly root: HTMLElement;
  private screen: NavigationScreenApi;
  private summaryProviders: NavigationFinishSummary["providers"] = [];
  private destroyScreen: () => Promise<void>;
  private events = new AbortController();
  private undoPositionObserver?: ResizeObserver;
  private map?: NavigationMap;
  private positionTracker = new NavigationPositionTracker();
  private completion = new NavigationCompletion();
  private quickCompletionAvailable = false;
  private finishedMap?: NavigationMap;
  private stationLists: NavigationStations[];
  private loading?: Promise<void>;
  private session?: NavigationSession;
  private voiceMessage = "";
  private phaseKey = "";
  private mobile = matchMedia("(max-width: 899px)");
  private detailsOpen = false;
  private noticeTarget?: string;
  private sections: NavigationSection[] = [];
  private selectedSectionId?: string;
  private followsCurrentSection = true;
  private currentSectionId?: string;
  private tabsKey = "";
  private sectionDetailKey = "";
  private timelineKey = "";
  private timeline?: TransitTimeline;
  private transitPath?: TransitPath;
  private stationMotion = new StationMotion();
  private stationSample?: (wall: number) => StationCursor;
  private stationCursor?: StationCursor;
  private stationPresentationKey = "";
  private stationFrame?: number;
  private stationWakeup?: ReturnType<typeof setTimeout>;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private dragY?: number;
  private confirmationTrigger?: HTMLElement;
  private alternativeTrigger?: HTMLElement;
  private alternativeSeenId?: string;
  private alternativeSelectedId?: string;
  private alternativeDetailId?: string;
  private alternativeListScroll = 0;
  private undoNotice: UndoNotice;
  private automaticCountdownBar = new CountdownBar(1000);
  private countdownInteraction: CountdownInteraction;
  private shownUndo?: object;
  private lastCompletionAt = -Infinity;
  private guidance = new NavigationGuidance((message) => {
    this.voiceMessage = message;
    this.screen.setText("navigation-audio-status", message);
  });
  constructor(
    private exit: () => void,
    private restart: (replan: boolean) => void,
    private options: {
      audioEnabled?: boolean;
      locationAutoRefresh?: () => boolean;
      presentation?: Pick<
        AppPresentation,
        "navigation" | "configureNavigation"
      >;
    } = {},
  ) {
    if (options.audioEnabled !== undefined)
      this.guidance.enabled = options.audioEnabled;
    const presentation = options.presentation ?? appPresentation();
    this.screen = presentation.navigation;
    presentation.configureNavigation({
      selectSection: (id) => this.selectSection(id),
      phaseKeydown: (event) => this.phaseKeydown(event),
      endNavigation: () => this.confirmEnd(),
    });
    this.destroyScreen = async () => {};
    flushSync();
    this.root = this.screen.element();
    el("navigation-auto-countdown-host").append(
      this.automaticCountdownBar.element,
    );
    this.countdownInteraction = new CountdownInteraction(
      [el("navigation-auto-complete"), el("navigation-complete")],
      (paused) => {
        this.session?.setCompletionPaused(paused);
        this.render();
      },
    );
    this.undoNotice = new UndoNotice(
      el("navigation-undo"),
      el<HTMLButtonElement>("navigation-undo-button"),
    );
    el("navigation-auto-cancel").onclick = () => {
      this.session?.cancelCompletionCountdown();
      this.screen.setText(
        "navigation-auto-announcement",
        "Automatischer Wechsel abgebrochen. Abschnitt manuell abschließen.",
      );
      this.render();
    };
    const positionUndo = () => {
      if (!this.visible) return;
      const panel = el("navigation-panel");
      el("navigation-undo").style.bottom =
        `${this.root.clientHeight - panel.offsetTop + 12}px`;
      el("navigation-auto-complete").style.bottom =
        `${this.root.clientHeight - panel.offsetTop + 12 + (el("navigation-undo").hidden ? 0 : el("navigation-undo").offsetHeight + 8)}px`;
    };
    const undoPositionObserver = (this.undoPositionObserver =
      new ResizeObserver(positionUndo));
    undoPositionObserver.observe(el("navigation-panel"));
    undoPositionObserver.observe(this.root);
    undoPositionObserver.observe(el("navigation-undo"));
    undoPositionObserver.observe(el("navigation-auto-complete"));
    this.stationLists = [
      new NavigationStations(el("navigation-stations-preview"), true),
      new NavigationStations(el("navigation-stations-detail")),
    ];
    document.addEventListener(
      "visibilitychange",
      () => {
        this.stopStationAnimation();
        if (document.hidden) this.positionTracker.interrupt();
        if (!document.hidden && this.visible) {
          this.stationMotion.reset();
          this.stationPresentationKey = "";
          this.render();
        }
      },
      { signal: this.events.signal },
    );
    this.reducedMotion.addEventListener(
      "change",
      () => {
        this.stopStationAnimation();
        if (this.visible) this.render();
      },
      { signal: this.events.signal },
    );
    const toggle = el("navigation-details-toggle");
    toggle.onclick = () => this.setDetails(!this.detailsOpen);
    toggle.onpointerdown = (event) => {
      this.dragY = event.clientY;
      toggle.setPointerCapture(event.pointerId);
    };
    toggle.onpointerup = (event) => {
      const delta = this.dragY === undefined ? 0 : event.clientY - this.dragY;
      this.dragY = undefined;
      if (Math.abs(delta) > 30) {
        this.setDetails(delta < 0);
        toggle.addEventListener(
          "click",
          (click) => click.stopImmediatePropagation(),
          { once: true, capture: true },
        );
      }
    };
    toggle.onpointercancel = () => {
      this.dragY = undefined;
    };
    toggle.onkeydown = (event) => {
      if (
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "Escape"
      )
        return;
      event.preventDefault();
      this.setDetails(event.key === "ArrowUp");
    };
    el("navigation-details").onkeydown = (event) => {
      if (event.key === "Escape" && this.mobile.matches) {
        event.preventDefault();
        this.setDetails(false);
      }
    };

    el("navigation-alert-open").onclick = () => this.openNotice();
    this.mobile.addEventListener(
      "change",
      () => {
        const focused = this.root.contains(document.activeElement)
          ? (document.activeElement as HTMLElement).id
          : undefined;
        const scrollLeft = el("navigation-phases").scrollLeft;
        stopMotion(el("navigation-panel"));
        this.render();
        el("navigation-phases").scrollLeft = scrollLeft;
        if (focused) {
          const target = document.getElementById(focused);
          if (
            target &&
            target.getClientRects().length &&
            !target.closest("[hidden], [inert]")
          )
            target.focus({ preventScroll: true });
        }
      },
      { signal: this.events.signal },
    );
    el("navigation-audio").onclick = () => {
      this.guidance.toggle();
      this.voiceMessage = "";
      if (
        this.session?.engine &&
        this.session.engine.guidanceUsable &&
        this.guidance.enabled
      )
        this.guidance.speak(
          `unmute-${Date.now()}`,
          this.session.engine.instruction,
        );
      this.render();
    };
    el("navigation-center").onclick = () => {
      this.followsCurrentSection = true;
      this.selectedSectionId = undefined;
      this.render();
      this.map?.center();
    };
    el("navigation-finish-close").onclick = () => this.exit();
    const retry = () => {
      if (!this.session?.engine) this.restart(false);
      else if (this.session.disruption)
        void this.session.proposeAlternative(
          this.session.engine.leg.kind === "stop" ? "stop" : undefined,
        );
      else if (this.session.engine.leg.kind === "stop")
        void this.session.continueStop();
      else if (
        movement(this.session.engine.leg) &&
        this.session.engine.offRoute
      )
        void this.session.retryStreet();
      else void this.session.reroute();
    };
    const completeSection = (event: MouseEvent, manual: boolean) => {
      if (event.detail > 1 || performance.now() - this.lastCompletionAt < 350)
        return;
      const engine = this.session?.engine;
      if (
        !engine ||
        !this.completionAvailable ||
        this.session?.busy ||
        (manual
          ? !movement(engine.leg) || this.quickCompletionAvailable
          : !this.quickCompletionAvailable)
      )
        return;
      if (engine.leg.kind === "stop") {
        void this.session!.continueStop();
        return;
      }
      if (this.session!.completeLeg(engine.leg.navigationId!))
        this.lastCompletionAt = performance.now();
    };
    this.screen.setCompletionCommands({
      complete: completeSection,
      retry,
      replan: () => this.restart(true),
    });
    el("navigation-accept").onclick = async () => {
      const expectedId = el("navigation-alternative").dataset.proposalId;
      if (!expectedId) return;
      const result = await this.session?.acceptAlternative(expectedId);
      if (result === "accepted") {
        this.selectedSectionId = undefined;
        this.followsCurrentSection = true;
        this.closeAlternative();
        if (this.detailsOpen) this.setDetails(false);
        else this.render();
        this.map?.center();
      } else this.render();
    };
    el("navigation-dismiss").onclick = () => {
      this.session?.dismissAlternative();
      this.closeAlternative();
    };
    el("navigation-alternative-locate").onclick = () => {
      void this.session?.retryLocation();
    };
    el("navigation-alternative-close").onclick = () => this.closeAlternative();
    el<HTMLDialogElement>("navigation-alternative").oncancel = (event) => {
      event.preventDefault();
      if (!this.backAlternativeDetails()) this.closeAlternative();
    };
  }
  private phaseKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.mobile.matches) {
      event.preventDefault();
      this.setDetails(false);
      return;
    }
    const tab = (event.target as Element).closest('[role="tab"]');
    const index = Array.from(el("navigation-phases").children).indexOf(tab!);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % this.sections.length
        : event.key === "ArrowLeft"
          ? (index + this.sections.length - 1) % this.sections.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? this.sections.length - 1
              : undefined;
    if (next === undefined || !this.sections[next]) return;
    event.preventDefault();
    this.selectSection(this.sections[next].id, true);
  }
  private setDetails(open: boolean) {
    if (open === this.detailsOpen) return;
    const panel = el("navigation-panel");
    const beforeHeight = panel.getBoundingClientRect().height;
    stopMotion(panel);
    this.detailsOpen = open;
    const details = el("navigation-details");
    const focusedTab = el("navigation-phases").contains(document.activeElement);
    if (!open && details.contains(document.activeElement))
      el("navigation-details-toggle").focus({ preventScroll: true });
    this.render();
    if (open) this.positionDetails();
    if (this.mobile.matches) {
      this.revealSelectedTab();
      resizeHeight(panel, beforeHeight);
    }
    if (!open) {
      const tab = this.selectedTab();
      if (focusedTab) tab?.focus({ preventScroll: true });
    }
  }
  private openNotice() {
    if (this.session?.alternative) {
      this.openAlternative();
      return;
    }
    this.setDetails(true);
    if (!this.noticeTarget) return;
    const details = el("navigation-details");
    const target = el(this.noticeTarget);
    details.scrollTop +=
      target.getBoundingClientRect().top -
      details.getBoundingClientRect().top -
      details.clientTop -
      16;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  private openAlternative() {
    this.alternativeTrigger = el("navigation-alert-open");
    this.alternativeSeenId = this.session?.alternatives
      .map((value) => value.id)
      .join(",");
    this.render();
    flushSync();
    const dialog = el<HTMLDialogElement>("navigation-alternative");
    if (!dialog.open) dialog.showModal();
    el("navigation-alternative-title").focus({ preventScroll: true });
  }
  private backAlternativeDetails() {
    if (!this.alternativeDetailId) return false;
    this.alternativeDetailId = undefined;
    this.render();
    flushSync();
    el("navigation-alternative").querySelector<HTMLElement>(
      ".alternative-content",
    )!.scrollTop = this.alternativeListScroll;
    el("navigation-alternative-title").focus({ preventScroll: true });
    return true;
  }
  private closeAlternative(restoreFocus = true) {
    const dialog = el<HTMLDialogElement>("navigation-alternative");
    if (!dialog.open) return false;
    dialog.close();
    flushSync();
    const trigger = this.alternativeTrigger;
    this.alternativeTrigger = undefined;
    this.alternativeSeenId = undefined;
    this.alternativeDetailId = undefined;
    if (restoreFocus && this.visible) {
      const target =
        trigger?.isConnected &&
        trigger.getClientRects().length &&
        !trigger.closest("[hidden], [inert]") &&
        (trigger.id !== "navigation-alert-open" || !!this.session?.alternative)
          ? trigger
          : el(
              this.session?.engine?.phase === "arrived"
                ? "navigation-finish-heading"
                : "navigation-instruction",
            );
      target.tabIndex = target.tabIndex < 0 ? -1 : target.tabIndex;
      target.focus({ preventScroll: true });
    }
    return true;
  }
  private get completionAvailable() {
    const engine = this.session?.engine;
    if (!engine || engine.phase !== "active") return false;
    return !!this.sections
      .find((section) => section.id === this.selectedSectionId)
      ?.legs.some((leg) => leg.navigationId === engine.leg.navigationId);
  }
  private positionDetails() {
    const details = el("navigation-details");
    details.scrollTop = 0;
    const engine = this.session?.engine;
    if (
      engine?.phase !== "active" ||
      engine.leg.kind !== "transit" ||
      this.selectedSectionId !== this.currentSectionId
    )
      return;
    const rail = el("navigation-stations-detail");
    if (rail.hidden) return;
    const passed = rail.querySelectorAll<HTMLElement>(
      '.navigation-station[data-state="passed"]',
    );
    const target =
      [...passed].at(-1) ??
      rail.querySelector<HTMLElement>(
        '.navigation-station:not([data-state="cancelled"])',
      );
    if (target)
      details.scrollTop = Math.max(
        0,
        target.getBoundingClientRect().top -
          details.getBoundingClientRect().top -
          details.clientTop -
          16,
      );
  }
  private selectedTab() {
    return el("navigation-phases").querySelector<HTMLButtonElement>(
      '[aria-selected="true"]',
    );
  }
  private revealSelectedTab() {
    const tab = this.selectedTab();
    if (!tab) return;
    const strip = el("navigation-phases");
    const bounds = tab.getBoundingClientRect();
    const viewport = strip.getBoundingClientRect();
    if (bounds.left < viewport.left)
      strip.scrollLeft += bounds.left - viewport.left;
    else if (bounds.right > viewport.right)
      strip.scrollLeft += bounds.right - viewport.right;
  }
  private alignCurrentTab() {
    const strip = el("navigation-phases");
    const tab = strip.querySelector('[aria-current="step"]');
    if (!tab) return;
    // Keep a glimpse of the previous step and leave room for upcoming steps.
    const left =
      strip.scrollLeft +
      tab.getBoundingClientRect().left -
      strip.getBoundingClientRect().left -
      24;
    strip.scrollLeft = Math.max(
      0,
      Math.min(left, strip.scrollWidth - strip.clientWidth),
    );
  }
  private selectSection(id: string, focus = false) {
    if (!this.sections.some((section) => section.id === id)) return;
    const changed = id !== this.selectedSectionId;
    this.followsCurrentSection = id === this.currentSectionId;
    this.selectedSectionId = id;
    this.render();
    flushSync();
    if (this.followsCurrentSection) this.map?.center();
    else this.map?.focusSection(id);
    const expanded = !this.mobile.matches || this.detailsOpen;
    if (expanded) this.positionDetails();
    const tab = this.selectedTab();
    if (focus) tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (changed && expanded)
      reveal(el("navigation-section-content"), {
        y: 6,
        duration: motionTime.selection,
        fromOpacity: 0.7,
      });
  }
  private renderSections() {
    const engine = this.session?.engine;
    this.sections = engine ? navigationSections(engine.journey) : [];
    const current = this.sections.find((s) => s.legs.includes(engine!.leg));
    const invalid = !this.sections.some((s) => s.id === this.selectedSectionId);
    if (!this.selectedSectionId || invalid) {
      const restore =
        !this.followsCurrentSection || (!!this.selectedSectionId && invalid);
      this.followsCurrentSection = true;
      this.selectedSectionId = current?.id;
      if (restore) this.map?.center();
    } else if (this.followsCurrentSection) this.selectedSectionId = current?.id;
    const currentChanged = this.currentSectionId !== current?.id;
    if (currentChanged && this.currentSectionId) this.closeAlternative(false);
    this.currentSectionId = current?.id;
    const selected = this.sections.find((s) => s.id === this.selectedSectionId);
    const phases = el("navigation-phases");
    const key = JSON.stringify(this.sections.map((s) => s.id));
    const scrollLeft = phases.scrollLeft;
    const tabsChanged = key !== this.tabsKey;
    const focused = phases.contains(document.activeElement);
    this.tabsKey = key;
    flushSync(() =>
      this.screen.updateTabs(
        this.sections.map((section, index) => ({
          id: section.id,
          label: sectionLabel(section),
          accessibleLabel: `${sectionLabel(section)} nach ${section.main.to.name} · Abschnitt ${index + 1} von ${this.sections.length}`,
          symbol:
            section.main.kind === "transit" &&
            ["BUS", "COACH"].includes(section.main.mode ?? "")
              ? "bus"
              : section.main.kind,
          selected: section === selected,
          current: section === current,
        })),
      ),
    );
    if (tabsChanged && focused)
      this.selectedTab()?.focus({ preventScroll: true });
    if (tabsChanged) phases.scrollLeft = scrollLeft;
    this.screen.setText(
      "navigation-stage",
      selected
        ? `${sectionLabel(selected)} · Abschnitt ${this.sections.indexOf(selected) + 1} von ${this.sections.length}`
        : "",
    );
    const panel = el("navigation-section-detail");
    if (selected)
      this.screen.setAttribute(
        "navigation-section-detail",
        "aria-labelledby",
        this.selectedTab()!.id,
      );
    else
      this.screen.setAttribute(
        "navigation-section-detail",
        "aria-labelledby",
        undefined,
      );
    const compactMovement =
      engine?.phase === "active" &&
      selected === current &&
      selected?.main === engine.leg &&
      movement(selected.main);
    const currentTransit =
      engine?.phase === "active" &&
      selected === current &&
      selected?.main === engine.leg &&
      selected?.main.kind === "transit";
    const detailKey = JSON.stringify([
      engine?.journey.departure,
      engine?.journey.arrival,
      selected,
      compactMovement,
      currentTransit,
    ]);
    if (detailKey !== this.sectionDetailKey) {
      const scrollTop = el("navigation-details").scrollTop;
      const selectionChanged =
        el("navigation-section-content").dataset.section !== selected?.id;
      this.sectionDetailKey = detailKey;
      this.screen.setAttribute(
        "navigation-section-content",
        "data-section",
        selected?.id ?? "",
      );
      this.screen.updateSectionDetail(
        engine && selected && !currentTransit
          ? structuredClone({
              journey: { ...engine.journey, legs: selected.legs },
              options: {
                presentation: "navigation",
                main: selected.main,
                compactMovement,
              },
            })
          : undefined,
      );
      el("navigation-details").scrollTop = selectionChanged ? 0 : scrollTop;
    }
    // Progress changes independently of the section structure. Keep its DOM stable.
    if (compactMovement && selected) {
      const text = this.remainingMovementText(selected.main);
      if (text !== undefined) this.screen.updateMovementSummary(text);
    }
    return { current, selected, revealCurrent: currentChanged || tabsChanged };
  }
  private remainingMovementText(leg: Leg): string | undefined {
    const engine = this.session?.engine;
    if (
      engine?.phase !== "active" ||
      this.selectedSectionId !== this.currentSectionId ||
      leg !== engine.leg ||
      !movement(leg) ||
      engine.requiresElevatorConfirmation
    )
      return;
    if (!this.session?.hasCurrentLocation || !engine.guidanceUsable)
      return "Reststrecke wird geprüft";
    const meters = engine.remainingMeters;
    const distance =
      meters >= 1000
        ? `${(meters / 1000).toFixed(1)} km`
        : `${Math.round(meters)} m`;
    return `Noch ${duration(engine.remainingSeconds)} · ${distance}`;
  }
  private renderSectionPreview(selected?: NavigationSection) {
    const preview = el("navigation-section-preview");
    const engine = this.session?.engine;
    this.screen.setHidden(
      "navigation-section-preview",
      !this.mobile.matches ||
        this.detailsOpen ||
        !selected ||
        engine?.phase !== "active" ||
        (selected.id === this.currentSectionId &&
          selected.main.kind === "transit"),
    );
    const description = !preview.hidden
      ? "navigation-section-preview-title navigation-section-preview-meta navigation-section-preview-place"
      : !el("navigation-context").hidden
        ? "navigation-context-title navigation-context-detail navigation-context-status navigation-remaining"
        : "navigation-stage navigation-remaining";
    const toggle = el("navigation-details-toggle");
    if (toggle.getAttribute("aria-describedby") !== description)
      this.screen.setAttribute(
        "navigation-details-toggle",
        "aria-describedby",
        description,
      );
    if (preview.hidden || !selected || !engine) return;
    const leg = selected.main;
    this.screen.setAttribute(
      "navigation-section-preview",
      "data-section",
      selected.id,
    );
    this.screen.setAttribute(
      "navigation-section-preview",
      "data-kind",
      leg.kind,
    );
    this.screen.setAttribute(
      "navigation-section-preview",
      "aria-labelledby",
      this.selectedTab()!.id,
    );
    const distance =
      leg.distance >= 1000
        ? `${(leg.distance / 1000).toFixed(1)} km`
        : `${Math.round(leg.distance)} m`;
    const messages =
      leg.kind === "transit"
        ? [
            `${sectionLabel(selected)} Richtung ${leg.headsign || leg.to.name}`,
            `${leg.from.name} · Ab ${detailTime(engine.journey, leg.start, Date.now() / 1000)}${leg.platform ? ` · Gleis ${leg.platform}` : ""}`,
            `${leg.to.name} · An ${detailTime(engine.journey, leg.end, Date.now() / 1000)}${leg.arrivalPlatform ? ` · Gleis ${leg.arrivalPlatform}` : ""}`,
          ]
        : [
            sectionLabel(selected),
            this.remainingMovementText(leg) ??
              `${duration(leg.end - leg.start)}${movement(leg) ? ` · ${distance}` : ""}`,
            leg.to.name,
          ];
    for (const [index, id] of [
      "navigation-section-preview-title",
      "navigation-section-preview-meta",
      "navigation-section-preview-place",
    ].entries()) {
      const text = el(id);
      if (text.textContent !== messages[index])
        this.screen.setText(id, messages[index]);
    }
  }
  private renderTransitContext(
    transit: Leg | undefined,
    viewed: Leg | undefined,
    estimate?: TransitEstimate,
    mapEstimated = false,
  ) {
    const session = this.session!;
    const engine = session.engine;
    const active = engine?.phase === "active";
    const onboard = active && engine.leg.kind === "transit";
    const currentSelected =
      !!viewed && this.selectedSectionId === this.currentSectionId;
    const leg = active ? transit : undefined;
    const context = el("navigation-context");
    this.screen.setAttribute(
      "navigation-view",
      "data-transit-context",
      String(!!leg),
    );
    this.screen.setAttribute(
      "navigation-view",
      "data-onboard",
      String(onboard),
    );
    let title = "",
      detail = "",
      status = "";
    const confirmedIndex = onboard ? engine.transitStopIndex : -1;
    const exitConfirmed = !!(
      onboard &&
      session.hasCurrentLocation &&
      !session.resumeNeedsConfirmation &&
      engine.transitExitConfirmed
    );
    const index = exitConfirmed
      ? confirmedIndex
      : (estimate?.stopIndex ??
        (onboard ? engine.transitDepartedStopIndex : -1));
    const stops =
      onboard && engine.leg.transitStops?.length
        ? engine.leg.transitStops
        : undefined;
    const confirmed = !!(
      onboard &&
      session.hasCurrentLocation &&
      !session.resumeNeedsConfirmation &&
      engine.hasCurrentTransitPosition
    );
    if (leg && engine) {
      if (onboard) {
        const remaining = stops?.filter(
          (stop, i) => i > index && !stop.cancelled,
        );
        title = leg.transitStatus?.cancelled
          ? `${leg.line || "ÖPNV"} · ${transitCancellationMessage(leg)}`
          : !stops
            ? "Stationsdaten nicht verfügbar"
            : exitConfirmed
              ? "Hier aussteigen"
              : remaining?.length
                ? `Nächster Halt: ${remaining[0].name}`
                : `Ausstieg: ${leg.to.name}`;
        detail = `${leg.line || "ÖPNV"}${remaining?.length ? ` · Noch ${remaining.length} ${remaining.length === 1 ? "Halt" : "Halte"}` : ""} · Ausstieg ${leg.to.name}`;
        status =
          !confirmed && !estimate && stops && session.hasCurrentLocation
            ? "Stationsstand wird bestätigt"
            : "";
        if (estimate?.source === "estimated")
          status =
            estimate.phase === "unclear"
              ? "Stationsstand unklar"
              : estimate.atExit
                ? "Ausstieg laut Fahrzeiten erreicht"
                : "";
      } else {
        const seconds = leg.start - Date.now() / 1000;
        const countdown =
          seconds < 0
            ? "Abfahrtszeit überschritten"
            : seconds < 60
              ? "in <1 Min."
              : `in ${Math.ceil(seconds / 60)} Min.`;
        title = leg.transitStatus?.cancelled
          ? `${leg.line || "ÖPNV"}${leg.headsign ? ` Richtung ${leg.headsign}` : ""}`
          : `${leg.line || "ÖPNV"} · ${countdown}`;
        const target = engine.leg.to;
        const samePlace =
          target.stopId && leg.from.stopId
            ? target.stopId === leg.from.stopId
            : target.name === leg.from.name &&
              target.latitude === leg.from.latitude &&
              target.longitude === leg.from.longitude;
        const namedAbove =
          samePlace &&
          ["navigation-instruction", "navigation-detail"].some((id) =>
            el(id).textContent?.includes(leg.from.name),
          );
        detail = `${leg.transitStatus?.cancelled ? "Geplante Abfahrt" : "Abfahrt"} ${detailTime(engine.journey, leg.start, Date.now() / 1000)}${namedAbove ? "" : ` · ${leg.from.name}`}${leg.platform ? ` · Gleis ${leg.platform}` : ""}`;
        status = freshTransit(leg, Date.now() / 1000) ? "" : transitStatus(leg);
      }
    }
    const hasStations = onboard && !!stops;
    const compactStatus =
      onboard &&
      estimate?.source === "estimated" &&
      (estimate.phase === "unclear" || estimate.atExit || !mapEstimated)
        ? status
        : "";
    const expanded = !this.mobile.matches || this.detailsOpen;
    const showContext =
      !!leg &&
      (!hasStations || (!!compactStatus && !expanded)) &&
      (!this.mobile.matches || currentSelected);
    this.screen.setHidden("navigation-context", !showContext);
    this.screen.setHidden("navigation-context-slot", !showContext);
    this.screen.setHidden("navigation-context-title", hasStations);
    this.screen.setHidden("navigation-context-detail", hasStations);
    const stationStatus = el("navigation-station-status");
    this.screen.setText(
      "navigation-station-status",
      onboard && viewed?.navigationId === engine.leg.navigationId ? status : "",
    );
    for (const [id, text] of [
      [
        "navigation-context-title",
        onboard ? (stops ? "" : leg!.to.name) : title,
      ],
      [
        "navigation-context-detail",
        onboard
          ? stops
            ? ""
            : `Ausstieg ${clock(leg!.end)}${leg!.arrivalPlatform ? ` · Gleis ${leg!.arrivalPlatform}` : ""}`
          : detail,
      ],
      [
        "navigation-context-status",
        !stops && onboard ? "Stationsdaten nicht verfügbar" : compactStatus,
      ],
    ]) {
      const element = el(id);
      if (element.textContent !== text) this.screen.setText(id, text);
    }
    this.stationLists[0].update(
      onboard && currentSelected ? engine.leg : undefined,
      index,
      confirmedIndex,
      onboard
        ? { exitConfirmed: confirmed && engine.transitExitConfirmed }
        : undefined,
    );
    const selectedTransit =
      active && viewed?.kind === "transit" ? viewed : undefined;
    this.stationLists[1].update(
      selectedTransit,
      onboard && selectedTransit?.navigationId === engine.leg.navigationId
        ? index
        : -1,
      onboard && selectedTransit?.navigationId === engine.leg.navigationId
        ? confirmedIndex
        : -1,
      onboard && selectedTransit?.navigationId === engine.leg.navigationId
        ? { exitConfirmed: confirmed && engine.transitExitConfirmed }
        : undefined,
    );
    const announcement = el("navigation-stations-announcement");
    const message =
      onboard && !leg?.transitStatus?.cancelled
        ? [
            title,
            detail,
            status,
            leg && !freshTransit(leg, Date.now() / 1000)
              ? transitStatus(leg)
              : "",
          ]
            .filter(Boolean)
            .join(". ")
        : "";
    if (announcement.textContent !== message)
      this.screen.setText("navigation-stations-announcement", message);
  }
  private stopStationAnimation() {
    if (this.stationFrame !== undefined)
      cancelAnimationFrame(this.stationFrame);
    if (this.stationWakeup !== undefined) clearTimeout(this.stationWakeup);
    this.stationFrame = undefined;
    this.stationWakeup = undefined;
  }
  private startStationAnimation() {
    if (
      !this.stationSample ||
      !this.visible ||
      document.hidden ||
      this.reducedMotion.matches ||
      this.stationFrame !== undefined ||
      this.stationWakeup !== undefined
    )
      return;
    const now = Date.now() / 1000;
    const next = this.stationMotion.correcting
      ? now
      : this.stationCursor?.source === "estimated"
        ? this.timeline?.nextMovementAt(
            now,
            this.session?.engine?.transitDepartedStopIndex,
            this.stationCursor.position,
          )
        : undefined;
    if (next === undefined) return;
    if (next > now) {
      this.stationWakeup = setTimeout(
        () => {
          this.stationWakeup = undefined;
          if (this.visible) this.render();
        },
        (next - now) * 1000,
      );
      return;
    }
    this.stationFrame = requestAnimationFrame(() => {
      this.stationFrame = undefined;
      const cursor = this.stationSample?.(Date.now() / 1000);
      if (!cursor || !this.visible || document.hidden) return;
      const previous = this.stationCursor;
      this.stationCursor = cursor;
      for (const list of this.stationLists) list.setPosition(cursor);
      if (
        !previous ||
        previous.stopIndex !== cursor.stopIndex ||
        previous.phase !== cursor.phase ||
        previous.atExit !== cursor.atExit
      )
        this.render();
      else this.startStationAnimation();
    });
  }
  private layout() {
    const mobile = this.mobile.matches;
    const details = el("navigation-details");
    if (mobile && !this.detailsOpen && details.contains(document.activeElement))
      el("navigation-details-toggle").focus({ preventScroll: true });
    this.screen.setHidden("navigation-details", mobile && !this.detailsOpen);
    this.screen.setAttribute(
      "navigation-view",
      "data-details",
      String(this.detailsOpen),
    );
    this.screen.setAttribute(
      "navigation-details-toggle",
      "aria-expanded",
      String(this.detailsOpen),
    );
    this.screen.setAttribute(
      "navigation-details-toggle",
      "aria-label",
      this.detailsOpen ? "Reisedetails schließen" : "Reisedetails öffnen",
    );
  }
  get visible() {
    return !this.root.hidden;
  }
  async show(session: NavigationSession) {
    closeMapStylePickers();
    if (!this.visible) {
      this.detailsOpen = false;
      this.selectedSectionId = undefined;
      this.currentSectionId = undefined;
    }
    this.session = session;
    session.setCompletionPaused(this.countdownInteraction.paused);
    this.completion.reset();
    this.screen.setHidden("navigation-auto-complete", true);
    this.screen.setText("navigation-auto-announcement", "");
    el<HTMLDetailsElement>("navigation-manual-actions").open = false;
    this.screen.setHidden("navigation-view", false);
    this.phaseKey = "";
    this.guidance.reset();
    this.guidance.speak("start", "Navigation wird vorbereitet");
    this.render();
    settle(el("navigation-panel"), 0, 14);
    if (!this.map && !this.loading) {
      this.loading = import("./navigation-map")
        .then(({ NavigationMap }) => {
          if (!this.visible) return;
          this.screen.setAttribute(
            "navigation-map",
            "data-load-error",
            undefined,
          );
          this.screen.setAttribute(
            "navigation-map",
            "aria-label",
            "Navigationskarte in Fahrtrichtung",
          );
          this.map = new NavigationMap(
            el("navigation-map"),
            el("navigation-panel"),
            el("navigation-top"),
            (following) => {
              this.screen.setIcon(
                "navigation-center",
                following ? "crosshair" : "crosshair-outline",
              );
              const label = following
                ? "Navigation zentrieren"
                : "Zurück zum Standort";
              this.screen.setAttribute(
                "navigation-center",
                "aria-label",
                label,
              );
              this.screen.setAttribute("navigation-center", "title", label);
              this.screen.setAttribute(
                "navigation-center",
                "data-following",
                String(following),
              );
            },
          );
        })
        .catch(() => {
          this.screen.setAttribute("navigation-map", "data-load-error", "true");
          this.screen.setAttribute(
            "navigation-map",
            "aria-label",
            "Karte nicht verfügbar",
          );
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
    if (this.visible) {
      this.render();
      if (this.followsCurrentSection) this.map?.center();
      else if (this.selectedSectionId)
        this.map?.focusSection(this.selectedSectionId);
    }
  }
  hide() {
    this.closeAlternative(false);
    this.screen.updateSectionDetail(undefined);
    this.sectionDetailKey = "";
    this.undoNotice.clear();
    this.shownUndo = undefined;
    this.positionTracker.reset();
    this.completion.reset();
    this.stopStationAnimation();
    this.stationMotion.reset();
    this.stationSample = undefined;
    this.stationCursor = undefined;
    this.stationPresentationKey = "";
    stopMotionWithin(this.root);
    closeMapStylePickers();
    this.screen.setHidden("navigation-view", true);
    this.guidance.reset();
    this.phaseKey = "";
    this.confirmationTrigger = undefined;
    el<HTMLDialogElement>("navigation-confirm").close();
    this.map?.dispose();
    this.map = undefined;
    this.finishedMap = undefined;
    for (const list of this.stationLists) list.update(undefined, -1);
  }
  async dispose() {
    this.hide();
    this.events.abort();
    this.undoPositionObserver?.disconnect();
    for (const list of this.stationLists) list.dispose();
    await this.destroyScreen();
  }
  pause() {
    this.guidance.cancel();
  }
  confirmEnd() {
    this.closeAlternative(false);
    if (this.session?.engine?.phase === "arrived") {
      this.exit();
      return;
    }
    this.confirm(
      "Navigation beenden?",
      "Die Route bleibt verfügbar.",
      this.exit,
      {
        confirmLabel: "Beenden",
        cancelLabel: "Weiter navigieren",
        endNavigation: true,
      },
    );
  }
  dismissConfirmation() {
    if (this.backAlternativeDetails() || this.closeAlternative()) return true;
    const dialog = el<HTMLDialogElement>("navigation-confirm");
    if (!dialog.open) return false;
    const trigger = this.confirmationTrigger;
    this.confirmationTrigger = undefined;
    dialog.close();
    if (this.visible) {
      const target =
        trigger &&
        this.root.contains(trigger) &&
        trigger.getClientRects().length > 0
          ? trigger
          : el("navigation-end");
      target.focus({ preventScroll: true });
    }
    return true;
  }
  private confirm(
    title: string,
    message: string,
    action: () => void,
    options: {
      confirmLabel?: string;
      cancelLabel?: string;
      endNavigation?: boolean;
    } = {},
  ) {
    const dialog = el<HTMLDialogElement>("navigation-confirm");
    if (dialog.open) return;
    this.confirmationTrigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    this.screen.setAttribute(
      "navigation-confirm",
      "data-kind",
      options.endNavigation ? "end" : "section",
    );
    this.screen.setText("navigation-confirm-title", title);
    this.screen.setText("navigation-confirm-message", message);
    const yes = el<HTMLButtonElement>("navigation-confirm-yes");
    const no = el<HTMLButtonElement>("navigation-confirm-no");
    this.screen.setText(
      "navigation-confirm-yes",
      options.confirmLabel ?? "Bestätigen",
    );
    this.screen.setText(
      "navigation-confirm-no",
      options.cancelLabel ?? "Abbrechen",
    );
    yes.onclick = () => {
      this.confirmationTrigger = undefined;
      dialog.close();
      action();
    };
    no.onclick = () => this.dismissConfirmation();
    dialog.oncancel = (event) => {
      event.preventDefault();
      this.dismissConfirmation();
    };
    dialog.showModal();
    if (options.endNavigation) no.focus({ preventScroll: true });
  }
  render() {
    const session = this.session;
    if (!session || !this.visible) return;
    const previousFocus = this.root.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    const previousStripScroll = el("navigation-phases").scrollLeft;
    flushSync(() =>
      this.screen.updateLayout(
        this.mobile.matches,
        session.engine?.phase === "arrived",
      ),
    );
    if (previousFocus && !previousFocus.isConnected && previousFocus.id) {
      const target = document.getElementById(previousFocus.id);
      if (
        target &&
        target.getClientRects().length &&
        !target.closest("[hidden], [inert]")
      )
        target.focus({ preventScroll: true });
      el("navigation-phases").scrollLeft = previousStripScroll;
    }
    const undo = session.completionUndo;
    if (undo !== this.shownUndo) {
      this.shownUndo = undo;
      this.screen.setText(
        "navigation-undo-announcement",
        undo ? "Abschnitt abgeschlossen. Rückgängig verfügbar." : "",
      );
      if (undo)
        this.undoNotice.show(
          async () => {
            this.selectedSectionId = undefined;
            this.positionTracker.reset();
            this.guidance.reset();
            this.phaseKey = "";
            if (session.undoLastCompletion()) {
              this.screen.setText(
                "navigation-undo-announcement",
                "Abschnitt wiederhergestellt.",
              );
              const complete = el("navigation-complete");
              (complete.getClientRects().length
                ? complete
                : el("navigation-instruction")
              ).focus({ preventScroll: true });
            }
          },
          () => session.discardCompletionUndo(undo),
        );
      else this.undoNotice.clear();
    }
    const engine = session.engine,
      arrived = engine?.phase === "arrived",
      leg = engine?.leg;
    const countdown = engine?.completionCountdown;
    const autoNotice = el("navigation-auto-complete");
    const showCountdown =
      !!countdown && !arrived && session.foreground && !session.busy;
    if (showCountdown) {
      const last =
        engine!.progress.legIndex === engine!.journey.legs.length - 1;
      this.screen.setText(
        "navigation-auto-label",
        `${last ? "Ziel erreicht" : "Nächster Abschnitt"} in ${Math.ceil(countdown.remainingSeconds)} s${engine!.completionPaused ? " · pausiert" : ""}`,
      );
      this.automaticCountdownBar.set(
        countdown.remainingSeconds * 1000,
        30000,
        engine!.completionPaused,
      );
      if (autoNotice.hidden) {
        this.screen.setText(
          "navigation-auto-announcement",
          last
            ? "Ziel erreicht in 30 Sekunden. Automatischen Abschluss abbrechen möglich."
            : "Nächster Abschnitt startet in 30 Sekunden. Automatischen Wechsel abbrechen möglich.",
        );
        this.screen.setHidden("navigation-auto-complete", false);
        reveal(autoNotice, { y: 8 });
      }
    } else {
      this.automaticCountdownBar.hide();
      if (autoNotice.contains(document.activeElement))
        el("navigation-instruction").focus({ preventScroll: true });
      this.screen.setHidden("navigation-auto-complete", true);
    }
    const enteringSummary = this.root.dataset.arrived !== "true";
    this.screen.setAttribute(
      "navigation-view",
      "data-arrived",
      String(!!arrived),
    );
    if (arrived) {
      this.stopStationAnimation();
      this.stationSample = undefined;
      this.stationCursor = undefined;
      this.stationMotion.reset();
      this.stationPresentationKey = "";
    }
    if (!arrived)
      flushSync(() =>
        this.screen.updateFinish({
          visible: false,
          providers: [],
          origin: "",
          destination: "",
          time: "",
          distance: "",
          sinceResume: false,
          status: "",
        }),
      );
    this.screen.setAttribute(
      "navigation-panel",
      "aria-label",
      arrived ? "Fahrtzusammenfassung" : "Navigationshinweise",
    );
    if (arrived && session.summary) {
      if (enteringSummary) {
        this.closeAlternative(false);
        this.summaryProviders = supportProviders.flatMap((provider) =>
          provider.url
            ? [
                {
                  name: provider.name,
                  label: provider.label,
                  url: provider.url,
                },
              ]
            : [],
        );
      }
      const summary = session.summary;
      const kilometers = (meters: number) =>
        `${(meters / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
      this.screen.setText("navigation-instruction", "Ziel erreicht");
      flushSync(() =>
        this.screen.updateFinish({
          visible: true,
          providers: this.summaryProviders,
          origin: summary.originName,
          destination: summary.destinationName,
          time: duration(summary.elapsedSeconds),
          distance: kilometers(summary.distanceMeters),
          sinceResume: summary.sinceResume,
          status: session.statisticsMessage,
          totals: session.statistics
            ? {
                count:
                  session.statistics.completedIds.length.toLocaleString(
                    "de-DE",
                  ),
                distance: kilometers(session.statistics.distanceMeters),
                time: duration(session.statistics.elapsedSeconds),
              }
            : undefined,
        }),
      );
      if (enteringSummary) {
        this.dismissConfirmation();
        el("navigation-finish-content").scrollTop = 0;
        this.guidance.cancel();
        this.guidance.speak(`arrived-${summary.id}`, "Ziel erreicht");
        el("navigation-finish-heading").focus({ preventScroll: true });
      }
      if (this.map && this.finishedMap !== this.map) {
        this.map.update(engine, session.fix, session.locationQuality);
        this.map.freeze();
        this.finishedMap = this.map;
      }
      return;
    }
    const displayPosition = engine
      ? this.positionTracker.update(
          engine,
          session.fix,
          session.locationQuality,
        )
      : undefined;
    let estimateSource: TransitEstimateSource | undefined;
    this.stationSample = undefined;
    if (
      engine?.phase === "active" &&
      leg?.kind === "transit" &&
      !session.resumeNeedsConfirmation &&
      leg.transitStops?.length &&
      !leg.transitStatus?.cancelled &&
      leg.transitStops.some((stop) => !stop.cancelled)
    ) {
      const key = JSON.stringify([
        leg.navigationId,
        leg.start,
        leg.end,
        leg.coordinates,
        leg.transitStops,
        leg.transitStatus?.cancelled,
      ]);
      if (key !== this.timelineKey) {
        this.timelineKey = key;
        this.timeline = TransitTimeline.create(leg);
        this.transitPath = TransitPath.forPresentation(leg);
      }
      const confirmedIndex = engine.transitStopIndex;
      const departedIndex = engine.transitDepartedStopIndex;
      const originalPath = TransitPath.create(leg);
      const floor = Math.max(
        confirmedIndex,
        originalPath
          ? originalPath.positionAt(engine.progress.meters)
          : confirmedIndex,
      );
      const confirmed =
        session.hasCurrentLocation && engine.hasCurrentTransitPosition;
      const timeline = this.timeline;
      const sample = confirmed
        ? () => stationCursor(leg, floor, departedIndex, "gps", "ride", key)
        : timeline
          ? (wall: number) => timeline.sample(wall, departedIndex, floor)
          : () =>
              stationCursor(
                leg,
                floor,
                departedIndex,
                "estimated",
                "unclear",
                key,
              );
      const presentationKey = JSON.stringify([
        key,
        confirmed,
        floor,
        departedIndex,
      ]);
      if (presentationKey !== this.stationPresentationKey) {
        this.stopStationAnimation();
        this.stationPresentationKey = presentationKey;
        this.stationMotion.setTarget(
          presentationKey,
          sample,
          Date.now() / 1000,
          performance.now() / 1000,
          !this.reducedMotion.matches && !document.hidden,
          leg,
        );
      }
      this.stationSample = (wall) =>
        this.stationMotion.sample(
          wall,
          performance.now() / 1000,
          !this.reducedMotion.matches,
          floor,
        );
      // The map may use a first suitable fix; the rail waits for confirmed evidence.
      const mapLocated = displayPosition && !displayPosition.preferEstimate;
      if (timeline && this.transitPath && !mapLocated)
        estimateSource = {
          timeline,
          path: this.transitPath,
          confirmedIndex: departedIndex,
          confirmedPosition: floor,
          sample: this.stationSample,
        };
    } else {
      this.stopStationAnimation();
      this.stationMotion.reset();
      this.stationPresentationKey = "";
    }
    const cursor = this.stationSample?.(Date.now() / 1000);
    this.stationCursor = cursor;
    const estimate = cursor?.source === "estimated" ? cursor : undefined;
    const streetPaused = !!engine && movement(leg) && !engine.guidanceUsable;
    this.screen.setText(
      "navigation-instruction",
      streetPaused
        ? session.busy
          ? "Route wird angepasst …"
          : `Jetzt: ${leg?.kind === "walk" ? "Zu Fuß" : "Rad"} bis ${leg?.to.name}`
        : engine && !arrived && leg?.kind === "bike" && !engine.maneuver
          ? `Nach ${leg.to.name}`
          : (engine?.instruction ??
            (session.busy || !session.message
              ? "Navigation wird vorbereitet …"
              : "Navigation konnte nicht starten")),
    );
    const arrows: Record<string, string> = {
      LEFT: "↰",
      HARD_LEFT: "↰",
      SLIGHTLY_LEFT: "↖",
      RIGHT: "↱",
      HARD_RIGHT: "↱",
      SLIGHTLY_RIGHT: "↗",
      UTURN_LEFT: "↶",
      UTURN_RIGHT: "↷",
      CIRCLE_CLOCKWISE: "⟳",
      CIRCLE_COUNTERCLOCKWISE: "⟲",
      STAIRS: "≋",
      ELEVATOR: "↕",
    };
    const arrow = el("navigation-arrow");
    if (engine?.phase === "active" && leg?.kind === "transit") {
      this.screen.setIcon(
        "navigation-arrow",
        ["BUS", "COACH"].includes(leg.mode ?? "") ? "bus" : "transit",
      );
    } else
      this.screen.setText(
        "navigation-arrow",
        arrived
          ? "✓"
          : engine?.maneuver
            ? (arrows[engine.maneuver.direction] ?? "↑")
            : leg?.kind === "transit"
              ? "⇥"
              : leg?.kind === "stop"
                ? "●"
                : "↑",
      );
    if (streetPaused) this.screen.setText("navigation-arrow", "");
    const meters = streetPaused ? undefined : engine?.distanceToNext;
    this.screen.setText(
      "navigation-distance",
      arrived || leg?.kind === "transit" || meters === undefined
        ? ""
        : meters >= 1000
          ? `${(meters / 1000).toFixed(1)} km`
          : `${Math.round(meters / 5) * 5} m`,
    );
    this.screen.setText(
      "navigation-detail",
      leg?.kind === "transit"
        ? ""
        : leg?.kind === "stop"
          ? `Weiterfahrt ${clock(leg.end)} · Bestätige, wenn du bereit bist.`
          : movement(leg) &&
              !leg?.maneuvers?.length &&
              !engine?.hasManeuverGuidance
            ? ""
            : (leg?.to.name ?? ""),
    );
    const { current, selected, revealCurrent } = this.renderSections();
    const statusMessage =
      !session.busy &&
      session.message ===
        "Standort hat sich geändert. Weg wird erneut berechnet …"
        ? ""
        : session.message;
    this.screen.setText(
      "navigation-status",
      session.resumeNeedsConfirmation
        ? "Zeitpunkt dieses Abschnitts liegt zurück. Prüfe und bestätige deinen aktuellen Abschnitt."
        : statusMessage,
    );
    this.screen.setText("navigation-storage-status", session.storageMessage);
    this.screen.setText(
      "navigation-disruption",
      session.disruption?.message ?? session.assessment?.message ?? "",
    );
    const invalidLocation = !session.hasCurrentLocation;
    const automaticLocationRefresh =
      session.foreground &&
      !!this.options.locationAutoRefresh?.() &&
      session.locationError?.reason !== "permission-denied";
    const mapEstimateLabel = estimateSource
      ? estimateSource.path.schematic
        ? "Kartenposition grob geschätzt"
        : "Kartenposition geschätzt"
      : estimate
        ? "Stationsstand geschätzt"
        : "";
    const gpsMessage =
      engine && !arrived && invalidLocation
        ? session.locationQuality === "inaccurate"
          ? "GPS ungenau"
          : "Kein GPS"
        : mapEstimateLabel
          ? mapEstimateLabel
          : displayPosition?.source === "last-known"
            ? "Standort wird geprüft"
            : "";
    const gpsEstimate = invalidLocation ? mapEstimateLabel : "";
    flushSync(() =>
      this.screen.updateLocation({
        primary: gpsMessage,
        estimate: gpsEstimate,
      }),
    );
    let locationMessage =
      !engine || arrived
        ? ""
        : session.locating
          ? "Standort wird gesucht …"
          : (session.locationError?.message ??
            (invalidLocation
              ? `${!session.fix ? "Kein Standort verfügbar." : session.locationQuality === "inaccurate" ? "Standort zu ungenau." : "Letzter Standort nicht aktuell."}${estimate ? "" : " Automatischer Fortschritt pausiert."}`
              : ""));
    if (estimate)
      locationMessage += estimateSource
        ? " Position und Stationsstand werden anhand der Fahrzeiten geschätzt. Bestätige den Ausstieg selbst."
        : " Stationsstand wird anhand der Fahrzeiten geschätzt. Bestätige den Ausstieg selbst.";
    if (
      engine &&
      !arrived &&
      invalidLocation &&
      !session.locating &&
      automaticLocationRefresh
    )
      locationMessage += " Standort wird automatisch erneut angefragt.";
    const locationStatus = el("navigation-location-status");
    this.screen.updateLocationFeedback(locationMessage, !session.locating);
    this.screen.setText(
      "navigation-network-status",
      navigator.onLine
        ? ""
        : "Offline · Streckenverlauf verfügbar. Neue Routen und Fahrtdaten benötigen Internet.",
    );
    const transit = engine?.journey.legs
      .slice(engine.progress.legIndex)
      .find((l) => l.kind === "transit");
    this.renderTransitContext(
      transit,
      selected?.main,
      cursor,
      !!mapEstimateLabel,
    );
    if (transit && leg?.kind !== "transit")
      this.screen.setText(
        "navigation-context-title",
        `Danach: ${el("navigation-context-title").textContent ?? ""}`,
      );
    this.renderSectionPreview(selected);
    if (cursor) for (const list of this.stationLists) list.setPosition(cursor);
    this.startStationAnimation();
    const viewedTransit = selected?.legs.find((l) => l.kind === "transit");
    const viewedTransitWarning = transitWarning(viewedTransit);
    this.screen.setText("navigation-transit-status", viewedTransitWarning);
    const currentTransitWarning = transitWarning(transit);
    this.screen.setText(
      "navigation-current-transit-status",
      transit !== viewedTransit ? currentTransitWarning : "",
    );
    const complete = el<HTMLButtonElement>("navigation-complete");
    const nearTarget = this.completion.update(
      engine,
      session.fix,
      session.hasCurrentLocation && session.foreground && !session.busy,
    );
    this.quickCompletionAvailable = this.completionAvailable && nearTarget;
    const manualActions = el<HTMLDetailsElement>("navigation-manual-actions");
    const moreActions = el("navigation-more-actions");
    const manualAvailable =
      this.completionAvailable && movement(leg) && !nearTarget;
    const focused = document.activeElement;
    const completeLabel =
      leg?.kind === "stop"
        ? "Weiterfahren"
        : leg?.kind === "transit"
          ? "Ausgestiegen"
          : leg?.kind === "fold"
            ? "Rad gefaltet"
            : leg?.kind === "unfold"
              ? "Rad entfaltet"
              : leg?.kind === "wait"
                ? "Warten beenden"
                : "Abschnitt fertig";
    const timedActivity = leg && ["fold", "unfold", "wait"].includes(leg.kind);
    const countdownDuration = countdown
      ? 30
      : timedActivity
        ? Math.max(0, leg.end - leg.start)
        : 0;
    const countdownRemaining = countdown
      ? countdown.remainingSeconds
      : timedActivity
        ? Math.min(countdownDuration, engine!.remainingSeconds)
        : 0;
    let countdownPresentation: NavigationCompletionModel["countdown"];
    if (this.quickCompletionAvailable && countdownDuration > 0) {
      const seconds = Math.ceil(countdownRemaining);
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      const label = countdown
        ? "Automatischer Wechsel"
        : leg?.kind === "fold"
          ? "Faltzeit"
          : leg?.kind === "unfold"
            ? "Entfaltzeit"
            : "Wartezeit";
      countdownPresentation = {
        remaining: countdownRemaining,
        duration: countdownDuration,
        paused: !!engine!.completionPaused,
        title: `${label} · ${time} verbleibend${engine!.completionPaused ? " · pausiert" : ""}`,
        description:
          (seconds > 0
            ? `${label}: noch ${seconds} Sekunden.`
            : `${label} abgelaufen. Abschnitt kann manuell bestätigt werden.`) +
          (engine!.completionPaused ? " Countdown pausiert." : ""),
      };
    }
    const locationRetry = !engine && session.needsLocation;
    flushSync(() =>
      this.screen.updateCompletion({
        available: this.quickCompletionAvailable,
        alternativeAvailable: !!session.alternative,
        completionPrimary:
          !movement(leg) ||
          (session.hasCurrentLocation && !!engine?.guidanceUsable),
        manualAvailable: !!manualAvailable,
        busy: session.busy,
        mobile: this.mobile.matches,
        label: completeLabel,
        retryVisible: !(
          (!session.retryAvailable && !session.disruption) ||
          locationRetry ||
          !!session.alternative
        ),
        retryLabel: session.disruption
          ? "Andere Verbindung suchen"
          : "Erneut versuchen",
        replanVisible: session.distantStart,
        countdown: countdownPresentation,
      }),
    );
    if (
      (focused === complete && complete.hidden) ||
      (focused === moreActions && moreActions.hidden) ||
      (focused instanceof HTMLElement &&
        manualActions.contains(focused) &&
        (!manualAvailable || (!manualActions.open && focused !== moreActions)))
    )
      (this.quickCompletionAvailable
        ? complete
        : manualAvailable && !this.mobile.matches
          ? moreActions
          : el("navigation-instruction")
      ).focus({ preventScroll: true });
    this.screen.setHidden(
      "navigation-locate",
      arrived === true ||
        (engine
          ? (!invalidLocation || automaticLocationRefresh) &&
            !session.alternativeNeedsLocation &&
            !session.locating
          : !locationRetry || !session.retryAvailable),
    );
    this.screen.setDisabled(
      "navigation-locate",
      session.busy || session.locating,
    );
    this.screen.setText(
      "navigation-locate",
      session.locating ? "Standort wird gesucht …" : "Standort erneut anfragen",
    );
    this.screen.setHidden(
      "navigation-location",
      !locationMessage && !!el("navigation-locate").hidden,
    );
    this.screen.setIcon(
      "navigation-audio",
      this.guidance.enabled ? "volume" : "muted",
    );
    this.screen.setAttribute(
      "navigation-audio",
      "title",
      this.guidance.enabled ? "Ton ausschalten" : "Ton einschalten",
    );
    this.screen.setAttribute(
      "navigation-audio",
      "aria-label",
      this.guidance.enabled ? "Ton ausschalten" : "Ton einschalten",
    );
    this.screen.setAttribute(
      "navigation-audio",
      "aria-pressed",
      String(this.guidance.enabled),
    );
    this.screen.setText("navigation-audio-status", this.voiceMessage);
    const cyclingLimit = session.settings?.maxCyclingMinutes ?? 30;
    const choices = session.alternatives.map((value) => ({
      id: value.id,
      journey: {
        ...(value.displayJourney ?? value.journey),
        id: value.id,
        ...(!value.displayJourney
          ? {
              departure: Math.min(
                value.journey.arrival,
                Math.max(
                  Date.now() / 1000,
                  value.journey.legs[value.legIndex].start,
                ),
              ),
              legs: value.journey.legs.slice(value.legIndex),
            }
          : {}),
      },
    }));
    const recommendedId = choices
      .filter((value) => cyclingExcess(value.journey, cyclingLimit) === 0)
      .sort((a, b) => compare(a.journey, b.journey, "now"))[0]?.id;
    const proposal =
      session.alternatives.find(
        (value) => value.id === this.alternativeSelectedId,
      ) ??
      session.alternatives.find((value) => value.id === recommendedId) ??
      session.alternative;
    this.alternativeSelectedId = proposal?.id;
    if (
      this.alternativeDetailId &&
      !session.alternatives.some(
        (value) => value.id === this.alternativeDetailId,
      )
    )
      this.alternativeDetailId = undefined;
    const displayJourney = choices.find(
      (value) => value.id === proposal?.id,
    )?.journey;
    const validity = session.alternativeValidity(proposal?.id);
    const changedProposal =
      !!this.alternativeSeenId &&
      !!proposal &&
      this.alternativeSeenId !==
        session.alternatives.map((value) => value.id).join(",");
    const canRetryAlternative =
      engine?.phase === "active" &&
      !!session.disruption &&
      !(engine.leg.kind === "transit" && engine.leg.transitStatus?.cancelled);
    const retryHadFocus =
      document.activeElement?.id === "navigation-alternative-retry";
    this.screen.updateAlternative({
      id: proposal?.id,
      choices,
      recommendedId,
      detailJourney: this.alternativeDetailId ? displayJourney : undefined,
      cyclingLimit,
      locating: session.locating,
      error: !!session.locationError,
      select: (id) => {
        this.alternativeSelectedId = id;
        this.render();
      },
      details: (id) => {
        this.alternativeListScroll = el(
          "navigation-alternative",
        ).querySelector<HTMLElement>(".alternative-content")!.scrollTop;
        this.alternativeSelectedId = id;
        this.alternativeDetailId = id;
        this.render();
        flushSync();
        el("navigation-alternative").querySelector<HTMLElement>(
          ".alternative-content",
        )!.scrollTop = 0;
        el("navigation-alternative-title").focus({ preventScroll: true });
      },
      retry: canRetryAlternative
        ? () => {
            void session.proposeAlternative(
              session.engine?.leg.kind === "stop" ? "stop" : undefined,
            );
          }
        : undefined,
      back: () => {
        this.backAlternativeDetails();
      },
      needsLocation: session.alternativeNeedsLocation,
      status: session.locating
        ? "Standort wird gesucht …"
        : session.locationError
          ? session.locationError.message
          : session.alternativeNeedsLocation
            ? "Für die neue Verbindung wird ein aktueller Standort benötigt."
            : session.busy
              ? "Vorschlag wird geprüft …"
              : !proposal
                ? !session.disruption
                  ? "Störung liegt nicht mehr vor. Die bisherige Route bleibt aktiv."
                  : session.message ||
                    "Vorschlag nicht mehr verfügbar. Die bisherige Route bleibt aktiv."
                : validity === "stale"
                  ? "Vorschlag ist nicht mehr aktuell. Bitte aktualisieren."
                  : changedProposal
                    ? "Vorschlag wurde aktualisiert. Bitte erneut prüfen."
                    : "",
      busy: session.busy,
      available:
        !!proposal && !!session.disruption && validity !== "unavailable",
      stale: validity === "stale",
    });
    if (retryHadFocus) {
      flushSync();
      if (!document.getElementById("navigation-alternative-retry"))
        el("navigation-alternative-close").focus({ preventScroll: true });
    }
    this.screen.setText(
      "navigation-remaining",
      engine ? (arrived ? "Ziel erreicht" : "") : "Navigation",
    );
    this.screen.setHidden("navigation-remaining", !!engine && !arrived);
    this.screen.setHidden(
      "navigation-summary-label",
      !engine || !!arrived || !el("navigation-context").hidden,
    );
    const requestedArrival =
      session.request?.timing === "arrive" ? session.request.time : undefined;
    const arrivalWarning =
      engine &&
      !arrived &&
      requestedArrival !== undefined &&
      engine.journey.arrival > requestedArrival
        ? `Gewünschte Ankunft ${clock(requestedArrival)} wird nicht erreicht.`
        : "";
    this.screen.setText("navigation-arrival-warning", arrivalWarning);
    const candidates: NavigationNotice[] = [
      {
        message:
          session.disruption?.message ?? session.assessment?.message ?? "",
        target: "navigation-disruption",
      },
      { message: arrivalWarning, target: "navigation-arrival-warning" },
      {
        message: !navigator.onLine
          ? "Offline · Neue Routen benötigen Internet"
          : "",
        target: "navigation-network-status",
      },
      {
        message: session.resumeNeedsConfirmation
          ? (el("navigation-status").textContent ?? "")
          : "",
        target: "navigation-status",
      },
      {
        message: session.alternative ? "" : statusMessage,
        target: "navigation-status",
      },
      {
        message: currentTransitWarning,
        target:
          transit === viewedTransit
            ? "navigation-transit-status"
            : "navigation-current-transit-status",
      },
      {
        message:
          viewedTransit && viewedTransit !== transit
            ? viewedTransitWarning
            : "",
        target: "navigation-transit-status",
      },
      { message: session.storageMessage, target: "navigation-storage-status" },
      { message: this.voiceMessage, target: "navigation-audio-status" },
    ].filter((notice) => !!notice.message);
    const messages = new Set<string>(),
      targets = new Set<string>();
    const notices = candidates.filter((notice) => {
      if (messages.has(notice.message) || targets.has(notice.target))
        return false;
      messages.add(notice.message);
      targets.add(notice.target);
      return true;
    });
    const alert = el("navigation-alert");
    this.screen.setHidden(
      "navigation-alert",
      !notices.length && !session.alternative,
    );
    const summary = notices[0]?.message ?? "Neue Verbindung verfügbar";
    const summaryText = el("navigation-alert-summary");
    if (summaryText.textContent !== summary)
      this.screen.setText("navigation-alert-summary", summary);
    const clearNotice = (target: string, replacement: HTMLElement) => {
      const element = el(target);
      const focused = element === document.activeElement;
      this.screen.setText(target, "");
      if (focused) {
        replacement.tabIndex = -1;
        replacement.focus({ preventScroll: true });
      }
    };
    for (const notice of candidates) {
      if (targets.has(notice.target)) continue;
      const canonical = notices.find((n) => n.message === notice.message)!;
      clearNotice(notice.target, el(canonical.target));
    }
    const primary = notices[0];
    if (primary)
      for (const notice of candidates) {
        if (
          notice.message === summary &&
          el(notice.target).textContent === summary
        )
          clearNotice(notice.target, summaryText);
      }
    this.noticeTarget = session.alternative
      ? "navigation-alternative"
      : notices.find((notice) => el(notice.target).textContent)?.target;
    const alertOpen = el("navigation-alert-open");
    this.screen.setAttribute(
      "navigation-alert-open",
      "data-primary",
      String(!!session.alternative),
    );
    this.screen.setHidden(
      "navigation-alert-open",
      !engine || !this.noticeTarget,
    );
    this.screen.setText(
      "navigation-alert-open",
      session.alternative
        ? "Neue Verbindungen ansehen"
        : notices.length > 1
          ? `${notices.length} Hinweise ansehen`
          : "Details ansehen",
    );
    this.layout();
    // Reveal progress after placing the strip, even while previewing another step.
    if (revealCurrent) this.alignCurrentTab();
    if (!engine) return;
    if (streetPaused) this.guidance.cancel();
    const phaseKey = `${engine.journey.legs.map((l) => l.navigationId).join("|")}-${engine.leg.navigationId}-${engine.phase}`;
    if (!streetPaused && this.phaseKey !== phaseKey) {
      this.phaseKey = phaseKey;
      this.guidance.speak(
        engine.maneuver && (engine.distanceToNext ?? Infinity) <= 100
          ? `${phaseKey}-turn-${engine.guidanceKey}`
          : phaseKey,
        engine.maneuver && engine.distanceToNext !== undefined
          ? `In ${Math.round(engine.distanceToNext / 10) * 10} Metern ${engine.instruction}`
          : engine.instruction,
      );
    }
    if (session.foreground && !session.busy) {
      if (
        !streetPaused &&
        engine.maneuver &&
        (engine.distanceToNext ?? Infinity) <= 100
      )
        this.guidance.speak(
          `${phaseKey}-turn-${engine.guidanceKey}`,
          `In ${Math.round((engine.distanceToNext ?? 0) / 10) * 10} Metern ${engine.instruction}`,
        );
      if (
        leg?.kind === "transit" &&
        freshTransit(leg, Date.now() / 1000) &&
        leg.end > Date.now() / 1000 &&
        leg.end - Date.now() / 1000 <= 300
      )
        this.guidance.speak(
          `${phaseKey}-exit`,
          `In ${Math.ceil((leg.end - Date.now() / 1000) / 60)} Minuten bei ${leg.to.name} aussteigen`,
        );
      if (transit?.platform && freshTransit(transit, Date.now() / 1000))
        this.guidance.speak(
          `platform-${transit.navigationId}-${transit.platform}`,
          `${transit.line} fährt von Gleis ${transit.platform}`,
          false,
        );
      if (session.disruption)
        this.guidance.speak(session.disruption.id, session.disruption.message);
    }
    this.map?.update(
      engine,
      session.fix,
      session.locationQuality,
      estimateSource,
      displayPosition,
    );
  }
}
