<script lang="ts">
  import AppRoot from "./AppRoot.svelte";
  import type { AppPresentation } from "../app-presentation";
  let { onDispose }: { onDispose?: () => void } = $props();
  let root: { presentation(): AppPresentation };
  export function presentation() {
    return root.presentation();
  }
</script>

<AppRoot {onDispose} bind:this={root} mode="example" />
