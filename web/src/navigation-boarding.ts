import type { Leg } from "./model";
import { distance } from "./geometry";
import { quality, type LocationFix } from "./live-location";
import {
  freshTransit,
  movement,
  movementCoordinates,
  type NavigationEngine,
} from "./navigation-engine";
import { projectPath, projectTransitPath } from "./navigation-projection";
import { maxStationShapeDistance, transitTopologyKey } from "./transit-stops";

const minimumBoardingSpeed = 3;

interface Anchor {
  time: number;
  meters: number;
}

/** Match time to physical distance, rather than interpolating station ordinals. */
function timeMatches(leg: Leg, meters: number, timestamp: number): boolean {
  const time = timestamp / 1000;
  if (time < leg.start || time >= leg.end || leg.end <= leg.start) return false;
  const length = projectPath(leg.from, leg.coordinates).length;
  const anchors: Anchor[] = [{ time: leg.start, meters: 0 }];
  for (const stop of leg.transitStops?.slice(1, -1) ?? []) {
    if (stop.cancelled) continue;
    const projected = projectPath(
      stop,
      leg.coordinates,
      anchors.at(-1)!.meters,
    );
    if (projected.distance > maxStationShapeDistance) return false;
    for (const at of [
      stop.arrival ?? stop.scheduledArrival,
      stop.departure ?? stop.scheduledDeparture,
    ]) {
      if (at === undefined) continue;
      const previous = anchors.at(-1)!;
      if (
        !Number.isFinite(at) ||
        at < previous.time ||
        at >= leg.end ||
        (at === previous.time && projected.meters !== previous.meters)
      )
        return false;
      anchors.push({ time: at, meters: projected.meters });
    }
  }
  anchors.push({ time: leg.end, meters: length });
  const at = (seconds: number) => {
    const next = anchors.findIndex((anchor) => anchor.time > seconds);
    if (next < 0) return length;
    if (next === 0) return 0;
    const a = anchors[next - 1],
      b = anchors[next];
    return (
      a.meters +
      ((b.meters - a.meters) * (seconds - a.time)) / (b.time - a.time)
    );
  };
  return meters >= at(time - 180) && meters <= at(time + 180);
}

export interface BoardingEvidence {
  index: number;
  fixes: [LocationFix, LocationFix];
  meters: number;
}

/** Ephemeral evidence belongs to one source section and one rail topology. */
export class NavigationBoarding {
  private engine?: NavigationEngine;
  private key = "";
  private first?: LocationFix;
  private last?: LocationFix;
  reset() {
    this.engine = undefined;
    this.key = "";
    this.first = this.last = undefined;
  }
  update(
    engine: NavigationEngine,
    fix: LocationFix | undefined,
    now: number,
  ): BoardingEvidence | undefined {
    // Delayed measurements must not invalidate a newer observation window.
    if (
      this.engine === engine &&
      fix &&
      this.last &&
      fix.timestamp < this.last.timestamp
    )
      return;
    // Reevaluate saved evidence on refresh without trusting changed duplicate payloads.
    if (
      this.engine === engine &&
      fix &&
      this.last &&
      fix.timestamp === this.last.timestamp
    )
      fix = this.last;
    if (
      !fix ||
      quality(fix, now) !== "current" ||
      fix.accuracy > 50 ||
      engine.phase !== "active" ||
      engine.leg.kind === "transit"
    ) {
      this.reset();
      return;
    }
    const index = engine.journey.legs.findIndex(
      (leg, i) => i > engine.progress.legIndex && leg.kind === "transit",
    );
    if (index < 0) {
      this.reset();
      return;
    }
    const skipped = engine.journey.legs.slice(engine.progress.legIndex, index);
    if (
      skipped.some(
        (leg) => leg.kind === "stop" || leg.stop || leg.viaStops?.length,
      )
    ) {
      this.reset();
      return;
    }
    const leg = engine.journey.legs[index];
    const key = JSON.stringify([
      engine.progress.legIndex,
      leg.navigationId,
      transitTopologyKey(leg),
    ]);
    if (this.engine !== engine || this.key !== key) {
      this.reset();
      this.engine = engine;
      this.key = key;
    }
    if (this.last && fix.timestamp < this.last.timestamp) return;
    if (!this.last || fix.timestamp > this.last.timestamp) {
      if (fix.speed !== undefined && fix.speed < minimumBoardingSpeed) {
        this.first = undefined;
        this.last = fix;
        return;
      }
      if (!this.first || fix.timestamp - this.first.timestamp > 30000)
        this.first = fix;
      this.last = fix;
    }
    if (!this.first) return;
    const first = this.first,
      last = this.last!;
    if (
      last.timestamp - first.timestamp < 3000 ||
      quality(first, now) !== "current" ||
      !freshTransit(leg, now / 1000) ||
      leg.coordinates.length <= 2
    )
      return;
    const match = (sample: LocationFix) => {
      if (
        movement(engine.leg) &&
        projectPath(sample, movementCoordinates(engine.leg)).distance <=
          Math.max(40, sample.accuracy)
      )
        return;
      const projection = projectTransitPath(sample, leg.coordinates, 0);
      if (
        !projection ||
        projection.meters < 200 ||
        distance(sample, leg.from) <= 100 ||
        distance(sample, leg.to) <= 100 ||
        !timeMatches(leg, projection.meters, sample.timestamp)
      )
        return;
      return projection;
    };
    const a = match(first),
      b = match(last);
    if (!b) {
      this.first = last;
      return;
    }
    if (!a) {
      this.first = last;
      return;
    }
    const change = b.meters - a.meters;
    const elapsed = (last.timestamp - first.timestamp) / 1000;
    if (change / elapsed < minimumBoardingSpeed) {
      this.first = last;
      return;
    }
    if (
      change <= 20 ||
      (change - first.accuracy - last.accuracy) / elapsed < minimumBoardingSpeed
    )
      return;
    if (change > 100 + elapsed * 100) {
      this.first = last;
      return;
    }
    return { index, fixes: [first, last], meters: a.meters };
  }
}
