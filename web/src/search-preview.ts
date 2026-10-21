import type { PlanningState } from "./planning-state";
import { planningRequestPreview } from "./planning-progress";
import { el } from "./ui";
import { rateLimitMessage } from "./model";
import { RetryCountdown } from "./retry-countdown";

/** The initial search has one persistent status, independent of transient toasts. */
export class SearchPreview {
  private state?: PlanningState;
  private routing = false;
  private longWait = false;
  private timer?: ReturnType<typeof setTimeout>;
  private countdown = new RetryCountdown();

  render(state: PlanningState) {
    this.state = state;
    const request = planningRequestPreview(state);
    const routing =
      !!request &&
      state.busy &&
      !state.locating &&
      state.pendingRequestResolved !== false;
    if (!routing) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.longWait = false;
    } else if (!this.routing) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.longWait = true;
        this.update();
      }, 10_000);
    }
    this.routing = routing;
    this.update();
    return request;
  }

  private update() {
    this.countdown.clear();
    const state = this.state!;
    const request = planningRequestPreview(state);
    const card = el("search-preview");
    card.hidden = !request;
    if (!request) return;
    const setText = (id: string, text: string) => {
      const element = el(id);
      if (element.textContent !== text) element.textContent = text;
    };
    setText(
      "search-preview-title",
      state.busy
        ? state.locating
          ? "Standort wird ermittelt …"
          : "Verbindungen werden gesucht …"
        : "Keine Verbindung verfügbar",
    );
    el("search-preview-spinner").hidden = !state.busy;
    const places = [
      request.origin,
      ...(request.stops ?? []).map((stop) => stop.place),
      request.destination,
    ];
    const index = state.activeSection;
    const section =
      index !== undefined &&
      request.stops?.length &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < places.length - 1
        ? `${places[index].name} → ${places[index + 1].name} wird geprüft.`
        : "Wir prüfen passende Wege für deine Vorgaben.";
    const detail = state.busy ? (state.locating ? "" : section) : state.message;
    setText("search-preview-detail", detail);
    if (!state.busy && rateLimitMessage(state.failures))
      this.countdown.render(
        el("search-preview-detail"),
        state.recovery?.retryAt ?? 0,
      );
    el("search-preview-detail").hidden = !detail;
    const hint = this.routing
      ? request.stops?.length
        ? "Mit Zwischenzielen stimmen wir mehrere Teilstrecken und Zeiten aufeinander ab."
        : "Die Suche dauert etwas länger. Wir prüfen weiter passende Verbindungen."
      : "";
    setText("search-preview-hint-reserve", hint);
    const hasRoute = this.routing && !!state.routePreview;
    const showHint = hasRoute || (this.longWait && this.routing);
    el("search-preview-hint").hidden = !showHint;
    setText(
      "search-preview-hint",
      hasRoute
        ? "Die angezeigte Teilroute ist vorläufig und kann sich noch ändern."
        : showHint
          ? hint
          : "",
    );
  }
}
