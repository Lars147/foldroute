import type { Leg } from "./model";
import type { TransitPosition } from "./navigation-estimate";
import { clock, node } from "./ui";
import { motionAllowed } from "./motion";

/** Paint the rail from the visible map position without rebuilding it each frame. */
export class NavigationStations {
  private leg?: Leg;
  private index = -1;
  private confirmedIndex = -1;
  private position?: TransitPosition;
  private renderedIndex = -1;
  private renderedLeg?: string;
  private renderedStopCount = 0;
  private key = "";
  private anchors: { element: HTMLElement; index: number; y: number }[] = [];
  private resize = new ResizeObserver(() => this.measure());
  private animations: Animation[] = [];
  private leaving = new Set<HTMLElement>();

  constructor(
    private list: HTMLElement,
    private compact = false,
  ) {
    this.resize.observe(list);
    const finish = () => {
      this.clearTransition();
      this.measure();
    };
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
      "change",
      finish,
    );
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) finish();
    });
    if (compact)
      list.setAttribute("aria-label", "Halte der aktuellen Bahnfahrt");
  }

  update(leg: Leg | undefined, index: number, confirmedIndex = index) {
    if (this.leg?.navigationId !== leg?.navigationId || index < 0)
      this.position = undefined;
    this.leg = leg;
    this.index = index;
    this.confirmedIndex = confirmedIndex;
    this.list.hidden = !leg?.transitStops;
    this.render();
  }

  setPosition(position: TransitPosition) {
    if (this.index < 0 || position.navigationId !== this.leg?.navigationId)
      return;
    this.position = position;
    if (this.visibleIndex() !== this.renderedIndex) this.render();
    else this.paint();
  }

  private get located() {
    return this.position?.meters !== undefined &&
      Number.isFinite(this.position.meters) &&
      this.position.path?.stopOffsets.length === this.leg?.transitStops?.length
      ? this.position
      : undefined;
  }

  private visibleIndex() {
    const stops = this.leg?.transitStops;
    if (!stops || this.index < 0) return -1;
    const position = this.located;
    let index = 0;
    // Keep the approaching segment visible throughout a station dwell and at exit.
    for (let i = 1; i < stops.length - 1; i++)
      if (
        !stops[i].cancelled &&
        (position
          ? position.path!.stopOffsets[i] < position.meters! - 0.01 ||
            (i <= this.index &&
              position.path!.stopOffsets[i] <= position.meters! + 0.01)
          : i <= this.index)
      )
        index = i;
    return index;
  }

  private render() {
    const leg = this.leg,
      stops = leg?.transitStops;
    if (!stops) {
      this.clearTransition();
      this.key = "";
      this.renderedLeg = undefined;
      this.renderedIndex = -1;
      this.renderedStopCount = 0;
      this.anchors = [];
      return;
    }
    const index = this.visibleIndex();
    const key = JSON.stringify([
      leg.navigationId,
      stops,
      index,
      this.confirmedIndex,
    ]);
    if (key === this.key) {
      this.paint();
      return;
    }
    const previousIndex = this.renderedIndex;
    const shifting =
      this.compact &&
      this.renderedLeg === leg.navigationId &&
      this.renderedStopCount === stops.length &&
      (index !== this.renderedIndex || this.animations.length > 0) &&
      motionAllowed(this.list);
    this.key = key;
    this.renderedIndex = index;
    this.renderedLeg = leg.navigationId;
    this.renderedStopCount = stops.length;
    this.list.dataset.continuation = String(this.compact && index > 0);
    const next =
      index >= 0
        ? stops.findIndex((stop, i) => i > index && !stop.cancelled)
        : -1;
    const indices = this.compact
      ? [...new Set([index, next, stops.length - 1])].filter((i) => i >= 0)
      : stops.map((_, i) => i);
    const items: HTMLElement[] = [];
    let previous: number | undefined;
    for (const i of indices) {
      if (previous !== undefined && i > previous + 1) {
        const gap = node("li", "", "navigation-station-gap");
        gap.dataset.stationKey = `gap:${i}`;
        gap.append(node("span", "Weitere Zwischenhalte", "sr-only"));
        items.push(gap);
      }
      const stop = stops[i];
      const item = node("li", "", "navigation-station");
      item.dataset.index = String(i);
      item.dataset.stationKey = `stop:${i}`;
      item.dataset.state = stop.cancelled
        ? "cancelled"
        : i <= index
          ? "passed"
          : i === next
            ? "next"
            : "upcoming";
      if (i === next) item.setAttribute("aria-current", "step");
      const marker = node("span", "", "navigation-station-marker");
      marker.setAttribute("aria-hidden", "true");
      const copy = node("div", "", "navigation-station-copy");
      copy.append(node("span", stop.name, "navigation-station-name"));
      const label = stop.cancelled
        ? "Halt entfällt"
        : i === stops.length - 1
          ? "Ausstieg"
          : i <= index
            ? i <= this.confirmedIndex
              ? "Erreicht"
              : "Voraussichtlich passiert"
            : "";
      // The compact rail needs the previous name, without another explanatory line.
      if (label && (!this.compact || i > index))
        copy.append(node("small", label));
      const row = node("div", "", "navigation-station-row");
      row.append(marker, copy);
      item.append(row);
      const arrival = stop.arrival ?? stop.scheduledArrival;
      if (!stop.cancelled && arrival !== undefined) {
        const time = node("time", clock(arrival), "navigation-station-time");
        time.dateTime = new Date(arrival * 1000).toISOString();
        time.setAttribute(
          "aria-label",
          `Ankunft${stop.arrival === undefined ? " laut Fahrplan" : ""} ${clock(arrival)}`,
        );
        row.append(time);
      }
      items.push(item);
      previous = i;
    }
    const continuous =
      indices.includes(previousIndex) ||
      [...this.list.children].some(
        (item) => (item as HTMLElement).dataset.index === String(index),
      );
    this.replace(items, shifting && continuous);
    this.observeLayout();
    this.measure();
  }

  /** Keep shared rows; collapse departing rows through the clipped upper edge. */
  private replace(items: HTMLElement[], shifting: boolean) {
    if (!shifting) {
      this.clearTransition();
      this.list.replaceChildren(...items);
      return;
    }
    const old = [...this.list.children] as HTMLElement[];
    const heights = new Map(
      old.map((item) => [item, item.getBoundingClientRect().height]),
    );
    const transforms = new Map(
      old.map((item) => [
        item,
        item.firstElementChild
          ? getComputedStyle(item.firstElementChild).transform
          : "none",
      ]),
    );
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.leaving.clear();
    const keys = new Set(items.map((item) => item.dataset.stationKey));
    const merged: HTMLElement[] = [];
    const discard = (item: HTMLElement) => {
      if (keys.has(item.dataset.stationKey)) return;
      item.dataset.leaving = "true";
      item.setAttribute("aria-hidden", "true");
      item.removeAttribute("aria-current");
      if (item.dataset.state === "next") item.dataset.state = "upcoming";
      this.leaving.add(item);
      merged.push(item);
    };
    let cursor = 0;
    for (const item of items) {
      const at = old.findIndex(
        (previous) => previous.dataset.stationKey === item.dataset.stationKey,
      );
      if (at < 0) {
        merged.push(item);
        continue;
      }
      while (cursor < at) discard(old[cursor++]);
      cursor = at + 1;
      const previous = old[at];
      previous.dataset.state = item.dataset.state ?? "";
      delete previous.dataset.leaving;
      previous.removeAttribute("aria-hidden");
      if (item.hasAttribute("aria-current"))
        previous.setAttribute("aria-current", "step");
      else previous.removeAttribute("aria-current");
      previous.replaceChildren(...item.childNodes);
      merged.push(previous);
    }
    while (cursor < old.length) discard(old[cursor++]);
    this.list.replaceChildren(...merged);
    const animations: Animation[] = [];
    const options: KeyframeAnimationOptions = {
      duration: 900,
      easing: "cubic-bezier(0.45, 0, 0.55, 1)",
      fill: "both",
    };
    for (const item of merged) {
      const height = item.getBoundingClientRect().height;
      const from = heights.get(item) ?? 0;
      const to = this.leaving.has(item) ? 0 : height;
      if (Math.abs(from - to) > 0.1) {
        item.style.overflow = "hidden";
        animations.push(
          item.animate(
            [{ height: `${from}px` }, { height: `${to}px` }],
            options,
          ),
        );
      }
      const row = item.querySelector<HTMLElement>(".navigation-station-row");
      const transform = transforms.get(item) ?? "none";
      if (row && (this.leaving.has(item) || transform !== "none"))
        animations.push(
          row.animate(
            [
              { transform },
              {
                transform: this.leaving.has(item)
                  ? `translateY(${-height}px)`
                  : "none",
              },
            ],
            options,
          ),
        );
    }
    this.animations = animations;
    if (!animations.length) {
      this.clearTransition();
      return;
    }
    this.list.dataset.shifting = "true";
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (this.animations !== animations) return;
        this.clearTransition();
        this.observeLayout();
        this.measure();
      },
      () => {},
    );
  }

  private clearTransition() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    for (const item of this.leaving) item.remove();
    this.leaving.clear();
    for (const item of this.list.children)
      (item as HTMLElement).style.removeProperty("overflow");
    delete this.list.dataset.shifting;
  }

  private observeLayout() {
    this.resize.disconnect();
    this.resize.observe(this.list);
    for (const item of this.list.children) this.resize.observe(item);
  }

  private measure() {
    this.anchors = [];
    if (!this.list.getClientRects().length) {
      this.clearTransition();
      return;
    }
    const top = this.list.getBoundingClientRect().top;
    for (const [i, item] of [...this.list.children].entries()) {
      const element = item as HTMLElement;
      const rowTop = element.getBoundingClientRect().top - top;
      const marker = element.querySelector<HTMLElement>(
        ".navigation-station-marker",
      );
      let y = rowTop;
      if (marker) {
        const style = getComputedStyle(marker, "::before");
        y =
          marker.getBoundingClientRect().top -
          top +
          parseFloat(style.top) +
          parseFloat(style.height) / 2;
        this.anchors.push({ element, index: Number(element.dataset.index), y });
      }
      element.style.setProperty(
        "--station-line-top",
        `${i === 0 && this.list.dataset.continuation !== "true" ? y : rowTop}px`,
      );
    }
    this.paint();
  }

  private paint() {
    const stops = this.leg?.transitStops;
    if (!stops) return;
    const position = this.located;
    const offsets = position?.path!.stopOffsets;
    let filled = -1;
    const anchors = this.anchors.filter(
      (anchor) => !stops[anchor.index].cancelled,
    );
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i],
        next = anchors[i + 1];
      const reached =
        this.index >= 0 &&
        (position
          ? offsets![anchor.index] <= position.meters! + 0.01
          : anchor.index <= this.index);
      if (reached) filled = anchor.y;
      if (
        position &&
        next &&
        position.meters! >= offsets![anchor.index] &&
        position.meters! < offsets![next.index]
      ) {
        const fraction =
          (position.meters! - offsets![anchor.index]) /
          (offsets![next.index] - offsets![anchor.index]);
        filled = anchor.y + (next.y - anchor.y) * fraction;
        break;
      }
    }
    for (const { element, index } of this.anchors) {
      const reached =
        !stops[index].cancelled &&
        this.index >= 0 &&
        (position
          ? offsets![index] <= position.meters! + 0.01
          : index <= this.index);
      const value = String(reached);
      if (element.dataset.reached !== value) element.dataset.reached = value;
    }
    this.list.style.setProperty("--station-progress", `${filled.toFixed(3)}px`);
  }
}
