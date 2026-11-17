<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    feedbackProvider,
    consumeFeedbackBack,
    feedbackCapture,
    closeFeedback,
    captureFeedbackImage,
  } from "../feedback-controller";
  import {
    enqueue,
    readOutbox,
    drainFeedback,
    deleteFeedback,
  } from "../feedback-outbox";
  import { sendFeedback } from "../feedback-sender";
  import type { FeedbackReport } from "../feedback-report";
  let dialog: HTMLDialogElement;
  let message = $state("");
  let status = $state("");
  let busy = $state(false);
  let capturing = $state(false);
  let diagnose = $state(true);
  let includeImage = $state(true);
  let image = $state<Blob>();
  let imageAt = $state<string>();
  let preview = $state("");
  let ready = $state(false);
  let inSettings = $state(false);
  let submitted = $state(false);
  let retryAt = $state(0);
  let lastError = $state("");
  let pending = $state<FeedbackReport[]>([]);
  let returnFocus: HTMLElement | null = null;
  let revision = 0;
  async function refresh() {
    const value = await readOutbox();
    pending = value.reports;
    retryAt = value.retryAt;
    lastError = value.error ?? "";
  }
  async function drain(force = false, ticket = revision) {
    try {
      await drainFeedback(sendFeedback, force);
      await refresh();
    } catch (error) {
      if (ticket === revision)
        status = String(error instanceof Error ? error.message : error);
      await refresh();
    }
  }
  function finish() {
    closeFeedback();
    dialog?.close();
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden],[inert]"))
      returnFocus.focus({ preventScroll: true });
  }
  $effect(() => {
    const capture = $feedbackCapture;
    untrack(() => {
      const current = ++revision;
      if (!capture) {
        dialog?.close();
        return;
      }
      returnFocus = capture.focusId
        ? document.getElementById(capture.focusId)
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      submitted = false;
      message = "";
      status = "Bild wird vorbereitet …";
      capturing = true;
      image = undefined;
      imageAt = undefined;
      if (preview) URL.revokeObjectURL(preview);
      preview = "";
      // Clone before the feedback modal changes the visible application.
      void captureFeedbackImage(capture)
        .then((result) => {
          if (current !== revision) return;
          image = result.image ?? undefined;
          imageAt = result.imageAt;
          if (image) preview = URL.createObjectURL(image);
          status = "";
        })
        .catch((error) => {
          if (current === revision) status = error.message;
        })
        .finally(() => {
          if (current === revision) {
            capturing = false;
            dialog.showModal();
          }
        });
    });
  });
  async function submit() {
    const capture = $feedbackCapture;
    if (!capture || busy || capturing || submitted) return;
    busy = true;
    const ticket = revision;
    try {
      await enqueue(
        {
          version: 1,
          id: capture.id,
          capturedAt: capture.capturedAt,
          release: capture.release,
          environment: capture.environment,
          message,
          context: diagnose ? capture.context : undefined,
          image: includeImage ? image : undefined,
          imageAt: includeImage ? imageAt : undefined,
        },
        capture.epoch,
      );
      if (ticket === revision) submitted = true;
      if (ticket === revision)
        status =
          "Meldung auf diesem Gerät vorgemerkt. Wird bei geöffneter App mit Internet gesendet.";
      await refresh();
      await drain(false, ticket);
      if (ticket === revision && !pending.some((r) => r.id === capture.id))
        status = "Feedback gesendet.";
    } catch (error) {
      if (ticket === revision)
        status = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
  async function remove(id: string) {
    try {
      await deleteFeedback(id);
      await refresh();
    } catch (error) {
      status = String(error);
    }
  }
  async function download() {
    const c = $feedbackCapture;
    if (!c) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify({
            version: 1,
            id: c.id,
            capturedAt: c.capturedAt,
            message,
            context: diagnose ? c.context : undefined,
            image:
              includeImage && image
                ? {
                    type: image.type,
                    base64: await new Promise<string>((resolve, reject) => {
                      const reader = new FileReader();
                      reader.onload = () =>
                        resolve(String(reader.result).split(",")[1]);
                      reader.onerror = () => reject(reader.error);
                      reader.readAsDataURL(image!);
                    }),
                  }
                : undefined,
          }),
        ],
        {
          type: "application/json",
        },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `foldroute-feedback-${c.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $effect(() => {
    ready = !!$feedbackProvider;
    if (ready)
      void refresh()
        .then(() => drain())
        .catch(() => {});
  });
  onMount(() => {
    const back = (event: PopStateEvent) => {
      if (consumeFeedbackBack(event)) return;
      if (!$feedbackCapture) return;
      event.stopImmediatePropagation();
      finish();
    };
    window.addEventListener("popstate", back, true);
    const online = () => {
      if (ready) void drain();
    };
    const observer = new MutationObserver(() => {
      inSettings = document.body.dataset.view === "settings";
      if (inSettings && ready) void refresh().catch(() => {});
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-view"],
    });
    window.addEventListener("foldroute:feedback-clear", online);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", online);
    const tick = setInterval(online, 60_000);

    return () => {
      observer.disconnect();
      window.removeEventListener("foldroute:feedback-clear", online);
      revision++;
      clearInterval(tick);
      window.removeEventListener("popstate", back, true);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", online);
      if (preview) URL.revokeObjectURL(preview);
    };
  });
</script>

{#if $feedbackCapture && capturing}<div
    class="feedback-capturing"
    data-feedback-ui
    role="status"
  >
    Ansicht wird erfasst … <button type="button" onclick={finish}
      >Abbrechen</button
    >
  </div>{/if}
<dialog
  bind:this={dialog}
  data-feedback-ui
  aria-labelledby="feedback-heading"
  oncancel={(e) => {
    e.preventDefault();
    finish();
  }}
>
  <h2 id="feedback-heading">Problem melden</h2>
  <label for="feedback-message">Was ist passiert?</label>
  <textarea id="feedback-message" bind:value={message} maxlength="5000" rows="4"
  ></textarea>
  <p>
    Diagnose und Bild können Route und letzte Position enthalten. Versand nur an
    den privaten FoldRoute-Pool bei Sentry (EU).
  </p>
  <label
    ><input type="checkbox" bind:checked={diagnose} /> Diagnose mitsenden</label
  >
  <label
    ><input type="checkbox" bind:checked={includeImage} /> Bild mitsenden</label
  >
  {#if preview && includeImage}<img
      src={preview}
      alt="Automatisch erfasste Appansicht"
      class="feedback-preview"
    />{/if}
  <p role="status">{status}</p>
  {#if !navigator.locks}<p>
      Dieser Browser unterstützt keinen koordinierten Versand. Bitte Bericht
      herunterladen.
    </p>
    <button type="button" onclick={download}>Bericht herunterladen</button>{/if}
  <div class="actions">
    <button type="button" onclick={finish}>Schließen</button><button
      type="button"
      class="primary"
      onclick={submit}
      disabled={busy ||
        capturing ||
        submitted ||
        !message.trim() ||
        !navigator.locks}>Feedback senden</button
    >
  </div>
</dialog>
{#if pending.length && inSettings}<section
    class="feedback-pending"
    data-feedback-ui
    aria-label="Offenes Feedback"
  >
    <h2>Offene Meldungen</h2>
    <p role="status">
      {lastError}{#if retryAt > Date.now()}
        Versand pausiert bis {new Date(retryAt).toLocaleTimeString(
          "de-DE",
        )}.{/if}
    </p>
    <p>
      Bereits laufender Versand wird vor dem Löschen abgeschlossen. Empfangene
      Meldungen bleiben im privaten Pool.
    </p>
    {#each pending as report}<div>
        <p>{report.message}</p>
        <button type="button" onclick={() => remove(report.id)}
          >Meldung löschen</button
        >
      </div>{/each}<button type="button" onclick={() => drain(true)}
      >Erneut senden</button
    >
  </section>{/if}

<style>
  dialog {
    padding: 20px;
    max-width: 560px;
    max-height: 85dvh;
    overflow: auto;
  }
  textarea {
    width: 100%;
    font: inherit;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    color: var(--ink);
    box-sizing: border-box;
  }
  label {
    display: block;
    margin-block: 12px;
  }
  .feedback-preview {
    width: 100%;
    max-height: 180px;
    background: var(--surface);
    border-radius: 12px;
    object-fit: contain;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .feedback-capturing {
    position: fixed;
    bottom: 80px;
    left: 12px;
    right: 12px;
    z-index: 2000;
    background: var(--panel);
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--line);
  }
  h2 {
    margin: 0 0 12px;
  }
  .feedback-pending {
    margin: 16px;
  }
</style>
