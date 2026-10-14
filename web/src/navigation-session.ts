import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type Leg,
  type Place,
  errorText,
  transition,
} from "./model";
import { distance } from "./geometry";
import {
  fixPlace,
  quality,
  type LocationFix,
  type LocationQuality,
} from "./live-location";
import {
  NavigationEngine,
  navigationJourney,
  movement,
  freshTransit,
} from "./navigation-engine";
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
} from "./transit-refresh";
import { ApiClient } from "./transitous";
import { planRoutes } from "./planner";

const alternativeDecisionSeconds = 30;
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
}
export interface NavigationDependencies {
  changed: () => void;
  locate: () => Promise<LocationFix>;
  storageEnabled: () => boolean;
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
  settings?: RoutingSettings;
  request?: RouteRequest;
  fix?: LocationFix;
  fixQuality?: LocationQuality;
  busy = false;
  message = "";
  storageMessage = "";
  disruption?: Disruption;
  alternative?: NavigationAlternative;
  retryAvailable = false;
  needsLocation = false;
  distantStart = false;
  foreground = true;
  resumeNeedsConfirmation = false;
  private requiredFixAfter = 0;
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
    acceptable: (journey: Journey) => boolean = () => true,
  ): Promise<Journey> {
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
      candidates = [await this.deps.plan(request, this.settings!, signal)];
    else
      for await (const update of planRoutes(
        request,
        this.settings!,
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
    return selected;
  }
  private usableFix(): LocationFix {
    if (
      !this.fix ||
      this.fixQuality !== "current" ||
      quality(this.fix) !== "current"
    )
      throw new Error(
        "Kein aktueller, genauer Standort. Standort erneut anfragen.",
      );
    return this.fix;
  }
  private remainingStops(afterCurrent = false) {
    const engine = this.engine!;
    return engine.journey.legs
      .slice(engine.progress.legIndex + (afterCurrent ? 1 : 0))
      .flatMap((l) =>
        l.stop && !engine.progress.confirmedStops.includes(l.stop.id)
          ? [l.stop]
          : [],
      );
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
    this.pendingAlternativeLocation = undefined;
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.transitController?.abort();
    this.transitController = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async start(
    journey: Journey,
    request: RouteRequest,
    settings: RoutingSettings,
    restored?: NavigationSnapshot,
    replan = false,
  ) {
    this.abortTasks();
    this.engine = undefined;
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
        this.message =
          "Warte auf einen genauen Standort … Bitte Standortzugriff im Browser und in den Systemeinstellungen erlauben.";
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
        throw new Error(
          "Standort ist zu ungenau oder veraltet. Bitte erneut versuchen.",
        );
      this.fix = fix;
      this.needsLocation = false;
      this.fixQuality = "current";
      this.requiredFixAfter = 0;
      const now = Date.now() / 1000;
      let candidate = navigationJourney(journey);
      const separation = distance(fix, journey.origin);
      if (!restored && !replan && separation > 25000) {
        this.distantStart = true;
        throw new Error(
          "Der geplante Start ist über 25 km entfernt. Route ab hier planen.",
        );
      }
      if (replan) {
        this.message = "Route ab deinem Standort wird berechnet …";
        this.emit();
        candidate = navigationJourney(
          await this.plan(this.requestFrom(fixPlace(fix), now), signal),
        );
      } else if (!restored && separation >= 250) {
        this.message = "Anfahrt zum geplanten Start wird berechnet …";
        this.emit();
        if (!navigator.onLine)
          throw new Error("Eine Anfahrt zum Start benötigt Internet.");
        const batch = await this.deps.api.batch(
          {
            origin: fixPlace(fix),
            destination: journey.origin,
            timing: "now",
            time: now,
          },
          this.settings,
          { direct: true, pre: "BIKE", post: "BIKE" },
          signal,
        );
        const approach = batch.journeys[0];
        if (!approach) throw new Error("Keine Anfahrt zum Start gefunden.");
        if (approach.arrival + 60 > candidate.departure)
          candidate = await this.plan(
            {
              ...request,
              origin: journey.origin,
              timing: "depart",
              time: approach.arrival + 60,
            },
            signal,
          );
        const wait =
          candidate.departure > approach.arrival
            ? [
                transition(
                  "wait",
                  journey.origin,
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
      const first = candidate.legs[index];
      const missedStart =
        !restored &&
        ((first.kind === "transit" && first.start < checkedAt) ||
          !!transitDisruption(
            candidate,
            index,
            checkedAt,
            movement(first) ? first.end - first.start : undefined,
          ));
      if (missedStart) {
        this.message = "Aktuelle Verbindung wird berechnet …";
        this.emit();
        candidate = navigationJourney(
          await this.plan(this.requestFrom(fixPlace(fix), checkedAt), signal),
        );
      }
      this.activate(candidate, restored?.progress);
      this.resumeNeedsConfirmation =
        !!restored &&
        !movement(this.engine!.leg) &&
        this.engine!.leg.end <= now;
      this.message = restored
        ? "Navigation fortgesetzt. Prüfe deinen aktuellen Abschnitt."
        : "";
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.controller = undefined;
        this.emit();
      }
    }
  }
  private activate(
    journey: Journey,
    progress?: NavigationSnapshot["progress"],
  ) {
    validateNavigationGeometry(journey);
    this.engine = new NavigationEngine(navigationJourney(journey), progress);
    this.request = {
      ...this.request!,
      origin: journey.origin,
      destination: journey.destination,
      stops: journey.legs.flatMap((l) => (l.stop ? [l.stop] : [])),
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
  updateLocation(fix?: LocationFix, state?: LocationQuality) {
    if (fix && fix.timestamp < this.requiredFixAfter) state = "stale";
    this.fix = fix;
    this.fixQuality = state;
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
      this.requiredFixAfter = Date.now();
      this.fixQuality = "stale";
      this.engine?.invalidateLocation();
      this.transitController?.abort();
      this.transitController = undefined;
      this.controller?.abort();
    } else if (this.engine) void this.refresh();
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
    this.persist();
    this.emit();
    void this.refresh();
  }
  async refresh() {
    const engine = this.engine;
    if (
      !engine ||
      engine.phase === "arrived" ||
      this.busy ||
      !this.foreground ||
      !navigator.onLine ||
      this.transitController
    )
      return;
    const controller = new AbortController();
    this.transitController = controller;
    try {
      const result = await this.refresher.refresh(
        engine.journey.legs.slice(engine.progress.legIndex),
        controller.signal,
      );
      if (controller.signal.aborted || this.engine !== engine) return;
      if (result.size)
        engine.applyJourney(
          applyTransit(engine.journey, engine.progress.legIndex, result),
        );
      this.disruption = transitDisruption(
        engine.journey,
        engine.progress.legIndex,
        Date.now() / 1000,
        movement(engine.leg) ? engine.remainingSeconds : undefined,
      );
      if (!this.disruption) {
        this.alternative = undefined;
        this.pendingAlternativeLocation = undefined;
        this.lastIssue = undefined;
      }
      if (this.alternative && this.alternative.issueId !== this.disruption?.id)
        this.alternative = undefined;
      if (
        this.disruption &&
        this.lastIssue !== this.disruption.id &&
        engine.leg.kind !== "stop"
      ) {
        this.lastIssue = this.disruption.id;
        void this.proposeAlternative();
      }
      this.persist(result.size > 0);
      this.emit();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.message = errorText(error);
        this.emit();
      }
    } finally {
      if (this.transitController === controller)
        this.transitController = undefined;
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
    return this.changeRoute(async (signal, engine) => {
      if (engine.leg.kind === "transit")
        throw new Error("Zunächst den Ausstieg bestätigen.");
      const route = await this.plan(
        this.requestFrom(fixPlace(this.usableFix()), Date.now() / 1000),
        signal,
      );
      signal.throwIfAborted();
      if (this.engine !== engine) return;
      const confirmedStops = engine.progress.confirmedStops;
      this.activate(route, {
        legIndex: 0,
        maneuverIndex: 0,
        meters: 0,
        confirmedStops,
      });
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
    const remaining = updated.legs
      .slice(engine.progress.legIndex + 1)
      .filter((l) => l.kind === "transit");
    if (
      remaining.every((l) => freshTransit(l, now)) &&
      !transitDisruption(updated, engine.progress.legIndex, now)
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
      this.persist(true);
      this.emit();
      return;
    }
    return this.changeRoute(async (signal, active) => {
      const request = this.requestFrom(
        fixPlace(this.usableFix()),
        Math.max(now, stop.end),
        true,
      );
      const route = await this.plan(request, signal);
      signal.throwIfAborted();
      if (
        this.engine !== active ||
        active.leg.navigationId !== stop.navigationId
      )
        return;
      if (stop.end > now)
        route.legs.unshift(transition("wait", stop.to, now, stop.end));
      const confirmedStops = [
        ...active.progress.confirmedStops,
        ...(stop.stop ? [stop.stop.id] : []),
      ];
      this.activate(route, {
        legIndex: 0,
        maneuverIndex: 0,
        meters: 0,
        confirmedStops,
      });
    }, "Weiterfahrt wird neu berechnet …");
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
  async proposeAlternative() {
    const engine = this.engine,
      issue = this.disruption;
    if (!engine || !issue || this.busy || engine.leg.kind === "stop") return;
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
        };
        this.usableFix();
      }
      this.pendingAlternativeLocation = undefined;
      const origin = onboard ? leg.to : fixPlace(this.usableFix());
      const departure = onboard
        ? Math.max(now, leg.end) + this.settings!.foldingDuration
        : now + alternativeDecisionSeconds;
      const route = await this.plan(
        this.requestFrom(origin, departure),
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
              departure - this.settings!.foldingDuration,
              departure,
            ),
          ]
        : [];
      const proposed = navigationJourney(
        prefix.length
          ? {
              ...route,
              origin: active.journey.origin,
              departure: active.journey.departure,
              legs: [...prefix, ...route.legs],
            }
          : route,
      );
      validateNavigationGeometry(proposed);
      this.alternative = {
        journey: proposed,
        legIndex: onboard ? active.progress.legIndex : 0,
        sourceId,
        issueId: issue.id,
        createdAt: Date.now() / 1000,
        sourceArrival: onboard ? leg.end : undefined,
      };
      return "Verbindung geprüft. Bitte zum Übernehmen bestätigen.";
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
      await this.proposeAlternative();
  }
  async acceptAlternative() {
    const engine = this.engine,
      candidate = this.alternative;
    if (!engine || !candidate || this.busy) return;
    if (
      candidate.sourceId !== engine.leg.navigationId ||
      candidate.issueId !== this.disruption?.id ||
      Date.now() / 1000 - candidate.createdAt > 120 ||
      !reachableAlternative(
        candidate.journey,
        candidate.legIndex,
        Date.now() / 1000,
        candidate.sourceArrival !== undefined,
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
      await this.proposeAlternative();
      return;
    }
    await this.changeRoute(async () => {
      this.alternative = undefined;
      this.activate(candidate.journey, {
        legIndex: candidate.legIndex,
        maneuverIndex: 0,
        meters: 0,
        confirmedStops: engine.progress.confirmedStops,
      });
    }, "Verbindung wird geprüft …");
  }
  dismissAlternative() {
    this.alternative = undefined;
    this.emit();
  }
  private persist(force = false) {
    const engine = this.engine;
    if (!engine) return;
    if (engine.phase === "arrived") {
      if (!this.arrivalCleared) {
        this.arrivalCleared = true;
        this.transitController?.abort();
        void this.store.clear().catch(() => {
          this.storageMessage =
            "Beendete Navigation konnte nicht gelöscht werden.";
          this.emit();
        });
      }
      return;
    }
    if (!this.deps.storageEnabled()) return;
    const key = JSON.stringify([
      engine.journey.id,
      engine.progress.legIndex,
      engine.progress.maneuverIndex,
      engine.progress.confirmedStops,
    ]);
    if (!force && key === this.savedKey) return;
    this.savedKey = key;
    const snapshot: NavigationSnapshot = structuredClone({
      version: 1,
      savedAt: Date.now() / 1000,
      journey: engine.journey,
      request: {
        ...this.request!,
        stops: engine.journey.legs.flatMap((l) => (l.stop ? [l.stop] : [])),
      },
      settings: this.settings!,
      progress: engine.progress,
    });
    void this.store.save(snapshot).catch(() => {
      this.storageMessage =
        "Navigation läuft. Wiederaufnahme konnte nicht gespeichert werden.";
      this.emit();
    });
  }
  async stop() {
    this.abortTasks();
    this.engine = undefined;
    this.busy = false;
    this.alternative = undefined;
    this.disruption = undefined;
    this.message = "";
    this.savedKey = "";
    this.emit();
    await this.store.clear();
  }
}
