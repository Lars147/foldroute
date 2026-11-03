/** Countdown presentation only; callers own deadlines and completion actions. */
export class CountdownBar {
  readonly element = document.createElement("span");
  private fill = document.createElement("span");

  constructor(private transitionMs = 0) {
    this.element.className = "countdown-bar";
    this.element.setAttribute("aria-hidden", "true");
    this.element.hidden = true;
    this.element.style.setProperty(
      "--countdown-transition",
      `${transitionMs}ms`,
    );
    this.fill.className = "countdown-bar-fill";
    this.element.append(this.fill);
  }

  set(remainingMs: number, durationMs: number, paused = false) {
    if (
      !Number.isFinite(remainingMs) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    )
      throw new RangeError(
        "Countdown needs a finite remaining time and positive duration.",
      );
    delete this.element.dataset.animated;
    this.element.toggleAttribute("data-paused", paused);
    this.element.style.setProperty(
      "--countdown-transition",
      `${paused ? 0 : this.transitionMs}ms`,
    );
    this.fill.style.animation = "none";
    this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, remainingMs / durationMs))})`;
    this.element.hidden = false;
  }

  start(remainingMs: number, durationMs: number) {
    this.set(remainingMs, durationMs);
    const remaining = Math.max(0, Math.min(durationMs, remainingMs));
    const fresh = this.fill.cloneNode(true) as HTMLSpanElement;
    fresh.style.animation = `countdown-drain ${durationMs}ms linear ${remaining - durationMs}ms forwards`;
    this.fill.replaceWith(fresh);
    this.fill = fresh;
    this.element.dataset.animated = "";
  }

  pause() {
    this.element.dataset.paused = "";
    this.fill.style.animationPlayState = "paused";
  }

  hide() {
    this.element.hidden = true;
    this.fill.style.animation = "none";
  }
}
