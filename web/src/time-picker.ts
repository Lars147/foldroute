import type { Timing } from "./model";
import { el, node } from "./ui";

export function localMinute(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function parseLocalMinute(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && localMinute(date) === value
    ? date
    : undefined;
}
export function timeSummary(mode: Timing, value: string): string {
  if (mode === "now") return "Jetzt";
  const date = parseLocalMinute(value);
  if (!date) return "Zeitpunkt wählen";
  const today = localMinute(new Date()).slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day =
    value.slice(0, 10) === today
      ? "Heute"
      : value.slice(0, 10) === localMinute(tomorrow).slice(0, 10)
        ? "Morgen"
        : date.toLocaleDateString("de-DE", {
            day: "numeric",
            month: "short",
            year:
              date.getFullYear() === new Date().getFullYear()
                ? undefined
                : "numeric",
          });
  return `${day}, ${mode === "arrive" ? "an" : "ab"} ${value.slice(11)}`;
}
export class TimePicker {
  private mode: Timing = "now";
  private day = "";
  private month = new Date();
  private timer?: ReturnType<typeof setInterval>;
  private get active() {
    return !el("time-editor").hidden;
  }
  constructor(private changed: () => void) {
    el("time-trigger").onclick = () => this.open();
    el("time-cancel").onclick = () => this.close();
    el("time-now").onclick = () => {
      this.mode = "now";
      this.refreshNow();
      this.render();
    };
    for (const mode of ["depart", "arrive"] as const)
      el(`time-${mode}`).onclick = () => {
        if (this.mode !== "now" || mode === "arrive") this.mode = mode;
        this.render();
      };
    el("time-previous").onclick = () => this.changeMonth(-1);
    el("time-next").onclick = () => this.changeMonth(1);
    for (const delta of [-5, 5])
      el(delta < 0 ? "time-minus" : "time-plus").onclick = () => {
        const date = this.date();
        if (!date) return;
        date.setMinutes(date.getMinutes() + delta);
        this.setFixedDate(date);
        this.render();
      };
    el("time-clock").onblur = () => {
      const date = this.date();
      if (date)
        el<HTMLInputElement>("time-clock").value = localMinute(date).slice(11);
      this.validate();
    };
    el("time-clock").oninput = () => {
      if (this.mode === "now") this.mode = "depart";
      this.validate();
      this.renderMode();
    };
    el("time-editor").onsubmit = (event) => {
      event.preventDefault();
      if (!this.validate()) return;
      el<HTMLInputElement>("timing").value = this.mode;
      el<HTMLInputElement>("when").value = localMinute(
        this.mode === "now" ? this.now() : this.date()!,
      );
      this.changed();
      this.close();
    };
    const dialog = el<HTMLDialogElement>("adjust-dialog");
    dialog.addEventListener("cancel", (event) => {
      if (this.active) {
        event.preventDefault();
        this.close();
      }
    });
    dialog.addEventListener("close", () => this.close(false));
    document.addEventListener("visibilitychange", () => {
      if (this.active) this.tick();
    });
  }
  private now() {
    return new Date();
  }
  private date() {
    const clock = el<HTMLInputElement>("time-clock").value.replace(
      /^(\d{2})(\d{2})$/,
      "$1:$2",
    );
    return parseLocalMinute(`${this.day}T${clock}`);
  }
  private refreshNow() {
    const date = this.now();
    this.day = localMinute(date).slice(0, 10);
    this.month = new Date(date.getFullYear(), date.getMonth(), 1);
    el<HTMLInputElement>("time-clock").value = localMinute(date).slice(11);
  }
  private setFixedDate(date: Date) {
    if (this.mode === "now") this.mode = "depart";
    this.day = localMinute(date).slice(0, 10);
    this.month = new Date(date.getFullYear(), date.getMonth(), 1);
    el<HTMLInputElement>("time-clock").value = localMinute(date).slice(11);
  }
  private tick() {
    if (this.mode === "now") {
      this.refreshNow();
      this.render();
    } else this.validate();
  }
  open() {
    this.mode = el<HTMLInputElement>("timing").value as Timing;
    if (this.mode === "now") this.refreshNow();
    else
      this.setFixedDate(
        parseLocalMinute(el<HTMLInputElement>("when").value) ?? this.now(),
      );
    el("route-form").hidden = true;
    el("route-form").inert = true;
    el("time-editor").hidden = false;
    const dialog = el("adjust-dialog");
    dialog.classList.add("editing-time");
    dialog.setAttribute("aria-labelledby", "time-heading");
    this.render();
    this.focusDay(this.day);
    this.timer = setInterval(() => this.tick(), 60000);
  }
  close(focus = true) {
    if (!this.active) return;
    clearInterval(this.timer);
    el("time-editor").hidden = true;
    el("route-form").hidden = false;
    el("route-form").inert = false;
    el("adjust-dialog").classList.remove("editing-time");
    el("adjust-dialog").setAttribute("aria-labelledby", "adjust-heading");
    if (focus) el("time-trigger").focus();
  }
  private changeMonth(delta: number) {
    this.month = new Date(
      this.month.getFullYear(),
      this.month.getMonth() + delta,
      1,
    );
    this.render();
  }
  private focusDay(day: string) {
    const grid = el("time-calendar");
    const target =
      grid.querySelector<HTMLButtonElement>(
        `[data-date="${day}"]:not(:disabled)`,
      ) ?? grid.querySelector<HTMLButtonElement>("button:not(:disabled)");
    grid
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => (button.tabIndex = button === target ? 0 : -1));
    (target ?? el("time-cancel")).focus();
  }
  private renderMode() {
    el("time-depart").setAttribute(
      "aria-pressed",
      String(this.mode !== "arrive"),
    );
    el("time-arrive").setAttribute(
      "aria-pressed",
      String(this.mode === "arrive"),
    );
    el("time-now").setAttribute("aria-pressed", String(this.mode === "now"));
    el("time-hint").textContent =
      this.mode === "now"
        ? "Der aktuelle Zeitpunkt wird bei der Berechnung bestimmt."
        : "Fester Zeitpunkt";
  }
  private validate() {
    const valid =
      this.mode === "now" ||
      (!!this.date() && this.date()!.getTime() >= Date.now());
    el("time-error").textContent = valid
      ? ""
      : "Bitte ein gültiges Datum und eine zukünftige Uhrzeit (HH:mm) wählen.";
    el<HTMLButtonElement>("time-apply").disabled = !valid;
    const date = this.date();
    el<HTMLButtonElement>("time-minus").disabled =
      !date || date.getTime() - 300000 < Date.now();
    el<HTMLButtonElement>("time-plus").disabled = !date;
    return valid;
  }
  private render() {
    const focused = (document.activeElement as HTMLElement)?.dataset.date;
    this.renderMode();
    this.validate();
    el("time-month").textContent = this.month.toLocaleDateString("de-DE", {
      month: "long",
      year: "numeric",
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    el<HTMLButtonElement>("time-previous").disabled =
      this.month <= new Date(today.getFullYear(), today.getMonth(), 1);
    const grid = el("time-calendar");
    grid.replaceChildren();
    const start = new Date(this.month);
    start.setDate(1 - ((start.getDay() + 6) % 7));
    const selectedVisible = this.day.startsWith(
      localMinute(this.month).slice(0, 7),
    );
    for (let week = 0; week < 6; week++) {
      const row = node("div");
      row.setAttribute("role", "row");
      for (let column = 0; column < 7; column++) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + column);
        const day = localMinute(date).slice(0, 10);
        const cell = node("div");
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-selected", String(day === this.day));
        const button = node("button", String(date.getDate()));
        button.type = "button";
        button.dataset.date = day;
        button.disabled = date < today;
        button.tabIndex =
          day === this.day ||
          (!selectedVisible &&
            date.getDate() === 1 &&
            date.getMonth() === this.month.getMonth())
            ? 0
            : -1;
        button.classList.toggle(
          "outside-month",
          date.getMonth() !== this.month.getMonth(),
        );
        button.setAttribute(
          "aria-label",
          date.toLocaleDateString("de-DE", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          }),
        );
        if (date.getTime() === today.getTime())
          button.setAttribute("aria-current", "date");
        button.onclick = () => {
          if (this.mode === "now") this.mode = "depart";
          this.day = day;
          this.month = new Date(date.getFullYear(), date.getMonth(), 1);
          this.render();
          this.focusDay(day);
        };
        button.onkeydown = (event) => {
          const offsets: Record<string, number> = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -7,
            ArrowDown: 7,
            Home: -column,
            End: 6 - column,
          };
          const next = new Date(date);
          if (event.key in offsets)
            next.setDate(next.getDate() + offsets[event.key]);
          else if (event.key === "PageUp" || event.key === "PageDown") {
            const wanted = next.getDate();
            next.setDate(1);
            next.setMonth(next.getMonth() + (event.key === "PageUp" ? -1 : 1));
            next.setDate(
              Math.min(
                wanted,
                new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(),
              ),
            );
          } else return;
          event.preventDefault();
          if (next < today) return;
          this.month = new Date(next.getFullYear(), next.getMonth(), 1);
          this.render();
          this.focusDay(localMinute(next).slice(0, 10));
        };
        cell.append(button);
        row.append(cell);
      }
      grid.append(row);
    }
    if (focused) this.focusDay(focused);
  }
}
