import type { Leg } from "./model";
import { transitTopologyKey } from "./transit-stops";

export interface StationCursor {
  navigationId?: string;
  revision: string;
  /** Ordered stop indices, never metres or map coordinates. */
  position: number;
  fromIndex: number;
  toIndex: number;
  fraction: number;
  stopIndex: number;
  phase: "before" | "ride" | "dwell" | "exit" | "unclear";
  atExit: boolean;
  source: "estimated" | "gps";
}

export function stationCursor(
  leg: Leg,
  position: number,
  stopIndex: number,
  source: StationCursor["source"],
  phase: StationCursor["phase"] = "ride",
  revision = "",
): StationCursor {
  const served = leg.transitStops!.flatMap((stop, i) =>
    stop.cancelled ? [] : [i],
  );
  position = Math.max(served[0], Math.min(served.at(-1)!, position));
  const toIndex = served.find((i) => i > position) ?? served.at(-1)!;
  const fromIndex = served.findLast((i) => i <= position) ?? served[0];
  return {
    navigationId: leg.navigationId,
    revision,
    position,
    fromIndex,
    toIndex,
    fraction:
      toIndex === fromIndex
        ? 0
        : (position - fromIndex) / (toIndex - fromIndex),
    stopIndex,
    phase,
    atExit: phase === "exit",
    source,
  };
}

type Anchor = { time: number; position: number; gap: boolean };

/** A timetable is useful even when no station can be placed on the map route. */
export class TransitTimeline {
  readonly revision: string;
  private constructor(
    readonly leg: Leg,
    private readonly served: number[],
    private readonly anchors: Anchor[],
    private readonly passTimes: (number | undefined)[],
  ) {
    this.revision = JSON.stringify([
      leg.navigationId,
      leg.start,
      leg.end,
      leg.transitStops?.map((s) => [
        s.stopId,
        s.name,
        s.cancelled,
        s.arrival,
        s.departure,
        s.scheduledArrival,
        s.scheduledDeparture,
      ]),
    ]);
  }
  get endTime() {
    return this.leg.end;
  }

  static create(leg: Leg): TransitTimeline | undefined {
    const stops = leg.transitStops;
    if (
      leg.kind !== "transit" ||
      leg.transitStatus?.cancelled ||
      !stops ||
      stops.length < 2 ||
      stops[0].cancelled ||
      stops.at(-1)!.cancelled ||
      !Number.isFinite(leg.start) ||
      !Number.isFinite(leg.end) ||
      leg.end <= leg.start
    )
      return;
    const served = stops.flatMap((s, i) => (s.cancelled ? [] : [i]));
    const anchors: Anchor[] = [{ time: leg.start, position: 0, gap: false }];
    const passTimes: (number | undefined)[] = [];
    passTimes[0] = leg.start;
    let gap = false;
    for (let ordinal = 1; ordinal < served.length - 1; ordinal++) {
      const index = served[ordinal],
        stop = stops[index];
      const arrival = stop.arrival ?? stop.scheduledArrival;
      const departure = stop.departure ?? stop.scheduledDeparture;
      for (const time of [arrival, departure]) {
        if (time === undefined) continue;
        const previous = anchors.at(-1)!;
        if (
          !Number.isFinite(time) ||
          time < leg.start ||
          time >= leg.end ||
          time < previous.time ||
          (time === previous.time && ordinal !== previous.position)
        ) {
          gap = true;
          continue;
        }
        if (time !== previous.time) {
          anchors.push({ time, position: ordinal, gap });
          gap = false;
        }
        if (time === departure || departure === undefined)
          passTimes[index] = time;
      }
    }
    anchors.push({ time: leg.end, position: served.length - 1, gap });
    passTimes[stops.length - 1] = leg.end;
    return new TransitTimeline(leg, served, anchors, passTimes);
  }

