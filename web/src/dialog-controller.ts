/** Native dialog lifecycle; feature controllers retain their own actions and state. */
export class DialogController {
  private events = new AbortController();
  private trigger?: HTMLElement;
  private restoreFocus = true;

  constructor(private dialog: HTMLDialogElement) {
    dialog.addEventListener(
      "close",
      () => {
        if (!this.dialog.open && this.restoreFocus && this.trigger?.isConnected)
          this.trigger.focus({ preventScroll: true });
      },
      { signal: this.events.signal },
    );
  }

  open(trigger: HTMLElement, initialFocus?: HTMLElement) {
    this.trigger = trigger;
    this.restoreFocus = true;
    if (!this.dialog.open) this.dialog.showModal();
    initialFocus?.focus({ preventScroll: true });
  }

  close(focus = true) {
    if (!this.dialog.open) return;
    // Programmatic close restores synchronously; native close restores in the event.
    this.restoreFocus = false;
    this.dialog.close();
    if (focus && this.trigger?.isConnected)
      this.trigger.focus({ preventScroll: true });
  }

  dispose() {
    this.events.abort();
    this.close(false);
    this.trigger = undefined;
  }
}
