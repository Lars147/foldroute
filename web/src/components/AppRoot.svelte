<script lang="ts">
  import { flushSync, onDestroy } from "svelte";
  import type { Snippet } from "svelte";
  import RouteEditor from "./RouteEditor.svelte";
  import JourneyWorkspace from "./JourneyWorkspace.svelte";
  import SettingsScreen from "./SettingsScreen.svelte";
  import HistoryList from "./HistoryList.svelte";
  import NavigationScreen from "./NavigationScreen.svelte";
  import type {
    AppPresentation,
    HistoryPresentation,
    NavigationViewCommands,
  } from "../app-presentation";
  let {
    mode = "live",
    onDispose,
  }: { mode?: "live" | "example"; onDispose?: () => void } = $props();
  const structureListeners = new Set<() => void>();
  function structureChanged() {
    structureListeners.forEach((listener) => listener());
  }
  function updateToastStructure(update: () => void) {
    const active =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest("#toast")
        ? document.activeElement.id
        : undefined;
    flushSync(update);
    structureChanged();
    const replacement = active ? document.getElementById(active) : undefined;
    if (
      replacement?.getClientRects().length &&
      !replacement.closest("[hidden], [inert]")
    )
      replacement.focus({ preventScroll: true });
  }
  onDestroy(() => {
    structureListeners.clear();
    onDispose?.();
  });
  let editor: { setExpanded(value: boolean): void };
  let workspace: Omit<AppPresentation["workspace"], "subscribeStructure">;
  let settings: AppPresentation["settings"];
  let navigation = $state<AppPresentation["navigation"]>(null!);
  let history = $state.raw<HistoryPresentation | undefined>();
  let rootToast = $state.raw<Snippet | undefined>();
  let navigationCommands = $state.raw<NavigationViewCommands>({
    selectSection() {},
    phaseKeydown() {},
    endNavigation() {},
  });
  export function presentation(): AppPresentation {
    return {
      editor: { setExpanded: (value) => editor.setExpanded(value) },
      workspace: {
        subscribeStructure: (listener) => {
          structureListeners.add(listener);
          return () => structureListeners.delete(listener);
        },
        setText: (id, value) => flushSync(() => workspace.setText(id, value)),
        setHidden: (id, value) =>
          flushSync(() => workspace.setHidden(id, value)),
        setInert: (id, value) => flushSync(() => workspace.setInert(id, value)),
        setDisabled: (id, value) =>
          flushSync(() => workspace.setDisabled(id, value)),
        setClass: (id, value) => flushSync(() => workspace.setClass(id, value)),
        toggleClass: (id, name, value) =>
          flushSync(() => workspace.toggleClass(id, name, value)),
        setAttribute: (id, name, value) =>
          flushSync(() => workspace.setAttribute(id, name, value)),
        setCommand: (id, command) => workspace.setCommand(id, command),
        updateLayout: (value) => {
          flushSync(() => workspace.updateLayout(value));
          structureChanged();
        },
        updateStops: (value) => flushSync(() => workspace.updateStops(value)),
        setRetryAt: (id, value) =>
          flushSync(() => workspace.setRetryAt(id, value)),
        updateToast: (value) => flushSync(() => workspace.updateToast(value)),
        setToastVisible: (value) =>
          flushSync(() => workspace.setToastVisible(value)),
        setToastRetryAt: (value) =>
          flushSync(() => workspace.setToastRetryAt(value)),
        setToastPlacement: (value) =>
          updateToastStructure(() => workspace.setToastPlacement(value)),
        setToastMap: (value) => flushSync(() => workspace.setToastMap(value)),
        setToastStyle: (name, value) =>
          flushSync(() => workspace.setToastStyle(name, value)),
        setRecoveryToast: (value) =>
          updateToastStructure(() => workspace.setRecoveryToast(value)),
        updateStartNotice: (message, help) =>
          flushSync(() => workspace.updateStartNotice(message, help)),
        updateStart: (checking, restored) =>
          flushSync(() => workspace.updateStart(checking, restored)),
        updateChoices: (value) =>
          flushSync(() => workspace.updateChoices(value)),
        updateSummary: (value) =>
          flushSync(() => workspace.updateSummary(value)),
        updateDetail: (value) => flushSync(() => workspace.updateDetail(value)),
      },
      settings,
      navigation: {
        element: () => navigation.element(),
        updateSectionDetail: (value) =>
          flushSync(() => navigation.updateSectionDetail(value)),
        updateMovementSummary: (value) =>
          flushSync(() => navigation.updateMovementSummary(value)),
        setIcon: (id, value) => flushSync(() => navigation.setIcon(id, value)),
        updateLocationFeedback: (message, help) =>
          flushSync(() => navigation.updateLocationFeedback(message, help)),
        setText: (id, value) => flushSync(() => navigation.setText(id, value)),
        setHidden: (id, value) =>
          flushSync(() => navigation.setHidden(id, value)),
        setDisabled: (id, value) =>
          flushSync(() => navigation.setDisabled(id, value)),
        setAttribute: (id, name, value) =>
          flushSync(() => navigation.setAttribute(id, name, value)),
        updateLayout: (mobile, arrived) =>
          navigation.updateLayout(mobile, arrived),
        updateTabs: (value) => navigation.updateTabs(value),
        updateLocation: (value) => navigation.updateLocation(value),
        updateFinish: (value) => navigation.updateFinish(value),
        updateCompletion: (value) => navigation.updateCompletion(value),
        setCompletionCommands: (value) =>
          navigation.setCompletionCommands(value),
      },
      configureNavigation: (commands) => {
        navigationCommands = commands;
      },
      updateHistory: (value) => {
        history = value;
      },
    };
  }
