import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type PlanningPhase,
  type PlanningUpdate,
  type PlanningRoutePreview,
  errorText,
  PlannerError,
  retainSelectedJourney,
  selectJourneys,
} from "./model";
import { searchMessage, stoppedSearchMessage } from "./planning-progress";
import { planRoutes } from "./planner";
import { ApiClient } from "./transitous";
import { locate } from "./search";
import { PlanningRoutingClient } from "./planning-routing";
export interface PlanningRecovery {
  action: "retry" | "adjust";
  mode?: "search" | "optimization";
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
  phase?: PlanningPhase;
  activeSection?: number;
  routePreview?: PlanningRoutePreview;
  incompletePhases?: PlanningPhase[];
  searchStatus?: PlanningUpdate["status"] | "stopped";
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
  private continuation?: {
    calculationId: string;
    request: RouteRequest;
    settings: RoutingSettings;
    client: PlanningRoutingClient;
  };
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
  private progress(
    update: PlanningUpdate,
    request: RouteRequest,
    hasResults: boolean,
  ) {
    return {
      busy: update.status === "searching",
      searchStatus: update.status,
      phase: update.phase,
      activeSection: update.activeSection,
      routePreview:
        update.status === "searching" && !hasResults && !this.state.selected
          ? update.routePreview
          : undefined,
      incompletePhases: update.incompletePhases,
      message: searchMessage(
        update.status,
        update.phase,
        update.incompletePhases,
        hasResults,
        update.issues,
      ),
      issues: update.issues,
      recovery:
        update.status === "partial"
          ? {
              action: "retry" as const,
              ...(hasResults ? { mode: "optimization" as const } : {}),
              request: structuredClone(request),
              retryAt: this.client.retryAt || undefined,
            }
          : undefined,
    };
  }
  stop(
    message = "Suche abgebrochen. Bisherige Ergebnisse bleiben verfügbar.",
    recovery?: PlanningRecovery,
  ) {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.continuation = undefined;
    this.state = {
      ...this.state,
      busy: false,
      locating: false,
      message,
      activeSection: undefined,
      routePreview: undefined,
      recovery,
      searchStatus: this.state.busy ? "stopped" : this.state.searchStatus,
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
    let message = context.busy
      ? "Bisherige Ergebnisse dieser Planung. Bei Bedarf erneut versuchen."
      : context.message;
    if (!message && context.phase && context.searchStatus)
      message =
        context.searchStatus === "stopped"
          ? stoppedSearchMessage
          : searchMessage(
              context.searchStatus,
              context.phase,
              context.incompletePhases ?? [],
              context.journeys.length > 0,
              context.issues,
            );
    this.state = {
      ...structuredClone(context),
      busy: false,
      locating: false,
      restored: true,
      calculationId: undefined,
      routePreview: undefined,
      recovery: context.recovery
        ? { ...structuredClone(context.recovery), mode: "search" }
        : undefined,
      message,
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
      phase: undefined,
      activeSection: undefined,
      routePreview: undefined,
      incompletePhases: [],
      searchStatus: undefined,
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
      const continuation = {
        calculationId,
        request: structuredClone(request),
        settings: structuredClone(calculationSettings),
        client: new PlanningRoutingClient(this.client),
      };
      this.continuation = continuation;
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
        continuation.client,
      )) {
        if (generation !== this.generation) return;
        const progress = this.progress(
          update,
          request,
          received || update.journeys.length > 0,
        );
        if (!update.journeys.length) {
          this.state = {
            ...this.state,
            ...progress,
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
          ...progress,
          locating: false,
          restored: false,
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
      const phase =
        this.state.phase ?? (request.stops?.length ? "via" : "base");
      const incompletePhases = received
        ? [...new Set([...(this.state.incompletePhases ?? []), phase])]
        : [];
      const issues = received
        ? [...new Set([...this.state.issues, errorText(error)])]
        : this.state.issues;
      this.state = {
        ...(received ? this.state : previous),
        request: received
          ? this.state.request
          : previous.selected
            ? previous.request
            : request,
        busy: false,
        locating: false,
        phase: received ? phase : undefined,
        activeSection: undefined,
        routePreview: undefined,
        incompletePhases,
        searchStatus: received ? "partial" : undefined,
        issues,
        pendingRequest: received ? undefined : request,
        pendingRequestResolved: received ? undefined : resolved,
        staleReason: received
          ? undefined
          : previous.selected
            ? (previous.staleReason ??
              "Die Aktualisierung ist nicht abgeschlossen. Diese Verbindung stammt aus der bisherigen Abfrage.")
            : undefined,
        message: received
          ? searchMessage("partial", phase, incompletePhases, true, issues)
          : error instanceof PlannerError &&
              error.code === "empty" &&
              request.timing !== "now" &&
              request.time < Date.now() / 1000
            ? "Für diesen Zeitpunkt wurden keine passenden Verbindungen gefunden."
            : errorText(error),
        recovery: {
          action:
            !received &&
            (locating ||
              (error instanceof PlannerError &&
                ["input", "empty"].includes(error.code)))
              ? "adjust"
              : "retry",
          ...(received ? { mode: "optimization" as const } : {}),
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
        this.state = {
          ...this.state,
          busy: false,
          locating: false,
          routePreview: undefined,
        };
        this.emit();
      }
    }
  }
  async resumeOptimization() {
    const continuation = this.continuation;
    if (
      !continuation ||
      this.state.busy ||
      this.state.recovery?.mode !== "optimization" ||
      this.state.calculationId !== continuation.calculationId ||
      this.state.restored ||
      this.state.staleReason ||
      this.state.pendingRequest ||
      !this.state.journeys.length ||
      !this.state.request ||
      !this.state.resultSettings ||
      routingContext(this.state.request, this.state.resultSettings) !==
        routingContext(continuation.request, continuation.settings) ||
      !navigator.onLine ||
      Math.max(this.state.recovery.retryAt ?? 0, this.client.retryAt) >
        Date.now() / 1000
    )
      return;

    const generation = ++this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const { request, settings, client } = continuation;
    const candidates = new Map(this.state.journeys.map((j) => [j.id, j]));
    this.state = {
      ...this.state,
      busy: true,
      locating: false,
      message: "Optimierung läuft …",
      issues: [],
      incompletePhases: [],
      searchStatus: "searching",
      recovery: undefined,
    };
    this.emit();
    try {
      for await (const update of planRoutes(
        structuredClone(request),
        structuredClone(settings),
        signal,
        client,
      )) {
        if (generation !== this.generation) return;
        for (const journey of update.journeys)
          candidates.set(journey.id, journey);
        const selected = this.state.selected;
        let journeys = selectJourneys(
          [...candidates.values()],
          request.timing,
          4,
          settings.maxCyclingMinutes,
          settings.showCyclingComparison,
        );
        if (selected)
          journeys = retainSelectedJourney(
            journeys,
            selected,
            settings.maxCyclingMinutes,
            settings.showCyclingComparison,
          );
        this.state = {
          ...this.state,
          ...this.progress(update, request, true),
          journeys,
          selected: journeys.find((j) => j.id === selected?.id) ?? journeys[0],
        };
        this.emit();
      }
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      const phase = this.state.phase ?? "base";
      this.state = {
        ...this.state,
        ...this.progress(
          {
            journeys: this.state.journeys,
            status: "partial",
            phase,
            incompletePhases: [
              ...new Set([...(this.state.incompletePhases ?? []), phase]),
            ],
            issues: [...new Set([...this.state.issues, errorText(error)])],
          },
          request,
          true,
        ),
      };
      if (error instanceof PlannerError && error.retryAt)
        this.state.recovery!.retryAt = error.retryAt;
      this.emit();
    } finally {
      if (generation === this.generation) {
        this.controller = undefined;
        this.state = { ...this.state, busy: false, locating: false };
        this.emit();
      }
    }
  }
}
