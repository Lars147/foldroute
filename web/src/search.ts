import { announceLocation, geolocationError } from "./live-location";
import type { Place, Coordinate } from "./model";
import { errorText } from "./model";
import { ApiClient } from "./transitous";
import { PlaceBook, samePlace } from "./places";
import { el, node, icon, setLocationFeedback } from "./ui";
import { reveal, stopMotion } from "./motion";

let lastLocation: { coordinate: Coordinate; timestamp: number } | undefined;
let searchLocationRequest:
  { controller: AbortController; promise: Promise<boolean> } | undefined;
export function clearSearchLocation() {
  searchLocationRequest?.controller.abort();
  searchLocationRequest = undefined;
  lastLocation = undefined;
}
function searchCenter(): Coordinate | undefined {
  return lastLocation && Date.now() - lastLocation.timestamp <= 60000
    ? lastLocation.coordinate
    : undefined;
}
export function prepareSearchLocation(): Promise<boolean> {
  if (searchCenter()) return Promise.resolve(false);
  if (searchLocationRequest) return searchLocationRequest.promise;
  if (!window.isSecureContext || !navigator.permissions?.query)
    return Promise.resolve(false);
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const permission = await navigator.permissions.query({
        name: "geolocation",
      });
      if (permission.state !== "granted" || controller.signal.aborted)
        return false;
      await requestLocation(controller.signal);
      return true;
    } catch {
      // Optional search bias must not block suggestions or request permission.
      return false;
    }
  })().finally(() => {
    if (searchLocationRequest?.controller === controller)
      searchLocationRequest = undefined;
  });
  searchLocationRequest = { controller, promise };
  return promise;
}
export class PlaceSearch {
  private static focusedSearch?: PlaceSearch;
  private static dialogSearch?: PlaceSearch;
  private static messages = new WeakMap<
    HTMLElement,
    { owner: PlaceSearch; text: string }
  >();
  input: HTMLInputElement;
  list: HTMLElement;
  value?: Place;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private version = 0;
  private active = -1;
  private options: Place[] = [];
  private visible = false;
  private browsing = false;
  private prefilling = false;
  private autoSelectSingle = false;
  private buttons: HTMLButtonElement[] = [];
  private focusBack?: HTMLButtonElement;
  private openingFocus = false;
  private readonly resizeFocus = () => {
    if (!matchMedia("(max-width: 899px)").matches) this.exitFocusMode();
  };
  private enterFocusMode() {
    if (
      this.focusBack ||
      this.openingFocus ||
      !matchMedia("(max-width: 899px)").matches
    )
      return;
    PlaceSearch.focusedSearch?.exitFocusMode();
    PlaceSearch.focusedSearch = this;
    const back = node("button", "‹ Zurück", "search-focus-back");
    back.type = "button";
    back.onclick = () => this.dismiss();
    this.focusBack = back;
    window.addEventListener("resize", this.resizeFocus);
    (this.input.closest("dialog") ?? document.body).append(back);
    document.body.classList.add("search-focus-mode");
    this.input.classList.add("search-focus-input");
    this.list.classList.add("search-focus-results");
    this.message.classList.add("search-focus-status");
  }
  private exitFocusMode() {
    if (!this.focusBack) return;
    window.removeEventListener("resize", this.resizeFocus);
    this.focusBack.remove();
    this.focusBack = undefined;
    PlaceSearch.focusedSearch = undefined;
    document.body.classList.remove("search-focus-mode");
    this.input.classList.remove("search-focus-input");
    this.list.classList.remove("search-focus-results");
    this.message.classList.remove("search-focus-status");
    this.input.blur();
  }
  constructor(
    public id: string,
    private api: ApiClient,
    private message: HTMLElement,
    private onSelect: (place: Place) => void,
    private book: PlaceBook,
    private onError: (message: string) => void,
    private settings: {
      showCurrentLocation?: boolean;
      focusDriven?: boolean;
      onDismiss?: () => void;
      getSearchCenter?: () => Coordinate | undefined;
    } = {},
  ) {
    this.input = el(id);
    this.list = el(`${id}-options`);
    this.input.setAttribute("aria-haspopup", "grid");
    this.list.setAttribute("role", "grid");
    this.book.subscribe(() => {
      if (this.visible) this.render();
    });
    this.input.addEventListener("focus", () => {
      this.enterFocusMode();
      if (!this.settings.getSearchCenter?.())
        void prepareSearchLocation().then((updated) => {
          if (
            updated &&
            this.visible &&
            !this.value &&
            document.activeElement === this.input &&
            this.input.value.trim().length >= 2
          )
            this.search(this.autoSelectSingle);
        });
      if (
        !this.openingFocus &&
        !this.prefilling &&
        (this.settings.focusDriven || !this.value)
      )
        this.activate();
    });
    {
      let pointing = false;
      let pointerTarget: EventTarget | null = null;
      // Safari does not focus clicked buttons. Keep the input focused until selection.
      this.list.addEventListener("mousedown", (event) => {
        if (this.settings.focusDriven) event.preventDefault();
      });
      this.input.addEventListener("click", () => {
        if (this.settings.focusDriven && !this.visible) this.activate();
      });
      const leave = (event?: FocusEvent) => {
        if (this.contains(event?.relatedTarget ?? null)) return;
        // Re-rendered result buttons can regain focus in the same turn.
        queueMicrotask(() => {
          if (
            !pointing &&
            !this.focusBack &&
            PlaceSearch.dialogSearch === this &&
            !this.contains(document.activeElement)
          )
            this.cancel();
        });
      };
      this.input.addEventListener("focusout", leave);
      this.list.addEventListener("focusout", leave);
      document.addEventListener(
        "pointerdown",
        (event) => {
          pointing = true;
          pointerTarget = event.target;
        },
        true,
      );
      document.addEventListener("pointerup", () => (pointing = false), true);
      document.addEventListener("pointercancel", () => {
        pointing = false;
        pointerTarget = null;
        leave();
      });
      // Do not collapse an inline list under a button between pointerdown and click.
      document.addEventListener("click", (event) => {
        const target = event.detail
          ? (pointerTarget ?? event.target)
          : event.target;
        pointerTarget = null;
        if (
          !this.focusBack &&
          PlaceSearch.dialogSearch === this &&
          !this.contains(target)
        )
          this.cancel();
      });
    }
    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (event) => {
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        this.settings.focusDriven &&
        this.visible &&
        this.buttons.length
      ) {
        event.preventDefault();
        this.buttons[0].focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!this.visible) this.activate();
        if (!this.buttons.length) return;
        event.preventDefault();
        this.active =
          (this.active +
            (event.key === "ArrowDown" ? 1 : -1) +
            this.buttons.length) %
          this.buttons.length;
        this.buttons.forEach((button, i) =>
          button.closest("li")!.classList.toggle("active", i === this.active),
        );
        this.input.setAttribute(
          "aria-activedescendant",
          this.buttons[this.active].parentElement!.id,
        );
        this.buttons[this.active].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (this.active >= 0 && this.visible)
          this.buttons[this.active]?.click();
        else this.search();
      }
    });
    this.list.addEventListener("keydown", (event) => {
      if (
        event.key === "Tab" &&
        event.shiftKey &&
        event.target === this.buttons[0] &&
        this.settings.focusDriven
      ) {
        event.preventDefault();
        this.openingFocus = true;
        this.input.focus({ preventScroll: true });
        this.openingFocus = false;
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const index = this.buttons.findIndex((b) =>
          b.closest("li")!.contains(document.activeElement),
        );
        if (index >= 0) {
          event.preventDefault();
          this.buttons[
            (index +
              (event.key === "ArrowDown" ? 1 : -1) +
              this.buttons.length) %
              this.buttons.length
          ].focus();
        }
      }
    });
  }
  private contains(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (target === this.input ||
        this.list.contains(target) ||
        this.message.contains(target))
    );
  }
  private claim() {
    if (!this.settings.focusDriven) return;
    if (PlaceSearch.dialogSearch !== this) PlaceSearch.dialogSearch?.cancel();
    PlaceSearch.dialogSearch = this;
  }
  private setMessage(text: string, locationHelp = false) {
    setLocationFeedback(this.message, text, locationHelp);
    PlaceSearch.messages.set(this.message, {
      owner: this,
      text: this.message.textContent ?? "",
    });
  }
  private clearMessage() {
    if (!this.settings.focusDriven) return;
    const message = PlaceSearch.messages.get(this.message);
    if (message?.owner !== this) return;
    if (this.message.textContent === message.text)
      this.message.textContent = "";
    PlaceSearch.messages.delete(this.message);
  }
  activate() {
    this.claim();
    this.browsing = !!this.settings.focusDriven;
    this.clearMessage();
    this.visible = true;
    this.render();
  }
  setFocusDriven(enabled: boolean) {
    this.cancel();
    this.settings.focusDriven = enabled;
  }
  searchShared(query: string) {
    this.input.value = query;
    this.search(true);
  }
  private search(autoSelectSingle = false) {
    this.value = undefined;
    this.cancel(true);
    this.autoSelectSingle = autoSelectSingle;
    this.claim();
    this.visible = true;
    const version = this.version,
      query = this.input.value.trim();
    this.render();
    if (query.length < 2) {
      this.setMessage(query.length ? "Mindestens zwei Zeichen eingeben." : "");
      return;
    }
    if (!navigator.onLine) {
      this.setMessage(
        "Offline: Favoriten bleiben verfügbar. Neue Ortssuche benötigt Internet.",
      );
      return;
    }
    this.timer = setTimeout(async () => {
      this.abort = new AbortController();
      this.setMessage("Orte werden gesucht …");
      try {
        const results = await this.api.searchPlaces(
          query,
          this.abort.signal,
          this.settings.getSearchCenter?.() ?? searchCenter(),
        );
        if (version !== this.version) return;
        this.options = results;
        if (autoSelectSingle && results.length === 1) {
          this.choose(results[0]);
          return;
        }
        this.render();
        this.setMessage(
          this.buttons.length
            ? "Ort auswählen."
            : "Keine passenden Orte gefunden.",
        );
      } catch (error) {
        if (version === this.version) this.setMessage(errorText(error));
      }
    }, 280);
  }
  private dismiss() {
    this.cancel();
    this.settings.onDismiss?.();
  }
  cancel(keepFocus = false) {
    if (PlaceSearch.dialogSearch === this) PlaceSearch.dialogSearch = undefined;
    this.clearMessage();
    if (!keepFocus) this.exitFocusMode();
    this.version++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.options = [];
    this.buttons = [];
    this.active = -1;
    this.visible = false;
    this.browsing = false;
    this.autoSelectSingle = false;
    this.list.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }
  set(place?: Place) {
    this.cancel();
    this.value = place;
    this.input.value = place?.name ?? "";
  }
  choose(place: Place) {
    const wasFocused = !!this.focusBack;
    this.set(place);
    this.exitFocusMode();
    this.openingFocus = true;
    if (!wasFocused) this.input.focus({ preventScroll: true });
    this.openingFocus = false;
    this.setMessage("");
    void this.book
      .change(place, "use")
      .catch(() =>
        this.onError(
          "Ort konnte nicht gespeichert werden. Die Planung bleibt möglich.",
        ),
      );
    this.onSelect(place);
  }
  private prefill(place: Place) {
    this.cancel(true);
    this.claim();
    this.value = undefined;
    this.input.value = place.name + " ";
    this.prefilling = true;
    this.input.focus();
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );
    this.prefilling = false;
    this.setMessage("Namen ergänzen oder Suchen drücken.");
  }
  private async chooseLocation() {
    this.cancel(true);
    this.claim();
    this.openingFocus = true;
    this.input.focus({ preventScroll: true });
    this.openingFocus = false;
    const version = this.version;
    this.abort = new AbortController();
    this.setMessage("Standort wird ermittelt …");
    try {
      const place = await locate(this.abort.signal);
      if (version === this.version) this.choose(place);
    } catch (error) {
      if (version === this.version) this.setMessage(errorText(error), true);
    }
  }
  private heading(text: string) {
    const row = node("li", "", "suggestion-heading"),
      cell = node("span", text);
    row.setAttribute("role", "row");
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-colspan", "3");
    row.append(cell);
    this.list.append(row);
  }
  private row(place?: Place) {
    const li = node("li"),
      select = node("button", "", "place-select");
    li.setAttribute("role", "row");
    if (!place) li.className = "current-location-option";
    const name = place?.name ?? "Aktueller Standort";
    li.dataset.placeKey = JSON.stringify([
      name,
      place?.latitude,
      place?.longitude,
    ]);
    const copy = node("span");
    copy.append(
      node("strong", name),
      node("small", place?.detail ?? "Standort ermitteln"),
    );
    select.type = "button";
    select.append(icon(place?.stopId ? "transit" : "location"), copy);
    select.setAttribute(
      "aria-label",
      `Ort auswählen: ${name}${place?.detail ? `, ${place.detail}` : ""}`,
    );
    select.onclick = () =>
      place ? this.choose(place) : void this.chooseLocation();
    const cell = node("span");
    cell.setAttribute("role", "gridcell");
    cell.id = `${this.id}-option-${this.buttons.length}`;
    cell.append(select);
    li.append(cell);
    this.buttons.push(select);
    if (place) {
      const favorite = node(
        "button",
        this.book.isFavorite(place) ? "★" : "☆",
        "place-favorite",
      );
      favorite.type = "button";
      favorite.setAttribute("aria-label", `${name}: Favorit`);
      favorite.setAttribute(
        "aria-pressed",
        String(this.book.isFavorite(place)),
      );
      favorite.onclick = async () => {
        if (favorite.getAttribute("aria-disabled") === "true") return;
        // Keep focus inside the list while IndexedDB updates and re-renders it.
        favorite.setAttribute("aria-disabled", "true");
        try {
          await this.book.change(place, "favorite");
        } catch {
          this.onError(
            "Favorit konnte nicht gespeichert werden. Bitte erneut versuchen.",
          );
        } finally {
          favorite.removeAttribute("aria-disabled");
        }
      };
      const favoriteCell = node("span");
      favoriteCell.setAttribute("role", "gridcell");
      favoriteCell.append(favorite);
      li.append(favoriteCell);
      if (this.input.value.trim()) {
        const prefill = node("button", "↖", "place-prefill");
        prefill.type = "button";
        prefill.setAttribute("aria-label", `${name} ins Suchfeld übernehmen`);
        prefill.onclick = () => this.prefill(place);
        const prefillCell = node("span");
        prefillCell.setAttribute("role", "gridcell");
        prefillCell.append(prefill);
        li.append(prefillCell);
      }
    }
    this.list.append(li);
  }
  private render() {
    const opening = this.list.hidden;
    const focused = this.list.contains(document.activeElement)
      ? {
          key: (document.activeElement as HTMLElement).closest("li")?.dataset
            .placeKey,
          action: (document.activeElement as HTMLElement).className,
        }
      : undefined;
    this.list.replaceChildren();
    this.buttons = [];
    this.active = -1;
    this.input.removeAttribute("aria-activedescendant");
    const query = this.browsing
      ? ""
      : this.input.value.trim().toLocaleLowerCase("de");
    const favorites = this.book.favorites
      .map(({ place }) => {
        const detail = this.options.find((option) =>
          samePlace(place, option),
        )?.detail;
        return detail ? { ...place, detail } : place;
      })
      .filter(
        (place) =>
          !query ||
          `${place.name} ${place.detail}`
            .toLocaleLowerCase("de")
            .includes(query),
      );
    if (!query && this.settings.showCurrentLocation !== false) this.row();
    if (favorites.length) {
      this.heading("Favoriten");
      favorites.forEach((place) => this.row(place));
    }
    if (!query && this.book.recent.length) {
      this.heading("Zuletzt verwendet");
      this.book.recent.forEach((e) => this.row(e.place));
    }
    const results = this.options.filter(
      (p, i, all) =>
        !favorites.some((place) => samePlace(place, p)) &&
        all.findIndex((other) => samePlace(other, p)) === i,
    );
    if (query && results.length) {
      this.heading("Suchergebnisse");
      results.forEach((p) => this.row(p));
    }
    this.list.hidden = !this.buttons.length;
    if (this.list.hidden) stopMotion(this.list);
    else if (opening)
      reveal(this.list, { y: 5, duration: 0.12, fromOpacity: 0.7 });
    this.input.setAttribute("aria-expanded", String(!this.list.hidden));
    if (focused) {
      const replacement = Array.from(
        this.list.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (b) =>
          b.className === focused.action &&
          b.closest("li")?.dataset.placeKey === focused.key,
      );
      if (replacement) replacement.focus({ preventScroll: true });
      else if (this.settings.focusDriven) {
        this.openingFocus = true;
        this.input.focus({ preventScroll: true });
        this.openingFocus = false;
      }
    }
  }
}
function requestLocation(signal?: AbortSignal): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (!window.isSecureContext) {
      reject(geolocationError(2));
      return;
    }
    if (!navigator.geolocation) {
      reject(geolocationError(2));
      return;
    }
    const abort = () => reject(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return;
        lastLocation = {
          coordinate: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
          timestamp: position.timestamp,
        };
        resolve(position);
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        reject(geolocationError(error.code));
      },
      { timeout: 12000, maximumAge: 60000 },
    );
  });
}
export async function locate(signal?: AbortSignal): Promise<Place> {
  const position = await requestLocation(signal);
  signal?.throwIfAborted();
  announceLocation(position);
  return {
    name: "Aktueller Standort",
    detail: "Standort dieser Abfrage",
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };
}
