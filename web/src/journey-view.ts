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
import { el, node, clock, duration, dateLabel, icon, legColors } from "./ui";
export type PanelSize = "collapsed" | "normal" | "expanded";
export class JourneyView {
  onDetailsOpened?: () => void;
  private key = "";
  private openedID?: string;
  private calculationID?: string;
  private wasBusy = false;
  private readonly detailPanel = el("panel-details");
  private size: PanelSize = "normal";
  private readonly desktop = matchMedia("(min-width: 900px)");
  private dragY?: number;
  private mapOnly = false;
  private fixedHeight = 0;
  private choiceHeight = 44;
  private lastRender?: {
    state: PlanningState;
    limit: number;
    recommendation: string;
    recommendedID?: string;
  };
  constructor(private select: (id: string) => void) {
    el("panel-map-toggle").onclick = () => {
      this.mapOnly = !this.mapOnly;
      this.updateMapAccess();
    };
    const handle = el("panel-handle");
    // CSS can hide the handle before matchMedia dispatches its change event.
    // Remember its focus until another user target receives it.
    let handleHadFocus = false;
    document.addEventListener("focusin", (event) => {
      if (event.target !== document.body)
        handleHadFocus = event.target === handle;
    });
    document.addEventListener("pointerdown", (event) => {
      if (!handle.contains(event.target as Node)) handleHadFocus = false;
    });
    handle.addEventListener("blur", () => {
      // Wait for responsive layout: Chromium can blur before updating the media query.
      requestAnimationFrame(() => {
        if (
          this.desktop.matches &&
          handleHadFocus &&
          document.activeElement === document.body
        )
          this.focusSelection();
      });
    });
    handle.onkeydown = (event) => {
      const sizes: PanelSize[] = ["collapsed", "normal", "expanded"];
      const offset =
        event.key === "ArrowUp" || event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowDown" || event.key === "ArrowLeft"
            ? -1
            : 0;
      if (!offset && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.setSize(
        sizes[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? 2
              : Math.max(0, Math.min(2, sizes.indexOf(this.size) + offset))
        ],
        true,
      );
    };
    handle.onpointerdown = (e) => {
      this.dragY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    };
    handle.onpointerup = (e) => {
      if (this.dragY === undefined) return;
      const dy = e.clientY - this.dragY;
      this.dragY = undefined;
      if (Math.abs(dy) > 30)
        this.setSize(
          dy < 0
            ? this.size === "collapsed"
              ? "normal"
              : "expanded"
            : this.size === "expanded"
              ? "normal"
              : "collapsed",
          true,
        );
    };
    handle.onpointercancel = () => (this.dragY = undefined);
    el("choices").onkeydown = (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.matches(".route-choice")
      )
        return;
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        this.next(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    for (const id of ["share-plan", "refresh-route"]) {
      el(id).addEventListener("blur", () => {
        if (!this.desktop.matches)
          queueMicrotask(() => {
            if (document.activeElement === document.body) {
              this.updateActionLayout();
              el("close-route").focus({ preventScroll: true });
            }
          });
      });
    }
    this.updateActionLayout();
    this.desktop.addEventListener("change", () => {
      this.updateActionLayout();
      this.updateMapAccess();
      this.reserveOverviewHeight();
      if (
        this.desktop.matches &&
        (document.activeElement === handle ||
          (handleHadFocus && document.activeElement === document.body))
      )
        this.focusSelection();
    });
    let resizePending = false;
    const observer = new ResizeObserver(() => {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        this.reserveOverviewHeight();
        const panel = el("journey-panel");
        const available = el("map-view").clientHeight;
        if (!available) return;
        const height = (selector: string) =>
          panel.querySelector<HTMLElement>(selector)!.offsetHeight;
        // Preserve natural content measurements while the map-only toolbar hides them.
        if (!this.mapOnly) {
          this.fixedHeight =
            height(".panel-tools") +
            height(".panel-handle") +
            height(".panel-actions") +
            parseFloat(getComputedStyle(panel).paddingTop) +
            parseFloat(getComputedStyle(panel).paddingBottom) +
            4;
          this.choiceHeight =
            panel.querySelector<HTMLElement>(".route-choice-row")
              ?.offsetHeight ?? 44;
        }
        const fixed = this.fixedHeight;
        const row = this.choiceHeight;
        const clearance = window.innerWidth >= 900 ? 40 : 134;
        panel.classList.toggle(
          "panel-full-height",
          !this.desktop.matches && available - clearance < fixed + row,
        );
        panel.classList.toggle(
          "panel-scroll-all",
          available - (this.desktop.matches ? 40 : 16) < fixed + row,
        );
        if (!panel.classList.contains("panel-scroll-all")) panel.scrollTop = 0;
        this.updateMapAccess();
      });
    });
    for (const element of [
      el("map-view"),
      el("choices"),
      ...el("journey-panel").querySelectorAll(".panel-tools, .panel-actions"),
    ])
      observer.observe(element);
  }
  private updateActionLayout() {
    const close = el("close-route");
    const toggle = el("panel-map-toggle");
    const actions =
      el("journey-panel").querySelector<HTMLElement>(".panel-actions")!;
    const tools = el("journey-panel").querySelector<HTMLElement>(
      ".panel-tool-actions",
    )!;
    const focused = document.activeElement as HTMLElement | null;
    const desktop = this.desktop.matches;
    const closeParent = desktop ? tools : actions;
    if (close.parentElement !== closeParent) {
      closeParent.append(close);
      close.className = desktop ? "icon-button" : "secondary";
      close.replaceChildren(
        desktop ? icon("close") : document.createTextNode("Schließen"),
      );
    }
    const toggleParent = this.mapOnly ? actions : tools;
    if (toggle.parentElement !== toggleParent) {
      toggleParent.insertBefore(
        toggle,
        this.mapOnly ? close : tools.firstChild,
      );
      toggle.className = this.mapOnly ? "primary" : "icon-button";
      toggle.replaceChildren(
        this.mapOnly ? document.createTextNode("Reise anzeigen") : icon("map"),
      );
    }
    if (focused && (focused === close || focused === toggle) && !focused.hidden)
      focused.focus({ preventScroll: true });
    else if (
      focused &&
      ["share-plan", "refresh-route", "adjust-route", "cancel"].includes(
        focused.id,
      ) &&
      !focused.getClientRects().length
    )
      close.focus({ preventScroll: true });
  }
  private updateMapAccess() {
    const panel = el("journey-panel");
    const full =
      panel.classList.contains("panel-full-height") && !this.desktop.matches;
    if (!full) this.mapOnly = false;
    panel.classList.toggle("panel-map-only", this.mapOnly);
    const toggle = el<HTMLButtonElement>("panel-map-toggle");
    toggle.hidden = !full;
    const label = this.mapOnly ? "Reise anzeigen" : "Karte anzeigen";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.setAttribute("aria-expanded", String(this.mapOnly));
    if (toggle.hidden && document.activeElement === toggle)
      this.focusSelection();
    this.updateActionLayout();
    for (const element of [
      el("map"),
      el("map-location"),
      el("map-route"),
      document.querySelector<HTMLElement>(".map-credit")!,
    ]) {
      if (full && !this.mapOnly && element.contains(document.activeElement))
        toggle.focus({ preventScroll: true });
      element.inert = full && !this.mapOnly;
    }
  }
  private next(direction: number) {
    const buttons = Array.from(
      el("choices").querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    );
    const index = buttons.findIndex(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    buttons[(index + direction + buttons.length) % buttons.length]?.click();
    this.focusSelection();
  }
  setSize(size: PanelSize, userInitiated = false) {
    if (this.desktop.matches) return;
    if (userInitiated && size === "expanded" && this.size !== "expanded")
      this.onDetailsOpened?.();
    this.size = size;
    this.mapOnly = false;
    this.updateMapAccess();
    el("journey-panel").dataset.size = size;
    const index = ["collapsed", "normal", "expanded"].indexOf(size);
    el("panel-handle").setAttribute("aria-valuenow", String(index));
    el("panel-handle").setAttribute(
      "aria-valuetext",
      ["Minimiert", "Normal", "Maximiert"][index],
    );
    this.reserveOverviewHeight();
  }
  render(state: PlanningState, cyclingLimit = 30) {
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
    if (
      (!this.wasBusy && state.busy) ||
      this.calculationID !== state.calculationId ||
      this.openedID !== j?.id ||
      !state.journeys.some((route) => route.id === this.openedID)
    )
      this.openedID = undefined;
    this.wasBusy = state.busy;
    this.calculationID = state.calculationId;
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
    this.lastRender = {
      state,
      limit: cyclingLimit,
      recommendation,
      recommendedID,
    };
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
      this.openedID,
      state.restored,
      state.queriedAt,
      state.request?.timing,
      cyclingLimit,
    ]);
    if (key === this.key) {
      this.reserveOverviewHeight();
      return;
    }
    this.key = key;
    const focusedAction = (document.activeElement as HTMLElement)?.dataset
      .action;
    const focused =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset.journey ??
          document.activeElement.dataset.routeDetail)
        : undefined;
    const scroll = this.scrollContainer();
    const scrollTop = scroll.scrollTop;
    this.detailPanel.remove();
    el("choices").replaceChildren();
    state.journeys.forEach((journey, index) => {
      const comparison = cyclingExcess(journey, cyclingLimit) > 0;
      const arrival = clock(journey.arrival);
      const row = node("div", "", "route-choice-row");
      row.classList.toggle("selected", journey.id === j?.id);
      const button = node("button", "", "route-choice");
      const heading = node(
        "span",
        `${comparison ? " · " : ""}${journeyTimeRange(journey)} · ${duration(journey.arrival - journey.departure)}`,
        "route-choice-time",
      );
      if (comparison) heading.prepend(icon("bike"));
      const effort = journeyEffort(journey);
      const effortText = `${duration(effort.cyclingSeconds)} Rad · ${duration(effort.walkingSeconds)} Fuß · ${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`;
      const outline = journeyOutline(journey);
      const open = journey.id === this.openedID;
      const outlineElement = node("span", outline, "route-outline");
      outlineElement.hidden = open;
      button.append(
        heading,
        outlineElement,
        node("span", effortText, "route-choice-effort"),
      );
      button.type = "button";
      button.dataset.journey = journey.id;
      button.setAttribute("aria-pressed", String(journey.id === j?.id));
      button.setAttribute(
        "aria-label",
        `${comparison ? "Fahrradvergleich: " + cyclingComparisonLabel(journey, cyclingLimit) : journey.id === recommendedID ? recommendation : `Alternative ${index + 1}`}: Ankunft ${dateLabel(journey.arrival)} ${clock(journey.arrival)}, Abfahrt ${dateLabel(journey.departure)} ${clock(journey.departure)}, Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`,
      );
      button.onclick = () => this.select(journey.id);
      const details = node("button", "", "route-details-button");
      const arrow = node("span", "›");
      arrow.setAttribute("aria-hidden", "true");
      details.append(arrow);
      details.setAttribute("aria-expanded", String(open));
      details.setAttribute("aria-controls", "panel-details");
      details.type = "button";
      details.dataset.routeDetail = journey.id;
      details.dataset.action = "details";
      details.setAttribute(
        "aria-label",
        `Reiseabschnitte ${open ? "schließen" : "öffnen"}: ${arrival}, ${outline}`,
      );
      details.onclick = () => {
        const top = details.getBoundingClientRect().top;
        this.openedID = open ? undefined : journey.id;
        if (!open) this.onDetailsOpened?.();
        this.select(journey.id);
        if (this.lastRender)
          this.render(this.lastRender.state, this.lastRender.limit);
        const target = [
          ...el("choices").querySelectorAll<HTMLButtonElement>(
            ".route-details-button",
          ),
        ].find((button) => button.dataset.routeDetail === journey.id);
        if (!target) return;
        target.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          // A newer interaction must keep its focus and scroll position.
          if (!target.isConnected || document.activeElement !== target) return;
          const content = this.scrollContainer();
          content.scrollTop += target.getBoundingClientRect().top - top;
          if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
            target.firstElementChild?.animate(
              [
                { transform: `rotate(${open ? 180 : 0}deg)` },
                { transform: `rotate(${open ? 0 : 180}deg)` },
              ],
              { duration: 160, easing: "ease" },
            );
          }
        });
      };
      row.append(button, details);
      el("choices").append(row);
      if (open) el("choices").append(this.detailPanel);
    });
    if (!this.detailPanel.isConnected) el("choices").append(this.detailPanel);
    this.detailPanel.hidden = !this.openedID;
    this.detailPanel.inert = !this.openedID;
    if (!j) {
      el("journey-detail").replaceChildren();
      this.reserveOverviewHeight();
      return;
    }
    this.reserveOverviewHeight();
    this.details(j, state.restored);
    scroll.scrollTop = scrollTop;
    if (focused)
      Array.from(el("choices").querySelectorAll<HTMLButtonElement>("button"))
        .find(
          (b) =>
            (b.dataset.journey ?? b.dataset.routeDetail) === focused &&
            b.dataset.action === focusedAction,
        )
        ?.focus({ preventScroll: true });
  }
  private scrollContainer() {
    const panel = el("journey-panel");
    return panel.classList.contains("panel-scroll-all")
      ? panel
      : el("panel-content");
  }
  focusSelection() {
    const selected = el("choices").querySelector<HTMLElement>(
      '.route-choice[aria-pressed="true"]',
    );
    (
      selected ?? el(this.desktop.matches ? "panel-content" : "panel-handle")
    ).focus({ preventScroll: true });
  }
  private reserveOverviewHeight() {
    const panel = el("journey-panel");
    if (this.desktop.matches) {
      panel.style.removeProperty("--overview-height");
      panel.style.minHeight = "0px";
      return;
    }
    if (!this.lastRender || this.mapOnly) {
      panel.style.minHeight = "0px";
      return;
    }
    const { state } = this.lastRender;
    if (!state.journeys.length) {
      panel.style.removeProperty("--overview-height");
      return;
    }
    if (!panel.offsetWidth) return;
    // Measure closed cards so disclosure never changes the panel height.
    const probe = panel.cloneNode(true) as HTMLElement;
    probe.inert = true;
    probe.setAttribute("aria-hidden", "true");
    probe.classList.remove(
      "panel-full-height",
      "panel-scroll-all",
      "panel-map-only",
    );
    Object.assign(probe.style, {
      position: "fixed",
      left: "-10000px",
      right: "auto",
      top: "0",
      bottom: "auto",
      width: `${panel.offsetWidth}px`,
      height: "auto",
      minHeight: "0",
      maxHeight: "none",
      visibility: "hidden",
      pointerEvents: "none",
    });
    probe.querySelector<HTMLElement>("#panel-details")!.hidden = true;
    const content = probe.querySelector<HTMLElement>("#panel-content")!;
    content.style.overflow = "visible";
    probe.querySelectorAll<HTMLElement>(".route-outline").forEach((outline) => {
      outline.hidden = false;
    });
    document.body.append(probe);
    const fixedHeight =
      probe.getBoundingClientRect().height -
      content.getBoundingClientRect().height;
    const rows = [...probe.querySelectorAll<HTMLElement>(".route-choice-row")];
    const count = this.size === "collapsed" ? 1 : 2;
    const lastRow = rows[Math.min(count, rows.length) - 1];
    const contentHeight = lastRow
      ? lastRow.getBoundingClientRect().bottom -
        content.getBoundingClientRect().top
      : content.getBoundingClientRect().height;
    probe.remove();
    panel.style.minHeight = "0px";
    panel.style.setProperty(
      "--overview-height",
      // Leave room for row borders and fractional layout rounding in WebKit.
      `${Math.ceil(fixedHeight + contentHeight) + 4}px`,
    );
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
