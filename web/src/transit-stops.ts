import type { Leg, TransitStop } from "./model";
import { validCoordinate } from "./geometry";

/** Stop coordinates can identify station access points away from the rail line. */
export const maxStationShapeDistance = 300;

/** Optional stop metadata must never turn an incomplete list into a false count. */
export function parseTransitStops(value: unknown): TransitStop[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return;
  const stops: TransitStop[] = [];
  for (const raw of value) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.name !== "string" ||
      !raw.name.trim() ||
      !validCoordinate({ latitude: raw.lat, longitude: raw.lon })
    )
      return;
    const stop: TransitStop = {
      name: raw.name,
      detail: "",
      latitude: raw.lat,
      longitude: raw.lon,
      stopId: typeof raw.stopId === "string" ? raw.stopId : undefined,
      cancelled: raw.cancelled === true,
    };
    for (const key of [
      "arrival",
      "departure",
      "scheduledArrival",
      "scheduledDeparture",
    ] as const) {
      if (raw[key] === undefined) continue;
      const time =
        typeof raw[key] === "string" ? Date.parse(raw[key]) / 1000 : NaN;
      if (!Number.isFinite(time)) return;
      stop[key] = time;
    }
    stops.push(stop);
  }
  return stops;
}

/** Preserve repeated visits to the same station, including visits without times. */
export function transitStopKey(stops: TransitStop[], index: number): string {
  const key = transitStopIdentity(stops[index], index);
  const occurrence = stops
    .slice(0, index)
    .filter((stop, i) => transitStopIdentity(stop, i) === key).length;
  return JSON.stringify([key, occurrence]);
}

export const transitStopIdentity = (stop: TransitStop, index: number) =>
  JSON.stringify([
    stop.stopId ?? [stop.name, stop.latitude, stop.longitude],
    (index === 0
      ? (stop.scheduledDeparture ?? stop.scheduledArrival)
      : (stop.scheduledArrival ?? stop.scheduledDeparture)) ?? null,
  ]);

/** Timetable predictions can change without invalidating physical GPS evidence. */
export const transitTopologyKey = (leg: Leg) =>
  JSON.stringify([
    leg.coordinates,
    [leg.from.stopId, leg.from.latitude, leg.from.longitude],
    [leg.to.stopId, leg.to.latitude, leg.to.longitude],
    !!leg.transitStatus?.cancelled,
    leg.transitStops?.map((stop, index) => [
      transitStopIdentity(stop, index),
      stop.latitude,
      stop.longitude,
      !!stop.cancelled,
    ]),
  ]);
