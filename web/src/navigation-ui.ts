import type { NavigationSession } from "./navigation-session";
import {
  reveal,
  settle,
  stopMotion,
  stopMotionWithin,
  motionTime,
} from "./motion";
import type { NavigationMap } from "./navigation-map";
import { NavigationGuidance } from "./navigation-guidance";
import { clock, duration, el, node, icon } from "./ui";
import type { Leg } from "./model";
import { movement, freshTransit } from "./navigation-engine";
import { renderJourneyDetails } from "./journey-detail";
import { closeMapStylePickers, mountMapStylePicker } from "./map-style-picker";
import {
  navigationSections,
  sectionLabel,
  type NavigationSection,
} from "./navigation-sections";

const transitStatus = (transit: Leg) =>
  `${transit.transitStatus?.failure === "network" ? "Abruf fehlgeschlagen" : transit.transitStatus?.failure === "unavailable" ? "Aktualisierung nicht verfügbar" : !freshTransit(transit, Date.now() / 1000) ? "Fahrtdaten veraltet" : transit.realtime ? "Echtzeit" : "Fahrplan"}${transit.transitStatus?.updatedAt ? ` · Stand ${clock(transit.transitStatus.updatedAt)}` : ""}`;

export class NavigationView {
  readonly root: HTMLElement;
  private map?: NavigationMap;
  private loading?: Promise<void>;
  private session?: NavigationSession;
  private voiceMessage = "";
  private phaseKey = "";
  private mobile = matchMedia("(max-width: 899px)");
  private detailsOpen = false;
  private sections: NavigationSection[] = [];
  private selectedSectionId?: string;
  private currentSectionId?: string;
  private tabsKey = "";
  private sectionDetailKey = "";
  private dragY?: number;
  private confirmationTrigger?: HTMLElement;
  private guidance = new NavigationGuidance((message) => {
    this.voiceMessage = message;
    el("navigation-audio-status").textContent = message;
  });
  constructor(
    private exit: () => void,
    private restart: (replan: boolean) => void,
  ) {
    this.root = node("section", "", "navigation-screen");
    this.root.id = "navigation-view";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Aktive Navigation");
    this.root.innerHTML = `
      <div id="navigation-map" tabindex="0" aria-label="Navigationskarte in Fahrtrichtung"></div>
      <div class="navigation-top" id="navigation-top"><div id="navigation-phases" role="tablist" aria-label="Reiseabschnitte"></div></div>
      <div id="navigation-gps-status" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      <div class="navigation-map-controls" role="group" aria-label="Kartensteuerung">
        <button id="navigation-audio" class="navigation-icon-button secondary" type="button" aria-label="Ton ausschalten" title="Ton ausschalten"></button>
        <button id="navigation-center" class="navigation-center navigation-icon-button secondary" type="button" aria-label="Navigation zentrieren" title="Navigation zentrieren" aria-pressed="true"></button>
        <div id="navigation-style-control"></div>
      </div>
      <div class="navigation-credit"><a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-Mitwirkende</a> · <a href="https://transitous.org/sources/">Fahrtdaten</a></div>
      <article class="navigation-panel" id="navigation-panel" aria-label="Navigationshinweise">
        <div class="navigation-instruction" id="navigation-guidance"><span id="navigation-arrow" aria-hidden="true">↑</span><div><strong id="navigation-distance"></strong><h1 id="navigation-instruction" tabindex="-1">Navigation wird vorbereitet …</h1><p id="navigation-detail"></p></div></div>
        <div id="navigation-alert" hidden><p id="navigation-alert-summary" role="status"></p><button id="navigation-alert-open" class="secondary" type="button">Details</button></div>
        <div id="navigation-summary">
          <button id="navigation-details-toggle" type="button" aria-expanded="false" aria-controls="navigation-details"><span class="navigation-grip" aria-hidden="true"></span><strong id="navigation-remaining"></strong><span id="navigation-summary-arrival"></span><span class="navigation-expand" aria-hidden="true">⌃</span></button>
          <div id="navigation-end-slot"></div>
        </div>
        <div id="navigation-phases-slot"></div>
        <div id="navigation-quick-actions" class="navigation-actions"></div>
        <div id="navigation-details">
        <div id="navigation-section-detail" role="tabpanel" tabindex="0">
          <div class="navigation-arrival"><span id="navigation-stage"></span><strong id="navigation-arrival"></strong></div>
          <div id="navigation-section-content"></div>
        </div>
        <div id="navigation-location" hidden><p id="navigation-location-status" role="status"></p><div class="navigation-actions"><button id="navigation-locate" class="secondary" hidden>Standort erneut anfragen</button></div></div>
        <p id="navigation-network-status"></p>
        <p id="navigation-transit-status"></p><p id="navigation-status" role="status"></p><p id="navigation-disruption" role="status"></p>
        <div id="navigation-alternative" hidden><p id="navigation-alternative-text"></p><button id="navigation-accept" class="primary">Verbindung übernehmen</button><button id="navigation-dismiss" class="secondary">Bisherige behalten</button></div>
        <p id="navigation-storage-status"></p><p id="navigation-audio-status"></p>
        <div class="navigation-actions" id="navigation-detail-actions"><button id="navigation-complete" class="primary" hidden>Abschnitt fertig</button><button id="navigation-retry" class="primary" hidden>Erneut versuchen</button><button id="navigation-replan" class="primary" hidden>Route ab hier planen</button><button id="navigation-end" class="secondary">Navigation beenden</button></div>
        </div>
      </article>
      <dialog id="navigation-confirm" aria-labelledby="navigation-confirm-title" aria-describedby="navigation-confirm-message"><h2 id="navigation-confirm-title"></h2><p id="navigation-confirm-message"></p><div class="navigation-actions"><button id="navigation-confirm-yes" class="primary" type="button">Bestätigen</button><button id="navigation-confirm-no" class="secondary" type="button">Abbrechen</button></div></dialog>`;
    el("main").append(this.root);
    mountMapStylePicker(el("navigation-style-control"), "navigation");
    el("navigation-center").append(icon("crosshair"));
    const toggle = el("navigation-details-toggle");
    toggle.onclick = () => this.setDetails(!this.detailsOpen);
    toggle.onpointerdown = (event) => {
      stopMotion(el("navigation-panel"));
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
    el("navigation-alert-open").onclick = () => this.setDetails(true);
    this.mobile.addEventListener("change", () => this.render());
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
      if (
        !engine ||
        !this.sections
          .find((section) => section.id === this.selectedSectionId)
          ?.legs.some((leg) => leg.navigationId === engine.leg.navigationId)
      )
        return;
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
      if (this.session?.engine !== previous) this.setDetails(false);
    };
    el("navigation-dismiss").onclick = () => this.session?.dismissAlternative();
  }
  private setDetails(open: boolean) {
    if (open === this.detailsOpen) return;
    const panel = el("navigation-panel");
    const before = panel.getBoundingClientRect().top;
    stopMotion(panel);
    this.detailsOpen = open;
    const details = el("navigation-details");
    const focusedTab = el("navigation-phases").contains(document.activeElement);
    if (!open) this.selectedSectionId = this.currentSectionId;
    if (!open && details.contains(document.activeElement))
      el("navigation-details-toggle").focus({ preventScroll: true });
    this.render();
    if (this.mobile.matches)
      settle(
        panel,
        0,
        before - panel.getBoundingClientRect().top,
        open ? motionTime.panel : motionTime.exit,
      );
    if (!open) {
      const tab = this.selectedTab();
      if (focusedTab) tab?.focus({ preventScroll: true });
      this.alignCurrentTab();
    }
  }
  private selectedTab() {
    return el("navigation-phases").querySelector<HTMLButtonElement>(
      '[aria-selected="true"]',
    );
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
    const opening = !this.detailsOpen;
    this.selectedSectionId = id;
    if (opening) this.setDetails(true);
    else this.render();
    const tab = this.selectedTab();
    if (focus) tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (changed)
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
    const detailKey = JSON.stringify([
      engine?.journey.departure,
      engine?.journey.arrival,
      selected,
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
          list
            .querySelector(
              '[data-kind="bike"] .detail-meta, [data-kind="walk"] .detail-meta',
            )
            ?.append(
              ` · ${meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`}`,
            );
        }
        content.append(list);
      }
      el("navigation-details").scrollTop = selectionChanged ? 0 : scrollTop;
    }
    return { current, selected, revealCurrent: currentChanged || tabsChanged };
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
      mobile && this.session?.engine?.leg.kind === "stop"
        ? "navigation-quick-actions"
        : "navigation-detail-actions",
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
    stopMotionWithin(this.root);
    closeMapStylePickers();
    this.root.hidden = true;
    this.guidance.reset();
    this.phaseKey = "";
    this.confirmationTrigger = undefined;
    el<HTMLDialogElement>("navigation-confirm").close();
    this.map?.dispose();
    this.map = undefined;
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
    el("navigation-instruction").textContent =
      engine?.instruction ??
      (session.busy || !session.message
        ? "Navigation wird vorbereitet …"
        : "Navigation konnte nicht starten");
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
    el("navigation-arrow").textContent = arrived
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
      arrived || meters === undefined
        ? ""
        : meters >= 1000
          ? `${(meters / 1000).toFixed(1)} km`
          : `${Math.round(meters / 5) * 5} m`;
    el("navigation-detail").textContent =
      leg?.kind === "transit"
        ? `${leg.platform ? `Gleis ${leg.platform} · ` : ""}Ausstieg ${leg.to.name}${leg.arrivalPlatform ? ` · Gleis ${leg.arrivalPlatform}` : ""}`
        : leg?.kind === "stop"
          ? `Weiterfahrt ${clock(leg.end)} · Bestätige, wenn du bereit bist.`
          : movement(leg) &&
              !leg?.maneuvers?.length &&
              !engine?.hasManeuverGuidance
            ? "Keine Abbiegehinweise für diesen Abschnitt. Folge dem Streckenverlauf."
            : (leg?.to.name ?? "");
    const { current, selected, revealCurrent } = this.renderSections();
    el("navigation-arrival").textContent = engine
      ? `Ankunft ${clock(engine.journey.arrival)}`
      : "";
    el("navigation-status").textContent = session.resumeNeedsConfirmation
      ? "Zeitpunkt dieses Abschnitts liegt zurück. Prüfe und bestätige deinen aktuellen Abschnitt."
      : session.message;
    el("navigation-storage-status").textContent = session.storageMessage;
    el("navigation-disruption").textContent =
      session.disruption?.message ?? session.assessment?.message ?? "";
    const invalidLocation = !session.hasCurrentLocation;
    const gpsStatus = el("navigation-gps-status");
    const gpsMessage =
      engine && !arrived && invalidLocation
        ? session.locationQuality === "inaccurate"
          ? "GPS ungenau"
          : "Kein GPS"
        : "";
    if (gpsStatus.textContent !== gpsMessage)
      gpsStatus.textContent = gpsMessage;
    gpsStatus.hidden = !gpsMessage;
    const locationMessage =
      !engine || arrived
        ? ""
        : session.locating
          ? "Standort wird gesucht …"
          : (session.locationError?.message ??
            (invalidLocation
              ? `${!session.fix ? "Kein Standort verfügbar." : session.locationQuality === "inaccurate" ? "Standort zu ungenau." : "Letzter Standort nicht aktuell."} Automatischer Fortschritt pausiert.`
              : ""));
    const locationStatus = el("navigation-location-status");
    if (locationStatus.textContent !== locationMessage)
      locationStatus.textContent = locationMessage;
    el("navigation-network-status").textContent = navigator.onLine
      ? ""
      : "Offline · Streckenverlauf verfügbar. Neue Routen und Fahrtdaten benötigen Internet.";
    const transit = engine?.journey.legs
      .slice(engine.progress.legIndex)
      .find((l) => l.kind === "transit");
    const viewedTransit =
      selected?.legs.find((l) => l.kind === "transit") ??
      (selected === current ? transit : undefined);
    el("navigation-transit-status").textContent = viewedTransit
      ? `${viewedTransit.line || "ÖPNV"} · ${transitStatus(viewedTransit)}`
      : "";
    const complete = el<HTMLButtonElement>("navigation-complete");
    complete.hidden = !engine || arrived === true || selected !== current;
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
        ? !invalidLocation &&
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
        : duration(Math.max(0, engine.journey.arrival - Date.now() / 1000))
      : "Navigation";
    el("navigation-summary-arrival").textContent =
      engine && !arrived ? `Ankunft ${clock(engine.journey.arrival)}` : "";
    if (
      engine &&
      !arrived &&
      session.request?.timing === "arrive" &&
      engine.journey.arrival > session.request.time
    ) {
      const target = ` · Gewünscht bis ${clock(session.request.time)}`;
      el("navigation-summary-arrival").textContent += target;
      el("navigation-arrival").textContent += target;
    }
    const notices = [
      session.disruption?.message ?? session.assessment?.message ?? "",
      !navigator.onLine ? "Offline · Neue Routen benötigen Internet" : "",
      session.resumeNeedsConfirmation
        ? el("navigation-status").textContent
        : "",
      session.alternative ? "" : session.message,
      transit && !freshTransit(transit, Date.now() / 1000)
        ? `${transit.line || "ÖPNV"} · ${transitStatus(transit)}`
        : "",
      session.storageMessage,
      this.voiceMessage,
    ].filter((message): message is string => !!message);
    const alert = el("navigation-alert");
    alert.hidden = !notices.length && !session.alternative;
    el("navigation-alert-summary").textContent =
      notices[0] ?? "Neue Verbindung verfügbar";
    const alertOpen = el("navigation-alert-open");
    alertOpen.hidden = !engine;
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
    this.map?.update(engine, session.fix, session.locationQuality);
  }
}
