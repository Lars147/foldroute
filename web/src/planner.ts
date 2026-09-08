import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type PlanningUpdate,
  type Leg,
  bikeBoardings,
  selectJourneys,
  shifted,
  transition,
  PlannerError,
  errorText,
  validSettings,
} from "./model";
import { distance, validCoordinate } from "./geometry";
import {
  ApiClient,
  baseVariants,
  type Batch,
  type StreetMode,
} from "./transitous";
export interface Seed {
  journey: Journey;
  index: number;
  request: RouteRequest;
  backwards: boolean;
  outer: StreetMode;
  key: string;
}
const buffer = 180;
export function seeds(
  journeys: Journey[],
  request: RouteRequest,
  settings: RoutingSettings,
  depth: number,
): Seed[] {
  const lists = journeys.map((journey) =>
    journey.legs.flatMap((leg, index): Seed[] => {
      if (leg.kind !== "transit") return [];
      const backwards = request.timing === "arrive";
      const retained = backwards
        ? journey.legs.slice(index)
        : journey.legs.slice(0, index + 1);
      if (bikeBoardings({ ...journey, legs: retained }).length !== depth)
        return [];
      if (
        distance(
          backwards ? request.origin : leg.to,
          backwards ? leg.from : request.destination,
        ) <= 100
      )
        return [];
      const part: RouteRequest = backwards
        ? {
            origin: request.origin,
            destination: leg.from,
            timing: "arrive",
            time: leg.start - settings.foldingDuration - buffer,
          }
        : {
            origin: leg.to,
            destination: request.destination,
            timing: "depart",
            time: leg.end + settings.foldingDuration + buffer,
          };
      const ordered = backwards ? journey.legs : [...journey.legs].reverse();
      const outer: StreetMode = ordered
        .slice(
          0,
          ordered.findIndex((l) => l.kind === "transit"),
        )
        .some((l) => l.kind === "bike")
        ? "BIKE"
        : "WALK";
      const point = backwards ? part.destination : part.origin;
      return [
        {
          journey,
          index,
          request: part,
          backwards,
          outer,
          key: `${outer}|${backwards}|${point.latitude}|${point.longitude}|${part.time}`,
        },
      ];
    }),
  );
  const result: Seed[] = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++)
    for (const list of lists) if (list[i]) result.push(list[i]);
  return result;
}
export function compose(
  seed: Seed,
  part: Journey,
  request: RouteRequest,
  settings: RoutingSettings,
): Journey | undefined {
  const first = part.legs.findIndex((l) => l.kind === "transit"),
    last = part.legs.findLastIndex((l) => l.kind === "transit");
  if (first < 0 || last < 0) return;
  const riding = (
    seed.backwards ? part.legs.slice(last + 1) : part.legs.slice(0, first)
  ).filter((l) => l.kind === "bike");
  const seconds = riding.reduce((s, l) => s + l.end - l.start, 0);
  if (
    !riding.length ||
    seconds <= 0 ||
    seconds > settings.maxCyclingMinutes * 60 ||
    riding.reduce((s, l) => s + l.distance, 0) <= 0
  )
    return;
  let legs: Leg[];
  if (seed.backwards) {
    const boarding = seed.journey.legs[seed.index],
      end = boarding.start - buffer,
      start = end - settings.foldingDuration;
    if (part.legs.at(-1)!.end > start) return;
    legs = [
      ...part.legs,
      transition("fold", boarding.from, start, end),
      transition("wait", boarding.from, end, boarding.start),
      ...seed.journey.legs.slice(seed.index),
    ];
  } else {
    const alighting = seed.journey.legs[seed.index],
      unfoldEnd = alighting.end + settings.foldingDuration;
    const approach = part.legs
      .slice(0, first)
      .map((l) =>
        l.kind === "fold"
          ? { ...l, start: l.start - buffer, end: l.end - buffer }
          : shifted(l, -buffer),
      );
    if (!approach.length || approach[0].start < unfoldEnd) return;
    const boarding = part.legs[first];
    legs = [
      ...seed.journey.legs.slice(0, seed.index + 1),
      transition("unfold", alighting.to, alighting.end, unfoldEnd),
      ...approach,
      transition(
        "wait",
        boarding.from,
        boarding.start - buffer,
        boarding.start,
      ),
      ...part.legs.slice(first),
    ];
  }
  if (
    legs.some(
      (l, i) =>
        i > 0 &&
        (legs[i - 1].end > l.start || distance(legs[i - 1].to, l.from) >= 100),
    )
  )
    return;
  const departure = legs[0].start,
    arrival = legs.at(-1)!.end;
  if (
    request.timing === "arrive"
      ? arrival > request.time
      : departure < request.time
  )
    return;
  const transit = legs.filter((l) => l.kind === "transit");
  const trips = transit.map(
    (l) =>
      l.tripId ?? `${l.line}|${l.from.latitude},${l.from.longitude}|${l.start}`,
  );
  if (new Set(trips).size !== trips.length) return;
  const result: Journey = {
    id: `bike-transfer|${seed.journey.id}|${seed.index}|${part.id}`,
    origin: request.origin,
    destination: request.destination,
    departure,
    arrival,
    legs,
    transfers: Math.max(0, transit.length - 1),
    isDirect: false,
  };
  return bikeBoardings(result).length <= settings.maxBikeTransfers
    ? result
    : undefined;
}
interface JobResult<T> {
  index: number;
  value?: T;
  error?: unknown;
}
async function* pool<T>(
  jobs: ((signal: AbortSignal) => Promise<T>)[],
  signal: AbortSignal,
): AsyncGenerator<JobResult<T>> {
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const pending = new Map<number, Promise<JobResult<T>>>();
  let next = 0;
  function submit() {
    const index = next++;
    pending.set(
      index,
      jobs[index](combined).then(
        (value) => ({ index, value }),
        (error) => ({ index, error }),
      ),
    );
  }
  try {
    while (next < Math.min(2, jobs.length)) submit();
    while (pending.size) {
      signal.throwIfAborted();
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      yield result;
      signal.throwIfAborted();
      if (next < jobs.length) submit();
    }
  } finally {
    controller.abort();
  }
}
const defaultClient = new ApiClient();
export async function* planRoutes(
  input: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client = defaultClient,
): AsyncGenerator<PlanningUpdate> {
  if (
    !validSettings(settings) ||
    !validCoordinate(input.origin) ||
    !validCoordinate(input.destination)
  )
    throw new PlannerError(
      "input",
      "Bitte Start, Ziel und Einstellungen prüfen.",
    );
  if (distance(input.origin, input.destination) < 30)
    throw new PlannerError(
      "input",
      "Start und Ziel liegen zu nah beieinander.",
    );
  const request = {
    ...input,
    time: input.time,
    timing: input.timing === "now" ? ("depart" as const) : input.timing,
  };
  if (
    !Number.isFinite(request.time) ||
    (input.timing !== "now" && request.time < Date.now() / 1000)
  )
    throw new PlannerError(
      "input",
      "Bitte einen aktuellen oder zukünftigen Zeitpunkt auswählen.",
    );
  let all: Journey[] = [],
    issues: string[] = [],
    stopped = false,
    directFinished = false;
  const variants =
    settings.excludedTransitModes.length === 6
      ? baseVariants.slice(0, 1)
      : baseVariants;
  const add = (batch: Batch) => {
    all.push(...batch.journeys);
    issues.push(...batch.issues);
    if (batch.rejected)
      issues.push(
        "Einige Verbindungen wurden wegen fehlerhafter Streckendaten ausgeblendet.",
      );
    stopped ||= batch.stop;
  };
  const update = (status: PlanningUpdate["status"]): PlanningUpdate => ({
    journeys: selectJourneys(all, request.timing),
    status,
    issues: [...new Set(issues)],
  });
  for await (const result of pool(
    variants.map((v) => (s) => client.batch(request, settings, v, s)),
    signal,
  )) {
    signal.throwIfAborted();
    if (result.index === 0) directFinished = true;
    if (result.value) add(result.value);
    else {
      issues.push(errorText(result.error));
      stopped ||= result.error instanceof PlannerError && result.error.stops;
    }
    if (directFinished && all.length) yield update("searching");
    if (stopped) break;
  }
  signal.throwIfAborted();
  if (!all.length)
    throw new PlannerError(
      "empty",
      issues.length
        ? [...new Set(issues)].join(" ")
        : "Keine passende Route gefunden. Ändere Start, Ziel, Zeit oder Einstellungen.",
    );
  if (stopped || !settings.maxBikeTransfers || !all.some((j) => !j.isDirect)) {
    yield update(issues.length ? "partial" : "complete");
    return;
  }
  yield update("searching");
  let frontier = selectJourneys(
    all.filter((j) => !j.isDirect),
    request.timing,
  );
  const cache = new Map<string, Journey[]>(),
    requested = new Set<string>();
  const deadline = new AbortController(),
    timer = setTimeout(
      () =>
        deadline.abort(
          new PlannerError(
            "deadline",
            "Die Suche nach weiteren Rad-Umstiegen wurde nach Ablauf des Zeitlimits beendet.",
          ),
        ),
      15000,
    );
  const searchSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    for (
      let depth = 0;
      depth < settings.maxBikeTransfers && frontier.length && !stopped;
      depth++
    ) {
      if (searchSignal.aborted) {
        signal.throwIfAborted();
        issues.push(errorText(searchSignal.reason));
        break;
      }
      const generated: Journey[] = [],
        jobs: Seed[] = [];
      const append = (seed: Seed, parts: Journey[]) => {
        for (const part of parts) {
          const j = compose(seed, part, request, settings);
          if (j) generated.push(j);
        }
      };
      for (const seed of seeds(frontier, request, settings, depth)) {
        if (cache.has(seed.key)) append(seed, cache.get(seed.key)!);
        else if (!requested.has(seed.key)) {
          requested.add(seed.key);
          jobs.push(seed);
          if (jobs.length === 4) break;
        }
      }
      try {
        for await (const result of pool(
          jobs.map(
            (seed) => (s) =>
              client.batch(
                seed.request,
                settings,
                seed.backwards
                  ? {
                      pre: seed.outer,
                      post: "BIKE",
                      postLimit: settings.maxCyclingMinutes * 60,
                    }
                  : {
                      pre: "BIKE",
                      post: seed.outer,
                      preLimit: settings.maxCyclingMinutes * 60,
                    },
                s,
              ),
          ),
          searchSignal,
        )) {
          signal.throwIfAborted();
          if (result.value) {
            const batch = result.value;
            issues.push(...batch.issues);
            if (batch.rejected)
              issues.push(
                "Einige zusätzliche Verbindungen enthalten fehlerhafte Streckendaten.",
              );
            stopped ||= batch.stop;
            cache.set(jobs[result.index].key, batch.journeys);
            append(jobs[result.index], batch.journeys);
          } else {
            issues.push(errorText(result.error));
            stopped ||=
              result.error instanceof PlannerError && result.error.stops;
          }
          if (stopped || deadline.signal.aborted) break;
        }
      } catch (error) {
        signal.throwIfAborted();
        issues.push(errorText(error));
        stopped = true;
      }
      const ids = new Set(all.map((j) => j.id));
      all.push(...generated.filter((j) => !ids.has(j.id) && !!ids.add(j.id)));
      yield update("searching");
      frontier = selectJourneys(generated, request.timing);
    }
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
  signal.throwIfAborted();
  yield update(issues.length ? "partial" : "complete");
}
