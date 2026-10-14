import type { Journey, RouteRequest, RoutingSettings } from "./model";
import { validSnapshot } from "./offline";
import { localDatabase } from "./storage";
import type { NavigationProgress } from "./navigation-engine";
import { validateGeometry } from "./geometry";

export interface NavigationSnapshot {
  version: 1;
  savedAt: number;
  journey: Journey;
  request: RouteRequest;
  settings: RoutingSettings;
  progress: NavigationProgress;
}
export function validNavigationSnapshot(
  value: unknown,
): value is NavigationSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as NavigationSnapshot;
  if (
    s.version !== 1 ||
    !validSnapshot({ ...s, version: s.request?.stops?.length ? 4 : 3 })
  )
    return false;
  const p = s.progress;
  if (
    !p ||
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
  async read(): Promise<NavigationSnapshot | undefined> {
    const db = await localDatabase.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state");
      const enabled = store.get("enabled"),
        active = store.get("activeNavigation");
      let result: NavigationSnapshot | undefined;
      active.onsuccess = () => {
        if (enabled.result !== false && validNavigationSnapshot(active.result))
          result = active.result;
        else store.delete("activeNavigation");
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
        enabled = store.get("enabled");
      enabled.onsuccess = () => {
        if (
          generation !== this.generation ||
          databaseGeneration !== localDatabase.generation
        )
          return;
        if (enabled.result !== false) store.put(snapshot, "activeNavigation");
        else store.delete("activeNavigation");
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  async clear() {
    this.generation++;
    const db = await localDatabase.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").delete("activeNavigation");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
}
