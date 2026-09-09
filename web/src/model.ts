export interface Coordinate {
  latitude: number;
  longitude: number;
}
export interface Place extends Coordinate {
  name: string;
  detail: string;
  stopId?: string;
}
export type Timing = "now" | "depart" | "arrive";
export interface RouteStop {
  id: string;
  place: Place;
  stayMinutes: number;
}
export function validStops(value: unknown): value is RouteStop[] {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    new Set(value.map((s) => s?.id)).size === value.length &&
    value.every(
      (s) =>
        s &&
        typeof s.id === "string" &&
        s.id.length > 0 &&
        s.id.length <= 100 &&
        s.place &&
        typeof s.place.name === "string" &&
        s.place.name.length <= 500 &&
        typeof s.place.detail === "string" &&
        Number.isFinite(s.place.latitude) &&
        Math.abs(s.place.latitude) <= 90 &&
        Number.isFinite(s.place.longitude) &&
        Math.abs(s.place.longitude) <= 180 &&
        Number.isInteger(s.stayMinutes) &&
        s.stayMinutes >= 0 &&
        s.stayMinutes <= 1440,
    )
  );
}
export interface RouteRequest {
  stops?: RouteStop[];
  origin: Place;
  destination: Place;
  timing: Timing;
  time: number;
}
export const modes = {
  suburbanRail: { name: "S-Bahn", values: ["SUBURBAN"] },
  subway: { name: "U-Bahn", values: ["SUBWAY"] },
  tram: { name: "Tram", values: ["TRAM"] },
  bus: { name: "Bus", values: ["BUS", "COACH"] },
  regionalRail: { name: "Regionalzüge", values: ["REGIONAL_RAIL"] },
  longDistanceRail: {
    name: "Fernzüge",
    values: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"],
  },
};
export type ModePreference = keyof typeof modes;
export interface RoutingSettings {
  showCyclingComparison: boolean;
  foldingDuration: number;
  cyclingSpeedKilometersPerHour: number;
  maxCyclingMinutes: number;
  maxWalkingMinutes: number;
  maxBikeTransfers: number;
  excludedTransitModes: ModePreference[];
}
export const defaults: RoutingSettings = {
  showCyclingComparison: true,
  foldingDuration: 180,
  cyclingSpeedKilometersPerHour: 15,
  maxCyclingMinutes: 30,
  maxWalkingMinutes: 2,
  maxBikeTransfers: 2,
  excludedTransitModes: [],
};
export const ranges = {
  cyclingSpeedKilometersPerHour: [10, 30, 1],
  maxCyclingMinutes: [1, 60, 1],
  maxWalkingMinutes: [1, 15, 1],
  foldingDuration: [60, 600, 30],
  maxBikeTransfers: [0, 3, 1],
} as const;
export function validSettings(value: unknown): value is RoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as RoutingSettings;
  return (
    typeof v.showCyclingComparison === "boolean" &&
    Object.entries(ranges).every(([key, [min, max, step]]) => {
      const n = v[key as keyof typeof ranges];
      return (
        Number.isFinite(n) &&
        n >= min &&
        n <= max &&
        Math.abs((n - min) / step - Math.round((n - min) / step)) < 1e-6
      );
    }) &&
    Array.isArray(v.excludedTransitModes) &&
    new Set(v.excludedTransitModes).size === v.excludedTransitModes.length &&
    v.excludedTransitModes.every((m) => Object.hasOwn(modes, m))
  );
}
export type StoredRoutingSettings = Omit<
  RoutingSettings,
  "showCyclingComparison"
> & { showCyclingComparison?: boolean };
export function validStoredSettings(
  value: unknown,
): value is StoredRoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as StoredRoutingSettings;
  return (
    (v.showCyclingComparison === undefined ||
      typeof v.showCyclingComparison === "boolean") &&
    validSettings({
      ...v,
      showCyclingComparison: v.showCyclingComparison ?? true,
    })
  );
}
export type LegacyRoutingSettings = Omit<
  StoredRoutingSettings,
  "foldingDuration"
> & {
  foldDuration: number;
  unfoldDuration: number;
};
export function validLegacySettings(
  value: unknown,
): value is LegacyRoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as LegacyRoutingSettings;
  return (
    [v.foldDuration, v.unfoldDuration].every(
      (n, i) =>
        Number.isFinite(n) &&
        n >= (i === 0 ? 60 : 30) &&
        n <= 600 &&
        n % 30 === 0,
    ) && validStoredSettings({ ...v, foldingDuration: 180 })
  );
}
export function migrateSettings(value: unknown): RoutingSettings | undefined {
  if (validStoredSettings(value))
    return {
      ...value,
      showCyclingComparison: value.showCyclingComparison ?? true,
    };
  if (!validLegacySettings(value)) return undefined;
  const { foldDuration, unfoldDuration, ...rest } = value;
  return {
    ...rest,
    showCyclingComparison: rest.showCyclingComparison ?? true,
    foldingDuration: Math.max(60, foldDuration, unfoldDuration),
  };
}
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
export interface Leg {
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
export interface PlanningUpdate {
  journeys: Journey[];
  status: "searching" | "complete" | "partial";
  issues: string[];
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
export const kindColors: Record<LegKind, string> = {
  bike: "#168d97",
  walk: "#57695a",
  transit: "#7667e8",
  fold: "#ffd43b",
  unfold: "#ffd43b",
  wait: "#697077",
  stop: "#ffd43b",
};
export const bikeDistance = (j: Journey) =>
  j.legs.filter((l) => l.kind === "bike").reduce((s, l) => s + l.distance, 0);
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
export class PlannerError extends Error {
  constructor(
    public code: string,
    message: string,
    public stops = false,
    public retryAt?: number,
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
