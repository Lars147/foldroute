import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  errorText,
  PlannerError,
  retainSelectedJourney,
} from "./model";
import { planRoutes } from "./planner";
import { ApiClient } from "./transitous";
import { locate } from "./search";
export interface PlanningRecovery {
  action: "retry" | "adjust";
  request: RouteRequest;
  retryAt?: number;
}
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
  calculationId?: string;
  pendingRequest?: RouteRequest;
  pendingRequestResolved?: boolean;
  staleReason?: string;
  recovery?: PlanningRecovery;
}
function routingContext(request: RouteRequest, settings: RoutingSettings) {
  const place = (value: RouteRequest["origin"]) => [
    value.latitude,
    value.longitude,
    value.stopId,
  ];
  return JSON.stringify([
    place(request.origin),
    place(request.destination),
    request.timing,
    request.time,
    (request.stops ?? []).map((stop) => [place(stop.place), stop.stayMinutes]),
    Object.entries(settings)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value].sort() : value,
      ]),
  ]);
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
  private selectionHeld = false;
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
  stop(
    message = "Suche abgebrochen. Bisherige Ergebnisse bleiben verfügbar.",
    recovery?: PlanningRecovery,
  ) {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.state = {
      ...this.state,
      busy: false,
      locating: false,
      message,
      recovery,
    };
    this.emit();
  }
  clear() {
    this.explicitlySelectedID = undefined;
    this.selectionHeld = false;
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
    this.selectionHeld = false;
    this.state = {
      ...this.state,
      staleReason: this.state.selected
        ? "Diese Verbindung wurde mit den bisherigen Einstellungen berechnet."
        : undefined,
      message: "Einstellungen geändert. Beim Verlassen wird neu berechnet.",
    };
    this.emit();
  }
  holdSelection() {
    this.selectionHeld = true;
  }
  select(id: string) {
    const selected = this.state.journeys.find((j) => j.id === id);
    if (selected) {
      this.explicitlySelectedID = id;
      this.state = { ...this.state, selected };
      this.emit();
    }
  }
  restore(
    journey: Journey,
    request: RouteRequest,
    queriedAt: number,
    resultSettings: RoutingSettings,
  ) {
    this.stop("");
    this.explicitlySelectedID = undefined;
    this.selectionHeld = false;
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
      resultSettings: structuredClone(resultSettings),
    };
    this.emit();
  }
  restoreContext(context: PlanningState) {
    this.stop("");
    this.explicitlySelectedID = undefined;
    this.selectionHeld = false;
    this.state = {
      ...structuredClone(context),
      busy: false,
      locating: false,
      restored: true,
      calculationId: undefined,
      message: context.busy
        ? "Bisherige Ergebnisse dieser Planung. Bei Bedarf erneut versuchen."
        : context.message,
    };
    this.emit();
  }
  returnFromNavigation(
    journey: Journey,
    request: RouteRequest,
    resultSettings: RoutingSettings,
    routeChanged = false,
  ) {
    this.stop("");
    const previous = this.state;
    const sameContext =
      !routeChanged &&
      previous.selected?.id === journey.id &&
      previous.request &&
      previous.resultSettings &&
      routingContext(previous.request, previous.resultSettings) ===
        routingContext(request, resultSettings);
    const selected = structuredClone(journey);
    this.explicitlySelectedID = selected.id;
    this.selectionHeld = false;
    this.state = {
      journeys: sameContext
        ? previous.journeys.map((item) =>
            item.id === selected.id ? selected : item,
          )
        : [selected],
      selected,
      request: structuredClone(request),
      resultSettings: structuredClone(resultSettings),
      queriedAt: previous.queriedAt,
      calculationId: sameContext ? previous.calculationId : undefined,
      busy: false,
      locating: false,
      restored: false,
      message: "",
      issues: sameContext ? previous.issues : [],
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
    this.selectionHeld = false;
    request = structuredClone(request);
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
      pendingRequest: request,
      pendingRequestResolved: false,
      staleReason: previous.selected
        ? (previous.staleReason ??
          "Diese Verbindung stammt aus der bisherigen Abfrage. Die Aktualisierung ist noch nicht abgeschlossen.")
        : undefined,
      busy: true,
      locating: needsLocation,
      message: needsLocation
        ? "Standort wird ermittelt …"
        : "Verbindungen werden gesucht …",
      issues: [],
      recovery: undefined,
    };
    this.emit();
    let locating = false,
      received = false,
      resolved = false;
    try {
      if (!navigator.onLine)
        throw new Error(
          "Keine Internetverbindung. Vorhandene Verbindungen bleiben verfügbar. Sobald du online bist, kannst du über „Route anpassen“ erneut suchen.",
        );
      if (needsLocation) {
        locating = true;
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
      const calculationId = crypto.randomUUID();
      if (request.timing === "now")
        request = {
          ...request,
          time: Math.floor(queriedAt),
        };
      resolved = true;
      this.resolved?.(request, calculationSettings);
      this.state = {
        ...this.state,
        pendingRequest: request,
        pendingRequestResolved: true,
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
        if (!update.journeys.length) {
          this.state = {
            ...this.state,
            busy: update.status === "searching",
            message:
              update.status === "searching"
                ? "Verbindungen optimieren …"
                : update.status === "partial"
                  ? "Suche teilweise abgeschlossen."
                  : "",
            issues: update.issues,
            recovery:
              update.status === "partial"
                ? {
                    action: "retry",
                    request: structuredClone(request),
                    retryAt: this.client.retryAt || undefined,
                  }
                : undefined,
          };
          this.emit();
          continue;
        }
        const selected =
          received &&
          (this.selectionHeld ||
            this.state.selected?.id === this.explicitlySelectedID)
            ? this.state.selected
            : undefined;
        let journeys = [...update.journeys];
        if (selected)
          journeys = retainSelectedJourney(
            journeys,
            selected,
            calculationSettings.maxCyclingMinutes,
            calculationSettings.showCyclingComparison,
          );
        received = true;
        this.state = {
          journeys,
          selected: journeys.find((j) => j.id === selected?.id) ?? journeys[0],
          resultSettings: calculationSettings,
          calculationId,
          request,
          queriedAt,
          busy: update.status === "searching",
          locating: false,
          restored: false,
          message:
            update.status === "searching"
              ? "Verbindungen optimieren …"
              : update.status === "partial"
                ? "Suche teilweise abgeschlossen."
                : "",
          issues: update.issues,
          recovery:
            update.status === "partial"
              ? {
                  action: "retry",
                  request: structuredClone(request),
                  retryAt: this.client.retryAt || undefined,
                }
              : undefined,
        };
        this.emit();
      }
      if (!received)
        throw new PlannerError(
          this.state.issues.length ? "service" : "empty",
          this.state.issues.join(" ") ||
            "Keine passende Route gefunden. Ändere Start, Ziel, Zeit oder Einstellungen.",
        );
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
        pendingRequest: received ? undefined : request,
        pendingRequestResolved: received ? undefined : resolved,
        staleReason: received
          ? undefined
          : previous.selected
            ? (previous.staleReason ??
              "Die Aktualisierung ist nicht abgeschlossen. Diese Verbindung stammt aus der bisherigen Abfrage.")
            : undefined,
        message:
          error instanceof PlannerError &&
          error.code === "empty" &&
          request.timing !== "now" &&
          request.time < Date.now() / 1000
            ? "Für diesen Zeitpunkt wurden keine passenden Verbindungen gefunden."
            : errorText(error),
        recovery: {
          action:
            locating ||
            (error instanceof PlannerError &&
              ["input", "empty"].includes(error.code))
              ? "adjust"
              : "retry",
          request: structuredClone(request),
          retryAt:
            error instanceof PlannerError && error.retryAt
              ? error.retryAt
              : this.client.retryAt || undefined,
        },
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
