import type { Journey, RouteRequest, RoutingSettings } from "./model";
import { validSnapshot } from "./offline";
import { localDatabase } from "./storage";
import { readStoragePreferences } from "./storage-preferences";
import type { NavigationProgress } from "./navigation-engine";
import { validateGeometry } from "./geometry";
import {
  emptyNavigationStatistics,
  recordNavigation,
  resetNavigationStatistics,
  validNavigationStatistics,
  validNavigationTrip,
  type NavigationStatistics,
  type NavigationTrip,
  type TripSummary,
} from "./navigation-summary";

export interface NavigationSnapshot {
  version: 1;
  savedAt: number;
  journey: Journey;
  request: RouteRequest;
  settings: RoutingSettings;
  progress: NavigationProgress;
  trip?: NavigationTrip;
  sessionId?: string;
  resumeEpoch?: number;
}
function storedTripId(value: unknown): string | undefined {
  return validNavigationSnapshot(value)
    ? (value.trip?.id ?? value.sessionId)
    : undefined;
}
export function validNavigationSnapshot(
  value: unknown,
): value is NavigationSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as NavigationSnapshot;
  if (
    s.version !== 1 ||
    (s.resumeEpoch !== undefined &&
      (!Number.isSafeInteger(s.resumeEpoch) || s.resumeEpoch < 0)) ||
    (s.sessionId !== undefined &&
      (typeof s.sessionId !== "string" || !s.sessionId.length)) ||
    (s.trip !== undefined && !validNavigationTrip(s.trip)) ||
    !validSnapshot({ ...s, version: s.request?.stops?.length ? 4 : 3 })
  )
    return false;
  const p = s.progress;
  if (
    !p ||
    (p.transitStop !== undefined &&
      (typeof p.transitStop !== "string" || !p.transitStop.length)) ||
    !Number.isInteger(p.legIndex) ||
    p.legIndex < 0 ||
    !s.journey.legs[p.legIndex] ||
    !Number.isInteger(p.maneuverIndex) ||
    p.maneuverIndex < 0 ||
    p.maneuverIndex > (s.journey.legs[p.legIndex].maneuvers?.length ?? 0) ||
    !Number.isFinite(p.meters) ||
    p.meters < 0 ||
    !Array.isArray(p.confirmedStops) ||
    !p.confirmedStops.every((id) => typeof id === "string")
  )
    return false;
  const ids = s.journey.legs.map((l) => l.navigationId);
  return (
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length
  );
}
export function validateNavigationGeometry(journey: Journey) {
  for (const leg of journey.legs) {
    if (leg.kind === "bike" || leg.kind === "walk")
      validateGeometry(
        leg.coordinates,
        leg.maneuvers ?? [],
        leg.from,
        leg.to,
        leg.kind === "walk",
        leg.distance,
      );
  }
}
export class NavigationStore {
  private generation = 0;
  async readStatistics(): Promise<{
    epoch: number;
    resumeEpoch: number;
    statistics: NavigationStatistics;
  }> {
    const db = await localDatabase.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readonly"),
        store = tx.objectStore("state"),
        epoch = store.get("navigationStatisticsEpoch"),
        resumeEpoch = store.get("navigationResumeEpoch"),
        statistics = store.get("navigationStatistics");
      tx.oncomplete = () =>
        resolve({
          epoch: epoch.result ?? 0,
          resumeEpoch: resumeEpoch.result ?? 0,
          statistics: validNavigationStatistics(statistics.result)
            ? statistics.result
            : emptyNavigationStatistics(),
        });
      tx.onabort = () => reject(tx.error);
    });
  }

  async completeTrip(
    summary: TripSummary,
  ): Promise<NavigationStatistics | undefined> {
    const generation = ++this.generation,
      databaseGeneration = localDatabase.generation;
    const db = await localDatabase.open();
    if (
      generation !== this.generation ||
      databaseGeneration !== localDatabase.generation
    )
      return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state"),
        enabled = store.get("enabled"),
        preferences = store.get("storagePreferences"),
        epoch = store.get("navigationStatisticsEpoch"),
        active = store.get("activeNavigation"),
        statistics = store.get("navigationStatistics");
      let result: NavigationStatistics | undefined;
      statistics.onsuccess = () => {
        if (
          generation !== this.generation ||
          databaseGeneration !== localDatabase.generation
        )
          return;
        if (storedTripId(active.result) === summary.id)
          store.delete("activeNavigation");
        if (
          !readStoragePreferences(preferences.result, enabled.result)
            .statistics ||
          (epoch.result ?? 0) !== summary.storageEpoch
        )
          return;
        result = recordNavigation(
          validNavigationStatistics(statistics.result)
            ? statistics.result
            : emptyNavigationStatistics(),
          summary,
        );
        store.put(result, "navigationStatistics");
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
    });
  }
  async read(includeDisabled = false): Promise<NavigationSnapshot | undefined> {
    const db = await localDatabase.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state");
      const enabled = store.get("enabled"),
        preferences = store.get("storagePreferences"),
        active = store.get("activeNavigation");
      let result: NavigationSnapshot | undefined;
      active.onsuccess = () => {
        if (
          (includeDisabled ||
            readStoragePreferences(preferences.result, enabled.result)
              .navigation) &&
          validNavigationSnapshot(active.result)
        ) {
          result = active.result;
          // Give old snapshots a random identity before two tabs can resume them.
          if (
            !result.trip &&
            !result.sessionId &&
            readStoragePreferences(preferences.result, enabled.result)
              .navigation
          ) {
            result.sessionId = crypto.randomUUID();
            store.put(result, "activeNavigation");
          }
        } else if (
          active.result !== undefined &&
          !validNavigationSnapshot(active.result)
        )
          store.delete("activeNavigation");
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(snapshot: NavigationSnapshot): Promise<void> {
    if (!validNavigationSnapshot(snapshot))
      throw new Error(
        "Navigation konnte nicht gespeichert werden: ungültiger Zustand.",
      );
    const generation = this.generation,
      databaseGeneration = localDatabase.generation;
    const db = await localDatabase.open();
    if (
      generation !== this.generation ||
      databaseGeneration !== localDatabase.generation
    )
      return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state"),
        enabled = store.get("enabled"),
        preferences = store.get("storagePreferences"),
        epoch = store.get("navigationResumeEpoch");
      epoch.onsuccess = () => {
        if (
          generation !== this.generation ||
          databaseGeneration !== localDatabase.generation
        )
          return;
        if (
          !readStoragePreferences(preferences.result, enabled.result).navigation
        )
          return;
        if ((snapshot.resumeEpoch ?? 0) !== (epoch.result ?? 0)) return;
        store.put(snapshot, "activeNavigation");
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  async clear(expectedTripId?: string) {
    this.generation++;
    const db = await localDatabase.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      if (expectedTripId === undefined) {
        store.delete("activeNavigation");
        const epoch = store.get("navigationResumeEpoch");
        epoch.onsuccess = () =>
          store.put((epoch.result ?? 0) + 1, "navigationResumeEpoch");
      } else {
        const active = store.get("activeNavigation");
        active.onsuccess = () => {
          if (storedTripId(active.result) === expectedTripId)
            store.delete("activeNavigation");
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  async clearStatistics() {
    const db = await localDatabase.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      resetNavigationStatistics(store);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
}
