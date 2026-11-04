import type { PlanningState } from "./planning-state";
import { planningRequestPreview } from "./planning-progress";
import { rateLimitMessage } from "./model";
import type {
  JourneyWorkspaceApi,
  WorkspaceTextId,
} from "./journey-workspace-presentation";

/** The initial search has one persistent status, independent of transient toasts. */
export class SearchPreview {
  private state?: PlanningState;
  private routing = false;
  private longWait = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private view: JourneyWorkspaceApi) {}

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
    this.view.setRetryAt("search-preview-detail", 0);
    const state = this.state!;
    const request = planningRequestPreview(state);
    this.view.setHidden("search-preview", !request);
    if (!request) return;
    const setText = (id: WorkspaceTextId, text: string) => {
      this.view.setText(id, text);
    };
    setText(
      "search-preview-title",
      state.busy
        ? state.locating
          ? "Standort wird ermittelt …"
          : "Verbindungen werden gesucht …"
        : "Keine Verbindung verfügbar",
    );
    this.view.setHidden("search-preview-spinner", !state.busy);
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
      this.view.setRetryAt(
        "search-preview-detail",
        state.recovery?.retryAt ?? 0,
      );
    this.view.setHidden("search-preview-detail", !detail);
    const hint = this.routing
      ? request.stops?.length
        ? "Mit Zwischenzielen stimmen wir mehrere Teilstrecken und Zeiten aufeinander ab."
        : "Die Suche dauert etwas länger. Wir prüfen weiter passende Verbindungen."
      : "";
    setText("search-preview-hint-reserve", hint);
    const hasRoute = this.routing && !!state.routePreview;
    const showHint = hasRoute || (this.longWait && this.routing);
    this.view.setHidden("search-preview-hint", !showHint);
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
