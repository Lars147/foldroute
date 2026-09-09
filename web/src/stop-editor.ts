import { type RouteStop, validStops } from "./model";
import { ApiClient } from "./transitous";
import { PlaceSearch } from "./search";
import { PlaceBook } from "./places";
import { el, node } from "./ui";

export class StopEditor {
  private rows: {
    root: HTMLElement;
    label: HTMLLabelElement;
    search: PlaceSearch;
    stay: HTMLInputElement;
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
      const list = node("ul", "", "suggestions");
      list.id = `${input.id}-options`;
      list.hidden = true;
      const stayLabel = node("label", "Aufenthalt in Minuten");
      const stay = node("input");
      stay.type = "number";
      stay.min = "0";
      stay.max = "1440";
      stay.step = "1";
      stay.value = "0";
      stayLabel.append(stay);
      const actions = node("div", "", "stop-actions");
      const up = node("button", "↑", "secondary"),
        down = node("button", "↓", "secondary"),
        remove = node("button", "Entfernen", "text-button");
      for (const b of [up, down, remove]) b.type = "button";
      actions.append(up, down, remove);
      root.append(label, input, list, stayLabel, actions);
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
        stay,
        id: crypto.randomUUID(),
        up,
        down,
        remove,
      });
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
      row.stay.value = "0";
      row.id = crypto.randomUUID();
      this.order.push(i);
      this.layout();
      row.search.input.focus();
    };
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
    this.rows[i].search.input.focus();
  }
  private layout() {
    this.rows.forEach((r, i) => {
      r.root.hidden = !this.order.includes(i);
      r.stay.disabled = r.root.hidden;
      r.search.input.disabled = r.root.hidden;
    });
    this.order.forEach((i, n) => {
      const row = this.rows[i];
      row.label.textContent = `Zwischenziel ${n + 1}`;
      row.up.disabled = n === 0;
      row.down.disabled = n === this.order.length - 1;
      row.up.setAttribute("aria-label", `Zwischenziel ${n + 1} nach oben`);
      row.down.setAttribute("aria-label", `Zwischenziel ${n + 1} nach unten`);
      row.remove.setAttribute("aria-label", `Zwischenziel ${n + 1} entfernen`);
      el("via-fields").append(row.root);
    });
    el<HTMLButtonElement>("add-stop").disabled = this.order.length === 3;
  }
  set(stops: RouteStop[]) {
    this.cancel();
    this.order = stops.map((_, i) => i);
    stops.forEach((s, i) => {
      const r = this.rows[i];
      r.id = s.id;
      r.search.set(s.place);
      r.stay.value = String(s.stayMinutes);
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
      if (!r.stay.value.trim() || !r.stay.checkValidity()) {
        el("adjust-status").textContent =
          "Aufenthalt: Bitte ganze Minuten von 0 bis 1440 eingeben.";
        r.stay.focus();
        return;
      }
      values.push({
        id: r.id,
        place: structuredClone(r.search.value),
        stayMinutes: Number(r.stay.value),
      });
    }
    return validStops(values) ? values : undefined;
  }
}
