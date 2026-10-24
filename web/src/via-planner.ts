import { joinAtStation } from "./station-join";
import { optimizeWalking } from "./walking-optimization";
import { workDeadline, type RoutingRun } from "./routing-retry";
import {
  type Journey,
  type RouteRequest,
  type RouteStop,
  type RoutingSettings,
  type PlanningUpdate,
  type PlanningPhase,
  type PlanningRoutePreview,
  type PlanningFailure,
  compare,
  connectionKey,
  sectionCyclingExcess,
  bikeBoardings,
  selectJourneys,
  PlannerError,
  errorText,
  planningFailures,
} from "./model";
import { distance } from "./geometry";
import type { RequestBudget, RoutingClient } from "./transitous";
import { planRoutes } from "./planner";

export function joinAtStop(
  first: Journey,
  last: Journey,
  stop: RouteStop,
): Journey | undefined {
  if (
    first.arrival + stop.stayMinutes * 60 > last.departure ||
    distance(first.destination, stop.place) >= 100 ||
    distance(last.origin, stop.place) >= 100
  )
    return;
  return {
    id: `via|${first.id}|${stop.id}|${stop.stayMinutes}|${last.id}`,
    origin: first.origin,
    destination: last.destination,
    departure: first.departure,
    arrival: last.arrival,
    legs: [
      ...first.legs,
      {
        kind: "stop",
        stop,
        from: stop.place,
        to: stop.place,
        start: first.arrival,
        end: last.departure,
        distance: 0,
        coordinates: [stop.place],
      },
      ...last.legs,
    ],
    transfers: first.transfers + last.transfers,
    isDirect: first.isDirect && last.isDirect,
  };
}
interface Candidate {
  journey: Journey;
  overLimit: boolean;
}
async function extendCandidate(
  path: Candidate | undefined,
  child: Journey,
  boundary: RouteStop | undefined,
  backward: boolean,
  settings: RoutingSettings,
  client: RoutingClient,
  signal: AbortSignal,
  budget: RequestBudget,
): Promise<Candidate | undefined> {
  const join = (first: Journey, last: Journey) =>
    boundary!.place.kind === "station"
      ? joinAtStation(
          first,
          last,
          boundary!,
          settings,
          client,
          signal,
          budget,
          backward,
        )
      : joinAtStop(first, last, boundary!);
  const journey = path
    ? backward
      ? await join(child, path.journey)
      : await join(path.journey, child)
    : child;
  const overLimit =
    !!path?.overLimit ||
    sectionCyclingExcess(child, settings.maxCyclingMinutes) > 0;
  if (
    !journey ||
    (overLimit && !journey.isDirect) ||
    bikeBoardings(journey).length > settings.maxBikeTransfers
  )
    return;
  return { journey, overLimit };
}
function frontier(items: Candidate[], request: RouteRequest): Candidate[] {
  const seen = new Set<string>();
  const sorted = items
    .sort((a, b) => compare(a.journey, b.journey, request.timing))
    .filter((c) => {
      const key = connectionKey(c.journey);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const regular = sorted.filter((c) => !c.overLimit).slice(0, 3);
  const cycling = sorted.find((c) => c.journey.isDirect);
  return cycling && !regular.includes(cycling)
    ? [...regular, cycling]
    : regular;
}

export async function* planViaRoutes(
  request: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client: RoutingClient,
  run?: RoutingRun,
): AsyncGenerator<PlanningUpdate> {
  let stops = request.stops!;
  let places = [
    request.origin,
    ...stops.map((s) => s.place),
    request.destination,
  ];
  for (let i = 1; i < places.length; i++)
    if (distance(places[i - 1], places[i]) < 30)
      throw new PlannerError(
        "input",
        `Teilstrecke ${i}: Die Orte liegen zu nah beieinander.`,
      );
  const fixed = {
    ...request,
    time: request.time,
  };
  if (!Number.isFinite(fixed.time))
    throw new PlannerError(
      "input",
      "Bitte einen gültigen Zeitpunkt auswählen.",
    );
  const deadline = workDeadline(
    run,
    60000,
    new PlannerError(
      "deadline",
      "Suche über Zwischenziele: Zeitlimit erreicht.",
      true,
    ),
  );
  const combined = AbortSignal.any([signal, deadline.signal]);
  let count = 0;
  const budget: RequestBudget = {
    run,
    take() {
      if (++count > 64)
        throw new PlannerError(
          "budget",
          "Suche über Zwischenziele: Anfragelimit erreicht.",
          true,
        );
    },
  };
  if (client.resolveStation) {
    try {
      places = await Promise.all(
        places.map((place) => client.resolveStation!(place, combined, budget)),
      );
      stops = stops.map((stop, index) => ({
        ...stop,
        place: places[index + 1],
      }));
      request = {
        ...request,
        origin: places[0],
        destination: places.at(-1)!,
        stops,
      };
      Object.assign(fixed, request);
    } catch (error) {
      deadline.dispose();
      throw error;
    }
  }
  const issues = new Set<string>();
  const failures: PlanningFailure[] = [];
  const incompletePhases = new Set<PlanningPhase>();
  let completed: Journey[] = [],
    stopped = false,
    retryableFailure = false,
    phase: PlanningPhase = "via";
  let activeSection: number | undefined;
  let routePreview: PlanningRoutePreview | undefined;
  const update = (status: PlanningUpdate["status"]): PlanningUpdate => ({
    journeys: selectJourneys(
      completed,
      request.timing,
      4,
      settings.maxCyclingMinutes,
      settings.showCyclingComparison,
    ),
    status,
    phase,
    issues: [...issues],
    failures: [...failures],
    incompletePhases: [...incompletePhases],
    activeSection: status === "searching" ? activeSection : undefined,
    routePreview:
      status === "searching" && !completed.length ? routePreview : undefined,
  });
  const backward = request.timing === "arrive";
  try {
    // Complete the base itinerary before spending requests on additional bike transfers.
    for (const baseOnly of settings.maxBikeTransfers ? [true, false] : [true]) {
      let paths: Candidate[] = [];
      for (let stage = 0; stage < places.length - 1 && !stopped; stage++) {
        const index = backward ? places.length - 2 - stage : stage;
        const additions: Candidate[] = [];
        for (const path of paths.length ? paths : [undefined]) {
          const boundary = path
            ? stops[backward ? index : index - 1]
            : undefined;
          const time = path
            ? backward
              ? path.journey.departure - boundary!.stayMinutes * 60
              : path.journey.arrival + boundary!.stayMinutes * 60
            : fixed.time;
          const part: RouteRequest = {
            origin: places[index],
            ...(index > 0 && places[index].kind === "station"
              ? { bikeFolded: true }
              : {}),
            destination: places[index + 1],
            timing: backward
              ? "arrive"
              : !path && request.timing === "now"
                ? "now"
                : "depart",
            time,
          };
          let candidates: Candidate[] = [];
          activeSection = index;
          phase = "via";
          if (path)
            routePreview =
              !path.overLimit || settings.showCyclingComparison
                ? {
                    legs: path.journey.legs,
                    startSection: backward ? index + 1 : 0,
                    endSection: backward ? places.length - 1 : index,
                  }
                : undefined;
          signal.throwIfAborted();
          yield update("searching");
          try {
            for await (const partUpdate of planRoutes(
              part,
              settings,
              combined,
              client,
              { raw: true, baseOnly, budget },
            )) {
              candidates = [];
              for (const child of partUpdate.journeys) {
                const candidate = await extendCandidate(
                  path,
                  child,
                  boundary,
                  backward,
                  settings,
                  client,
                  combined,
                  budget,
                );
                if (candidate) candidates.push(candidate);
              }
              const preview = frontier([...candidates], request).find(
                (candidate) =>
                  !candidate.overLimit || settings.showCyclingComparison,
              );
              if (preview)
                routePreview = {
                  legs: preview.journey.legs,
                  startSection: backward ? index : 0,
                  endSection: backward ? places.length - 1 : index + 1,
                };
              phase = partUpdate.phase === "base" ? "via" : partUpdate.phase;
              partUpdate.issues.forEach((issue) => issues.add(issue));
              failures.push(...(partUpdate.failures ?? []));
              partUpdate.incompletePhases.forEach((value) =>
                incompletePhases.add(value === "base" ? "via" : value),
              );
              // Only complete end-to-end journeys enter the results array.
              yield update("searching");
            }
          } catch (error) {
            signal.throwIfAborted();
            retryableFailure ||= !(
              error instanceof PlannerError &&
              ["input", "empty"].includes(error.code)
            );
            issues.add(
              `Teilstrecke ${index + 1} (${places[index].name} → ${places[index + 1].name}): ${errorText(error)}`,
            );
            failures.push(...planningFailures(error));
            incompletePhases.add(phase);
            stopped ||=
              combined.aborted ||
              count > 64 ||
              (error instanceof PlannerError && error.stops);
          }
          additions.push(...candidates);
          if (stage === places.length - 2 && additions.length) {
            completed = [...completed, ...additions.map((c) => c.journey)];
            yield update("searching");
          }
          if (
            stopped ||
            budget.stopped ||
            count >= 64 ||
            (!run && client.retryAt > Date.now() / 1000)
          ) {
            stopped = true;
            break;
          }
        }
        paths = frontier(additions, request);
        if (!paths.length) break;
      }
      if (stopped || combined.aborted || !completed.some((j) => !j.isDirect))
        break;
    }
    signal.throwIfAborted();
    if (stopped || combined.aborted) {
      if (!issues.size)
        issues.add(
          combined.aborted
            ? errorText(combined.reason)
            : "Suche über Zwischenziele unvollständig.",
        );
      incompletePhases.add("via");
    }
    if (!stopped && !combined.aborted && !budget.stopped) {
      activeSection = undefined;
      try {
        for await (const walkingUpdate of optimizeWalking(
          completed,
          fixed,
          settings,
          combined,
          client,
          budget,
        )) {
          completed = walkingUpdate.journeys;
          phase = "walking";
          walkingUpdate.issues.forEach((issue) => issues.add(issue));
          failures.push(...(walkingUpdate.failures ?? []));
          if (walkingUpdate.incomplete) incompletePhases.add("walking");
          yield update("searching");
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!combined.aborted) throw error;
        if (!issues.size) issues.add(errorText(combined.reason));
        incompletePhases.add(phase);
      }
    }
    const journeys = selectJourneys(
      completed,
      request.timing,
      4,
      settings.maxCyclingMinutes,
      settings.showCyclingComparison,
    );
    if (!journeys.length)
      throw new PlannerError(
        retryableFailure || combined.aborted || budget.stopped
          ? "service"
          : "empty",
        [...issues].join(" ") ||
          "Keine vollständige Verbindung über alle Zwischenziele gefunden.",
        false,
        client.retryAt || undefined,
        failures,
      );
    yield update(incompletePhases.size ? "partial" : "complete");
  } finally {
    deadline.dispose();
  }
}
