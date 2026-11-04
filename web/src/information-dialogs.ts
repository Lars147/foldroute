import { DialogController } from "./dialog-controller";
import licensesHTML from "virtual:foldroute-licenses";
import { el } from "./ui";

/** Keep full license notices in one source, available without another request. */
export function mountInformationDialogs() {
  const events = new AbortController();
  const controllers: DialogController[] = [];
  const licenses = new DOMParser().parseFromString(licensesHTML, "text/html");
  el("licenses-content").append(
    ...Array.from(licenses.querySelectorAll("main > section"), (section) =>
      document.importNode(section, true),
    ),
  );
  for (const name of ["licenses", "about"]) {
    const opener = el<HTMLAnchorElement>(`open-${name}`);
    const dialog = el<HTMLDialogElement>(`${name}-dialog`);
    const controller = new DialogController(dialog);
    controllers.push(controller);
    opener.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      controller.open(opener, el(`${name}-dialog-title`));
    }, { signal: events.signal });
    dialog.querySelector<HTMLButtonElement>("[data-close-information]")!
      .addEventListener("click", () => controller.close(), { signal: events.signal });
  }
  return () => {
    events.abort();
    controllers.forEach((controller) => controller.dispose());
  };
}
