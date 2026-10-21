import { PlannerError, planningFailures } from "./model";

export interface ServicePause {
  code: "429" | "503" | "pause";
  message: string;
  retryAt: number;
  duration: number;
}
export class RoutingSlots {
  active = 0;
  listeners = new Set<() => void>();
  changed() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** One execution owns its retries and wait allowance; successful calculation caches live longer. */
export class RoutingRun {
  private requests = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  private spent = 0;
  private pausedSince?: number;
  private pausedUntil = 0;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private blocked?: PlannerError;
  private disposed = false;

  constructor(
    private currentPause: () => ServicePause | undefined,
    private signal: AbortSignal,
    private onDispose?: () => void,
    private slots = new RoutingSlots(),
  ) {
    this.slots.listeners.add(this.changed);
    signal.addEventListener("abort", this.changed, { once: true });
    this.pauseChanged();
  }

  private changed = () => {
    for (const listener of [...this.listeners]) listener();
  };

  private settlePause() {
    if (this.pausedSince === undefined) return;
    const now = Date.now();
    this.spent += Math.max(
      0,
      Math.min(now, this.pausedUntil) - this.pausedSince,
    );
    this.pausedSince = now < this.pausedUntil ? now : undefined;
  }

  pauseChanged() {
    if (this.disposed) return;
    this.settlePause();
    clearTimeout(this.pauseTimer);
    const now = Date.now();
    const pause = this.currentPause();
    if (!this.blocked && pause && pause.retryAt * 1000 > now) {
      const remaining = pause.retryAt * 1000 - now;
      if (
        pause.code !== "429" ||
        pause.duration >= 30 ||
        this.spent + remaining > 30000
      ) {
        this.blocked = new PlannerError(
          pause.code,
          pause.message,
          false,
          pause.retryAt,
        );
        this.pausedSince = undefined;
        this.pausedUntil = now;
      } else {
        this.pausedSince = now;
        this.pausedUntil = pause.retryAt * 1000;
        this.pauseTimer = setTimeout(() => this.pauseChanged(), remaining);
      }
    } else if (!pause || pause.retryAt * 1000 <= now) {
      this.pausedSince = undefined;
      this.pausedUntil = now;
    }
    this.changed();
  }

  get paused() {
    return this.pausedSince !== undefined && this.pausedUntil > Date.now();
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(wake);
        signal.removeEventListener("abort", abort);
        this.signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.aborted ? signal.reason : this.signal.reason);
      };
      this.listeners.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async acquire(signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();
      this.signal.throwIfAborted();
      if (this.disposed)
        throw new DOMException("Routing run ended", "AbortError");
      if (this.blocked) throw this.blocked;
      if (!this.paused && this.slots.active < 2) {
        this.slots.active++;
        return;
      }
      await this.waitForChange(signal);
    }
  }

  request<T>(
    key: string,
    signal: AbortSignal,
    attempt: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    this.signal.throwIfAborted();
    if (this.disposed)
      throw new DOMException("Routing run ended", "AbortError");
    const previous = this.requests.get(key);
    if (previous) return previous as Promise<T>;
    const pending = this.perform(key, signal, attempt);
    this.requests.set(key, pending);
    return pending;
  }

  private async perform<T>(
    key: string,
    signal: AbortSignal,
    attempt: () => Promise<T>,
  ): Promise<T> {
    for (let count = 0; ; count++) {
      await this.acquire(signal);
      try {
        if (this.blocked) throw this.blocked;
        if (this.paused) {
          count--;
          continue;
        }
        return await attempt();
      } catch (error) {
        signal.throwIfAborted();
        this.signal.throwIfAborted();
        const failure = planningFailures(error).find(
          (value) => value.code === "429",
        );
        if (!failure || count >= 2 || this.blocked)
          throw failure
            ? new PlannerError(
                "429",
                failure.message,
                false,
                Math.max(
                  failure.retryAt ?? 0,
                  this.currentPause()?.retryAt ?? 0,
                ),
                [{ ...failure, requestKey: key }],
              )
            : error;
      } finally {
        this.slots.active--;
        this.slots.changed();
      }
    }
  }

  deadline(milliseconds: number, reason?: unknown) {
    const controller = new AbortController();
    let remaining = milliseconds;
    let started: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const now = Date.now();
      if (started !== undefined) remaining -= now - started;
      started = undefined;
      if (!controller.signal.aborted && !this.paused && !this.disposed) {
        started = now;
        timer = setTimeout(
          () => controller.abort(reason),
          Math.max(0, remaining),
        );
      }
    };
    this.listeners.add(update);
    update();
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        this.listeners.delete(update);
      },
    };
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.pauseTimer);
    this.signal.removeEventListener("abort", this.changed);
    this.slots.listeners.delete(this.changed);
    this.changed();
    this.listeners.clear();
    this.onDispose?.();
  }
}

export function workDeadline(
  run: RoutingRun | undefined,
  milliseconds: number,
  reason?: unknown,
) {
  if (run) return run.deadline(milliseconds, reason);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(reason), milliseconds);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
