import { legStops } from "./model";
import type { Coordinate, Journey, Leg, Maneuver } from "./model";
import { distance } from "./geometry";
import { quality, type LocationFix } from "./live-location";
import {
  maxStationShapeDistance,
  transitStopKey,
  transitStopIdentity,
  transitTopologyKey,
  findViaVisit,
} from "./transit-stops";
import {
  navigationCues,
  verticalManeuver,
  type NavigationCue,
} from "./navigation-cues";

export interface NavigationProgress {
  legIndex: number;
  maneuverIndex: number;
  meters: number;
  confirmedStops: string[];
  transitStop?: string;
  transitDepartedStop?: string;
}
export interface Projection {
  meters: number;
  distance: number;
  length: number;
  bearing: number;
}
export const movement = (leg?: Leg) =>
  leg?.kind === "bike" || leg?.kind === "walk";
export const freshTransit = (leg: Leg, now: number) =>
  !leg.transitStatus?.cancelled &&
  !leg.transitStatus?.missingViaStops?.length &&
  !leg.transitStatus?.failure &&
  leg.transitStatus?.updatedAt !== undefined &&
  Math.abs(now - leg.transitStatus.updatedAt) <= 120;
export const headingDelta = (from: number, to: number) =>
  ((((to - from + 180) % 360) + 360) % 360) - 180;

/** Project onto segments, restricting candidates to the current part of the path. */
export function projectPath(
  point: Coordinate,
  path: Coordinate[],
  min = 0,
  max = Infinity,
): Projection {
  let length = 0;
  let best = { meters: 0, distance: Infinity, length: 0, bearing: 0 };
  const scale = Math.cos((point.latitude * Math.PI) / 180);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    const segment = distance(a, b);
    const ax = (a.longitude - point.longitude) * scale,
      ay = a.latitude - point.latitude;
    const dx = (b.longitude - a.longitude) * scale,
      dy = b.latitude - a.latitude;
    const t =
      dx || dy
        ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        : 0;
    const meters = length + segment * t;
    const d = distance(point, {
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    });
    if (meters >= min && meters <= max && d < best.distance - 0.01)
      best = {
        meters,
        distance: d,
        length: 0,
        bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
      };
    length += segment;
  }
  return { ...best, length };
}

/** Street matching must agree for guidance and presentation, including route loops. */
export function projectMovementPath(
  fix: LocationFix,
  path: Coordinate[],
  min = 0,
  max = Infinity,
): Projection | undefined {
  const candidates: Projection[] = [];
  let offset = 0;
  for (let i = 1; i < path.length; i++) {
    const candidate = projectPath(fix, [path[i - 1], path[i]]);
    candidate.meters += offset;
    offset += candidate.length;
    if (
      candidate.meters >= min &&
      candidate.meters <= max &&
      candidate.distance <= Math.max(40, fix.accuracy)
    )
      candidates.push(candidate);
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) return;
  const nearby = candidates.filter(
    (c) => c.distance <= best.distance + Math.max(10, fix.accuracy),
  );
  const separated = (a: Projection, b: Projection) =>
    Math.abs(a.meters - b.meters) > Math.max(30, 2 * fix.accuracy);
  let selected = best;
  if (nearby.some((c) => separated(best, c))) {
    if (fix.heading === undefined || (fix.speed ?? 0) < 1) return;
    const aligned = nearby.filter(
      (c) => Math.abs(headingDelta(fix.heading!, c.bearing)) <= 60,
    );
    if (!aligned[0] || aligned.some((c) => separated(aligned[0], c))) return;
    selected = aligned[0];
  }
  return { ...selected, length: offset };
}

export function movementCoordinates(leg: Leg): Coordinate[] {
  return leg.maneuvers?.length
    ? leg.maneuvers.flatMap((step) => step.coordinates)
    : leg.coordinates.length > 1
      ? leg.coordinates
      : [leg.from, leg.to];
}

