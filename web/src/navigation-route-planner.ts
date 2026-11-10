import {
  type Journey,
  type Place,
  type RouteRequest,
  type RoutingSettings,
  journeyStops,
  transition,
} from "./model";
import { movement, freshTransit, navigationJourney } from "./navigation-engine";
import { transitDisruption, applyTransit } from "./transit-refresh";
import { validateNavigationGeometry } from "./navigation-store";
import { planRoutes } from "./planner";
import type { RoutingClient } from "./routing-contracts";

export function reachableAlternative(
  journey: Journey,
  index: number,
  now: number,
  onboard = false,
) {
  const leg = journey.legs[index];
  return (
    !transitDisruption(
      journey,
      index,
      now,
      movement(leg) ? leg.end - leg.start : undefined,
    ) && !(!onboard && index === 0 && leg.kind === "transit" && leg.start < now)
  );
}

/** Only an immediate boarding can invalidate the current street destination. */
export function unavailableBoarding(
  journey: Journey,
  index: number,
  now: number,
) {
  for (const leg of journey.legs.slice(index + 1)) {
    if (movement(leg) || leg.kind === "stop") return false;
    if (leg.kind === "transit")
      return (
        !!leg.transitStatus?.cancelled ||
        (freshTransit(leg, now) && leg.start < now)
      );
  }
  return false;
}

export interface NavigationRoutePlannerDependencies {
  api: RoutingClient;
  plan?: (
    request: RouteRequest,
    settings: RoutingSettings,
    signal: AbortSignal,
  ) => Promise<Journey>;
  now?: () => number;
  online?: () => boolean;
}

/** Routing policy returns proposals; only the session may accept them. */
export class NavigationRoutePlanner {
  private readonly now: () => number;
  private readonly online: () => boolean;

  constructor(
    private readonly dependencies: NavigationRoutePlannerDependencies,
  ) {
    this.now = dependencies.now ?? (() => Date.now() / 1000);
    this.online = dependencies.online ?? (() => navigator.onLine);
  }

  async planAlternatives(
    request: RouteRequest,
    settings: RoutingSettings,
    signal: AbortSignal,
    acceptable: (journey: Journey) => boolean = (journey) =>
      reachableAlternative(journey, 0, Math.max(request.time, this.now())),
  ): Promise<{ journeys: Journey[]; settings: RoutingSettings }> {
    if (!this.online())
      throw new Error(
        "Neue Routen benötigen Internet. Die bisherige Route bleibt verfügbar.",
      );
    const now = this.now();
    // Generated navigation departures catch up after slow location/trip lookups.
    if (
      request.timing === "now" ||
      (request.timing === "depart" && request.time <= now)
    )
      request = { ...request, timing: "now", time: now };
    let candidates: Journey[] = [];
    if (this.dependencies.plan)
      candidates = [await this.dependencies.plan(request, settings, signal)];
    else
      for await (const update of planRoutes(
        request,
        settings,
        signal,
        this.dependencies.api,
      ))
        if (update.journeys.length) candidates = update.journeys;
    signal.throwIfAborted();
    const journeys = candidates.filter(acceptable);
    if (!journeys.length)
      throw new Error(
        "Keine aktuell erreichbare Verbindung gefunden. Bitte erneut suchen.",
      );
    return { journeys, settings };
  }
  async plan(
    request: RouteRequest,
    settings: RoutingSettings,
    signal: AbortSignal,
    acceptable?: (journey: Journey) => boolean,
  ): Promise<{ journey: Journey; settings: RoutingSettings }> {
    const result = await this.planAlternatives(
      request,
      settings,
      signal,
      acceptable,
    );
    return { journey: result.journeys[0], settings: result.settings };
  }
}

/** Street-only proposal preserves every existing transit leg and its identity. */
export function composeStreetRepair(
  current: Journey,
  index: number,
  replacement: Journey,
  retainElevator: boolean,
): Journey {
  return applyTransit(
    {
      ...current,
      legs: [
        ...current.legs.slice(0, index),
        ...replacement.legs.map((part) => ({
          ...part,
          navigationId: crypto.randomUUID(),
        })),
        ...(retainElevator ? [current.legs[index]] : []),
        ...current.legs.slice(index + 1),
      ],
    },
    index,
    new Map(),
  );
}

export interface AlternativeComposition {
  current: Journey;
  legIndex: number;
  route: Journey;
  onboard: boolean;
  reason?: "reroute" | "stop";
  origin: Place;
  departure: number;
  foldingDuration: number;
  now: number;
}

/** Compose a replacement itinerary without changing the active journey. */
export function composeAlternative(input: AlternativeComposition): Journey {
  const {
    current,
    legIndex,
    route,
    onboard,
    reason,
    origin,
    departure,
    foldingDuration,
    now,
  } = input;
  const leg = current.legs[legIndex];
  const prefix = onboard
    ? [
        ...current.legs.slice(0, legIndex + 1),
        transition("unfold", origin, departure - foldingDuration, departure),
      ]
    : reason === "stop" && leg.end > now
      ? [transition("wait", leg.to, now, leg.end)]
      : [];
  // Outstanding visits belong to the replacement itinerary, not to both
  // the failed train prefix and the new route.
  const reassigned = new Set(journeyStops(route).map((stop) => stop.id));
  for (let i = 0; i < prefix.length; i++) {
    const part = prefix[i];
    if (!part.viaStops?.some((visit) => reassigned.has(visit.stop.id)))
      continue;
    const viaStops = part.viaStops.filter(
      (visit) => !reassigned.has(visit.stop.id),
    );
    prefix[i] = {
      ...part,
      viaStops: viaStops.length ? viaStops : undefined,
      transitStatus: {
        ...part.transitStatus,
        missingViaStops: part.transitStatus?.missingViaStops?.filter(
          (id) => !reassigned.has(id),
        ),
      },
    };
  }
  const proposed = navigationJourney(
    prefix.length
      ? {
          ...route,
          origin: onboard ? current.origin : prefix[0].from,
          departure: onboard ? current.departure : prefix[0].start,
          legs: [...prefix, ...route.legs],
        }
      : route,
  );
  validateNavigationGeometry(proposed);

  return proposed;
}
