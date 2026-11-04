<script lang="ts">
  import "../route-editor.css";
  import { onMount } from "svelte";
  import { icon } from "../ui";
  let expanded = $state(false);
  let form: HTMLFormElement;
  export function setExpanded(value: boolean) {
    expanded = value;
  }
  onMount(() => {
    for (const target of form.querySelectorAll<HTMLElement>("[data-icon]"))
      target.append(icon(target.dataset.icon!));
  });
</script>

<form
  bind:this={form!}
  id="route-form"
  class="search-form"
  data-editor-expanded={expanded}
  novalidate
>
  <button
    id="search-adjust"
    type="button"
    class="context-button"
    aria-expanded="false"
    aria-controls="route-editor"
  >
    <span class="context-copy"
      ><strong id="search-adjust-label">Start &amp; Zeit</strong><span
        id="search-context">Aktueller Standort · Jetzt</span
      ></span
    ><span data-icon="chevron"></span>
  </button>
  <div class="search-content">
    <div class="route-editor-frame" data-expanded={expanded}>
      <div
        class="route-places-frame"
        class:route-editor-places={expanded}
        role="group"
        aria-label="Strecke"
      >
        <span class="route-connection" aria-hidden="true" hidden={!expanded}
        ></span>
        <div id="route-editor" class="route-editor" hidden={!expanded}>
          <div class="route-editor-origin route-point">
            <div class="route-endpoint-row">
              <button
                id="origin-location"
                type="button"
                class="route-origin-control icon-button"
                aria-label="Aktuellen Standort verwenden"
                title="Aktuellen Standort verwenden"
              >
                <span class="route-start-marker" aria-hidden="true"></span>
              </button>
              <label for="origin" class="sr-only">Start</label>
              <input
                id="origin"
                type="search"
                autocomplete="off"
                placeholder="Start wählen"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="origin-options"
                aria-expanded="false"
              />
              <button
                id="planner-more"
                class="icon-button"
                type="button"
                aria-label="Weitere Routenoptionen"
                aria-expanded="false"
                aria-controls="planner-actions"
                popovertarget="planner-actions"
                data-icon="more"
              ></button>
            </div>
            <ul
              id="origin-options"
              class="suggestions"
              role="listbox"
              aria-label="Startvorschläge"
              hidden
            ></ul>
          </div>
          <div id="via-fields"></div>
        </div>
        <div id="route-editor-destination" class="route-point">
          <div id="destination-home">
            <div id="destination-field" class="destination-row">
              <span
                class="destination-marker"
                data-icon="stop"
                aria-hidden="true"
                hidden
              ></span>
              <div class="search-box">
                <span class="home-search-icon" data-icon="search"></span><label
                  class="sr-only"
                  for="destination">Ziel</label
                ><input
                  id="destination"
                  type="search"
                  placeholder="Adresse, Ort oder Haltestelle"
                  autocomplete="off"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls="destination-options"
                  aria-expanded="false"
                />
              </div>
              <button
                id="swap"
                type="button"
                class="swap icon-button"
                hidden
                aria-label="Start und Ziel tauschen"
                title="Start und Ziel tauschen"
                aria-describedby="swap-description"
                data-icon="swap"
              ></button>
            </div>
          </div>
          <div id="destination-status-home">
            <p id="place-status" class="message" role="status"></p>
          </div>
          <div id="home-suggestions">
            <ul
              id="destination-options"
              class="suggestions"
              role="listbox"
              aria-label="Zielvorschläge"
              hidden
            ></ul>
          </div>
        </div>
        <span id="swap-description" class="sr-only"></span>
      </div>
      <div class="route-editor-extras" hidden={!expanded}>
        <div
          id="planner-actions"
          class="planner-actions-panel"
          popover="auto"
          role="group"
          aria-label="Routenoptionen"
        >
          <!-- Native popover focuses its add action only when opened. -->
          <!-- svelte-ignore a11y_autofocus -->
          <button
            id="add-stop"
            type="button"
            aria-describedby="planner-stop-limit"
            autofocus
          >
            Zwischenziel hinzufügen
          </button>
          <p id="planner-stop-limit" class="message" hidden>
            Maximal drei Zwischenziele.
          </p>
        </div>
        <p id="adjust-status" class="message" role="status"></p>
        <span
          id="adjust-location-announcement"
          class="sr-only"
          role="status"
          aria-atomic="true"
        ></span>
        <button id="time-trigger" type="button" class="time-trigger">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <rect x="3" y="5" width="18" height="16" rx="3" />
            <path d="M7 2v6m10-6v6M3 11h18" /></svg
          ><span class="time-trigger-copy"
            ><span>Zeitpunkt</span><strong id="time-summary"></strong></span
          ><span aria-hidden="true">›</span>
        </button>
        <input id="timing" type="hidden" value="now" /><input
          id="when"
          type="hidden"
        />
      </div>
    </div>
    <div id="home-places">
      <div id="search-empty" class="search-empty">
        <img src="foldroute-mark.svg" width="96" height="96" alt="" />
        <h2>Ein Ziel. Viele Möglichkeiten.</h2>
        <p>
          Wähle dein Ziel. FoldRoute findet Verbindungen mit Rad und ÖPNV – mit
          deiner Zeit zum Falten.
        </p>
      </div>
      <button id="open-saved" type="button" class="saved-button" hidden>
        <span data-icon="wait"></span><span
          ><strong>Letzte Strecke erneut planen</strong><small
            id="saved-description"
          ></small></span
        ><span data-icon="chevron"></span>
      </button>
      <p id="offline-empty" class="message" hidden>
        Du bist offline. Noch keine Reise gespeichert. Verbinde dich mit dem
        Internet, um eine Route zu planen.
      </p>
    </div>
  </div>
  <div id="planning-actions" class="planning-actions" hidden>
    <button id="cancel-adjust" type="button" class="secondary" hidden>
      Abbrechen
    </button>
    <button id="calculate" type="submit" class="primary">
      Route berechnen
    </button>
  </div>
</form>
