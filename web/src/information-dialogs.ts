import licensesHTML from "virtual:foldroute-licenses";
import { el } from "./ui";

/** Keep full license notices in one source, available without another request. */
export function mountInformationDialogs() {
  const licenses = new DOMParser().parseFromString(licensesHTML, "text/html");
  el("licenses-content").append(
    ...Array.from(licenses.querySelectorAll("main > section"), (section) =>
      document.importNode(section, true),
    ),
  );
  for (const name of ["licenses", "about"]) {
    const opener = el<HTMLAnchorElement>(`open-${name}`);
    const dialog = el<HTMLDialogElement>(`${name}-dialog`);
    opener.onclick = (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      dialog.showModal();
      el(`${name}-dialog-title`).focus({ preventScroll: true });
    };
    dialog.querySelector<HTMLButtonElement>(
      "[data-close-information]",
    )!.onclick = () => dialog.close();
    dialog.addEventListener("close", () =>
      opener.focus({ preventScroll: true }),
    );
  }
}
