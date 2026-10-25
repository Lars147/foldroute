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
  private offSamples = 0;
  private lastTimestamp = 0;
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
  get remainingSeconds(): number {
    const leg = this.leg;
    const length = projectPath(leg.from, this.path).length;
    return length
      ? ((leg.end - leg.start) * this.remainingMeters) / length
      : Math.max(0, leg.end - Date.now() / 1000);
  }
  private preparePath() {
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
    this.offSamples = 0;
    this.distanceToNext = undefined;
    this.lastTimestamp = 0;
    this.transitSample = undefined;
    this.transitEvidence = undefined;
    this.transitPositionConfirmed = false;
  }
  update(fix: LocationFix, now = Date.now()): boolean {
    if (this.phase !== "active" || quality(fix, now) !== "current") {
      this.invalidateLocation();
      return false;
    }
    if (fix.timestamp <= this.lastTimestamp) return false;
    const elapsed = this.lastTimestamp
      ? (fix.timestamp - this.lastTimestamp) / 1000
      : 0;
    this.lastTimestamp = fix.timestamp;
    if (!movement(this.leg)) {
      this.distanceToNext = distance(fix, this.leg.to);
      if (this.leg.kind === "transit") this.updateTransit(fix);
      return false;
    }
    const projection = projectPath(
      fix,
      this.path,
      Math.max(0, this.progress.meters - 30),
      elapsed === 0
        ? Infinity
        : this.progress.meters + Math.max(100, Math.min(500, elapsed * 20)),
    );
    const whole = projectPath(fix, this.path);
    this.offSamples =
      fix.accuracy <= 50 && whole.distance > 60 ? this.offSamples + 1 : 0;
    this.offRoute = this.offSamples >= 3;
    if (
      projection.distance <= Math.max(40, fix.accuracy) &&
      fix.accuracy <= 50
    ) {
      this.progress.meters = Math.max(this.progress.meters, projection.meters);
      this.updateManeuver();
      if (
        projection.length - this.progress.meters <= 40 &&
        distance(fix, this.leg.to) <= 40 &&
        !this.maneuver
      )
        this.advance(false, now / 1000);
    }
    return this.offRoute;
  }
  tick(now = Date.now() / 1000) {
    if (this.phase !== "active") return;
    const leg = this.leg;
    if (leg.kind === "stop" || movement(leg) || now < leg.end) return;
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
    const next = this.journey.legs[this.progress.legIndex + 1];
    if (!manual && next?.kind === "transit" && !freshTransit(next, now))
      return false;
    if (
      !manual &&
      next?.kind === "transit" &&
      next.start < now &&
      (movement(this.leg) ? now : this.leg.end) > next.start
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
    this.offSamples = 0;
    this.offRoute = false;
    this.lastTimestamp = 0;
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
    const previousStops = previous.transitStops;
    const topologyChanged =
      transitTopologyKey(previous) !==
      transitTopologyKey(journey.legs[this.progress.legIndex]);
    const oldProgress = { ...this.progress };
    this.journey = journey;
    if (topologyChanged) {
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
