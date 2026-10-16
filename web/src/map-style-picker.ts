import { mapStyle, mapStyleEvent, mapStyleOptions } from "./map-style";
import { icon, node } from "./ui";

export function closeMapStylePickers() {
  document
    .querySelectorAll<HTMLElement>(".map-style-panel:popover-open")
    .forEach((panel) => panel.hidePopover());
}

export function mountMapStylePicker(root: HTMLElement, id: string) {
  if (root.childElementCount) return;
  const mobile = matchMedia("(max-width: 899px)");
  const trigger = node("button", "", "map-style-toggle icon-button");
  trigger.type = "button";
  trigger.setAttribute("aria-label", "Kartenstil wählen");
  trigger.title = "Kartenstil wählen";
  trigger.append(icon("layers"));
  const panel = node("div", "", "map-style-panel");
  panel.id = `${id}-map-style-panel`;
  panel.popover = "auto";
  panel.setAttribute("role", "dialog");
  const title = node("h2", "Karte anpassen");
  title.id = `${id}-map-style-title`;
  panel.setAttribute("aria-labelledby", title.id);
  trigger.popoverTargetElement = panel;
  const header = node("div", "", "map-style-header");
  const close = node("button", "", "icon-button");
  close.type = "button";
  close.setAttribute("aria-label", "Kartenstile schließen");
  close.append(icon("close"));
  close.onclick = () => {
    panel.hidePopover();
    trigger.focus({ preventScroll: true });
  };
  // Safari can leave focus outside a popover after a pointer-selected radio.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !panel.matches(":popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      panel.hidePopover();
      trigger.focus({ preventScroll: true });
    },
    { capture: true },
  );
  header.append(title, close);
  const body = node("div", "", "map-style-body");
  const section = node("h3", "Kartenstil", "map-style-section-title");
  const options = node("div", "", "map-style-options");
  options.setAttribute("role", "radiogroup");
  options.setAttribute("aria-label", "Kartenstil wählen");
  for (const option of mapStyleOptions) {
    const label = node("label", "", "map-style-option");
    const radio = node("input");
    radio.type = "radio";
    radio.name = `${id}-map-style`;
    radio.value = option.id;
    radio.setAttribute("aria-label", option.title);
    radio.onchange = () => {
      if (radio.checked) mapStyle.set(option.id);
    };
    const preview = node("span", "", "map-style-preview");
    preview.dataset.style = option.id;
    preview.setAttribute("aria-hidden", "true");
    // Schematic swatches distinguish palettes without extra map requests.
    preview.innerHTML =
      '<svg viewBox="0 0 88 60" preserveAspectRatio="xMidYMid slice" focusable="false"><path class="swatch-park" d="M0 0h38v27H0zM58 42h30v18H58z"/><path class="swatch-water" d="M59-5 43 24 59 65"/><path class="swatch-road" d="M-5 42 93 13M24-5 42 65"/><path class="swatch-main-road" d="M-5 16 93 47"/></svg>';
    const copy = node("span", "", "map-style-copy");
    const description = node("small", option.description);
    description.id = `${id}-map-style-${option.id}-description`;
    radio.setAttribute("aria-describedby", description.id);
    copy.append(node("strong", option.title), description);
    label.append(preview, copy, radio);
    options.append(label);
  }
  const status = node("p", "", "map-style-status");
  status.setAttribute("role", "status");
  body.append(section, options, status);
  panel.append(header, body);
  root.append(trigger, panel);
  const render = () => {
    options.querySelectorAll<HTMLInputElement>("input").forEach((radio) => {
      radio.checked = radio.value === mapStyle.preference;
    });
    status.textContent = mapStyle.storageFailed
      ? "Kartenstil gilt nur für diese Sitzung."
      : !navigator.onLine
        ? "Die Straßenkarte lädt wieder mit Verbindung."
        : "";
    status.hidden = !status.textContent;
  };
  const position = () => {
    if (mobile.matches) {
      for (const property of ["width", "left", "top"])
        panel.style.removeProperty(property);
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(bounds.right - width, innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(bounds.bottom + 8, innerHeight - panel.offsetHeight - 12))}px`;
  };
  panel.addEventListener("toggle", () => {
    const open = panel.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      position();
      options
        .querySelector<HTMLInputElement>("input:checked")!
        .focus({ preventScroll: true });
    }
  });
  trigger.setAttribute("aria-expanded", "false");
  const refresh = () => {
    render();
    if (panel.matches(":popover-open")) position();
  };
  window.addEventListener(mapStyleEvent, refresh);
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  const reposition = () => {
    if (panel.matches(":popover-open")) position();
  };
  window.addEventListener("resize", reposition);
  mobile.addEventListener("change", reposition);
  render();
}
