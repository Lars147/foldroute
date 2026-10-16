import "./style.css";
import { appearance } from "./appearance";
import { mapStyle } from "./map-style";

const example =
  new URLSearchParams(location.search).get("example") === "bike-transfer";
appearance.initialize(true);
mapStyle.initialize();
const ready = example ? import("./example") : import("./main");

// Keep controls unavailable until their entrypoint has attached its handlers.
void ready.then(() => {
  document
    .querySelectorAll<HTMLElement>("#main, .app-tabs")
    .forEach((element) => {
      element.inert = false;
    });
  delete document.body.dataset.starting;
});
