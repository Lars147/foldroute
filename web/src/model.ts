import {
  type Coordinate, type Place, type RouteRequest, type RouteStop, type Timing,
  sameStation, validStops, validPlaceMetadata,
} from "./place-model";
export * from "./place-model";
export * from "./routing-settings";

export function lateDepartureDelay(
  journey: Journey,
  request?: RouteRequest,
): number | undefined {
  if (!request || request.timing === "arrive") return undefined;
  const delay = journey.departure - request.time;
  return delay >= 3600 ? delay : undefined;
}
export type LegKind =
  "bike" | "walk" | "transit" | "fold" | "unfold" | "wait" | "stop";
export interface Maneuver {
  direction: string;
  streetName: string;
  distance: number;
  coordinates: Coordinate[];
}
export interface TransitReference {
  tripId: string;
  fromId: string;
  toId: string;
  scheduledDeparture: number;
  scheduledArrival: number;
}
export type TransitCancellationReason =
  "trip" | "boarding" | "alighting" | "both-stops";
export interface TransitStatus {
  missingViaStops?: string[];
  updatedAt?: number;
  failure?: "network" | "unavailable";
  cancelled?: boolean;
  cancellationReason?: TransitCancellationReason;
}
export interface TransitStop extends Place {
  arrival?: number;
  departure?: number;
  scheduledArrival?: number;
  scheduledDeparture?: number;
  cancelled?: boolean;
}
export interface Leg {
  /** Requested zero-stay visits inside a single, uninterrupted train ride. */
  viaStops?: { stop: RouteStop; place: TransitStop; occurrence?: number }[];
  /** A provider-validated station connection must not be replaced by cycling. */
  stationTransfer?: boolean;
  navigationId?: string;
  maneuvers?: Maneuver[];
  transitReference?: TransitReference;
  transitStatus?: TransitStatus;
  transitStops?: TransitStop[];
  stop?: RouteStop;
  kind: LegKind;
  from: Place;
  to: Place;
  start: number;
  end: number;
  distance: number;
  coordinates: Coordinate[];
  mode?: string;
  line?: string;
  headsign?: string;
  agency?: string;
  platform?: string;
  arrivalPlatform?: string;
  realtime?: boolean;
  tripId?: string;
  scheduledStart?: number;
  scheduledEnd?: number;
}
export interface Journey {
  id: string;
  origin: Place;
  destination: Place;
  departure: number;
  arrival: number;
  legs: Leg[];
  transfers: number;
  isDirect: boolean;
}
/** Automatic platform transfers, excluding access/egress and explicit visits. */
export function stationTransferWalks(legs: Leg[]): Set<number> {
  const indices = new Set<number>();
  let previous = -1;
  legs.forEach((leg, index) => {
    if (leg.kind !== "transit") return;
    if (
      previous >= 0 &&
      sameStation(legs[previous].to, leg.from) &&
      legs
        .slice(previous + 1, index)
        .every((part) => part.kind === "walk" || part.kind === "wait")
    ) {
      for (let i = previous + 1; i < index; i++)
        if (legs[i].kind === "walk") indices.add(i);
    }
    previous = index;
  });
  return indices;
}
/** User-selected station coordinates are labels, not physical navigation targets. */
export const journeyStart = (journey: Journey): Place =>
  journey.origin.kind === "station"
    ? (journey.legs[0]?.from ?? journey.origin)
    : journey.origin;
export const journeyEnd = (journey: Journey): Place =>
  journey.destination.kind === "station"
    ? (journey.legs.at(-1)?.to ?? journey.destination)
    : journey.destination;
export const legStops = (leg: Leg): RouteStop[] => [
  ...(leg?.stop ? [leg.stop] : []),
  ...(Array.isArray(leg?.viaStops) ? leg.viaStops : []).map(
    (visit) => visit?.stop,
  ),
];
export const journeyStops = (journey: Journey): RouteStop[] =>
  journey.legs.flatMap(legStops);
export const journeyStopPlaces = (journey: Journey): Place[] =>
  journey.legs.flatMap((leg) => [
    ...(leg.stop ? [leg.from] : []),
    ...(leg.viaStops ?? []).map((visit) => visit.place),
  ]);

