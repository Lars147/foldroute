import type { Timing } from "./model";
import { el, node } from "./ui";
import { reveal, stopMotionWithin, motionTime } from "./motion";

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
  private mode: Exclude<Timing, "now"> = "depart";
  private day = "";
  private month = new Date();
  private get active() {
    return el<HTMLDialogElement>("time-dialog").open;
  }
  constructor(private changed: () => void) {
    el("time-trigger").onclick = () => this.open();
    el("time-cancel").onclick = () => this.close();
    el("time-now").onclick = () => {
      this.setFixedDate(new Date());
      this.render();
    };
    for (const mode of ["depart", "arrive"] as const)
      el(`time-${mode}`).onclick = () => {
        this.mode = mode;
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
      this.validate();
    };
    el("time-editor").onsubmit = (event) => {
      event.preventDefault();
      if (!this.validate()) return;
      el<HTMLInputElement>("timing").value = this.mode;
      el<HTMLInputElement>("when").value = localMinute(this.date()!);
      this.changed();
      this.close();
    };
    const dialog = el<HTMLDialogElement>("time-dialog");
    dialog.addEventListener("cancel", (event) => {
      if (this.active) {
        event.preventDefault();
        this.close();
      }
    });
  }
  private date() {
    const clock = el<HTMLInputElement>("time-clock").value.replace(
      /^(\d{2})(\d{2})$/,
      "$1:$2",
    );
    return parseLocalMinute(`${this.day}T${clock}`);
  }
  private setFixedDate(date: Date) {
    this.day = localMinute(date).slice(0, 10);
    this.month = new Date(date.getFullYear(), date.getMonth(), 1);
    el<HTMLInputElement>("time-clock").value = localMinute(date).slice(11);
  }
  open() {
    const timing = el<HTMLInputElement>("timing").value as Timing;
    this.mode = timing === "arrive" ? "arrive" : "depart";
    this.setFixedDate(
      timing === "now"
        ? new Date()
        : (parseLocalMinute(el<HTMLInputElement>("when").value) ?? new Date()),
    );
    const dialog = el<HTMLDialogElement>("time-dialog");
    dialog.showModal();
    this.render();
    this.focusDay(this.day);
    reveal(el("time-editor"), { x: 14, y: 0 });
  }
  close(focus = true) {
    if (!this.active) return;
    stopMotionWithin(el("time-editor"));
    el<HTMLDialogElement>("time-dialog").close();
    if (focus) el("time-trigger").focus();
  }
  private changeMonth(delta: number) {
    this.month = new Date(
      this.month.getFullYear(),
      this.month.getMonth() + delta,
      1,
    );
    this.render();
    reveal(el("time-calendar"), {
      x: delta > 0 ? 12 : -12,
      y: 0,
      duration: motionTime.selection,
    });
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
      String(this.mode === "depart"),
    );
    el("time-arrive").setAttribute(
      "aria-pressed",
      String(this.mode === "arrive"),
    );
  }
  private validate() {
    const date = this.date();
    const valid = !!date;
    el("time-error").textContent = valid
      ? ""
      : "Bitte ein gültiges Datum und eine Uhrzeit (HH:mm) wählen.";
    el<HTMLButtonElement>("time-apply").disabled = !valid;
    el<HTMLButtonElement>("time-minus").disabled = !date;
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
