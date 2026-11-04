import type { HistoryEntry } from "./offline";
import type { RoutingSettings } from "./model";
import type { SettingsValidation } from "./settings-validation";
import type { NavigationScreenApi } from "./navigation-presentation";
import type { JourneyWorkspaceApi } from "./journey-workspace-presentation";

export interface HistoryPresentation {
  entries: readonly HistoryEntry[];
  online: boolean;
  open(entry: HistoryEntry): void;
  remove(id: string): void;
}
export interface SettingsFieldsPresentation {
  read(): RoutingSettings;
  change(settings: RoutingSettings): void;
  validation: SettingsValidation;
}
export interface SettingsPresentation {
  render(binding: SettingsFieldsPresentation): void;
  clear(): void;
}
export interface NavigationViewCommands {
  selectSection(id: string): void;
  phaseKeydown(event: KeyboardEvent): void;
  endNavigation(): void;
}
export interface AppPresentation {
  readonly editor: { setExpanded(value: boolean): void };
  readonly workspace: JourneyWorkspaceApi;
  readonly settings: SettingsPresentation;
  readonly navigation: NavigationScreenApi;
  configureNavigation(commands: NavigationViewCommands): void;
  updateHistory(value: HistoryPresentation): void;
}

let current: AppPresentation | undefined;
/** One concrete application composition, also available to isolated browser fixtures. */
export function installAppPresentation(value: AppPresentation) {
  if (current) throw new Error("Application presentation already mounted");
  current = value;
  return () => {
    if (current === value) current = undefined;
  };
}
export function appPresentation(): AppPresentation {
  if (!current) throw new Error("Application presentation has not mounted");
  return current;
}