export type PlanningPhase = "base" | "bike-transfers" | "walking" | "via";
/** Map-only geometry; never a selectable or saved result. */
export interface PlanningRoutePreview {
  legs: Leg[];
  /** Covered request sections, zero-based and end-exclusive. */
  startSection: number;
  endSection: number;
}
export interface PlanningUpdate {
  journeys: Journey[];
  status: "searching" | "complete" | "partial";
  issues: string[];
  failures?: PlanningFailure[];
  phase: PlanningPhase;
  incompletePhases: PlanningPhase[];
  /** Zero-based section in request order; not a completion counter. */
  activeSection?: number;
  routePreview?: PlanningRoutePreview;
}
export const kindNames: Record<LegKind, string> = {
  bike: "Rad",
  walk: "Zu Fuß",
  transit: "ÖPNV",
  fold: "Falten",
  unfold: "Entfalten",
  wait: "Warten",
  stop: "Zwischenziel",
};
export const bikeDistance = (j: Journey) =>
  j.legs.filter((l) => l.kind === "bike").reduce((s, l) => s + l.distance, 0);
export const walkingSeconds = (j: Journey) =>
  j.legs
    .filter((l) => l.kind === "walk")
    .reduce((s, l) => s + l.end - l.start, 0);
export const walkingDistance = (j: Journey) =>
  j.legs.filter((l) => l.kind === "walk").reduce((s, l) => s + l.distance, 0);
export function bikeBoardings(j: Journey): number[] {
  let seen = false,
    rode = false;
  const result: number[] = [];
  j.legs.forEach((l, i) => {
    if (l.kind === "stop") {
      seen = false;
      rode = false;
    } else if (l.kind === "transit") {
      if (seen && rode) result.push(i);
      seen = true;
      rode = false;
    } else if (seen && l.kind === "bike") rode = true;
  });
  return result;
}
export function transition(
  kind: "fold" | "unfold" | "wait",
  place: Place,
  start: number,
  end: number,
): Leg {
  return {
    kind,
    from: place,
    to: place,
    start,
    end,
    coordinates: [place],
    distance: 0,
  };
}
export const shifted = (l: Leg, seconds: number): Leg =>
  l.kind === "bike" || l.kind === "walk"
    ? { ...l, start: l.start + seconds, end: l.end + seconds }
    : l;
