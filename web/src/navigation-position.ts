import type { Leg } from "./model";
import {
  quality,
  type LocationFix,
  type LocationQuality,
} from "./live-location";
import {
  headingDelta,
  movement,
  projectPath,
  type NavigationEngine,
  type Projection,
} from "./navigation-engine";
import { NavigationPath, type MarkerPosition } from "./navigation-estimate";

export interface NavigationPosition {
  position: MarkerPosition;
  path?: NavigationPath;
  raw?: LocationFix;
  source: "gps" | "last-known";
  /** A held outlier takes precedence over a timetable for two fresh samples. */
  preferEstimate: boolean;
}

/** Presentation evidence never changes confirmed navigation progress. */
export class NavigationPositionTracker {
  private engine?: NavigationEngine;
  private key = "";
  private path?: NavigationPath;
  private timestamp = -Infinity;
  private anchor?: { meters: number; timestamp: number };
  private outside = 0;
  private last?: NavigationPosition;

  reset() {
    this.engine = undefined;
    this.key = "";
    this.path = undefined;
    this.timestamp = -Infinity;
    this.anchor = undefined;
    this.outside = 0;
    this.last = undefined;
  }

  interrupt() {
    this.anchor = undefined;
    this.outside = 0;
    if (this.last)
      this.last = { ...this.last, source: "last-known", preferEstimate: true };
  }

  update(
    engine: NavigationEngine,
    fix?: LocationFix,
    state?: LocationQuality,
    now = Date.now(),
  ): NavigationPosition {
    const leg = engine.leg;
    const key = JSON.stringify([
      engine.progress.legIndex,
      leg.navigationId,
      leg.kind,
      leg.coordinates,
      leg.transitStatus?.cancelled,
    ]);
    if (this.engine !== engine || this.key !== key) {
      this.reset();
      this.engine = engine;
      this.key = key;
      // Only drawn route geometry supplies display metres. Station-to-station
      // schematic lines must never become GPS matching evidence.
      if (
        (movement(leg) && leg.coordinates.length >= 2) ||
        (leg.kind === "transit" &&
          !leg.transitStatus?.cancelled &&
          leg.coordinates.length > 2)
      )
        this.path = new NavigationPath(leg.coordinates);
    }
    this.last ??= {
      position: { point: leg.from, bearing: 0 },
      source: "last-known",
      preferEstimate: true,
    };
    if (!fix || state !== "current" || quality(fix, now) !== "current") {
      this.interrupt();
      // A fresh inaccurate measurement can update the uncertainty circle,
      // but cannot move the marker or bypass a session's freshness barrier.
      if (
        fix &&
        state === "inaccurate" &&
        quality(fix, now) !== "stale" &&
        fix.timestamp > this.timestamp
      ) {
        this.timestamp = fix.timestamp;
        this.last.raw = fix;
      }
      return this.last;
    }
    if (fix.timestamp <= this.timestamp) return this.last;
    if (fix.timestamp - this.timestamp > 60000) this.interrupt();
    this.timestamp = fix.timestamp;
    this.last.raw = fix;
    const path = this.path;
    const corridor = leg.kind === "transit" ? 100 : Math.max(40, fix.accuracy);
    const projection = path && this.match(fix, leg, path, corridor);
    if (projection && path) {
      this.anchor = { meters: projection.meters, timestamp: fix.timestamp };
      this.outside = 0;
      return (this.last = {
        position: path.at(projection.meters),
        path,
        raw: fix,
        source: "gps",
        preferEstimate: false,
      });
    }
    const outside =
      path && projectPath(fix, path.coordinates).distance > corridor;
    this.outside = outside ? this.outside + 1 : 0;
    if (outside && this.anchor && this.last.path && this.outside < 3) {
      return (this.last = {
        ...this.last,
        source: "last-known",
        preferEstimate: false,
      });
    }
    if (!outside && path && this.last.path) {
      // Ambiguity or an impossible movement is not evidence of deviation.
      return (this.last = {
        ...this.last,
        source: "last-known",
        preferEstimate: true,
      });
    }
    this.anchor = undefined;
    return (this.last = {
      position: {
        point: fix,
        bearing:
          fix.heading !== undefined && (fix.speed ?? 0) >= 1
            ? fix.heading
            : this.last.position.bearing,
      },
      raw: fix,
      source: "gps",
      preferEstimate: path ? true : !engine.hasTransitLocation,
    });
  }

  private match(
    fix: LocationFix,
    leg: Leg,
    path: NavigationPath,
    corridor: number,
  ) {
    const transit = leg.kind === "transit";
    const elapsed = this.anchor
      ? (fix.timestamp - this.anchor.timestamp) / 1000
      : 0;
    const min = this.anchor
      ? Math.max(0, this.anchor.meters - (transit ? 100 : 30))
      : 0;
    const max = this.anchor
      ? this.anchor.meters +
        (transit
          ? 100 + elapsed * 100
          : Math.max(100, Math.min(500, elapsed * 20)))
      : Infinity;
    const candidates: Projection[] = [];
    for (let i = 1; i < path.coordinates.length; i++) {
      const candidate = projectPath(fix, [
        path.coordinates[i - 1],
        path.coordinates[i],
      ]);
      candidate.meters += path.offsets[i - 1];
      if (
        candidate.meters >= min &&
        candidate.meters <= max &&
        candidate.distance <= corridor
      )
        candidates.push(candidate);
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    if (!best) return;
    const nearby = candidates.filter(
      (candidate) =>
        candidate.distance <= best.distance + Math.max(10, fix.accuracy),
    );
    const separated = (a: Projection, b: Projection) =>
      Math.abs(a.meters - b.meters) >
      (transit ? 200 : Math.max(30, 2 * fix.accuracy));
    if (!nearby.some((candidate) => separated(best, candidate))) return best;
    if (fix.heading !== undefined && (fix.speed ?? 0) >= 1) {
      const aligned = nearby.filter(
        (candidate) =>
          Math.abs(headingDelta(fix.heading!, candidate.bearing)) <= 60,
      );
      if (
        aligned[0] &&
        !aligned.some((candidate) => separated(aligned[0], candidate))
      )
        return aligned[0];
    }
  }
}
