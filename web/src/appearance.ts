export type AppearancePreference = "system" | "light" | "dark";

const storageKey = "foldroute.appearance";

function preference(value: string | null): AppearancePreference {
  return value === "light" || value === "dark" ? value : "system";
}

class AppearanceController {
  preference: AppearancePreference = "system";
  storageFailed = false;
  onChange?: () => void;
  onStorageError?: () => void;
  private media = window.matchMedia("(prefers-color-scheme: dark)");

  initialize() {
    try {
      this.preference = preference(localStorage.getItem(storageKey));
    } catch {
      this.storageFailed = true;
    }
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey || event.key === null) {
        this.preference = preference(event.newValue);
        this.apply();
      }
    });
    this.media.addEventListener("change", () => this.apply());
    this.apply();
  }

  set(value: AppearancePreference) {
    this.preference = value;
    this.apply();
    try {
      localStorage.setItem(storageKey, value);
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
      this.onStorageError?.();
    }
  }

  // Called inside the existing data-deletion transaction and error handling.
  reset() {
    localStorage.removeItem(storageKey);
    this.preference = "system";
    this.storageFailed = false;
    this.apply();
  }

  private apply() {
    const effective =
      this.preference === "system"
        ? this.media.matches
          ? "dark"
          : "light"
        : this.preference;
    const changed = document.documentElement.dataset.theme !== effective;
    document.documentElement.dataset.theme = effective;
    const styles = getComputedStyle(document.documentElement);
    // The inline startup palette is available before the shared stylesheet loads.
    const color =
      styles.getPropertyValue("--color-canvas").trim() ||
      styles.getPropertyValue("--startup-paper").trim();
    if (color)
      document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )!.content = color;
    this.onChange?.();
    if (changed) window.dispatchEvent(new Event("foldroute:appearance"));
  }
}

export const appearance = new AppearanceController();
