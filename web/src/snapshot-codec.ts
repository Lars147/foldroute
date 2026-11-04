import {
  validStoredSettings,
  validNavigationLegData,
  validPlaceMetadata,
  journeyStops,
  validStops,
  validLegacySettings,
  type LegacyRoutingSettings,
  type Journey,
  type Place,
  type RouteRequest,
  type StoredRoutingSettings,
} from "./model";

interface Snapshot {
  savedAt: number;
  request: RouteRequest;
  journey: Journey;
}
export type SavedJourney = Snapshot &
  (
    | { version: 1; settings: LegacyRoutingSettings }
    | { version: 3 | 4; settings: StoredRoutingSettings }
  );
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object";
const point = (p: unknown) =>
  object(p) &&
  Number.isFinite(p.latitude) &&
  Math.abs(p.latitude) <= 90 &&
  Number.isFinite(p.longitude) &&
  Math.abs(p.longitude) <= 180;
const place = (p: unknown) =>
  point(p) &&
  object(p) &&
  typeof p.name === "string" &&
  typeof p.detail === "string" &&
  validPlaceMetadata(p as Place);
/** History owns its version envelope; payload validation is shared with navigation. */
export function validHistorySnapshot(value: unknown): value is SavedJourney {
  return (
    object(value) &&
    (value.version === 1
      ? validLegacySettings(value.settings)
      : (value.version === 3 || value.version === 4) &&
        validStoredSettings(value.settings)) &&
    validSnapshotPayload(value, value.version === 4)
  );
}

/** Validate data shared by history and navigation without inventing an envelope version. */
export function validSnapshotPayload(
  value: unknown,
  withStops: boolean,
): value is Snapshot {
  if (!object(value) || !Number.isFinite(value.savedAt)) return false;
  const r = value.request,
    j = value.journey;
  return (
    object(r) &&
    (r.bikeFolded === undefined || typeof r.bikeFolded === "boolean") &&
    place(r.origin) &&
    place(r.destination) &&
    validStops(r.stops) &&
    (withStops
      ? Array.isArray(r.stops) && r.stops.length > 0
      : !r.stops?.length) &&
    ["now", "depart", "arrive"].includes(r.timing) &&
    Number.isFinite(r.time) &&
    object(j) &&
    typeof j.id === "string" &&
    place(j.origin) &&
    place(j.destination) &&
    Number.isFinite(j.departure) &&
    Number.isFinite(j.arrival) &&
    j.arrival >= j.departure &&
    Number.isInteger(j.transfers) &&
    j.transfers >= 0 &&
    typeof j.isDirect === "boolean" &&
    Array.isArray(j.legs) &&
    j.legs.length > 0 &&
    (!withStops ||
      JSON.stringify(journeyStops(j as Journey), (key, value) =>
        key === "stationId" ? undefined : value,
      ) ===
        JSON.stringify(r.stops, (key, value) =>
          key === "stationId" ? undefined : value,
        )) &&
    j.legs.every(
      (l: unknown) =>
        object(l) &&
        validNavigationLegData(l as any) &&
        [
          "bike",
          "walk",
          "transit",
          "fold",
          "unfold",
          "wait",
          ...(withStops ? ["stop"] : []),
        ].includes(l.kind) &&
        (l.kind !== "stop" ||
          (validStops([l.stop]) &&
            r.stops?.some((s: any) => s.id === l.stop.id) &&
            l.start + l.stop.stayMinutes * 60 <= l.end &&
            (l.stop.place.kind === "station" ||
              (l.from?.latitude === l.stop.place.latitude &&
                l.from?.longitude === l.stop.place.longitude)))) &&
        place(l.from) &&
        place(l.to) &&
        Number.isFinite(l.start) &&
        Number.isFinite(l.end) &&
        l.end >= l.start &&
        Number.isFinite(l.distance) &&
        l.distance >= 0 &&
        Array.isArray(l.coordinates) &&
        l.coordinates.every(point) &&
        ["line", "headsign", "agency", "platform", "arrivalPlatform"].every(
          (k) => l[k] === undefined || typeof l[k] === "string",
        ),
    )
  );
}
