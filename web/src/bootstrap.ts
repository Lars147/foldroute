import "./style.css";
import { appearance } from "./appearance";
import { mapStyle } from "./map-style";
import { setupMotion, reveal } from "./motion";
import { finishStartup } from "./startup";

const example =
  new URLSearchParams(location.search).get("example") === "bike-transfer";
async function start() {
  const preview =
    import.meta.env.DEV && !!document.documentElement.dataset.startupPreview;
  if (preview)
    appearance.preference = document.documentElement.dataset.startupPreview as
      "light" | "dark";
  appearance.initialize(!preview);
  mapStyle.initialize();
  const entry = await (import.meta.env.DEV && preview
    ? import("./startup-preview-entry")
    : example
      ? import("./example")
      : import("./main"));
  // Local restoration chooses the first screen; routing and tiles keep loading independently.
  await entry.startupReady;
  if (!(await finishStartup())) return;
  setupMotion();
  const introduction = document.querySelector<HTMLElement>("#search-empty");
  if (introduction) reveal(introduction, { y: 8 });
  if (import.meta.env.DEV && preview)
    parent.postMessage("foldroute:splash-complete", location.origin);
}
void start().catch(() =>
  window.dispatchEvent(new Event("foldroute:startup-error")),
);
