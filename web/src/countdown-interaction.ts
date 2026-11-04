/** Share mouse-hover and focus pauses without owning the countdown deadline. */
export class CountdownInteraction {
  private hovered = new Set<HTMLElement>();
  private lastPaused = false;

  constructor(
    private elements: HTMLElement[],
    private changed: (paused: boolean) => void,
  ) {
    for (const element of elements) {
      element.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse") return;
        this.hovered.add(element);
        this.refresh();
      });
      element.addEventListener("pointerleave", () => {
        this.hovered.delete(element);
        this.refresh();
      });
      element.addEventListener("focusin", () => this.refresh());
      element.addEventListener("focusout", () =>
        queueMicrotask(() => this.refresh()),
      );
    }
  }

  get paused() {
    return this.elements.some(
      (element) =>
        element.getClientRects().length > 0 &&
        (this.hovered.has(element) || element.contains(document.activeElement)),
    );
  }

  refresh() {
    const paused = this.paused;
    if (paused === this.lastPaused) return;
    this.lastPaused = paused;
    this.changed(paused);
  }
}
