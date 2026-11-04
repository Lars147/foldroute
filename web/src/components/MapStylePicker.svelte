<script lang="ts">
  import { onMount, tick } from "svelte";
  import { mapStyle, mapStyleEvent, mapStyleOptions } from "../map-style";
  import { icon } from "../ui";

  let { id }: { id: string } = $props();
  let trigger: HTMLButtonElement;
  let panel: HTMLDivElement;
  let preference = $state(mapStyle.preference);
  let status = $state("");
  let open = $state(false);

  function close() {
    panel.hidePopover();
    trigger.focus({ preventScroll: true });
  }

  onMount(() => {
    const events = new AbortController();
    const mobile = matchMedia("(max-width: 899px)");
    trigger.prepend(icon("layers"));
    panel.querySelector(".map-style-header button")!.append(icon("close"));
    trigger.popoverTargetElement = panel;
    const refresh = () => {
      preference = mapStyle.preference;
      status = mapStyle.storageFailed
        ? "Kartenstil gilt nur für diese Sitzung."
        : !navigator.onLine
          ? "Die Straßenkarte lädt wieder mit Verbindung."
          : "";
      void tick().then(() => {
        if (!events.signal.aborted) reposition();
      });
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
    const reposition = () => {
      if (panel.matches(":popover-open")) position();
    };
    panel.addEventListener(
      "toggle",
      () => {
        open = panel.matches(":popover-open");
        if (open) {
          refresh();
          position();
          panel
            .querySelector<HTMLInputElement>(
              `input[value="${mapStyle.preference}"]`,
            )!
            .focus({ preventScroll: true });
        }
      },
      { signal: events.signal },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !panel.matches(":popover-open")) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      },
      { capture: true, signal: events.signal },
    );
    for (const event of [mapStyleEvent, "online", "offline"])
      window.addEventListener(event, refresh, { signal: events.signal });
    window.addEventListener("resize", reposition, { signal: events.signal });
    mobile.addEventListener("change", reposition, { signal: events.signal });
    refresh();
    return () => {
      events.abort();
      if (panel.matches(":popover-open")) panel.hidePopover();
    };
  });
</script>

<button
  bind:this={trigger!}
  class="map-style-toggle icon-button"
  type="button"
  aria-label="Kartenstil wählen"
  title="Kartenstil wählen"
  aria-expanded={open}
></button>
<div
  bind:this={panel!}
  id={`${id}-map-style-panel`}
  class="map-style-panel"
  popover="auto"
  role="dialog"
  aria-labelledby={`${id}-map-style-title`}
>
  <div class="map-style-header">
    <h2 id={`${id}-map-style-title`}>Karte anpassen</h2>
    <button
      type="button"
      class="icon-button"
      aria-label="Kartenstile schließen"
      onclick={close}
    ></button>
  </div>
  <div class="map-style-body">
    <h3 class="map-style-section-title">Kartenstil</h3>
    <div
      class="map-style-options"
      role="radiogroup"
      aria-label="Kartenstil wählen"
    >
      {#each mapStyleOptions as option (option.id)}
        <label class="map-style-option">
          <span
            class="map-style-preview"
            data-style={option.id}
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 88 60"
              preserveAspectRatio="xMidYMid slice"
              focusable="false"
              ><path
                class="swatch-park"
                d="M0 0h38v27H0zM58 42h30v18H58z"
              /><path class="swatch-water" d="M59-5 43 24 59 65" /><path
                class="swatch-road"
                d="M-5 42 93 13M24-5 42 65"
              /><path class="swatch-main-road" d="M-5 16 93 47" /></svg
            >
          </span>
          <span class="map-style-copy"
            ><strong>{option.title}</strong><small
              id={`${id}-map-style-${option.id}-description`}
              >{option.description}</small
            ></span
          >
          <input
            type="radio"
            name={`${id}-map-style`}
            value={option.id}
            checked={preference === option.id}
            aria-label={option.title}
            aria-describedby={`${id}-map-style-${option.id}-description`}
            onchange={() => mapStyle.set(option.id)}
          />
        </label>
      {/each}
    </div>
    <p class="map-style-status" role="status" hidden={!status}>{status}</p>
  </div>
</div>
