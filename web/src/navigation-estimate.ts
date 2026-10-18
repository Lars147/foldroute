import type { Coordinate, Leg } from "./model";
import { distance } from "./geometry";
import { headingDelta, projectPath } from "./navigation-engine";

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

export interface TransitEstimate extends MarkerPosition {
  stopIndex: number;
  atExit: boolean;
}
export interface TransitEstimateSource {
  timeline: TransitTimeline;
  confirmedIndex: number;
  confirmedMeters: number;
}
export interface TransitPosition {
  navigationId?: string;
  meters?: number;
  path?: TransitPath;
  source: "estimated" | "gps" | "last-known";
}
type Anchor = { time: number; meters: number };

/** Station geometry is usable with GPS even when station times are missing. */
export class TransitPath {
  private constructor(
    readonly path: NavigationPath,
    readonly stopOffsets: number[],
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
      leg.coordinates.length < 2
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
      if (projected.distance > 100 || !Number.isFinite(projected.meters))
        return;
      offsets.push(projected.meters);
    }
    return new TransitPath(path, offsets);
  }
}

/** Presentation only: sampling never writes to NavigationEngine or a GPS fix. */
export class TransitTimeline {
  readonly path: NavigationPath;
  readonly stopOffsets: number[];
  private constructor(
    route: TransitPath,
    private readonly anchors: Anchor[],
    private readonly passTimes: (number | undefined)[],
    private readonly cancelled: boolean[],
  ) {
    this.path = route.path;
    this.stopOffsets = route.stopOffsets;
  }
  get endTime() {
    return this.anchors.at(-1)!.time;
  }
  nextMovementAt(
    now: number,
    confirmedIndex = 0,
    confirmedMeters = 0,
  ): number | undefined {
    const minimum = Math.max(confirmedMeters, this.stopOffsets[confirmedIndex]);
    for (let i = 1; i < this.anchors.length; i++) {
      const a = this.anchors[i - 1],
        b = this.anchors[i];
      if (b.time <= now || b.meters <= a.meters || b.meters <= minimum)
        continue;
      const begins =
        a.time +
        (Math.max(0, minimum - a.meters) / (b.meters - a.meters)) *
          (b.time - a.time);
      return Math.max(now, begins);
    }
  }
  static create(leg: Leg): TransitTimeline | undefined {
    const route = TransitPath.create(leg);
    if (!route) return;
    const stops = leg.transitStops!;
    const offsets = route.stopOffsets;
    const anchors: Anchor[] = [];
    const passTimes: (number | undefined)[] = [];
    for (const [i, stop] of stops.entries()) {
      if (stop.cancelled) continue;
      const arrival =
        stop.arrival ??
        stop.scheduledArrival ??
        (i === 0 ? leg.start : i === stops.length - 1 ? leg.end : undefined);
      const departure =
        i === stops.length - 1
          ? undefined
          : (stop.departure ??
            stop.scheduledDeparture ??
            (i === 0 ? leg.start : undefined));
      passTimes[i] = departure ?? arrival;
      for (const time of [arrival, departure]) {
        if (time === undefined) continue;
        if (!Number.isFinite(time)) return;
        const previous = anchors.at(-1);
        if (
          previous &&
          (time < previous.time ||
            (time === previous.time && offsets[i] !== previous.meters))
        )
          return;
        if (!previous || time !== previous.time)
          anchors.push({ time, meters: offsets[i] });
      }
    }
    if (anchors.length < 2 || anchors[0].time >= anchors.at(-1)!.time) return;
    return new TransitTimeline(
      route,
      anchors,
      passTimes,
      stops.map((stop) => !!stop.cancelled),
    );
  }
  sample(
    now: number,
    confirmedIndex = 0,
    confirmedMeters = 0,
  ): TransitEstimate {
    const anchors = this.anchors;
    const next = anchors.findIndex((anchor) => anchor.time > now);
    let meters = anchors.at(-1)!.meters;
    if (next === 0) meters = anchors[0].meters;
    else if (next > 0) {
      const a = anchors[next - 1],
        b = anchors[next];
      meters =
        a.meters + ((b.meters - a.meters) * (now - a.time)) / (b.time - a.time);
    }
    meters = Math.min(
      this.stopOffsets.at(-1)!,
      Math.max(meters, confirmedMeters, this.stopOffsets[confirmedIndex]),
    );
    let stopIndex = confirmedIndex;
    this.stopOffsets.forEach((offset, i) => {
      if (
        !this.cancelled[i] &&
        i > stopIndex &&
        offset <= meters + 0.01 &&
        (this.passTimes[i] === undefined
          ? offset < meters
          : this.passTimes[i]! <= now)
      )
        stopIndex = i;
    });
    return {
      ...this.path.at(meters),
      stopIndex,
      atExit: now >= this.endTime && meters >= this.stopOffsets.at(-1)! - 0.01,
    };
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
  ) {
    const previousPath = this.track?.path;
    const from = visible ?? (this.track ? this.sample(now) : undefined);
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
            started: now,
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
  sample(now: number, animate = true): MarkerPosition {
    if (!this.track)
      throw new Error("Markerbewegung benötigt eine Zielposition.");
    const target = this.track.sample(now);
    const correction = this.correction;
    if (!animate || !correction || now - correction.started >= 2) {
      this.correction = undefined;
      return target;
    }
    const fraction = Math.max(0, (now - correction.started) / 2);
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
