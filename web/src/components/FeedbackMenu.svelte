<script lang="ts">
  import {
    feedbackProvider,
    feedbackCapture,
    rememberFeedbackOrigin,
    openFeedback,
  } from "../feedback-controller";
  let {
    context = "Ansicht",
    action = false,
  }: { context?: string; action?: boolean } = $props();
  let launcher: HTMLButtonElement;
  let popup: HTMLDivElement;
  let expanded = $state(false);
  function toggle() {
    if (expanded) {
      popup.hidePopover();
      return;
    }
    popup.showPopover();
    expanded = true;
    const rect = launcher.getBoundingClientRect();
    popup.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
    popup.style.top = `${rect.bottom + popup.offsetHeight + 8 < innerHeight ? rect.bottom : Math.max(8, rect.top - popup.offsetHeight)}px`;
  }
  function report() {
    popup?.hidePopover();
    expanded = false;
    const parent = document.activeElement?.closest("dialog");
    if (parent?.id === "route-actions-dialog")
      (parent as HTMLDialogElement).close();
    openFeedback();
  }
</script>

{#if $feedbackProvider}
  {#if action}<button
      type="button"
      onclick={report}
      disabled={!!$feedbackCapture}>Problem melden</button
    >
  {:else}<div class="feedback-menu" data-feedback-ui>
      <button
        class="feedback-launch"
        type="button"
        bind:this={launcher}
        aria-label={`Weitere Aktionen: ${context}`}
        aria-expanded={expanded}
        disabled={!!$feedbackCapture}
        onpointerdown={rememberFeedbackOrigin}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") rememberFeedbackOrigin();
        }}
        onclick={toggle}>…</button
      >
      <div
        bind:this={popup}
        popover="auto"
        aria-label={`Aktionen: ${context}`}
        ontoggle={(event) => (expanded = event.newState === "open")}
      >
        <button type="button" onclick={report}>Problem melden</button>
      </div>
    </div>{/if}
{/if}

<style>
  .feedback-menu {
    float: right;
    position: relative;
    margin-inline-start: auto;
  }
  .feedback-launch {
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 24px;
    border: 0;
    background: transparent;
  }
  .feedback-menu > div {
    position: fixed;
    inset: auto;
    margin: 0;
    min-width: 180px;
    background: var(--panel);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 8px;
  }
</style>
