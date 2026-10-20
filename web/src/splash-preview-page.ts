import "./splash-preview-page.css";

const frame = document.querySelector<HTMLIFrameElement>("#preview")!;
const proceed = document.querySelector<HTMLButtonElement>("#continue")!;
const status = document.querySelector<HTMLElement>("#preview-status")!;
const choices = document.querySelectorAll<HTMLButtonElement>(
  "[data-theme-choice]",
);
let theme = matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";
let automatic = false;

function replay(play = false) {
  automatic = play;
  document.documentElement.dataset.theme = theme;
  for (const choice of choices)
    choice.setAttribute(
      "aria-pressed",
      String(choice.dataset.themeChoice === theme),
    );
  proceed.disabled = true;
  status.textContent = "Vorschau wird geladen.";
  // Only the development entrypoint understands this parameter; it never loads personal stores.
  frame.src = `/?splash-preview=${theme}${automatic ? "&splash-autoplay=1" : ""}`;
}
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin)
    return;
  if (event.data === "foldroute:splash-ready") {
    proceed.disabled = automatic;
    status.textContent = automatic
      ? "Start läuft. Das Logo bleibt mindestens 600 ms sichtbar."
      : "Start wartet. Die Vorschau läuft bis zum Fortsetzen.";
  } else if (event.data === "foldroute:splash-complete") {
    status.textContent = "Start abgeschlossen.";
  }
});
for (const choice of choices)
  choice.onclick = () => {
    theme = choice.dataset.themeChoice!;
    replay();
  };
document.querySelector<HTMLButtonElement>("#replay")!.onclick = () =>
  replay(true);
proceed.onclick = () => {
  proceed.disabled = true;
  status.textContent =
    "Start läuft. Das Logo bleibt mindestens 600 ms sichtbar.";
  frame.contentWindow!.postMessage(
    "foldroute:splash-continue",
    location.origin,
  );
};
replay();
