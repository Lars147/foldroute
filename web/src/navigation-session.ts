import { systemClock, type Clock } from "./clock";
import { NavigationPersistence } from "./navigation-persistence";
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
import {
  NavigationRoutePlanner,
  composeStreetRepair,
  composeAlternative,
  reachableAlternative,
  unavailableBoarding,
} from "./navigation-route-planner";
import {
  navigatedRouteMeters,
  routeLegMeters,
  type NavigationStatistics,
  type NavigationTrip,
  type TripSummary,
} from "./navigation-summary";

const alternativeDecisionSeconds = 30;
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
  clock?: Clock;
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
  private readonly clock: Clock;
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
  private readonly persistence: NavigationPersistence;
  private refresher: TransitRefresher;
  private readonly routePlanner: NavigationRoutePlanner;
  private lastReroute = -Infinity;
  private streetRetryAt = 0;
  private streetFailures = 0;
  private streetEngine?: NavigationEngine;
  private lastIssue?: string;
  private pendingAlternativeLocation?: {
    engine: NavigationEngine;
    sourceId: string;
    issueId: string;
    reason?: "reroute" | "stop";
  };
  private completionPaused = false;
  private resumeValidation?: {
    engine: NavigationEngine;
    legId: string;
    transitChecked: boolean;
    check?: AbortController;
  };
  private syncResumeGuard() {
    if (this.engine)
      this.engine.automaticProgressBlocked =
        this.resumeNeedsConfirmation ||
        (!!this.resumeValidation &&
          this.resumeValidation.engine === this.engine &&
          this.resumeValidation.legId === this.engine.leg.navigationId);
  }

  private reconcileResumeValidation() {
    const validation = this.resumeValidation;
    if (validation) {
      const engine = this.engine;
      if (
        validation.engine !== engine ||
        validation.legId !== engine?.leg.navigationId
      ) {
        this.resumeValidation = undefined;
      } else {
        // Saved times are provisional. Recheck against the latest times until
        // both trip validation and a usable location have completed.
        this.resumeNeedsConfirmation =
          !movement(engine.leg) && engine.leg.end <= this.clock.now() / 1000;
        if (
          validation.transitChecked &&
          this.hasCurrentLocation &&
          !this.resumeNeedsConfirmation
        )
          this.resumeValidation = undefined;
      }
    }
    this.syncResumeGuard();
  }

  setCompletionPaused(paused: boolean) {
    this.completionPaused = paused;
    this.engine?.setCompletionPaused(paused);
  }

  cancelCompletionCountdown() {
    this.engine?.cancelCompletionCountdown();
  }

  get alternativeNeedsLocation() {
    return !!this.pendingAlternativeLocation;
  }
  private arrivalCleared = false;
  private pendingCompletionUndo?: {
    engine: NavigationEngine;
    nextId: string;
    progress: NavigationProgress;
    trip?: NavigationTrip;
    resumeNeedsConfirmation: boolean;
    resumeValidationPending: boolean;
    timing?: {
      id: string;
      start: number;
      end: number;
      appliedStart: number;
      appliedEnd: number;
    };
  };
  get completionUndo() {
    const undo = this.pendingCompletionUndo;
    if (
      undo &&
      (this.engine !== undo.engine ||
        this.engine.phase !== "active" ||
        this.engine.leg.navigationId !== undo.nextId)
    )
      this.pendingCompletionUndo = undefined;
    return this.pendingCompletionUndo;
  }
  discardCompletionUndo(expected = this.pendingCompletionUndo) {
    if (this.pendingCompletionUndo === expected)
      this.pendingCompletionUndo = undefined;
  }
  undoLastCompletion() {
    const undo = this.completionUndo;
    if (!undo) return false;
    this.discardCompletionUndo();
    this.controller?.abort();
    this.controller = undefined;
    this.transitController?.abort();
    this.transitController = undefined;
    this.locationGeneration++;
    this.locating = false;
    this.busy = false;
    const journey = structuredClone(undo.engine.journey);
    const timing = undo.timing;
    const leg =
      timing && journey.legs.find((leg) => leg.navigationId === timing.id);
    if (leg && timing) {
      if (leg.start === timing.appliedStart) leg.start = timing.start;
      if (leg.end === timing.appliedEnd) leg.end = timing.end;
    }
    this.engine = new NavigationEngine(journey, undo.progress, this.clock);
    this.engine.setCompletionPaused(this.completionPaused);
    this.engine.cancelCompletionCountdown();
    this.trip = undo.trip;
    this.resumeNeedsConfirmation =
      undo.resumeNeedsConfirmation ||
      (undo.resumeValidationPending &&
        !movement(this.engine.leg) &&
        this.engine.leg.end <= this.clock.now() / 1000);
    this.resumeValidation = undo.resumeValidationPending
      ? {
          engine: this.engine,
          legId: this.engine.leg.navigationId!,
          transitChecked: !navigator.onLine,
        }
      : undefined;
    if (!this.hasCurrentLocation) this.engine.invalidateLocation();
    this.alternative = undefined;
    this.pendingAlternativeLocation = undefined;
    this.lastIssue = undefined;
    this.message = "";
    this.retryAvailable = false;
    this.disruption = transitDisruption(
      journey,
      this.engine.progress.legIndex,
      this.clock.now() / 1000,
    );
    this.assessment = assessConnection(
      journey,
      this.engine.progress.legIndex,
      this.clock.now() / 1000,
      { onboard: this.engine.leg.kind === "transit" },
    );
    this.persistence.resetCheckpoint();
    this.persist(true);
    this.emit();
    void this.refresh();
    return true;
  }
  constructor(private deps: NavigationDependencies) {
    this.clock = deps.clock ?? systemClock;
    this.routePlanner = new NavigationRoutePlanner({
      api: deps.api,
      plan: deps.plan,
      now: () => this.clock.now() / 1000,
    });
    this.persistence = new NavigationPersistence(
      deps.store ?? new NavigationStore(),
    );
    this.refresher = deps.refresher ?? new TransitRefresher();
  }
  private emit() {
    // Section preparation resets engine-local timing; retain the UI pause intent.
    this.engine?.setCompletionPaused(this.completionPaused);
    this.reconcileResumeValidation();
    void this.completionUndo;
    this.deps.changed();
  }
  private plan(
    request: RouteRequest,
    signal: AbortSignal,
    acceptable?: (journey: Journey) => boolean,
  ): Promise<{ journey: Journey; settings: RoutingSettings }> {
    const settings = structuredClone(
      this.deps.routingSettings?.() ?? this.settings!,
    );
    return this.routePlanner.plan(request, settings, signal, acceptable);
  }
  get locationQuality() {
    if (!this.fix) return;
    return this.fixQuality === "current"
      ? quality(this.fix, this.clock.now())
      : this.fixQuality;
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
      timing: time <= this.clock.now() / 1000 ? "now" : "depart",
      time,
      stops: this.engine
        ? this.remainingStops(afterCurrent)
        : this.request?.stops,
    };
  }
  private abortTasks() {
    this.resumeValidation = undefined;
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
    if (restored && !replan) {
      this.requiredFixAfter = this.clock.now();
      if (this.fix && this.fix.timestamp < this.requiredFixAfter)
        this.fixQuality = "stale";
    }
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
      if (restored && !replan) {
        const stored = await this.persistence.readEpochs();
        signal.throwIfAborted();
        if (stored.failed)
          this.storageMessage =
            "Navigation läuft. Gesamtstatistik konnte nicht gelesen werden.";
        const candidate = navigationJourney(journey);
        const index = restored.progress.legIndex;
        this.assessment = assessConnection(
          candidate,
          index,
          this.clock.now() / 1000,
          {
            onboard: candidate.legs[index].kind === "transit",
          },
        );
        this.needsLocation = false;
        this.message = "";
        return {
          journey: candidate,
          request: structuredClone(request),
          settings: this.settings!,
          progress: restored.progress,
          assessment: this.assessment,
          restored: true,
          generation,
          trip: restored.trip,
          tripId: restored.sessionId,
          storageEpoch: stored.storageEpoch,
          resumeEpoch: stored.resumeEpoch,
        } satisfies PreparedNavigation;
      }
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
      if (quality(fix, this.clock.now()) !== "current")
        throw new LocationError(
          "unusable",
          "Standort ist zu ungenau oder veraltet. Bitte erneut versuchen.",
        );
      this.fix = fix;
      this.needsLocation = false;
      this.fixQuality = "current";
      this.requiredFixAfter = 0;
      const now = this.clock.now() / 1000;
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
      const checkedAt = this.clock.now() / 1000;
      this.assessment = assessConnection(candidate, index, checkedAt, {
        fix: restored ? undefined : fix,
        onboard: !!restored && candidate.legs[index].kind === "transit",
      });
      this.message = this.assessment.message;
      let storageEpoch = 0;
      let resumeEpoch = 0;
      if (this.deps.resumeEnabled() || this.deps.statisticsEnabled()) {
        const stored = await this.persistence.readEpochs();
        storageEpoch = stored.storageEpoch;
        resumeEpoch = stored.resumeEpoch;
        if (stored.failed)
          this.storageMessage =
            "Navigation läuft. Gesamtstatistik konnte nicht gelesen werden.";
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
    if (
      !prepared.restored &&
      (!this.fix || quality(this.fix, this.clock.now()) !== "current")
    ) {
      this.needsLocation = true;
      throw new LocationError(
        "unusable",
        "Standort ist zu ungenau oder veraltet. Bitte erneut versuchen.",
      );
    }
    prepared.assessment = assessConnection(
      prepared.journey,
      prepared.progress?.legIndex ?? 0,
      this.clock.now() / 1000,
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
          startedAt: this.clock.now() / 1000,
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
    this.assessment = prepared.assessment;
    this.resumeNeedsConfirmation =
      prepared.restored &&
      !movement(this.engine!.leg) &&
      this.engine!.leg.end <= this.clock.now() / 1000;
    if (prepared.restored)
      this.resumeValidation = {
        engine: this.engine!,
        legId: this.engine!.leg.navigationId!,
        transitChecked: !navigator.onLine,
      };
    this.reconcileResumeValidation();
    if (this.hasCurrentLocation && this.fix) this.engine!.update(this.fix);
    else this.engine!.invalidateLocation();
    this.message = prepared.restored
      ? "Navigation fortgesetzt. Prüfe deinen aktuellen Abschnitt."
      : "";
    this.persist(true);
    this.emit();
    if (prepared.restored) {
      if (!this.hasCurrentLocation) void this.retryLocation();
      void this.refresh("foreground");
    }
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
    this.engine = new NavigationEngine(
      navigationJourney(journey),
      progress,
      this.clock,
    );
    this.engine.setCompletionPaused(this.completionPaused);
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
    this.streetRetryAt = 0;
    this.streetFailures = 0;
    this.persistence.resetCheckpoint();
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
    if (fix && state === "current") state = quality(fix, this.clock.now());
    this.fix = fix;
    this.fixQuality = state;
    if (this.hasCurrentLocation) this.locationError = undefined;
    else if (error) this.locationError = error;
    if (!this.engine || !this.foreground) return;
    // Only street repair can safely follow progress on its original engine.
    // User-requested itinerary changes retain their existing section boundary.
    if (this.busy && this.streetEngine !== this.engine) {
      this.engine.resetCompletionCountdown();
      this.emit();
      return;
    }
    this.reconcileResumeValidation();
    if (!fix || state !== "current") this.engine.invalidateLocation();
    else this.engine.update(fix);
    if (this.streetEngine === this.engine && !this.engine.offRoute)
      this.controller?.abort();
    void this.repairStreet();
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
    this.requiredFixAfter = this.clock.now();
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
      this.requiredFixAfter = this.clock.now();
      this.fixQuality = "stale";
      this.engine?.invalidateLocation();
      this.transitController?.abort();
      this.transitController = undefined;
      this.controller?.abort();
    } else if (this.engine) void this.refresh("foreground");
    this.emit();
  }
  private tick() {
    if (this.busy) this.engine?.resetCompletionCountdown();
    if (
      !this.engine ||
      !this.foreground ||
      this.busy ||
      this.engine.phase === "arrived"
    )
      return;
    if (!this.fix || quality(this.fix, this.clock.now()) !== "current")
      this.engine.invalidateLocation();
    this.reconcileResumeValidation();
    // After restoration/backgrounding, require a fresh fix before timer-driven progress.
    if (
      !this.resumeNeedsConfirmation &&
      this.fix &&
      quality(this.fix, this.clock.now()) === "current" &&
      this.fixQuality === "current"
    )
      this.engine.tick();
    this.discardChangedAlternative();
    this.assessment = assessConnection(
      this.engine.connectionJourney,
      this.engine.progress.legIndex,
      this.clock.now() / 1000,
      {
        remainingMovement: movement(this.engine.leg)
          ? this.engine.remainingSeconds
          : undefined,
        onboard: this.engine.leg.kind === "transit",
      },
    );
    this.persist();
    this.emit();
    void this.repairStreet();
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
      engine.connectionJourney,
      engine.progress.legIndex,
      this.clock.now() / 1000,
      {
        remainingMovement: movement(engine.leg)
          ? engine.remainingSeconds
          : undefined,
        onboard: engine.leg.kind === "transit",
      },
    );
    const detected = transitDisruption(
      engine.connectionJourney,
      engine.progress.legIndex,
      this.clock.now() / 1000,
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
    if (this.disruption) this.retryAvailable = true;
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
    const validation =
      this.resumeValidation?.engine === engine
        ? this.resumeValidation
        : undefined;
    const checksResume =
      validation &&
      !validation.transitChecked &&
      (!validation.check || validation.check.signal.aborted);
    if (checksResume) validation.check = controller;
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
        this.clock.now() / 1000,
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
    } finally {
      if (
        checksResume &&
        validation &&
        this.resumeValidation === validation &&
        validation.check === controller &&
        !controller.signal.aborted &&
        this.engine === engine
      ) {
        validation.transitChecked = true;
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
    engine.resetCompletionCountdown();
    this.message = label;
    this.retryAvailable = false;
    this.emit();
    try {
      const message = await work(controller.signal, engine);
      if (!controller.signal.aborted) this.message = message ?? "";
    } catch (error) {
      if (controller.signal.aborted && this.engine === engine) {
        const returned = this.streetEngine === engine && !engine.offRoute;
        this.message = returned
          ? ""
          : "Berechnung unterbrochen. Erneut versuchen.";
        this.retryAvailable = !returned;
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
  /** Automatic repairs replace streets only. Transit changes require a user request. */
  private async repairStreet() {
    const engine = this.engine,
      now = this.clock.now() / 1000;
    if (
      !engine ||
      !movement(engine.leg) ||
      !engine.offRoute ||
      this.busy ||
      !this.foreground ||
      !navigator.onLine ||
      !this.hasCurrentLocation ||
      this.fix!.accuracy > 50 ||
      engine.plausibleMovementTimestamp !== this.fix!.timestamp ||
      now <
        Math.max(
          this.streetRetryAt,
          this.lastReroute + 10,
          this.deps.api.retryAt || 0,
        )
    )
      return;
    if (unavailableBoarding(engine.journey, engine.progress.legIndex, now)) {
      const assessment = assessConnection(
        engine.journey,
        engine.progress.legIndex,
        now,
      );
      this.disruption = { id: assessment.id, message: assessment.message };
      this.retryAvailable = true;
      return;
    }
    this.lastReroute = now;
    this.streetEngine = engine;
    await this.changeRoute(async (signal, active) => {
      const leg = active.leg;
      const settings = structuredClone(
        this.deps.routingSettings?.() ?? this.settings!,
      );
      const result = await this.deps.api.batch(
        {
          origin: fixPlace(this.usableFix()),
          destination: active.requiresElevatorConfirmation ? leg.from : leg.to,
          timing: "now",
          time: this.clock.now() / 1000,
        },
        settings,
        {
          direct: true,
          directMode: leg.kind === "walk" ? "WALK" : "BIKE",
          pre: "BIKE",
          post: "BIKE",
        },
        signal,
      );
      signal.throwIfAborted();
      if (this.engine !== active || !active.offRoute) return;
      const replacement = result.journeys[0];
      if (!replacement) throw new Error("Kein neuer Weg gefunden.");
      const latest = this.usableFix();
      if (
        latest.accuracy > 50 ||
        active.plausibleMovementTimestamp !== latest.timestamp ||
        !movement(replacement.legs[0]) ||
        projectPath(latest, replacement.legs[0].coordinates).distance >
          Math.max(20, latest.accuracy)
      ) {
        this.streetRetryAt = this.clock.now() / 1000 + 10;
        return "Standort hat sich geändert. Weg wird erneut berechnet …";
      }
      const index = active.progress.legIndex;
      const route = composeStreetRepair(
        active.journey,
        index,
        replacement,
        active.requiresElevatorConfirmation,
      );
      const assessment = assessConnection(
        route,
        index,
        this.clock.now() / 1000,
      );
      if (
        unavailableBoarding(
          route,
          index + replacement.legs.length - 1,
          this.clock.now() / 1000,
        )
      ) {
        this.disruption = { id: assessment.id, message: assessment.message };
        this.retryAvailable = true;
        this.streetRetryAt = this.clock.now() / 1000 + 60;
        return assessment.message;
      }
      const progress = { ...active.progress, maneuverIndex: 0, meters: 0 };
      this.activate(route, progress, settings);
      this.engine!.update(latest);
      this.assessment = assessment;
      this.disruption =
        assessment.status === "ready"
          ? undefined
          : { id: assessment.id, message: assessment.message };
      this.retryAvailable = !!this.disruption;
      this.streetFailures = 0;
      this.streetRetryAt = 0;
      return assessment.message;
    }, "Route wird angepasst …");
    if (this.engine === engine && engine.offRoute && this.retryAvailable) {
      this.streetFailures++;
      this.streetRetryAt = Math.max(
        this.streetRetryAt,
        this.clock.now() / 1000 +
          [10, 30, 60][Math.min(2, this.streetFailures - 1)],
        this.deps.api.retryAt || 0,
      );
    }
    if (this.streetEngine === engine) this.streetEngine = undefined;
  }
  async retryStreet() {
    this.streetRetryAt = 0;
    this.lastReroute = -Infinity;
    await this.repairStreet();
  }
  async reroute() {
    this.lastReroute = this.clock.now() / 1000;
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
        this.requestFrom(fixPlace(this.usableFix()), this.clock.now() / 1000),
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
      now = this.clock.now() / 1000;
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
    this.retryAvailable = true;
    this.emit();
  }
  completeLeg(expectedId: string) {
    const engine = this.engine;
    if (
      !engine ||
      engine.phase !== "active" ||
      this.busy ||
      engine.leg.navigationId !== expectedId ||
      engine.leg.kind === "stop"
    )
      return false;
    this.updateTrip();
    const progress = structuredClone(engine.progress);
    const trip = this.trip && structuredClone(this.trip);
    const resumeNeedsConfirmation = this.resumeNeedsConfirmation;
    const resumeValidationPending =
      this.resumeValidation?.engine === engine &&
      this.resumeValidation.legId === engine.leg.navigationId;
    const next = engine.journey.legs[engine.progress.legIndex + 1];
    const timing = next && {
      id: next.navigationId!,
      start: next.start,
      end: next.end,
    };
    if (!engine.advance(true)) {
      engine.progress = progress;
      return false;
    }
    this.pendingCompletionUndo =
      engine.phase === "active"
        ? {
            engine,
            nextId: engine.leg.navigationId!,
            progress,
            trip,
            resumeNeedsConfirmation,
            resumeValidationPending,
            timing: timing && {
              ...timing,
              appliedStart: engine.leg.start,
              appliedEnd: engine.leg.end,
            },
          }
        : undefined;
    this.resumeNeedsConfirmation = false;
    this.alternative = undefined;
    this.pendingAlternativeLocation = undefined;
    this.persist(true);
    this.emit();
    return true;
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
        now = this.clock.now() / 1000;
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
              ? Math.max(departure, this.clock.now() / 1000)
              : this.clock.now() / 1000 + alternativeDecisionSeconds,
          ),
      );
      signal.throwIfAborted();
      if (
        this.engine !== active ||
        active.leg.navigationId !== sourceId ||
        this.disruption?.id !== issue.id
      )
        return;
      const proposed = composeAlternative({
        current: active.journey,
        legIndex: active.progress.legIndex,
        route,
        onboard,
        reason,
        origin,
        departure,
        foldingDuration,
        now,
      });
      this.alternative = {
        settings: routeSettings,
        journey: proposed,
        legIndex: onboard ? active.progress.legIndex : 0,
        sourceId,
        issueId: issue.id,
        createdAt: this.clock.now() / 1000,
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
      this.clock.now() / 1000 - candidate.createdAt > 120 ||
      blocksNavigation(
        assessConnection(
          candidate.journey,
          candidate.legIndex,
          this.clock.now() / 1000,
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
        const arrivedAt = this.clock.now() / 1000;
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
    const pending = this.persistence.saveCheckpoint(
      {
        savedAt: this.clock.now() / 1000,
        journey: engine.journey,
        request: this.request!,
        settings: this.settings!,
        progress: engine.progress,
        trip: this.trip,
        resumeEpoch: this.resumeEpoch,
      },
      force,
    );
    void pending?.catch(() => {
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
    const enabled = this.deps.statisticsEnabled();
    this.statisticsMessage = enabled
      ? "Gesamtstatistik wird gespeichert …"
      : "Gesamtstatistik ist ausgeschaltet.";
    const result = await this.persistence.complete(summary, enabled);
    if (result.kind === "disabled") {
      if (result.clearingFailed) {
        this.storageMessage =
          "Gespeicherter Navigationsstand konnte nicht gelöscht werden.";
        this.emit();
      }
      return;
    }
    if (this.summary !== summary) return;
    if (result.kind === "stored") {
      this.statistics = result.statistics;
      this.statisticsMessage = result.statistics
        ? ""
        : "Gesamtstatistik wurde gelöscht oder Speicherung ausgeschaltet.";
    } else
      this.statisticsMessage =
        "Gesamtstatistik konnte nicht gespeichert werden.";
    this.emit();
  }
  async stop() {
    this.discardCompletionUndo();
    const tripId = this.trip?.id;
    const completion = this.completion;
    this.abortTasks();
    this.engine = undefined;
    this.busy = false;
    this.alternative = undefined;
    this.disruption = undefined;
    this.assessment = undefined;
    this.message = "";
    this.persistence.resetCheckpoint();
    this.emit();
    await completion;
    await this.persistence.clear(tripId);
  }
}
