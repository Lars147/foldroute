import { type Journey, type Leg, transition } from "./model";
import { clock, dateLabel } from "./ui";

const preparation = (leg: Leg) => ["fold", "unfold", "wait"].includes(leg.kind);
export type JourneyPresentation = "live" | "example";

/** Group preparation with the next movement without crossing a planned stop. */
export function detailGroups(journey: Journey): Leg[][] {
  const groups: Leg[][] = [];
  let pending: Leg[] = [];
  let coveredUntil: number | undefined;
  for (const leg of journey.legs) {
    if (coveredUntil !== undefined && leg.start - coveredUntil >= 60)
      pending.push(transition("wait", leg.from, coveredUntil, leg.start));
    coveredUntil = Math.max(coveredUntil ?? leg.end, leg.end);
    if (preparation(leg)) {
      pending.push(leg);
    } else {
      if (leg.kind === "stop" && pending.length) {
        groups.push(pending);
        pending = [];
      }
      groups.push([...pending, leg]);
      pending = [];
    }
  }
  if (pending.length) groups.push(pending);
  return groups;
}

export function detailTime(
  journey: Journey,
  instant: number,
  comparedInstant = journey.departure,
): string {
  const crossDay =
    new Date(journey.departure * 1000).toDateString() !==
      new Date(journey.arrival * 1000).toDateString() ||
    new Date(instant * 1000).toDateString() !==
      new Date(comparedInstant * 1000).toDateString();
  return `${crossDay ? `${dateLabel(instant)} ` : ""}${clock(instant)}`;
}

export function detailTransitTime(
  journey: Journey,
  leg: Leg,
  event: "departure" | "arrival",
): { time: string; delay?: { time: string; minutes: number } } {
  const actual = event === "departure" ? leg.start : leg.end;
  const scheduled =
    event === "departure"
      ? (leg.scheduledStart ?? leg.transitReference?.scheduledDeparture)
      : (leg.scheduledEnd ?? leg.transitReference?.scheduledArrival);
  if (!leg.realtime || scheduled === undefined || actual - scheduled < 60)
    return { time: detailTime(journey, actual) };
  return {
    time: detailTime(journey, scheduled, actual),
    delay: {
      time: detailTime(journey, actual, scheduled),
      minutes: Math.floor((actual - scheduled) / 60),
    },
  };
}
