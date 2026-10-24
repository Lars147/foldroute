import {
  PlannerError,
  stationId,
  transition,
  type Journey,
  type Leg,
  type Place,
  type RouteStop,
  type RoutingSettings,
} from "./model";
import { distance } from "./geometry";
import type { Batch, RequestBudget, RoutingClient } from "./transitous";

const exactStation = (place: Place): Place => ({
  ...place,
  kind: "station",
  stationId: place.stopId,
});
const samePosition = (a: Place, b: Place) =>
  distance(a, b) <= 1 &&
  a.level === b.level &&
  (a.stopId === b.stopId || (!a.stopId && !b.stopId));
const point = (place: Place): Place => ({
  ...place,
  kind: "point",
  stationId: undefined,
  stopId: undefined,
});
const matches = (a: Leg, b: Leg) =>
  !!a.tripId &&
  a.tripId === b.tripId &&
  a.from.stopId === b.from.stopId &&
  a.to.stopId === b.to.stopId &&
  a.start === b.start &&
  a.end === b.end &&
  a.scheduledStart === b.scheduledStart &&
  a.scheduledEnd === b.scheduledEnd;

function checkBatch(
  batch: Batch,
  client: RoutingClient,
  budget: RequestBudget,
) {
  if (batch.stop) budget.stopped = true;
  if (batch.stop || batch.rejected || batch.issues.length)
    throw new PlannerError(
      "service",
      batch.issues.join(" ") ||
        "Bahnhofsumstieg konnte nicht vollständig geprüft werden.",
      false,
      client.retryAt,
      batch.failures,
    );
}

/** Insert the requested stay into a real, stationary gap, never over a walk. */
function withStay(legs: Leg[], stop: RouteStop): Leg[] | undefined {
  for (let i = 0; i < legs.length - 1; i++) {
    const before = legs[i],
      after = legs[i + 1];
    if (
      after.start - before.end < stop.stayMinutes * 60 ||
      !samePosition(before.to, after.from)
    )
      continue;
    return [
      ...legs.slice(0, i + 1),
      {
        ...transition("wait", before.to, before.end, after.start),
        kind: "stop",
        stop,
      },
      ...legs.slice(i + 1),
    ];
  }
}

