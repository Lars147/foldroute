import {
  renderJourneyDetails,
  type JourneyPresentation,
} from "./journey-detail";
import { closeMapStylePickers } from "./map-style-picker";
import {
  type Journey,
  bikeDistance,
  lateDepartureDelay,
  compare,
  cyclingExcess,
  cyclingComparisonLabel,
  journeyEffort,
  journeyOutline,
} from "./model";
import { type PlanningState } from "./planning-state";
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
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private navigation: JourneyNavigation = {
    screen: "list",
    mapReturn: "list",
    positions: {},
  };
  private readonly desktop = matchMedia("(min-width: 900px)");
  private readonly detailPanel = el("panel-details");
  constructor(
    private select: (id: string) => void,
    private readonly presentation: JourneyPresentation = "live",
  ) {
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
      this.applyLayout();
      this.restorePosition();
      if (
        !actionsDialog.open &&
        !document.querySelector(".map-style-panel:popover-open") &&
        document.activeElement !== el("route-more")
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
        const fixed =
          el("result-header").offsetHeight +
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
        panel.classList.toggle(
          "result-scroll-all",
          (this.desktop.matches || this.screen !== "map") &&
            el("map-view").clientHeight < fixed + row,
        );
      });
    });
    for (const element of [
      el("map-view"),
      el("result-header"),
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
    return this.desktop.matches || this.screen === "map";
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
    const fromDetail = this.screen === "detail";
    this.navigation =
      value && ["list", "detail", "map"].includes(value.screen)
        ? structuredClone(value)
        : { screen: "list", mapReturn: "list", positions: {} };
    this.applyLayout();
    this.restorePosition();
    if (focus) this.focusSelection(fromDetail);
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
    const fromDetail = this.screen === "detail";
    this.savePosition();
    if (screen === "map" && this.screen !== "map")
      this.navigation.mapReturn = this.screen;
    this.navigation.screen = screen;
    this.applyLayout();
    this.restorePosition();
    if (focus) this.focusSelection(fromDetail);
  }
  private requestScreen(screen: JourneyScreen, replace = false) {
    if (this.onNavigate) this.onNavigate(screen, replace);
    else this.showScreen(screen);
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
    const mobile = !this.desktop.matches;
    const map = mobile && this.screen === "map";
    const detail = mobile && this.screen === "detail";
    el("map-view").dataset.resultScreen = mobile ? this.screen : "desktop";
    el("choices").hidden = map || detail;
    this.detailPanel.hidden = !this.displayedID || (mobile && !detail);
    this.detailPanel.inert = this.detailPanel.hidden;
    el("result-back").hidden = !mobile || this.screen === "list";
    el("result-back").textContent = this.example
      ? "‹ Beispielroute"
      : map
        ? this.savedOrigin
          ? "‹ Strecken"
          : "‹ Alle Verbindungen"
        : this.savedOrigin === "history"
          ? "‹ Strecken"
          : this.savedOrigin === "search"
            ? "‹ Zur Suche"
            : "‹ Alle Verbindungen";
    const mapToggle = el<HTMLButtonElement>("panel-map-toggle");
    const mapToggleParent = el(
      mobile && this.screen === "list"
        ? "planning-context-footer"
        : "result-nav",
    );
    if (mapToggle.parentElement !== mapToggleParent)
      mapToggleParent.append(mapToggle);
    mapToggle.hidden = !mobile || map;
    mapToggle.disabled = !this.displayedID;
    el("map-preview").hidden = !map;
    const recovery = el("planning-recovery");
    const recoveryAnchor = el(map ? "map-preview-status" : "stale-notice");
    if (recovery.previousElementSibling !== recoveryAnchor)
      recoveryAnchor.after(recovery);
    const start = el("navigation-start");
    const startParent = this.restored
      ? el("route-actions-dialog")
      : document.querySelector<HTMLElement>(".panel-actions")!;
    if (start.parentElement !== startParent) startParent.append(start);
    const replan = el("replan-saved");
    const replanParent =
      this.restored && map
        ? el("map-preview")
        : document.querySelector<HTMLElement>(".panel-actions")!;
    if (replan.parentElement !== replanParent) {
      if (map) replanParent.insertBefore(replan, el("map-open-details"));
      else replanParent.append(replan);
    }
    el("map-open-details").className =
      this.restored || this.example ? "secondary" : "primary";
    if (this.example) {
      const ownRoute = el("example-plan-own");
      const actions = document.querySelector<HTMLElement>(".panel-actions")!;
      actions.hidden = map;
      const parent = map ? el("map-preview") : actions;
      if (ownRoute.parentElement !== parent)
        parent.insertBefore(ownRoute, map ? el("map-open-details") : null);
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
    const mapError = el("map-error");
    const errorParent = map ? el("map-preview") : el("panel-content");
    if (mapError.parentElement !== errorParent)
      errorParent.insertBefore(
        mapError,
        map ? el("map-open-details") : this.detailPanel,
      );
    el("result-context").hidden = detail || map;
    el("result-freshness").hidden = this.example;
    el("close-route").hidden = mobile && this.screen !== "list";
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
    this.onLayoutChange?.();
  }
  focusSelection(fromDetail = false) {
    const target =
      !this.desktop.matches && this.screen === "map"
        ? el("result-back")
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
    el("route-request-meta").textContent = this.example
      ? "Beispielroute"
      : request
        ? `${request.timing === "now" ? "Abfahrt jetzt" : `${request.timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`}${request.stops?.length ? ` · ${request.stops.length} ${request.stops.length === 1 ? "Zwischenstopp" : "Zwischenstopps"}` : ""}`
        : "Route bearbeiten";
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
    el("status").textContent = state.message;
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
    el("issues").textContent = state.issues.join(" ");
    el("issues").hidden = !state.issues.length;
    el("journey-panel").classList.toggle("is-loading", state.busy);
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
    const mapStatus = el("map-preview-status");
    mapStatus.textContent = state.recovery
      ? state.message
      : state.restored
        ? `Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`
        : (state.staleReason ?? (state.busy ? state.message : ""));
    mapStatus.hidden = !mapStatus.textContent;
    clearTimeout(this.recoveryTimer);
    const recovery = state.recovery;
    el("planning-recovery").hidden = !recovery || state.busy;
    const recover = el<HTMLButtonElement>("recover-planning");
    recover.textContent =
      recovery?.action === "adjust" ? "Route anpassen" : "Erneut versuchen";
    const wait = Math.max(0, (recovery?.retryAt ?? 0) - Date.now() / 1000);
    recover.disabled =
      recovery?.action === "retry" && (!navigator.onLine || wait > 0);
    el("recovery-wait").hidden = !wait || recovery?.action !== "retry";
    el("recovery-wait").textContent = wait
      ? `Erneut möglich ab ${clock(recovery!.retryAt!)}.`
      : "";
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
        `${state.message ? state.message + " " : ""}Keine Verbindung innerhalb deines Radlimits gefunden. Fahrradroute zum Vergleich.`;
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
    el("choices").replaceChildren();
    state.journeys.forEach((journey, index) => {
      const comparison = cyclingExcess(journey, cyclingLimit) > 0;
      const row = node("div", "", "route-choice-row");
      row.classList.toggle("selected", journey.id === j?.id);
      const button = node("button", "", "route-choice");
      const effort = journeyEffort(journey);
      const effortText = `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
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
        this.select(journey.id);
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
        ...this.summary(
          j,
          cyclingLimit,
          j.id === recommendedID && !state.restored
            ? recommendation
            : undefined,
        ),
      );
    } else {
      el("journey-detail").replaceChildren();
      el("map-preview-summary").replaceChildren();
    }
    el<HTMLButtonElement>("map-open-details").disabled = !j;
    this.applyLayout();
    this.restorePosition();
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
      `${comparison ? `Fahrradvergleich: ${cyclingComparisonLabel(journey, cyclingLimit)}. ` : ""}${journeyOutline(journey)}. ${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`,
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

  private choiceEffort(effort: ReturnType<typeof journeyEffort>) {
    const summary = node("span", "", "route-choice-effort");
    summary.setAttribute("aria-hidden", "true");
    const addMetric = (
      name: "bike" | "walk" | "transfer",
      text: string,
      label: string,
    ) => {
      const metric = node("span", "", "route-effort-metric");
      metric.dataset.kind = name;
      metric.title = label;
      metric.style.setProperty(
        "--stage-color",
        name === "transfer" ? "var(--panel-muted)" : routeSymbolColor(name),
      );
      metric.append(icon(name), node("span", text));
      summary.append(metric);
    };
    if (effort.cyclingSeconds > 0)
      addMetric(
        "bike",
        duration(effort.cyclingSeconds),
        "Zeit auf dem Fahrrad",
      );
    if (effort.walkingSeconds > 0)
      addMetric("walk", duration(effort.walkingSeconds), "Zeit zu Fuß");
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
