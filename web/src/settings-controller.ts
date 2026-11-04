import { flushSync } from "svelte";
import { appPresentation } from "./app-presentation";
import type { SettingsPresentation } from "./app-presentation";
import { SettingsValidation } from "./settings-validation";
import {
  defaults,
  migrateSettings,
  modes,
  validSettings,
  type RoutingSettings,
} from "./model";

interface SettingsDependencies {
  changed(next: RoutingSettings): void;
  replanContext(): { pending: boolean; hasRequest: boolean };
  close(): void;
  storageError(message: string, initial: boolean): void;
  stored(): void;
}
const storageKey = "foldroute.routing.v3";
const legacyStorageKey = "foldroute.routing.v1";

/** Owns routing preferences and their controls; planning/history effects are commands. */
export class SettingsController {
  private current = structuredClone(defaults);
  private readonly validation: SettingsValidation;
  private readonly events = new AbortController();
  private readonly headingObserver: ResizeObserver;
  private frame?: number;
  get value(): RoutingSettings {
    return this.current;
  }

  constructor(
    private root: HTMLElement,
    private dependencies: SettingsDependencies,
    private presentation: SettingsPresentation = appPresentation().settings,
  ) {
    this.validation = new SettingsValidation(this.element("settings-form"));
    try {
      const current = localStorage.getItem(storageKey),
        legacy = localStorage.getItem(legacyStorageKey);
      const value = migrateSettings(JSON.parse(current ?? legacy ?? "null"));
      if (value) {
        this.current = value;
        if (!current && legacy) {
          localStorage.setItem(storageKey, JSON.stringify(value));
          localStorage.removeItem(legacyStorageKey);
        }
      }
    } catch {
      dependencies.storageError(
        "Einstellungen gelten nur für diese Sitzung.",
        true,
      );
    }
    this.element("reset-settings").addEventListener(
      "click",
      () => {
        this.apply(structuredClone(defaults));
        this.render();
      },
      { signal: this.events.signal },
    );
    const heading = root.querySelector<HTMLElement>(".settings-heading-row");
    if (!heading) throw new Error("Settings heading missing");
    this.headingObserver = new ResizeObserver(() =>
      root.style.setProperty(
        "--settings-heading-height",
        `${heading.getBoundingClientRect().height}px`,
      ),
    );
    this.headingObserver.observe(heading);
    root.addEventListener(
      "focusin",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || heading.contains(target))
          return;
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
          this.frame = undefined;
          if (
            document.activeElement === target &&
            target.getBoundingClientRect().top <
              heading.getBoundingClientRect().bottom + 8
          )
            target.scrollIntoView({ block: "nearest" });
        });
      },
      { signal: this.events.signal },
    );
    this.element("settings-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        dependencies.close();
      },
      { signal: this.events.signal },
    );
  }
  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Settings element missing: ${id}`);
    return element;
  }
  validate() {
    return this.validation.validate();
  }
  apply(next: RoutingSettings) {
    if (
      !validSettings(next) ||
      JSON.stringify(this.current) === JSON.stringify(next)
    )
      return;
    this.current = structuredClone(next);
    this.dependencies.changed(this.current);
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.current));
      localStorage.removeItem(legacyStorageKey);
      this.dependencies.stored();
    } catch {
      this.dependencies.storageError(
        "Einstellungen konnten nicht dauerhaft gespeichert werden. Sie gelten für diese Sitzung.",
        false,
      );
    }
    this.summary();
  }
  summary() {
    const context = this.dependencies.replanContext();
    const notice = this.element("settings-replan");
    notice.hidden = !context.pending || !context.hasRequest;
    notice.textContent = "Die Route wird beim Verlassen neu berechnet.";
    const selected = Object.entries(modes)
      .filter(
        ([key]) =>
          !this.current.excludedTransitModes.includes(
            key as keyof typeof modes,
          ),
      )
      .map(([, mode]) => mode.name);
    this.element("modes-summary").textContent =
      selected.length === Object.keys(modes).length
        ? "Alle Verkehrsmittel"
        : selected.length
          ? selected.join(" · ")
          : "Keine ausgewählt";
  }
  render() {
    this.presentation.render({
      read: () => this.current,
      change: (next) => this.apply(next),
      validation: this.validation,
    });
    flushSync();
    this.summary();
  }
  clearPersisted() {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
  }
  resetAfterDataClear() {
    this.current = structuredClone(defaults);
  }
  dispose() {
    this.presentation.clear();
    this.events.abort();
    this.headingObserver.disconnect();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }
}
