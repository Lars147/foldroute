import {
  type Journey,
  kindNames,
  bikeDistance,
  lateDepartureDelay,
  compare,
  cyclingExcess,
  cyclingComparisonLabel,
} from "./model";
import { type PlanningState } from "./planning-state";
import { el, node, clock, duration, dateLabel, icon, legColors } from "./ui";
export type PanelSize = "collapsed" | "normal" | "expanded";
export class JourneyView {
  private key = "";
  private size: PanelSize = "normal";
  private dragY?: number;
  private swipe?: { x: number; y: number };
  constructor(private select: (id: string) => void) {
    el("panel-size").onclick = () =>
      this.setSize(
        this.size === "collapsed"
          ? "normal"
          : this.size === "normal"
            ? "expanded"
            : "collapsed",
      );
    const handle = el("panel-handle");
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
        );
    };
    handle.onpointercancel = () => (this.dragY = undefined);
    const summary = el("panel-summary");
    summary.onpointerdown = (e) => {
      this.swipe = { x: e.clientX, y: e.clientY };
    };
    summary.onpointerup = (e) => {
      if (!this.swipe) return;
      const dx = e.clientX - this.swipe.x,
        dy = e.clientY - this.swipe.y;
      this.swipe = undefined;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy))
        this.next(dx < 0 ? 1 : -1);
    };
    summary.onpointercancel = () => (this.swipe = undefined);
    summary.onkeydown = (e) => {
      if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        this.next(e.key === "ArrowRight" ? 1 : -1);
      }
    };
  }
  private next(direction: number) {
    const buttons = Array.from(
      el("choices").querySelectorAll<HTMLButtonElement>("button"),
    );
    const index = buttons.findIndex(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    buttons[(index + direction + buttons.length) % buttons.length]?.click();
  }
  setSize(size: PanelSize) {
    this.size = size;
    el("journey-panel").dataset.size = size;
    el("panel-size").textContent =
      size === "collapsed"
        ? "Details öffnen"
        : size === "normal"
          ? "Mehr Details"
          : "Details einklappen";
    el("panel-size").setAttribute(
      "aria-expanded",
      String(size !== "collapsed"),
    );
    el("panel-details").inert = size === "collapsed";
  }
  render(state: PlanningState, cyclingLimit = 30) {
    el("status").textContent = state.message;
    el("cancel").hidden = !state.busy;
    el("refresh-route").hidden = state.busy;
    el<HTMLButtonElement>("refresh-route").disabled =
      !state.request || !navigator.onLine;
    el<HTMLButtonElement>("adjust-route").disabled = state.busy;
    el("issues").textContent = state.issues.join(" ");
    el("issues").hidden = !state.issues.length;
    el("journey-panel").classList.toggle("is-loading", state.busy);
    const j = state.selected;
    const onlyComparison =
      state.journeys.length > 0 &&
      state.journeys.every(
        (journey) => cyclingExcess(journey, cyclingLimit) > 0,
      );
    if (onlyComparison && !state.busy)
      el("status").textContent =
        `${state.message === "Verbindungen gefunden." ? "" : state.message + " "}Keine Verbindung innerhalb deines Radlimits gefunden. Fahrradroute zum Vergleich.`;
    el("cycling-comparison").textContent = j
      ? cyclingComparisonLabel(j, cyclingLimit)
      : "";
    el("cycling-comparison").hidden =
      !j || cyclingExcess(j, cyclingLimit) === 0;
    const delay =
      j && !state.busy && !state.restored
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
    const recommendedID = state.journeys
      .filter((j) => cyclingExcess(j, cyclingLimit) === 0)
      .sort((a, b) => compare(a, b, state.request?.timing ?? "now"))[0]?.id;
    el("saved-notice").hidden = !state.restored;
    if (state.restored)
      el("saved-notice").textContent =
        `Gespeicherter Stand: ${dateLabel(state.queriedAt)}, ${clock(state.queriedAt)}. Zeiten wurden nicht aktualisiert.${j && j.arrival < Date.now() / 1000 ? " Diese Reise liegt in der Vergangenheit." : ""}`;
    const key = JSON.stringify([
      state.journeys.map((j) => j.id),
      j?.id,
      state.restored,
      state.queriedAt,
      state.request?.timing,
      cyclingLimit,
    ]);
    if (key === this.key) return;
    this.key = key;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.journey
        : undefined;
    el("choices").replaceChildren();
    state.journeys.forEach((journey, index) => {
      const button = node(
        "button",
        `${cyclingExcess(journey, cyclingLimit) > 0 ? "Vergleich" : index + 1} · ${duration(journey.arrival - journey.departure)}`,
        "route-choice",
      );
      button.type = "button";
      button.dataset.journey = journey.id;
      button.setAttribute("aria-pressed", String(journey.id === j?.id));
      button.setAttribute(
        "aria-label",
        `${cyclingExcess(journey, cyclingLimit) > 0 ? "Fahrradvergleich: " + cyclingComparisonLabel(journey, cyclingLimit) : journey.id === recommendedID ? recommendation : `Alternative ${index + 1}`}: ${duration(journey.arrival - journey.departure)}, ${clock(journey.departure)} bis ${clock(journey.arrival)}`,
      );
      button.onclick = () => this.select(journey.id);
      el("choices").append(button);
    });
    if (!j) {
      el("option-title").textContent = "Deine Möglichkeiten";
      el("route-arrival").textContent = "Route finden.";
      el("route-duration").textContent = "Rad und ÖPNV gemeinsam geplant.";
      el("route-range").textContent = "";
      el("fold-line").replaceChildren();
      el("journey-detail").replaceChildren();
      return;
    }
    const index = state.journeys.findIndex((x) => x.id === j.id);
    el("option-title").textContent = state.restored
      ? "Gespeicherte Reise"
      : cyclingExcess(j, cyclingLimit) > 0
        ? `Fahrradvergleich · ${Math.ceil(cyclingExcess(j, cyclingLimit) / 60)} Min. über deinem Radlimit`
        : `${j.id === recommendedID ? recommendation : `Alternative ${index + 1}`}${j.isDirect ? " · Nur Fahrrad" : ""}`;
    const times = el("route-arrival");
    times.replaceChildren();
    for (const [label, time] of [
      ["Abfahrt", j.departure],
      ["Ankunft", j.arrival],
    ] as const) {
      const group = node("span", "", "route-time");
      group.append(node("small", label), node("span", clock(time)));
      if (new Date(time * 1000).toDateString() !== new Date().toDateString())
        group.append(node("small", dateLabel(time)));
      times.append(group);
    }
    el("route-duration").textContent =
      `Gesamtdauer · ${duration(j.arrival - j.departure)}`;
    el("route-range").textContent =
      `${dateLabel(j.departure)} ${clock(j.departure)} – ${dateLabel(j.arrival)} ${clock(j.arrival)} · ${j.transfers} Umstiege · ${(bikeDistance(j) / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km Rad`;
    this.details(j, state.restored);
    if (focused)
      Array.from(el("choices").querySelectorAll<HTMLButtonElement>("button"))
        .find((b) => b.dataset.journey === focused)
        ?.focus({ preventScroll: true });
  }
  private details(j: Journey, restored: boolean) {
    const line = el("fold-line");
    line.replaceChildren();
    j.legs
      .filter((l) => l.kind !== "wait")
      .forEach((leg) => {
        const item = node("span", "", "fold-leg");
        item.style.setProperty("--leg-color", legColors[leg.kind]);
        item.append(
          icon(leg.kind),
          node("span", leg.line || kindNames[leg.kind]),
        );
        line.append(item);
      });
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
    el("journey-detail").replaceChildren(list);
  }
}
