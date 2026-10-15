import {
  type Journey,
  kindNames,
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
  legColors,
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
  private navigation: JourneyNavigation = {
    screen: "list",
    mapReturn: "list",
    positions: {},
  };
  private readonly desktop = matchMedia("(min-width: 900px)");
  private readonly detailPanel = el("panel-details");
  constructor(private select: (id: string) => void) {
    el("panel-map-toggle").onclick = () => this.requestScreen("map");
    el("result-back").onclick = () => {
      if (this.onBack) this.onBack();
      else
        this.showScreen(
          this.navigation.screen === "map" ? this.navigation.mapReturn : "list",
        );
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
      actionsDialog.close();
      el("route-more").focus({ preventScroll: true });
    };
    el("route-more").onclick = () => actionsDialog.showModal();
    el("route-actions-close").onclick = closeActions;
    actionsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeActions();
    });
    for (const id of ["share-plan", "refresh-route", "replan-saved"]) {
      el(id).addEventListener("click", closeActions, { capture: true });
    }
    this.desktop.addEventListener("change", () => {
      this.applyLayout();
      this.restorePosition();
      if (!actionsDialog.open && document.activeElement !== el("route-more"))
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
    el("result-back").textContent = map
      ? this.navigation.mapReturn === "detail"
        ? "‹ Reiseablauf"
        : "‹ Alle Verbindungen"
      : this.savedOrigin === "history"
        ? "‹ Fahrten"
        : this.savedOrigin === "search"
          ? "‹ Zur Suche"
          : "‹ Alle Verbindungen";
    el("panel-map-toggle").hidden = !mobile || map;
    el<HTMLButtonElement>("panel-map-toggle").disabled = !this.displayedID;
    el("map-preview").hidden = !map;
    const mapError = el("map-error");
    const errorParent = map ? el("map-preview") : el("panel-content");
    if (mapError.parentElement !== errorParent)
      errorParent.insertBefore(
        mapError,
        map ? el("map-open-details") : this.detailPanel,
      );
    el("result-context").hidden = detail || map;
    el("result-freshness").hidden = map;
    el("close-route").hidden = mobile && this.screen !== "list";
    for (const element of [
      el("map"),
      el("map-location"),
      el("map-route"),
      document.querySelector<HTMLElement>(".map-credit")!,
    ]) {
      element.inert = !this.mapVisible;
      element.style.visibility = this.mapVisible ? "" : "hidden";
    }
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
    el("route-origin").textContent = request?.origin.name ?? "Start";
    el("route-destination").textContent = request?.destination.name ?? "Ziel";
    el("route-request-meta").textContent = request
      ? `${request.timing === "now" ? "Abfahrt jetzt" : `${request.timing === "arrive" ? "Ankunft" : "Abfahrt"} ${dateLabel(request.time)}, ${clock(request.time)}`}${request.stops?.length ? ` · ${request.stops.length} ${request.stops.length === 1 ? "Zwischenstopp" : "Zwischenstopps"}` : ""}`
      : "Route bearbeiten";
    const selected = state.selected;
    el("route-start-duration").textContent = selected
      ? duration(selected.arrival - selected.departure)
      : "";
    el("route-start-arrival").textContent = selected
      ? `${journeyEndpointTime(selected, "arrival")} an`
      : "";
    el("route-start-summary").hidden = !selected;
    el("navigation-start").hidden = !selected || state.busy;
    el<HTMLButtonElement>("navigation-start").disabled =
      state.busy || state.locating;
    cyclingLimit = state.resultSettings?.maxCyclingMinutes ?? cyclingLimit;
    el("status").textContent = state.message;
    el("stale-notice").textContent = state.staleReason ?? "";
    el("stale-notice").hidden = !state.staleReason;
    el("refresh-route").textContent = state.staleReason
      ? "Erneut versuchen"
      : "Aktualisieren";
    el("cancel").hidden = !state.busy;
    el("refresh-route").hidden = state.busy;
    el<HTMLButtonElement>("refresh-route").disabled =
      !state.request || !navigator.onLine;
    el<HTMLButtonElement>("adjust-route").disabled = state.busy;
    el("issues").textContent = state.issues.join(" ");
    el("issues").hidden = !state.issues.length;
    el("journey-panel").classList.toggle("is-loading", state.busy);
    const j = state.selected;
    this.savePosition();
    this.displayedID = j?.id;
    el("result-context").textContent = state.request
      ? `${state.request.origin.name} → ${state.request.destination.name}`
      : "Verbindungen";
    el("result-stand").textContent = state.queriedAt
      ? `${state.restored ? "Gespeichert" : "Stand"}: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}`
      : "";
    el("map-preview-stand").textContent = state.restored
      ? `Gespeicherter Stand: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}. Zeiten nicht aktualisiert.`
      : (state.staleReason ??
        (state.busy ? state.message : `Stand: ${clock(state.queriedAt)}`));
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
      j && !state.busy && !state.restored && !state.staleReason
        ? lateDepartureDelay(j, state.request)
        : undefined;
    el("late-departure").hidden = delay === undefined;
    el("late-departure-text").textContent =
      delay === undefined
        ? ""
        : `Start erst ${clock(j!.departure)} – ${duration(delay)} nach dem gewünschten Beginn. Größere Suchgrenzen können frühere Verbindungen ermöglichen.`;
    const recommendation =
      state.request?.timing === "arrive"
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
      const heading = node("span", "", "route-choice-time");
      const arrival = node(
        "strong",
        `${journeyEndpointTime(journey, "arrival")} an`,
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
      heading.append(arrival, node("span", " · ", "visually-hidden"), schedule);
      const effort = journeyEffort(journey);
      const effortText = `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
      const outline = journeyOutline(journey);
      button.append(
        heading,
        this.choiceOutline(journey),
        this.choiceEffort(effort),
      );
      if (journey.id === recommendedID && !state.restored)
        button.prepend(node("span", recommendation, "route-recommendation"));
      button.type = "button";
      button.dataset.journey = journey.id;
      button.setAttribute("aria-pressed", String(journey.id === j?.id));
      button.setAttribute(
        "aria-label",
        `${comparison ? "Fahrradvergleich: " + cyclingComparisonLabel(journey, cyclingLimit) : journey.id === recommendedID ? recommendation : `Alternative ${index + 1}`}: Ankunft ${dateLabel(journey.arrival)} ${clock(journey.arrival)}, Abfahrt ${dateLabel(journey.departure)} ${clock(journey.departure)}, Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`,
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
        `Details: Reiseablauf ansehen, Abfahrt ${clock(journey.departure)}, Ankunft ${clock(journey.arrival)}`,
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
      const summary = `${journeyTimeRange(j)} · ${duration(j.arrival - j.departure)}`;
      el("journey-heading").textContent = summary;
      const effort = journeyEffort(j);
      el("journey-effort").textContent =
        `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
      el("map-preview-time").textContent = summary;
      el("map-preview-outline").textContent = journeyOutline(j);
    } else el("journey-detail").replaceChildren();
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
        name === "transfer" ? "#c1c8cb" : routeSymbolColor(name),
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
    const list = node("ol", "", "journey-legs");
    j.legs.forEach((leg, index) => {
      const previous = j.legs[index - 1];
      if (previous && leg.start - previous.end >= 60)
        list.append(
          node(
            "li",
            `${duration(leg.start - previous.end)} Aufenthalt · ${leg.from.name}`,
            "wait",
          ),
        );
      const item = node("li");
      item.style.setProperty("--leg-color", legColors[leg.kind]);
      const symbol = icon(leg.kind);
      symbol.classList.add("leg-symbol");
      const copy = node("div");
      copy.append(
        node(
          "strong",
          `${kindNames[leg.kind]}${leg.line ? " " + leg.line : ""}`,
        ),
        node(
          "small",
          `${clock(leg.start)} – ${clock(leg.end)} · ${duration(leg.end - leg.start)}`,
        ),
        node(
          "p",
          leg.from.name +
            (leg.from.name !== leg.to.name ? " → " + leg.to.name : ""),
        ),
      );
      if (leg.stop)
        copy.append(
          node(
            "small",
            `Geplanter Aufenthalt: ${leg.stop.stayMinutes} min · Weiterfahrt ${clock(leg.end)}`,
          ),
        );
      if (leg.headsign) copy.append(node("small", "Richtung " + leg.headsign));
      if (leg.platform || leg.arrivalPlatform)
        copy.append(
          node(
            "small",
            [
              leg.platform ? "Abfahrt Gleis / Steig " + leg.platform : "",
              leg.arrivalPlatform
                ? "Ankunft Gleis / Steig " + leg.arrivalPlatform
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
      if (leg.kind === "transit")
        copy.append(
          node(
            "small",
            restored
              ? "Gespeicherte Fahrplanangabe"
              : leg.realtime
                ? "Echtzeitdaten zum Zeitpunkt der Abfrage"
                : "Fahrplanzeit",
          ),
        );
      item.append(symbol, copy);
      list.append(item);
    });
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