/** A shared parent ID is not evidence that a platform transfer is possible. */
export async function joinAtStation(
  first: Journey,
  last: Journey,
  stop: RouteStop,
  settings: RoutingSettings,
  client: RoutingClient,
  signal: AbortSignal,
  budget: RequestBudget,
  backward = false,
  attempt = 0,
): Promise<Journey | undefined> {
  const left = first.legs.at(-1)!,
    right = last.legs[0];
  const id = stationId(stop.place);
  if (!id || !left || !right) return;
  let legs: Leg[] | undefined;
  let extraTransfers = 0;
  if (left.kind === "transit" && right.kind === "transit") {
    if (!left.from.stopId || !right.to.stopId) return;
    const batch = await client.batch(
      {
        origin: exactStation(left.from),
        destination: exactStation(right.to),
        timing: "depart",
        time: left.start,
        bikeFolded: true,
      },
      settings,
      {
        pre: "WALK",
        post: "WALK",
        native: true,
        via: { id, stayMinutes: stop.stayMinutes },
      },
      signal,
      budget,
    );
    checkBatch(batch, client, budget);
    for (const candidate of batch.journeys) {
      const transit = candidate.legs.filter((leg) => leg.kind === "transit");
      if (
        transit.length === 2 &&
        matches(left, transit[0]) &&
        matches(right, transit[1]) &&
        candidate.legs[0] === transit[0] &&
        candidate.legs.at(-1) === transit[1]
      ) {
        legs = withStay(
          candidate.legs.map((leg) => ({
            ...leg,
            stationTransfer: leg.kind !== "transit" || undefined,
            ...(leg === transit[0]
              ? { viaStops: left.viaStops }
              : leg === transit[1]
                ? { viaStops: right.viaStops }
                : {}),
          })),
          stop,
        );
        extraTransfers = candidate.transfers;
      } else if (
        transit.length === 1 &&
        stop.stayMinutes === 0 &&
        left.tripId &&
        left.tripId === right.tripId
      ) {
        const through = transit[0];
        const visit = through.transitStops?.find(
          (visit) =>
            visit.stopId === left.to.stopId &&
            visit.stopId === right.from.stopId &&
            (visit.arrival ?? visit.scheduledArrival) === left.end &&
            (visit.departure ?? visit.scheduledDeparture) === right.start,
        );
        if (
          visit &&
          through.tripId === left.tripId &&
          through.from.stopId === left.from.stopId &&
          through.to.stopId === right.to.stopId &&
          through.start === left.start &&
          through.end === right.end &&
          through.scheduledStart === left.scheduledStart &&
          through.scheduledEnd === right.scheduledEnd
        ) {
          legs = [
            {
              ...through,
              viaStops: [
                ...(left.viaStops ?? []),
                {
                  stop,
                  place: visit,
                  occurrence: through
                    .transitStops!.slice(
                      0,
                      through.transitStops!.indexOf(visit),
                    )
                    .filter(
                      (prior) =>
                        prior.stopId === visit.stopId ||
                        (!!prior.parentId && prior.parentId === visit.parentId),
                    ).length,
                },
                ...(right.viaStops ?? []),
              ],
            },
          ];
        }
      }
      if (legs) break;
    }
    if (!legs) return;
    legs = [...first.legs.slice(0, -1), ...legs, ...last.legs.slice(1)];
  } else {
    const connector: Leg[] = [];
    let time = left.end + stop.stayMinutes * 60;
    if (!samePosition(left.to, right.from)) {
      const batch = await client.batch(
        {
          origin: point(left.to),
          destination: point(right.from),
          timing: "depart",
          time,
        },
        settings,
        { direct: true, directMode: "WALK", pre: "WALK", post: "WALK" },
        signal,
        budget,
      );
      checkBatch(batch, client, budget);
      const walk = batch.journeys.find(
        (journey) =>
          journey.legs.every((leg) => leg.kind === "walk") &&
          journey.departure >= time &&
          distance(journey.legs[0].from, left.to) <= 1 &&
          distance(journey.legs.at(-1)!.to, right.from) <= 1,
      );
      if (!walk) return;
      connector.push(
        ...walk.legs.map((leg) => ({ ...leg, stationTransfer: true })),
      );
      time = walk.arrival;
    }
    const beforeBike = [...first.legs]
      .reverse()
      .find((leg) => ["transit", "bike", "fold", "unfold"].includes(leg.kind));
    const folded =
      beforeBike?.kind === "transit" || beforeBike?.kind === "fold";
    const nextMode = last.legs.find((leg) =>
      ["transit", "bike", "fold", "unfold"].includes(leg.kind),
    );
    const action =
      folded && nextMode?.kind === "bike"
        ? "unfold"
        : !folded && nextMode?.kind === "transit"
          ? "fold"
          : undefined;
    if (action) {
      connector.push(
        transition(action, right.from, time, time + settings.foldingDuration),
      );
      time += settings.foldingDuration;
    }
    if (time > right.start) {
      if (attempt >= 2) return;
      // Search the movable section again; a later bicycle start must not erase
      // an otherwise valid train arrival, and an arrive-by search works backwards.
      const section = backward ? first : last;
      const delta = time - right.start;
      const transitIndex = section.legs.findIndex(
        (leg) => leg.kind === "transit",
      );
      const lastTransit = section.legs.findLastIndex(
        (leg) => leg.kind === "transit",
      );
      const batch = await client.batch(
        {
          origin: section.origin,
          destination: section.destination,
          timing: backward ? "arrive" : "depart",
          time: backward ? first.arrival - delta : time,
          bikeFolded:
            section.origin.kind === "station" &&
            (backward
              ? !section.legs.some((leg) => leg.kind === "fold")
              : true),
        },
        settings,
        {
          direct: section.isDirect,
          pre: section.legs
            .slice(0, transitIndex)
            .some((leg) => leg.kind === "bike")
            ? "BIKE"
            : "WALK",
          post: section.legs
            .slice(lastTransit + 1)
            .some((leg) => leg.kind === "bike")
            ? "BIKE"
            : "WALK",
        },
        signal,
        budget,
      );
      checkBatch(batch, client, budget);
      for (const replacement of batch.journeys) {
        const joined = await joinAtStation(
          backward ? replacement : first,
          backward ? last : replacement,
          stop,
          settings,
          client,
          signal,
          budget,
          backward,
          attempt + 1,
        );
        if (joined) return joined;
      }
      return;
    }
    const stay: Leg = {
      ...transition(
        "wait",
        left.to,
        left.end,
        left.end + stop.stayMinutes * 60,
      ),
      kind: "stop",
      stop,
    };
    legs = [
      ...first.legs,
      stay,
      ...connector,
      ...(time < right.start
        ? [transition("wait", right.from, time, right.start)]
        : []),
      ...last.legs,
    ];
  }
  if (
    legs.some(
      (leg, index) =>
        index > 0 &&
        (legs![index - 1].end > leg.start ||
          distance(legs![index - 1].to, leg.from) > 1),
    )
  )
    return;
  return {
    id: `via|${first.id}|${stop.id}|${stop.stayMinutes}|${last.id}`,
    origin: first.origin,
    destination: last.destination,
    departure: legs[0].start,
    arrival: legs.at(-1)!.end,
    legs,
    transfers: first.transfers + last.transfers + extraTransfers,
    isDirect: first.isDirect && last.isDirect,
  };
}
