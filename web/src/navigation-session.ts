import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type Leg,
  type Place,
  errorText,
  transition,
  journeyStart,
  journeyStops,
  legStops,
} from "./model";
import { distance } from "./geometry";
import {
  fixPlace,
  LocationError,
  quality,
  type LocationFix,
  type LocationQuality,
  type LocationRequestOptions,
} from "./live-location";
import {
  NavigationEngine,
  navigationJourney,
  movement,
  freshTransit,
  projectPath,
  type NavigationProgress,
} from "./navigation-engine";
import {
  assessConnection,
  blocksNavigation,
  type ConnectionAssessment,
} from "./connection-assessment";
import {
  NavigationStore,
  validateNavigationGeometry,
  type NavigationSnapshot,
} from "./navigation-store";
import {
  applyTransit,
  TransitRefresher,
  transitDisruption,
  type Disruption,
  type TransitResult,
  type TransitRefreshOptions,
} from "./transit-refresh";
import { ApiClient } from "./transitous";
import { planRoutes } from "./planner";
import {
  navigatedRouteMeters,
  routeLegMeters,
  type NavigationStatistics,
  type NavigationTrip,
  type TripSummary,
} from "./navigation-summary";

const alternativeDecisionSeconds = 30;
const progressCheckpointMeters = 50;
function reachableAlternative(
  journey: Journey,
  index: number,
  now: number,
  onboard = false,
) {
  const leg = journey.legs[index];
  return (
    !transitDisruption(
      journey,
      index,
      now,
      movement(leg) ? leg.end - leg.start : undefined,
    ) && !(!onboard && index === 0 && leg.kind === "transit" && leg.start < now)
  );
}

