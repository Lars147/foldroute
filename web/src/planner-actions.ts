import { el } from "./ui";

/** A small action popover; it never owns or submits the planning draft. */
export class PlannerActions {
  private panel = el("planner-actions");
  private trigger = el<HTMLButtonElement>("planner-more");
  private add = el<HTMLButtonElement>("add-stop");
  private get open() {
    return this.panel.matches(":popover-open");
  }
  constructor(onOpen: () => void, onAdd: () => void) {
    this.add.onclick = () => {
      if (this.add.disabled) return;
      this.close();
      onAdd();
    };
    this.panel.addEventListener("beforetoggle", (event) => {
      if ((event as ToggleEvent).newState === "open") onOpen();
    });
    this.panel.addEventListener("toggle", () => {
      this.trigger.setAttribute("aria-expanded", String(this.open));
      if (this.open) this.position();
    });
    // Consume Escape before it can collapse or cancel the enclosing route editor.
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.open) return;
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
      },
      { capture: true },
    );
    document.addEventListener(
      "scroll",
      (event) => {
        if (
          this.open &&
          event.target instanceof Node &&
          !this.panel.contains(event.target)
        )
          this.position();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => this.position());
    window.visualViewport?.addEventListener("resize", () => this.position());
    window.visualViewport?.addEventListener("scroll", () => this.position());
  }
  close(focus = false) {
    if (!this.open) return;
    this.panel.hidePopover();
    this.trigger.setAttribute("aria-expanded", "false");
    if (focus) this.trigger.focus({ preventScroll: true });
  }
  private position() {
    if (!this.open) return;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 12;
    const top = (viewport?.offsetTop ?? 0) + 12;
    const right = left + (viewport?.width ?? innerWidth) - 24;
    const bottom = top + (viewport?.height ?? innerHeight) - 24;
    const bounds = this.trigger.getBoundingClientRect();
    const width = Math.min(280, right - left);
    this.panel.style.width = `${width}px`;
    this.panel.style.left = `${Math.max(left, Math.min(bounds.right - width, right - width))}px`;
    const height = this.panel.offsetHeight;
    const y =
      bounds.bottom + height + 8 <= bottom
        ? bounds.bottom + 8
        : bounds.top - height - 8;
    this.panel.style.top = `${Math.max(top, Math.min(y, bottom - height))}px`;
  }
}
