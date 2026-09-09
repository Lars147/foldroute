import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  errorText,
  cyclingExcess,
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
  resultSettings?: RoutingSettings;
}
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
  private explicitlySelectedID?: string;
  constructor(
    private client: ApiClient,
    private change: (s: PlanningState) => void,
    private resolved?: (
      request: RouteRequest,
      settings: RoutingSettings,
    ) => void,
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
    this.explicitlySelectedID = undefined;
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
  invalidateForSettings() {
    this.stop("");
    this.explicitlySelectedID = undefined;
    this.state = {
      ...this.state,
      journeys: [],
      selected: undefined,
      resultSettings: undefined,
      restored: false,
      queriedAt: 0,
      issues: [],
      message: "Einstellungen geändert. Beim Verlassen wird neu berechnet.",
    };
    this.emit();
  }
  select(id: string) {
    const selected = this.state.journeys.find((j) => j.id === id);
    if (selected) {
      this.explicitlySelectedID = id;
      this.state = { ...this.state, selected };
      this.emit();
    }
  }
  restore(journey: Journey, request: RouteRequest, queriedAt: number) {
    this.stop("");
    this.explicitlySelectedID = undefined;
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
  prepare(request: RouteRequest, message = "") {
    this.clear();
    this.state = { ...this.state, request, message };
    this.emit();
  }
  async calculate(
    request: RouteRequest,
    settings: RoutingSettings,
    refreshLocation: boolean,
  ): Promise<"location-error" | undefined> {
    this.stop("");
    this.explicitlySelectedID = undefined;
    const calculationSettings = structuredClone(settings);
    const needsLocation =
      refreshLocation || request.destination.name === "Aktueller Standort";
    const generation = this.generation,
      previous = this.state;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = {
      ...previous,
      request: previous.selected ? previous.request : request,
      busy: true,
      locating: needsLocation,
      message: needsLocation
        ? "Standort wird ermittelt …"
        : "Verbindungen werden gesucht …",
      issues: [],
    };
    this.emit();
    let locating = needsLocation,
      received = false;
    try {
      if (!navigator.onLine)
        throw new Error(
          "Keine Internetverbindung. Du kannst deine gespeicherte Reise öffnen.",
        );
      if (needsLocation) {
        const current = await locate(signal);
        request = {
          ...request,
          origin: refreshLocation ? current : request.origin,
          destination:
            request.destination.name === "Aktueller Standort"
              ? current
              : request.destination,
        };
      }
      if (generation !== this.generation) return;
      locating = false;
      const queriedAt = Date.now() / 1000;
      if (request.timing === "now")
        request = { ...request, time: Math.floor(queriedAt) };
      this.resolved?.(request, calculationSettings);
      this.state = {
        ...this.state,
        locating: false,
        message: "Verbindungen werden gesucht …",
      };
      this.emit();
      for await (const update of planRoutes(
        request,
        calculationSettings,
        signal,
        this.client,
      )) {
        if (generation !== this.generation) return;
        const selected =
          received && this.state.selected?.id === this.explicitlySelectedID
            ? this.state.selected
            : undefined;
        let journeys = [...update.journeys];
        if (selected && !journeys.some((j) => j.id === selected.id))
          journeys =
            cyclingExcess(selected, calculationSettings.maxCyclingMinutes) > 0
              ? [
                  ...journeys
                    .filter(
                      (j) =>
                        cyclingExcess(
                          j,
                          calculationSettings.maxCyclingMinutes,
                        ) === 0,
                    )
                    .slice(0, 2),
                  selected,
                ]
              : [selected, ...journeys].slice(0, 3);
        received = true;
        this.state = {
          journeys,
          selected: journeys.find((j) => j.id === selected?.id) ?? journeys[0],
          resultSettings: calculationSettings,
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
        request: received
          ? this.state.request
          : previous.selected
            ? previous.request
            : request,
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
