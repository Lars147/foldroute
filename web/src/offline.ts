import {
  validStoredSettings,
  validStops,
  validLegacySettings,
  type LegacyRoutingSettings,
  type Journey,
  type RouteRequest,
  type StoredRoutingSettings,
} from "./model";
import { localDatabase } from "./storage";
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
  typeof p.detail === "string";
export function validSnapshot(value: unknown): value is SavedJourney {
  if (
    !object(value) ||
    !Number.isFinite(value.savedAt) ||
    !(value.version === 1
      ? validLegacySettings(value.settings)
      : (value.version === 3 || value.version === 4) &&
        validStoredSettings(value.settings))
  )
    return false;
  const r = value.request,
    j = value.journey;
  return (
    object(r) &&
    place(r.origin) &&
    place(r.destination) &&
    validStops(r.stops) &&
    (value.version === 4
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
    (value.version !== 4 ||
      JSON.stringify(
        j.legs.filter((l: any) => l?.kind === "stop").map((l: any) => l.stop),
      ) === JSON.stringify(r.stops)) &&
    j.legs.every(
      (l: unknown) =>
        object(l) &&
        [
          "bike",
          "walk",
          "transit",
          "fold",
          "unfold",
          "wait",
          ...(value.version === 4 ? ["stop"] : []),
        ].includes(l.kind) &&
        (l.kind !== "stop" ||
          (validStops([l.stop]) &&
            r.stops?.some((s: any) => s.id === l.stop.id) &&
            l.start + l.stop.stayMinutes * 60 <= l.end &&
            l.from?.latitude === l.stop.place.latitude &&
            l.from?.longitude === l.stop.place.longitude)) &&
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
export class OfflineStore {
  async read(): Promise<{
    enabled: boolean;
    snapshot?: SavedJourney;
    invalid: boolean;
  }> {
    const db = await localDatabase.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state");
      const enabled = store.get("enabled"),
        saved = store.get("last");
      let snapshot: SavedJourney | undefined,
        invalid = false;
      saved.onsuccess = () => {
        if (saved.result !== undefined) {
          if (validSnapshot(saved.result)) snapshot = saved.result;
          else {
            invalid = true;
            store.delete("last");
          }
        }
      };
      tx.oncomplete = () =>
        resolve({
          enabled: enabled.result !== false,
          snapshot: enabled.result === false ? undefined : snapshot,
          invalid,
        });
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(snapshot: SavedJourney): Promise<boolean> {
    const generation = localDatabase.generation;
    if (!validSnapshot(snapshot))
      throw new Error("Reise kann nicht offline gespeichert werden.");
    const db = await localDatabase.open();
    if (generation !== localDatabase.generation) return false;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state"),
        enabled = store.get("enabled");
      let saved = false;
      enabled.onsuccess = () => {
        if (enabled.result !== false) {
          store.put(snapshot, "last");
          saved = true;
        }
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = () => reject(tx.error);
    });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    const generation = localDatabase.generation;
    const db = await localDatabase.open();
    if (generation !== localDatabase.generation) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state");
      store.put(enabled, "enabled");
      if (!enabled) store.delete("last");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  async clear(): Promise<void> {
    const db = await localDatabase.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").delete("last");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
}
