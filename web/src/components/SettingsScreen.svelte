<script lang="ts">
  import buildVersion from "virtual:foldroute-build-version";
  import SettingsFields from "./SettingsFields.svelte";
  import type { SettingsFieldsPresentation } from "../app-presentation";
  let binding = $state.raw<SettingsFieldsPresentation | undefined>();
  let revision = $state(0);
  export function render(value: SettingsFieldsPresentation) {
    binding = value;
    revision++;
  }
  export function clear() {
    binding = undefined;
  }
</script>

<section
  id="settings-view"
  class="screen settings-screen"
  aria-labelledby="settings-heading"
  hidden
>
  <div class="settings-heading-row">
    <h1 id="settings-heading">Einstellungen</h1>
    <span id="settings-summary" class="settings-mobile-title" aria-hidden="true"
      >Deine Vorgaben</span
    >
    <button
      id="save-settings"
      class="text-button"
      type="submit"
      form="settings-form"
    >
      Fertig
    </button>
  </div>
  <section
    id="app-updates"
    class="group app-updates"
    aria-labelledby="app-updates-heading"
    hidden
  >
    <div class="app-update-copy">
      <h2 id="app-updates-heading" tabindex="-1">App-Updates</h2>
      <p id="update-status" class="message" role="status">
        <strong id="update-availability" hidden></strong>
        <span id="update-description"></span>
      </p>
    </div>
    <div class="app-update-actions">
      <button
        id="check-updates"
        class="secondary"
        type="button"
        aria-describedby="update-status"
      >
        Nach Updates suchen
      </button>
      <button
        id="settings-update-now"
        class="primary"
        type="button"
        aria-describedby="update-status"
        hidden
      >
        Jetzt neu laden
      </button>
    </div>
  </section>
  <form id="settings-form" novalidate>
    <p id="settings-replan" class="message" role="status" hidden></p>
    <section class="group">
      <h2>Rad &amp; Falten</h2>
      <div id="settings-fields">
        {#key revision}{#if binding}<SettingsFields
              section="basic"
              {...binding}
            />{/if}{/key}
      </div>
    </section>
    <details id="settings-modes" class="group settings-disclosure">
      <summary>
        <span
          >Verkehrsmittel<small id="modes-summary">Alle Verkehrsmittel</small
          ></span
        >
      </summary>
      <fieldset id="modes" aria-label="Verkehrsmittel">
        {#key revision}{#if binding}<SettingsFields
              section="modes"
              {...binding}
            />{/if}{/key}
      </fieldset>
    </details>
    <details id="settings-options" class="group settings-disclosure">
      <summary>
        <span
          >Wege &amp; Umsteigen<small
            >Fußwege und zusätzliche Umstiegszeit</small
          ></span
        >
      </summary>
      <div id="settings-extra-fields">
        {#key revision}{#if binding}<SettingsFields
              section="extra"
              {...binding}
            />{/if}{/key}
      </div>
    </details>
    <details id="settings-optimization" class="group settings-disclosure">
      <summary>
        <span
          >Routenoptimierung<small>Radverbindungen und Fahrradvergleich</small
          ></span
        >
      </summary>
      <div id="settings-optimization-fields">
        {#key revision}{#if binding}<SettingsFields
              section="optimization"
              {...binding}
            />{/if}{/key}
      </div>
    </details>
    <button id="reset-settings" type="button" class="text-button">
      Routeneinstellungen zurücksetzen
    </button>
  </form>
  <section class="group" id="app-settings">
    <h2>Darstellung &amp; Bedienung</h2>
    <fieldset class="appearance-picker">
      <legend>Darstellung</legend>
      <div class="appearance-segments">
        <label
          ><input type="radio" name="appearance" value="system" checked /><span
            >System</span
          ></label
        >
        <label
          ><input type="radio" name="appearance" value="light" /><span
            >Hell</span
          ></label
        >
        <label
          ><input type="radio" name="appearance" value="dark" /><span
            >Dunkel</span
          ></label
        >
      </div>
    </fieldset>
    <label class="toggle-row">
      <span
        >Bildschirm eingeschaltet lassen<small
          >Während der Routenvorschau. Verbraucht mehr Akku; der Stromsparmodus
          kann dies verhindern.</small
        ></span
      >
      <input id="keep-screen-awake" type="checkbox" role="switch" checked />
    </label>
  </section>
  <section class="group" id="storage-settings">
    <h2>Speicher auf diesem Gerät</h2>
    <label class="toggle-row">
      <span
        >Streckenverlauf speichern<small id="storage-save-hint"
          >Behält bis zu 20 geplante Strecken zum erneuten Öffnen.</small
        ></span
      >
      <input
        id="offline-enabled"
        type="checkbox"
        role="switch"
        aria-describedby="storage-save-hint storage-delete-hint"
        checked
      />
    </label>
    <label class="toggle-row">
      <span
        >Navigation wiederaufnehmen<small id="navigation-storage-hint"
          >Speichert den aktuellen Stand, damit du deine Fahrt nach Schließen
          der App fortsetzen kannst.</small
        ></span
      >
      <input
        id="navigation-storage-enabled"
        type="checkbox"
        role="switch"
        aria-describedby="navigation-storage-hint storage-delete-hint"
        checked
      />
    </label>
    <label class="toggle-row">
      <span
        >Fahrtstatistik speichern<small id="statistics-storage-hint"
          >Sammelt Gesamtstrecke und Fahrzeit abgeschlossener Fahrten.</small
        ></span
      >
      <input
        id="statistics-enabled"
        type="checkbox"
        role="switch"
        aria-describedby="statistics-storage-hint storage-delete-hint"
        checked
      />
    </label>
    <p id="storage-delete-hint" class="message">
      Ausschalten stoppt neue Speicherung. Vorhandene Daten bleiben erhalten und
      lassen sich unter „Daten verwalten“ einzeln löschen.
    </p>
    <p id="storage-message" class="message" role="status"></p>
  </section>
  <details id="settings-data" class="group settings-disclosure">
    <summary>Daten verwalten</summary>
    <button id="delete-saved" type="button" class="text-button settings-delete">
      Streckenverlauf löschen
    </button>
    <button
      id="delete-navigation"
      type="button"
      class="text-button settings-delete"
    >
      Gespeicherten Navigationsstand löschen
    </button>
    <button
      id="delete-statistics"
      type="button"
      class="text-button settings-delete"
    >
      Fahrtstatistik löschen
    </button>
    <button id="clear-data" type="button" class="text-button settings-delete">
      Alle lokalen Daten löschen
    </button>
  </details>
  <a
    id="open-licenses"
    class="group settings-licenses"
    href="licenses.html"
    aria-haspopup="dialog"
    aria-controls="licenses-dialog"
    ><span>Lizenzen &amp; Datenquellen</span><span aria-hidden="true">›</span
    ></a
  >
  <a class="group settings-feedback" href="https://foldroute.userjot.com/"
    ><span>Feedback &amp; Ideen</span><span aria-hidden="true">↗</span></a
  >
  <details id="settings-help" class="group settings-disclosure info">
    <summary>Installation &amp; Hilfe</summary>
    <div class="settings-install">
      <button id="install" class="secondary"> FoldRoute installieren </button>
      <p id="install-message" class="message" role="status"></p>
      <div id="ios-install-guide" class="install-guide" hidden>
        <ol class="install-steps" aria-label="Installation auf iPhone und iPad">
          <li>
            <div class="install-step">
              <span data-icon="share" aria-hidden="true"></span>
              <div>
                Öffne <strong>„Teilen“</strong> im Browser.
                <span class="install-step-note"
                  >In Safari gegebenenfalls zuerst das Seitenmenü öffnen.</span
                >
              </div>
            </div>
          </li>
          <li>
            <div class="install-step">
              <span data-icon="plus-square" aria-hidden="true"></span>
              <div>
                Wähle <strong>„Zu Home-Bildschirm hinzufügen“</strong>.
                <span class="install-step-note"
                  >In Chrome: „Zum Startbildschirm hinzufügen“.</span
                >
              </div>
            </div>
          </li>
          <li>
            <div class="install-step">
              <span data-icon="check" aria-hidden="true"></span>
              <div>
                Aktiviere <strong>„Als Web-App öffnen“</strong>, falls
                angeboten, und tippe auf <strong>„Hinzufügen“</strong>.
              </div>
            </div>
          </li>
        </ol>
        <p>
          <a class="installation-help" href="hilfe.html#installation"
            >Hilfe zur Installation</a
          >
        </p>
      </div>
    </div>
    <nav class="settings-help-links" aria-label="Hilfe und Informationen">
      <a href="hilfe.html"
        ><span>Hilfe &amp; FAQ</span><span aria-hidden="true">›</span></a
      >
      <a href="hilfe.html#datenschutz"
        ><span>Datenschutz &amp; Daten</span><span aria-hidden="true">›</span
        ></a
      >
      <a
        id="open-about"
        href="https://github.com/Lars147/foldroute"
        aria-haspopup="dialog"
        aria-controls="about-dialog"
        ><span>Über FoldRoute</span><span aria-hidden="true">›</span></a
      >
    </nav>
  </details>
  <p class="settings-version">
    Version
    <a
      id="app-version"
      href={`https://github.com/Lars147/foldroute/commit/${buildVersion.commit}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Commit ${buildVersion.shortCommit} auf GitHub öffnen (neuer Tab)`}
      >{buildVersion.shortCommit}</a
    >
  </p>
</section>
