const demoKey = "foldroute.historySwipeSeen.v1";

/** Gesture state stays separate from saved journeys and navigation. */
export class HistorySwipe {
  private opened?: string;
  private active = false;
  private seen = false;
  private interrupted = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private demo?: HTMLElement;
  private deferred?: () => void;
  private suppressClickUntil = 0;
  private drag?: {
    row: HTMLElement;
    pointer: number;
    x: number;
    y: number;
    offset: number;
    horizontal: boolean;
  };
  private desktop = matchMedia("(hover: hover) and (pointer: fine)");
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private list: HTMLElement) {
    try {
      this.seen = localStorage.getItem(demoKey) === "true";
    } catch {
      /* Session fallback. */
    }
    list.addEventListener("pointerdown", (event) => this.down(event));
    list.addEventListener("pointermove", (event) => this.move(event));
    list.addEventListener("pointerup", (event) => {
      if (this.drag?.pointer === event.pointerId) this.end();
    });
    list.addEventListener("pointercancel", (event) => {
      if (this.drag?.pointer === event.pointerId) this.end(true);
    });
    list.addEventListener("lostpointercapture", (event) => {
      // Touch starts with implicit capture on a child button. Transferring it
      // to the row releases the child's capture and bubbles this event here.
      // Only losing the row's own capture cancels an active drag.
      if (
        this.drag?.pointer === event.pointerId &&
        event.target === this.drag.row
      )
        this.end(true);
    });
    list.addEventListener(
      "click",
      (event) => {
        if (performance.now() < this.suppressClickUntil) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.demo) this.suppressClickUntil = 0;
        if (this.active) this.interrupted = true;
        if (this.demo) {
          this.suppressClickUntil = performance.now() + 800;
          event.preventDefault();
          this.cancelDemo();
        } else if (this.active) this.cancelDemo();
        if (
          !(event.target instanceof Element) ||
          !event.target.closest(".history-row")
        )
          this.close();
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (this.active) this.interrupted = true;
      this.cancelDemo();
      if (event.key === "Escape") {
        this.close();
        (
          document.activeElement
            ?.closest(".history-row")
            ?.querySelector(".history-open") as HTMLElement | null
        )?.focus();
      }
    });
    document.addEventListener(
      "scroll",
      () => {
        if (this.active) this.interrupted = true;
        this.cancelDemo();
      },
      true,
    );
    document.addEventListener("wheel", () => this.cancelDemo(), {
      passive: true,
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.interrupted = true;
        this.cancelDemo();
        this.end(true);
        this.close();
      }
    });
    this.reduced.addEventListener("change", () => this.cancelDemo());
    this.desktop.addEventListener("change", () => {
      this.interrupted = true;
      this.cancelDemo();
      this.end(true);
      this.close();
    });
  }
  private markSeen() {
    this.seen = true;
    try {
      localStorage.setItem(demoKey, "true");
    } catch {
      /* Session fallback. */
    }
  }
  resetHint() {
    this.cancelDemo();
    this.seen = false;
    try {
      localStorage.removeItem(demoKey);
    } catch {
      /* Session fallback. */
    }
  }
  deferRender(render: () => void) {
    if (!this.drag && !this.demo) return false;
    this.deferred = render;
    return true;
  }
  private flush() {
    const render = this.deferred;
    this.deferred = undefined;
    render?.();
  }
  setActive(active: boolean) {
    if (active && !this.active) this.interrupted = false;
    this.active = active;
    if (!active) {
      this.cancelDemo();
      this.end(true);
      this.close();
    } else this.ready();
  }
  ready() {
    for (const row of this.list.querySelectorAll<HTMLElement>(".history-row"))
      row.classList.toggle("swipe-open", row.dataset.historyId === this.opened);
    if (
      !this.active ||
      this.desktop.matches ||
      this.interrupted ||
      document.hidden ||
      this.seen ||
      this.reduced.matches ||
      !matchMedia("(any-pointer: coarse)").matches ||
      this.timers.length ||
      !this.list.children.length
    )
      return;
    this.timers.push(
      setTimeout(() => {
        const row = this.list.firstElementChild as HTMLElement | null;
        if (
          !row ||
          !this.active ||
          document.hidden ||
          this.reduced.matches ||
          this.list.contains(document.activeElement)
        ) {
          this.cancelDemo();
          return;
        }
        this.markSeen();
        this.demo = row;
        row.classList.add("swipe-demo");
        row.classList.add("swipe-open");
        this.timers.push(
          setTimeout(() => {
            row.classList.remove("swipe-open");
            this.timers.push(setTimeout(() => this.cancelDemo(), 250));
          }, 1250),
        );
      }, 600),
    );
  }
  private cancelDemo() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.demo) {
      this.demo.classList.remove("swipe-demo", "swipe-open");
      this.demo = undefined;
      this.flush();
    }
  }
  private width(row: HTMLElement) {
    return row
      .querySelector<HTMLElement>(".history-remove")!
      .getBoundingClientRect().width;
  }
  close() {
    this.opened = undefined;
    this.list
      .querySelectorAll(".swipe-open")
      .forEach((row) => row.classList.remove("swipe-open"));
  }
  private down(event: PointerEvent) {
    if (
      this.desktop.matches ||
      performance.now() < this.suppressClickUntil ||
      !event.isPrimary ||
      event.pointerType === "mouse" ||
      event.button !== 0
    )
      return;
    const target = event.target as Element;
    if (target.closest(".history-remove")) return;
    const row = target.closest<HTMLElement>(".history-row");
    if (!row) return;
    if (this.opened && this.opened !== row.dataset.historyId) this.close();
    this.drag = {
      row,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset: this.opened === row.dataset.historyId ? -this.width(row) : 0,
      horizontal: false,
    };
  }
  private move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const x = event.clientX - drag.x,
      y = event.clientY - drag.y;
    if (!drag.horizontal) {
      if (Math.abs(y) >= 10 && Math.abs(y) >= Math.abs(x)) {
        this.end(true);
        return;
      }
      if (Math.abs(x) < 10 || Math.abs(x) < Math.abs(y) * 1.5) return;
      drag.horizontal = true;
      this.markSeen();
      drag.row.setPointerCapture(event.pointerId);
      drag.row.classList.add("swipe-dragging");
    }
    const offset = Math.max(
      -this.width(drag.row),
      Math.min(0, drag.offset + x),
    );
    drag.row.style.setProperty("--swipe-offset", `${offset}px`);
  }
  private end(cancel = false) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    if (drag.horizontal) {
      const offset =
        parseFloat(drag.row.style.getPropertyValue("--swipe-offset")) || 0;
      this.close();
      if (!cancel && -offset >= this.width(drag.row) * 0.4) {
        this.opened = drag.row.dataset.historyId;
        drag.row.classList.add("swipe-open");
      }
      this.suppressClickUntil = performance.now() + 500;
    } else if (!cancel && drag.offset < 0) {
      this.close();
      this.suppressClickUntil = performance.now() + 500;
    }
    drag.row.style.removeProperty("--swipe-offset");
    drag.row.classList.remove("swipe-dragging");
    if (drag.row.hasPointerCapture(drag.pointer))
      drag.row.releasePointerCapture(drag.pointer);
    if (drag.horizontal || cancel) this.flush();
    else setTimeout(() => this.flush(), 0);
  }
}
