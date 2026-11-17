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
let origin: FeedbackCapture | undefined;
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
  const remember = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("#route-more"))
      rememberFeedbackOrigin();
  };
  window.addEventListener("pointerdown", remember, true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") remember(event);
    },
    true,
  );
  const changed = () => {
    origin = undefined;
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
/** Runs in capture phase, before menu focus/outside-click handlers. */
export function rememberFeedbackOrigin() {
  if (!provider) return;
  origin = {
    focusId: document.activeElement?.id,
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
}
export function openFeedback() {
  if (!origin) rememberFeedbackOrigin();
  if (!origin) return;
  sequence++;
  history.pushState(
    { ...history.state, feedbackId: origin.id },
    "",
    location.href,
  );
  activeHistoryId = origin.id;
  feedbackCapture.set(origin);
  origin = undefined;
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
      const image = await domToBlob(document.body, {
        width: innerWidth,
        height: innerHeight,
        scale: Math.min(
          devicePixelRatio,
          2,
          Math.sqrt(2_000_000 / (innerWidth * innerHeight)),
        ),
        backgroundColor: getComputedStyle(document.documentElement)
          .backgroundColor,
        timeout: 4000,
        features: { restoreScrollPosition: true },
        filter: (node) =>
          node.nodeName !== "NOSCRIPT" &&
          !(node instanceof Element && node.hasAttribute("data-feedback-ui")),
        onEmbedNode: (clone) => {
          const image =
            clone instanceof Element
              ? clone.querySelector<HTMLImageElement>(
                  "#map .maplibregl-canvas-container img",
                )
              : null;
          if (image && frame) image.src = frame;
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
