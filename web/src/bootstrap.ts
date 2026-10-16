import "./style.css";

const ready =
  new URLSearchParams(location.search).get("example") === "bike-transfer"
    ? import("./example")
    : import("./main");

// Keep controls unavailable until their entrypoint has attached its handlers.
void ready.then(() => {
  document
    .querySelectorAll<HTMLElement>("#main, .app-tabs")
    .forEach((element) => {
      element.inert = false;
    });
  delete document.body.dataset.starting;
});
