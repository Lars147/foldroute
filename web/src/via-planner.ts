import {
  type Journey,
  type RouteRequest,
  type RouteStop,
  type RoutingSettings,
  type PlanningUpdate,
  compare,
  connectionKey,
  sectionCyclingExcess,
  bikeBoardings,
  selectJourneys,
  PlannerError,
  errorText,
} from "./model";
import { distance } from "./geometry";
import { ApiClient, type RequestBudget } from "./transitous";
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
  client: ApiClient,
): AsyncGenerator<PlanningUpdate> {
  const stops = request.stops!;
  const places = [
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
    time: request.timing === "now" ? Date.now() / 1000 : request.time,
  };
  if (
    !Number.isFinite(fixed.time) ||
    (request.timing !== "now" && fixed.time < Date.now() / 1000)
  )
    throw new PlannerError(
      "input",
      "Bitte einen aktuellen oder zukünftigen Zeitpunkt auswählen.",
    );
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new PlannerError(
          "deadline",
          "Die Suche mit Zwischenzielen hat das Zeitlimit erreicht.",
          true,
        ),
      ),
    60000,
  );
  const combined = AbortSignal.any([signal, deadline.signal]);
  let count = 0;
  const budget: RequestBudget = {
    take() {
      if (++count > 64)
        throw new PlannerError(
          "budget",
          "Die Suche mit Zwischenzielen hat das Anfragelimit erreicht.",
          true,
        );
    },
  };
  const issues = new Set<string>();
  let completed: Journey[] = [],
    stopped = false;
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
            destination: places[index + 1],
            timing: backward ? "arrive" : "depart",
            time,
          };
          let latest: Journey[] = [];
          try {
            for await (const update of planRoutes(
              part,
              settings,
              combined,
              client,
              { raw: true, baseOnly, budget },
            )) {
              latest = update.journeys;
              update.issues.forEach((issue) => issues.add(issue));
            }
          } catch (error) {
            signal.throwIfAborted();
            issues.add(
              `Teilstrecke ${index + 1} (${places[index].name} → ${places[index + 1].name}): ${errorText(error)}`,
            );
            stopped ||=
              combined.aborted ||
              count > 64 ||
              (error instanceof PlannerError && error.stops);
          }
          for (const child of latest) {
            const journey = path
              ? backward
                ? joinAtStop(child, path.journey, boundary!)
                : joinAtStop(path.journey, child, boundary!)
              : child;
            const overLimit =
              !!path?.overLimit ||
              sectionCyclingExcess(child, settings.maxCyclingMinutes) > 0;
            if (
              !journey ||
              (overLimit && !journey.isDirect) ||
              bikeBoardings(journey).length > settings.maxBikeTransfers
            )
              continue;
            additions.push({ journey, overLimit });
          }
          if (stage === places.length - 2 && additions.length) {
            completed = [...completed, ...additions.map((c) => c.journey)];
            const journeys = selectJourneys(
              completed,
              request.timing,
              4,
              settings.maxCyclingMinutes,
              settings.showCyclingComparison,
            );
            if (journeys.length)
              yield { journeys, status: "searching", issues: [...issues] };
          }
          if (
            stopped ||
            budget.stopped ||
            count >= 64 ||
            client.retryAt > Date.now() / 1000
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
    if (stopped)
      issues.add("Die Suche mit Zwischenzielen wurde vorzeitig beendet.");
    const journeys = selectJourneys(
      completed,
      request.timing,
      4,
      settings.maxCyclingMinutes,
      settings.showCyclingComparison,
    );
    if (!journeys.length)
      throw new PlannerError(
        "empty",
        [...issues].join(" ") ||
          "Keine vollständige Verbindung über alle Zwischenziele gefunden.",
      );
    yield {
      journeys,
      status: issues.size ? "partial" : "complete",
      issues: [...issues],
    };
  } finally {
    clearTimeout(timer);
  }
}