/** Reject off-route and ambiguous projections, including overlapping route loops. */
export function projectTransitPath(
  fix: LocationFix,
  path: Coordinate[],
  min: number,
): Projection | undefined {
  const projection = projectPath(fix, path, min);
  if (projection.distance > 100) return;
  let offset = 0;
  for (let i = 1; i < path.length; i++) {
    const alternative = projectPath(fix, [path[i - 1], path[i]]);
    const position = offset + alternative.meters;
    if (
      position >= min &&
      Math.abs(position - projection.meters) > 200 &&
      alternative.distance <= projection.distance + Math.max(10, fix.accuracy)
    )
      return;
    offset += alternative.length;
  }
  return projection;
}
export function maneuverText(maneuver: Maneuver): string {
  const text: Record<string, string> = {
    DEPART: "Losfahren",
    CONTINUE: "Geradeaus",
    LEFT: "Links abbiegen",
    RIGHT: "Rechts abbiegen",
    HARD_LEFT: "Scharf links",
    HARD_RIGHT: "Scharf rechts",
    SLIGHTLY_LEFT: "Leicht links",
    SLIGHTLY_RIGHT: "Leicht rechts",
    CIRCLE_CLOCKWISE: "In den Kreisverkehr fahren",
    CIRCLE_COUNTERCLOCKWISE: "In den Kreisverkehr fahren",
    STAIRS: "Treppe nehmen",
    ELEVATOR: "Aufzug nehmen",
    UTURN_LEFT: "Wenden",
    UTURN_RIGHT: "Wenden",
  };
  const instruction = text[maneuver.direction] ?? "Dem Streckenverlauf folgen";
  return (
    instruction +
    (maneuver.streetName && !["STAIRS", "ELEVATOR"].includes(maneuver.direction)
      ? ` auf ${maneuver.streetName}`
      : "")
  );
}
export function navigationJourney(journey: Journey): Journey {
  const copy = structuredClone(journey);
  copy.legs = copy.legs.map((leg) => ({
    ...leg,
    navigationId: leg.navigationId ?? crypto.randomUUID(),
  }));
  return copy;
}
export class NavigationEngine {
  phase: "active" | "arrived" = "active";
  progress: NavigationProgress;
  distanceToNext?: number;
  offRoute = false;
  private lastTimestamp = 0;
  private acceptedTimestamp = 0;
  routeState: "following" | "uncertain" | "deviated" = "following";
  movementMatch?: Projection;
  movementMatchTimestamp = 0;
  plausibleMovementTimestamp = -Infinity;
  completionCountdown?: { startedAt: number; remainingSeconds: number };
  completionPaused = false;
  private completionUpdatedAt = 0;
  private completionPauseStarted?: number;
  private activityPauseSeconds = 0;
  private completionFix?: LocationFix;
  private completionCancelled = false;
  private evidence?: {
    kind: "leave" | "return";
    first: LocationFix;
    firstMeters?: number;
    count: number;
  };
  private previousMovementFix?: LocationFix;
  private get elevatorAnchor(): Coordinate | undefined {
    if (this.maneuver?.direction !== "ELEVATOR" || !this.path.length) return;
    const anchor = this.path[0];
    return this.path.every(
      (point) =>
        point.latitude === anchor.latitude &&
        point.longitude === anchor.longitude,
    )
      ? anchor
      : undefined;
  }
  get guidanceUsable() {
    return (
      this.routeState === "following" ||
      (!!this.elevatorAnchor && !this.offRoute)
    );
  }
  get requiresElevatorConfirmation() {
    return !!this.elevatorAnchor;
  }
  private path: Coordinate[] = [];
  private offsets: number[] = [];
  private cues: NavigationCue[] = [];
  private cue?: NavigationCue;
  transitPositionConfirmed = false;
  private transitOffsets?: number[];
  private transitSample?: {
    index: number;
    meters?: number;
    fix: LocationFix;
    atExit: boolean;
  };
  private transitEvidence?: {
    first: LocationFix;
    last: LocationFix;
    atExit: boolean;
  };
  constructor(
    public journey: Journey,
    progress?: NavigationProgress,
  ) {
    this.progress = structuredClone(
      progress ?? {
        legIndex: 0,
        maneuverIndex: 0,
        meters: 0,
        confirmedStops: [],
      },
    );
    if (!journey.legs[this.progress.legIndex])
      throw new Error("Ungültiger Navigationsabschnitt.");
    this.normalizeTransitProgress();
    this.preparePath();
  }
  get leg(): Leg {
    return this.journey.legs[this.progress.legIndex];
  }
  get transitStopIndex(): number {
    const stops = this.leg.transitStops;
    return stops && this.progress.transitStop
      ? Math.max(
          0,
          stops.findIndex(
            (_, i) => transitStopKey(stops, i) === this.progress.transitStop,
          ),
        )
      : 0;
  }
  get transitDepartedStopIndex(): number {
    const stops = this.leg.transitStops;
    if (!stops) return 0;
    const index = stops.findIndex(
      (_, i) => transitStopKey(stops, i) === this.progress.transitDepartedStop,
    );
    return Math.max(0, index);
  }
  private normalizeTransitProgress() {
    const stops = this.leg.transitStops;
    if (!stops) {
      delete this.progress.transitStop;
      delete this.progress.transitDepartedStop;
      return;
    }
    const find = (key?: string) =>
      stops.findIndex(
        (stop, i) => !stop.cancelled && transitStopKey(stops, i) === key,
      );
    let reached = find(this.progress.transitStop);
    let departed = find(this.progress.transitDepartedStop);
    // Legacy snapshots confirm arrival, not departure from that same station.
    if (departed < 0) departed = this.previousServedStop(reached);
    // An unambiguous departure also proves arrival if a refresh removed it.
    reached = Math.max(reached, departed);
    this.progress.transitStop =
      reached >= 0 ? transitStopKey(stops, reached) : undefined;
    this.progress.transitDepartedStop =
      departed >= 0 ? transitStopKey(stops, departed) : undefined;
  }
  private previousServedStop(index: number): number {
    return (
      this.leg.transitStops?.findLastIndex(
        (stop, i) => i < index && !stop.cancelled,
      ) ?? -1
    );
  }
  get transitExitConfirmed(): boolean {
    const evidence = this.transitEvidence;
    const stops = this.leg.transitStops;
    return !!(
      this.transitPositionConfirmed &&
      evidence?.atExit &&
      stops &&
      !stops.at(-1)!.cancelled &&
      (this.leg.to.stopId
        ? stops.at(-1)!.stopId === this.leg.to.stopId
        : distance(stops.at(-1)!, this.leg.to) <= maxStationShapeDistance) &&
      quality(evidence.first) === "current" &&
      quality(evidence.last) === "current"
    );
  }
  get hasCurrentTransitPosition(): boolean {
    return !!(
      this.transitPositionConfirmed &&
      this.transitEvidence &&
      quality(this.transitEvidence.first) === "current" &&
      quality(this.transitEvidence.last) === "current"
    );
  }
  get hasTransitLocation(): boolean {
    return !!(
      this.transitSample && quality(this.transitSample.fix) === "current"
    );
  }
  get maneuver(): Maneuver | undefined {
    return this.phase === "active" ? this.cue?.maneuver : undefined;
  }
  get guidanceKey(): string | undefined {
    return this.phase === "active" ? this.cue?.key : undefined;
  }
  get hasManeuverGuidance(): boolean {
    return this.cues.length > 0;
  }
  get instruction(): string {
    if (this.phase === "arrived") return "Ziel erreicht";
    const leg = this.leg;
    if (movement(leg))
      return this.maneuver
        ? maneuverText(this.maneuver)
        : `${leg.kind === "bike" ? "Mit dem Rad" : "Zu Fuß"} nach ${leg.to.name}`;
    if (leg.kind === "transit")
      return `${leg.line ?? "ÖPNV"} Richtung ${leg.headsign ?? leg.to.name}`;
    return {
      fold: "Rad jetzt falten",
      unfold: "Rad jetzt entfalten",
      wait: "Auf Weiterfahrt warten",
      stop: "Zwischenziel erreicht",
    }[leg.kind as "fold"];
  }
  get remainingMeters(): number {
    return Math.max(
      0,
      projectPath(this.leg.from, this.path).length - this.progress.meters,
    );
  }
  get navigationPath(): readonly Coordinate[] {
    return this.path;
  }
  get hasMovementPath(): boolean {
    const length = projectPath(this.leg.from, this.path).length;
    return movement(this.leg) && Number.isFinite(length) && length > 0;
  }
  get remainingSeconds(): number {
    if (this.completionCountdown)
      return this.completionCountdown.remainingSeconds;
    if (this.timedActivity)
      return Math.max(
        0,
        this.activityEnd(Date.now() / 1000) - Date.now() / 1000,
      );
    const leg = this.leg;
    const length = projectPath(leg.from, this.path).length;
    return length
      ? ((leg.end - leg.start) * this.remainingMeters) / length
      : Math.max(0, leg.end - Date.now() / 1000);
  }
  private preparePath() {
    this.resetCompletionCountdown();
    this.completionCancelled = false;
    this.completionPaused = false;
    this.completionPauseStarted = undefined;
    this.activityPauseSeconds = 0;
    this.path = [];
    this.offsets = [];
    let total = 0;
    if (this.leg.maneuvers?.length) {
      for (const step of this.leg.maneuvers) {
        for (const [i, point] of step.coordinates.entries()) {
          if (this.path.length) total += distance(this.path.at(-1)!, point);
          this.path.push(point);
          if (i === 0) this.offsets.push(total);
        }
      }
    } else
      this.path =
        this.leg.coordinates.length > 1
          ? this.leg.coordinates
          : [this.leg.from, this.leg.to];
    this.cues = movement(this.leg)
      ? navigationCues(this.leg, this.path, this.offsets)
      : [];
    this.updateManeuver();
    this.prepareTransitStops();
  }
  private prepareTransitStops() {
    this.transitOffsets = undefined;
    this.transitSample = undefined;
    const stops = this.leg.transitStops;
    // Endpoint-only geometry is a presentation fallback, not a measured rail path.
    if (this.leg.kind !== "transit" || !stops || this.path.length <= 2) return;
    const offsets: number[] = [];
    for (const stop of stops) {
      if (stop.cancelled) {
        offsets.push(offsets.at(-1) ?? 0);
        continue;
      }
      const projection = projectPath(
        stop,
        this.path,
        offsets.length ? offsets.at(-1)! + 1 : 0,
      );
      if (projection.distance > maxStationShapeDistance) return;
      offsets.push(projection.meters);
    }
    this.transitOffsets = offsets;
  }
  private updateTransit(fix: LocationFix) {
    const stops = this.leg.transitStops;
    if (!stops || this.leg.transitStatus?.cancelled) return;
    const currentIndex = this.transitStopIndex;
    let index = -1;
    let meters: number | undefined;
    const offsets = this.transitOffsets;
    if (offsets) {
      const min = Math.max(0, this.progress.meters - 100);
      const projection = projectTransitPath(fix, this.path, min);
      if (projection) {
        meters = projection.meters;
        offsets.forEach((anchor, i) => {
          if (!stops[i].cancelled && anchor <= projection.meters + 1) index = i;
        });
        // A platform fix can land just before the station's shape anchor.
        // Only the distinctly nearest station may be confirmed this early.
        const nearby = stops
          .flatMap((stop, i) => {
            const separation = distance(fix, stop);
            return i >= currentIndex &&
              !stop.cancelled &&
              separation <= 100 &&
              Math.abs(offsets[i] - projection.meters) <= 100
              ? [{ index: i, distance: separation }]
              : [];
          })
          .sort((a, b) => a.distance - b.distance);
        if (
          nearby[0] &&
          (!nearby[1] ||
            nearby[1].distance - nearby[0].distance >
              Math.max(10, fix.accuracy))
        )
          index = Math.max(index, nearby[0].index);
      }
    } else {
      // Without a usable shape, only an unambiguous station vicinity is evidence.
      const nearby = stops.flatMap((stop, i) =>
        i >= currentIndex && !stop.cancelled && distance(fix, stop) <= 100
          ? [i]
          : [],
      );
      if (nearby.length === 1) index = nearby[0];
    }
    const previous = this.transitSample;
    this.transitSample = undefined;
    this.transitEvidence = undefined;
    if (index < currentIndex) {
      this.transitPositionConfirmed = false;
      return;
    }
    const elapsed = previous
      ? (fix.timestamp - previous.fix.timestamp) / 1000
      : 0;
    const change =
      previous && meters !== undefined && previous.meters !== undefined
        ? meters - previous.meters
        : previous
          ? distance(previous.fix, fix)
          : 0;
    const atExit =
      index === stops.length - 1 &&
      !stops.at(-1)!.cancelled &&
      (distance(fix, this.leg.to) <= 100 ||
        (meters !== undefined &&
          offsets !== undefined &&
          Math.abs(meters - offsets.at(-1)!) <= 100));
    if (
      previous &&
      elapsed > 0 &&
      elapsed <= 60 &&
      change >= -100 &&
      change <= 100 + elapsed * 100
    ) {
      const confirmed = Math.max(currentIndex, Math.min(index, previous.index));
      this.progress.transitStop = transitStopKey(stops, confirmed);
      // Arrival at a later visit proves departure from earlier served visits.
      let departed = Math.max(
        this.transitDepartedStopIndex,
        this.previousServedStop(confirmed),
      );
      if (offsets && meters !== undefined && previous.meters !== undefined) {
        const next = stops.findIndex(
          (stop, i) => i > confirmed && !stop.cancelled,
        );
        if (next >= 0) {
          const boundary =
            offsets[confirmed] +
            Math.min(100, (offsets[next] - offsets[confirmed]) / 2);
          // Compare against the fixed station anchor, not successive fixes:
          // slow departures must work even with frequent GPS updates.
          if (
            meters - fix.accuracy > boundary &&
            previous.meters - previous.fix.accuracy > boundary
          )
            departed = Math.max(departed, confirmed);
        }
      }
      this.progress.transitDepartedStop = transitStopKey(stops, departed);
      if (meters !== undefined && previous.meters !== undefined)
        this.progress.meters = Math.max(
          this.progress.meters,
          Math.min(meters, previous.meters),
        );
      this.transitPositionConfirmed = true;
      this.transitEvidence = {
        first: previous.fix,
        last: fix,
        atExit: atExit && previous.atExit,
      };
    } else this.transitPositionConfirmed = false;
    this.transitSample = { index, meters, fix, atExit };
  }
  private updateManeuver() {
    // Preserve source-step indices for existing saved navigation snapshots.
    // A step's direction applies at its start, not at its endpoint.
    const next = this.offsets.findIndex((offset, i) => {
      const special = verticalManeuver(this.leg.maneuvers![i].direction);
      // A vertical maneuver can share its coordinate with the next step.
      // Keep its instruction until the rider has moved beyond that anchor.
      return special
        ? offset >= this.progress.meters - 25
        : i > 0 && offset > this.progress.meters;
    });
    this.progress.maneuverIndex =
      next < 0 ? (this.leg.maneuvers?.length ?? 0) : next;
    this.cue = this.cues.find((cue) =>
      verticalManeuver(cue.maneuver.direction)
        ? cue.meters >= this.progress.meters - 25
        : cue.meters > this.progress.meters ||
          (cue.meters === 0 && this.progress.meters === 0),
    );
    this.distanceToNext =
      this.cue === undefined
        ? this.remainingMeters
        : Math.max(0, this.cue.meters - this.progress.meters);
  }
  invalidateLocation() {
    this.resetCompletionCountdown();
    this.distanceToNext = undefined;
    this.lastTimestamp = 0;
    this.acceptedTimestamp = 0;
    this.evidence = undefined;
    this.previousMovementFix = undefined;
    this.plausibleMovementTimestamp = -Infinity;
    this.movementMatch = undefined;
    if (movement(this.leg)) this.routeState = "uncertain";
    this.transitSample = undefined;
    this.transitEvidence = undefined;
    this.transitPositionConfirmed = false;
  }
  resetCompletionCountdown() {
    this.completionCountdown = undefined;
    this.completionFix = undefined;
    this.completionUpdatedAt = 0;
  }
  private get timedActivity() {
    return ["fold", "unfold", "wait"].includes(this.leg.kind);
  }
  private activityEnd(now: number) {
    return (
      this.leg.end +
      this.activityPauseSeconds +
      (this.completionPauseStarted === undefined
        ? 0
        : Math.max(0, now - this.completionPauseStarted / 1000))
    );
  }
  get connectionJourney(): Journey {
    if (
      !this.timedActivity ||
      (!this.activityPauseSeconds && this.completionPauseStarted === undefined)
    )
      return this.journey;
    const legs = this.journey.legs.slice();
    legs[this.progress.legIndex] = {
      ...this.leg,
      end: this.activityEnd(Date.now() / 1000),
    };
    return { ...this.journey, legs };
  }
  setCompletionPaused(paused: boolean, now = Date.now()) {
    paused &&=
      this.phase === "active" && (movement(this.leg) || this.timedActivity);
    if (paused === this.completionPaused) return;
    this.updateCountdownTime(now);
    if (paused) this.completionPauseStarted = now;
    else {
      if (this.timedActivity && this.completionPauseStarted !== undefined)
        this.activityPauseSeconds +=
          Math.max(0, now - this.completionPauseStarted) / 1000;
      this.completionPauseStarted = undefined;
    }
    this.completionPaused = paused;
  }
  private updateCountdownTime(now: number) {
    if (!this.completionCountdown) return;
    if (!this.completionPaused)
      this.completionCountdown.remainingSeconds =
        Math.max(
          0,
          Math.round(this.completionCountdown.remainingSeconds * 1000) -
            Math.max(0, Math.round(now - this.completionUpdatedAt)),
        ) / 1000;
    this.completionUpdatedAt = now;
  }
  cancelCompletionCountdown() {
    this.resetCompletionCountdown();
    this.completionCancelled = true;
  }
  private updateCompletionCountdown(now: number) {
    const fix = this.completionFix;
    const plausible =
      fix &&
      quality(fix, now) === "current" &&
      fix.accuracy <= 50 &&
      this.plausibleMovementTimestamp === fix.timestamp;
    const targetDistance = plausible ? distance(fix, this.leg.to) : Infinity;
    if (plausible && targetDistance > 20) this.completionCancelled = false;
    if (
      !plausible ||
      targetDistance > 20 ||
      !this.guidanceUsable ||
      this.movementMatchTimestamp !== fix.timestamp ||
      !this.movementMatch ||
      !this.hasMovementPath ||
      this.maneuver
    ) {
      this.completionCountdown = undefined;
      return;
    }
    if (
      !this.completionCountdown &&
      !this.completionCancelled &&
      targetDistance <= 10 &&
      this.remainingMeters <= 10
    ) {
      this.completionCountdown = { startedAt: now, remainingSeconds: 30 };
      this.completionUpdatedAt = now;
    }
    const countdown = this.completionCountdown;
    if (!countdown) return;
    this.updateCountdownTime(now);
    if (countdown.remainingSeconds === 0 && !this.completionPaused) {
      this.cancelCompletionCountdown();
      this.advance(false, now / 1000);
    }
  }
  update(fix: LocationFix, now = Date.now()): boolean {
    if (this.phase !== "active" || quality(fix, now) !== "current") {
      this.invalidateLocation();
      return false;
    }
    if (fix.timestamp <= this.lastTimestamp) return false;
    this.completionFix = fix;
    const elapsed = this.acceptedTimestamp
      ? (fix.timestamp - this.acceptedTimestamp) / 1000
      : 0;
    this.lastTimestamp = fix.timestamp;
    if (!movement(this.leg)) {
      this.distanceToNext = distance(fix, this.leg.to);
      if (this.leg.kind === "transit") this.updateTransit(fix);
      return false;
    }
    const previous = this.previousMovementFix;
    this.movementMatchTimestamp = fix.timestamp;
    this.movementMatch = undefined;
    const gap = previous ? (fix.timestamp - previous.timestamp) / 1000 : 0;
    if (
      previous &&
      distance(previous, fix) >
        Math.max(100, gap * 20) + previous.accuracy + fix.accuracy
    ) {
      this.evidence = undefined;
      this.routeState = this.offRoute ? "deviated" : "uncertain";
      this.distanceToNext = undefined;
      this.completionCountdown = undefined;
      return this.offRoute;
    }
    this.previousMovementFix = fix;
    this.plausibleMovementTimestamp = fix.timestamp;
    const anchor = this.elevatorAnchor;
    const anchorDistance = anchor ? distance(fix, anchor) : undefined;
    const projection = anchor
      ? anchorDistance! <= Math.max(40, fix.accuracy)
        ? { meters: 0, distance: anchorDistance!, length: 0, bearing: 0 }
        : undefined
      : projectMovementPath(
          fix,
          this.path,
          Math.max(0, this.progress.meters - 30),
          elapsed === 0
            ? Infinity
            : this.progress.meters + Math.max(100, elapsed * 20),
        );
    const whole = anchor ? projection : projectMovementPath(fix, this.path);
    const separation = anchorDistance ?? projectPath(fix, this.path).distance;
    const backward = whole && whole.meters < this.progress.meters - 30;
    const leave = separation > Math.max(20, fix.accuracy) || !!backward;
    const returned =
      projection && projection.distance <= Math.max(10, fix.accuracy / 2);
    if (fix.accuracy > 50 || (gap > 15 && this.evidence))
      this.evidence = undefined;
    const kind =
      fix.accuracy <= 50 && leave
        ? "leave"
        : fix.accuracy <= 50 && returned && this.offRoute
          ? "return"
          : undefined;
    if (kind) {
      if (
        !this.evidence ||
        this.evidence.kind !== kind ||
        fix.timestamp - this.evidence.first.timestamp > 30000
      )
        this.evidence = {
          kind,
          first: fix,
          firstMeters: whole?.meters,
          count: 0,
        };
      this.evidence.count++;
      const moved =
        distance(this.evidence.first, fix) >
        Math.max(20, this.evidence.first.accuracy + fix.accuracy);
      if (
        this.evidence.count >= 3 &&
        fix.timestamp - this.evidence.first.timestamp >= 5000 &&
        (!backward ||
          (moved &&
            whole.meters < (this.evidence.firstMeters ?? whole.meters) - 20))
      ) {
        this.offRoute = kind === "leave";
        this.evidence = undefined;
      }
    } else this.evidence = undefined;
    this.movementMatch = leave || this.offRoute ? undefined : projection;
    this.routeState = this.offRoute
      ? "deviated"
      : leave || !projection || fix.accuracy > 50
        ? "uncertain"
        : "following";
    if (!this.guidanceUsable) this.distanceToNext = undefined;
    if (projection && this.guidanceUsable && fix.accuracy <= 50) {
      this.progress.meters = Math.max(this.progress.meters, projection.meters);
      this.acceptedTimestamp = fix.timestamp;
      this.updateManeuver();
    }
    this.updateCompletionCountdown(now);
    return this.offRoute;
  }
  tick(now = Date.now() / 1000) {
    if (this.phase !== "active") return;
    const leg = this.leg;
    if (movement(leg)) {
      this.updateCompletionCountdown(now * 1000);
      return;
    }
    if (
      leg.kind === "stop" ||
      this.completionPaused ||
      now < (this.timedActivity ? this.activityEnd(now) : leg.end)
    )
      return;
    if (
      leg.kind === "transit" &&
      (!freshTransit(leg, now) || !this.transitExitConfirmed)
    )
      return;
    if (["fold", "wait"].includes(leg.kind)) {
      const next = this.journey.legs
        .slice(this.progress.legIndex + 1)
        .find((l) => l.kind === "transit");
      if (next && !freshTransit(next, now)) return;
    }
    this.advance(false, now);
  }
  advance(manual = false, now = Date.now() / 1000): boolean {
    if (this.phase !== "active") return false;
    if (!manual && this.completionPaused) return false;
    const next = this.journey.legs[this.progress.legIndex + 1];
    if (!manual && next?.kind === "transit" && !freshTransit(next, now))
      return false;
    if (
      !manual &&
      next?.kind === "transit" &&
      next.start < now &&
      (movement(this.leg)
        ? now
        : this.timedActivity
          ? this.activityEnd(now)
          : this.leg.end) > next.start
    )
      return false;
    if (
      this.leg.kind === "stop" &&
      this.leg.stop &&
      !this.progress.confirmedStops.includes(this.leg.stop.id)
    )
      this.progress.confirmedStops.push(this.leg.stop.id);
    for (const stop of legStops(this.leg)) {
      const visit = this.leg.viaStops?.find(
        (visit) => visit.stop.id === stop.id,
      );
      if (
        visit &&
        (this.leg.transitStatus?.failure ||
          this.leg.transitStatus?.missingViaStops?.includes(stop.id) ||
          !findViaVisit(this.leg, visit))
      )
        continue;
      if (!this.progress.confirmedStops.includes(stop.id))
        this.progress.confirmedStops.push(stop.id);
    }
    if (!next) {
      if (
        this.journey.legs.some((leg) =>
          leg.viaStops?.some(
            (visit) =>
              !this.progress.confirmedStops.includes(visit.stop.id) &&
              (leg.transitStatus?.failure ||
                leg.transitStatus?.missingViaStops?.includes(visit.stop.id)),
          ),
        )
      )
        return false;
      this.phase = "arrived";
      this.resetCompletionCountdown();
      this.distanceToNext = 0;
      return true;
    }
    this.progress.legIndex++;
    // Physical activities take time even when their original schedule is past.
    if (next.kind === "fold" || next.kind === "unfold") {
      const seconds = Math.max(0, next.end - next.start);
      next.start = now;
      next.end = now + seconds;
    } else if (next.kind === "stop") {
      next.start = now;
      next.end = Math.max(next.end, now + (next.stop?.stayMinutes ?? 0) * 60);
    } else if (next.kind === "wait") {
      next.start = now;
      next.end = Math.max(now, next.end);
    }
    this.progress.meters = 0;
    this.progress.maneuverIndex = 0;
    delete this.progress.transitStop;
    delete this.progress.transitDepartedStop;
    this.transitPositionConfirmed = false;
    this.offRoute = false;
    this.lastTimestamp = 0;
    this.acceptedTimestamp = 0;
    this.routeState = "following";
    this.evidence = undefined;
    this.previousMovementFix = undefined;
    this.plausibleMovementTimestamp = -Infinity;
    this.movementMatch = undefined;
    this.preparePath();
    return true;
  }
  applyJourney(journey: Journey) {
    if (
      journey.legs.length !== this.journey.legs.length ||
      journey.legs.some(
        (leg, i) => leg.navigationId !== this.journey.legs[i].navigationId,
      )
    )
      throw new Error("Navigationsabschnitte stimmen nicht überein.");
    const previous = this.leg;
    const nextLeg = journey.legs[this.progress.legIndex];
    const maneuverPathChanged =
      movement(previous) &&
      JSON.stringify([previous.kind, previous.maneuvers]) !==
        JSON.stringify([nextLeg.kind, nextLeg.maneuvers]);
    const previousStops = previous.transitStops;
    const topologyChanged =
      transitTopologyKey(previous) !==
      transitTopologyKey(journey.legs[this.progress.legIndex]);
    const oldProgress = { ...this.progress };
    this.journey = journey;
    if (topologyChanged || maneuverPathChanged) {
      const stops = this.leg.transitStops;
      for (const field of ["transitStop", "transitDepartedStop"] as const) {
        const oldIndex =
          previousStops?.findIndex(
            (_, i) => transitStopKey(previousStops, i) === oldProgress[field],
          ) ?? -1;
        const identity =
          oldIndex >= 0
            ? transitStopIdentity(previousStops![oldIndex], oldIndex)
            : undefined;
        const oldMatches = previousStops?.filter(
          (stop, i) => transitStopIdentity(stop, i) === identity,
        );
        const matches = stops?.flatMap((stop, i) =>
          !stop.cancelled && transitStopIdentity(stop, i) === identity
            ? [i]
            : [],
        );
        this.progress[field] =
          oldMatches?.length === 1 && matches?.length === 1
            ? transitStopKey(stops!, matches[0])
            : undefined;
      }
      this.normalizeTransitProgress();
      this.progress.meters = 0;
      this.invalidateLocation();
      this.preparePath();
    }
  }
}
