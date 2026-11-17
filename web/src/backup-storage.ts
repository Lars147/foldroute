import { migrateSettings } from "./model";
import { localDatabase } from "./storage";
import {
  backupKeys,
  validateBackup,
  type BackupPreferences,
  type FoldRouteBackup,
} from "./backup-codec";
import { emptyNavigationStatistics } from "./navigation-summary";
import { readStoragePreferences } from "./storage-preferences";

export class BackupRecoveryError extends Error {
  constructor() {
    super(
      "Wiederherstellung unterbrochen. Bitte FoldRoute neu öffnen, um den vorherigen Stand wiederherzustellen.",
    );
    this.name = "BackupRecoveryError";
  }
}
const journalKey = "backupRollback";
const pendingKey = "foldroute.backupPending";
function pendingRestore() {
  try {
    return localStorage.getItem(pendingKey);
  } catch {
    return null;
  }
}
function clearPending() {
  try {
    localStorage.removeItem(pendingKey);
  } catch {
    /* A committed marker can be retried on startup. */
  }
}
const lockName = "foldroute-backup-access";
let sharedOwner: { voluntary: boolean } | undefined;
let lostAccess = false;
let reloading = false;
let guardingReturn = false;
function guardForeground(event?: Event) {
  if (!lostAccess || document.hidden) return;
  event?.stopImmediatePropagation();
  if (reloading) return;
  reloading = true;
  document.body.inert = true;
  location.reload();
}
let sharedDone: Promise<unknown> | undefined;
let releaseShared: (() => void) | undefined;
let initializing: Promise<void> | undefined;
function preferences(): BackupPreferences {
  return Object.fromEntries(
    backupKeys.map((k) => [k, localStorage.getItem(k)]),
  ) as BackupPreferences;
}
function writePreferences(p: BackupPreferences) {
  for (const k of backupKeys) {
    if (p[k] === null) localStorage.removeItem(k);
    else localStorage.setItem(k, p[k]!);
  }
}
async function journal(): Promise<BackupPreferences | undefined> {
  const db = await localDatabase.open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state");
    const req = tx.objectStore("state").get(journalKey);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error);
  });
}
async function setJournal(value?: BackupPreferences) {
  const db = await localDatabase.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    if (value) tx.objectStore("state").put(value, journalKey);
    else tx.objectStore("state").delete(journalKey);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
export async function acquireBackupAccess() {
  if (!guardingReturn) {
    guardingReturn = true;
    window.addEventListener("pageshow", guardForeground, true);
    window.addEventListener("focus", guardForeground, true);
    document.addEventListener("visibilitychange", guardForeground, true);
  }
  if (!navigator.locks || releaseShared) return;
  const owner = { voluntary: false };
  await new Promise<void>((resolve, reject) => {
    sharedDone = navigator.locks
      .request(lockName, { mode: "shared" }, async () => {
        await new Promise<void>((release) => {
          sharedOwner = owner;
          releaseShared = release;
          resolve();
        });
      })
      .finally(() => {
        if (sharedOwner !== owner) return;
        sharedOwner = undefined;
        releaseShared = undefined;
        if (!owner.voluntary) {
          lostAccess = true;
          guardForeground();
        }
      })
      .catch(reject);
  });
}
async function exclusive<T>(
  action: () => Promise<T>,
  committedOutcome = false,
): Promise<T> {
  let completed = false;
  if (!navigator.locks)
    throw new Error(
      "Wiederherstellung wird von diesem Browser nicht unterstützt.",
    );
  if (sharedOwner) sharedOwner.voluntary = true;
  releaseShared?.();
  releaseShared = undefined;
  await sharedDone;
  try {
    return await navigator.locks.request(
      lockName,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error(
            "Bitte andere FoldRoute-Fenster schließen und erneut versuchen.",
          );
        const result = await action();
        completed = true;
        return result;
      },
    );
  } finally {
    try {
      await acquireBackupAccess();
    } catch (error) {
      if (!completed || !committedOutcome) throw error;
    }
  }
}
async function recover() {
  const old = await journal();
  if (!old) return;
  // A journal is internal state, but validate its allowlisted values before applying.
  if (
    backupKeys.some(
      (k) => !(k in old) || (old[k] !== null && typeof old[k] !== "string"),
    )
  )
    throw new Error("Wiederherstellungsprotokoll beschädigt.");
  if (localStorage.getItem(pendingKey)) writePreferences(old);
  await setJournal();
  localStorage.removeItem(pendingKey);
}
export function initializeBackupStorage() {
  return (initializing ??= (async () => {
    await acquireBackupAccess();
    // A failed database is handled by the existing storage UI. Never hide a
    // known unfinished restore: recovery failures must block initialization.
    let pending: BackupPreferences | undefined;
    try {
      pending = await journal();
    } catch (error) {
      if (pendingRestore()) throw error;
      return;
    }
    if (pending) await exclusive(recover);
    else clearPending();
  })());
}
export async function createBackup(): Promise<FoldRouteBackup> {
  const db = await localDatabase.open();
  const settings = preferences();
  const legacySettings = localStorage.getItem("foldroute.routing.v1");
  if (settings[backupKeys[0]] === null && legacySettings !== null)
    settings[backupKeys[0]] = JSON.stringify(
      migrateSettings(JSON.parse(legacySettings)),
    );
  settings["foldroute.routing.v1"] = null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["state", "places"]);
    const store = tx.objectStore("state");
    const history = store.get("history"),
      last = store.get("last"),
      stats = store.get("navigationStatistics"),
      prefs = store.get("storagePreferences"),
      enabled = store.get("enabled"),
      places = tx.objectStore("places").getAll();
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => {
      try {
        if (
          history.result !== undefined &&
          (history.result?.version !== 1 ||
            !Array.isArray(history.result.entries))
        )
          throw new Error("Gespeicherter Verlauf beschädigt.");
        if (
          prefs.result !== undefined &&
          (!prefs.result ||
            ["history", "navigation", "statistics"].some(
              (k) => typeof prefs.result[k] !== "boolean",
            ))
        )
          throw new Error("Speichereinstellungen beschädigt.");
        if (enabled.result !== undefined && typeof enabled.result !== "boolean")
          throw new Error("Speichereinstellungen beschädigt.");
        resolve(
          validateBackup({
            format: "foldroute-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            settings,
            storage: readStoragePreferences(prefs.result, enabled.result),
            places: places.result,
            history:
              history.result?.entries ??
              (last.result === undefined
                ? []
                : [{ id: "legacy", snapshot: last.result }]),
            statistics:
              stats.result === undefined
                ? emptyNavigationStatistics()
                : stats.result,
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
  });
}
export async function restoreBackup(
  input: FoldRouteBackup,
  quiesce: () => Promise<void>,
) {
  const backup = validateBackup(input);
  await exclusive(async () => {
    try {
      await recover();
    } catch {
      throw new BackupRecoveryError();
    }
    await quiesce();
    localDatabase.generation++;
    const old = preferences();
    await setJournal(old);
    try {
      localStorage.setItem(pendingKey, "true");
      writePreferences(backup.settings);
      const db = await localDatabase.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["state", "places"], "readwrite");
        const state = tx.objectStore("state"),
          places = tx.objectStore("places");
        for (const key of [
          "historyEpoch",
          "navigationResumeEpoch",
          "navigationStatisticsEpoch",
        ]) {
          const req = state.get(key);
          req.onsuccess = () => state.put((req.result ?? 0) + 1, key);
        }
        state.put({ version: 1, entries: backup.history }, "history");
        if (backup.history.length)
          state.put(backup.history[0].snapshot, "last");
        else state.delete("last");
        state.put(backup.statistics, "navigationStatistics");
        state.put(backup.storage, "storagePreferences");
        state.delete("enabled");
        state.delete("activeNavigation");
        state.delete(journalKey);
        places.clear();
        for (const place of backup.places) places.put(place, place.id);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } catch (error) {
      try {
        writePreferences(old);
        await setJournal();
        localStorage.removeItem(pendingKey);
      } catch {
        throw new BackupRecoveryError();
      }
      throw error;
    }
    try {
      localStorage.removeItem(pendingKey);
    } catch {
      /* Startup reconciles a committed restore marker. */
    }
  }, true);
}
