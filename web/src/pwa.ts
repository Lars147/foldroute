import { el } from "./ui";
import { reveal } from "./motion";
import { afterStartup } from "./startup";
import {
  updateBlockedReason,
  updatePresentation,
  type UpdateContext,
  type UpdateEnvironment,
  type UpdateState,
} from "./pwa-update-state";
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
interface PWAOptions {
  context: () => UpdateContext;
  notify: (message: string) => void;
}

export function setupPWA(options: PWAOptions) {
  const events = new AbortController();
  let disposed = false;
  let observer: MutationObserver | undefined;
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    disposed = true;
    events.abort();
    observer?.disconnect();
    clearTimeout(activationTimer);
  };
  const installGuide = el("ios-install-guide");
  let installEvent: InstallEvent | undefined,
    registration: ServiceWorkerRegistration | undefined;
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  function installed() {
    el("install").hidden = standalone();
    installGuide.hidden = true;
  }
  installed();
  window.addEventListener(
    "appinstalled",
    () => {
      installEvent = undefined;
      el("install").hidden = true;
      installGuide.hidden = true;
      el("install-message").textContent = "FoldRoute wurde installiert.";
    },
    { signal: events.signal },
  );
  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      event.preventDefault();
      installEvent = event as InstallEvent;
    },
    { signal: events.signal },
  );
  el("install").addEventListener(
    "click",
    async () => {
      installGuide.hidden = true;
      if (installEvent) {
        el("install-message").textContent = "";
        await installEvent.prompt();
        await installEvent.userChoice;
        installEvent = undefined;
        return;
      }
      const ios =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      el("install-message").textContent = ios
        ? "So installierst du FoldRoute auf deinem Home-Bildschirm:"
        : "Öffne das Browsermenü und wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“, sofern dein Browser dies anbietet.";
      installGuide.hidden = !ios;
      reveal(el("install-message"), { y: 6 });
    },
    { signal: events.signal },
  );
  el("app-updates").hidden = false;
  if (!import.meta.env.PROD) {
    el("update-description").textContent =
      "Entwicklungsmodus – Updates nicht verfügbar";
    el<HTMLButtonElement>("check-updates").disabled = true;
    el<HTMLButtonElement>("settings-update-now").disabled = true;
    return { refresh: () => {}, dispose };
  }
  if (!("serviceWorker" in navigator) || !isSecureContext) {
    el("update-description").textContent =
      "App-Updates werden von diesem Browser nicht unterstützt.";
    el("check-updates").hidden = true;
    return { refresh: () => {}, dispose };
  }

  const dismissalKey = "foldroute.updateDismissed.v1";
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem(dismissalKey) === "true";
  } catch {
    /* Dismissal still works in memory when session storage is unavailable. */
  }
  const state: UpdateState = {
    dismissed,
    checking: false,
    checked: false,
    applying: false,
    reloadNeeded: false,
    error: "",
  };
  let applyingFromSettings = false;
  let reloadCommitted = false;
  let hadController = !!navigator.serviceWorker.controller;
  let registering: Promise<ServiceWorkerRegistration | undefined> | undefined;
  const watched = new WeakSet<ServiceWorker>();
  const base = new URL("./", document.baseURI);
  const environment = (): UpdateEnvironment => ({
    startupReady: !!el("app-startup").hidden,
    visible: !document.hidden,
    overlayOpen: !!document.querySelector("dialog[open], :popover-open"),
    searchFocused: document.body.classList.contains("search-focus-mode"),
    online: navigator.onLine,
    controlled: !!navigator.serviceWorker.controller,
    waiting: !!registration?.waiting,
    installing: registration?.installing?.state === "installing",
  });
  const blockedReason = (fromSettings = false) =>
    updateBlockedReason(options.context(), environment(), fromSettings);
  const text = (id: string, value: string) => {
    if (el(id).textContent !== value) el(id).textContent = value;
  };
  function render() {
    if (disposed) return;
    const presentation = updatePresentation(
      state,
      options.context(),
      environment(),
    );
    const { hasUpdate, showBanner, showAvailability, status } = presentation;
    const focusedAction = document.activeElement;
    el("app-updates").toggleAttribute("data-update-available", hasUpdate);
    // The animated tab indicator contains an aria-hidden copy of each icon.
    for (const badge of document.querySelectorAll<HTMLElement>(".update-badge"))
      badge.hidden = !hasUpdate;
    if (hasUpdate)
      el("tab-settings").setAttribute(
        "aria-label",
        "Einstellungen, Update verfügbar",
      );
    else el("tab-settings").removeAttribute("aria-label");
    if (showBanner && el("update-banner").hidden) {
      el("update-banner").hidden = false;
      reveal(el("update-banner"), { y: 8 });
    } else if (!showBanner) el("update-banner").hidden = true;

    text(
      "update-availability",
      showAvailability ? "Neue Version verfügbar." : "",
    );
    el("update-availability").hidden = !showAvailability;
    text("update-description", status);
    const checkButton = el<HTMLButtonElement>("check-updates");
    checkButton.hidden = presentation.checkHidden;
    checkButton.disabled = presentation.checkDisabled;
    checkButton.setAttribute("aria-busy", String(presentation.checkBusy));
    const reloadButton = el<HTMLButtonElement>("settings-update-now");
    reloadButton.hidden = presentation.reloadHidden;
    if (
      (focusedAction === checkButton && checkButton.hidden) ||
      (focusedAction === reloadButton && reloadButton.hidden)
    ) {
      (reloadButton.hidden ? el("app-updates-heading") : reloadButton).focus({
        preventScroll: true,
      });
    }
  }
  const refresh = () => {
    if (!disposed) queueMicrotask(render);
  };
  function activationFailed(message: string) {
    clearTimeout(activationTimer);
    state.applying = false;
    applyingFromSettings = false;
    state.error = message;
    render();
    options.notify(message);
  }
  function reload(fromSettings: boolean) {
    clearTimeout(activationTimer);
    const blocked = blockedReason(fromSettings);
    if (blocked) {
      state.applying = false;
      applyingFromSettings = false;
      state.reloadNeeded = true;
      render();
      options.notify(
        `Update bereit. ${blocked} Lade danach erneut bewusst neu.`,
      );
      return;
    }
    if (reloadCommitted) return;
    reloadCommitted = true;
    location.reload();
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => {
      if (hadController) state.reloadNeeded = true;
      hadController = !!navigator.serviceWorker.controller;
      if (state.applying) reload(applyingFromSettings);
      else render();
    },
    { signal: events.signal },
  );
  function watch(worker: ServiceWorker | null) {
    if (disposed || !worker || watched.has(worker)) return;
    watched.add(worker);
    const changed = () => {
      if (worker.state === "installed") {
        state.error = "";
      } else if (worker.state === "activated") {
        worker.removeEventListener("statechange", changed);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", changed);
        if (state.applying) {
          activationFailed(
            "Update konnte nicht aktiviert werden. Bitte erneut versuchen.",
          );
          return;
        }
        state.error =
          "Update konnte nicht heruntergeladen werden. Bitte erneut suchen.";
      }
      refresh();
    };
    worker.addEventListener("statechange", changed, { signal: events.signal });
    refresh();
  }
  function register() {
    if (registration) return Promise.resolve(registration);
    registering ??= navigator.serviceWorker
      .register(new URL("sw.js", base), {
        scope: base.pathname,
        updateViaCache: "none",
      })
      .then((reg) => {
        if (disposed) return reg;
        registration = reg;
        state.error = "";
        watch(reg.installing);
        watch(reg.waiting);
        reg.addEventListener("updatefound", () => watch(reg.installing), {
          signal: events.signal,
        });
        render();
        return reg;
      })
      .catch(() => {
        state.error =
          "Updates konnten nicht geprüft werden. Bitte erneut versuchen.";
        render();
        return undefined;
      })
      .finally(() => {
        registering = undefined;
      });
    return registering;
  }
  async function check() {
    if (
      state.checking ||
      state.applying ||
      registration?.installing ||
      !navigator.onLine
    )
      return;
    state.checking = true;
    state.checked = false;
    state.error = "";
    render();
    try {
      const reg = await register();
      if (!reg || disposed) return;
      await reg.update();
      state.checked = true;
    } catch {
      state.error =
        "Updates konnten nicht geprüft werden. Bitte erneut versuchen.";
    } finally {
      state.checking = false;
      render();
    }
  }
  function applyUpdate(fromSettings = false) {
    const blocked = blockedReason(fromSettings);
    if (blocked) {
      render();
      options.notify(blocked);
      return;
    }
    if (state.applying) return;
    if (state.reloadNeeded) return reload(fromSettings);
    const worker = registration?.waiting;
    if (!worker || !navigator.serviceWorker.controller) {
      render();
      options.notify(
        "Kein Update zum Neuladen bereit. Bitte erneut nach Updates suchen.",
      );
      return;
    }
    state.applying = true;
    applyingFromSettings = fromSettings;
    state.error = "";
    render();
    activationTimer = setTimeout(() => {
      activationFailed(
        "Update wurde nicht rechtzeitig aktiviert. Bitte erneut versuchen.",
      );
    }, 15000);
    worker.postMessage({ type: "SKIP_WAITING" });
  }
  el("check-updates").addEventListener("click", () => void check(), {
    signal: events.signal,
  });
  el("update-now").addEventListener("click", () => applyUpdate(), {
    signal: events.signal,
  });
  el("settings-update-now").addEventListener("click", () => applyUpdate(true), {
    signal: events.signal,
  });
  el("update-later").addEventListener(
    "click",
    () => {
      state.dismissed = true;
      try {
        sessionStorage.setItem(dismissalKey, "true");
      } catch {
        /* Retain the in-memory dismissal without session storage. */
      }
      el("tab-settings").focus({ preventScroll: true });
      render();
    },
    { signal: events.signal },
  );
  for (const event of ["input", "change", "focusin", "focusout"])
    document.addEventListener(event, refresh, { signal: events.signal });
  observer = new MutationObserver(refresh);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-navigation", "data-view"],
  });
  for (const dialog of document.querySelectorAll("dialog"))
    observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  window.addEventListener(
    "online",
    () => {
      render();
      void check();
    },
    { signal: events.signal },
  );
  window.addEventListener("offline", render, { signal: events.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      render();
      if (document.visibilityState === "visible" && navigator.onLine)
        void check();
    },
    { signal: events.signal },
  );
  afterStartup(render);
  render();
  void register();
  return { refresh, dispose };
}
