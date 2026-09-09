import {
  ranges,
  validSettings,
  validStops,
  type RouteStop,
  type Place,
  type RouteRequest,
  type RoutingSettings,
} from "./model";
import { validCoordinate } from "./geometry";

export interface RouteLink {
  request: RouteRequest;
  settings: RoutingSettings;
}
export type ParsedRouteLink =
  { kind: "none" } | { kind: "invalid" } | { kind: "plan"; plan: RouteLink };
const optionKeys = [
  ...Object.keys(ranges),
  "excludedTransitModes",
  "showCyclingComparison",
];
const stopKeys = Array.from({ length: 3 }, (_, i) => [
  `via${i + 1}`,
  `via${i + 1}Name`,
  `via${i + 1}Stay`,
]).flat();
const keys = [
  ...stopKeys,
  "v",
  "from",
  "fromName",
  "to",
  "toName",
  "timing",
  "time",
  ...optionKeys,
];
const fixedPlace = (place: Place, name: string): Place => ({
  latitude: place.latitude,
  longitude: place.longitude,
  name: place.name === "Aktueller Standort" ? name : place.name,
  detail: "",
});

export function routeURL(base: string | URL, plan?: RouteLink): URL {
  const url = new URL(base);
  for (const key of keys) url.searchParams.delete(key);
  if (!plan) return url;
  const { request, settings } = plan;
  const params = url.searchParams;
  params.set("v", request.stops?.length ? "2" : "1");
  request.stops?.forEach((stop, i) => {
    params.set(
      `via${i + 1}`,
      `${stop.place.latitude.toFixed(6)},${stop.place.longitude.toFixed(6)}`,
    );
    params.set(`via${i + 1}Name`, stop.place.name);
    params.set(`via${i + 1}Stay`, String(stop.stayMinutes));
  });
  for (const [key, place] of [
    ["from", fixedPlace(request.origin, "Startpunkt")],
    ["to", fixedPlace(request.destination, "Zielpunkt")],
  ] as const) {
    params.set(
      key,
      `${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}`,
    );
    params.set(`${key}Name`, place.name);
  }
  params.set("showCyclingComparison", String(settings.showCyclingComparison));
  params.set("timing", request.timing);
  if (request.timing !== "now")
    params.set("time", new Date(request.time * 1000).toISOString());
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[])
    params.set(key, String(settings[key]));
  params.set(
    "excludedTransitModes",
    [...settings.excludedTransitModes].sort().join(","),
  );
  return url;
}

export function readRouteURL(url: URL): ParsedRouteLink {
  const params = url.searchParams;
  if (!keys.some((key) => params.has(key))) return { kind: "none" };
  if (
    !["1", "2"].includes(params.get("v") ?? "") ||
    keys.some((key) => params.getAll(key).length > 1)
  )
    return { kind: "invalid" };
  function place(key: string, fallback: string): Place | undefined {
    const pair = params.get(key)?.split(",");
    if (!pair || pair.length !== 2 || pair.some((n) => !n.trim())) return;
    const point = { latitude: Number(pair[0]), longitude: Number(pair[1]) };
    const name = params.get(`${key}Name`)?.trim() || fallback;
    if (!validCoordinate(point) || name.length > 500) return;
    return fixedPlace({ ...point, name, detail: "" }, fallback);
  }
  const stops: RouteStop[] = [];
  if (params.get("v") === "1" && stopKeys.some((key) => params.has(key)))
    return { kind: "invalid" };
  if (
    [...params.keys()].some(
      (key) => /^via/.test(key) && !stopKeys.includes(key),
    )
  )
    return { kind: "invalid" };
  for (let i = 1; i <= 3; i++) {
    const group = [`via${i}`, `via${i}Name`, `via${i}Stay`];
    if (!group.some((key) => params.has(key))) continue;
    const p = place(`via${i}`, `Zwischenziel ${i}`),
      raw = params.get(`via${i}Stay`);
    if (stops.length !== i - 1 || !p || !raw?.trim())
      return { kind: "invalid" };
    stops.push({ id: `via-${i}`, place: p, stayMinutes: Number(raw) });
  }
  if (!validStops(stops) || (params.get("v") === "2" && !stops.length))
    return { kind: "invalid" };
  const origin = place("from", "Startpunkt"),
    destination = place("to", "Zielpunkt");
  const timing = params.get("timing");
  const rawTime = params.get("time");
  const time = timing === "now" ? 0 : Date.parse(rawTime ?? "") / 1000;
  if (
    !origin ||
    !destination ||
    !["now", "depart", "arrive"].includes(timing ?? "") ||
    !Number.isFinite(time) ||
    (timing !== "now" &&
      (!rawTime?.endsWith("Z") ||
        new Date(time * 1000).toISOString().replace(".000Z", "Z") !==
          rawTime.replace(".000Z", "Z")))
  )
    return { kind: "invalid" };
  const showComparison = params.get("showCyclingComparison");
  if (
    showComparison !== null &&
    showComparison !== "true" &&
    showComparison !== "false"
  )
    return { kind: "invalid" };
  const values: Record<string, unknown> = {
    showCyclingComparison: showComparison !== "false",
  };
  for (const key of Object.keys(ranges)) {
    const raw = params.get(key);
    if (!raw?.trim()) return { kind: "invalid" };
    values[key] = Number(raw);
  }
  if (!params.has("excludedTransitModes")) return { kind: "invalid" };
  values.excludedTransitModes = params
    .get("excludedTransitModes")!
    .split(",")
    .filter(Boolean);
  if (!validSettings(values)) return { kind: "invalid" };
  return {
    kind: "plan",
    plan: {
      request: {
        origin,
        destination,
        ...(stops.length ? { stops } : {}),
        timing: timing as RouteRequest["timing"],
        time,
      },
      settings: values,
    },
  };
}
