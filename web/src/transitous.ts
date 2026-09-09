import {
  type Place,
  type Leg,
  type Journey,
  type RouteRequest,
  type RoutingSettings,
  type Coordinate,
  modes,
  transition,
  shifted,
  PlannerError,
  geometryError,
  responseError,
} from "./model";
import { decodePolyline, validateGeometry, validCoordinate } from "./geometry";
export const service = {
  api: "https://api.transitous.org/api",
  tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
};
export type StreetMode = "BIKE" | "WALK";
export interface Variant {
  direct?: boolean;
  pre: StreetMode;
  post: StreetMode;
  preLimit?: number;
  postLimit?: number;
}
export const baseVariants: Variant[] = [
  { direct: true, pre: "BIKE", post: "BIKE" },
  { pre: "WALK", post: "WALK" },
  { pre: "BIKE", post: "BIKE" },
  { pre: "WALK", post: "BIKE" },
  { pre: "BIKE", post: "WALK" },
];
export function makeURL(
  request: RouteRequest,
  settings: RoutingSettings,
  variant: Variant,
): URL {
  const url = new URL(`${service.api}/v6/plan`);
  const coord = (p: Coordinate) =>
    `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  const time =
    request.time +
    (variant.direct
      ? 0
      : request.timing === "arrive"
        ? -settings.foldingDuration
        : settings.foldingDuration);
  const values: Record<string, string> = {
    fromPlace: coord(request.origin),
    toPlace: coord(request.destination),
    time: new Date(time * 1000).toISOString().replace(".000Z", "Z"),
    arriveBy: String(request.timing === "arrive"),
    cyclingSpeed: (settings.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
    detailedLegs: "true",
    realtimeMode: "REALTIME",
    language: "de",
  };
  if (variant.direct)
    Object.assign(values, {
      transitModes: "",
      directModes: "BIKE",
      maxDirectTime: "21600",
    });
  else
    Object.assign(values, {
      transitModes: Object.entries(modes)
        .filter(
          ([key]) =>
            !settings.excludedTransitModes.includes(key as keyof typeof modes),
        )
        .flatMap(([, m]) => m.values)
        .join(","),
      directModes: "",
      preTransitModes: variant.pre,
      postTransitModes: variant.post,
      additionalTransferTime: "3",
      maxPreTransitTime: String(
        variant.preLimit ??
          (variant.pre === "WALK"
            ? settings.maxWalkingMinutes
            : settings.maxCyclingMinutes) * 60,
      ),
      maxPostTransitTime: String(
        variant.postLimit ??
          (variant.post === "WALK"
            ? settings.maxWalkingMinutes
            : settings.maxCyclingMinutes) * 60,
      ),
      requireBikeTransport: "false",
    });
  url.search = new URLSearchParams(values).toString();
  return url;
}
interface RawPlace {
  name: string;
  lat: number;
  lon: number;
  stopId?: string;
  description?: string;
  track?: string;
  scheduledTrack?: string;
}
interface Polyline {
  points: string;
  precision: number;
}
interface RawLeg {
  mode: string;
  from: RawPlace;
  to: RawPlace;
  startTime: string;
  endTime: string;
  distance?: number;
  routeShortName?: string;
  displayName?: string;
  headsign?: string;
  agencyName?: string;
  tripId?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  cancelled?: boolean;
  legGeometry?: Polyline;
  steps?: {
    relativeDirection: string;
    distance: number;
    streetName: string;
    polyline: Polyline;
  }[];
}
interface Itinerary {
  id: string;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: RawLeg[];
}
interface RawResponse {
  itineraries?: Itinerary[];
  direct?: Itinerary[];
}
const platformCorrections: Record<string, string> = {
  "de:09162:10:42:82": "2",
  "de:09162:10:43:83": "3",
  "de:09162:10:43:84": "4",
  "de:09162:10:45:85": "5",
  "de:09162:10:45:86": "6",
  "de:09162:10:47:87": "7",
  "de:09162:10:47:88": "8",
  "de:09162:10:49:89": "9",
  "de:09162:10:49:90": "10",
  "de:09162:910:41:82": "2",
};
export function platform(stopId?: string, raw?: string): string | undefined {
  const key = Object.keys(platformCorrections).find((k) => stopId?.endsWith(k));
  return key && raw === key.split(":").at(-1) ? platformCorrections[key] : raw;
}
function date(s: string): number {
  const n = Date.parse(s) / 1000;
  if (!Number.isFinite(n)) throw responseError();
  return n;
}
function place(p: RawPlace, fallback: Place, endpoint: string): Place {
  if (
    !p ||
    typeof p.name !== "string" ||
    !validCoordinate({ latitude: p.lat, longitude: p.lon })
  )
    throw responseError();
  if (p.name === endpoint)
    return { ...fallback, stopId: p.stopId || fallback.stopId };
  const track = platform(p.stopId, p.track ?? p.scheduledTrack);
  return {
    name: p.name,
    detail: track ? `Gleis ${track}` : (p.description ?? ""),
    latitude: p.lat,
    longitude: p.lon,
    stopId: p.stopId || undefined,
  };
}
function mapLeg(raw: RawLeg, request: RouteRequest): Leg {
  if (!raw || typeof raw.mode !== "string") throw responseError();
  const from = place(raw.from, request.origin, "START"),
    to = place(raw.to, request.destination, "END");
  const start = date(raw.startTime),
    end = date(raw.endTime);
  if (end < start) throw responseError();
  let coordinates = raw.legGeometry
    ? decodePolyline(raw.legGeometry.points, raw.legGeometry.precision)
    : [];
  if (raw.mode === "BIKE" || raw.mode === "WALK") {
    const steps = (raw.steps ?? []).map((s) => ({
      direction: s.relativeDirection,
      distance: s.distance,
      coordinates: decodePolyline(s.polyline.points, s.polyline.precision),
    }));
    coordinates = validateGeometry(
      coordinates,
      steps,
      { ...from, latitude: raw.from.lat, longitude: raw.from.lon },
      { ...to, latitude: raw.to.lat, longitude: raw.to.lon },
      raw.mode === "WALK",
      raw.distance ?? 0,
    );
    return {
      kind: raw.mode === "BIKE" ? "bike" : "walk",
      from,
      to,
      start,
      end,
      distance: raw.distance ?? 0,
      coordinates,
    };
  }
  if (!coordinates.every(validCoordinate)) throw geometryError();
  return {
    kind: "transit",
    from,
    to,
    start,
    end,
    distance: 0,
    coordinates: coordinates.length ? coordinates : [from, to],
    mode: raw.mode,
    line: raw.routeShortName ?? raw.displayName ?? raw.mode,
    headsign: raw.headsign ?? to.name,
    agency: raw.agencyName ?? "",
    platform: platform(
      raw.from.stopId,
      raw.from.track ?? raw.from.scheduledTrack,
    ),
    arrivalPlatform: platform(
      raw.to.stopId,
      raw.to.track ?? raw.to.scheduledTrack,
    ),
    realtime: raw.realTime ?? false,
    tripId:
      raw.tripId &&
      raw.from.stopId &&
      raw.to.stopId &&
      raw.scheduledStartTime &&
      raw.scheduledEndTime
        ? raw.tripId
        : undefined,
    scheduledStart: raw.scheduledStartTime
      ? date(raw.scheduledStartTime)
      : undefined,
  };
}
export interface Batch {
  journeys: Journey[];
  rejected: boolean;
  recovery?: number;
  issues: string[];
  stop: boolean;
}
export function mapResponse(
  value: unknown,
  request: RouteRequest,
  settings: RoutingSettings,
  variant: Variant,
): Batch {
  if (!value || typeof value !== "object") throw responseError();
  const response = value as RawResponse;
  const raw = response[variant.direct ? "direct" : "itineraries"] ?? [];
  if (!Array.isArray(raw)) throw responseError();
  const batch: Batch = {
    journeys: [],
    rejected: false,
    issues: [],
    stop: false,
  };
  for (const item of raw) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !Array.isArray(item.legs) ||
      !Number.isInteger(item.transfers)
    )
      throw responseError();
    if (!item.legs.length || item.legs.some((l) => l.cancelled)) continue;
    try {
      let legs = item.legs.map((l) => mapLeg(l, request));
      const first = legs.findIndex((l) => l.kind === "transit"),
        last = legs.findLastIndex((l) => l.kind === "transit");
      if (!variant.direct && first >= 0) {
        const valid = (street: Leg[], mode: StreetMode) =>
          mode !== "WALK" ||
          (!street.some((l) => l.kind === "bike") &&
            street
              .filter((l) => l.kind === "walk")
              .reduce((s, l) => s + l.end - l.start, 0) <=
              settings.maxWalkingMinutes * 60);
        if (
          !valid(legs.slice(0, first), variant.pre) ||
          !valid(legs.slice(last + 1), variant.post)
        )
          continue;
        const normalized: Leg[] = [];
        legs.forEach((leg, i) => {
          if (i === first)
            normalized.push(
              transition(
                "fold",
                leg.from,
                leg.start - settings.foldingDuration,
                leg.start,
              ),
            );
          normalized.push(
            i < first
              ? shifted(leg, -settings.foldingDuration)
              : i > last
                ? shifted(leg, settings.foldingDuration)
                : leg,
          );
          if (i === last)
            normalized.push(
              transition(
                "unfold",
                leg.to,
                leg.end,
                leg.end + settings.foldingDuration,
              ),
            );
        });
        legs = normalized;
      }
      const id =
        item.id ||
        JSON.stringify(
          legs.map((l) => [
            l.kind,
            l.start,
            l.end,
            l.from.latitude,
            l.from.longitude,
            l.to.latitude,
            l.to.longitude,
            l.tripId,
            l.line,
          ]),
        );
      batch.journeys.push({
        id: variant.direct ? id : `${id}|${variant.pre}|${variant.post}`,
        origin: request.origin,
        destination: request.destination,
        departure: legs[0].start,
        arrival: legs.at(-1)!.end,
        legs,
        transfers: item.transfers,
        isDirect: !!variant.direct,
      });
    } catch (error) {
      if (!(error instanceof PlannerError) || error.code !== "geometry")
        throw error;
      batch.rejected = true;
      const start = date(item.startTime),
        end = date(item.endTime);
      if (start <= end && start <= request.time)
        batch.recovery = Math.max(batch.recovery ?? start, start);
    }
  }
  return batch;
}
export function retryAfter(
  raw: string | null,
  now = Date.now() / 1000,
): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return now + Math.max(0, n);
  const date = Date.parse(raw) / 1000;
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
export interface RequestBudget {
  take(): void;
  stopped?: boolean;
}
export class ApiClient {
  retryAt = 0;
  constructor(
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async json(
    url: URL,
    signal: AbortSignal,
    reload = false,
    budget?: RequestBudget,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const now = Date.now() / 1000;
    if (this.retryAt > now)
      throw new PlannerError(
        "pause",
        "Der Dienst bittet um eine Pause. Bitte später erneut versuchen.",
        true,
        this.retryAt,
      );
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          new PlannerError(
            "timeout",
            "Der Dienst hat nicht rechtzeitig geantwortet.",
          ),
        ),
      20000,
    );
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      budget?.take();
      const response = await this.fetcher(url, {
        signal: combined,
        referrerPolicy: "strict-origin-when-cross-origin",
        ...(reload ? { cache: "reload" as const } : {}),
      });
      signal.throwIfAborted();
      if (response.status === 429 || response.status === 503) {
        const until = retryAfter(response.headers.get("Retry-After"));
        if (until) this.retryAt = Math.max(this.retryAt, until);
        throw new PlannerError(
          String(response.status),
          response.status === 429
            ? "Zu viele Anfragen. Bitte später erneut versuchen."
            : "Routingdienst vorübergehend nicht verfügbar.",
          response.status === 429 || !!until,
          until,
        );
      }
      if (!response.ok)
        throw new PlannerError(
          "service",
          "Der Dienst konnte die Anfrage nicht beantworten.",
        );
      const value: unknown = await response.json();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (error instanceof PlannerError) throw error;
      throw new PlannerError(
        "network",
        "Verbindung zum Dienst fehlgeschlagen. Internetverbindung prüfen und erneut versuchen.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async batch(
    request: RouteRequest,
    settings: RoutingSettings,
    variant: Variant,
    signal: AbortSignal,
    budget?: RequestBudget,
  ): Promise<Batch> {
    const once = async (req: RouteRequest, reload = false) =>
      mapResponse(
        await this.json(
          makeURL(req, settings, variant),
          signal,
          reload,
          budget,
        ),
        req,
        settings,
        variant,
      );
    const first = await once(request);
    if (!first.rejected) return first;
    const forward =
      variant.direct && request.timing === "arrive" && first.recovery != null;
    const retryRequest: RouteRequest = forward
      ? { ...request, timing: "depart", time: first.recovery! }
      : request;
    try {
      const retry = await once(retryRequest, true);
      if (forward)
        retry.journeys = retry.journeys.filter(
          (j) =>
            j.departure >= retryRequest.time &&
            j.arrival <= request.time &&
            j.arrival >= j.departure,
        );
      retry.rejected ||= retry.journeys.length === 0;
      const ids = new Set(retry.journeys.map((j) => j.id));
      retry.journeys.push(...first.journeys.filter((j) => !ids.has(j.id)));
      if (!retry.journeys.length) throw geometryError();
      return retry;
    } catch (error) {
      signal.throwIfAborted();
      if (!first.journeys.length) throw error;
      first.issues.push(
        error instanceof Error ? error.message : "Unvollständige Suche",
      );
      first.stop = error instanceof PlannerError && error.stops;
      return first;
    }
  }
  async searchPlaces(
    query: string,
    signal: AbortSignal,
    center?: Place | { latitude: number; longitude: number },
  ): Promise<Place[]> {
    const url = new URL(`${service.api}/v1/geocode`);
    url.search = new URLSearchParams({
      text: query,
      language: "de",
      numResults: "12",
      ...(center ? { place: `${center.latitude},${center.longitude}` } : {}),
    }).toString();
    const raw = await this.json(url, signal);
    if (!Array.isArray(raw)) throw responseError();
    return raw
      .filter(
        (p) =>
          p &&
          typeof p.name === "string" &&
          validCoordinate({ latitude: p.lat, longitude: p.lon }),
      )
      .slice(0, 12)
      .map((p) => ({
        name: p.name,
        detail: [
          p.zip,
          ...(Array.isArray(p.areas)
            ? p.areas
                .filter((a: { unique?: boolean }) => a.unique)
                .map((a: { name?: string }) => a.name)
            : []),
          p.country,
        ]
          .filter(Boolean)
          .join(", "),
        latitude: p.lat,
        longitude: p.lon,
        stopId: p.type === "STOP" ? p.id : undefined,
      }));
  }
}
