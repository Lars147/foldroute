/** Foreground-only screen lock. Denial (for example low power) is nonfatal. */
export class ScreenAwake {
  private active = false;
  private generation = 0;
  private lock?: WakeLockSentinel;

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    const generation = ++this.generation;
    const previous = this.lock;
    this.lock = undefined;
    if (previous) void previous.release().catch(() => {});
    if (!active || !navigator.wakeLock) return;
    void navigator.wakeLock.request("screen").then(
      (lock) => {
        if (generation !== this.generation || !this.active) {
          void lock.release().catch(() => {});
          return;
        }
        this.lock = lock;
        lock.addEventListener(
          "release",
          () => {
            if (this.lock === lock) this.lock = undefined;
          },
          { once: true },
        );
      },
      () => {
        /* The system can deny the lock; planning remains available. */
      },
    );
  }
}
