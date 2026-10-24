import { animate } from "motion/mini";
import { spring } from "motion";

export const motionTime = {
  feedback: 0.12,
  selection: 0.22,
  page: 0.3,
  panel: 0.36,
  exit: 0.24,
};
const reduced =
  typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)")
    : undefined;
const running = new Map<
  HTMLElement,
  { cancel: () => void; targetTop?: number }
>();

export function stopMotion(element: HTMLElement) {
  running.get(element)?.cancel();
}
export function stopMotionWithin(root: HTMLElement) {
  for (const element of running.keys())
    if (root.contains(element)) stopMotion(element);
}

export function motionTargetTop(element: HTMLElement) {
  return running.get(element)?.targetTop;
}

export function motionAllowed(element: HTMLElement) {
  return (
    !reduced?.matches &&
    !document.hidden &&
    !("starting" in document.body.dataset) &&
    element.isConnected &&
    typeof element.animate === "function" &&
    element.getClientRects().length > 0
  );
}

/** The DOM already has its final state. Motion never owns visibility or focus. */
function play(
  element: HTMLElement,
  x: number,
  y: number,
  duration: number,
  fade: number | false,
  physics: boolean,
  size?: { width: [number, number]; height: [number, number] },
) {
  stopMotion(element);
  if (!motionAllowed(element)) return;
  const properties = [
    "translate",
    ...(fade !== false ? ["opacity"] : []),
    ...(size ? ["width", "height"] : []),
  ];
  const original = properties.map((name) => [
    name,
    element.style.getPropertyValue(name),
    element.style.getPropertyPriority(name),
  ]);
  const controls = animate(
    element,
    {
      translate: [`${x}px ${y}px`, "0px 0px"],
      ...(size
        ? {
            width: size.width.map((value) => `${value}px`),
            height: size.height.map((value) => `${value}px`),
          }
        : {}),
      ...(fade !== false
        ? {
            opacity: [
              Number(getComputedStyle(element).opacity) * fade,
              Number(getComputedStyle(element).opacity),
            ],
          }
        : {}),
    },
    physics
      ? { type: spring, duration, bounce: 0 }
      : { duration, ease: [0.2, 0, 0.38, 0.9] },
  );
  const cleanup = () => {
    if (running.get(element) !== entry) return;
    running.delete(element);
    for (const [name, value, priority] of original) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
  };
  const entry = {
    cancel: () => {
      controls.cancel();
      cleanup();
    },
  };
  running.set(element, entry);
  void controls.finished.then(cleanup, cleanup);
}

export function reveal(
  element: HTMLElement,
  options: {
    x?: number;
    y?: number;
    duration?: number;
    fromOpacity?: number;
  } = {},
) {
  play(
    element,
    options.x ?? 0,
    options.y ?? 10,
    options.duration ?? motionTime.page,
    options.fromOpacity ?? 0.35,
    false,
  );
}

export function settle(
  element: HTMLElement,
  x: number,
  y: number,
  duration = motionTime.panel,
) {
  play(element, x, y, duration, false, true);
}

/** Grow from the current visible height; bottom-anchored actions stay in place. */
export function resizeHeight(element: HTMLElement, from: number) {
  stopMotion(element);
  const to = element.getBoundingClientRect().height;
  if (!motionAllowed(element) || Math.abs(to - from) < 1) return;
  const targetTop = element.offsetTop;
  const animation = element.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: 480, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
  );
  const cleanup = () => {
    if (running.get(element) === entry) running.delete(element);
  };
  const entry = {
    targetTop,
    cancel: () => {
      animation.cancel();
      cleanup();
    },
  };
  running.set(element, entry);
  void animation.finished.then(cleanup, cleanup);
}

export type Positions = Map<string, { left: number; top: number }>;
export function captureList(parent: HTMLElement, key = "motionKey"): Positions {
  return new Map(
    [...parent.children].flatMap((child) => {
      if (
        !(child instanceof HTMLElement) ||
        !child.dataset[key] ||
        !child.getClientRects().length
      )
        return [];
      const { left, top } = child.getBoundingClientRect();
      return [[child.dataset[key]!, { left, top }]];
    }),
  );
}

