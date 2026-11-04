import { reveal, stopMotion } from "./motion";
import { CountdownBar } from "./countdown-bar";
import { CountdownInteraction } from "./countdown-interaction";

/** One undo action, with an eight-second reading window. */
export class UndoNotice {
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 8000;
  private started = 0;
  private interaction: CountdownInteraction;
  private action?: () => Promise<void>;
  private revision = 0;
  private onClear?: () => void;
  private countdown = new CountdownBar();
  constructor(
    private banner: HTMLElement,
    private button: HTMLButtonElement,
  ) {
    banner.append(this.countdown.element);
    this.interaction = new CountdownInteraction([banner], (paused) =>
      paused ? this.pause() : this.resume(),
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
    this.countdown.set(this.remaining, 8000);
    this.banner.hidden = false;
    this.button.disabled = false;
    reveal(this.banner, { y: 8 });
    this.interaction.refresh();
    this.resume();
  }
  clear() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.action = undefined;
    this.countdown.hide();
    stopMotion(this.banner);
    this.banner.hidden = true;
    this.interaction.refresh();
    const onClear = this.onClear;
    this.onClear = undefined;
    onClear?.();
  }
  private pause() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining -= performance.now() - this.started;
    this.countdown.pause();
  }
  private resume() {
    if (
      !this.action ||
      this.timer !== undefined ||
      this.interaction.paused ||
      this.button.disabled
    )
      return;
    this.started = performance.now();
    this.countdown.start(this.remaining, 8000);
    this.timer = setTimeout(() => this.clear(), Math.max(0, this.remaining));
  }
}
