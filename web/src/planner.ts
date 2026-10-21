import { optimizeWalking } from "./walking-optimization";
import { planViaRoutes } from "./via-planner";
import { pool } from "./routing-pool";
import { workDeadline } from "./routing-retry";
import {
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type PlanningUpdate,
  type PlanningPhase,
  type Leg,
  type PlanningFailure,
  bikeBoardings,
  selectJourneys,
  cyclingExcess,
  shifted,
  transition,
  PlannerError,
  errorText,
  validSettings,
  validStops,
  planningFailures,
} from "./model";
import { distance, validCoordinate } from "./geometry";
import {
  ApiClient,
  baseVariants,
  type Batch,
  type StreetMode,
  type RequestBudget,
  type RoutingClient,
} from "./transitous";
export interface Seed {
  journey: Journey;
  index: number;
  request: RouteRequest;
  backwards: boolean;
  outer: StreetMode;
  key: string;
}
export function seeds(
  journeys: Journey[],
  request: RouteRequest,
  settings: RoutingSettings,
  depth: number,
): Seed[] {
  const buffer = settings.transferMinutes * 60;
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
  const buffer = settings.transferMinutes * 60;
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
const defaultClient = new ApiClient();
export interface SearchOptions {
  raw?: boolean;
  baseOnly?: boolean;
  budget?: RequestBudget;
}
async function* planRawRoutes(
  input: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client: RoutingClient = defaultClient,
  options: SearchOptions = {},
): AsyncGenerator<PlanningUpdate> {
  if (
    !validSettings(settings) ||
    !validStops(input.stops) ||
    !validCoordinate(input.origin) ||
    !validCoordinate(input.destination)
  )
    throw new PlannerError(
      "input",
      "Bitte Start, Ziel und Einstellungen prüfen.",
    );
  if (input.stops?.length) {
    yield* planViaRoutes(input, settings, signal, client, options.budget?.run);
    return;
  }
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
  if (!Number.isFinite(request.time))
    throw new PlannerError(
      "input",
      "Bitte einen gültigen Zeitpunkt auswählen.",
    );
  let all: Journey[] = [],
    issues: string[] = [],
    stopped = false,
    phase: PlanningPhase = "base";
  const incompletePhases = new Set<PlanningPhase>();
  const failures: PlanningFailure[] = [];
  const addIssues = (...messages: string[]) => {
    if (messages.length) incompletePhases.add(phase);
    issues.push(...messages);
  };
  const variants =
    settings.excludedTransitModes.length === 6
      ? baseVariants.slice(0, 1)
      : baseVariants;
  const add = (batch: Batch) => {
    all.push(
      ...batch.journeys.filter(
        (j) =>
          options.raw ||
          settings.showCyclingComparison ||
          cyclingExcess(j, settings.maxCyclingMinutes) === 0,
      ),
    );
    addIssues(...batch.issues);
    failures.push(...(batch.failures ?? []));
    if (batch.rejected)
      addIssues(
        "Einige Verbindungen wurden wegen fehlerhafter Streckendaten ausgeblendet.",
      );
    if (batch.stop) incompletePhases.add(phase);
    stopped ||= batch.stop;
  };
  const update = (status: PlanningUpdate["status"]): PlanningUpdate => ({
    journeys: options.raw
      ? [...all]
      : selectJourneys(
          all,
          request.timing,
          4,
          settings.maxCyclingMinutes,
          settings.showCyclingComparison,
        ),
    status,
    issues: [...new Set(issues)],
    failures: [...failures],
    phase,
    incompletePhases: [...incompletePhases],
  });
  signal.throwIfAborted();
  yield update("searching");
  for await (const result of pool(
    variants.map(
      (v) => (s) => client.batch(request, settings, v, s, options.budget),
    ),
    signal,
    () => !stopped,
  )) {
    signal.throwIfAborted();
    if (result.value) add(result.value);
    else {
      addIssues(errorText(result.error));
      failures.push(...planningFailures(result.error));
      stopped ||= result.error instanceof PlannerError && result.error.stops;
    }
    if (all.length) yield update("searching");
  }
  if (stopped && options.budget) options.budget.stopped = true;
  signal.throwIfAborted();
  if (!all.length)
    throw new PlannerError(
      issues.length ? "service" : "empty",
      issues.length
        ? [...new Set(issues)].join(" ")
        : "Keine passende Route gefunden. Ändere Start, Ziel, Zeit oder Einstellungen.",
      false,
      client.retryAt || undefined,
      failures,
    );
  if (
    options.baseOnly ||
    stopped ||
    !settings.maxBikeTransfers ||
    !all.some((j) => !j.isDirect)
  ) {
    yield update(incompletePhases.size ? "partial" : "complete");
    return;
  }
  let frontier = selectJourneys(
    all.filter((j) => !j.isDirect),
    request.timing,
  );
  const cache = new Map<string, Journey[]>(),
    requested = new Set<string>();
  const deadline = workDeadline(
    options.budget?.run,
    15000,
    new PlannerError(
      "deadline",
      "Suche nach weiteren Rad-Umstiegen: Zeitlimit erreicht.",
    ),
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
        incompletePhases.add("bike-transfers");
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
      if (jobs.length) {
        phase = "bike-transfers";
        yield update("searching");
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
                options.budget,
              ),
          ),
          searchSignal,
          () => !stopped,
        )) {
          signal.throwIfAborted();
          if (result.value) {
            const batch = result.value;
            addIssues(...batch.issues);
            failures.push(...(batch.failures ?? []));
            if (batch.rejected)
              addIssues(
                "Einige zusätzliche Verbindungen enthalten fehlerhafte Streckendaten.",
              );
            if (batch.stop) incompletePhases.add(phase);
            stopped ||= batch.stop;
            cache.set(jobs[result.index].key, batch.journeys);
            append(jobs[result.index], batch.journeys);
            const ids = new Set(all.map((j) => j.id));
            all.push(
              ...generated.filter((j) => !ids.has(j.id) && !!ids.add(j.id)),
            );
            yield update("searching");
          } else {
            addIssues(errorText(result.error));
            failures.push(...planningFailures(result.error));
            stopped ||=
              result.error instanceof PlannerError && result.error.stops;
          }
          if (deadline.signal.aborted) break;
        }
      } catch (error) {
        signal.throwIfAborted();
        addIssues(errorText(error));
        stopped = true;
      }
      const ids = new Set(all.map((j) => j.id));
      all.push(...generated.filter((j) => !ids.has(j.id) && !!ids.add(j.id)));
      yield update("searching");
      frontier = selectJourneys(generated, request.timing);
    }
    if (deadline.signal.aborted) {
      phase = "bike-transfers";
      addIssues(errorText(deadline.signal.reason));
    }
  } finally {
    deadline.dispose();
  }
  signal.throwIfAborted();
  if (stopped && options.budget) options.budget.stopped = true;
  yield update(incompletePhases.size ? "partial" : "complete");
}

