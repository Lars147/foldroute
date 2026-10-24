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
import { NavigationGuidance } from "./navigation-guidance";
import { NavigationStations } from "./navigation-stations";
import { clock, duration, el, node, icon, setLocationFeedback } from "./ui";
import type { Leg } from "./model";
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
import { detailTime, renderJourneyDetails } from "./journey-detail";
import { closeMapStylePickers, mountMapStylePicker } from "./map-style-picker";
import { supportProviders } from "./project-support";
import { mapAttribution } from "./map-theme";
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
  private map?: NavigationMap;
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
  private guidance = new NavigationGuidance((message) => {
    this.voiceMessage = message;
    el("navigation-audio-status").textContent = message;
  });
  constructor(
    private exit: () => void,
    private restart: (replan: boolean) => void,
    private options: {
      audioEnabled?: boolean;
      locationAutoRefresh?: () => boolean;
    } = {},
  ) {
    if (options.audioEnabled !== undefined)
      this.guidance.enabled = options.audioEnabled;
    this.root = node("section", "", "navigation-screen");
    this.root.id = "navigation-view";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Aktive Navigation");
    this.root.innerHTML = `
      <div id="navigation-map" tabindex="0" aria-label="Navigationskarte in Fahrtrichtung"></div>
      <div class="navigation-top" id="navigation-top"><div id="navigation-phases" role="tablist" aria-label="Reiseabschnitte"></div></div>
      <div id="navigation-gps-status" role="status" aria-live="polite" aria-atomic="true" hidden><strong id="navigation-gps-primary"></strong> <span id="navigation-gps-estimate" hidden></span></div>
      <div class="navigation-map-controls" role="group" aria-label="Kartensteuerung">
        <button id="navigation-audio" class="navigation-icon-button secondary" type="button" aria-label="Ton ausschalten" title="Ton ausschalten"></button>
        <button id="navigation-center" class="navigation-center navigation-icon-button secondary" type="button" aria-label="Navigation zentrieren" title="Navigation zentrieren" aria-pressed="true"></button>
        <div id="navigation-style-control"></div>
      </div>
      <div class="navigation-credit">${mapAttribution}</div>
      <article class="navigation-panel" id="navigation-panel" aria-label="Navigationshinweise">
        <div class="navigation-instruction" id="navigation-guidance"><span id="navigation-arrow" aria-hidden="true">↑</span><div><strong id="navigation-distance"></strong><h1 id="navigation-instruction" tabindex="-1">Navigation wird vorbereitet …</h1><p id="navigation-detail"></p></div></div>
        <div id="navigation-summary">
          <button id="navigation-details-toggle" type="button" aria-expanded="false" aria-controls="navigation-details" aria-describedby="navigation-context-title navigation-context-detail navigation-context-status navigation-remaining"><span class="navigation-grip" aria-hidden="true"></span><strong id="navigation-remaining"></strong><span id="navigation-summary-label">Reisedetails</span></button>
          <div id="navigation-end-slot"></div>
        </div>
        <div id="navigation-alert" hidden><p id="navigation-alert-summary" role="status" aria-atomic="true"></p><button id="navigation-alert-open" class="secondary" type="button">Details</button></div>
        <div id="navigation-context-slot"><span id="navigation-context" hidden><strong id="navigation-context-title"></strong><span id="navigation-context-detail"></span><span id="navigation-context-status"></span></span></div>
        <div id="navigation-section-preview" role="region" hidden><strong id="navigation-section-preview-title"></strong><p id="navigation-section-preview-meta"></p><p id="navigation-section-preview-place"></p></div>
        <ol id="navigation-stations-preview" class="navigation-stations" aria-label="Kommende Halte" hidden></ol>
        <span id="navigation-stations-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>
        <div id="navigation-details">
        <div id="navigation-section-detail" role="tabpanel" tabindex="0">
          <span id="navigation-stage" class="sr-only"></span>
          <div id="navigation-section-content"></div>
          <ol id="navigation-stations-detail" class="navigation-stations" aria-label="Stationen bis zum Ausstieg" hidden></ol>
          <p id="navigation-station-status"></p>
          <p id="navigation-transit-status"></p>
        </div>
        <p id="navigation-current-transit-status"></p>
        <p id="navigation-arrival-warning" role="status"></p>
        <div id="navigation-location" hidden><p id="navigation-location-status" role="status"></p><div class="navigation-actions"><button id="navigation-locate" class="secondary" hidden>Standort erneut anfragen</button></div></div>
        <p id="navigation-network-status"></p>
        <p id="navigation-status" role="status"></p><p id="navigation-disruption" role="status"></p>
        <div id="navigation-alternative" hidden><p id="navigation-alternative-text"></p><button id="navigation-accept" class="primary">Verbindung übernehmen</button><button id="navigation-dismiss" class="secondary">Bisherige behalten</button></div>
        <p id="navigation-storage-status"></p><p id="navigation-audio-status"></p>
        <div class="navigation-actions" id="navigation-detail-actions"><button id="navigation-complete" class="primary" hidden>Abschnitt fertig</button><button id="navigation-retry" class="primary" hidden>Erneut versuchen</button><button id="navigation-replan" class="primary" hidden>Route ab hier planen</button><button id="navigation-end" class="secondary">Navigation beenden</button></div>
        </div>
        <div id="navigation-phases-slot"></div>
        <div id="navigation-quick-actions" class="navigation-actions"></div>
        <div id="navigation-finish" hidden>
          <div class="navigation-finish-content" id="navigation-finish-content">
            <div class="navigation-finish-trip">
              <header class="navigation-finish-header">
                <span class="navigation-finish-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m5 12 4 4L19 6"/></svg></span>
                <div><h1 id="navigation-finish-heading" tabindex="-1">Ziel erreicht</h1><p id="navigation-finish-route"><span id="navigation-finish-origin"></span><span aria-hidden="true"> → </span><span class="sr-only"> nach </span><span id="navigation-finish-destination"></span></p></div>
              </header>
              <dl class="navigation-finish-metrics" aria-label="Diese Fahrt">
                <div><dt>Unterwegs</dt><dd id="navigation-finish-time"></dd></div>
                <div><dt>Routenlänge</dt><dd id="navigation-finish-distance"></dd></div>
              </dl>
              <p id="navigation-finish-resumed" hidden>Zeit und Strecke seit Wiederaufnahme erfasst.</p>
            </div>
            <section id="navigation-finish-totals" aria-labelledby="navigation-finish-totals-heading" hidden>
              <h2 id="navigation-finish-totals-heading">Deine Wege mit FoldRoute</h2>
              <dl class="navigation-finish-metrics navigation-finish-overall">
                <div><dt>Fahrten</dt><dd id="navigation-finish-count"></dd></div>
                <div><dt>Strecke</dt><dd id="navigation-finish-total-distance"></dd></div>
                <div><dt>Zeit</dt><dd id="navigation-finish-total-time"></dd></div>
              </dl>
            </section>
            <p id="navigation-finish-storage" role="status"></p>
            <nav id="navigation-support" aria-label="FoldRoute unterstützen" hidden>
              <div id="navigation-support-links"></div>
            </nav>
          </div>
          <div class="navigation-finish-actions">
            <button id="navigation-finish-close" class="primary" type="button">Fahrt abschließen</button>
          </div>
        </div>
      </article>
      <dialog id="navigation-confirm" aria-labelledby="navigation-confirm-title" aria-describedby="navigation-confirm-message"><h2 id="navigation-confirm-title"></h2><p id="navigation-confirm-message"></p><div class="navigation-actions"><button id="navigation-confirm-yes" class="primary" type="button">Bestätigen</button><button id="navigation-confirm-no" class="secondary" type="button">Abbrechen</button></div></dialog>`;
    el("main").append(this.root);
    this.stationLists = [
      new NavigationStations(el("navigation-stations-preview"), true),
      new NavigationStations(el("navigation-stations-detail")),
    ];
    document.addEventListener("visibilitychange", () => {
      this.stopStationAnimation();
      if (!document.hidden && this.visible) {
        this.stationMotion.reset();
        this.stationPresentationKey = "";
        this.render();
      }
    });
    this.reducedMotion.addEventListener("change", () => {
      this.stopStationAnimation();
      if (this.visible) this.render();
    });
    mountMapStylePicker(el("navigation-style-control"), "navigation");
    el("navigation-center").append(icon("crosshair"));
    const toggle = el("navigation-details-toggle");
    const expand = icon("chevron");
    expand.classList.add("navigation-expand");
    toggle.append(expand);
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
    el("navigation-phases").onkeydown = (event) => {
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
    };
    el("navigation-alert-open").onclick = () => this.openNotice();
    this.mobile.addEventListener("change", () => {
      stopMotion(el("navigation-panel"));
      this.render();
    });
    el("navigation-audio").onclick = () => {
      this.guidance.toggle();
      this.voiceMessage = "";
      if (this.session?.engine && this.guidance.enabled)
        this.guidance.speak(
          `unmute-${Date.now()}`,
          this.session.engine.instruction,
        );
      this.render();
    };
    el("navigation-center").onclick = () => this.map?.center();
    el("navigation-end").onclick = () => this.confirmEnd();
    el("navigation-finish-close").onclick = () => this.exit();
    el("navigation-replan").onclick = () => this.restart(true);
    el("navigation-retry").onclick = () => {
      if (!this.session?.engine) this.restart(false);
      else if (this.session.engine.leg.kind === "stop")
        void this.session.continueStop();
      else if (this.session.disruption) void this.session.proposeAlternative();
      else void this.session.reroute();
    };
    el("navigation-complete").onclick = () => {
      const engine = this.session?.engine;
      if (!engine || !this.completionAvailable || this.session?.busy) return;
      if (engine.leg.kind === "stop") {
        void this.session!.continueStop();
        return;
      }
      const id = engine.leg.navigationId!;
      this.confirm(
        "Abschnitt beenden?",
        `${engine.instruction} bei ${engine.leg.to.name} abschließen?`,
        () => this.session?.completeLeg(id),
      );
    };
    el("navigation-accept").onclick = async () => {
      const previous = this.session?.engine;
      await this.session?.acceptAlternative();
      if (this.session?.engine !== previous) {
        this.selectedSectionId = undefined;
        if (this.detailsOpen) this.setDetails(false);
        else this.render();
      }
    };
    el("navigation-dismiss").onclick = () => this.session?.dismissAlternative();
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
    const changed = id !== this.selectedSectionId;
    this.selectedSectionId = id;
    this.render();
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
    const following =
      !this.selectedSectionId ||
      this.selectedSectionId === this.currentSectionId;
    if (
      following ||
      !this.sections.some((s) => s.id === this.selectedSectionId)
    )
      this.selectedSectionId = current?.id;
    const currentChanged = this.currentSectionId !== current?.id;
    this.currentSectionId = current?.id;
    const selected = this.sections.find((s) => s.id === this.selectedSectionId);
    const phases = el("navigation-phases");
    const key = JSON.stringify(this.sections.map((s) => s.id));
    const scrollLeft = phases.scrollLeft;
    const tabsChanged = key !== this.tabsKey;
    if (tabsChanged) {
      this.tabsKey = key;
      const focused = phases.contains(document.activeElement);
      phases.replaceChildren(
        ...this.sections.map((section, index) => {
          const tab = node("button", "", "navigation-phase");
          tab.type = "button";
          tab.id = `navigation-tab-${index}`;
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", "navigation-section-detail");
          const symbol = node("span", "", "navigation-phase-symbol");
          symbol.setAttribute("aria-hidden", "true");
          tab.append(symbol, node("span", "", "navigation-phase-label"));
          tab.onclick = () => this.selectSection(section.id);
          return tab;
        }),
      );
      // A replan may remove the focused section. Keep focus in the tab strip.
      if (focused)
        (
          phases.children[this.sections.findIndex((s) => s === selected)] as
            HTMLElement | undefined
        )?.focus({ preventScroll: true });
    }
    this.sections.forEach((section, index) => {
      const tab = phases.children[index] as HTMLButtonElement;
      const isCurrent = section === current,
        isSelected = section === selected;
      tab.classList.toggle("current", isCurrent);
      tab.setAttribute("aria-selected", String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      if (isCurrent) tab.setAttribute("aria-current", "step");
      else tab.removeAttribute("aria-current");
      const symbol = tab.querySelector<HTMLElement>(
        ".navigation-phase-symbol",
      )!;
      const symbolName =
        section.main.kind === "transit" &&
        ["BUS", "COACH"].includes(section.main.mode ?? "")
          ? "bus"
          : section.main.kind;
      if (symbol.dataset.icon !== symbolName) {
        symbol.dataset.icon = symbolName;
        symbol.replaceChildren(icon(symbolName));
      }
      tab.querySelector(".navigation-phase-label")!.textContent =
        sectionLabel(section);
      tab.setAttribute(
        "aria-label",
        `${sectionLabel(section)} nach ${section.main.to.name} · Abschnitt ${index + 1} von ${this.sections.length}`,
      );
    });
    if (tabsChanged) phases.scrollLeft = scrollLeft;
    el("navigation-stage").textContent = selected
      ? `${sectionLabel(selected)} · Abschnitt ${this.sections.indexOf(selected) + 1} von ${this.sections.length}`
      : "";
    const panel = el("navigation-section-detail");
    if (selected) panel.setAttribute("aria-labelledby", this.selectedTab()!.id);
    else panel.removeAttribute("aria-labelledby");
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
      const content = el("navigation-section-content");
      content.replaceChildren();
      content.dataset.section = selected?.id ?? "";
      if (engine && selected) {
        const list = renderJourneyDetails(
          { ...engine.journey, legs: selected.legs },
          false,
        );
        if (["fold", "unfold"].includes(selected.main.kind))
          list
            .querySelector(`[data-kind="${selected.main.kind}"]`)!
            .classList.remove("detail-preparation");
        if (movement(selected.main)) {
          const meters = selected.main.distance;
          const distance =
            meters >= 1000
              ? `${(meters / 1000).toFixed(1)} km`
              : `${Math.round(meters)} m`;
          const step = list.querySelector<HTMLElement>(
            `[data-kind="${selected.main.kind}"]`,
          )!;
          if (compactMovement) {
            step.classList.add("navigation-current-movement");
            step.replaceChildren(
              node(
                "small",
                `Geplant: ${duration(selected.main.end - selected.main.start)} · ${distance}`,
                "navigation-section-summary",
              ),
            );
          } else step.querySelector(".detail-meta")!.append(` · ${distance}`);
        }
        // Routine data-source labels are omitted; transit warnings remain separate.
        for (const source of list.querySelectorAll(".detail-source"))
          source.remove();
        if (!currentTransit) content.append(list);
      }
      el("navigation-details").scrollTop = selectionChanged ? 0 : scrollTop;
    }
    return { current, selected, revealCurrent: currentChanged || tabsChanged };
  }
  private renderSectionPreview(selected?: NavigationSection) {
    const preview = el("navigation-section-preview");
    const engine = this.session?.engine;
    preview.hidden =
      !this.mobile.matches ||
      this.detailsOpen ||
      !selected ||
      engine?.phase !== "active" ||
      (selected.id === this.currentSectionId &&
        selected.main.kind === "transit");
    const description = !preview.hidden
      ? "navigation-section-preview-title navigation-section-preview-meta navigation-section-preview-place"
      : !el("navigation-context").hidden
        ? "navigation-context-title navigation-context-detail navigation-context-status navigation-remaining"
        : "navigation-stage navigation-remaining";
    const toggle = el("navigation-details-toggle");
    if (toggle.getAttribute("aria-describedby") !== description)
      toggle.setAttribute("aria-describedby", description);
    if (preview.hidden || !selected || !engine) return;
    const leg = selected.main;
    preview.dataset.section = selected.id;
    preview.dataset.kind = leg.kind;
    preview.setAttribute("aria-labelledby", this.selectedTab()!.id);
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
        text.textContent = messages[index];
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
    this.root.dataset.transitContext = String(!!leg);
    this.root.dataset.onboard = String(onboard);
    let title = "",
      detail = "",
      status = "";
    const confirmedIndex = onboard ? engine.transitStopIndex : -1;
    const index = estimate?.stopIndex ?? confirmedIndex;
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
        title =
          estimate?.source === "estimated" && estimate.phase === "dwell"
            ? `Voraussichtlich an: ${stops?.[estimate.fromIndex].name}`
            : leg.transitStatus?.cancelled
              ? `${leg.line || "ÖPNV"} · ${transitCancellationMessage(leg)}`
              : !stops
                ? "Stationsdaten nicht verfügbar"
                : index === stops.length - 1 && confirmed
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
                : "Stationsstand geschätzt";
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
    context.hidden = !showContext;
    el("navigation-context-slot").hidden = !showContext;
    el("navigation-context-title").hidden = hasStations;
    el("navigation-context-detail").hidden = hasStations;
    const stationStatus = el("navigation-station-status");
    stationStatus.textContent =
      onboard && viewed?.navigationId === engine.leg.navigationId ? status : "";
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
      if (element.textContent !== text) element.textContent = text;
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
      announcement.textContent = message;
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
            this.session?.engine?.transitStopIndex,
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
    const move = (id: string, parent: string, first = false) => {
      const element = el(id),
        container = el(parent);
      if (element.parentElement === container) return;
      const focused = element.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)
        : undefined;
      if (first) container.prepend(element);
      else container.append(element);
      focused?.focus({ preventScroll: true });
    };
    move(
      "navigation-context",
      mobile ? "navigation-details-toggle" : "navigation-context-slot",
      mobile,
    );
    move(
      "navigation-guidance",
      mobile ? "navigation-top" : "navigation-panel",
      true,
    );
    move(
      "navigation-phases",
      mobile ? "navigation-phases-slot" : "navigation-top",
    );
    move(
      "navigation-end",
      mobile ? "navigation-end-slot" : "navigation-detail-actions",
    );
    move(
      "navigation-complete",
      mobile ? "navigation-quick-actions" : "navigation-detail-actions",
      true,
    );
    for (const id of ["navigation-retry", "navigation-replan"])
      move(
        id,
        mobile ? "navigation-quick-actions" : "navigation-detail-actions",
      );
    const details = el("navigation-details");
    if (mobile && !this.detailsOpen && details.contains(document.activeElement))
      el("navigation-details-toggle").focus({ preventScroll: true });
    details.hidden = mobile && !this.detailsOpen;
    this.root.dataset.details = String(this.detailsOpen);
    el("navigation-details-toggle").setAttribute(
      "aria-expanded",
      String(this.detailsOpen),
    );
    el("navigation-details-toggle").setAttribute(
      "aria-label",
      this.detailsOpen ? "Reisedetails schließen" : "Reisedetails öffnen",
    );
    const end = el("navigation-end");
    const arrived = this.session?.engine?.phase === "arrived";
    const label = arrived ? "Fahrt abschließen" : "Navigation beenden";
    end.setAttribute("aria-label", label);
    end.title = label;
    if (mobile && !arrived) end.replaceChildren(icon("close"));
    else end.textContent = label;
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
    this.root.hidden = false;
    this.phaseKey = "";
    this.guidance.reset();
    this.guidance.speak("start", "Navigation wird vorbereitet");
    this.render();
    settle(el("navigation-panel"), 0, 14);
    if (!this.map && !this.loading) {
      this.loading = import("./navigation-map")
        .then(({ NavigationMap }) => {
          if (!this.visible) return;
          delete el("navigation-map").dataset.loadError;
          el("navigation-map").setAttribute(
            "aria-label",
            "Navigationskarte in Fahrtrichtung",
          );
          this.map = new NavigationMap(
            el("navigation-map"),
            el("navigation-panel"),
            el("navigation-top"),
            (following) => {
              const button = el("navigation-center");
              const label = following
                ? "Navigation zentrieren"
                : "Standort folgen";
              button.setAttribute("aria-label", label);
              button.setAttribute("title", label);
              button.setAttribute("aria-pressed", String(following));
            },
          );
        })
        .catch(() => {
          el("navigation-map").dataset.loadError = "true";
          el("navigation-map").setAttribute(
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
      this.map?.center();
      this.render();
    }
  }
  hide() {
    this.stopStationAnimation();
    this.stationMotion.reset();
    this.stationSample = undefined;
    this.stationCursor = undefined;
    this.stationPresentationKey = "";
    stopMotionWithin(this.root);
    closeMapStylePickers();
    this.root.hidden = true;
    this.guidance.reset();
    this.phaseKey = "";
    this.confirmationTrigger = undefined;
    el<HTMLDialogElement>("navigation-confirm").close();
    this.map?.dispose();
    this.map = undefined;
    this.finishedMap = undefined;
    for (const list of this.stationLists) list.update(undefined, -1);
  }
  pause() {
    this.guidance.cancel();
  }
  confirmEnd() {
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
    dialog.dataset.kind = options.endNavigation ? "end" : "section";
    el("navigation-confirm-title").textContent = title;
    el("navigation-confirm-message").textContent = message;
    const yes = el<HTMLButtonElement>("navigation-confirm-yes");
    const no = el<HTMLButtonElement>("navigation-confirm-no");
    yes.textContent = options.confirmLabel ?? "Bestätigen";
    no.textContent = options.cancelLabel ?? "Abbrechen";
    if (options.endNavigation) yes.before(no);
    else no.before(yes);
    no.autofocus = !!options.endNavigation;
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
  }
  render() {
    const session = this.session;
    if (!session || !this.visible) return;
    const engine = session.engine,
      arrived = engine?.phase === "arrived",
      leg = engine?.leg;
    const enteringSummary = this.root.dataset.arrived !== "true";
    this.root.dataset.arrived = String(!!arrived);
    if (arrived) {
      this.stopStationAnimation();
      this.stationSample = undefined;
      this.stationCursor = undefined;
      this.stationMotion.reset();
      this.stationPresentationKey = "";
    }
    el("navigation-finish").hidden = !arrived;
    el("navigation-panel").setAttribute(
      "aria-label",
      arrived ? "Fahrtzusammenfassung" : "Navigationshinweise",
    );
    if (arrived && session.summary) {
      const summary = session.summary;
      const kilometers = (meters: number) =>
        `${(meters / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
      el("navigation-instruction").textContent = "Ziel erreicht";
      el("navigation-finish-origin").textContent = summary.originName;
      el("navigation-finish-destination").textContent = summary.destinationName;
      el("navigation-finish-time").textContent = duration(
        summary.elapsedSeconds,
      );
      el("navigation-finish-distance").textContent = kilometers(
        summary.distanceMeters,
      );
      el("navigation-finish-resumed").hidden = !summary.sinceResume;
      el("navigation-finish-totals").hidden = !session.statistics;
      if (session.statistics) {
        el("navigation-finish-count").textContent =
          session.statistics.completedIds.length.toLocaleString("de-DE");
        el("navigation-finish-total-distance").textContent = kilometers(
          session.statistics.distanceMeters,
        );
        el("navigation-finish-total-time").textContent = duration(
          session.statistics.elapsedSeconds,
        );
      }
      const storage = el("navigation-finish-storage");
      if (storage.textContent !== session.statisticsMessage)
        storage.textContent = session.statisticsMessage;
      if (enteringSummary) {
        this.dismissConfirmation();
        const support = el("navigation-support-links");
        support.replaceChildren();
        for (const provider of supportProviders) {
          if (!provider.url) continue;
          const link = node("a", provider.label);
          link.setAttribute(
            "aria-label",
            provider.label === provider.name
              ? `Über ${provider.name} unterstützen`
              : `${provider.label} (über ${provider.name})`,
          );
          link.href = provider.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          const external = node("span", "↗");
          external.setAttribute("aria-hidden", "true");
          link.append(external);
          support.append(link);
        }
        el("navigation-support").hidden = !support.childElementCount;
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
        ? () => stationCursor(leg, floor, confirmedIndex, "gps", "ride", key)
        : timeline
          ? (wall: number) => timeline.sample(wall, confirmedIndex, floor)
          : () =>
              stationCursor(
                leg,
                floor,
                confirmedIndex,
                "estimated",
                "unclear",
                key,
              );
      const presentationKey = JSON.stringify([
        key,
        confirmed,
        floor,
        confirmedIndex,
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
      const mapLocated =
        session.hasCurrentLocation && engine.hasTransitLocation;
      if (timeline && this.transitPath && !mapLocated)
        estimateSource = {
          timeline,
          path: this.transitPath,
          confirmedIndex,
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
    el("navigation-instruction").textContent =
      engine && !arrived && leg?.kind === "bike" && !engine.maneuver
        ? `Nach ${leg.to.name}`
        : (engine?.instruction ??
          (session.busy || !session.message
            ? "Navigation wird vorbereitet …"
            : "Navigation konnte nicht starten"));
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
    arrow.replaceChildren();
    if (engine?.phase === "active" && leg?.kind === "transit") {
      arrow.append(
        icon(["BUS", "COACH"].includes(leg.mode ?? "") ? "bus" : "transit"),
      );
    } else
      arrow.textContent = arrived
        ? "✓"
        : engine?.maneuver
          ? (arrows[engine.maneuver.direction] ?? "↑")
          : leg?.kind === "transit"
            ? "⇥"
            : leg?.kind === "stop"
              ? "●"
              : "↑";
    const meters = engine?.distanceToNext;
    el("navigation-distance").textContent =
      arrived || leg?.kind === "transit" || meters === undefined
        ? ""
        : meters >= 1000
          ? `${(meters / 1000).toFixed(1)} km`
          : `${Math.round(meters / 5) * 5} m`;
    el("navigation-detail").textContent =
      leg?.kind === "transit"
        ? ""
        : leg?.kind === "stop"
          ? `Weiterfahrt ${clock(leg.end)} · Bestätige, wenn du bereit bist.`
          : movement(leg) &&
              !leg?.maneuvers?.length &&
              !engine?.hasManeuverGuidance
            ? ""
            : (leg?.to.name ?? "");
    const { current, selected, revealCurrent } = this.renderSections();
    el("navigation-status").textContent = session.resumeNeedsConfirmation
      ? "Zeitpunkt dieses Abschnitts liegt zurück. Prüfe und bestätige deinen aktuellen Abschnitt."
      : session.message;
    el("navigation-storage-status").textContent = session.storageMessage;
    el("navigation-disruption").textContent =
      session.disruption?.message ?? session.assessment?.message ?? "";
    const invalidLocation = !session.hasCurrentLocation;
    const automaticLocationRefresh =
      session.foreground &&
      !!this.options.locationAutoRefresh?.() &&
      session.locationError?.reason !== "permission-denied";
    const gpsStatus = el("navigation-gps-status");
    const mapEstimateLabel = estimateSource
      ? estimateSource.path.schematic
        ? "Kartenposition grob geschätzt"
        : "Kartenposition geschätzt"
      : "";
    const gpsMessage =
      engine && !arrived && invalidLocation
        ? session.locationQuality === "inaccurate"
          ? "GPS ungenau"
          : "Kein GPS"
        : mapEstimateLabel
          ? mapEstimateLabel
          : "";
    const gpsEstimate = invalidLocation ? mapEstimateLabel : "";
    for (const [id, message] of [
      ["navigation-gps-primary", gpsMessage],
      ["navigation-gps-estimate", gpsEstimate],
    ]) {
      const text = el(id);
      if (text.textContent !== message) text.textContent = message;
    }
    const gpsEstimateText = el("navigation-gps-estimate");
    if (gpsEstimateText.hidden !== !gpsEstimate)
      gpsEstimateText.hidden = !gpsEstimate;
    if (gpsStatus.hidden !== !gpsMessage) gpsStatus.hidden = !gpsMessage;
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
    setLocationFeedback(locationStatus, locationMessage, !session.locating);
    el("navigation-network-status").textContent = navigator.onLine
      ? ""
      : "Offline · Streckenverlauf verfügbar. Neue Routen und Fahrtdaten benötigen Internet.";
    const transit = engine?.journey.legs
      .slice(engine.progress.legIndex)
      .find((l) => l.kind === "transit");
    this.renderTransitContext(
      transit,
      selected?.main,
      cursor,
      !!mapEstimateLabel,
    );
    this.renderSectionPreview(selected);
    if (cursor) for (const list of this.stationLists) list.setPosition(cursor);
    this.startStationAnimation();
    const viewedTransit = selected?.legs.find((l) => l.kind === "transit");
    const viewedTransitWarning = transitWarning(viewedTransit);
    el("navigation-transit-status").textContent = viewedTransitWarning;
    const currentTransitWarning = transitWarning(transit);
    el("navigation-current-transit-status").textContent =
      transit !== viewedTransit ? currentTransitWarning : "";
    const complete = el<HTMLButtonElement>("navigation-complete");
    complete.hidden = !this.completionAvailable;
    complete.disabled = session.busy;
    complete.textContent =
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
    const locationRetry = !engine && session.needsLocation;
    el("navigation-retry").hidden =
      !session.retryAvailable ||
      locationRetry ||
      (invalidLocation && !!session.locationError);
    el("navigation-replan").hidden = !session.distantStart;
    el("navigation-locate").hidden =
      arrived === true ||
      (engine
        ? (!invalidLocation || automaticLocationRefresh) &&
          !session.alternativeNeedsLocation &&
          !session.locating
        : !locationRetry || !session.retryAvailable);
    el<HTMLButtonElement>("navigation-locate").disabled =
      session.busy || session.locating;
    el("navigation-locate").textContent = session.locating
      ? "Standort wird gesucht …"
      : "Standort erneut anfragen";
    el("navigation-location").hidden =
      !locationMessage && el("navigation-locate").hidden;
    el("navigation-end").textContent = arrived
      ? "Fahrt abschließen"
      : "Navigation beenden";
    el("navigation-audio").replaceChildren(
      icon(this.guidance.enabled ? "volume" : "muted"),
    );
    el("navigation-audio").setAttribute(
      "title",
      this.guidance.enabled ? "Ton ausschalten" : "Ton einschalten",
    );
    el("navigation-audio").setAttribute(
      "aria-label",
      this.guidance.enabled ? "Ton ausschalten" : "Ton einschalten",
    );
    el("navigation-audio").setAttribute(
      "aria-pressed",
      String(this.guidance.enabled),
    );
    el("navigation-audio-status").textContent = this.voiceMessage;
    el("navigation-alternative").hidden = !session.alternative;
    const accept = el<HTMLButtonElement>("navigation-accept");
    accept.disabled = session.busy;
    accept.textContent = session.busy
      ? "Verbindung wird geprüft …"
      : "Verbindung übernehmen";
    if (session.alternative) {
      const j = session.alternative.journey;
      el("navigation-alternative-text").textContent =
        `Neue Verbindung: Ankunft ${clock(j.arrival)} · ${duration(j.arrival - j.departure)}`;
    }
    el("navigation-remaining").textContent = engine
      ? arrived
        ? "Ziel erreicht"
        : ""
      : "Navigation";
    el("navigation-remaining").hidden = !!engine && !arrived;
    el("navigation-summary-label").hidden =
      !engine || !!arrived || !el("navigation-context").hidden;
    const requestedArrival =
      session.request?.timing === "arrive" ? session.request.time : undefined;
    const arrivalWarning =
      engine &&
      !arrived &&
      requestedArrival !== undefined &&
      engine.journey.arrival > requestedArrival
        ? `Gewünschte Ankunft ${clock(requestedArrival)} wird nicht erreicht.`
        : "";
    el("navigation-arrival-warning").textContent = arrivalWarning;
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
        message: session.alternative ? "" : session.message,
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
    alert.hidden = !notices.length && !session.alternative;
    const summary = notices[0]?.message ?? "Neue Verbindung verfügbar";
    const summaryText = el("navigation-alert-summary");
    if (summaryText.textContent !== summary) summaryText.textContent = summary;
    const clearNotice = (target: string, replacement: HTMLElement) => {
      const element = el(target);
      const focused = element === document.activeElement;
      element.textContent = "";
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
    const cancellationSummary = engine?.journey.legs.some(
      (leg) => leg.transitStatus?.cancelled && transitWarning(leg) === summary,
    );
    if (
      this.mobile.matches &&
      cancellationSummary &&
      primary &&
      el(primary.target).textContent === primary.message
    )
      clearNotice(primary.target, summaryText);
    this.noticeTarget = session.alternative
      ? "navigation-alternative"
      : notices.find((notice) => el(notice.target).textContent)?.target;
    const alertOpen = el("navigation-alert-open");
    alertOpen.hidden = !engine || !this.noticeTarget;
    alertOpen.textContent = session.alternative
      ? `Verbindung ansehen${notices.length > 1 ? ` · ${notices.length} Hinweise` : ""}`
      : notices.length > 1
        ? `${notices.length} Hinweise ansehen`
        : "Details ansehen";
    this.layout();
    // Reveal progress after placing the strip, even while previewing another step.
    if (revealCurrent) this.alignCurrentTab();
    if (!engine) return;
    const phaseKey = `${engine.journey.legs.map((l) => l.navigationId).join("|")}-${engine.leg.navigationId}-${engine.phase}`;
    if (this.phaseKey !== phaseKey) {
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
      if (engine.maneuver && (engine.distanceToNext ?? Infinity) <= 100)
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
    );
  }
}
