import "./style.css";
import { appearance } from "./appearance";
import { mapStyle } from "./map-style";
import { setupMotion, reveal } from "./motion";
import { finishStartup } from "./startup";

const example =
  new URLSearchParams(location.search).get("example") === "bike-transfer";
async function start() {
  appearance.initialize();
  mapStyle.initialize();
  const entry = await (example ? import("./example") : import("./main"));
  // Local restoration chooses the first screen; routing and tiles keep loading independently.
  await entry.startupReady;
  if (!(await finishStartup())) return;
  setupMotion();
  const introduction = document.querySelector<HTMLElement>("#search-empty");
  if (introduction) reveal(introduction, { y: 8 });
}
void start().catch(() =>
  window.dispatchEvent(new Event("foldroute:startup-error")),
);
