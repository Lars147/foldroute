import { localDatabase } from "./storage";

export interface StoragePreferences {
  history: boolean;
  navigation: boolean;
  statistics: boolean;
}
export const defaultStoragePreferences: StoragePreferences = {
  history: true,
  navigation: true,
  statistics: true,
};

export function readStoragePreferences(
  value: unknown,
  legacyEnabled: unknown,
): StoragePreferences {
  const fallback = legacyEnabled !== false;
  const stored =
    value && typeof value === "object"
      ? (value as Partial<StoragePreferences>)
      : {};
  return {
    history: typeof stored.history === "boolean" ? stored.history : fallback,
    navigation:
      typeof stored.navigation === "boolean" ? stored.navigation : fallback,
    statistics:
      typeof stored.statistics === "boolean" ? stored.statistics : fallback,
  };
}

export class StoragePreferencesStore {
  async set(
    key: keyof StoragePreferences,
    enabled: boolean,
  ): Promise<StoragePreferences> {
    const generation = localDatabase.generation;
    const db = await localDatabase.open();
    if (generation !== localDatabase.generation)
      throw new Error("Lokale Daten wurden inzwischen gelöscht.");
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"),
        store = tx.objectStore("state");
      const legacy = store.get("enabled"),
        current = store.get("storagePreferences");
      let preferences: StoragePreferences;
      current.onsuccess = () => {
        preferences = {
          ...readStoragePreferences(current.result, legacy.result),
          [key]: enabled,
        };
        store.put(preferences, "storagePreferences");
      };
      tx.oncomplete = () => resolve(preferences);
      tx.onabort = () => reject(tx.error);
    });
  }
}
