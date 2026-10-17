/** Release the startup guard once the entrypoint has chosen its initial UI. */
export function finishStartup() {
  const splash = document.getElementById("app-startup")!;
  const visible = splash.getClientRects().length > 0;
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
  };
  if (!visible || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    hide();
    return;
  }
  const fade = splash.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 120,
    easing: "ease-out",
  });
  void fade.finished.then(hide, hide);
}
