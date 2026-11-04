import {
  parseSharedDestination,
  shareKeys,
  unsupportedShare,
  type SharePayload,
} from "./shared-destination";
import { PlaceSearch } from "./search";
import type { Place } from "./model";
import type { ApiClient } from "./transitous";
import type { PlaceBook } from "./places";
import type { NavigationSnapshot } from "./navigation-store";
import { afterStartup } from "./startup";

interface ShareImportDependencies {
  api: ApiClient;
  book: PlaceBook;
  notify(message: string): void;
  beforeAccept(): void;
  navigation: {
    active(): boolean;
    end(): Promise<void>;
    resume(snapshot: NavigationSnapshot): Promise<void>;
    clearSaved(): Promise<void>;
  };
  prepareDestination(place: Place): void;
  startDestination(place: Place): Promise<void>;
}
const storageKey = "foldroute.sharedDestination.v1";

/** Owns the pending import and its dialogs, independently of planning and navigation. */
export class ShareImportController {
  private pending?: { id: string; payload: SharePayload };
  private resume?: NavigationSnapshot;
  private initialized = false;
  private disposed = false;
  private readonly events = new AbortController();
  private readonly dialog: HTMLDialogElement;
  private readonly navigationDialog: HTMLDialogElement;
  private readonly search: PlaceSearch;
  get hasPending() {
    return !!this.pending;
  }

  constructor(
    private root: ParentNode,
    private dependencies: ShareImportDependencies,
    private initial?: SharePayload,
  ) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const item = JSON.parse(raw);
        if (
          typeof item.id === "string" &&
          item.payload &&
          ["title", "text", "url"].every(
            (key) =>
              item.payload[key] === undefined ||
              typeof item.payload[key] === "string",
          )
        )
          this.pending = item;
      }
    } catch {
      /* A pending import remains usable without storage. */
    }
    if (initial) {
      this.pending = { id: crypto.randomUUID(), payload: initial };
      try {
        localStorage.setItem(storageKey, JSON.stringify(this.pending));
      } catch {
        /* Session-only import. */
      }
      const clean = new URL(location.href);
      for (const key of shareKeys) clean.searchParams.delete(key);
      history.replaceState(history.state, "", clean);
    }
    this.dialog = this.element<HTMLDialogElement>("shared-dialog");
    this.navigationDialog = this.element<HTMLDialogElement>(
      "shared-navigation-dialog",
    );
    this.search = new PlaceSearch(
      "shared-destination",
      dependencies.api,
      this.element("shared-status"),
      (place) => void this.accept(place),
      dependencies.book,
      dependencies.notify,
      { showCurrentLocation: false },
    );
    this.on("shared-pending", () => this.open());
    this.on("shared-cancel", () => this.dialog.close());
    this.on("shared-discard", () => {
      this.forget();
      this.dialog.close();
    });
    this.dialog.addEventListener(
      "close",
      () => {
        this.search.cancel();
        this.render();
      },
      { signal: this.events.signal },
    );
    this.navigationDialog.addEventListener("close", () => this.render(), {
      signal: this.events.signal,
    });
    this.on("shared-navigation-keep", () => this.keepNavigation());
    this.navigationDialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this.keepNavigation();
      },
      { signal: this.events.signal },
    );
    this.on("shared-navigation-replace", () => void this.replaceNavigation());
    this.render();
  }
  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Share import element missing: ${id}`);
    return element;
  }
  private on(id: string, action: () => void) {
    this.element(id).addEventListener("click", action, {
      signal: this.events.signal,
    });
  }
  private render() {
    this.element("shared-pending").hidden =
      !this.pending || this.dialog.open || this.navigationDialog.open;
  }
  forget() {
    const id = this.pending?.id;
    this.pending = undefined;
    try {
      if (JSON.parse(localStorage.getItem(storageKey) ?? "null")?.id === id)
        localStorage.removeItem(storageKey);
    } catch {
      /* The accepted import already belongs to the planning context. */
    }
    this.render();
  }
  clearPersisted() {
    this.forget();
    localStorage.removeItem(storageKey);
  }
  setResume(snapshot: NavigationSnapshot) {
    this.resume = snapshot;
  }
  clearResume() {
    this.resume = undefined;
  }
  initializeInitialShare(): boolean {
    if (!this.initial || this.initialized) return false;
    this.initialized = true;
    this.open();
    return true;
  }
  open() {
    if (!this.pending) return;
    if (this.dependencies.navigation.active() || this.resume) {
      const parsed = parseSharedDestination(this.pending.payload);
      const label =
        parsed.kind === "place"
          ? parsed.place.name
          : parsed.kind === "query"
            ? parsed.query
            : "das geteilte Ziel";
      this.element("shared-navigation-description").textContent =
        `Neue Route zu ${label} planen? Die laufende Navigation wird beendet.`;
      const id = this.pending.id;
      afterStartup(() => {
        if (!this.disposed && this.pending?.id === id) {
          this.navigationDialog.showModal();
          this.render();
        }
      });
    } else this.present();
  }
  private present() {
    if (!this.pending) return;
    const parsed = parseSharedDestination(this.pending.payload);
    if (parsed.kind === "place") {
      void this.accept(parsed.place);
      return;
    }
    this.search.set();
    this.element("shared-error").textContent =
      parsed.kind === "query"
        ? ""
        : parsed.kind === "invalid"
          ? "Geteiltes Ziel ungültig. Bitte Ziel eingeben."
          : unsupportedShare;
    const id = this.pending.id;
    if (parsed.kind === "query") this.search.searchShared(parsed.query);
    afterStartup(() => {
      if (this.disposed || this.pending?.id !== id) return;
      this.dialog.showModal();
      this.render();
      if (parsed.kind === "query") this.search.input.focus();
    });
  }
  private async accept(place: Place) {
    this.dependencies.beforeAccept();
    this.search.cancel();
    this.dialog.close();
    this.dependencies.prepareDestination(place);
    this.forget();
    await this.dependencies.startDestination(place);
  }
  private keepNavigation() {
    this.navigationDialog.close();
    const snapshot = this.resume;
    this.resume = undefined;
    if (snapshot) void this.dependencies.navigation.resume(snapshot);
  }
  private async replaceNavigation() {
    this.navigationDialog.close();
    if (this.dependencies.navigation.active())
      await this.dependencies.navigation.end();
    else if (this.resume) {
      try {
        await this.dependencies.navigation.clearSaved();
      } catch {
        if (!this.disposed)
          this.dependencies.notify(
            "Gespeicherte Navigation konnte nicht gelöscht werden.",
          );
        return;
      }
    }
    this.resume = undefined;
    if (!this.disposed) this.present();
  }
  dispose() {
    this.disposed = true;
    this.events.abort();
    this.search.dispose();
    this.dialog.close();
    this.navigationDialog.close();
  }
}
