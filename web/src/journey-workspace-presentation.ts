export const workspaceElementIds = [
  "adjust-route",
  "alternatives-announcement",
  "alternatives-back",
  "alternatives-body",
  "alternatives-close",
  "alternatives-dialog",
  "alternatives-feedback-slot",
  "alternatives-footer",
  "alternatives-select",
  "alternatives-title",
  "choices",
  "close-route",
  "cycling-comparison",
  "example-plan-own",
  "issues",
  "journey-detail",
  "journey-effort",
  "journey-heading",
  "journey-panel",
  "late-departure",
  "late-departure-text",
  "late-settings",
  "map",
  "map-controls",
  "map-error",
  "map-label",
  "map-location",
  "map-open-details",
  "map-preview",
  "map-preview-actions",
  "map-preview-feedback",
  "map-preview-heading",
  "map-preview-status",
  "map-preview-summary",
  "map-request-meta",
  "map-route",
  "map-style-control",
  "map-view",
  "map-zoom-control",
  "navigation-search-now",
  "navigation-start",
  "navigation-start-notice",
  "navigation-start-recovery",
  "navigation-start-retry",
  "overview",
  "panel-actions",
  "panel-content",
  "panel-details",
  "plan-link-fallback",
  "plan-link-value",
  "planning-context-footer",
  "planning-feedback-slot",
  "planning-recovery",
  "recover-planning",
  "recovery-label",
  "recovery-wait",
  "refresh-route",
  "replan-saved",
  "result-back",
  "result-context",
  "result-freshness",
  "result-header",
  "result-nav",
  "result-stand",
  "route-action-context",
  "route-action-destination",
  "route-action-origin",
  "route-action-stand",
  "route-action-stops",
  "route-action-stops-row",
  "route-action-time",
  "route-actions-close",
  "route-actions-dialog",
  "route-actions-title",
  "route-destination",
  "route-more",
  "route-origin",
  "route-request-meta",
  "route-request-stops",
  "route-start-arrival",
  "route-start-duration",
  "route-start-summary",
  "saved-notice",
  "search-preview",
  "search-preview-detail",
  "search-preview-feedback",
  "search-preview-heading",
  "search-preview-hint",
  "search-preview-hint-reserve",
  "search-preview-spinner",
  "search-preview-title",
  "share-plan",
  "stale-notice",
  "status",
] as const;
export type WorkspaceElementId = (typeof workspaceElementIds)[number];
export const workspaceTextIds = [
  "alternatives-announcement",
  "alternatives-title",
  "cycling-comparison",
  "issues",
  "journey-effort",
  "journey-heading",
  "late-departure-text",
  "map-error",
  "map-preview-heading",
  "map-preview-status",
  "map-request-meta",
  "navigation-search-now",
  "navigation-start-notice",
  "navigation-start-retry",
  "recovery-label",
  "recovery-wait",
  "refresh-route",
  "result-back",
  "result-context",
  "result-stand",
  "route-action-destination",
  "route-action-origin",
  "route-action-stand",
  "route-action-stops",
  "route-action-time",
  "route-destination",
  "route-origin",
  "route-request-meta",
  "route-start-arrival",
  "route-start-duration",
  "saved-notice",
  "search-preview-detail",
  "search-preview-hint",
  "search-preview-hint-reserve",
  "search-preview-title",
  "stale-notice",
  "status",
] as const;
export type WorkspaceTextId = (typeof workspaceTextIds)[number];
import type { Journey, RouteStop } from "./model";
import type { JourneyDetailOptions } from "./journey-detail-view";
export interface WorkspaceChoices {
  journeys: readonly Journey[];
  selectedId?: string;
  recommendedId?: string;
  recommendation: string;
  restored: boolean;
  cyclingLimit: number;
  example: boolean;
  inSheet: boolean;
  select(journey: Journey): void;
  details(journey: Journey): void;
}
export interface WorkspaceDetail {
  journey: Journey;
  restored: boolean;
  options: JourneyDetailOptions;
  distance: string;
}
export interface WorkspaceLayout {
  desktop: boolean;
  requestPreview: boolean;
  restored: boolean;
  example: boolean;
  savedOrigin?: "search" | "history";
  sheetMode?: "alternatives" | "preview" | "detail";
}
export interface WorkspaceToast {
  visible: boolean;
  message: string;
  planningId?: string;
  stage?: "searching" | "ready" | "optimizing" | "error";
  retryAt?: number;
  countdown?: { deadline: number; duration: number };
}
export interface JourneyWorkspaceApi {
  updateStartNotice(message: string, help: boolean): void;
  updateStart(checking: boolean, restored: boolean): void;
  subscribeStructure(listener: () => void): () => void;
  updateToast(model: WorkspaceToast): void;
  setToastVisible(value: boolean): void;
  setToastRetryAt(value: number): void;
  setToastPlacement(value: "root" | "sheet" | "inline"): void;
  setToastMap(value: boolean): void;
  setToastStyle(name: string, value: string): void;
  setRecoveryToast(value: boolean): void;

  updateStops(value: readonly RouteStop[]): void;
  setRetryAt(id: WorkspaceElementId, value: number): void;
  setText(
    id: WorkspaceTextId,
    value: string | null | undefined,
  ): string | null | undefined;
  setHidden(id: WorkspaceElementId, value: boolean): boolean;
  setInert(id: WorkspaceElementId, value: boolean): boolean;
  setDisabled(id: WorkspaceElementId, value: boolean): boolean;
  setClass(id: WorkspaceElementId, value: string): string;
  toggleClass(id: WorkspaceElementId, name: string, value: boolean): void;
  setAttribute(
    id: WorkspaceElementId,
    name: string,
    value: string | undefined,
  ): void;
  setCommand(
    id: WorkspaceElementId,
    command: (event: MouseEvent) => void,
  ): void;
  updateLayout(value: WorkspaceLayout): void;
  updateChoices(value: WorkspaceChoices): void;
  updateSummary(value?: {
    journey: Journey;
    cyclingLimit: number;
    example: boolean;
  }): void;
  updateDetail(value?: WorkspaceDetail): void;
}