</script>

<a class="skip" href="#main" inert>Zum Inhalt</a>
<header class="app-header" inert>
  <a class="brand" href="../" aria-label="FoldRoute Projekt"
    ><img src="foldroute-mark.svg" width="34" height="34" alt="" />FoldRoute</a
  >
</header>
<span id="connection" role="status" hidden>Offline</span>
<button id="shared-pending" class="secondary shared-pending" hidden>
  Geteiltes Ziel
</button>
<dialog
  id="shared-navigation-dialog"
  aria-labelledby="shared-navigation-heading"
>
  <div class="dialog-body">
    <h2 id="shared-navigation-heading">Neue Route planen?</h2>
    <p id="shared-navigation-description"></p>
    <div class="form-actions">
      <button id="shared-navigation-replace" class="primary">
        Neue Route planen
      </button>
      <button id="shared-navigation-keep" class="secondary">
        Navigation fortsetzen
      </button>
    </div>
  </div>
</dialog>
<dialog id="shared-dialog" aria-labelledby="shared-heading">
  <div class="dialog-heading">
    <button id="shared-cancel" class="text-button">Abbrechen</button>
    <h2 id="shared-heading">Geteiltes Ziel</h2>
  </div>
  <div class="dialog-body">
    <p id="shared-error" class="message" role="status"></p>
    <label for="shared-destination">Ziel suchen</label>
    <input
      id="shared-destination"
      type="search"
      autocomplete="off"
      role="combobox"
      aria-autocomplete="list"
      aria-controls="shared-destination-options"
      aria-expanded="false"
      placeholder="Adresse, Ort oder Haltestelle"
    />
    <p id="shared-status" class="message" role="status"></p>
    <ul
      id="shared-destination-options"
      class="suggestions"
      aria-label="Geteiltes Ziel auswählen"
      hidden
    ></ul>
    <button id="shared-discard" class="text-button">
      Geteiltes Ziel verwerfen
    </button>
  </div>
