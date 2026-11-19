import buildVersion from "virtual:foldroute-build-version";
import { writable } from "svelte/store";
import { readOutbox } from "./feedback-outbox";
export interface FeedbackCapture {
  focusId?: string;
  release: string;
  environment: string;
  id: string;
  capturedAt: string;
  context: unknown;
  epoch: number;
  revision: string;
}
interface Provider {
  read(): unknown;
  revision(): string;
  frame(): Promise<string | undefined>;
}
export const feedbackProvider = writable<Provider | undefined>();
export const feedbackCapture = writable<FeedbackCapture | undefined>();
let provider: Provider | undefined;
let epoch = 0;
let sequence = 0;
let closingHistory = false;
let activeHistoryId: string | undefined;
/** Move the feedback overlay with app navigation instead of leaving it behind. */
export function writeFeedbackHistory(
  state: Record<string, unknown>,
  push: boolean,
  url: string | URL,
) {
  const entry = { ...state };
  delete entry.feedbackId;
  if (activeHistoryId && history.state?.feedbackId === activeHistoryId) {
    if (push) {
      // Reuse the old overlay entry for the new page; Back closes only feedback.
      history.replaceState(entry, "", url);
      history.pushState({ ...entry, feedbackId: activeHistoryId }, "", url);
    } else {
      history.replaceState({ ...entry, feedbackId: activeHistoryId }, "", url);
    }
  } else {
    history[push ? "pushState" : "replaceState"](entry, "", url);
  }
}
export function consumeFeedbackBack(event: Event) {
  if (closingHistory) {
    closingHistory = false;
    event.stopImmediatePropagation();
    return true;
  }
  return false;
}
export async function configureFeedback(value: Provider) {
  epoch = (await readOutbox()).epoch;
  provider = value;
  feedbackProvider.set(value);
  const changed = () => {
    closeFeedback();
    void readOutbox()
      .then((value) => {
        epoch = value.epoch;
      })
      .catch(() => {});
  };
  window.addEventListener("foldroute:feedback-clear", changed);
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel("foldroute-feedback-clear");
  if (channel) channel.onmessage = changed;
}
export function openFeedback(trigger: HTMLButtonElement) {
  if (!provider || activeHistoryId) return;
  const capture: FeedbackCapture = {
    focusId: trigger.id,
    release: buildVersion.commit,
    environment: import.meta.env.PROD ? "production" : "development",
    id: crypto.randomUUID().replaceAll("-", ""),
    capturedAt: new Date().toISOString(),
    epoch,
    revision: provider.revision(),
    context: structuredClone({
      application: provider.read(),
      ui: {
        focused: document.activeElement?.id,
        inputs: [
          ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            "main input:not([type=file]):not([type=password]), main textarea",
          ),
        ]
          .filter((e) => e.getClientRects().length)
          .map((e) => ({
            id: e.id,
            value: e.value,
            checked: "checked" in e ? e.checked : undefined,
          })),
        suggestions: [...document.querySelectorAll<HTMLElement>(".suggestions")]
          .filter((e) => e.getClientRects().length)
          .map((e) => ({ id: e.id, text: e.innerText })),
        dialogs: [
          ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
        ].map((e) => e.id),
        scroll: { x: scrollX, y: scrollY },
        viewport: {
          width: innerWidth,
          height: innerHeight,
          ratio: devicePixelRatio,
          visual: visualViewport && {
            width: visualViewport.width,
            height: visualViewport.height,
            offsetTop: visualViewport.offsetTop,
          },
        },
        browser: navigator.userAgent,
        online: navigator.onLine,
      },
    }),
  };
  sequence++;
  history.pushState(
    { ...history.state, feedbackId: capture.id },
    "",
    location.href,
  );
  activeHistoryId = capture.id;
  feedbackCapture.set(capture);
}
export function closeFeedback() {
  const historyId = activeHistoryId;
  activeHistoryId = undefined;
  sequence++;
  feedbackCapture.set(undefined);
  if (historyId && history.state?.feedbackId === historyId && !closingHistory) {
    closingHistory = true;
    history.back();
  }
}
export async function captureFeedbackImage(value: FeedbackCapture) {
  const ticket = sequence;
  let changed = false,
    expired = false;
  const signature = () =>
    JSON.stringify([
      innerWidth,
      innerHeight,
      visualViewport?.width,
      visualViewport?.height,
      visualViewport?.offsetTop,
      visualViewport?.offsetLeft,
      visualViewport?.scale,
    ]);
  const initial = signature();
  const check = () => {
    const viewport = visualViewport;
    if (
      changed ||
      signature() !== initial ||
      (viewport &&
        (Math.abs(viewport.height - innerHeight) > 4 ||
          Math.abs(viewport.width - innerWidth) > 4 ||
          Math.abs(viewport.offsetTop) > 2 ||
          Math.abs(viewport.offsetLeft) > 2 ||
          Math.abs(viewport.scale - 1) > 0.01))
    )
      throw new Error(
        "Bild bei Bildschirmtastatur oder vergrößerter Ansicht nicht verfügbar. Text und ursprünglicher Diagnosezustand bleiben sendbar.",
      );
    if (expired || ticket !== sequence)
      throw new Error("Aufnahme abgebrochen.");
    if (provider?.revision() !== value.revision)
      throw new Error(
        "Ansicht hat inzwischen gewechselt. Bericht enthält den ursprünglichen Zustand ohne Bild.",
      );
  };
  const resize = () => {
    if (signature() !== initial) changed = true;
  };
  const viewport = visualViewport;
  window.addEventListener("resize", resize);
  viewport?.addEventListener("resize", resize);
  viewport?.addEventListener("scroll", resize);
  let timer: ReturnType<typeof setTimeout>;
  try {
    check();
    const work = (async () => {
      const { domToBlob } = await import("modern-screenshot");
      check();
      const frame = await provider?.frame();
      check();
      const imageAt = new Date().toISOString();
      const { backgroundColor } = getComputedStyle(document.documentElement);
      const image = await domToBlob(document.body, {
        width: innerWidth,
        height: innerHeight,
        scale: Math.min(
          devicePixelRatio,
          2,
          Math.sqrt(2_000_000 / (innerWidth * innerHeight)),
        ),
        backgroundColor,
        timeout: 4000,
        // The document scroll belongs to <html>, outside the captured <body>.
        // Offset the clone's flow while keeping fixed controls in the viewport.
        style: { marginTop: `${-scrollY}px`, marginLeft: `${-scrollX}px` },
        features: { restoreScrollPosition: true },
        filter: (node) =>
          node.nodeName !== "NOSCRIPT" &&
          !(node instanceof Element && node.hasAttribute("data-feedback-ui")),
        onCloneEachNode: (node) => {
          // Hide the action without shifting the content below it.
          if (
            node instanceof HTMLElement &&
            node.hasAttribute("data-feedback-trigger")
          )
            node.style.opacity = "0";
        },
        onEmbedNode: (clone) => {
          const image =
            clone instanceof Element
              ? clone.querySelector<HTMLImageElement>(
                  "#map .maplibregl-canvas-container img",
                )
              : null;
          if (image && frame) image.src = frame;
        },
        onCreateForeignObjectSvg: (svg) => {
          // WebKit's redraw clears the canvas fill. Paint behind the scrolled
          // body in the SVG so every redraw includes the viewport background.
          const background = svg.ownerDocument.createElementNS(
            svg.namespaceURI,
            "rect",
          );
          background.setAttribute("width", "100%");
          background.setAttribute("height", "100%");
          background.setAttribute("fill", backgroundColor);
          svg.prepend(background);
        },
      });
      check();
      return { image, imageAt };
    })();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(
            new Error(
              "Bildaufnahme dauerte zu lange. Text und Diagnose bleiben verfügbar.",
            ),
          );
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    window.removeEventListener("resize", resize);
    viewport?.removeEventListener("resize", resize);
    viewport?.removeEventListener("scroll", resize);
  }
}