export function reflowList(
  parent: HTMLElement,
  before: Positions,
  key = "motionKey",
) {
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement) || !child.dataset[key]) continue;
    stopMotion(child);
    if (!child.getClientRects().length) continue;
    const old = before.get(child.dataset[key]!);
    if (!old) reveal(child, { y: 8, duration: motionTime.selection });
    else {
      const next = child.getBoundingClientRect();
      if (Math.abs(old.left - next.left) + Math.abs(old.top - next.top) > 1)
        settle(child, old.left - next.left, old.top - next.top);
    }
  }
}

function stopAll() {
  for (const entry of [...running.values()]) entry.cancel();
}
reduced?.addEventListener("change", stopAll);
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAll();
  });
  // Moving ancestors must never change the containing block of a focused search field.
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    for (const element of running.keys())
      if (element.contains(event.target)) stopMotion(element);
  });
}

let initialized = false;
export function setupMotion() {
  if (initialized) return;
  initialized = true;
  setupAppearanceMotion();
  setupTabMotion();
  document.addEventListener(
    "toggle",
    (event) => {
      const detail = event.target;
      if (!(detail instanceof HTMLDetailsElement) || !detail.open) return;
      for (const child of detail.children)
        if (child instanceof HTMLElement && child.tagName !== "SUMMARY")
          reveal(child, { y: 6, duration: motionTime.selection });
    },
    true,
  );
}

function setupTabMotion() {
  const tabs = document.querySelector<HTMLElement>(".app-tabs")!;
  const indicator = document.createElement("div");
  indicator.className = "tab-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const contents = document.createElement("div");
  contents.className = "tab-indicator-contents";
  const captions = [
    ...tabs.querySelectorAll<HTMLElement>(".app-tab-content"),
  ].map((caption) => {
    const copy = caption.cloneNode(true) as HTMLElement;
    copy.classList.add("tab-indicator-copy");
    copy.dataset.tab = caption.closest("button")!.id;
    contents.append(copy);
    return { caption, copy };
  });
  indicator.append(contents);
  tabs.append(indicator);
  let selected: string | undefined;
  const position = (moving: boolean) => {
    if (!tabs.getClientRects().length) {
      stopMotionWithin(indicator);
      delete tabs.dataset.motion;
      selected = undefined;
      return;
    }
    const button = tabs.querySelector<HTMLButtonElement>(
      "button[aria-current]",
    )!;
    const old = indicator.getBoundingClientRect();
    stopMotionWithin(indicator);
    const area = tabs.getBoundingClientRect(),
      target = button.getBoundingClientRect();
    const inset = parseFloat(
      getComputedStyle(tabs).getPropertyValue("--tab-indicator-inset"),
    );
    const left = target.left - area.left - tabs.clientLeft + inset;
    const top = target.top - area.top - tabs.clientTop + inset;
    const width = target.width - inset * 2;
    const height = target.height - inset * 2;
    indicator.style.left = `${left}px`;
    indicator.style.top = `${top}px`;
    indicator.style.width = `${width}px`;
    indicator.style.height = `${height}px`;
    contents.style.left = `${-left}px`;
    contents.style.top = `${-top}px`;
    contents.style.width = `${tabs.clientWidth}px`;
    contents.style.height = `${tabs.clientHeight}px`;
    for (const { caption, copy } of captions) {
      const bounds = caption.getBoundingClientRect();
      copy.style.left = `${bounds.left - area.left - tabs.clientLeft}px`;
      copy.style.top = `${bounds.top - area.top - tabs.clientTop}px`;
      copy.style.width = `${bounds.width}px`;
      copy.style.height = `${bounds.height}px`;
      copy.style.font = getComputedStyle(caption).font;
    }
    if (moving && selected !== button.id && tabs.dataset.motion === "ready") {
      const x = old.left - (target.left + inset);
      const y = old.top - (target.top + inset);
      play(indicator, x, y, motionTime.selection, false, true, {
        width: [old.width, width],
        height: [old.height, height],
      });
      // Counter-move the clipped copies so icons and labels stay fixed.
      settle(contents, -x, -y, motionTime.selection);
    }
    selected = button.id;
    tabs.dataset.motion = "ready";
  };
  position(false);
  new MutationObserver(() => position(true)).observe(tabs, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });
  const resize = new ResizeObserver(() => position(false));
  resize.observe(tabs);
  // Text scaling can move an icon without resizing the fixed navigation bar.
  for (const button of tabs.querySelectorAll("button")) resize.observe(button);
  for (const { caption } of captions) resize.observe(caption);
}

