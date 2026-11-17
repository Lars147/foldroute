import { migrateSettings } from "./model";
import { validStoredPlace, type StoredPlace } from "./places";
import { sameHistoryRoute, type HistoryEntry } from "./offline";
import { validHistorySnapshot } from "./snapshot-codec";
import {
  validNavigationStatistics,
  type NavigationStatistics,
} from "./navigation-summary";
import type { StoragePreferences } from "./storage-preferences";

export const backupLimit = 50 * 1024 * 1024;
export const backupKeys = [
  "foldroute.routing.v3",
  "foldroute.appearance",
  "foldroute.mapStyle",
  "foldroute.navigationAudio",
  "foldroute.screenAwake",
  "foldroute.routing.v1",
] as const;
export type BackupPreferences = Record<
  (typeof backupKeys)[number],
  string | null
>;
export interface FoldRouteBackup {
  format: "foldroute-backup";
  version: 1;
  exportedAt: string;
  settings: BackupPreferences;
  storage: StoragePreferences;
  places: StoredPlace[];
  history: HistoryEntry[];
  statistics: NavigationStatistics;
}
function reject(): never {
  throw new Error("Ungültige oder nicht unterstützte FoldRoute-Sicherung.");
}
export function validateBackup(input: unknown): FoldRouteBackup {
  if (!input || typeof input !== "object") reject();
  const b = input as FoldRouteBackup;
  if (
    b.format !== "foldroute-backup" ||
    b.version !== 1 ||
    typeof b.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(b.exportedAt))
  )
    reject();
  if (
    !b.settings ||
    typeof b.settings !== "object" ||
    backupKeys.some(
      (k) =>
        !(k in b.settings) ||
        (b.settings[k] !== null && typeof b.settings[k] !== "string"),
    )
  )
    reject();
  const s = b.settings;
  if (s["foldroute.routing.v1"] !== null) reject();
  if (
    s[backupKeys[0]] !== null &&
    !migrateSettings(JSON.parse(s[backupKeys[0]]!))
  )
    reject();
  if (
    s[backupKeys[1]] !== null &&
    !["system", "light", "dark"].includes(s[backupKeys[1]]!)
  )
    reject();
  if (
    s[backupKeys[2]] !== null &&
    !["positron", "liberty", "dark"].includes(s[backupKeys[2]]!)
  )
    reject();
  for (const k of [backupKeys[3], backupKeys[4]])
    if (s[k] !== null && !["true", "false"].includes(s[k]!)) reject();
  if (
    !b.storage ||
    ["history", "navigation", "statistics"].some(
      (k) => typeof b.storage[k as keyof StoragePreferences] !== "boolean",
    )
  )
    reject();
  if (
    !Array.isArray(b.places) ||
    !b.places.every(validStoredPlace) ||
    b.places.some((p) => !p.id) ||
    new Set(b.places.map((p) => p.id)).size !== b.places.length ||
    b.places.filter((p) => !p.favorite).length > 20
  )
    reject();
  if (
    !Array.isArray(b.history) ||
    b.history.length > 20 ||
    new Set(b.history.map((h) => h?.id)).size !== b.history.length ||
    b.history.some(
      (h, i) =>
        !h ||
        typeof h.id !== "string" ||
        !h.id ||
        !validHistorySnapshot(h.snapshot) ||
        (h.calculationId !== undefined &&
          (typeof h.calculationId !== "string" || !h.calculationId)) ||
        (h.placeNames !== undefined &&
          (!h.placeNames ||
            typeof h.placeNames !== "object" ||
            Array.isArray(h.placeNames) ||
            Object.values(h.placeNames).some(
              (n) => typeof n !== "string" || !n.trim(),
            ))) ||
        b.history
          .slice(0, i)
          .some((previous) =>
            sameHistoryRoute(previous.snapshot.request, h.snapshot.request),
          ),
    )
  )
    reject();
  if (!validNavigationStatistics(b.statistics)) reject();
  // Project the allowlist rather than retaining arbitrary imported keys.
  return {
    format: b.format,
    version: b.version,
    exportedAt: b.exportedAt,
    settings: Object.fromEntries(
      backupKeys.map((k) => [k, s[k]]),
    ) as BackupPreferences,
    storage: {
      history: b.storage.history,
      navigation: b.storage.navigation,
      statistics: b.storage.statistics,
    },
    places: structuredClone(b.places),
    history: structuredClone(b.history),
    statistics: structuredClone(b.statistics),
  };
}
export function encodeBackup(b: FoldRouteBackup): string {
  const text = JSON.stringify(validateBackup(b), null, 2);
  if (new Blob([text]).size > backupLimit)
    throw new Error("Sicherung überschreitet 50 MiB.");
  return text;
}
export async function decodeBackup(file: File): Promise<FoldRouteBackup> {
  if (file.size > backupLimit)
    throw new Error("Sicherung überschreitet 50 MiB.");
  return validateBackup(JSON.parse(await file.text()));
}

export interface BackupActions {
  create(): Promise<FoldRouteBackup>;
  restore(backup: FoldRouteBackup): Promise<void>;
}
