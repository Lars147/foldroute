/** Invalidate pending writes in other tabs as well as deleting the totals. */
export function resetNavigationStatistics(store: IDBObjectStore) {
  store.delete("navigationStatistics");
  const epoch = store.get("navigationStatisticsEpoch");
  epoch.onsuccess = () =>
    store.put((epoch.result ?? 0) + 1, "navigationStatisticsEpoch");
}
