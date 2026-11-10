<script lang="ts">
  import type {
    NavigationCompletionModel,
    NavigationCompletionCommands,
  } from "../navigation-presentation";
  let {
    mode,
    model,
    commands,
  }: {
    mode: "manual" | "primary";
    model: NavigationCompletionModel;
    commands: NavigationCompletionCommands;
  } = $props();
  let manualOpen = $state(false);
  let wasMobile = false;
  $effect(() => {
    if (!model.manualAvailable) manualOpen = false;
    else if (model.mobile) manualOpen = true;
    else if (wasMobile) manualOpen = false;
    wasMobile = model.mobile;
  });
  function suppressRepeat(event: KeyboardEvent) {
    if (event.repeat && (event.key === "Enter" || event.key === " "))
      event.preventDefault();
  }
</script>

{#if mode === "manual"}
  <details
    id="navigation-manual-actions"
    hidden={!model.manualAvailable}
    bind:open={manualOpen}
  >
    <summary id="navigation-more-actions" hidden={model.mobile}
      >Weitere Aktionen</summary
    >
    <div class="navigation-actions">
      <button
        id="navigation-complete-manually"
        class="secondary"
        type="button"
        disabled={model.busy}
        onclick={(event) => commands.complete(event, true)}
        onkeydown={suppressRepeat}>Abschnitt manuell abschließen</button
      >
    </div>
  </details>
{:else}
  <button
    id="navigation-complete"
    class={model.alternativeAvailable || model.completionPrimary === false
      ? "secondary"
      : "primary"}
    hidden={!model.available}
    disabled={model.busy}
    type="button"
    data-countdown={model.countdown
      ? Math.ceil(model.countdown.remaining)
      : undefined}
    title={model.countdown?.title}
    aria-describedby={model.countdown
      ? "navigation-complete-countdown-description"
      : undefined}
    onclick={(event) => commands.complete(event, false)}
    onkeydown={suppressRepeat}
  >
    <span id="navigation-complete-label">{model.label}</span>
    <span
      class="countdown-bar"
      aria-hidden="true"
      hidden={!model.countdown}
      data-paused={model.countdown?.paused ? "" : undefined}
      style={`--countdown-transition: ${model.countdown?.paused ? 0 : 1000}ms`}
    >
      <span
        class="countdown-bar-fill"
        style={`animation: none; transform: scaleX(${model.countdown ? Math.max(0, Math.min(1, model.countdown.remaining / model.countdown.duration)) : 0})`}
      ></span>
    </span>
  </button>
  <button
    id="navigation-retry"
    class={(model.available && model.completionPrimary !== false) ||
    model.alternativeAvailable
      ? "secondary"
      : "primary"}
    type="button"
    hidden={!model.retryVisible || model.alternativeAvailable}
    onclick={commands.retry}>{model.retryLabel}</button
  >
  <button
    id="navigation-replan"
    class={(model.available && model.completionPrimary !== false) ||
    model.retryVisible ||
    model.alternativeAvailable
      ? "secondary"
      : "primary"}
    type="button"
    hidden={!model.replanVisible || model.alternativeAvailable}
    onclick={commands.replan}>Route ab hier planen</button
  >
  <span id="navigation-complete-countdown-description" class="sr-only"
    >{model.countdown?.description ?? ""}</span
  >
{/if}
