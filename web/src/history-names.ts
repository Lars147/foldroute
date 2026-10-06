import type { Coordinate } from "./model";
import type { HistoryEntry } from "./offline";
import { distance } from "./geometry";

export type HistoryNames = Partial<Record<"origin" | "destination", string>>;
export const genericHistoryName = (name: string) =>
  ["aktueller standort", "startpunkt", "zielpunkt"].includes(
    name.trim().toLocaleLowerCase("de"),
  );
export const coordinateKey = (p: Coordinate) => `${p.latitude},${p.longitude}`;
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export function reverseAddress(
  raw: unknown,
  coordinate: Coordinate,
): string | undefined {
  if (!Array.isArray(raw)) return;
  const matches = raw
    .filter(
      (p) =>
        p &&
        p.type === "ADDRESS" &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lon) <= 180,
    )
    .sort(
      (a, b) =>
        distance(coordinate, { latitude: a.lat, longitude: a.lon }) -
        distance(coordinate, { latitude: b.lat, longitude: b.lon }),
    );
  const match = matches[0];
  if (!match) return;
  const areas: Array<{
    name?: string;
    default?: boolean;
    unique?: boolean;
    adminLevel?: number;
  } | null> = Array.isArray(match.areas) ? match.areas : [];
  const city =
    clean(areas.find((a) => a?.default)?.name) ||
    clean(areas.find((a) => a?.unique && (a.adminLevel ?? 0) >= 6)?.name);
  const district = clean(areas.find((a) => (a?.adminLevel ?? 0) >= 9)?.name);
  const street =
    distance(coordinate, { latitude: match.lat, longitude: match.lon }) <= 100
      ? clean(match.street)
      : "";
  const address = street
    ? [street, clean(match.houseNumber)].filter(Boolean).join(" ")
    : district;
  return [...new Set([address, city].filter(Boolean))].join(", ") || undefined;
}

/** One lookup at a time; names are display metadata, never route coordinates. */
export class HistoryNameQueue {
  private active = false;
  private pending = new Map<string, HistoryEntry>();
  private running?: AbortController;
  private cache = new Map<string, string>();
  private retryAt = new Map<string, number>();
  constructor(
    private resolve: (
      coordinate: Coordinate,
      signal: AbortSignal,
    ) => Promise<string | undefined>,
    private save: (entry: HistoryEntry, names: HistoryNames) => Promise<void>,
  ) {}
  setActive(active: boolean) {
    this.active = active;
    if (!active) {
      this.pending.clear();
      this.running?.abort();
    } else this.start();
  }
  clear() {
    this.pending.clear();
    this.cache.clear();
    this.retryAt.clear();
    this.running?.abort();
  }
  enqueue(entries: HistoryEntry[]) {
    if (!this.active) return;
    for (const entry of entries) {
      for (const side of ["origin", "destination"] as const) {
        const name = entry.placeNames?.[side];
        if (name && genericHistoryName(entry.snapshot.request[side].name))
          this.cache.set(coordinateKey(entry.snapshot.request[side]), name);
      }
      this.pending.set(entry.id, entry);
    }
    this.start();
  }
  private start() {
    if (!this.active || this.running || !this.pending.size) return;
    const abort = new AbortController();
    this.running = abort;
    void this.drain(abort.signal).finally(() => {
      this.running = undefined;
      this.start();
    });
  }
  private async drain(signal: AbortSignal) {
    while (this.active && !signal.aborted && this.pending.size) {
      const entry = this.pending.values().next().value!;
      this.pending.delete(entry.id);
      const names: HistoryNames = {};
      for (const side of ["origin", "destination"] as const) {
        const place = entry.snapshot.request[side];
        if (!genericHistoryName(place.name) || entry.placeNames?.[side])
          continue;
        const key = coordinateKey(place);
        let name = this.cache.get(key);
        if (!name && (this.retryAt.get(key) ?? 0) <= Date.now()) {
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), 10000);
          try {
            name = await this.resolve(
              place,
              AbortSignal.any([signal, timeout.signal]),
            );
          } catch {
            /* Optional enrichment must not interrupt saved journeys. */
          } finally {
            clearTimeout(timer);
          }
          if (signal.aborted) return;
          if (name) this.cache.set(key, name);
          else this.retryAt.set(key, Date.now() + 300000);
        }
        if (name) names[side] = name;
      }
      if (signal.aborted) return;
      if (Object.keys(names).length) {
        try {
          await this.save(entry, names);
        } catch {
          /* A later history visit can retry saving the cached name. */
        }
      }
    }
  }
}
