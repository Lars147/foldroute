import type { RouteRequest, RoutingSettings } from "./model";
import type {
  Batch,
  RequestBudget,
  RoutingClient,
  Variant,
} from "./transitous";

/** Successful responses belong to one calculation, never to a new search. */
export class PlanningRoutingClient implements RoutingClient {
  private completed = new Map<string, Batch>();

  constructor(private client: RoutingClient) {}

  get retryAt() {
    return this.client.retryAt;
  }

  set retryAt(value: number) {
    this.client.retryAt = value;
  }

  async batch(
    request: RouteRequest,
    settings: RoutingSettings,
    variant: Variant,
    signal: AbortSignal,
    budget?: RequestBudget,
  ): Promise<Batch> {
    signal.throwIfAborted();
    const key = JSON.stringify([request, settings, variant], (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    );
    const completed = this.completed.get(key);
    if (completed) return structuredClone(completed);

    const batch = await this.client.batch(
      request,
      settings,
      variant,
      signal,
      budget,
    );
    signal.throwIfAborted();
    if (!batch.rejected && !batch.stop && !batch.issues.length)
      this.completed.set(key, structuredClone(batch));
    return batch;
  }
}
