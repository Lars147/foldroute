const minimumDisplay = 600;
const pendingPresentation = new Set<() => void>();

window.addEventListener("foldroute:startup-failed", () =>
  pendingPresentation.clear(),
);

/** Modal dialogs enter the top layer, so present them only after the splash has disappeared. */
export function afterStartup(present: () => void) {
  if (document.body.hasAttribute("data-startup-error")) return;
  if (document.getElementById("app-startup")!.hidden) present();
  else pendingPresentation.add(present);
}

/** Readiness and the minimum display run concurrently, independent of the logo animation. */
function waitForMinimumDisplay(): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    const complete = (ready: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("foldroute:startup-visible", check);
      window.removeEventListener("foldroute:startup-failed", failed);
      document.removeEventListener("visibilitychange", check);
      resolve(ready);
    };
    const failed = () => complete(false);
    const check = () => {
      if (document.body.hasAttribute("data-startup-error")) return failed();
      const visibleAt = document.documentElement.dataset.startupVisibleAt;
      if (visibleAt === undefined) return;
      const remaining =
        minimumDisplay - (performance.now() - Number(visibleAt));
      clearTimeout(timer);
      if (remaining <= 0) complete(true);
      else timer = window.setTimeout(check, Math.ceil(remaining));
    };
    window.addEventListener("foldroute:startup-visible", check);
    window.addEventListener("foldroute:startup-failed", failed);
    document.addEventListener("visibilitychange", check);
    check();
  });
}

/** Release controls after local restoration and the visible PWA splash's minimum display. */
export async function finishStartup(): Promise<boolean> {
  const splash = document.getElementById("app-startup")!;
  if (document.body.hasAttribute("data-startup-error")) return false;
  const visible = splash.getClientRects().length > 0;
  if (visible && !(await waitForMinimumDisplay())) return false;
  if (visible) splash.dataset.exiting = "";
  delete document.body.dataset.starting;
  document
    .querySelectorAll<HTMLElement>("#main, .app-tabs, .app-header, .skip")
    .forEach((element) => {
      element.inert = false;
    });
  splash.inert = true;
  splash.setAttribute("aria-hidden", "true");
  const hide = () => {
    splash.hidden = true;
    delete splash.dataset.exiting;
    const presentations = [...pendingPresentation];
    pendingPresentation.clear();
    presentations.forEach((present) => present());
  };
  if (!visible || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    hide();
    return true;
  }
  const fade = splash.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 120,
    easing: "ease-out",
  });
  void fade.finished.then(hide, hide);
  return true;
}
