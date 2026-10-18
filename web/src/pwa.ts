import { el } from "./ui";
import { reveal } from "./motion";
import { afterStartup } from "./startup";
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
interface PWAOptions {
  context: () => { home: boolean; blockedReason?: string };
  notify: (message: string) => void;
}

export function setupPWA(options: PWAOptions) {
  let installEvent: InstallEvent | undefined,
    registration: ServiceWorkerRegistration | undefined;
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  function installed() {
    el("install").hidden = standalone();
  }
  installed();
  window.addEventListener("appinstalled", () => {
    installEvent = undefined;
    el("install").hidden = true;
    el("install-message").textContent = "FoldRoute wurde installiert.";
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event as InstallEvent;
  });
  el("install").onclick = async () => {
    if (installEvent) {
      await installEvent.prompt();
      await installEvent.userChoice;
      installEvent = undefined;
      return;
    }
    el("install-message").textContent =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
        ? "In Safari: Teilen öffnen und „Zum Home-Bildschirm“ wählen. Falls angeboten, „Als Web-App öffnen“ aktivieren."
        : "Öffne das Browsermenü und wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“, sofern dein Browser dies anbietet.";
    reveal(el("install-message"), { y: 6 });
  };
  if (!import.meta.env.PROD) return { refresh: () => {} };
  el("app-updates").hidden = false;
  if (!("serviceWorker" in navigator) || !isSecureContext) {
    el("update-description").textContent =
      "App-Updates werden von diesem Browser nicht unterstützt.";
    el("check-updates").hidden = true;
    return { refresh: () => {} };
  }

  const dismissalKey = "foldroute.updateDismissed.v1";
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem(dismissalKey) === "true";
  } catch {
    /* Dismissal still works in memory when session storage is unavailable. */
  }
  let checking = false,
    checked = false,
    applying = false,
    reloadNeeded = false,
    reloadCommitted = false,
    hadController = !!navigator.serviceWorker.controller,
    error = "";
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let registering: Promise<ServiceWorkerRegistration | undefined> | undefined;
  const watched = new WeakSet<ServiceWorker>();
  const base = new URL("./", document.baseURI);
  const available = () =>
    reloadNeeded ||
    (!!navigator.serviceWorker.controller && !!registration?.waiting);
  function blockedReason() {
    if (!el("app-startup").hidden || document.hidden)
      return "Sobald die App bereit ist, kannst du neu laden.";
    if (document.querySelector("dialog[open], :popover-open"))
      return "Schließe zuerst den geöffneten Dialog.";
    if (document.body.classList.contains("search-focus-mode"))
      return "Beende zuerst die Eingabe.";
    return options.context().blockedReason;
  }
  const text = (id: string, value: string) => {
    if (el(id).textContent !== value) el(id).textContent = value;
  };
  function render() {
    const hasUpdate = available();
    const blocked = blockedReason();
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
    const showBanner =
      hasUpdate &&
      !dismissed &&
      !applying &&
      !blocked &&
      options.context().home;
    if (showBanner && el("update-banner").hidden) {
      el("update-banner").hidden = false;
      reveal(el("update-banner"), { y: 8 });
    } else if (!showBanner) el("update-banner").hidden = true;

    const downloading =
      !!navigator.serviceWorker.controller &&
      registration?.installing?.state === "installing";
    const status = applying
      ? "App wird aktualisiert …"
      : hasUpdate
        ? [error, blocked ?? "Zum Aktualisieren wird die App neu geladen."]
            .filter(Boolean)
            .join(" ")
        : !navigator.onLine
          ? "Offline. Verbinde dich mit dem Internet, um nach Updates zu suchen."
          : error ||
            (downloading
              ? "Update wird heruntergeladen …"
              : checking
                ? "Suche läuft …"
                : checked
                  ? "Du bist auf dem neuesten Stand."
                  : "Updates werden automatisch im Hintergrund geprüft.");
    const showAvailability = hasUpdate && !applying;
    text(
      "update-availability",
      showAvailability ? "Neue Version verfügbar." : "",
    );
    el("update-availability").hidden = !showAvailability;
    text("update-description", status);
    const checkButton = el<HTMLButtonElement>("check-updates");
    checkButton.hidden = hasUpdate || applying;
    checkButton.disabled =
      checking || downloading || applying || !navigator.onLine;
    checkButton.setAttribute("aria-busy", String(checking || downloading));
    const reloadButton = el<HTMLButtonElement>("settings-update-now");
    reloadButton.hidden = !hasUpdate || !!blocked || applying;
    if (
      (focusedAction === checkButton && checkButton.hidden) ||
      (focusedAction === reloadButton && reloadButton.hidden)
    ) {
      (reloadButton.hidden ? el("app-updates-heading") : reloadButton).focus({
        preventScroll: true,
      });
    }
  }
  const refresh = () => queueMicrotask(render);
  function activationFailed(message: string) {
    clearTimeout(activationTimer);
    applying = false;
    error = message;
    render();
    options.notify(message);
  }
  function reload() {
    clearTimeout(activationTimer);
    const blocked = blockedReason();
    if (blocked) {
      applying = false;
      reloadNeeded = true;
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
  const ready = () =>
    (el("offline-ready").textContent =
      "Oberfläche offline verfügbar. Neue Routen und Straßenkarten benötigen Internet.");
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) reloadNeeded = true;
    hadController = !!navigator.serviceWorker.controller;
    if (applying) reload();
    else render();
  });
  function watch(worker: ServiceWorker | null) {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    const changed = () => {
      if (worker.state === "installed") {
        error = "";
        ready();
      } else if (worker.state === "activated") {
        worker.removeEventListener("statechange", changed);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", changed);
        if (applying) {
          activationFailed(
            "Update konnte nicht aktiviert werden. Bitte erneut versuchen.",
          );
          return;
        }
        error =
          "Update konnte nicht heruntergeladen werden. Bitte erneut suchen.";
      }
      refresh();
    };
    worker.addEventListener("statechange", changed);
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
        registration = reg;
        error = "";
        if (reg.active) ready();
        watch(reg.installing);
        watch(reg.waiting);
        reg.addEventListener("updatefound", () => watch(reg.installing));
        render();
        return reg;
      })
      .catch(() => {
        error = "Updates konnten nicht geprüft werden. Bitte erneut versuchen.";
        el("offline-ready").textContent =
          "Oberfläche konnte nicht offline bereitgestellt werden. Online kannst du weiterplanen.";
        render();
        return undefined;
      })
      .finally(() => {
        registering = undefined;
      });
    return registering;
  }
  async function check() {
    if (checking || applying || registration?.installing || !navigator.onLine)
      return;
    checking = true;
    checked = false;
    error = "";
    render();
    try {
      const reg = await register();
      if (!reg) return;
      await reg.update();
      checked = true;
    } catch {
      error = "Updates konnten nicht geprüft werden. Bitte erneut versuchen.";
    } finally {
      checking = false;
      render();
    }
  }
  function applyUpdate() {
    const blocked = blockedReason();
    if (blocked) {
      render();
      options.notify(blocked);
      return;
    }
    if (applying) return;
    if (reloadNeeded) return reload();
    const worker = registration?.waiting;
    if (!worker || !navigator.serviceWorker.controller) {
      render();
      options.notify(
        "Kein Update zum Neuladen bereit. Bitte erneut nach Updates suchen.",
      );
      return;
    }
    applying = true;
    error = "";
    render();
    activationTimer = setTimeout(() => {
      activationFailed(
        "Update wurde nicht rechtzeitig aktiviert. Bitte erneut versuchen.",
      );
    }, 15000);
    worker.postMessage({ type: "SKIP_WAITING" });
  }
  el("check-updates").onclick = () => void check();
  el("update-now").onclick = applyUpdate;
  el("settings-update-now").onclick = applyUpdate;
  el("update-later").onclick = () => {
    dismissed = true;
    try {
      sessionStorage.setItem(dismissalKey, "true");
    } catch {
      /* Retain the in-memory dismissal without session storage. */
    }
    el("tab-settings").focus({ preventScroll: true });
    render();
  };
  for (const event of ["input", "change", "focusin", "focusout"])
    document.addEventListener(event, refresh);
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-navigation", "data-view"],
  });
  for (const dialog of document.querySelectorAll("dialog"))
    observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  window.addEventListener("online", () => {
    render();
    void check();
  });
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", () => {
    render();
    if (document.visibilityState === "visible" && navigator.onLine)
      void check();
  });
  afterStartup(render);
  render();
  void register();
  return { refresh };
}
