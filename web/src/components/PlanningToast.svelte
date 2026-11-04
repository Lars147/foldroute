<script lang="ts">
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import RetryCountdownText from "./RetryCountdownText.svelte";
  import type { WorkspaceToast } from "../journey-workspace-presentation";
  let {
    model,
    styles,
    mapToast,
    recovery,
  }: {
    model: WorkspaceToast;
    styles: Readonly<Record<string, string>>;
    mapToast: boolean;
    recovery?: Snippet;
  } = $props();
  let sample = $state(performance.now());
  const countdownElapsed = $derived(
    model.countdown
      ? Math.max(
          0,
          Math.min(
            model.countdown.duration,
            sample - model.countdown.deadline + model.countdown.duration,
          ),
        )
      : 0,
  );
  onMount(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const refresh = () => (sample = performance.now());
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  });
</script>

<div
  id="toast"
  class="toast"
  role="status"
  hidden={!model.visible}
  data-planning-id={model.planningId}
  data-planning-stage={model.stage}
  data-map-toast={mapToast ? "" : undefined}
  style={Object.entries(styles)
    .map(([name, value]) => `${name}: ${value}`)
    .join(";")}
>
  {#if model.planningId}
    {#if model.stage === "searching" || model.stage === "optimizing"}<span
        class="planning-toast-spinner"
        aria-hidden="true"
      ></span>
    {:else if model.stage === "ready"}<Icon name="check" />
    {:else if model.stage === "error"}<Icon
        name="warning"
        class="planning-toast-warning"
      />{/if}
    <span class="planning-toast-message"
      >{model.message}<RetryCountdownText until={model.retryAt ?? 0} /></span
    >
  {:else}{model.message}{/if}
  {#if recovery}{@render recovery()}{/if}
  {#if model.countdown}
    <span
      class="countdown-bar toast-countdown"
      aria-hidden="true"
      data-animated=""
      style="--countdown-transition: 0ms"
      style:--toast-duration={`${model.countdown.duration}ms`}
      style:--toast-elapsed={`${countdownElapsed}ms`}
    >
      {#key sample}
        <span class="countdown-bar-fill toast-countdown-fill"></span>
      {/key}
    </span>
  {/if}
</div>
