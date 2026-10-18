import type { Journey, Leg } from "./model";
import type { NavigationProgress } from "./navigation-engine";
import { distance } from "./geometry";

export interface NavigationTrip {
  id: string;
  startedAt: number;
  originName: string;
  distanceMeters: number;
  routeMeters: number;
  sinceResume: boolean;
  storageEpoch: number;
}

export interface TripSummary {
  id: string;
  originName: string;
  destinationName: string;
  arrivedAt: number;
  elapsedSeconds: number;
  distanceMeters: number;
  sinceResume: boolean;
  storageEpoch: number;
}

export interface NavigationStatistics {
  version: 1;
  completedIds: string[];
  distanceMeters: number;
  elapsedSeconds: number;
}

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function validNavigationTrip(value: unknown): value is NavigationTrip {
  if (!value || typeof value !== "object") return false;
  const trip = value as NavigationTrip;
  return (
    typeof trip.id === "string" &&
    trip.id.length > 0 &&
    nonnegative(trip.startedAt) &&
    typeof trip.originName === "string" &&
    nonnegative(trip.distanceMeters) &&
    nonnegative(trip.routeMeters) &&
    typeof trip.sinceResume === "boolean" &&
    Number.isSafeInteger(trip.storageEpoch) &&
    trip.storageEpoch >= 0
  );
}

export function emptyNavigationStatistics(): NavigationStatistics {
  return { version: 1, completedIds: [], distanceMeters: 0, elapsedSeconds: 0 };
}

export function validNavigationStatistics(
  value: unknown,
): value is NavigationStatistics {
  if (!value || typeof value !== "object") return false;
  const stats = value as NavigationStatistics;
  return (
    stats.version === 1 &&
    Array.isArray(stats.completedIds) &&
    stats.completedIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(stats.completedIds).size === stats.completedIds.length &&
    nonnegative(stats.distanceMeters) &&
    nonnegative(stats.elapsedSeconds)
  );
}

export function recordNavigation(
  statistics: NavigationStatistics,
  summary: TripSummary,
): NavigationStatistics {
  if (
    !summary.id ||
    !nonnegative(summary.distanceMeters) ||
    !nonnegative(summary.elapsedSeconds)
  )
    throw new Error("Ungültige Navigationsstatistik.");
  if (statistics.completedIds.includes(summary.id)) return statistics;
  return {
    version: 1,
    completedIds: [...statistics.completedIds, summary.id],
    distanceMeters: statistics.distanceMeters + summary.distanceMeters,
    elapsedSeconds: statistics.elapsedSeconds + summary.elapsedSeconds,
  };
}

function routePath(leg: Leg) {
  return leg.maneuvers?.length
    ? leg.maneuvers.flatMap((step) => step.coordinates)
    : leg.coordinates.length > 1
      ? leg.coordinates
      : [leg.from, leg.to];
}

function pathLength(leg: Leg) {
  const path = routePath(leg);
  let length = 0;
  for (let i = 1; i < path.length; i++)
    length += distance(path[i - 1], path[i]);
  return length;
}

export function routeLegMeters(leg: Leg): number {
  if (!["bike", "walk", "transit"].includes(leg.kind)) return 0;
  return leg.distance > 0 ? leg.distance : pathLength(leg);
}

/** Route-derived progress, not a measured GPS track. */
export function navigatedRouteMeters(
  journey: Journey,
  progress: NavigationProgress,
  arrived = false,
): number {
  const leg = journey.legs[progress.legIndex];
  const completed = journey.legs
    .slice(0, progress.legIndex)
    .reduce((sum, item) => sum + routeLegMeters(item), 0);
  if (arrived) return completed + routeLegMeters(leg);
  const length = pathLength(leg);
  return (
    completed +
    (length ? routeLegMeters(leg) * Math.min(1, progress.meters / length) : 0)
  );
}

/** Invalidate pending writes in other tabs as well as deleting the totals. */
export function resetNavigationStatistics(store: IDBObjectStore) {
  store.delete("navigationStatistics");
  const epoch = store.get("navigationStatisticsEpoch");
  epoch.onsuccess = () =>
    store.put((epoch.result ?? 0) + 1, "navigationStatisticsEpoch");
}
