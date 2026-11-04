<script lang="ts">
  import type { Journey } from "../model";
  import { detailGroups } from "../journey-detail";
  import type { JourneyDetailOptions } from "../journey-detail-view";
  import JourneyStep from "./JourneyStep.svelte";
  let {
    journey,
    restored,
    options,
  }: { journey: Journey; restored: boolean; options: JourneyDetailOptions } =
    $props();
  let summary = $state<string | undefined>();
  const groups = $derived(detailGroups(journey));
  export function setMovementSummary(text: string) {
    summary = text;
  }
</script>

{#each groups as group}
  <li class="journey-section">
    <ol class="journey-steps">
      {#each group as leg, index}
        <JourneyStep
          {journey}
          {leg}
          next={group[index + 1]}
          {restored}
          {options}
          {summary}
        />
      {/each}
    </ol>
  </li>
{/each}
