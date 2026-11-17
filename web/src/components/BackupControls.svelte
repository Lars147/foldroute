<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    decodeBackup,
    encodeBackup,
    type BackupActions,
    type FoldRouteBackup,
  } from "../backup-codec";
  let { actions }: { actions: BackupActions } = $props();
  let busy = $state(false);
  let message = $state("");
  let prepared = $state<File>();
  let url = $state("");
  let candidate = $state.raw<FoldRouteBackup>();
  let dialog: HTMLDialogElement;
  let picker: HTMLInputElement;
  let trigger: HTMLButtonElement;
  let revision = 0;
  const errorText = (error: unknown) => {
    if (error instanceof SyntaxError)
      return "Keine gültige JSON-Sicherung. Bitte eine FoldRoute-Sicherungsdatei auswählen.";
    if (error instanceof DOMException)
      return error.name === "QuotaExceededError"
        ? "Nicht genügend Speicherplatz. Sicherung konnte nicht verarbeitet werden."
        : "Speicherzugriff fehlgeschlagen. Bitte erneut versuchen.";
    return error instanceof Error
      ? error.message
      : "Sicherung konnte nicht verarbeitet werden.";
  };
  function discard() {
    if (url) URL.revokeObjectURL(url);
    url = "";
    prepared = undefined;
  }
  onDestroy(() => {
    revision++;
    discard();
  });
  async function prepare() {
    const current = ++revision;
    busy = true;
    message = "";
    discard();
    try {
      const snapshot = await actions.create();
      if (current !== revision) return;
      const name = `foldroute-sicherung-${snapshot.exportedAt.slice(0, 10)}-${snapshot.exportedAt.slice(11, 19).replace(/:/g, "")}.json`;
      prepared = new File([encodeBackup(snapshot)], name, {
        type: "application/json",
      });
      url = URL.createObjectURL(prepared);
      message =
        "Sicherungsdatei bereit. Bitte außerhalb von FoldRoute in Dateien speichern.";
      void navigator.storage?.persist?.().catch(() => {});
    } catch (error) {
      message = errorText(error);
    } finally {
      busy = false;
    }
  }
  async function share() {
    if (!prepared) return;
    try {
      await navigator.share({
        files: [prepared],
        title: "FoldRoute-Sicherung",
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        message = "Teilen nicht möglich. Bitte Datei herunterladen.";
    }
  }
  async function select() {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    const current = ++revision;
    busy = true;
    message = "";
    try {
      const parsed = await decodeBackup(file);
      if (current !== revision) return;
      candidate = parsed;
      dialog.showModal();
    } catch (error) {
      message = errorText(error);
    } finally {
      busy = false;
    }
  }
  function close() {
    if (!busy) dialog.close();
  }
  async function restore() {
    if (!candidate || busy) return;
    let blocked = false;
    busy = true;
    message = "";
    try {
      await actions.restore(candidate);
      blocked = true;
      message =
        "Sicherung wiederhergestellt. Bitte FoldRoute neu öffnen, falls die Startseite nicht automatisch erscheint.";
    } catch (error) {
      message = errorText(error);
      blocked = error instanceof Error && error.name === "BackupRecoveryError";
    } finally {
      busy = blocked;
    }
  }
</script>

<div class="backup-actions">
  <button type="button" class="secondary" onclick={prepare} disabled={busy}
    >Daten sichern</button
  >
  <button
    type="button"
    class="secondary"
    bind:this={trigger}
    onclick={() => picker.click()}
    disabled={busy}>Sicherung wiederherstellen</button
  >
  <input
    type="file"
    accept=".json,application/json"
    bind:this={picker}
    onchange={select}
    hidden
  />
  {#if prepared}
    {#if navigator.canShare?.({ files: [prepared] })}<button
        type="button"
        class="secondary"
        onclick={share}
        disabled={busy}>Datei speichern / teilen</button
      >{/if}
    <a href={url} download={prepared.name}>Sicherungsdatei herunterladen</a>
  {/if}
  <p class="message">
    Enthält Einstellungen, Orte, Streckenverlauf und Statistik. Vor Entfernen
    der PWA außerhalb der App sichern.
  </p>
  <p class="message" role="status">{message}</p>
</div>
<dialog
  bind:this={dialog}
  aria-labelledby="backup-restore-heading"
  onclose={() => {
    candidate = undefined;
    trigger?.focus();
  }}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
>
  <h2 id="backup-restore-heading">Vorhandene Daten ersetzen?</h2>
  {#if candidate}
    <p>
      Sicherung vom {new Date(candidate.exportedAt).toLocaleString("de-DE")}
    </p>
    <p>
      {candidate.places.length} Orte · {candidate.history.length} Strecken · {candidate
        .statistics.completedIds.length} Fahrten
    </p>
    <p>
      {(candidate.statistics.distanceMeters / 1000).toLocaleString("de-DE")} km ·
      {Math.round(candidate.statistics.elapsedSeconds / 60)} Minuten
    </p>
    <p>
      Einstellungen, Orte, Verlauf und Statistik werden ersetzt. Ein vorhandener
      Navigationsstand wird entfernt. Bitte andere FoldRoute-Fenster schließen.
    </p>
  {/if}
  <p class="message" role="status">{message}</p>
  <div class="actions">
    <button type="button" class="secondary" onclick={close} disabled={busy}
      >Abbrechen</button
    >
    <button type="button" class="primary" onclick={restore} disabled={busy}
      >Vorhandene Daten ersetzen</button
    >
  </div>
</dialog>

<style>
  .backup-actions {
    display: grid;
    gap: 12px;
    margin-bottom: 16px;
  }
</style>
