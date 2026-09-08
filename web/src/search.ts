import type { Place, Coordinate } from "./model";
import { errorText } from "./model";
import { ApiClient } from "./transitous";
import { PlaceBook, samePlace } from "./places";
import { el, node, icon } from "./ui";

let lastLocation: { coordinate: Coordinate; timestamp: number } | undefined;
export function clearSearchLocation() {
  lastLocation = undefined;
}
function searchCenter(): Coordinate {
  return lastLocation && Date.now() - lastLocation.timestamp <= 60000
    ? lastLocation.coordinate
    : { latitude: 48.1372, longitude: 11.5756 };
}
export class PlaceSearch {
  input: HTMLInputElement;
  list: HTMLElement;
  value?: Place;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private version = 0;
  private active = -1;
  private options: Place[] = [];
  private visible = false;
  private prefilling = false;
  private buttons: HTMLButtonElement[] = [];
  constructor(
    public id: string,
    private api: ApiClient,
    private message: HTMLElement,
    private onSelect: (place: Place) => void,
    private book: PlaceBook,
    private onError: (message: string) => void,
  ) {
    this.input = el(id);
    this.list = el(`${id}-options`);
    this.input.setAttribute("aria-haspopup", "grid");
    this.list.setAttribute("role", "grid");
    this.book.subscribe(() => {
      if (this.visible) this.render();
    });
    this.input.addEventListener("focus", () => {
      if (!this.prefilling && !this.value) this.activate();
    });
    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.cancel();
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
      if (event.key === "Escape") {
        this.input.focus();
        this.cancel();
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
  activate() {
    this.visible = true;
    this.render();
  }
  private search() {
    this.value = undefined;
    this.cancel();
    this.visible = true;
    const version = this.version,
      query = this.input.value.trim();
    this.render();
    if (query.length < 2) {
      this.message.textContent = query.length
        ? "Mindestens zwei Zeichen eingeben."
        : "";
      return;
    }
    if (!navigator.onLine) {
      this.message.textContent =
        "Offline: Favoriten bleiben verfügbar. Neue Ortssuche benötigt Internet.";
      return;
    }
    this.timer = setTimeout(async () => {
      this.abort = new AbortController();
      this.message.textContent = "Orte werden gesucht …";
      try {
        const results = await this.api.searchPlaces(
          query,
          this.abort.signal,
          searchCenter(),
        );
        if (version !== this.version) return;
        this.options = results;
        this.render();
        this.message.textContent = this.buttons.length
          ? "Ort auswählen."
          : "Keine passenden Orte gefunden.";
      } catch (error) {
        if (version === this.version)
          this.message.textContent = errorText(error);
      }
    }, 280);
  }
  cancel() {
    this.version++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.options = [];
    this.buttons = [];
    this.active = -1;
    this.visible = false;
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
    this.set(place);
    this.input.focus({ preventScroll: true });
    this.message.textContent = "";
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
    this.cancel();
    this.value = undefined;
    this.input.value = place.name + " ";
    this.prefilling = true;
    this.input.focus();
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );
    this.prefilling = false;
    this.message.textContent = "Namen ergänzen oder Suchen drücken.";
  }
  private async chooseLocation() {
    this.cancel();
    const version = this.version;
    this.abort = new AbortController();
    this.message.textContent = "Standort wird ermittelt …";
    try {
      const place = await locate(this.abort.signal);
      if (version === this.version) this.choose(place);
    } catch (error) {
      if (version === this.version) this.message.textContent = errorText(error);
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
    const name = place?.name ?? "Aktueller Standort";
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
        favorite.disabled = true;
        try {
          await this.book.change(place, "favorite");
        } catch {
          this.onError(
            "Favorit konnte nicht gespeichert werden. Bitte erneut versuchen.",
          );
        } finally {
          favorite.disabled = false;
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
    const focused = this.list.contains(document.activeElement)
      ? document.activeElement?.getAttribute("aria-label")
      : undefined;
    this.list.replaceChildren();
    this.buttons = [];
    this.active = -1;
    this.input.removeAttribute("aria-activedescendant");
    const query = this.input.value.trim().toLocaleLowerCase("de");
    const favorites = this.book.favorites.filter(
      (e) =>
        !query ||
        `${e.place.name} ${e.place.detail}`
          .toLocaleLowerCase("de")
          .includes(query),
    );
    if (!query) this.row();
    if (favorites.length) {
      this.heading("Favoriten");
      favorites.forEach((e) => this.row(e.place));
    }
    if (!query && this.book.recent.length) {
      this.heading("Zuletzt verwendet");
      this.book.recent.forEach((e) => this.row(e.place));
    }
    const results = this.options.filter(
      (p, i, all) =>
        !favorites.some((e) => samePlace(e.place, p)) &&
        all.findIndex((other) => samePlace(other, p)) === i,
    );
    if (query && results.length) {
      this.heading("Suchergebnisse");
      results.forEach((p) => this.row(p));
    }
    this.list.hidden = !this.buttons.length;
    this.input.setAttribute("aria-expanded", String(!this.list.hidden));
    if (focused)
      Array.from(this.list.querySelectorAll<HTMLButtonElement>("button"))
        .find((b) => b.getAttribute("aria-label") === focused)
        ?.focus({ preventScroll: true });
  }
}
export function locate(signal?: AbortSignal): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (!window.isSecureContext) {
      reject(
        new Error(
          "Standort benötigt eine sichere Verbindung. Bitte die App über HTTPS öffnen.",
        ),
      );
      return;
    }
    if (!navigator.geolocation) {
      reject(new Error("Standort nicht verfügbar. Bitte Start wählen."));
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
        resolve({
          name: "Aktueller Standort",
          detail: "Standort dieser Abfrage",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        const message =
          error.code === 1
            ? "Standortzugriff nicht erlaubt. Bitte Standortberechtigung und Ortungsdienste in den Geräte- bzw. Browsereinstellungen prüfen. Danach erneut versuchen oder Start manuell wählen."
            : error.code === 3
              ? "Standortabfrage dauert zu lange. Bitte erneut versuchen oder Start manuell wählen."
              : "Standort konnte nicht ermittelt werden. Bitte Ortungsdienste und Empfang prüfen, erneut versuchen oder Start manuell wählen.";
        const detail = error.message?.trim();
        reject(
          new Error(
            `${message} Diagnose: Standortfehler ${error.code}${detail ? ` – ${detail}` : ""}.`,
          ),
        );
      },
      { timeout: 12000, maximumAge: 60000 },
    );
  });
}
