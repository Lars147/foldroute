/** Visual seconds never change the live region's announced message. */
export class RetryCountdown {
  private span?: HTMLSpanElement;
  private timer?: ReturnType<typeof setTimeout>;
  private until = 0;

  render(host: HTMLElement, retryAt: number) {
    if (this.span?.parentElement === host && this.until === retryAt) return;
    this.clear();
    this.until = retryAt;
    if (retryAt <= Date.now() / 1000) return;
    const span = document.createElement("span");
    span.className = "retry-countdown";
    span.setAttribute("aria-hidden", "true");
    host.append(span);
    this.span = span;
    const tick = () => {
      if (!span.isConnected) {
        this.clear();
        return;
      }
      const remaining = Math.max(0, retryAt * 1000 - Date.now());
      span.textContent = remaining ? ` · ${Math.ceil(remaining / 1000)} s` : "";
      if (remaining) this.timer = setTimeout(tick, Math.min(1000, remaining));
      else this.clear();
    };
    tick();
  }

  clear() {
    clearTimeout(this.timer);
    this.span?.remove();
    this.span = undefined;
  }
}
