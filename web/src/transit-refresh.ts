import {
  bikeBoardings,
  type Journey,
  type Leg,
  type TransitReference,
} from "./model";
import { assessConnection } from "./connection-assessment";
import { platform, retryAfter, service } from "./transitous";

export interface TransitUpdate {
  departure: number;
  arrival: number;
  platform?: string;
  arrivalPlatform?: string;
  realtime: boolean;
  cancelled: boolean;
  updatedAt: number;
}
export type TransitResult =
  | { kind: "updated"; update: TransitUpdate }
  | { kind: "unavailable" }
  | { kind: "failed"; retryAt?: number };
type Stop = {
  stopId?: string;
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
};
type TripLeg = {
  from: Stop;
  to: Stop;
  intermediateStops?: Stop[];
  realTime?: boolean;
  cancelled?: boolean;
};
const timestamp = (s?: string) => (s ? Date.parse(s) / 1000 : NaN);
export const transitRetryDelay = (failures: number) =>
  failures <= 1 ? 120 : failures === 2 ? 240 : 300;
export function matchTrip(
  value: unknown,
  ref: TransitReference,
  now: number,
): TransitResult {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { legs?: unknown }).legs)
  )
    return { kind: "unavailable" };
  const legs = (value as { legs: TripLeg[] }).legs;
  if (
    !legs.length ||
    legs.some(
      (l) =>
        !l ||
        !l.from ||
        !l.to ||
        (l.intermediateStops !== undefined &&
          !Array.isArray(l.intermediateStops)),
    )
  )
    return { kind: "unavailable" };
  const stops = legs.flatMap((leg) =>
    [leg.from, ...(leg.intermediateStops ?? []), leg.to].map((stop) => ({
      stop,
      leg,
    })),
  );
  const board = stops.flatMap(({ stop }, i) =>
    stop?.stopId === ref.fromId &&
    timestamp(stop.scheduledDeparture) === ref.scheduledDeparture
      ? [i]
      : [],
  );
  const alight = stops.flatMap(({ stop }, i) =>
    stop?.stopId === ref.toId &&
    timestamp(stop.scheduledArrival) === ref.scheduledArrival
      ? [i]
      : [],
  );
  if (board.length !== 1 || alight.length !== 1 || board[0] >= alight[0])
    return { kind: "unavailable" };
  const from = stops[board[0]],
    to = stops[alight[0]];
  const departure = timestamp(
      from.stop.departure ?? from.stop.scheduledDeparture,
    ),
    arrival = timestamp(to.stop.arrival ?? to.stop.scheduledArrival);
  if (
    !Number.isFinite(departure) ||
    !Number.isFinite(arrival) ||
    arrival < departure
  )
    return { kind: "unavailable" };
  const track = (stop: Stop) =>
    typeof (stop.track ?? stop.scheduledTrack) === "string"
      ? platform(stop.stopId, stop.track ?? stop.scheduledTrack)
      : undefined;
  return {
    kind: "updated",
    update: {
      departure,
      arrival,
      platform: track(from.stop),
      arrivalPlatform: track(to.stop),
      realtime: from.leg.realTime === true && to.leg.realTime === true,
      cancelled:
        from.stop.cancelled === true ||
        to.stop.cancelled === true ||
        stops
          .slice(board[0], alight[0] + 1)
          .some(({ leg }) => leg.cancelled === true),
      updatedAt: now,
    },
  };
}
export class TransitRefresher {
  private due = new Map<string, number>();
  private failures = new Map<string, number>();
  private retryAt = 0;
  constructor(
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async refresh(
    legs: Leg[],
    signal: AbortSignal,
    now = Date.now() / 1000,
  ): Promise<Map<string, TransitResult>> {
    const results = new Map<string, TransitResult>();
    if (now < this.retryAt) return results;
    const groups = new Map<string, Leg[]>();
    for (const leg of legs) {
      if (
        leg.kind !== "transit" ||
        now < (this.due.get(leg.navigationId!) ?? 0)
      )
        continue;
      if (!leg.transitReference) {
        results.set(leg.navigationId!, { kind: "unavailable" });
        this.due.set(leg.navigationId!, now + 300);
        continue;
      }
      const key = leg.transitReference.tripId;
      groups.set(key, [...(groups.get(key) ?? []), leg]);
    }
    for (const [tripId, group] of groups) {
      signal.throwIfAborted();
      const url = new URL(`${service.api}/v6/trip`);
      url.search = new URLSearchParams({
        tripId,
        detailedLegs: "false",
        withScheduledSkippedStops: "true",
        language: "de",
      }).toString();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 20000);
      let limited = false;
      let groupResults: TransitResult[];
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.any([signal, timeout.signal]),
          cache: "no-store",
          referrerPolicy: "strict-origin-when-cross-origin",
        });
        signal.throwIfAborted();
        limited = response.status === 429 || response.status === 503;
        if (limited) {
          this.retryAt = Math.max(
            now + 120,
            retryAfter(response.headers.get("Retry-After"), now) ?? 0,
          );
          groupResults = group.map(() => ({
            kind: "failed",
            retryAt: this.retryAt,
          }));
        } else if ([400, 404, 422].includes(response.status))
          groupResults = group.map(() => ({ kind: "unavailable" }));
        else if (!response.ok)
          groupResults = group.map(() => ({ kind: "failed" }));
        else {
          const value: unknown = await response.json();
          signal.throwIfAborted();
          groupResults = group.map((leg) =>
            matchTrip(value, leg.transitReference!, Date.now() / 1000),
          );
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        groupResults = group.map(() => ({ kind: "failed" }));
      } finally {
        clearTimeout(timer);
      }
      group.forEach((leg, i) => {
        const id = leg.navigationId!,
          result = groupResults[i];
        results.set(id, result);
        const count =
          result.kind === "failed" ? (this.failures.get(id) ?? 0) + 1 : 0;
        this.failures.set(id, count);
        this.due.set(
          id,
          Math.max(Date.now() / 1000, now) +
            (result.kind === "updated"
              ? 60
              : result.kind === "unavailable"
                ? 300
                : transitRetryDelay(count)),
        );
      });
      if (limited) break;
    }
    return results;
  }
}
export function applyTransit(
  journey: Journey,
  index: number,
  results: Map<string, TransitResult>,
): Journey {
  const copy = structuredClone(journey),
    boardings = bikeBoardings(journey);
  copy.legs.forEach((leg, i) => {
    if (i < index || leg.kind !== "transit") return;
    const result = results.get(leg.navigationId!);
    if (!result) return;
    if (result.kind !== "updated") {
      leg.transitStatus = {
        ...leg.transitStatus,
        failure: result.kind === "failed" ? "network" : "unavailable",
      };
      return;
    }
    const u = result.update;
    Object.assign(leg, {
      start: u.departure,
      end: u.arrival,
      platform: u.platform,
      arrivalPlatform: u.arrivalPlatform,
      realtime: u.realtime,
      transitStatus: { updatedAt: u.updatedAt, cancelled: u.cancelled },
    });
  });
  const boardingSchedule = (i: number) => {
    const boarding = copy.legs.findIndex(
      (leg, n) => n > i && leg.kind === "transit",
    );
    const activities = boarding < 0 ? [] : journey.legs.slice(i + 1, boarding);
    return {
      departure: boarding < 0 ? undefined : copy.legs[boarding].start,
      work: activities.reduce(
        (seconds, leg) =>
          seconds +
          (leg.kind === "wait" ? 0 : Math.max(0, leg.end - leg.start)),
        0,
      ),
      buffer: boardings.includes(boarding) ? 180 : 0,
    };
  };
  const waitEnd = (i: number, earliest: number) => {
    const { departure, work, buffer } = boardingSchedule(i);
    // A final wait includes the boarding buffer. Earlier waits must leave
    // enough time for folding/movement and that final buffer.
    return Math.max(
      earliest,
      departure === undefined
        ? journey.legs[i].end
        : departure - work - (work > 0 ? buffer : 0),
    );
  };
  const current = copy.legs[index];
  if (current?.kind === "wait") current.end = waitEnd(index, current.start);
  for (let i = index + 1; i < copy.legs.length; i++) {
    const leg = copy.legs[i],
      previousEnd = copy.legs[i - 1].end,
      duration = leg.end - leg.start;
    if (leg.kind === "transit") continue;
    leg.start = previousEnd;
    if (leg.kind === "wait") leg.end = waitEnd(i, previousEnd);
    else if (leg.kind === "stop")
      leg.end = Math.max(
        leg.end,
        previousEnd + (leg.stop?.stayMinutes ?? 0) * 60,
      );
    else if (leg.kind === "fold") {
      const { departure, work, buffer } = boardingSchedule(i);
      leg.start = Math.max(
        previousEnd,
        (departure ?? previousEnd) - duration - work - buffer,
      );
      leg.end = leg.start + duration;
    } else leg.end = previousEnd + duration;
  }
  copy.departure = copy.legs[0].start;
  copy.arrival = copy.legs.at(-1)!.end;
  return copy;
}
export interface Disruption {
  id: string;
  message: string;
}
export function transitDisruption(
  journey: Journey,
  index: number,
  now: number,
  remainingMovement?: number,
): Disruption | undefined {
  const assessment = assessConnection(journey, index, now, {
    remainingMovement,
    onboard: journey.legs[index]?.kind === "transit",
  });
  return assessment.status === "ready" || assessment.status === "unknown"
    ? undefined
    : { id: assessment.id, message: assessment.message };
}