</dialog>
<main id="main" inert>
  <dialog
    id="navigation-resume-dialog"
    aria-labelledby="navigation-resume-title"
  >
    <h2 id="navigation-resume-title">Navigation fortsetzen?</h2>
    <p id="navigation-resume-summary"></p>
    <p>
      Navigation wird am gespeicherten Abschnitt fortgesetzt. Standort und
      Fahrtdaten werden im Hintergrund geprüft.
    </p>
    <div class="navigation-actions">
      <button id="navigation-resume" class="primary">
        Navigation fortsetzen</button
      ><button id="navigation-discard" class="secondary">Verwerfen</button>
    </div>
  </dialog>
  <section
    id="search-view"
    class="screen search-screen"
    aria-labelledby="search-heading"
  >
    <div class="search-intro">
      <h1 id="search-heading" tabindex="-1">Wohin geht’s?</h1>
      <p>Mit deinem Faltrad. Und allem, was verbindet.</p>
    </div>
    <div id="route-editor-host"><RouteEditor bind:this={editor} /></div>
  </section>
  <section
    id="history-view"
    class="screen"
    aria-labelledby="history-heading"
    hidden
  >
    <h1 id="history-heading" tabindex="-1">Verlauf</h1>
    <p id="history-empty" class="message"></p>
    <ul id="history-list" class="history-list">
      {#if history}<HistoryList {...history} />{/if}
    </ul>
  </section>
  <JourneyWorkspace
    bind:this={workspace}
    rootToastChanged={(value) => (rootToast = value)}
  />

  <SettingsScreen bind:this={settings} />
  {#if mode === "live"}<NavigationScreen
      bind:this={navigation}
      selectSection={(id) => navigationCommands.selectSection(id)}
      phaseKeydown={(event) => navigationCommands.phaseKeydown(event)}
      endNavigation={() => navigationCommands.endNavigation()}
    />{/if}
</main>
<dialog
  id="licenses-dialog"
  class="information-dialog"
  aria-labelledby="licenses-dialog-title"
>
  <div class="information-heading">
    <h2 id="licenses-dialog-title" tabindex="-1">
      Lizenzen &amp; Datenquellen
    </h2>
    <button
      type="button"
      class="icon-button"
      aria-label="Lizenzen schließen"
      data-icon="close"
      data-close-information
    ></button>
  </div>
  <div id="licenses-content" class="information-content"></div>
</dialog>
<dialog
  id="about-dialog"
  class="information-dialog"
  aria-labelledby="about-dialog-title"
>
  <div class="information-heading">
    <h2 id="about-dialog-title" tabindex="-1">Über FoldRoute</h2>
    <button
      type="button"
      class="icon-button"
      aria-label="Über FoldRoute schließen"
      data-icon="close"
      data-close-information
    ></button>
  </div>
  <div class="information-content">
    <p class="about-intro">Mit Faltrad und ÖPNV unterwegs.</p>
    <p>
      FoldRoute verbindet Radstrecken mit Bus und Bahn. Die Routenplanung
      berücksichtigt deine Radzeit, die Zeit zum Falten und Entfalten sowie
      deine Umstiegszeit.
    </p>
    <h3>Deine Daten bleiben bei dir</h3>
    <p>
      Ohne Konto und ohne Tracking. Gespeicherte Strecken, Favoriten und
      Einstellungen bleiben auf diesem Gerät. Für Ortssuche und Routenberechnung
      werden deine Planungsangaben an Transitous übermittelt.
    </p>
    <h3>Ein offenes Projekt</h3>
    <p>
      FoldRoute ist Open Source. Quellcode und weitere Informationen findest du
      auf GitHub.
    </p>
    <a
      href="https://github.com/Lars147/foldroute"
      target="_blank"
      rel="noopener noreferrer">Projekt auf GitHub öffnen ↗</a
    >
  </div>
</dialog>
<nav class="app-tabs" aria-label="Hauptbereiche" inert>
  <button id="tab-route" aria-current="page">
    <span class="app-tab-content"
      ><span data-icon="map"></span><span class="app-tab-label">Route</span
      ></span
    ></button
  ><button id="tab-history">
    <span class="app-tab-content"
      ><span data-icon="wait"></span><span class="app-tab-label">Verlauf</span
      ></span
    ></button
  ><button id="tab-settings">
    <span class="app-tab-content"
      ><span class="settings-tab-icon" data-icon="settings"
        ><span class="update-badge" aria-hidden="true" hidden></span></span
      ><span class="app-tab-label">Einstellungen</span></span
    >
  </button>
</nav>
<dialog id="time-dialog" class="editing-time" aria-labelledby="time-heading">
  <form id="time-editor">
    <div class="dialog-heading">
      <h2 id="time-heading">Zeitpunkt</h2>
      <button id="time-cancel" type="button" aria-label="Zeitwahl schließen">
        ✕
      </button>
    </div>
    <div class="time-editor-body">
      <div class="time-modes" role="group" aria-label="Abfahrt oder Ankunft">
        <button id="time-depart" type="button">Abfahrt</button><button
          id="time-arrive"
          type="button">Ankunft</button
        >
      </div>
      <div class="time-month-navigation">
        <button id="time-previous" type="button" aria-label="Vorheriger Monat">
          ‹
        </button>
        <h3 id="time-month" aria-live="polite">Kalender</h3>
        <button id="time-next" type="button" aria-label="Nächster Monat">
          ›
        </button>
      </div>
      <div class="time-weekdays" aria-hidden="true">
        <span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span
          >Fr</span
        ><span>Sa</span><span>So</span>
      </div>
      <div id="time-calendar" role="grid" aria-labelledby="time-month"></div>
      <label for="time-clock">Uhrzeit</label>
      <div class="time-clock-controls">
        <button id="time-minus" type="button" aria-label="Fünf Minuten früher">
          −</button
        ><input
          id="time-clock"
          type="time"
          step="60"
          required
          aria-describedby="time-error"
          autocomplete="off"
        /><button id="time-plus" type="button" aria-label="Fünf Minuten später">
          +</button
        ><button id="time-now" class="secondary" type="button"> Jetzt </button>
      </div>
      <p id="time-error" role="status" class="message"></p>
    </div>
    <div class="dialog-actions">
      <button id="time-apply" class="primary" type="submit">
        Übernehmen
      </button>
    </div>
  </form>
</dialog>
<dialog id="delete-history-dialog" aria-labelledby="delete-history-heading">
  <h2 id="delete-history-heading">Streckenverlauf löschen?</h2>
  <p>
    Alle gespeicherten Planungen werden von diesem Gerät entfernt.
    Navigationsstand, Fahrtstatistik, Favoriten und Einstellungen bleiben
    erhalten.
  </p>
  <p id="delete-history-status" class="message" role="status"></p>
  <div class="form-actions">
    <button id="cancel-delete-history" class="secondary" type="button">
      Abbrechen
    </button>
    <button id="confirm-delete-history" class="primary" type="button">
      Streckenverlauf löschen
    </button>
  </div>
</dialog>
<dialog id="delete-storage-dialog" aria-labelledby="delete-storage-heading">
  <h2 id="delete-storage-heading">Lokale Daten löschen</h2>
  <p id="delete-storage-description"></p>
  <p id="delete-storage-status" class="message" role="status"></p>
  <div class="form-actions">
    <button id="cancel-delete-storage" class="secondary" type="button">
      Abbrechen
    </button>
    <button id="confirm-delete-storage" class="primary" type="button">
      Löschen
    </button>
  </div>
</dialog>
<dialog id="delete-data-dialog" aria-labelledby="delete-data-heading">
  <h2 id="delete-data-heading">Alle lokalen Daten löschen?</h2>
  <p>
    Favoriten, letzte Orte, Einstellungen, gespeicherte Strecken,
    Wiederaufnahmezustand und Gesamtstatistik werden unwiderruflich entfernt.
  </p>
  <p id="delete-data-status" class="message" role="status"></p>
  <div class="form-actions">
    <button id="cancel-delete-data" class="secondary" type="button">
      Abbrechen
    </button>
    <button id="confirm-delete-data" class="primary" type="button">
      Alles löschen
    </button>
  </div>
</dialog>
<div id="map-location-error" class="toast location-error" hidden>
  <p id="map-location-error-text" role="status"></p>
  <a href="hilfe.html#standort">Hilfe zum Standort</a><button
    id="dismiss-location-error"
    type="button"
    class="text-button"
  >
    Schließen
  </button>
</div>
<div class="history-feedback">
  {@render rootToast?.()}
  <span
    id="planning-announcement"
    class="sr-only"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  ></span>
  <div id="history-undo" class="toast history-undo" hidden>
    <span role="status">Strecke gelöscht</span>
    <button id="history-undo-button" class="text-button" type="button">
      Rückgängig
    </button>
  </div>
</div>
<div id="update-banner" class="update-banner" role="status" hidden>
  <span
    >Neue Version von FoldRoute verfügbar. Zum Aktualisieren wird die App neu
    geladen.</span
  >
  <div class="update-actions">
    <button id="update-later" type="button">Später</button>
    <button id="update-now" type="button" class="primary">
      Jetzt neu laden
    </button>
  </div>
</div>
