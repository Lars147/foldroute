import type { Coordinate, Journey, Leg, Maneuver } from "./model";
import { distance } from "./geometry";
import { quality, type LocationFix } from "./live-location";

export interface NavigationProgress {
  legIndex: number;
  maneuverIndex: number;
  meters: number;
  confirmedStops: string[];
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
    this.preparePath();
  }
  get leg(): Leg {
    return this.journey.legs[this.progress.legIndex];
  }
  get maneuver(): Maneuver | undefined {
    return this.leg.maneuvers?.[this.progress.maneuverIndex];
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
    this.updateManeuver();
  }
  private updateManeuver() {
    // A step's direction applies at its start, not at its endpoint.
    const next = this.offsets.findIndex((offset, i) => {
      const special = ["ELEVATOR", "STAIRS"].includes(
        this.leg.maneuvers![i].direction,
      );
      // A vertical maneuver can share its coordinate with the next step.
      // Keep its instruction until the rider has moved beyond that anchor.
      return special
        ? offset >= this.progress.meters - 25
        : i > 0 && offset > this.progress.meters;
    });
    this.progress.maneuverIndex =
      next < 0 ? (this.leg.maneuvers?.length ?? 0) : next;
    this.distanceToNext =
      next < 0
        ? this.remainingMeters
        : Math.max(0, this.offsets[next] - this.progress.meters);
  }
  invalidateLocation() {
    this.offSamples = 0;
    this.distanceToNext = undefined;
    this.lastTimestamp = 0;
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
        !["ELEVATOR", "STAIRS"].includes(this.maneuver?.direction ?? "")
      )
        this.advance(false, now / 1000);
    }
    return this.offRoute;
  }
  tick(now = Date.now() / 1000) {
    if (this.phase !== "active") return;
    const leg = this.leg;
    if (leg.kind === "stop" || movement(leg) || now < leg.end) return;
    if (leg.kind === "transit" && !freshTransit(leg, now)) return;
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
    if (!next) {
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
    this.journey = journey;
  }
}
