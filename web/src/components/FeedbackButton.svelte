<script lang="ts">
  import {
    feedbackProvider,
    feedbackCapture,
    openFeedback,
  } from "../feedback-controller";

  let { placement }: { placement: "settings" | "navigation" } = $props();
</script>

{#if $feedbackProvider}
  <button
    id={`${placement}-report-problem`}
    class={placement === "settings" ? "group settings-report" : "text-button"}
    type="button"
    data-feedback-trigger
    disabled={!!$feedbackCapture}
    onclick={(event) => openFeedback(event.currentTarget)}
  >
    <span>Problem melden</span>
    {#if placement === "settings"}<span aria-hidden="true">›</span>{/if}
  </button>
{/if}

<style>
  button {
    width: 100%;
    text-align: start;
  }
  .text-button {
    min-height: 44px;
    margin-block-start: 8px;
  }
</style>
