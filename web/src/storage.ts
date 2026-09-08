export class LocalDatabase {
  generation = 0;
  private database?: Promise<IDBDatabase>;

  open(): Promise<IDBDatabase> {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("foldroute-offline", 2);
      request.onupgradeneeded = () => {
        for (const name of ["state", "places"])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name);
      };
      request.onerror = () => {
        this.database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        this.database = undefined;
        reject(
          new Error(
            "Bitte andere FoldRoute-Fenster schließen und erneut versuchen.",
          ),
        );
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.database = undefined;
        };
        resolve(request.result);
      };
    }));
  }

  async clearAll(): Promise<void> {
    this.generation++;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["state", "places"], "readwrite");
      tx.objectStore("state").clear();
      tx.objectStore("places").clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
}

export const localDatabase = new LocalDatabase();
