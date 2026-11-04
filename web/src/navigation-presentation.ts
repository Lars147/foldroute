import type { Journey } from "./model";
import type { JourneyDetailOptions } from "./journey-detail-view";

/** Plain presentation values: no engine/session objects enter framework state. */
export interface NavigationTab {
  readonly id: string;
  readonly label: string;
  readonly accessibleLabel: string;
  readonly symbol:
    "bike" | "walk" | "transit" | "bus" | "fold" | "unfold" | "wait" | "stop";
  readonly selected: boolean;
  readonly current: boolean;
}
export interface NavigationLocationStatus {
  readonly primary: string;
  readonly estimate: string;
}
export interface NavigationSupportProvider {
  readonly name: string;
  readonly label: string;
  readonly url: string;
}
export interface NavigationFinishSummary {
  readonly providers: readonly NavigationSupportProvider[];
  readonly visible: boolean;
  readonly origin: string;
  readonly destination: string;
  readonly time: string;
  readonly distance: string;
  readonly sinceResume: boolean;
  readonly totals?: {
    readonly count: string;
    readonly distance: string;
    readonly time: string;
  };
  readonly status: string;
}
export interface NavigationScreenApi {
  element(): HTMLElement;
  updateSectionDetail(value?: NavigationSectionDetail): void;
  updateMovementSummary(text: string): void;
  setIcon(id: string, name: string | undefined): void;
  updateLocationFeedback(message: string, help: boolean): void;
  setText(id: string, value: string | null | undefined): void;
  setHidden(id: string, value: boolean): void;
  setDisabled(id: string, value: boolean): void;
  setAttribute(id: string, name: string, value: string | undefined): void;
  updateLayout(mobile: boolean, arrived: boolean): void;
  updateTabs(tabs: readonly NavigationTab[]): void;
  updateLocation(status: NavigationLocationStatus): void;
  updateFinish(summary: NavigationFinishSummary): void;
  updateCompletion(model: NavigationCompletionModel): void;
  setCompletionCommands(commands: NavigationCompletionCommands): void;
}

export interface NavigationCompletionModel {
  readonly available: boolean;
  readonly manualAvailable: boolean;
  readonly busy: boolean;
  readonly mobile: boolean;
  readonly label: string;
  readonly retryVisible: boolean;
  readonly retryLabel: string;
  readonly replanVisible: boolean;
  readonly countdown?: {
    readonly remaining: number;
    readonly duration: number;
    readonly paused: boolean;
    readonly title: string;
    readonly description: string;
  };
}
export interface NavigationCompletionCommands {
  complete(event: MouseEvent, manual: boolean): void;
  retry(): void;
  replan(): void;
}

export interface NavigationSectionDetail {
  readonly journey: Journey;
  readonly options: JourneyDetailOptions;
}
