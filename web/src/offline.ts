import {
  readStoragePreferences,
  type StoragePreferences,
} from "./storage-preferences";
import {
  coordinateKey,
  genericHistoryName,
  type HistoryNames,
} from "./history-names";
import {
  validStoredSettings,
  validNavigationLegData,
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
        validNavigationLegData(l as any) &&
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
  placeNames?: HistoryNames;
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
      if (entry.placeNames !== undefined) {
        if (!object(entry.placeNames)) delete entry.placeNames;
        else
          for (const side of ["origin", "destination"]) {
            if (
              typeof entry.placeNames[side] !== "string" ||
              !entry.placeNames[side].trim()
            )
              delete entry.placeNames[side];
          }
      }
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
  const placeNames: HistoryNames = { ...entry.placeNames };
  for (const side of ["origin", "destination"] as const) {
    if (
      !placeNames[side] &&
      previous?.placeNames?.[side] &&
      coordinateKey(previous.snapshot.request[side]) ===
        coordinateKey(entry.snapshot.request[side]) &&
      genericHistoryName(entry.snapshot.request[side].name)
    )
      placeNames[side] = previous.placeNames[side];
  }
  const updated = {
    ...entry,
    ...(Object.keys(placeNames).length ? { placeNames } : {}),
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
  preferences: StoragePreferences;
  epoch: number;
  entries: HistoryEntry[];
  snapshot?: SavedJourney;
  invalid: boolean;
}
export interface HistoryDeletion {
  entry: HistoryEntry;
  epoch: number;
  databaseGeneration: number;
}
export class OfflineStore {
  private generation = 0;
  private deleted = new Set<string>();
  private deletedCalculations = new Set<string>();
  private undoEpoch = 0;
  private undoTokens = new WeakSet<HistoryDeletion>();
  private calculationEntries = new Map<string, string>();
  private calculationEpochs = new Map<string, number>();

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
        preferences = store.get("storagePreferences"),
        epoch = store.get("historyEpoch"),
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
        const storagePreferences = readStoragePreferences(
          preferences.result,
          enabled.result,
        );
        result = {
          ...decoded,
          enabled: storagePreferences.history,
          preferences: storagePreferences,
          epoch: epoch.result ?? 0,
        };
        change?.(result);
        result.snapshot = result.entries[0]?.snapshot;
        if (
          change ||
          history.result === undefined ||
          decoded.invalid ||
          decoded.changed ||
          preferences.result === undefined
        ) {
          const data: HistoryData = { version: 1, entries: result.entries };
          store.put(data, "history");
          store.put(result.preferences, "storagePreferences");
          store.put(result.epoch, "historyEpoch");
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
        preferences: { history: true, navigation: true, statistics: true },
        epoch: 0,
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
      const epoch = this.calculationEpochs.get(id);
      this.calculationEpochs.set(id, epoch ?? state.epoch);
      if (
        !state.enabled ||
        (epoch !== undefined && epoch !== state.epoch) ||
        this.deletedCalculations.has(id) ||
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
  async updateNames(
    expected: HistoryEntry,
    names: HistoryNames,
  ): Promise<boolean> {
    let changed = false;
    await this.transaction((state) => {
      const entry = state.entries.find((e) => e.id === expected.id);
      if (
        !state.enabled ||
        !entry ||
        entry.calculationId !== expected.calculationId ||
        entry.snapshot.savedAt !== expected.snapshot.savedAt ||
        JSON.stringify(entry.snapshot.request) !==
          JSON.stringify(expected.snapshot.request)
      )
        return;
      for (const side of ["origin", "destination"] as const) {
        if (
          names[side] &&
          genericHistoryName(entry.snapshot.request[side].name) &&
          !entry.placeNames?.[side]
        ) {
          entry.placeNames = { ...entry.placeNames, [side]: names[side] };
          changed = true;
        }
      }
    });
    return changed;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.undoEpoch++;
    this.generation++;
    await this.transaction(
      (state) => {
        state.enabled = enabled;
        state.preferences.history = enabled;
      },
      this.generation,
      localDatabase.generation,
    );
  }
  async clear(): Promise<void> {
    this.undoEpoch++;
    this.generation++;
    await this.transaction(
      (state) => {
        state.entries = [];
        state.epoch++;
      },
      this.generation,
      localDatabase.generation,
    );
  }
  async remove(id: string): Promise<HistoryDeletion | undefined> {
    this.generation++;
    const epoch = this.undoEpoch;
    const databaseGeneration = localDatabase.generation;
    const alreadyDeleted = this.deleted.has(id);
    this.deleted.add(id);
    let entry: HistoryEntry | undefined;
    try {
      await this.transaction((state) => {
        entry = state.entries.find((item) => item.id === id);
        state.entries = state.entries.filter((item) => item.id !== id);
      });
    } catch (error) {
      if (!alreadyDeleted) this.deleted.delete(id);
      throw error;
    }
    if (!entry) return;
    this.deletedCalculations.add(entry.calculationId ?? entry.id);
    for (const [calculation, entryId] of this.calculationEntries)
      if (entryId === id) this.deletedCalculations.add(calculation);
    const token = { entry: structuredClone(entry), epoch, databaseGeneration };
    this.undoTokens.add(token);
    return token;
  }
  async restoreDeleted(
    token: HistoryDeletion,
  ): Promise<"restored" | "newer" | "unavailable"> {
    let result: "restored" | "newer" | "unavailable" = "unavailable";
    await this.transaction((state) => {
      if (
        !state.enabled ||
        !this.undoTokens.has(token) ||
        token.epoch !== this.undoEpoch ||
        token.databaseGeneration !== localDatabase.generation
      )
        return;
      if (
        state.entries.some((entry) =>
          sameHistoryRoute(
            entry.snapshot.request,
            token.entry.snapshot.request,
          ),
        )
      ) {
        result = "newer";
        return;
      }
      if (state.entries.length >= 20) return;
      state.entries = retainHistory(
        state.entries,
        structuredClone(token.entry),
      );
      result = "restored";
    });
    if (result !== "unavailable") {
      this.undoTokens.delete(token);
      // Old calculations remain blocked even after the entry itself is restored.
      this.deleted.delete(token.entry.id);
    }
    return result;
  }
}

export function historySnapshot(entry: HistoryEntry): SavedJourney {
  const snapshot = structuredClone(entry.snapshot);
  for (const side of ["origin", "destination"] as const) {
    const name = entry.placeNames?.[side];
    const original = entry.snapshot.request[side];
    if (!name || !genericHistoryName(original.name)) continue;
    for (const place of [
      snapshot.request[side],
      snapshot.journey[side],
      ...snapshot.journey.legs.flatMap((l) => [l.from, l.to]),
    ]) {
      if (
        genericHistoryName(place.name) &&
        coordinateKey(place) === coordinateKey(original)
      )
        place.name = name;
    }
  }
  return snapshot;
}
