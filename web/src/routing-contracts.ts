import type {
  Journey,
  Place,
  PlanningFailure,
  PlanningUpdate,
  RouteRequest,
  RoutingSettings,
} from "./model";
import type { RoutingRun, ServicePause } from "./routing-retry";

export type StreetMode = "BIKE" | "WALK";
export interface Variant {
  /** Native via validation uses unmodified provider times and legs. */
  native?: boolean;
  via?: { id: string; stayMinutes: number };
  directMode?: StreetMode;
  street?: boolean;
  direct?: boolean;
  pre: StreetMode;
  post: StreetMode;
  preLimit?: number;
  postLimit?: number;
}

export interface Batch {
  journeys: Journey[];
  rejected: boolean;
  recovery?: number;
  issues: string[];
  failures?: PlanningFailure[];
  stop: boolean;
}
export interface RequestBudget {
  take(): void;
  stopped?: boolean;
  run?: RoutingRun;
}

/** Provider-independent routing operations shared by planning strategies. */
export interface RoutingClient {
  retryAt: number;
  batch(
    request: RouteRequest,
    settings: RoutingSettings,
    variant: Variant,
    signal: AbortSignal,
    budget?: RequestBudget,
  ): Promise<Batch>;
  createRun?(signal: AbortSignal): RoutingRun | undefined;
  resolveStation?(
    place: Place,
    signal: AbortSignal,
    budget?: RequestBudget,
  ): Promise<Place>;
}

export interface PlanningClient extends RoutingClient {
  onPause(listener: (pause: ServicePause) => void): () => void;
}

export interface SearchOptions {
  raw?: boolean;
  baseOnly?: boolean;
  budget?: RequestBudget;
}

export type RoutePlanner = (
  request: RouteRequest,
  settings: RoutingSettings,
  signal: AbortSignal,
  client: RoutingClient,
  options?: SearchOptions,
) => AsyncGenerator<PlanningUpdate>;
