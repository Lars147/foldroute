<script lang="ts">
  import { onDestroy } from "svelte";
  let { until }: { until: number } = $props();
  let seconds = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    clearTimeout(timer);
    const deadline = until;
    const tick = () => {
      const remaining = Math.max(0, deadline * 1000 - Date.now());
      seconds = Math.ceil(remaining / 1000);
      if (remaining) timer = setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
    return () => clearTimeout(timer);
  });
  onDestroy(() => clearTimeout(timer));
</script>

{#if seconds}<span class="retry-countdown" aria-hidden="true"
    >{` · ${seconds} s`}</span
  >{/if}