function setupAppearanceMotion() {
  const segments = document.querySelector<HTMLElement>(".appearance-segments")!;
  const indicator = document.createElement("div");
  indicator.className = "appearance-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const labels = document.createElement("div");
  labels.className = "appearance-indicator-labels";
  const captions = [
    ...segments.querySelectorAll<HTMLInputElement>("input"),
  ].map((input) => {
    const caption = input.nextElementSibling as HTMLElement;
    const copy = document.createElement("div");
    copy.className = "appearance-indicator-label";
    copy.dataset.value = input.value;
    copy.textContent = caption.textContent;
    labels.append(copy);
    return { caption, copy };
  });
  indicator.append(labels);
  segments.append(indicator);
  // WebKit can lose :focus-visible when arrows focus the next native radio.
  segments.addEventListener("keydown", () => {
    segments.dataset.keyboardFocus = "true";
  });
  segments.addEventListener("pointerdown", () => {
    delete segments.dataset.keyboardFocus;
  });
  segments.addEventListener("focusout", (event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !segments.contains(event.relatedTarget)
    )
      delete segments.dataset.keyboardFocus;
  });
  let preference: string | undefined;
  const position = (moving: boolean) => {
    if (!segments.getClientRects().length) {
      stopMotionWithin(indicator);
      delete segments.dataset.motion;
      preference = undefined;
      return;
    }
    const input = segments.querySelector<HTMLInputElement>("input:checked")!;
    const target = input.nextElementSibling!.getBoundingClientRect();
    const old = indicator.getBoundingClientRect();
    stopMotionWithin(indicator);
    const area = segments.getBoundingClientRect();
    const left = target.left - area.left - segments.clientLeft;
    const top = target.top - area.top - segments.clientTop;
    indicator.style.left = `${left}px`;
    indicator.style.top = `${top}px`;
    indicator.style.width = `${target.width}px`;
    indicator.style.height = `${target.height}px`;
    labels.style.left = `${-left}px`;
    labels.style.top = `${-top}px`;
    labels.style.width = `${segments.clientWidth}px`;
    labels.style.height = `${segments.clientHeight}px`;
    for (const { caption, copy } of captions) {
      const bounds = caption.getBoundingClientRect();
      copy.style.left = `${bounds.left - area.left - segments.clientLeft}px`;
      copy.style.top = `${bounds.top - area.top - segments.clientTop}px`;
      copy.style.width = `${bounds.width}px`;
      copy.style.height = `${bounds.height}px`;
      copy.style.font = getComputedStyle(caption).font;
    }
    if (
      moving &&
      preference !== input.value &&
      segments.dataset.motion === "ready"
    ) {
      const x = old.left - target.left;
      const y = old.top - target.top;
      // Counter-move the clipped text so captions stay fixed as the fill glides.
      settle(indicator, x, y, motionTime.selection);
      settle(labels, -x, -y, motionTime.selection);
    }
    preference = input.value;
    segments.dataset.motion = "ready";
  };
  position(false);
  new MutationObserver(() => position(true)).observe(segments, {
    attributes: true,
    attributeFilter: ["data-appearance"],
  });
  const resize = new ResizeObserver(() => position(false));
  resize.observe(segments);
  for (const label of segments.querySelectorAll("label")) resize.observe(label);
}