  sample(
    now: number,
    confirmedIndex = 0,
    confirmedPosition = confirmedIndex,
  ): StationCursor {
    const next = this.anchors.findIndex((a) => a.time > now);
    let ordinal = this.served.length - 1;
    let phase: StationCursor["phase"] = "exit";
    if (next === 0) {
      ordinal = 0;
      phase = "before";
    } else if (next > 0) {
      const a = this.anchors[next - 1],
        b = this.anchors[next];
      ordinal = a.position;
      phase = b.gap ? "unclear" : a.position === b.position ? "dwell" : "ride";
      if (!b.gap)
        ordinal +=
          ((b.position - a.position) * (now - a.time)) / (b.time - a.time);
    }
    const low = Math.min(this.served.length - 1, Math.floor(ordinal));
    const high = Math.min(this.served.length - 1, low + 1);
    const position = Math.max(
      confirmedIndex,
      confirmedPosition,
      this.served[low] +
        (this.served[high] - this.served[low]) * (ordinal - low),
    );
    let stopIndex = confirmedIndex;
    for (const index of this.served) {
      const passed = this.passTimes[index];
      if (
        index > stopIndex &&
        (passed === undefined
          ? index < position
          : index <= position && passed <= now)
      )
        stopIndex = index;
    }
    return stationCursor(
      this.leg,
      position,
      stopIndex,
      "estimated",
      phase,
      this.revision,
    );
  }

  nextMovementAt(
    now: number,
    confirmedIndex = 0,
    confirmedPosition = confirmedIndex,
  ): number | undefined {
    const floor = Math.max(confirmedIndex, confirmedPosition);
    for (let i = 1; i < this.anchors.length; i++) {
      const a = this.anchors[i - 1],
        b = this.anchors[i];
      if (
        b.time <= now ||
        b.gap ||
        b.position <= a.position ||
        this.served[b.position] <= floor
      )
        continue;
      // Convert the confirmed logical position to an ordinal between served stops.
      const at = this.served.findIndex((index) => index > floor);
      const minimum =
        at <= 0
          ? 0
          : at -
            1 +
            (floor - this.served[at - 1]) /
              (this.served[at] - this.served[at - 1]);
      const starts =
        a.time +
        (Math.max(0, minimum - a.position) / (b.position - a.position)) *
          (b.time - a.time);
      return Math.max(now, starts);
    }
  }
}

/** Corrections use monotonic time; their target always uses current wall time. */
export class StationMotion {
  private leg?: Leg;
  private topology = "";
  private key = "";
  private target?: (now: number) => StationCursor;
  private correction?: { started: number; position: number };
  setTarget(
    key: string,
    sample: (now: number) => StationCursor,
    wall: number,
    monotonic: number,
    animate: boolean,
    leg: Leg,
  ) {
    const topology = transitTopologyKey(leg);
    if (key === this.key && topology === this.topology) return;
    const previous =
      this.target &&
      topology === this.topology &&
      this.sample(wall, monotonic, animate);
    this.topology = topology;
    this.key = key;
    this.leg = leg;
    this.target = sample;
    const next = sample(wall);
    this.correction =
      animate &&
      previous &&
      previous.navigationId === next.navigationId &&
      Math.abs(previous.position - next.position) > 0.00001
        ? { started: monotonic, position: previous.position }
        : undefined;
  }
  get correcting() {
    return !!this.correction;
  }
  sample(
    wall: number,
    monotonic: number,
    animate = true,
    floor = 0,
  ): StationCursor {
    const target = this.target!(wall),
      correction = this.correction;
    if (!animate || !correction || monotonic - correction.started >= 2) {
      this.correction = undefined;
      return target;
    }
    const fraction = Math.max(0, (monotonic - correction.started) / 2);
    const blend = fraction * fraction * (3 - 2 * fraction);
    return stationCursor(
      this.leg!,
      Math.max(
        floor,
        correction.position + (target.position - correction.position) * blend,
      ),
      target.stopIndex,
      target.source,
      target.phase,
      target.revision,
    );
  }
  reset() {
    this.key = "";
    this.topology = "";
    this.target = undefined;
    this.correction = undefined;
  }
}