export async function* planRoutes(
  input: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client: RoutingClient = defaultClient,
  options: SearchOptions = {},
): AsyncGenerator<PlanningUpdate> {
  if (!options.budget?.run && client.createRun) {
    const run = client.createRun(signal);
    if (run) {
      const parent = options.budget;
      let stopped = parent?.stopped;
      const budget: RequestBudget = {
        take: () => parent?.take(),
        run,
        get stopped() {
          return parent ? parent.stopped : stopped;
        },
        set stopped(value) {
          if (parent) parent.stopped = value;
          else stopped = value;
        },
      };
      try {
        yield* planRoutes(input, settings, signal, client, {
          ...options,
          budget,
        });
      } finally {
        run.dispose();
      }
      return;
    }
  }
  if (options.raw || options.baseOnly) {
    yield* planRawRoutes(input, settings, signal, client, options);
    return;
  }
  const budget = options.budget ?? { take() {} };
  let last: PlanningUpdate | undefined;
  for await (const update of planRawRoutes(input, settings, signal, client, {
    ...options,
    budget,
  })) {
    last = update;
    yield { ...update, status: "searching" };
  }
  if (!last) return;
  for await (const update of optimizeWalking(
    input.stops?.length ? [] : last.journeys,
    input,
    settings,
    signal,
    client,
    budget,
  )) {
    last = {
      ...last,
      journeys: selectJourneys(
        update.journeys,
        input.timing,
        4,
        settings.maxCyclingMinutes,
        settings.showCyclingComparison,
      ),
      issues: [...new Set([...last.issues, ...update.issues])],
      failures: [...(last.failures ?? []), ...(update.failures ?? [])],
      status: "searching",
      phase: "walking",
      incompletePhases: [
        ...new Set([
          ...last.incompletePhases,
          ...(update.incomplete ? ["walking" as const] : []),
        ]),
      ],
    };
    yield last;
  }
  yield {
    ...last,
    status: last.incompletePhases.length ? "partial" : "complete",
  };
}
