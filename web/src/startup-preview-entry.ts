import { icon } from "./ui";

// Dev-only entry: reuse the real home markup without opening storage, GPS or routing.
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
  element.append(icon(element.dataset.icon!));
});
export const startupReady = new Promise<void>((resolve) => {
  const release = (event: MessageEvent) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      event.data !== "foldroute:splash-continue"
    )
      return;
    window.removeEventListener("message", release);
    resolve();
  };
  window.addEventListener("message", release);
  parent.postMessage("foldroute:splash-ready", location.origin);
});
