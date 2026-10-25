import { el } from "./ui";

const rect = (element: Element | null) =>
  element?.getClientRects().length
    ? element.getBoundingClientRect().toJSON()
    : null;

// Deliberately whitelist layout properties: never read labels, inputs, map data,
// local storage, route URL parameters, or canvas pixels.
function styles(element: Element, pseudo?: string) {
  const style = getComputedStyle(element, pseudo);
  return Object.fromEntries(
    [
      "display",
      "position",
      "top",
      "bottom",
      "height",
      "padding-top",
      "padding-bottom",
      "background-color",
      "background-image",
      "opacity",
      "filter",
      "backdrop-filter",
      "transform",
      "z-index",
    ].map((key) => [key, style.getPropertyValue(key)]),
  );
}

export function mountScreenDiagnostics() {
  const root = document.documentElement;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.append(probe);
  function snapshot() {
    const safe = getComputedStyle(probe);
    const viewport = window.visualViewport;
    const navigatorStandalone =
      (navigator as Navigator & { standalone?: boolean }).standalone ?? null;
    const worker = navigator.serviceWorker?.controller;
    const map = document.getElementById("map");
    const navigationMap = document.getElementById("navigation-map");
    return {
      capturedAt: new Date().toISOString(),
      view: document.body.dataset.view ?? null,
      navigation: document.body.dataset.navigation ?? null,
      resultScreen:
        document.getElementById("map-view")?.dataset.resultScreen ?? null,
      standalone:
        matchMedia("(display-mode: standalone)").matches ||
        navigatorStandalone === true,
      navigatorStandalone,
      standaloneAttribute: root.hasAttribute("data-standalone"),
      theme: root.dataset.theme ?? null,
      systemColorScheme: matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
      },
      window: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        scrollX,
        scrollY,
      },
      document: { width: root.clientWidth, height: root.clientHeight },
      visualViewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            offsetTop: viewport.offsetTop,
            offsetLeft: viewport.offsetLeft,
            scale: viewport.scale,
          }
        : null,
      safeArea: {
        top: parseFloat(safe.paddingTop),
        right: parseFloat(safe.paddingRight),
        bottom: parseFloat(safe.paddingBottom),
        left: parseFloat(safe.paddingLeft),
      },
      devicePixelRatio,
      orientation: screen.orientation?.type ?? null,
      meta: Object.fromEntries(
        [
          "viewport",
          "theme-color",
          "apple-mobile-web-app-status-bar-style",
        ].map((name) => [
          name,
          document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
            ?.content ?? null,
        ]),
      ),
      layout: {
        root: { bounds: rect(root), styles: styles(root) },
        body: { bounds: rect(document.body), styles: styles(document.body) },
        statusBarOverlay: styles(document.body, "::before"),
        map: map ? { bounds: rect(map), styles: styles(map) } : null,
        navigationMap: navigationMap
          ? { bounds: rect(navigationMap), styles: styles(navigationMap) }
          : null,
      },
      serviceWorker: worker
        ? { path: new URL(worker.scriptURL).pathname, state: worker.state }
        : null,
    };
  }
  let lastMapSnapshot: ReturnType<typeof snapshot> | null = null;
  function captureMap() {
    if (document.hidden) return;
    const visibleMap = ["navigation-map", "map"].some((id) => {
      const bounds = rect(document.getElementById(id));
      return bounds && bounds.width > 0 && bounds.height > 0;
    });
    if (visibleMap) lastMapSnapshot = snapshot();
  }
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(captureMap);
  };
  // Capture before the tab's own click handler hides the map, including
  // keyboard/assistive-technology activation. Only one sample stays in memory.
  document.addEventListener("click", captureMap, true);
  for (const event of ["resize", "pageshow", "orientationchange"])
    window.addEventListener(event, schedule);
  document.addEventListener("visibilitychange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    attributeFilter: ["data-view", "data-navigation"],
  });
  observer.observe(root, {
    attributeFilter: ["data-theme", "data-standalone"],
  });
  observer.observe(el("map-view"), {
    attributeFilter: ["hidden", "data-result-screen"],
  });
  schedule();

  el("copy-screen-diagnostics").onclick = async () => {
    const report = {
      diagnostic: "foldroute-screen-v1",
      build: el("app-version").textContent?.trim() ?? null,
      units: "CSS pixels",
      path: location.pathname,
      secureContext: isSecureContext,
      userAgent: navigator.userAgent,
      lastMapSnapshot,
      current: snapshot(),
    };
    const value = el<HTMLTextAreaElement>("screen-diagnostics-value");
    value.value = JSON.stringify(report, null, 2);
    const fallback = el("screen-diagnostics-fallback");
    fallback.hidden = true;
    const status = el("screen-diagnostics-status");
    const missing = lastMapSnapshot
      ? ""
      : "Noch keine Kartenansicht erfasst. Bitte zuerst eine Route öffnen. ";
    try {
      await navigator.clipboard.writeText(value.value);
      status.textContent = `${missing}Diagnose kopiert. Du kannst sie jetzt teilen.`;
    } catch {
      // Clipboard permission can be denied even in a secure installed app.
      fallback.hidden = false;
      status.textContent = `${missing}Bitte die Diagnose im Textfeld manuell kopieren.`;
      value.focus();
      value.select();
    }
  };
}
