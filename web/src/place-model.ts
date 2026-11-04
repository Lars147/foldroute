export interface Coordinate {
  latitude: number;
  longitude: number;
}
export interface Place extends Coordinate {
  name: string;
  detail: string;
  stopId?: string;
  /** Missing kind denotes a legacy point, never an inferred station. */
  kind?: "point" | "station";
  stationId?: string;
  parentId?: string;
  level?: number;
}
export const stationId = (place: Place): string | undefined =>
  place.kind === "station" ? (place.stationId ?? place.stopId) : undefined;
/** Compare actual transit halts using only provider-declared identity. */
export function sameStation(a: Place, b: Place): boolean {
  const root = a.parentId ?? a.stopId;
  return !!(
    (a.stopId && a.stopId === b.stopId) ||
    (root && root === (b.parentId ?? b.stopId))
  );
}
export function validPlaceMetadata(place: Place): boolean {
  return (
    [undefined, "point", "station"].includes(place.kind) &&
    [place.stopId, place.stationId, place.parentId].every(
      (id) =>
        id === undefined ||
        (typeof id === "string" && id.length > 0 && id.length <= 1000),
    ) &&
    (place.kind !== "station" || !!place.stopId) &&
    (place.stationId === undefined || place.kind === "station") &&
    (place.level === undefined || Number.isFinite(place.level))
  );
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
        validPlaceMetadata(s.place) &&
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
  /** Internal continuation: the bicycle is already folded. */
  bikeFolded?: boolean;
  stops?: RouteStop[];
  origin: Place;
  destination: Place;
  timing: Timing;
  time: number;
}
