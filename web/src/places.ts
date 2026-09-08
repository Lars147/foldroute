import type { Place } from "./model";
import { distance, validCoordinate } from "./geometry";
import { localDatabase } from "./storage";

export interface StoredPlace {
  id: string;
  place: Place;
  favorite: boolean;
  lastUsedAt?: number;
}
export const samePlace = (a: Place, b: Place) =>
  a.name.localeCompare(b.name, "de", { sensitivity: "accent" }) === 0 &&
  distance(a, b) <= 25;

export function validStoredPlace(value: unknown): value is StoredPlace {
  if (!value || typeof value !== "object") return false;
  const v = value as StoredPlace;
  return (
    typeof v.id === "string" &&
    typeof v.favorite === "boolean" &&
    !!v.place &&
    validCoordinate(v.place) &&
    typeof v.place.name === "string" &&
    typeof v.place.detail === "string" &&
    (v.place.stopId === undefined || typeof v.place.stopId === "string") &&
    (v.lastUsedAt === undefined || Number.isFinite(v.lastUsedAt))
  );
}

export function updatedPlaces(
  entries: StoredPlace[],
  place: Place,
  action: "use" | "favorite",
  now: number,
): StoredPlace[] {
  if (place.name === "Aktueller Standort") return entries;
  const previous = entries.find((e) => samePlace(e.place, place));
  const entry: StoredPlace = {
    id: previous?.id ?? crypto.randomUUID(),
    place: { ...place, stopId: place.stopId ?? previous?.place.stopId },
    favorite:
      action === "favorite"
        ? !previous?.favorite
        : (previous?.favorite ?? false),
    lastUsedAt: action === "use" ? now : previous?.lastUsedAt,
  };
  const all = entries.filter((e) => e.id !== entry.id);
  if (entry.favorite || entry.lastUsedAt !== undefined) all.push(entry);
  return [
    ...all.filter((e) => e.favorite),
    ...all
      .filter((e) => !e.favorite)
      .sort((a, b) => b.lastUsedAt! - a.lastUsedAt!)
      .slice(0, 20),
  ];
}

export class PlaceBook {
  entries: StoredPlace[] = [];
  private listeners = new Set<() => void>();
  private generation = 0;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
  }
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  get favorites() {
    return this.entries
      .filter((e) => e.favorite)
      .sort((a, b) => a.place.name.localeCompare(b.place.name, "de"));
  }
  get recent() {
    return this.entries
      .filter((e) => !e.favorite && e.lastUsedAt !== undefined)
      .sort((a, b) => b.lastUsedAt! - a.lastUsedAt!)
      .slice(0, 5);
  }
  isFavorite(place: Place) {
    return this.entries.some((e) => e.favorite && samePlace(e.place, place));
  }
  reset() {
    this.generation++;
    this.entries = [];
    this.emit();
  }

  async load() {
    const generation = this.generation;
    const db = await localDatabase.open();
    const entries = await new Promise<StoredPlace[]>((resolve, reject) => {
      const tx = db.transaction("places", "readonly");
      const request = tx.objectStore("places").getAll();
      tx.oncomplete = () => resolve(request.result.filter(validStoredPlace));
      tx.onabort = () => reject(tx.error);
    });
    if (generation === this.generation) {
      this.entries = entries;
      this.emit();
    }
  }

  async change(place: Place, action: "use" | "favorite") {
    if (place.name === "Aktueller Standort") return;
    const generation = ++this.generation,
      epoch = localDatabase.generation;
    const db = await localDatabase.open();
    if (epoch !== localDatabase.generation) return;
    const entries = await new Promise<StoredPlace[]>((resolve, reject) => {
      const tx = db.transaction("places", "readwrite"),
        store = tx.objectStore("places");
      const request = store.getAll();
      let updated: StoredPlace[];
      request.onsuccess = () => {
        updated = updatedPlaces(
          request.result.filter(validStoredPlace),
          place,
          action,
          Date.now(),
        );
        store.clear();
        updated.forEach((e) => store.put(e, e.id));
      };
      tx.oncomplete = () => resolve(updated);
      tx.onabort = () => reject(tx.error);
    });
    if (generation === this.generation && epoch === localDatabase.generation) {
      this.entries = entries;
      this.emit();
    }
  }
}
