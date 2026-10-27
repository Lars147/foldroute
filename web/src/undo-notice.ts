import { reveal, stopMotion } from "./motion";

/** One undo action, with an eight-second reading window. */
export class UndoNotice {
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 8000;
  private started = 0;
  private hovered = false;
  private action?: () => Promise<void>;
  private revision = 0;
  private onClear?: () => void;
  private countdown?: HTMLElement;
  constructor(
    private banner: HTMLElement,
    private button: HTMLButtonElement,
  ) {
    this.countdown =
      banner.querySelector<HTMLElement>(".toast-countdown-fill") ?? undefined;
    banner.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      this.hovered = true;
      this.pause();
    });
    banner.addEventListener("pointerleave", () => {
      this.hovered = false;
      this.resume();
    });
    banner.addEventListener("focusin", () => this.pause());
    banner.addEventListener("focusout", () =>
      queueMicrotask(() => this.resume()),
    );
    button.onclick = async () => {
      const action = this.action,
        revision = this.revision;
      if (!action || button.disabled) return;
      this.pause();
      button.disabled = true;
      try {
        await action();
      } finally {
        if (revision === this.revision) this.clear();
      }
    };
  }
  show(action: () => Promise<void>, onClear?: () => void) {
    this.clear();
    this.action = action;
    this.onClear = onClear;
    this.remaining = 8000;
    if (this.countdown) {
      const fresh = this.countdown.cloneNode(true) as HTMLElement;
      fresh.style.animationPlayState = "paused";
      this.countdown.replaceWith(fresh);
      this.countdown = fresh;
    }
    this.banner.hidden = false;
    this.button.disabled = false;
    reveal(this.banner, { y: 8 });
    this.hovered =
      matchMedia("(any-hover: hover)").matches && this.banner.matches(":hover");
    this.resume();
  }
  clear() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.action = undefined;
    stopMotion(this.banner);
    this.banner.hidden = true;
    const onClear = this.onClear;
    this.onClear = undefined;
    onClear?.();
  }
  private pause() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining -= performance.now() - this.started;
    if (this.countdown) this.countdown.style.animationPlayState = "paused";
  }
  private resume() {
    if (
      !this.action ||
      this.timer !== undefined ||
      this.hovered ||
      this.banner.contains(document.activeElement) ||
      this.button.disabled
    )
      return;
    this.started = performance.now();
    if (this.countdown) this.countdown.style.animationPlayState = "running";
    this.timer = setTimeout(() => this.clear(), Math.max(0, this.remaining));
  }
}
