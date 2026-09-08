import { el } from "./ui";
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function setupPWA() {
  let installEvent: InstallEvent | undefined,
    registration: ServiceWorkerRegistration | undefined,
    reloadRequested = false;
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  function installed() {
    el("install").hidden = standalone();
    if (standalone())
      el("install-message").textContent = "FoldRoute ist als App geöffnet.";
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
  };
  if (
    !import.meta.env.PROD ||
    !("serviceWorker" in navigator) ||
    !isSecureContext
  )
    return;
  const base = new URL("./", document.baseURI);
  const showUpdate = () => {
    if (registration?.waiting) el("update-banner").hidden = false;
  };
  const ready = () =>
    (el("offline-ready").textContent =
      "Oberfläche offline verfügbar. Neue Routen und Straßenkarten benötigen Internet.");
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadRequested) location.reload();
  });
  navigator.serviceWorker
    .register(new URL("sw.js", base), { scope: base.pathname })
    .then((reg) => {
      registration = reg;
      if (reg.active) ready();
      showUpdate();
      const watch = () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") {
            if (navigator.serviceWorker.controller) showUpdate();
            else ready();
          }
        });
      };
      watch();
      reg.addEventListener("updatefound", watch);
    })
    .catch(() => {
      el("offline-ready").textContent =
        "Oberfläche konnte nicht offline bereitgestellt werden. Online kannst du weiterplanen.";
    });
  el("update-now").onclick = () => {
    if (!registration?.waiting) return;
    reloadRequested = true;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  };
  el("update-later").onclick = () => (el("update-banner").hidden = true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine)
      void registration?.update().catch(() => {});
  });
}
