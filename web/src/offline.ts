import {
  validStoredSettings,
  validStops,
  validLegacySettings,
  type LegacyRoutingSettings,
  type Journey,
  type Place,
  type RouteRequest,
  type StoredRoutingSettings,
} from "./model";
import { localDatabase } from "./storage";
import { distance } from "./geometry";
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
export interface HistoryEntry {
  id: string;
  calculationId?: string;
  snapshot: SavedJourney;
}
interface HistoryData {
  version: 1;
  entries: HistoryEntry[];
}
const genericPlaces = new Set([
  "aktueller standort",
  "startpunkt",
  "zielpunkt",
]);
function sameHistoryPlace(a: Place, b: Place): boolean {
  const aName = a.name.trim(),
    bName = b.name.trim();
  return (
    distance(a, b) <= 25 &&
    (genericPlaces.has(aName.toLocaleLowerCase("de")) ||
      genericPlaces.has(bName.toLocaleLowerCase("de")) ||
      aName.localeCompare(bName, "de", { sensitivity: "accent" }) === 0)
  );
}
export function sameHistoryRoute(a: RouteRequest, b: RouteRequest): boolean {
  const aStops = a.stops ?? [],
    bStops = b.stops ?? [];
  return (
    sameHistoryPlace(a.origin, b.origin) &&
    sameHistoryPlace(a.destination, b.destination) &&
    aStops.length === bStops.length &&
    aStops.every((stop, index) =>
      sameHistoryPlace(stop.place, bStops[index].place),
    )
  );
}
export function readHistory(
  value: unknown,
  legacy?: unknown,
): {
  entries: HistoryEntry[];
  invalid: boolean;
  changed?: boolean;
} {
  if (value === undefined) {
    return {
      entries: validSnapshot(legacy)
        ? [{ id: "legacy", snapshot: legacy }]
        : [],
      invalid: legacy !== undefined && !validSnapshot(legacy),
    };
  }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries))
    return { entries: [], invalid: true };
  const ids = new Set<string>();
  const entries = value.entries.filter(
    (entry: unknown): entry is HistoryEntry => {
      if (
        !object(entry) ||
        typeof entry.id !== "string" ||
        !entry.id ||
        (entry.calculationId !== undefined &&
          (typeof entry.calculationId !== "string" || !entry.calculationId)) ||
        ids.has(entry.id) ||
        !validSnapshot(entry.snapshot)
      )
        return false;
      ids.add(entry.id);
      return true;
    },
  );
  const unique: HistoryEntry[] = [];
  for (const entry of [...entries].sort(
    (a, b) => b.snapshot.savedAt - a.snapshot.savedAt,
  )) {
    if (
      !unique.some((previous) =>
        sameHistoryRoute(previous.snapshot.request, entry.snapshot.request),
      )
    )
      unique.push(entry);
  }
  const retained = unique.slice(0, 20);
  return {
    entries: retained,
    invalid: entries.length !== value.entries.length,
    changed:
      retained.length !== value.entries.length ||
      retained.some((entry, index) => entry !== value.entries[index]),
  };
}
export function retainHistory(
  entries: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const previous = entries.find((item) =>
    sameHistoryRoute(item.snapshot.request, entry.snapshot.request),
  );
  if (previous && previous.snapshot.savedAt > entry.snapshot.savedAt)
    return entries;
  const updated = {
    ...entry,
    id: previous?.id ?? entry.id,
    calculationId: entry.calculationId ?? entry.id,
  };
  return [
    updated,
    ...entries.filter(
      (item) =>
        item.id !== updated.id &&
        !sameHistoryRoute(item.snapshot.request, entry.snapshot.request),
    ),
  ]
    .sort((a, b) => b.snapshot.savedAt - a.snapshot.savedAt)
    .slice(0, 20);
}

interface StoredHistory {
  enabled: boolean;
  entries: HistoryEntry[];
  snapshot?: SavedJourney;
  invalid: boolean;
}
export class OfflineStore {
  private generation = 0;
  private deleted = new Set<string>();
  private calculationEntries = new Map<string, string>();

  private async transaction(
    change?: (state: StoredHistory) => void,
    generation = this.generation,
    databaseGeneration = localDatabase.generation,
  ): Promise<StoredHistory | undefined> {
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
        last = store.get("last"),
        history = store.get("history");
      let result: StoredHistory | undefined;
      history.onsuccess = () => {
        if (
          generation !== this.generation ||
          databaseGeneration !== localDatabase.generation
        )
          return;
        const decoded = readHistory(history.result, last.result);
        result = { ...decoded, enabled: enabled.result !== false };
        if (!result.enabled) result.entries = [];
        change?.(result);
        result.snapshot = result.entries[0]?.snapshot;
        if (
          change ||
          history.result === undefined ||
          decoded.invalid ||
          decoded.changed ||
          (!result.enabled && decoded.entries.length > 0)
        ) {
          const data: HistoryData = { version: 1, entries: result.entries };
          store.put(data, "history");
          store.put(result.enabled, "enabled");
          // Keep the existing latest-journey record compatible with older clients.
          if (result.snapshot) store.put(result.snapshot, "last");
          else store.delete("last");
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
    });
  }
  async read(): Promise<StoredHistory> {
    return (
      (await this.transaction()) ?? {
        enabled: true,
        entries: [],
        invalid: false,
      }
    );
  }
  async save(snapshot: SavedJourney, id: string): Promise<boolean> {
    if (!validSnapshot(snapshot))
      throw new Error("Reise kann nicht offline gespeichert werden.");
    let saved = false;
    await this.transaction((state) => {
      const knownEntry = this.calculationEntries.get(id);
      if (
        !state.enabled ||
        this.deleted.has(id) ||
        (knownEntry && this.deleted.has(knownEntry))
      )
        return;
      const previous = state.entries.find((entry) =>
        sameHistoryRoute(entry.snapshot.request, snapshot.request),
      );
      if (
        previous &&
        (previous.snapshot.savedAt > snapshot.savedAt ||
          (knownEntry &&
            previous.calculationId &&
            previous.calculationId !== id &&
            previous.snapshot.savedAt === snapshot.savedAt))
      )
        return;
      state.entries = retainHistory(state.entries, {
        id,
        calculationId: id,
        snapshot,
      });
      this.calculationEntries.set(id, previous?.id ?? id);
      saved = true;
    });
    return saved;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.generation++;
    await this.transaction((state) => {
      state.enabled = enabled;
      if (!enabled) state.entries = [];
    });
  }
  async clear(): Promise<void> {
    this.generation++;
    await this.transaction((state) => {
      state.entries = [];
    });
  }
  async remove(id: string): Promise<void> {
    this.generation++;
    this.deleted.add(id);
    await this.transaction((state) => {
      state.entries = state.entries.filter((entry) => entry.id !== id);
    });
  }
}
