import type { NavigationSession } from "./navigation-session";
import type { NavigationMap } from "./navigation-map";
import { NavigationGuidance } from "./navigation-guidance";
import { clock, duration, el, node, icon } from "./ui";
import { kindNames } from "./model";
import { movement, freshTransit } from "./navigation-engine";

export class NavigationView {
  readonly root: HTMLElement;
  private map?: NavigationMap;
  private loading?: Promise<void>;
  private session?: NavigationSession;
  private voiceMessage = "";
  private phaseKey = "";
  private mobile = matchMedia("(max-width: 899px)");
  private detailsOpen = false;
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
      <div class="navigation-top" id="navigation-top"><div id="navigation-phases" aria-label="Reiseabschnitte"></div></div>
      <div class="navigation-map-controls" role="group" aria-label="Kartensteuerung">
        <button id="navigation-audio" class="navigation-icon-button secondary" type="button" aria-label="Ton ausschalten" title="Ton ausschalten"></button>
        <button id="navigation-center" class="navigation-center navigation-icon-button secondary" type="button" aria-label="Navigation zentrieren" title="Navigation zentrieren" aria-pressed="true"></button>
      </div>
      <div class="navigation-credit"><a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-Mitwirkende</a> · <a href="https://transitous.org/sources/">Fahrtdaten</a></div>
      <article class="navigation-panel" id="navigation-panel" aria-label="Navigationshinweise">
        <div class="navigation-instruction" id="navigation-guidance"><span id="navigation-arrow" aria-hidden="true">↑</span><div><strong id="navigation-distance"></strong><h1 id="navigation-instruction" tabindex="-1">Navigation wird vorbereitet …</h1><p id="navigation-detail"></p></div></div>
        <div id="navigation-alert" hidden><p id="navigation-alert-summary" role="status"></p><button id="navigation-alert-open" class="secondary" type="button">Details</button></div>
        <div id="navigation-summary">
          <button id="navigation-details-toggle" type="button" aria-expanded="false" aria-controls="navigation-details"><span class="navigation-grip" aria-hidden="true"></span><strong id="navigation-remaining"></strong><span id="navigation-summary-arrival"></span><span class="navigation-expand" aria-hidden="true">⌃</span></button>
          <div id="navigation-end-slot"></div>
        </div>
        <div id="navigation-quick-actions" class="navigation-actions"></div>
        <div id="navigation-details">
        <div id="navigation-phases-slot"></div>
        <div class="navigation-arrival"><span id="navigation-stage"></span><strong id="navigation-arrival"></strong></div>
        <p id="navigation-location-status" role="status"></p>
        <p id="navigation-network-status"></p>
        <p id="navigation-transit-status"></p><p id="navigation-status" role="status"></p><p id="navigation-disruption" role="status"></p>
        <div id="navigation-alternative" hidden><p id="navigation-alternative-text"></p><button id="navigation-accept" class="primary">Verbindung übernehmen</button><button id="navigation-dismiss" class="secondary">Bisherige behalten</button></div>
        <p id="navigation-storage-status"></p><p id="navigation-audio-status"></p>
        <div class="navigation-actions" id="navigation-detail-actions"><button id="navigation-complete" class="primary" hidden>Abschnitt fertig</button><button id="navigation-retry" class="primary" hidden>Erneut versuchen</button><button id="navigation-locate" class="secondary" hidden>Standort erneut anfragen</button><button id="navigation-replan" class="primary" hidden>Route ab hier planen</button><button id="navigation-end" class="secondary">Navigation beenden</button></div>
        <small>Navigation bei geöffneter App. Bildschirm eingeschaltet lassen.</small>
        </div>
      </article>
      <dialog id="navigation-confirm" aria-labelledby="navigation-confirm-title" aria-describedby="navigation-confirm-message"><h2 id="navigation-confirm-title"></h2><p id="navigation-confirm-message"></p><div class="navigation-actions"><button id="navigation-confirm-yes" class="primary" type="button">Bestätigen</button><button id="navigation-confirm-no" class="secondary" type="button">Abbrechen</button></div></dialog>`;
    el("main").append(this.root);
    el("navigation-center").append(icon("crosshair"));
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
      if (!engine) return;
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
    this.detailsOpen = open;
    const details = el("navigation-details");
    if (!open && details.contains(document.activeElement))
      el("navigation-details-toggle").focus({ preventScroll: true });
    this.render();
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
    for (const id of [
      "navigation-retry",
      "navigation-locate",
      "navigation-replan",
    ])
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
    if (!this.visible) this.detailsOpen = false;
    this.session = session;
    this.root.hidden = false;
    this.phaseKey = "";
    this.guidance.reset();
    this.guidance.speak("start", "Navigation wird vorbereitet");
    this.render();
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
          : movement(leg) && !leg?.maneuvers?.length
            ? "Keine Abbiegehinweise für diesen Abschnitt. Folge dem Streckenverlauf."
            : (leg?.to.name ?? "");
    el("navigation-stage").textContent = engine
      ? `${kindNames[engine.leg.kind]} · Abschnitt ${engine.progress.legIndex + 1} von ${engine.journey.legs.length}`
      : "";
    el("navigation-arrival").textContent = engine
      ? `Ankunft ${clock(engine.journey.arrival)}`
      : "";
    el("navigation-status").textContent = session.resumeNeedsConfirmation
      ? "Zeitpunkt dieses Abschnitts liegt zurück. Prüfe und bestätige deinen aktuellen Abschnitt."
      : session.message;
    el("navigation-storage-status").textContent = session.storageMessage;
    el("navigation-disruption").textContent =
      session.disruption?.message ?? session.assessment?.message ?? "";
    const invalidLocation = !session.fix || session.fixQuality !== "current";
    el("navigation-location-status").textContent =
      !engine || arrived
        ? ""
        : invalidLocation
          ? "Standort fehlt, ist ungenau oder veraltet. Automatischer Fortschritt pausiert."
          : "";
    el("navigation-network-status").textContent = navigator.onLine
      ? ""
      : "Offline · Streckenverlauf verfügbar. Neue Routen und Fahrtdaten benötigen Internet.";
    const transit = engine?.journey.legs
      .slice(engine.progress.legIndex)
      .find((l) => l.kind === "transit");
    el("navigation-transit-status").textContent = transit
      ? `${transit.transitStatus?.failure === "network" ? "Abruf fehlgeschlagen" : transit.transitStatus?.failure === "unavailable" ? "Aktualisierung nicht verfügbar" : !freshTransit(transit, Date.now() / 1000) ? "Fahrtdaten veraltet" : transit.realtime ? "Echtzeit" : "Fahrplan"}${transit.transitStatus?.updatedAt ? ` · Stand ${clock(transit.transitStatus.updatedAt)}` : ""}`
      : "";
    const complete = el<HTMLButtonElement>("navigation-complete");
    complete.hidden = !engine || arrived === true;
    complete.disabled = session.busy;
    complete.textContent =
      leg?.kind === "stop"
        ? "Weiterfahren"
        : leg?.kind === "transit"
          ? "Ausgestiegen"
          : "Abschnitt fertig";
    const locationRetry = !engine && session.needsLocation;
    el("navigation-retry").hidden = !session.retryAvailable || locationRetry;
    el("navigation-replan").hidden = !session.distantStart;
    el("navigation-locate").hidden =
      arrived === true ||
      (engine
        ? !invalidLocation && !session.alternativeNeedsLocation
        : !locationRetry || !session.retryAvailable);
    el<HTMLButtonElement>("navigation-locate").disabled = session.busy;
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
      engine && !arrived && invalidLocation
        ? "Standort ungenau oder veraltet · Fortschritt pausiert"
        : "",
      session.disruption?.message ?? session.assessment?.message ?? "",
      !navigator.onLine ? "Offline · Neue Routen benötigen Internet" : "",
      session.resumeNeedsConfirmation
        ? el("navigation-status").textContent
        : "",
      session.alternative ? "" : session.message,
      transit && !freshTransit(transit, Date.now() / 1000)
        ? el("navigation-transit-status").textContent
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
    if (!engine) return;
    const phaseKey = `${engine.journey.legs.map((l) => l.navigationId).join("|")}-${engine.leg.navigationId}-${engine.phase}`;
    if (this.phaseKey !== phaseKey) {
      this.phaseKey = phaseKey;
      const phases = el("navigation-phases");
      phases.replaceChildren();
      engine.journey.legs.forEach((l, index) => {
        const part = node(
          "span",
          kindNames[l.kind],
          `navigation-phase ${index === engine.progress.legIndex ? "current" : ""}`,
        );
        if (index === engine.progress.legIndex)
          part.setAttribute("aria-current", "step");
        phases.append(part);
      });
      phases
        .querySelector(".current")
        ?.scrollIntoView({ block: "nearest", inline: "center" });
      this.guidance.speak(
        phaseKey,
        engine.maneuver && engine.distanceToNext !== undefined
          ? `In ${Math.round(engine.distanceToNext / 10) * 10} Metern ${engine.instruction}`
          : engine.instruction,
      );
    }
    if (session.foreground && !session.busy) {
      if (engine.maneuver && (engine.distanceToNext ?? Infinity) <= 100)
        this.guidance.speak(
          `${phaseKey}-turn-${engine.progress.maneuverIndex}`,
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
    this.map?.update(engine, session.fix, session.fixQuality);
  }
}
