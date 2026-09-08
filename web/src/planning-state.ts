import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  errorText,
} from "./model";
import { planRoutes } from "./planner";
import { ApiClient } from "./transitous";
import { locate } from "./search";
export interface PlanningState {
  journeys: Journey[];
  selected?: Journey;
  request?: RouteRequest;
  queriedAt: number;
  busy: boolean;
  locating: boolean;
  message: string;
  issues: string[];
  restored: boolean;
}
export const byDuration = (a: Journey, b: Journey) =>
  a.arrival - a.departure - (b.arrival - b.departure) ||
  a.arrival - b.arrival ||
  a.transfers - b.transfers;
export class PlanningSession {
  state: PlanningState = {
    journeys: [],
    queriedAt: 0,
    busy: false,
    locating: false,
    message: "",
    issues: [],
    restored: false,
  };
  private controller?: AbortController;
  private generation = 0;
  constructor(
    private client: ApiClient,
    private change: (s: PlanningState) => void,
  ) {}
  private emit() {
    this.change(this.state);
  }
  stop(message = "Suche abgebrochen. Bisherige Ergebnisse bleiben verfügbar.") {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.state = { ...this.state, busy: false, locating: false, message };
    this.emit();
  }
  clear() {
    this.stop("");
    this.state = {
      journeys: [],
      queriedAt: 0,
      busy: false,
      locating: false,
      message: "",
      issues: [],
      restored: false,
    };
    this.emit();
  }
  select(id: string) {
    const selected = this.state.journeys.find((j) => j.id === id);
    if (selected) {
      this.state = { ...this.state, selected };
      this.emit();
    }
  }
  restore(journey: Journey, request: RouteRequest, queriedAt: number) {
    this.stop("");
    this.state = {
      journeys: [journey],
      selected: journey,
      request,
      queriedAt,
      busy: false,
      locating: false,
      message: "Gespeicherte Reise",
      issues: [],
      restored: true,
    };
    this.emit();
  }
  async calculate(
    request: RouteRequest,
    settings: RoutingSettings,
    refreshLocation: boolean,
  ): Promise<"location-error" | undefined> {
    this.stop("");
    const generation = this.generation,
      previous = this.state;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = {
      ...previous,
      busy: true,
      locating: refreshLocation,
      message: refreshLocation
        ? "Standort wird ermittelt …"
        : "Verbindungen werden gesucht …",
      issues: [],
    };
    this.emit();
    let locating = refreshLocation,
      received = false;
    try {
      if (!navigator.onLine)
        throw new Error(
          "Keine Internetverbindung. Du kannst deine gespeicherte Reise öffnen.",
        );
      if (refreshLocation)
        request = { ...request, origin: await locate(signal) };
      if (generation !== this.generation) return;
      locating = false;
      const queriedAt = Date.now() / 1000;
      if (request.timing === "now") request = { ...request, time: queriedAt };
      this.state = {
        ...this.state,
        locating: false,
        message: "Verbindungen werden gesucht …",
      };
      this.emit();
      for await (const update of planRoutes(
        request,
        settings,
        signal,
        this.client,
      )) {
        if (generation !== this.generation) return;
        const selected = received ? this.state.selected : undefined;
        let journeys = [...update.journeys];
        if (selected && !journeys.some((j) => j.id === selected.id))
          journeys = [selected, ...journeys].slice(0, 3);
        journeys.sort(byDuration);
        received = true;
        this.state = {
          journeys,
          selected: selected ?? journeys[0],
          request,
          queriedAt,
          busy: update.status === "searching",
          locating: false,
          restored: false,
          message:
            update.status === "searching"
              ? "Weitere Verbindungen werden geprüft …"
              : update.status === "partial"
                ? "Suche teilweise abgeschlossen."
                : "Verbindungen gefunden.",
          issues: update.issues,
        };
        this.emit();
      }
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      this.state = {
        ...(received ? this.state : previous),
        busy: false,
        locating: false,
        message: errorText(error),
      };
      this.emit();
      if (locating) return "location-error";
    } finally {
      if (generation === this.generation) {
        this.controller = undefined;
        this.state = { ...this.state, busy: false, locating: false };
        this.emit();
      }
    }
  }
}
