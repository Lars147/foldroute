import {
  journeyStops,
  type Journey,
  type RouteRequest,
  type RoutingSettings,
} from "./model";
import type { NavigationProgress } from "./navigation-engine";
import type { NavigationSnapshot } from "./navigation-store";
import type {
  NavigationStatistics,
  NavigationTrip,
  TripSummary,
} from "./navigation-summary";

export interface NavigationPersistenceStore {
  readStatistics(): Promise<{
    epoch: number;
    resumeEpoch: number;
    statistics: NavigationStatistics;
  }>;
  save(snapshot: NavigationSnapshot): Promise<void>;
  completeTrip(summary: TripSummary): Promise<NavigationStatistics | undefined>;
  clear(expectedTripId?: string): Promise<void>;
}

export interface NavigationCheckpoint {
  journey: Journey;
  request: RouteRequest;
  settings: RoutingSettings;
  progress: NavigationProgress;
  trip?: NavigationTrip;
  resumeEpoch: number;
  savedAt: number;
}

export type TripCompletionResult =
  | { kind: "disabled"; clearingFailed: boolean }
  | { kind: "stored"; statistics: NavigationStatistics | undefined }
  | { kind: "failed" };

/** Resume checkpoints and completion IO; repository transactions own epoch guards. */
export class NavigationPersistence {
  private checkpoint = "";

  constructor(private readonly store: NavigationPersistenceStore) {}

  resetCheckpoint() {
    this.checkpoint = "";
  }

  async readEpochs(): Promise<{
    storageEpoch: number;
    resumeEpoch: number;
    failed: boolean;
  }> {
    try {
      const stored = await this.store.readStatistics();
      return {
        storageEpoch: stored.epoch,
        resumeEpoch: stored.resumeEpoch ?? 0,
        failed: false,
      };
    } catch {
      return { storageEpoch: 0, resumeEpoch: 0, failed: true };
    }
  }

  saveCheckpoint(
    input: NavigationCheckpoint,
    force = false,
  ): Promise<void> | undefined {
    const progress = input.progress;
    const key = JSON.stringify([
      input.journey.id,
      progress.legIndex,
      progress.maneuverIndex,
      Math.floor(progress.meters / 50),
      progress.confirmedStops,
      progress.transitStop,
      progress.transitDepartedStop,
    ]);
    if (!force && key === this.checkpoint) return;
    this.checkpoint = key;
    const snapshot: NavigationSnapshot = structuredClone({
      version: 1,
      savedAt: input.savedAt,
      journey: input.journey,
      request: { ...input.request, stops: journeyStops(input.journey) },
      settings: input.settings,
      progress,
      trip: input.trip,
      resumeEpoch: input.resumeEpoch,
    });
    return this.store.save(snapshot);
  }

  async complete(
    summary: TripSummary,
    statisticsEnabled: boolean,
  ): Promise<TripCompletionResult> {
    if (!statisticsEnabled) {
      try {
        await this.store.clear(summary.id);
        return { kind: "disabled", clearingFailed: false };
      } catch {
        return { kind: "disabled", clearingFailed: true };
      }
    }
    try {
      return {
        kind: "stored",
        statistics: await this.store.completeTrip(summary),
      };
    } catch {
      return { kind: "failed" };
    }
  }

  clear(expectedTripId?: string): Promise<void> {
    return this.store.clear(expectedTripId);
  }
}
