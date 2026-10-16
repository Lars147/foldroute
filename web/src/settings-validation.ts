import { node } from "./ui";

export class SettingsValidation {
  constructor(private form: HTMLElement) {}

  bind(input: HTMLInputElement, label: HTMLElement) {
    const error = node("small", "", "setting-error");
    error.id = `${input.id}-error`;
    error.hidden = true;
    input.setAttribute(
      "aria-describedby",
      [input.getAttribute("aria-describedby"), error.id]
        .filter(Boolean)
        .join(" "),
    );
    label.append(error);
    input.addEventListener("blur", () => this.update(input, true));
    input.addEventListener("input", () => this.update(input, false));
  }

  private update(input: HTMLInputElement, reveal: boolean) {
    if (reveal) input.dataset.validationTouched = "true";
    const error = document.getElementById(`${input.id}-error`)!;
    const invalid =
      !input.validity.valid && input.dataset.validationTouched === "true";
    input.setAttribute("aria-invalid", String(invalid));
    error.hidden = !invalid;
    if (!invalid) {
      error.textContent = "";
      return;
    }
    const number = (value: string) => Number(value).toLocaleString("de-DE");
    error.textContent = input.validity.badInput
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
