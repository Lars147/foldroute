import { node } from "./ui";

export interface FieldValidation { invalid: boolean; message: string }

export class SettingsValidation {
  private views = new WeakMap<HTMLInputElement, (state: FieldValidation) => void>();
  constructor(private form: HTMLElement) {}

  bind(input: HTMLInputElement, label: HTMLElement, render?: (state: FieldValidation) => void) {
    const events = new AbortController();
    if (render) this.views.set(input, render);
    const error = node("small", "", "setting-error");
    error.id = `${input.id}-error`;
    error.hidden = true;
    input.setAttribute(
      "aria-describedby",
      [...new Set([...(input.getAttribute("aria-describedby") ?? "").split(/\s+/), error.id].filter(Boolean))].join(" "),
    );
    if (!render) label.append(error);
    input.addEventListener("blur", () => this.update(input, true), { signal: events.signal });
    input.addEventListener("input", () => this.update(input, false), { signal: events.signal });
    return () => { events.abort(); this.views.delete(input); };
  }

  private update(input: HTMLInputElement, reveal: boolean) {
    if (reveal) input.dataset.validationTouched = "true";
    const error = document.getElementById(`${input.id}-error`)!;
    const invalid =
      !input.validity.valid && input.dataset.validationTouched === "true";
    const render = this.views.get(input);
    if (render) {
      render({ invalid, message: invalid ? this.message(input) : "" });
      return;
    }
    input.setAttribute("aria-invalid", String(invalid));
    error.hidden = !invalid;
    if (!invalid) {
      error.textContent = "";
      return;
    }
    error.textContent = this.message(input);
  }

  private message(input: HTMLInputElement) {
    const number = (value: string) => Number(value).toLocaleString("de-DE");
    return input.validity.badInput
      ? "Bitte eine Zahl eingeben."
      : input.validity.valueMissing
        ? "Bitte einen Wert eingeben."
        : input.validity.stepMismatch
          ? `Bitte einen Wert von ${number(input.min)} bis ${number(input.max)} in Schritten von ${number(input.step)} eingeben.`
          : `Bitte einen Wert von ${number(input.min)} bis ${number(input.max)} eingeben.`;
  }

  validate(): boolean {
    const inputs = [
      ...this.form.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ];
    inputs.forEach((input) => this.update(input, true));
    const invalid = inputs.find((input) => !input.validity.valid);
    if (!invalid) return true;
    const details = invalid.closest("details");
    if (details) details.open = true;
    invalid.focus({ preventScroll: true });
    invalid.closest(".setting-row")!.scrollIntoView({ block: "nearest" });
    return false;
  }
}