export function compare(a: Journey, b: Journey, timing: Timing): number {
  return (
    (timing === "arrive" ? b.departure - a.departure : a.arrival - b.arrival) ||
    a.transfers - b.transfers ||
    walkingSeconds(a) - walkingSeconds(b) ||
    a.legs.filter((l) => l.kind === "bike").length -
      b.legs.filter((l) => l.kind === "bike").length ||
    bikeDistance(a) - bikeDistance(b) ||
    walkingDistance(a) - walkingDistance(b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
export function worthwhile(
  j: Journey,
  direct: Journey | undefined,
  timing: Timing,
): boolean {
  if (j.isDirect || !direct) return true;
  const saving =
    timing === "arrive"
      ? j.departure - direct.departure
      : direct.arrival - j.arrival;
  const distance = bikeDistance(direct) - bikeDistance(j);
  return (
    saving >= 180 ||
    (saving >= -600 &&
      distance >= 1000 &&
      distance >= bikeDistance(direct) * 0.2)
  );
}
const pointKey = (p: Coordinate) => `${p.latitude},${p.longitude}`;
export function connectionKey(j: Journey): string {
  if (j.isDirect) return `direct|${j.id}`;
  const legs = j.legs.filter((l) => l.kind === "transit");
  return legs.length
    ? legs
        .map((l) =>
          l.tripId && l.scheduledStart != null
            ? `trip|${l.tripId}|${Math.floor(l.scheduledStart / 86400)}`
            : `fallback|${l.mode}|${l.line}|${pointKey(l.from)}|${pointKey(l.to)}|${l.start}|${l.end}`,
        )
        .join(";")
    : j.id;
}
function signature(j: Journey): string {
  const links = bikeBoardings(j).map((i) => {
    let p = i - 1;
    while (p >= 0 && j.legs[p].kind !== "transit") p--;
    return j.legs
      .slice(p + 1, i)
      .filter((l) => l.kind === "bike")
      .map((l) => [pointKey(l.from), pointKey(l.to)]);
  });
  return JSON.stringify([
    j.isDirect,
    j.legs
      .filter((l) => l.kind === "transit")
      .map((l) => [l.mode, l.line, l.headsign, l.from.name, l.to.name]),
    links,
  ]);
}
export function cyclingExcess(journey: Journey, limitMinutes: number): number {
  if (!journey.isDirect) return 0;
  let seconds = 0,
    current = 0;
  for (const leg of journey.legs) {
    if (leg.kind === "stop") {
      seconds = Math.max(seconds, current);
      current = 0;
    } else if (leg.kind === "bike") current += leg.end - leg.start;
  }
  seconds = Math.max(seconds, current);
  return Math.max(0, seconds - limitMinutes * 60);
}
export function sectionCyclingExcess(
  journey: Journey,
  limitMinutes: number,
): number {
  if (journey.isDirect) return cyclingExcess(journey, limitMinutes);
  return Math.max(
    0,
    ...journey.legs
      .filter((l) => l.kind === "bike")
      .map((l) => l.end - l.start - limitMinutes * 60),
  );
}
export function cyclingComparisonLabel(
  journey: Journey,
  limitMinutes: number,
): string {
  const excess = cyclingExcess(journey, limitMinutes);
  return excess > 0
    ? `${Math.ceil((excess + limitMinutes * 60) / 60)} Min. ${journey.legs.some((l) => l.kind === "stop") ? "längste Radetappe" : "Radfahrt"} · ${Math.ceil(excess / 60)} Min. über deinem Radlimit`
    : "";
}
export function selectJourneys(
  journeys: Journey[],
  timing: Timing,
  maximum = 4,
  cyclingLimit = Infinity,
  showCyclingComparison = true,
): Journey[] {
  if (maximum <= 0) return [];
  const sorted = [...journeys].sort((a, b) => compare(a, b, timing));
  const comparison = sorted.find((j) => cyclingExcess(j, cyclingLimit) > 0);
  if (comparison) {
    const suitable = selectJourneys(
      sorted.filter((j) => cyclingExcess(j, cyclingLimit) === 0),
      timing,
      Math.min(
        3,
        maximum === 1 || !showCyclingComparison ? maximum : maximum - 1,
      ),
    );
    return !showCyclingComparison || (maximum === 1 && suitable.length)
      ? suitable
      : [...suitable, comparison];
  }
  maximum = Math.min(3, maximum);
  const direct = sorted.find((j) => j.isDirect);
  const worth = sorted.filter((j) => worthwhile(j, direct, timing));
  const transit = worth.find((j) => !j.isDirect);
  const seen = new Set<string>();
  const ranked = worth.filter((j) => {
    if (j.isDirect && transit) {
      const disadvantage =
        timing === "arrive"
          ? transit.departure - j.departure
          : j.arrival - transit.arrival;
      if (
        disadvantage >
        Math.max(600, (transit.arrival - transit.departure) * 0.2)
      )
        return false;
    }
    const key = connectionKey(j);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const signatures = new Set<string>();
  const indices: number[] = [];
  for (let i = 0; i < ranked.length && indices.length < maximum; i++) {
    const key = signature(ranked[i]);
    if (!signatures.has(key)) {
      indices.push(i);
      signatures.add(key);
    }
  }
  for (let i = 0; i < ranked.length && indices.length < maximum; i++)
    if (!indices.includes(i)) indices.push(i);
  return indices.map((i) => ranked[i]);
}
export function retainSelectedJourney(
  journeys: Journey[],
  selected: Journey,
  cyclingLimit: number,
  showComparison: boolean,
): Journey[] {
  if (journeys.some((j) => j.id === selected.id)) return journeys;
  const regular = journeys.filter((j) => cyclingExcess(j, cyclingLimit) === 0);
  const comparison = showComparison
    ? journeys.find((j) => cyclingExcess(j, cyclingLimit) > 0)
    : undefined;
  if (cyclingExcess(selected, cyclingLimit) > 0)
    return showComparison
      ? [...regular.slice(0, 3), selected]
      : regular.slice(0, 3);
  return [selected, ...regular]
    .slice(0, 3)
    .concat(comparison ? [comparison] : []);
}

/** Movement effort excludes folding, waiting and time spent at intermediate stops. */
export function journeyEffort(journey: Journey) {
  let cyclingSeconds = 0;
  let walkingSeconds = 0;
  for (const leg of journey.legs) {
    if (leg.kind === "bike") cyclingSeconds += leg.end - leg.start;
    if (leg.kind === "walk") walkingSeconds += leg.end - leg.start;
  }
  return { cyclingSeconds, walkingSeconds, transfers: journey.transfers };
}
export interface PlanningFailure {
  code: string;
  message: string;
  retryAt?: number;
  requestKey?: string;
}
export function planningFailures(error: unknown): PlanningFailure[] {
  return error instanceof PlannerError
    ? (error.failures ?? [
        { code: error.code, message: error.message, retryAt: error.retryAt },
      ])
    : [];
}
export function rateLimitMessage(failures: PlanningFailure[] = []) {
  if (failures.some((failure) => failure.code === "503")) return;
  if (failures.some((failure) => failure.code === "429"))
    return "Anfragelimit erreicht";
}
export function serviceFailureMessage(failures: PlanningFailure[] = []) {
  return failures.some((failure) => failure.code === "503")
    ? "Routingdienst vorübergehend nicht verfügbar."
    : rateLimitMessage(failures);
}
export class PlannerError extends Error {
  constructor(
    public code: string,
    message: string,
    public stops = false,
    public retryAt?: number,
    public failures?: PlanningFailure[],
  ) {
    super(message);
  }
}
export const geometryError = () =>
  new PlannerError(
    "geometry",
    "Einige Verbindungen enthalten keine gültigen Streckendaten.",
  );
export const responseError = () =>
  new PlannerError(
    "response",
    "Die Antwort des Routingdienstes ist unvollständig oder ungültig.",
  );
export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Die Suche konnte nicht abgeschlossen werden.";
}

export function journeyOutline(journey: Journey): string {
  return journey.legs
    .filter((leg) => !["fold", "unfold", "wait"].includes(leg.kind))
    .map((leg) =>
      leg.kind === "transit"
        ? leg.line || "ÖPNV"
        : leg.kind === "stop"
          ? `Stopp: ${leg.from.name}`
          : kindNames[leg.kind],
    )
    .join(" → ");
}

/** Optional navigation metadata keeps older route snapshots readable. */
export function validNavigationLegData(value: Leg): boolean {
  const point = (p: Coordinate) =>
    p &&
    Number.isFinite(p.latitude) &&
    Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.longitude) <= 180;
  const reference = value.transitReference,
    status = value.transitStatus;
  return (
    (value.stationTransfer === undefined ||
      typeof value.stationTransfer === "boolean") &&
    (value.viaStops === undefined ||
      (value.kind === "transit" &&
        Array.isArray(value.viaStops) &&
        value.viaStops.length > 0 &&
        validStops(value.viaStops.map((visit) => visit?.stop)) &&
        value.viaStops.every(
          (visit) =>
            visit.stop.stayMinutes === 0 &&
            visit.stop.place.kind === "station" &&
            point(visit.place) &&
            validPlaceMetadata(visit.place) &&
            (visit.occurrence === undefined ||
              (Number.isInteger(visit.occurrence) && visit.occurrence >= 0)) &&
            [
              visit.place.scheduledArrival,
              visit.place.scheduledDeparture,
            ].every((time) => time === undefined || Number.isFinite(time)),
        ))) &&
    (value.transitStops === undefined ||
      (Array.isArray(value.transitStops) &&
        value.transitStops.length >= 2 &&
        value.transitStops.every(
          (stop) =>
            point(stop) &&
            typeof stop.name === "string" &&
            stop.name.length > 0 &&
            typeof stop.detail === "string" &&
            (stop.stopId === undefined || typeof stop.stopId === "string") &&
            [
              stop.arrival,
              stop.departure,
              stop.scheduledArrival,
              stop.scheduledDeparture,
            ].every((time) => time === undefined || Number.isFinite(time)) &&
            (stop.cancelled === undefined ||
              typeof stop.cancelled === "boolean"),
        ))) &&
    [value.scheduledStart, value.scheduledEnd].every(
      (time) => time === undefined || Number.isFinite(time),
    ) &&
    (value.navigationId === undefined ||
      (typeof value.navigationId === "string" &&
        value.navigationId.length > 0)) &&
    (value.maneuvers === undefined ||
      (Array.isArray(value.maneuvers) &&
        value.maneuvers.every(
          (m) =>
            m &&
            typeof m.direction === "string" &&
            typeof m.streetName === "string" &&
            Number.isFinite(m.distance) &&
            m.distance >= 0 &&
            Array.isArray(m.coordinates) &&
            m.coordinates.length > 0 &&
            m.coordinates.every(point),
        ))) &&
    (reference === undefined ||
      (!!reference &&
        [reference.tripId, reference.fromId, reference.toId].every(
          (s) => typeof s === "string" && s.length > 0,
        ) &&
        Number.isFinite(reference.scheduledDeparture) &&
        Number.isFinite(reference.scheduledArrival) &&
        reference.scheduledArrival >= reference.scheduledDeparture)) &&
    (status === undefined ||
      (!!status &&
        (status.missingViaStops === undefined ||
          (Array.isArray(status.missingViaStops) &&
            status.missingViaStops.every(
              (id) =>
                typeof id === "string" &&
                value.viaStops?.some((visit) => visit.stop.id === id),
            ))) &&
        (status.updatedAt === undefined || Number.isFinite(status.updatedAt)) &&
        (status.cancelled === undefined ||
          typeof status.cancelled === "boolean") &&
        (status.cancellationReason === undefined ||
          ["trip", "boarding", "alighting", "both-stops"].includes(
            status.cancellationReason,
          )) &&
        (status.failure === undefined ||
          ["network", "unavailable"].includes(status.failure))))
  );
}
