import { type Coordinate, type Place, geometryError } from "./model";
export function validCoordinate(p: Coordinate): boolean {
  return (
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}
export function distance(a: Coordinate, b: Coordinate): number {
  const r = Math.PI / 180,
    lat = (b.latitude - a.latitude) * r,
    lon = (b.longitude - a.longitude) * r;
  const h =
    Math.sin(lat / 2) ** 2 +
    Math.cos(a.latitude * r) *
      Math.cos(b.latitude * r) *
      Math.sin(lon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function decodePolyline(
  encoded: string,
  precision: number,
): Coordinate[] {
  if (
    typeof encoded !== "string" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 8
  )
    throw geometryError();
  let i = 0,
    lat = 0,
    lon = 0;
  const points: Coordinate[] = [];
  function next(): number {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      if (i >= encoded.length || shift >= 50) throw geometryError();
      byte = encoded.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) throw geometryError();
      value += (byte & 31) * 2 ** shift;
      shift += 5;
    } while (byte >= 32);
    return value % 2 ? -(Math.floor(value / 2) + 1) : value / 2;
  }
  while (i < encoded.length) {
    lat += next();
    lon += next();
    if (!Number.isSafeInteger(lat) || !Number.isSafeInteger(lon))
      throw geometryError();
    points.push({
      latitude: lat / 10 ** precision,
      longitude: lon / 10 ** precision,
    });
  }
  return points;
}
export interface GeometryStep {
  direction: string;
  distance: number;
  coordinates: Coordinate[];
}
export function validateGeometry(
  geometry: Coordinate[],
  steps: GeometryStep[],
  from: Place,
  to: Place,
  walk: boolean,
  length: number,
): Coordinate[] {
  if (
    ![from, to, ...geometry].every(validCoordinate) ||
    !Number.isFinite(length) ||
    length < 0 ||
    steps.some(
      (s) =>
        !Number.isFinite(s.distance) ||
        s.distance < 0 ||
        !s.coordinates.every(validCoordinate),
    )
  )
    throw geometryError();
  const normalized = steps.map((s) => ({
    ...s,
    coordinates: [...s.coordinates],
  }));
  for (let i = 0; i < normalized.length;) {
    if (normalized[i].coordinates.length) {
      i++;
      continue;
    }
    const start = i;
    while (i < normalized.length && !normalized[i].coordinates.length) {
      if (
        normalized[i].direction !== "ELEVATOR" ||
        normalized[i].distance !== 0
      )
        throw geometryError();
      i++;
    }
    const before =
      start > 0
        ? normalized[start - 1].coordinates.at(-1)!
        : (geometry[0] ?? from);
    const after =
      i < normalized.length
        ? normalized[i].coordinates[0]
        : (geometry.at(-1) ?? to);
    if (distance(before, after) > 25) throw geometryError();
    for (let n = start; n < i; n++) normalized[n].coordinates = [before];
  }
  const connects = (p: Coordinate[]) =>
    p.length > 0 &&
    p.every(validCoordinate) &&
    distance(p[0], from) <= (from.stopId ? 500 : 100) &&
    distance(p.at(-1)!, to) <= (to.stopId ? 500 : 100);
  if (normalized.length) {
    if (
      !connects([
        normalized[0].coordinates[0],
        normalized.at(-1)!.coordinates.at(-1)!,
      ])
    )
      throw geometryError();
    for (let i = 1; i < normalized.length; i++)
      if (
        distance(
          normalized[i - 1].coordinates.at(-1)!,
          normalized[i].coordinates[0],
        ) > 100
      )
        throw geometryError();
  }
  const result = geometry.length
    ? geometry
    : normalized.length
      ? normalized.flatMap((s) => s.coordinates)
      : walk && length <= 100 && distance(from, to) <= 100
        ? [from, to]
        : [];
  if (!connects(result) || (result.length < 2 && distance(from, to) > 100))
    throw geometryError();
  return result;
}
