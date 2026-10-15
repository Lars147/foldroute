import { type RouteStop, validStops } from "./model";
import { ApiClient } from "./transitous";
import { PlaceSearch } from "./search";
import { PlaceBook } from "./places";
import { el, icon, node } from "./ui";

export class StopEditor {
  private rows: {
    root: HTMLElement;
    label: HTMLLabelElement;
    search: PlaceSearch;
    hours: HTMLInputElement;
    minutes: HTMLInputElement;
    stayPanel: HTMLElement;
    stayToggle: HTMLButtonElement;
    staySummary: HTMLElement;
    stayError: HTMLElement;
    id: string;
    up: HTMLButtonElement;
    down: HTMLButtonElement;
    remove: HTMLButtonElement;
  }[] = [];
  private order: number[] = [];
  constructor(
    api: ApiClient,
    book: PlaceBook,
    toast: (message: string) => void,
  ) {
    for (let i = 0; i < 3; i++) {
      const root = node("div", "", "stop-editor-row");
      const input = node("input");
      input.id = `via-${i}`;
      input.type = "search";
      input.autocomplete = "off";
      input.placeholder = "Zwischenziel wählen";
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "false");
      input.setAttribute("aria-controls", `${input.id}-options`);
      const label = node("label");
      label.htmlFor = input.id;
      label.id = `${input.id}-label`;
      const list = node("ul", "", "suggestions");
      list.id = `${input.id}-options`;
      list.hidden = true;
      const stayPanel = node("div", "", "stop-stay-fields");
      stayPanel.id = `${input.id}-stay`;
      stayPanel.hidden = true;
      const hours = node("input"),
        minutes = node("input");
      for (const [field, suffix, caption] of [
        [hours, "hours", "Stunden"],
        [minutes, "minutes", "Minuten"],
      ] as const) {
        field.type = "text";
        field.inputMode = "numeric";
        field.id = `${input.id}-${suffix}`;
        field.value = "0";
        field.autocomplete = "off";
        const fieldLabel = node("label", caption);
        fieldLabel.htmlFor = field.id;
        fieldLabel.append(field);
        stayPanel.append(fieldLabel);
      }
      const stayError = node("p", "", "message stop-stay-error");
      stayError.id = `${input.id}-stay-error`;
      stayError.setAttribute("role", "alert");
      stayError.hidden = true;
      hours.setAttribute("aria-describedby", stayError.id);
      minutes.setAttribute("aria-describedby", stayError.id);
      stayPanel.append(stayError);
      const stayToggle = node("button", "", "stop-stay-toggle");
      stayToggle.type = "button";
      stayToggle.setAttribute("aria-controls", stayPanel.id);
      stayToggle.setAttribute("aria-expanded", "false");
      stayToggle.setAttribute("aria-describedby", label.id);
      const copy = node("span", "", "stop-stay-copy");
      const staySummary = node("strong", "Ohne Pause");
      copy.append(node("span", "Aufenthalt"), staySummary);
      stayToggle.append(icon("wait"), copy, icon("chevron"));
      const actions = node("div", "", "stop-actions");
      const up = node("button", "↑", "secondary"),
        down = node("button", "↓", "secondary"),
        remove = node("button", "", "stop-remove");
      remove.append(icon("close"));
      for (const b of [up, down, remove]) b.type = "button";
      const heading = node("div", "", "stop-heading");
      heading.append(label, remove);
      actions.append(stayToggle, up, down);
      root.append(heading, input, list, actions, stayPanel);
      root.hidden = true;
      el("via-fields").append(root);
      const search = new PlaceSearch(
        input.id,
        api,
        el("adjust-status"),
        () => {},
        book,
        toast,
      );
      this.rows.push({
        root,
        label,
        search,
        hours,
        minutes,
        stayPanel,
        stayToggle,
        staySummary,
        stayError,
        id: crypto.randomUUID(),
        up,
        down,
        remove,
      });
      stayToggle.onclick = () => {
        const row = this.rows[i];
        if (!stayPanel.hidden && this.readStay(i, true) === undefined) return;
        stayPanel.hidden = !stayPanel.hidden;
        stayToggle.setAttribute("aria-expanded", String(!stayPanel.hidden));
        if (!stayPanel.hidden) row.hours.focus();
      };
      for (const field of [hours, minutes]) {
        field.addEventListener("input", () => this.readStay(i, false));
      }
      up.onclick = () => this.move(i, -1);
      down.onclick = () => this.move(i, 1);
      remove.onclick = () => {
        search.cancel();
        this.order = this.order.filter((n) => n !== i);
        this.layout();
        el("add-stop").focus();
      };
    }
    el("add-stop").onclick = () => {
      const i = this.rows.findIndex((_, i) => !this.order.includes(i));
      if (i < 0) return;
      const row = this.rows[i];
      row.search.set();
      this.resetStay(i, 0);
      row.id = crypto.randomUUID();
      this.order.push(i);
      this.layout();
      row.search.input.focus();
    };
  }
  private resetStay(i: number, total: number) {
    const row = this.rows[i];
    row.hours.value = String(Math.floor(total / 60));
    row.minutes.value = String(total % 60);
    row.stayPanel.hidden = true;
    row.stayToggle.setAttribute("aria-expanded", "false");
    this.readStay(i, false);
  }
  private readStay(i: number, report: boolean): number | undefined {
    const row = this.rows[i];
    const hoursText = row.hours.value.trim(),
      minutesText = row.minutes.value.trim();
    const hours = Number(hoursText),
      minutes = Number(minutesText);
    let invalid: HTMLInputElement | undefined;
    let message = "";
    if (!/^\d*$/.test(hoursText) || !Number.isInteger(hours) || hours > 24) {
      invalid = row.hours;
      message = "Bitte ganze Stunden von 0 bis 24 eingeben.";
    } else if (
      !/^\d*$/.test(minutesText) ||
      !Number.isInteger(minutes) ||
      minutes > 59
    ) {
      invalid = row.minutes;
      message = "Bitte ganze Minuten von 0 bis 59 eingeben.";
    } else if (hours * 60 + minutes > 1440) {
      invalid = row.minutes;
      message = "Der Aufenthalt darf höchstens 24 Stunden betragen.";
    }
    if (invalid) {
      if (report) {
        row.stayPanel.hidden = false;
        row.stayToggle.setAttribute("aria-expanded", "true");
        row.hours.setAttribute("aria-invalid", String(invalid === row.hours));
        row.minutes.setAttribute(
          "aria-invalid",
          String(invalid === row.minutes),
        );
        row.stayError.textContent = message;
        row.stayError.hidden = false;
        invalid.focus();
      }
      return;
    }
    row.hours.removeAttribute("aria-invalid");
    row.minutes.removeAttribute("aria-invalid");
    row.stayError.hidden = true;
    row.stayError.textContent = "";
    const total = hours * 60 + minutes;
    row.staySummary.textContent =
      total === 0
        ? "Ohne Pause"
        : [hours ? `${hours} Std.` : "", minutes ? `${minutes} Min.` : ""]
            .filter(Boolean)
            .join(" ");
    return total;
  }
  private move(i: number, delta: number) {
    const pos = this.order.indexOf(i),
      target = pos + delta;
    if (target < 0 || target >= this.order.length) return;
    [this.order[pos], this.order[target]] = [
      this.order[target],
      this.order[pos],
    ];
    this.layout();
    const row = this.rows[i];
    const action = delta < 0 ? row.up : row.down;
    (action.disabled ? row.remove : action).focus();
  }
  private layout() {
    this.rows.forEach((r, i) => {
      r.root.hidden = !this.order.includes(i);
      r.hours.disabled = r.root.hidden;
      r.minutes.disabled = r.root.hidden;
      r.search.input.disabled = r.root.hidden;
    });
    this.order.forEach((i, n) => {
      const row = this.rows[i];
      row.label.textContent = `Zwischenziel ${n + 1}`;
      row.up.hidden = row.down.hidden = this.order.length < 2;
      row.up.disabled = n === 0;
      row.down.disabled = n === this.order.length - 1;
      row.up.setAttribute("aria-label", `Zwischenziel ${n + 1} nach oben`);
      row.down.setAttribute("aria-label", `Zwischenziel ${n + 1} nach unten`);
      row.remove.setAttribute("aria-label", `Zwischenziel ${n + 1} entfernen`);
      row.remove.title = `Zwischenziel ${n + 1} entfernen`;
      row.up.title = row.up.getAttribute("aria-label")!;
      row.down.title = row.down.getAttribute("aria-label")!;
      el("via-fields").append(row.root);
    });
    el<HTMLButtonElement>("add-stop").disabled = this.order.length === 3;
    el("swap-description").textContent = this.order.length
      ? "Die Reihenfolge der Zwischenziele wird ebenfalls umgekehrt."
      : "";
    el("swap").title = this.order.length
      ? "Route umkehren – inklusive Zwischenziele"
      : "Start und Ziel tauschen";
  }
  set(stops: RouteStop[]) {
    this.cancel();
    this.order = stops.map((_, i) => i);
    stops.forEach((s, i) => {
      const r = this.rows[i];
      r.id = s.id;
      r.search.set(s.place);
      this.resetStay(i, s.stayMinutes);
    });
    this.layout();
  }
  reverse() {
    this.order.reverse();
    this.layout();
  }
  cancel() {
    this.rows.forEach((r) => r.search.cancel());
  }
  read(): RouteStop[] | undefined {
    const values: RouteStop[] = [];
    for (const [n, i] of this.order.entries()) {
      const r = this.rows[i];
      if (!r.search.value) {
        el("adjust-status").textContent =
          `Bitte Zwischenziel ${n + 1} aus den Vorschlägen auswählen.`;
        r.search.input.focus();
        return;
      }
      const stayMinutes = this.readStay(i, true);
      if (stayMinutes === undefined) return;
      values.push({
        id: r.id,
        place: structuredClone(r.search.value),
        stayMinutes,
      });
    }
    return validStops(values) ? values : undefined;
  }
}
