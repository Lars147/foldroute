import type { Coordinate, Leg } from "./model";
import { distance } from "./geometry";
import { headingDelta, projectPath } from "./navigation-engine";
import { maxStationShapeDistance } from "./transit-stops";

export interface MarkerPosition {
  point: Coordinate;
  bearing: number;
  meters?: number;
}

/** Distances stay in metres along the route, including repeated visits to a place. */
export class NavigationPath {
  readonly key: string;
  readonly offsets: number[] = [0];
  constructor(readonly coordinates: Coordinate[]) {
    this.key = JSON.stringify(coordinates);
    for (let i = 1; i < coordinates.length; i++)
      this.offsets.push(
        this.offsets[i - 1] + distance(coordinates[i - 1], coordinates[i]),
      );
  }
  at(meters: number): MarkerPosition {
    const end = this.offsets.at(-1)!;
    meters = Math.max(0, Math.min(end, meters));
    let low = 1,
      high = this.offsets.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle] < meters) low = middle + 1;
      else high = middle;
    }
    const a = this.coordinates[low - 1],
      b = this.coordinates[low];
    const length = this.offsets[low] - this.offsets[low - 1];
    const fraction = length ? (meters - this.offsets[low - 1]) / length : 0;
    return {
      point: {
        latitude: a.latitude + (b.latitude - a.latitude) * fraction,
        longitude: a.longitude + (b.longitude - a.longitude) * fraction,
      },
      bearing:
        ((Math.atan2(
          (b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180),
          b.latitude - a.latitude,
        ) *
          180) /
          Math.PI +
          360) %
        360,
      meters,
    };
  }
}

export {
  TransitTimeline,
  StationMotion,
  stationCursor,
} from "./transit-timeline";
export type {
  StationCursor,
  StationCursor as TransitEstimate,
} from "./transit-timeline";
import type { StationCursor, TransitTimeline } from "./transit-timeline";

export interface TransitEstimateSource {
  timeline: TransitTimeline;
  path: TransitPath;
  confirmedIndex: number;
  confirmedPosition: number;
  sample: (wall: number) => StationCursor;
}
/** Station geometry is usable with GPS even when station times are missing. */
export class TransitPath {
  private constructor(
    readonly path: NavigationPath,
    readonly stopOffsets: number[],
    readonly schematic = false,
  ) {}
  static create(leg: Leg): TransitPath | undefined {
    const stops = leg.transitStops;
    if (
      leg.kind !== "transit" ||
      leg.transitStatus?.cancelled ||
      !stops ||
      stops.length < 2 ||
      stops[0].cancelled ||
      stops.at(-1)!.cancelled ||
      leg.coordinates.length <= 2
    )
      return;
    const path = new NavigationPath(leg.coordinates);
    const offsets: number[] = [];
    for (const stop of stops) {
      if (stop.cancelled) {
        offsets.push(offsets.at(-1)!);
        continue;
      }
      const projected = projectPath(
        stop,
        leg.coordinates,
        offsets.length ? offsets.at(-1)! + 1 : 0,
      );
      if (
        projected.distance > maxStationShapeDistance ||
        !Number.isFinite(projected.meters)
      )
        return;
      offsets.push(projected.meters);
    }
    return new TransitPath(path, offsets);
  }
  /** A single presentation mode for the entire leg; never used as GPS evidence. */
  static forPresentation(leg: Leg): TransitPath | undefined {
    if (
      leg.kind !== "transit" ||
      leg.transitStatus?.cancelled ||
      !leg.transitStops ||
      leg.transitStops.length < 2 ||
      leg.transitStops[0].cancelled ||
      leg.transitStops.at(-1)!.cancelled
    )
      return;
    const original =
      leg.coordinates.length > 2 ? TransitPath.create(leg) : undefined;
    if (original) return original;
    const coordinates = leg.transitStops.filter((stop) => !stop.cancelled);
    const path = new NavigationPath(coordinates);
    let ordinal = -1;
    const offsets = leg.transitStops.map((stop) => {
      if (!stop.cancelled) ordinal++;
      return path.offsets[Math.max(0, ordinal)];
    });
    return new TransitPath(path, offsets, true);
  }
  positionAt(meters: number): number {
    let previous = 0;
    for (let i = 1; i < this.stopOffsets.length; i++) {
      const a = this.stopOffsets[previous],
        b = this.stopOffsets[i];
      if (b <= a) continue;
      if (meters < b)
        return previous + (i - previous) * Math.max(0, (meters - a) / (b - a));
      previous = i;
    }
    return this.stopOffsets.length - 1;
  }
  at(cursor: StationCursor): MarkerPosition {
    const low = cursor.fromIndex,
      high = cursor.toIndex;
    const meters =
      this.stopOffsets[low] +
      (this.stopOffsets[high] - this.stopOffsets[low]) * cursor.fraction;
    return this.path.at(meters);
  }
}

export interface MarkerTrack {
  path?: NavigationPath;
  sample: (now: number) => MarkerPosition;
}

/** Two-second corrections follow a moving target and restart at the visible point. */
export class MarkerMotion {
  private track?: MarkerTrack;
  private correction?: {
    started: number;
    from: MarkerPosition;
    alongPath: boolean;
  };
  setTarget(
    track: MarkerTrack,
    now: number,
    animate: boolean,
    visible?: MarkerPosition,
    monotonic = now,
  ) {
    const previousPath = this.track?.path;
    const from =
      visible ?? (this.track ? this.sample(now, true, monotonic) : undefined);
    this.track = track;
    const target = track.sample(now);
    this.correction =
      animate &&
      from &&
      (distance(from.point, target.point) > 0.01 ||
        (from.meters !== undefined &&
          target.meters !== undefined &&
          Math.abs(from.meters - target.meters) > 0.01) ||
        Math.abs(headingDelta(from.bearing, target.bearing)) > 0.1)
        ? {
            started: monotonic,
            from,
            alongPath:
              !!track.path &&
              previousPath?.key === track.path.key &&
              from.meters !== undefined,
          }
        : undefined;
  }
  get correcting() {
    return !!this.correction;
  }
  sample(now: number, animate = true, monotonic = now): MarkerPosition {
    if (!this.track)
      throw new Error("Markerbewegung benötigt eine Zielposition.");
    const target = this.track.sample(now);
    const correction = this.correction;
    if (!animate || !correction || monotonic - correction.started >= 2) {
      this.correction = undefined;
      return target;
    }
    const fraction = Math.max(0, (monotonic - correction.started) / 2);
    const blend = fraction * fraction * (3 - 2 * fraction);
    const from = correction.from;
    const position =
      correction.alongPath && target.meters !== undefined
        ? this.track.path!.at(
            from.meters! + (target.meters - from.meters!) * blend,
          )
        : {
            meters:
              from.meters !== undefined && target.meters !== undefined
                ? from.meters + (target.meters - from.meters) * blend
                : undefined,
            point: {
              latitude:
                from.point.latitude +
                (target.point.latitude - from.point.latitude) * blend,
              longitude:
                from.point.longitude +
                (target.point.longitude - from.point.longitude) * blend,
            },
          };
    return {
      ...position,
      bearing:
        from.bearing + headingDelta(from.bearing, target.bearing) * blend,
    };
  }
}
