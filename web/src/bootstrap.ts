import "./style.css";
import { mount, flushSync } from "svelte";
import AppRoot from "./components/AppRoot.svelte";
import ExampleRoot from "./components/ExampleRoot.svelte";
import { installAppPresentation } from "./app-presentation";
import { appearance } from "./appearance";
import { mapStyle } from "./map-style";
import { setupMotion, reveal } from "./motion";
import { finishStartup } from "./startup";

const example =
  new URLSearchParams(location.search).get("example") === "bike-transfer";
async function start() {
  appearance.initialize();
  mapStyle.initialize();
  const target = document.getElementById("app-root");
  if (!target) throw new Error("Application root host missing");
  let clearPresentation = () => {};
  const props = { onDispose: () => clearPresentation() };
  const root = example
    ? mount(ExampleRoot, { target, props })
    : mount(AppRoot, { target, props });
  flushSync();
  const presentation = root.presentation();
  clearPresentation = installAppPresentation(presentation);
  // Local restoration chooses the first screen; routing and tiles keep loading independently.
  if (example) await (await import("./example")).startExample(presentation);
  else await (await import("./main")).startApplication(presentation);
  if (!(await finishStartup())) return;
  setupMotion();
  const introduction = document.querySelector<HTMLElement>("#search-empty");
  if (introduction) reveal(introduction, { y: 8 });
}
void start().catch(() =>
  window.dispatchEvent(new Event("foldroute:startup-error")),
);
