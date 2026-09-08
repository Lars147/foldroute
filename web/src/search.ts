import type { Place } from "./model";
import { errorText } from "./model";
import { ApiClient } from "./transitous";
import { el, node, icon } from "./ui";
export class PlaceSearch {
  input: HTMLInputElement;
  list: HTMLElement;
  value?: Place;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private version = 0;
  private active = -1;
  private options: Place[] = [];
  constructor(
    public id: string,
    private api: ApiClient,
    private message: HTMLElement,
    private onSelect: (place: Place) => void,
  ) {
    this.input = el(id);
    this.list = el(`${id}-options`);
    this.input.addEventListener("input", () => {
      this.value = undefined;
      this.cancel();
      const version = this.version,
        query = this.input.value.trim();
      if (query.length < 3) {
        this.message.textContent = "Mindestens drei Zeichen eingeben.";
        return;
      }
      if (!navigator.onLine) {
        this.message.textContent =
          "Für die Ortssuche brauchst du eine Internetverbindung.";
        return;
      }
      this.timer = setTimeout(async () => {
        this.abort = new AbortController();
        this.message.textContent = "Orte werden gesucht …";
        try {
          const results = await this.api.searchPlaces(query, this.abort.signal);
          if (version !== this.version) return;
          this.options = results;
          this.render();
          this.message.textContent = results.length
            ? "Ort auswählen."
            : "Keine passenden Orte gefunden.";
        } catch (error) {
          if (version === this.version)
            this.message.textContent = errorText(error);
        }
      }, 400);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.cancel();
        return;
      }
      if (this.list.hidden || !this.options.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.active =
          (this.active +
            (event.key === "ArrowDown" ? 1 : -1) +
            this.options.length) %
          this.options.length;
        Array.from(this.list.children).forEach((child, i) =>
          child.setAttribute("aria-selected", String(i === this.active)),
        );
        this.input.setAttribute(
          "aria-activedescendant",
          `${this.id}-option-${this.active}`,
        );
        this.list.children[this.active].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (this.active >= 0) this.choose(this.options[this.active]);
      }
    });
  }
  cancel() {
    this.version++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.options = [];
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
    this.message.textContent = "";
    this.onSelect(place);
  }
  private render() {
    this.list.replaceChildren();
    this.active = -1;
    this.options.forEach((place, i) => {
      const li = node("li");
      li.id = `${this.id}-option-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      const copy = node("span");
      copy.append(node("strong", place.name), node("small", place.detail));
      li.append(
        icon(place.stopId ? "transit" : "location"),
        copy,
        icon("chevron"),
      );
      li.addEventListener("mousedown", (event) => event.preventDefault());
      li.addEventListener("click", () => this.choose(place));
      this.list.append(li);
    });
    this.list.hidden = !this.options.length;
    this.input.setAttribute("aria-expanded", String(!!this.options.length));
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