export interface NavigationAlternative {
  journey: Journey;
  legIndex: number;
  sourceId: string;
  issueId: string;
  createdAt: number;
  sourceArrival?: number;
  settings: RoutingSettings;
  confirmedStops?: string[];
  reason?: "reroute" | "stop";
}
export interface PreparedNavigation {
  journey: Journey;
  settings: RoutingSettings;
  request: RouteRequest;
  progress?: NavigationProgress;
  assessment: ConnectionAssessment;
  restored: boolean;
  generation: number;
  trip?: NavigationTrip;
  storageEpoch: number;
  resumeEpoch: number;
  tripId?: string;
}
export interface NavigationDependencies {
  routingSettings?: () => RoutingSettings;
  changed: () => void;
  locate: (options?: LocationRequestOptions) => Promise<LocationFix>;
  resumeEnabled: () => boolean;
  statisticsEnabled: () => boolean;
  api: ApiClient;
  store?: NavigationStore;
  refresher?: TransitRefresher;
  plan?: (
    request: RouteRequest,
    settings: RoutingSettings,
    signal: AbortSignal,
  ) => Promise<Journey>;
}
export class NavigationSession {
  engine?: NavigationEngine;
  summary?: TripSummary;
  statistics?: NavigationStatistics;
  statisticsMessage = "";
  private trip?: NavigationTrip;
  private resumeEpoch = 0;
  private completion?: Promise<void>;
  settings?: RoutingSettings;
  request?: RouteRequest;
  fix?: LocationFix;
  fixQuality?: LocationQuality;
  busy = false;
  message = "";
  locationError?: LocationError;
  locating = false;
  storageMessage = "";
  disruption?: Disruption;
  alternative?: NavigationAlternative;
  retryAvailable = false;
  needsLocation = false;
  distantStart = false;
  foreground = true;
  resumeNeedsConfirmation = false;
  assessment?: ConnectionAssessment;
  routeChanged = false;
  private requiredFixAfter = 0;
  private locationGeneration = 0;
  private generation = 0;
  private controller?: AbortController;
  private transitController?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private readonly store: NavigationStore;
  private refresher: TransitRefresher;
  private lastReroute = -Infinity;
  private lastIssue?: string;
  private pendingAlternativeLocation?: {
    engine: NavigationEngine;
    sourceId: string;
    issueId: string;
    reason?: "reroute" | "stop";
  };
  get alternativeNeedsLocation() {
    return !!this.pendingAlternativeLocation;
  }
  private savedKey = "";
  private arrivalCleared = false;
  constructor(private deps: NavigationDependencies) {
    this.store = deps.store ?? new NavigationStore();
    this.refresher = deps.refresher ?? new TransitRefresher();
  }
  private emit() {
    this.deps.changed();
  }
  private async plan(
    request: RouteRequest,
    signal: AbortSignal,
    acceptable: (journey: Journey) => boolean = (journey) =>
      reachableAlternative(
        journey,
        0,
        Math.max(request.time, Date.now() / 1000),
      ),
  ): Promise<{ journey: Journey; settings: RoutingSettings }> {
    const settings = structuredClone(
      this.deps.routingSettings?.() ?? this.settings!,
    );
    if (!navigator.onLine)
      throw new Error(
        "Neue Routen benötigen Internet. Die bisherige Route bleibt verfügbar.",
      );
    // These are navigation-generated departures, not fixed dates entered by
    // the user. A preceding location/trip request may have outlived the time.
    const now = Date.now() / 1000;
    if (
      request.timing === "now" ||
      (request.timing === "depart" && request.time <= now)
    )
      request = { ...request, timing: "now", time: now };
    let candidates: Journey[] = [];
    if (this.deps.plan)
      candidates = [await this.deps.plan(request, settings, signal)];
    else
      for await (const update of planRoutes(
        request,
        settings,
        signal,
        this.deps.api,
      ))
        if (update.journeys.length) candidates = update.journeys;
    signal.throwIfAborted();
    const selected = candidates.find(acceptable);
    if (!selected)
      throw new Error(
        "Keine aktuell erreichbare Verbindung gefunden. Bitte erneut suchen.",
      );
    return { journey: selected, settings };
  }
  get locationQuality() {
    if (!this.fix) return;
    return this.fixQuality === "current" ? quality(this.fix) : this.fixQuality;
  }
  get hasCurrentLocation() {
    return this.locationQuality === "current";
  }
  private usableFix(): LocationFix {
    if (!this.hasCurrentLocation)
      throw new LocationError(
        "unusable",
        "Kein aktueller, genauer Standort. Standort erneut anfragen.",
      );
    return this.fix!;
  }
  private remainingStops(afterCurrent = false) {
    const engine = this.engine!;
    const boundary = engine.progress.legIndex + (afterCurrent ? 1 : 0);
    return engine.journey.legs
      .flatMap((leg, index) =>
        index < boundary
          ? (leg.viaStops ?? [])
              .filter(
                (visit) =>
                  leg.transitStatus?.failure ||
                  leg.transitStatus?.missingViaStops?.includes(visit.stop.id),
              )
              .map((visit) => visit.stop)
          : legStops(leg),
      )
      .filter((stop) => !engine.progress.confirmedStops.includes(stop.id));
  }
  private requestFrom(
    origin: Place,
    time: number,
    afterCurrent = false,
  ): RouteRequest {
    return {
      origin,
      destination:
        this.engine?.journey.destination ?? this.request!.destination,
      timing: time <= Date.now() / 1000 ? "now" : "depart",
      time,
      stops: this.engine
        ? this.remainingStops(afterCurrent)
        : this.request?.stops,
    };
  }
  private abortTasks() {
    this.locationGeneration++;
    this.locating = false;
    this.locationError = undefined;
    this.pendingAlternativeLocation = undefined;
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.transitController?.abort();
    this.transitController = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  cancelStart() {
    if (this.engine) return;
    this.abortTasks();
    this.busy = false;
    this.message = "";
    this.assessment = undefined;
    this.emit();
  }
  async start(
    journey: Journey,
    request: RouteRequest,
    settings: RoutingSettings,
    restored?: NavigationSnapshot,
    replan = false,
  ) {
    const prepared = await this.prepareStart(
      journey,
      request,
      settings,
      restored,
      replan,
    );
    if (!blocksNavigation(prepared.assessment) || restored)
      this.activateStart(prepared);
    return prepared;
  }
  async prepareStart(
    journey: Journey,
    request: RouteRequest,
    settings: RoutingSettings,
    restored?: NavigationSnapshot,
    replan = false,
  ) {
    this.abortTasks();
    this.engine = undefined;
    this.trip = undefined;
    this.summary = undefined;
    this.statistics = undefined;
    this.statisticsMessage = "";
    this.completion = undefined;
    this.routeChanged = replan;
    this.assessment = undefined;
    this.settings = structuredClone(settings);
    this.request = structuredClone(request);
    this.message = "Standort wird geprüft …";
    this.needsLocation = true;
    this.busy = true;
    this.distantStart = false;
    this.retryAvailable = false;
    this.controller = new AbortController();
    const signal = this.controller.signal,
      generation = this.generation;
    this.emit();
    try {
      validateNavigationGeometry(journey);
      const locationHint = setTimeout(() => {
        if (signal.aborted) return;
        this.message = "Warte auf einen genauen Standort …";
        this.emit();
      }, 3000);
      let fix: LocationFix;
      try {
        fix = await this.deps.locate();
      } finally {
        clearTimeout(locationHint);
      }
      signal.throwIfAborted();
      if (quality(fix) !== "current")
        throw new LocationError(
          "unusable",
          "Standort ist zu ungenau oder veraltet. Bitte erneut versuchen.",
        );
      this.fix = fix;
      this.needsLocation = false;
      this.fixQuality = "current";
      this.requiredFixAfter = 0;
      const now = Date.now() / 1000;
      let candidate = navigationJourney(journey);
      let candidateSettings = this.settings;
      const actualStart = journeyStart(journey);
      const separation = distance(fix, actualStart);
      const first = journey.legs[0];
      const startsOnPath =
        movement(first) &&
        fix.accuracy <= 50 &&
        projectPath(
          fix,
          first.coordinates.length > 1
            ? first.coordinates
            : [first.from, first.to],
        ).distance <= Math.max(40, fix.accuracy);
      if (!restored && !replan && !startsOnPath && separation > 25000) {
        this.distantStart = true;
        throw new Error(
          "Der geplante Start ist über 25 km entfernt. Route ab hier planen.",
        );
      }
      if (replan) {
        this.message = "Route ab deinem Standort wird berechnet …";
        this.emit();
        const planned = await this.plan(
          this.requestFrom(fixPlace(fix), now),
          signal,
        );
        candidate = navigationJourney(planned.journey);
        candidateSettings = planned.settings;
      } else if (!restored && !startsOnPath && separation >= 250) {
        this.message = "Anfahrt zum geplanten Start wird berechnet …";
        this.emit();
        if (!navigator.onLine)
          throw new Error("Eine Anfahrt zum Start benötigt Internet.");
        const approachSettings = structuredClone(
          this.deps.routingSettings?.() ?? this.settings!,
        );
        const batch = await this.deps.api.batch(
          {
            origin: fixPlace(fix),
            destination:
              journey.origin.kind === "station"
                ? {
                    ...actualStart,
                    kind: "point",
                    stationId: undefined,
                    stopId: undefined,
                  }
                : actualStart,
            timing: "now",
            time: now,
          },
          approachSettings,
          {
            direct: true,
            directMode: journey.origin.kind === "station" ? "WALK" : "BIKE",
            pre: "BIKE",
            post: "BIKE",
          },
          signal,
        );
        const approach = batch.journeys[0];
        if (!approach) throw new Error("Keine Anfahrt zum Start gefunden.");
        const wait =
          candidate.departure > approach.arrival
            ? [
                transition(
                  "wait",
                  actualStart,
                  approach.arrival,
                  candidate.departure,
                ),
              ]
            : [];
        candidate = navigationJourney({
          ...candidate,
          origin: approach.origin,
          departure: approach.departure,
          legs: [...approach.legs, ...wait, ...candidate.legs],
        });
      } else if (
        !restored &&
        !candidate.legs.some((l) => l.kind === "transit")
      ) {
        const shift = now - candidate.departure;
        candidate.legs = candidate.legs.map((l) => ({
          ...l,
          start: l.start + shift,
          end: l.end + shift,
        }));
        candidate.departure += shift;
        candidate.arrival += shift;
      }
      signal.throwIfAborted();
      const index = restored?.progress.legIndex ?? 0;
      if (navigator.onLine) {
        this.message = "Fahrtdaten werden geprüft …";
        this.emit();
        const updates = await this.refresher.refresh(
          candidate.legs.slice(index),
          signal,
        );
        candidate = applyTransit(candidate, index, updates);
      }
      signal.throwIfAborted();
      // Restoration never silently skips a saved section based on elapsed time.
      const checkedAt = Date.now() / 1000;
      this.assessment = assessConnection(candidate, index, checkedAt, {
        fix: restored ? undefined : fix,
        onboard: !!restored && candidate.legs[index].kind === "transit",
      });
      this.message = this.assessment.message;
      let storageEpoch = 0;
      let resumeEpoch = 0;
      if (this.deps.resumeEnabled() || this.deps.statisticsEnabled()) {
        try {
          const stored = await this.store.readStatistics();
          storageEpoch = stored.epoch;
          resumeEpoch = stored.resumeEpoch ?? 0;
        } catch {
          this.storageMessage =
            "Navigation läuft. Gesamtstatistik konnte nicht gelesen werden.";
        }
        signal.throwIfAborted();
      }
      return {
        journey: candidate,
        request: structuredClone(request),
        settings: candidateSettings,
        progress: restored?.progress,
        assessment: this.assessment,
        restored: !!restored,
        generation,
        trip: restored?.trip,
        storageEpoch,
        resumeEpoch,
        tripId: restored?.sessionId,
      } satisfies PreparedNavigation;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.controller = undefined;
        this.emit();
      }
    }
  }
  activateStart(prepared: PreparedNavigation) {
    if (prepared.generation !== this.generation) return false;
    if (!this.fix || quality(this.fix) !== "current") {
      this.needsLocation = true;
      throw new LocationError(
        "unusable",
        "Standort ist zu ungenau oder veraltet. Bitte erneut versuchen.",
      );
    }
    prepared.assessment = assessConnection(
      prepared.journey,
      prepared.progress?.legIndex ?? 0,
      Date.now() / 1000,
      {
        fix: prepared.restored ? undefined : this.fix,
        onboard:
          prepared.restored &&
          prepared.journey.legs[prepared.progress?.legIndex ?? 0].kind ===
            "transit",
      },
    );
    this.assessment = prepared.assessment;
    if (blocksNavigation(prepared.assessment) && !prepared.restored)
      return false;
    this.request = structuredClone(prepared.request);
    this.resumeEpoch = prepared.resumeEpoch;
    this.trip = prepared.trip
      ? structuredClone(prepared.trip)
      : {
          id: prepared.tripId ?? crypto.randomUUID(),
          startedAt: Date.now() / 1000,
          originName: prepared.journey.origin.name,
          distanceMeters: 0,
          routeMeters:
            prepared.restored && prepared.progress
              ? navigatedRouteMeters(prepared.journey, prepared.progress)
              : 0,
          sinceResume: prepared.restored,
          storageEpoch: prepared.storageEpoch,
        };
    this.activate(prepared.journey, prepared.progress, prepared.settings);
    if (!prepared.restored && this.fix) this.engine!.update(this.fix);
    this.assessment = prepared.assessment;
    this.resumeNeedsConfirmation =
      prepared.restored &&
      !movement(this.engine!.leg) &&
      this.engine!.leg.end <= Date.now() / 1000;
    this.message = prepared.restored
      ? "Navigation fortgesetzt. Prüfe deinen aktuellen Abschnitt."
      : "";
    this.persist(true);
    this.emit();
    return true;
  }
  private activate(
    journey: Journey,
    progress?: NavigationSnapshot["progress"],
    settings = this.settings!,
  ) {
    validateNavigationGeometry(journey);
    this.locationGeneration++;
    this.locating = false;
    const replacing = !!this.engine;
    const previous = this.engine;
    if (replacing) {
      this.updateTrip();
      this.routeChanged = true;
    }
    this.settings = structuredClone(settings);
    this.engine = new NavigationEngine(navigationJourney(journey), progress);
    if (replacing && this.trip) {
      const retainedMeters =
        previous!.leg.navigationId === this.engine.leg.navigationId
          ? this.trip.routeMeters -
            previous!.journey.legs
              .slice(0, previous!.progress.legIndex)
              .reduce((sum, leg) => sum + routeLegMeters(leg), 0)
          : 0;
      this.trip.routeMeters = navigatedRouteMeters(
        this.engine.journey,
        this.engine.progress,
      );
      if (retainedMeters > 0)
        this.trip.routeMeters = Math.max(
          this.trip.routeMeters,
          this.engine.journey.legs
            .slice(0, this.engine.progress.legIndex)
            .reduce((sum, leg) => sum + routeLegMeters(leg), 0) +
            retainedMeters,
        );
    }
    this.request = {
      ...this.request!,
      origin: journey.origin,
      destination: journey.destination,
      stops: journeyStops(journey),
    };
    this.alternative = undefined;
    this.pendingAlternativeLocation = undefined;
    this.disruption = undefined;
    this.lastIssue = undefined;
    this.savedKey = "";
    this.arrivalCleared = false;
    this.retryAvailable = false;
    this.resumeNeedsConfirmation = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    this.persist();
  }
  updateLocation(
    fix?: LocationFix,
    state?: LocationQuality,
    error?: LocationError,
  ) {
    if (fix && fix.timestamp < this.requiredFixAfter) state = "stale";
    if (fix && state === "current") state = quality(fix);
    this.fix = fix;
    this.fixQuality = state;
    if (this.hasCurrentLocation) this.locationError = undefined;
    else if (error) this.locationError = error;
    if (!this.engine || !this.foreground) return;
    if (this.busy) {
      this.emit();
      return;
    }
    if (!fix || state !== "current") this.engine.invalidateLocation();
    else if (
      this.engine.update(fix) &&
      !this.busy &&
      !this.retryAvailable &&
      Date.now() / 1000 - this.lastReroute >= 30
    )
      void this.reroute();
    this.discardChangedAlternative();
    this.persist();
    this.emit();
  }
  async retryLocation() {
    const engine = this.engine;
    if (
      !engine ||
      !this.foreground ||
      this.locating ||
      this.busy ||
      engine.phase === "arrived"
    )
      return;
    const generation = this.generation,
      request = ++this.locationGeneration;
    const current = () =>
      generation === this.generation &&
      request === this.locationGeneration &&
      this.engine === engine &&
      this.foreground;
    this.locating = true;
    this.locationError = undefined;
    this.requiredFixAfter = Date.now();
    this.fixQuality = "stale";
    engine.invalidateLocation();
    this.emit();
    let located = false;
    try {
      const fix = await this.deps.locate({ fresh: true });
      if (!current()) return;
      this.updateLocation(fix, "current");
      this.usableFix();
      located = true;
    } catch (error) {
      if (
        current() &&
        !this.hasCurrentLocation &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        this.locationError =
          error instanceof LocationError
            ? error
            : new LocationError("unavailable", errorText(error));
    } finally {
      if (current()) {
        this.locating = false;
        this.emit();
      }
    }
    if (located && current()) await this.resumeAlternativeAfterLocation();
  }
  private discardChangedAlternative() {
    if (
      this.alternative &&
      this.alternative.sourceId !== this.engine?.leg.navigationId
    ) {
      this.alternative = undefined;
      this.lastIssue = undefined;
    }
    const pending = this.pendingAlternativeLocation;
    if (
      pending &&
      (pending.engine !== this.engine ||
        pending.sourceId !== this.engine?.leg.navigationId)
    )
      this.pendingAlternativeLocation = undefined;
  }
  setForeground(value: boolean) {
    if (value === this.foreground) return;
    this.foreground = value;
    if (!value) {
      this.locationGeneration++;
      this.locating = false;
      this.persist(true);
      this.requiredFixAfter = Date.now();
      this.fixQuality = "stale";
      this.engine?.invalidateLocation();
      this.transitController?.abort();
      this.transitController = undefined;
      this.controller?.abort();
    } else if (this.engine) void this.refresh("foreground");
    this.emit();
  }
  private tick() {
    if (
      !this.engine ||
      !this.foreground ||
      this.busy ||
      this.engine.phase === "arrived"
    )
      return;
    if (!this.fix || quality(this.fix) !== "current")
      this.engine.invalidateLocation();
    // After restoration/backgrounding, require a fresh fix before timer-driven progress.
    if (
      !this.resumeNeedsConfirmation &&
      this.fix &&
      quality(this.fix) === "current" &&
      this.fixQuality === "current"
    )
      this.engine.tick();
    this.discardChangedAlternative();
    this.assessment = assessConnection(
      this.engine.journey,
      this.engine.progress.legIndex,
      Date.now() / 1000,
      {
        remainingMovement: movement(this.engine.leg)
          ? this.engine.remainingSeconds
          : undefined,
        onboard: this.engine.leg.kind === "transit",
      },
    );
    this.persist();
    this.emit();
    void this.refresh();
  }
  private applyTransitResults(
    engine: NavigationEngine,
    result: Map<string, TransitResult>,
  ) {
    if (!result.size) return;
    engine.applyJourney(
      applyTransit(engine.journey, engine.progress.legIndex, result),
    );
    this.assessment = assessConnection(
      engine.journey,
      engine.progress.legIndex,
      Date.now() / 1000,
      {
        remainingMovement: movement(engine.leg)
          ? engine.remainingSeconds
          : undefined,
        onboard: engine.leg.kind === "transit",
      },
    );
    const detected = transitDisruption(
      engine.journey,
      engine.progress.legIndex,
      Date.now() / 1000,
      movement(engine.leg) ? engine.remainingSeconds : undefined,
    );
    if (!this.alternative?.reason) this.disruption = detected;
    if (!this.disruption) {
      this.alternative = undefined;
      this.pendingAlternativeLocation = undefined;
      this.lastIssue = undefined;
    }
    if (this.alternative && this.alternative.issueId !== this.disruption?.id)
      this.alternative = undefined;
    if (
      this.disruption &&
      !this.alternative &&
      this.assessment.status !== "risk" &&
      this.lastIssue !== this.disruption.id &&
      engine.leg.kind !== "stop"
    ) {
      this.lastIssue = this.disruption.id;
      void this.proposeAlternative();
    }
    this.persist(result.size > 0);
    this.emit();
  }
  async refresh(reason: TransitRefreshOptions["reason"] = "regular") {
    const engine = this.engine;
    if (
      !engine ||
      engine.phase === "arrived" ||
      this.busy ||
      !this.foreground ||
      !navigator.onLine
    )
      return;
    // One lifetime signal, while the refresher independently owns active/future slots.
    // A slow future request must not hold up the next current-trip poll.
    const controller = (this.transitController ??= new AbortController());
    let delivered = false;
    const receive = (result: Map<string, TransitResult>) => {
      if (
        controller.signal.aborted ||
        this.engine !== engine ||
        engine.phase === "arrived"
      )
        return;
      delivered = true;
      this.applyTransitResults(engine, result);
    };
    try {
      const result = await this.refresher.refresh(
        engine.journey.legs.slice(engine.progress.legIndex),
        controller.signal,
        Date.now() / 1000,
        {
          reason,
          activeTripId: engine.leg.transitReference?.tripId,
          onResult: receive,
        },
      );
      // Also supports injected refreshers returning only the final batch.
      if (!delivered) receive(result);
    } catch (error) {
      if (!controller.signal.aborted && this.engine === engine) {
        this.message = errorText(error);
        this.emit();
      }
    }
  }
  private async changeRoute(
    work: (
      signal: AbortSignal,
      engine: NavigationEngine,
    ) => Promise<void | string>,
    label: string,
  ) {
    const engine = this.engine;
    if (!engine || this.busy || engine.phase === "arrived") return;
    this.transitController?.abort();
    this.transitController = undefined;
    this.controller = new AbortController();
    const controller = this.controller;
    this.busy = true;
    this.message = label;
    this.retryAvailable = false;
    this.emit();
    try {
      const message = await work(controller.signal, engine);
      if (!controller.signal.aborted) this.message = message ?? "";
    } catch (error) {
      if (controller.signal.aborted && this.engine === engine) {
        this.message = "Berechnung unterbrochen. Erneut versuchen.";
        this.retryAvailable = true;
      }
      if (!controller.signal.aborted && this.engine === engine) {
        if (error instanceof LocationError) {
          this.locationError = error;
          this.message = "";
        } else
          this.message = `${errorText(error)} Bisherige Route bleibt erhalten.`;
        this.retryAvailable = true;
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.busy = false;
        this.persist();
        this.emit();
      }
    }
  }
  async reroute() {
    this.lastReroute = Date.now() / 1000;
    if (
      this.engine?.journey.legs
        .slice(this.engine.progress.legIndex)
        .some((leg) => leg.kind === "transit")
    ) {
      this.disruption = {
        id: `reroute-${this.engine.leg.navigationId}`,
        message: "Route verlassen. Die bisherige Verbindung bleibt aktiv.",
      };
      return this.proposeAlternative("reroute");
    }
    return this.changeRoute(async (signal, engine) => {
      if (engine.leg.kind === "transit")
        throw new Error("Zunächst den Ausstieg bestätigen.");
      const { journey: route, settings: routeSettings } = await this.plan(
        this.requestFrom(fixPlace(this.usableFix()), Date.now() / 1000),
        signal,
      );
      signal.throwIfAborted();
      if (this.engine !== engine) return;
      const confirmedStops = engine.progress.confirmedStops;
      this.activate(
        route,
        {
          legIndex: 0,
          maneuverIndex: 0,
          meters: 0,
          confirmedStops,
        },
        routeSettings,
      );
    }, "Route wird angepasst …");
  }
  async continueStop() {
    const engine = this.engine;
    if (!engine || engine.leg.kind !== "stop") return;
    const stop = engine.leg,
      now = Date.now() / 1000;
    const candidate = structuredClone(engine.journey);
    candidate.legs[engine.progress.legIndex].end = Math.max(now, stop.end);
    const updated = applyTransit(
      candidate,
      engine.progress.legIndex,
      new Map(),
    );
    if (
      !blocksNavigation(
        assessConnection(updated, engine.progress.legIndex, now),
      )
    ) {
      engine.applyJourney(updated);
      if (stop.end > now) {
        const copy = structuredClone(updated);
        copy.legs.splice(engine.progress.legIndex + 1, 0, {
          ...transition("wait", stop.to, now, stop.end),
          navigationId: crypto.randomUUID(),
        });
        engine.journey = copy;
      }
      engine.advance(true);
      this.resumeNeedsConfirmation = false;
      this.persist(true);
      this.emit();
      return;
    }
    this.disruption = {
      id: `stop-${stop.navigationId}`,
      message: "Weiterfahrt prüfen. Die bisherige Verbindung bleibt aktiv.",
    };
    return this.proposeAlternative("stop");
  }
  completeLeg(expectedId: string) {
    if (
      !this.engine ||
      this.busy ||
      this.engine.leg.navigationId !== expectedId ||
      this.engine.leg.kind === "stop"
    )
      return;
    this.resumeNeedsConfirmation = false;
    this.engine.advance(true);
    this.alternative = undefined;
    this.pendingAlternativeLocation = undefined;
    this.persist(true);
    this.emit();
  }
  async proposeAlternative(reason?: "reroute" | "stop") {
    const engine = this.engine,
      issue = this.disruption;
    if (
      !engine ||
      !issue ||
      this.busy ||
      (engine.leg.kind === "stop" && reason !== "stop")
    )
      return;
    this.alternative = undefined;
    if (engine.leg.kind === "transit" && engine.leg.transitStatus?.cancelled) {
      this.message =
        "Ausstieg vor Ort prüfen. Nach dem Ausstieg den Abschnitt bestätigen und neu planen.";
      this.emit();
      return;
    }
    return this.changeRoute(async (signal, active) => {
      const leg = active.leg,
        sourceId = leg.navigationId!;
      const onboard = leg.kind === "transit",
        now = Date.now() / 1000;
      if (!onboard) {
        this.pendingAlternativeLocation = {
          engine: active,
          sourceId,
          issueId: issue.id,
          reason,
        };
        this.usableFix();
      }
      this.pendingAlternativeLocation = undefined;
      const origin = onboard ? leg.to : fixPlace(this.usableFix());
      const foldingDuration = (this.deps.routingSettings?.() ?? this.settings!)
        .foldingDuration;
      const departure = onboard
        ? Math.max(now, leg.end) + foldingDuration
        : reason === "stop"
          ? Math.max(now, leg.end) + alternativeDecisionSeconds
          : now + alternativeDecisionSeconds;
      const { journey: route, settings: routeSettings } = await this.plan(
        this.requestFrom(origin, departure, onboard || reason === "stop"),
        signal,
        (candidate) =>
          reachableAlternative(
            candidate,
            0,
            onboard
              ? Math.max(departure, Date.now() / 1000)
              : Date.now() / 1000 + alternativeDecisionSeconds,
          ),
      );
      signal.throwIfAborted();
      if (
        this.engine !== active ||
        active.leg.navigationId !== sourceId ||
        this.disruption?.id !== issue.id
      )
        return;
      const prefix = onboard
        ? [
            ...active.journey.legs.slice(0, active.progress.legIndex + 1),
            transition(
              "unfold",
              origin,
              departure - foldingDuration,
              departure,
            ),
          ]
        : reason === "stop" && leg.end > now
          ? [transition("wait", leg.to, now, leg.end)]
          : [];
      // Outstanding visits belong to the replacement itinerary, not to both
      // the failed train prefix and the new route.
      const reassigned = new Set(journeyStops(route).map((stop) => stop.id));
      for (let i = 0; i < prefix.length; i++) {
        const part = prefix[i];
        if (!part.viaStops?.some((visit) => reassigned.has(visit.stop.id)))
          continue;
        const viaStops = part.viaStops.filter(
          (visit) => !reassigned.has(visit.stop.id),
        );
        prefix[i] = {
          ...part,
          viaStops: viaStops.length ? viaStops : undefined,
          transitStatus: {
            ...part.transitStatus,
            missingViaStops: part.transitStatus?.missingViaStops?.filter(
              (id) => !reassigned.has(id),
            ),
          },
        };
      }
      const proposed = navigationJourney(
        prefix.length
          ? {
              ...route,
              origin: onboard ? active.journey.origin : prefix[0].from,
              departure: onboard ? active.journey.departure : prefix[0].start,
              legs: [...prefix, ...route.legs],
            }
          : route,
      );
      validateNavigationGeometry(proposed);
      this.alternative = {
        settings: routeSettings,
        journey: proposed,
        legIndex: onboard ? active.progress.legIndex : 0,
        sourceId,
        issueId: issue.id,
        createdAt: Date.now() / 1000,
        sourceArrival: onboard ? leg.end : undefined,
        reason,
        confirmedStops:
          reason === "stop" && leg.stop
            ? [...active.progress.confirmedStops, leg.stop.id]
            : undefined,
      };
      return "";
    }, "Alternative wird gesucht …");
  }
  async resumeAlternativeAfterLocation() {
    const pending = this.pendingAlternativeLocation;
    this.pendingAlternativeLocation = undefined;
    if (
      pending &&
      pending.engine === this.engine &&
      pending.sourceId === this.engine?.leg.navigationId &&
      pending.issueId === this.disruption?.id
    )
      await this.proposeAlternative(pending.reason);
  }
  async acceptAlternative() {
    const engine = this.engine,
      candidate = this.alternative;
    if (!engine || !candidate || this.busy) return;
    if (
      candidate.sourceId !== engine.leg.navigationId ||
      candidate.issueId !== this.disruption?.id ||
      Date.now() / 1000 - candidate.createdAt > 120 ||
      blocksNavigation(
        assessConnection(
          candidate.journey,
          candidate.legIndex,
          Date.now() / 1000,
          { onboard: candidate.sourceArrival !== undefined },
        ),
      ) ||
      (candidate.sourceArrival !== undefined &&
        candidate.sourceArrival !== engine.leg.end)
    ) {
      this.alternative = undefined;
      if (!this.disruption) {
        this.message =
          "Vorschlag nicht mehr aktuell. Die bisherige Route bleibt aktiv.";
        this.emit();
        return;
      }
      await this.proposeAlternative(candidate.reason);
      return;
    }
    await this.changeRoute(async () => {
      this.alternative = undefined;
      this.activate(
        candidate.journey,
        {
          legIndex: candidate.legIndex,
          maneuverIndex: 0,
          meters: 0,
          confirmedStops:
            candidate.confirmedStops ?? engine.progress.confirmedStops,
        },
        candidate.settings,
      );
    }, "Verbindung wird geprüft …");
  }
  dismissAlternative() {
    this.alternative = undefined;
    this.emit();
  }
  private persist(force = false) {
    const engine = this.engine;
    if (!engine) return;
    this.updateTrip();
    if (engine.phase === "arrived") {
      if (!this.arrivalCleared) {
        this.arrivalCleared = true;
        this.transitController?.abort();
        this.controller?.abort();
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.alternative = undefined;
        this.disruption = undefined;
        const trip = this.trip!;
        const arrivedAt = Date.now() / 1000;
        this.summary = Object.freeze({
          id: trip.id,
          originName: trip.originName,
          destinationName: engine.journey.destination.name,
          arrivedAt,
          elapsedSeconds: Math.max(0, arrivedAt - trip.startedAt),
          distanceMeters: trip.distanceMeters,
          sinceResume: trip.sinceResume,
          storageEpoch: trip.storageEpoch,
        });
        this.completion = this.finishTrip(this.summary);
      }
      return;
    }
    if (!this.deps.resumeEnabled()) return;
    const key = JSON.stringify([
      engine.journey.id,
      engine.progress.legIndex,
      engine.progress.maneuverIndex,
      Math.floor(engine.progress.meters / progressCheckpointMeters),
      engine.progress.confirmedStops,
      engine.progress.transitStop,
    ]);
    if (!force && key === this.savedKey) return;
    this.savedKey = key;
    const snapshot: NavigationSnapshot = structuredClone({
      version: 1,
      savedAt: Date.now() / 1000,
      journey: engine.journey,
      request: {
        ...this.request!,
        stops: journeyStops(engine.journey),
      },
      settings: this.settings!,
      progress: engine.progress,
      trip: this.trip,
      resumeEpoch: this.resumeEpoch,
    });
    void this.store.save(snapshot).catch(() => {
      this.storageMessage =
        "Navigation läuft. Wiederaufnahme konnte nicht gespeichert werden.";
      this.emit();
    });
  }
  private updateTrip() {
    if (!this.engine || !this.trip || this.summary) return;
    const meters = navigatedRouteMeters(
      this.engine.journey,
      this.engine.progress,
      this.engine.phase === "arrived",
    );
    this.trip.distanceMeters += Math.max(0, meters - this.trip.routeMeters);
    this.trip.routeMeters = Math.max(this.trip.routeMeters, meters);
  }
  private async finishTrip(summary: TripSummary) {
    if (!this.deps.statisticsEnabled()) {
      this.statisticsMessage = "Gesamtstatistik ist ausgeschaltet.";
      try {
        await this.store.clear(summary.id);
      } catch {
        this.storageMessage =
          "Gespeicherter Navigationsstand konnte nicht gelöscht werden.";
        this.emit();
      }
      return;
    }
    this.statisticsMessage = "Gesamtstatistik wird gespeichert …";
    try {
      const statistics = await this.store.completeTrip(summary);
      if (this.summary !== summary) return;
      this.statistics = statistics;
      this.statisticsMessage = statistics
        ? ""
        : "Gesamtstatistik wurde gelöscht oder Speicherung ausgeschaltet.";
    } catch {
      if (this.summary !== summary) return;
      this.statisticsMessage =
        "Gesamtstatistik konnte nicht gespeichert werden.";
    }
    this.emit();
  }
  async stop() {
    const tripId = this.trip?.id;
    const completion = this.completion;
    this.abortTasks();
    this.engine = undefined;
    this.busy = false;
    this.alternative = undefined;
    this.disruption = undefined;
    this.assessment = undefined;
    this.message = "";
    this.savedKey = "";
    this.emit();
    await completion;
    await this.store.clear(tripId);
  }
}
