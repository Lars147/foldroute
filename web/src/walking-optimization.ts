import {
  type Journey,
  type Leg,
  type RouteRequest,
  type RoutingSettings,
  walkingSeconds,
  selectJourneys,
  bikeBoardings,
  transition,
  PlannerError,
  errorText,
} from "./model";
import { distance } from "./geometry";
import { ApiClient, type RequestBudget } from "./transitous";

export interface WalkingBlock {
  journey: Journey;
  first: number;
  last: number;
  folded: boolean;
  seconds: number;
}
export function walkingBlocks(journeys: Journey[]): WalkingBlock[] {
  const result: WalkingBlock[] = [];
  for (const journey of journeys) {
    let folded = false;
    for (let i = 0; i < journey.legs.length; i++) {
      const leg = journey.legs[i];
      if (leg.kind === "fold" || leg.kind === "transit") folded = true;
      if (leg.kind === "unfold" || leg.kind === "stop") folded = false;
      if (leg.kind !== "walk") continue;
      const first = i;
      while (journey.legs[i + 1]?.kind === "walk") i++;
      const seconds = journey.legs
        .slice(first, i + 1)
        .reduce((sum, l) => sum + l.end - l.start, 0);
      if (seconds > 0)
        result.push({ journey, first, last: i, folded, seconds });
    }
  }
  return result.sort(
    (a, b) =>
      b.seconds - a.seconds ||
      a.journey.id.localeCompare(b.journey.id) ||
      a.first - b.first,
  );
}
export function cyclingReplacement(
  block: WalkingBlock,
  ride: Journey,
  settings: RoutingSettings,
): Journey | undefined {
  const { journey, first, last, folded } = block;
  const original = journey.legs;
  const from = original[first].from,
    to = original[last].to;
  const lower = first ? original[first - 1].end : journey.departure;
  const upper =
    last + 1 < original.length ? original[last + 1].start : journey.arrival;
  const fold = folded ? settings.foldingDuration : 0,
    buffer = folded ? 180 : 0;
  if (
    !ride.legs.length ||
    !ride.legs.some((l) => l.kind === "bike") ||
    ride.legs.some((l) => l.kind !== "walk" && l.kind !== "bike") ||
    ride.departure < lower + fold ||
    ride.arrival + fold + buffer > upper ||
    distance(ride.legs[0].from, from) > 30 ||
    distance(ride.legs.at(-1)!.to, to) > 30
  )
    return;
  const replacement: Leg[] = [];
  if (folded) replacement.push(transition("unfold", from, lower, lower + fold));
  replacement.push(...ride.legs);
  if (folded)
    replacement.push(transition("fold", to, ride.arrival, ride.arrival + fold));
  const end = ride.arrival + fold;
  if (last + 1 < original.length && end < upper)
    replacement.push(transition("wait", to, end, upper));
  const legs = [
    ...original.slice(0, first),
    ...replacement,
    ...original.slice(last + 1),
  ];
  if (
    legs.some(
      (l, i) =>
        !Number.isFinite(l.start) ||
        !Number.isFinite(l.end) ||
        l.end < l.start ||
        (i > 0 &&
          (legs[i - 1].end > l.start || distance(legs[i - 1].to, l.from) > 30)),
    )
  )
    return;
  let cycling = 0;
  for (const leg of legs) {
    if (leg.kind === "transit" || leg.kind === "stop") cycling = 0;
    if (leg.kind === "bike") cycling += leg.end - leg.start;
    if (cycling > settings.maxCyclingMinutes * 60) return;
  }
  const result = {
    ...journey,
    id: `${journey.id}|ride:${first}-${last}:${ride.id}`,
    legs,
    departure: legs[0].start,
    arrival: legs.at(-1)!.end,
  };
  if (
    result.departure < journey.departure ||
    result.arrival > journey.arrival ||
    walkingSeconds(result) >= walkingSeconds(journey) ||
    bikeBoardings(result).length > settings.maxBikeTransfers
  )
    return;
  return result;
}

export async function* optimizeWalking(
  journeys: Journey[],
  request: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client: ApiClient,
  parentBudget?: RequestBudget,
): AsyncGenerator<{ journeys: Journey[]; issues: string[] }> {
  const chosen = selectJourneys(
    journeys.filter((j) => !j.isDirect),
    request.timing,
    3,
    settings.maxCyclingMinutes,
    false,
  );
  const blocks = walkingBlocks(chosen);
  if (
    !blocks.length ||
    parentBudget?.stopped ||
    client.retryAt > Date.now() / 1000
  )
    return;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  let count = 0;
  const budget: RequestBudget = {
    take() {
      if (count >= 6 || parentBudget?.stopped)
        throw new PlannerError("budget", "Radprüfung beendet.", true);
      parentBudget?.take();
      count++;
    },
  };
  const cache = new Map<string, Promise<Journey[]>>();
  const latest = new Map(chosen.map((j) => [j.id, j]));
  const improvements: Journey[] = [],
    issues: string[] = [];
  let stopped = false;
  const fetchBlock = async (block: WalkingBlock) => {
    const lower = block.first
      ? block.journey.legs[block.first - 1].end
      : block.journey.departure;
    const part: RouteRequest = {
      origin: block.journey.legs[block.first].from,
      destination: block.journey.legs[block.last].to,
      timing: "depart",
      time: lower + (block.folded ? settings.foldingDuration : 0),
    };
    const key = JSON.stringify([
      part.origin.stopId ?? [part.origin.latitude, part.origin.longitude],
      part.destination.stopId ?? [
        part.destination.latitude,
        part.destination.longitude,
      ],
      part.time,
    ]);
    let pending = cache.get(key);
    if (!pending) {
      pending = client
        .batch(
          part,
          settings,
          { direct: true, pre: "BIKE", post: "BIKE", street: true },
          combined,
          budget,
        )
        .then((batch) => {
          if (batch.stop) {
            stopped = true;
            if (parentBudget) parentBudget.stopped = true;
          }
          issues.push(...batch.issues);
          return batch.journeys;
        });
      cache.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PlannerError && error.stops) stopped = true;
      if (
        !combined.aborted &&
        !(
          error instanceof PlannerError &&
          ["budget", "empty"].includes(error.code)
        )
      )
        issues.push(errorText(error));
      return [];
    }
  };
  try {
    for (
      let i = 0;
      i < blocks.length && !stopped && !combined.aborted && count < 6;
      i += 2
    ) {
      const jobs = blocks.slice(i, i + 2);
      const responses = await Promise.all(jobs.map(fetchBlock));
      signal.throwIfAborted();
      for (let n = 0; n < jobs.length; n++) {
        const originalBlock = jobs[n];
        const current = latest.get(originalBlock.journey.id)!;
        // Locate unchanged legs by identity after earlier replacements shift indices.
        const first = current.legs.indexOf(
          originalBlock.journey.legs[originalBlock.first],
        );
        const last = current.legs.indexOf(
          originalBlock.journey.legs[originalBlock.last],
        );
        if (first < 0 || last < first) continue;
        const block = { ...originalBlock, journey: current, first, last };
        const replacements = responses[n].flatMap((ride) => {
          const candidate = cyclingReplacement(block, ride, settings);
          return candidate ? [candidate] : [];
        });
        const best = selectJourneys(
          replacements,
          request.timing,
          1,
          settings.maxCyclingMinutes,
          false,
        )[0];
        if (best) {
          latest.set(originalBlock.journey.id, best);
          improvements.push(best);
        }
      }
      yield {
        journeys: [...journeys, ...improvements],
        issues: [...new Set(issues)],
      };
    }
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
  signal.throwIfAborted();
}
