<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { NavigationTab } from "../navigation-presentation";
  let {
    select,
    keydown,
    model,
  }: {
    select: (id: string) => void;
    keydown: (event: KeyboardEvent) => void;
    model: readonly NavigationTab[];
  } = $props();
</script>

<div
  id="navigation-phases"
  role="tablist"
  tabindex="-1"
  aria-label="Reiseabschnitte"
  onkeydown={keydown}
>
  {#each model as tab, index (tab.id)}
    <button
      id={`navigation-tab-${index}`}
      type="button"
      class="navigation-phase"
      class:current={tab.current}
      role="tab"
      aria-controls="navigation-section-detail"
      aria-selected={tab.selected}
      aria-current={tab.current ? "step" : undefined}
      aria-label={tab.accessibleLabel}
      tabindex={tab.selected ? 0 : -1}
      onclick={() => select(tab.id)}
    >
      <span
        class="navigation-phase-symbol"
        aria-hidden="true"
        data-icon={tab.symbol}><Icon name={tab.symbol} /></span
      >
      <span class="navigation-phase-label">{tab.label}</span>
    </button>
  {/each}
</div>
