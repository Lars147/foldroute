<script lang="ts">
  import RouteSummary from "./RouteSummary.svelte";
  import {
    cyclingExcess,
    cyclingComparisonLabel,
    journeyEffort,
    journeyOutline,
    type Journey,
  } from "../model";
  import { clock, dateLabel, duration } from "../ui";
  let {
    journeys,
    selectedId,
    recommendedId,
    recommendation,
    restored,
    cyclingLimit,
    example,
    inSheet,
    select,
    details,
  }: {
    journeys: readonly Journey[];
    selectedId?: string;
    recommendedId?: string;
    recommendation: string;
    restored: boolean;
    cyclingLimit: number;
    example: boolean;
    inSheet: boolean;
    select: (journey: Journey) => void;
    details: (journey: Journey) => void;
  } = $props();
</script>

{#each journeys as journey, index (journey.id)}
  {@const comparison = cyclingExcess(journey, cyclingLimit) > 0}
  {@const effort = journeyEffort(journey)}
  {@const transfers = `${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`}
  {@const effortText =
    effort.cyclingSeconds > 0
      ? `${duration(effort.cyclingSeconds)} Rad · ${transfers}`
      : transfers}
  {@const outline = journeyOutline(journey)}
  {@const disabled = !inSheet && journey.id !== selectedId}
  <div class="route-choice-row" class:selected={journey.id === selectedId}>
    <button
      type="button"
      class="route-choice"
      data-journey={journey.id}
      aria-pressed={journey.id === selectedId}
      aria-label={example
        ? `Beispielroute: Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`
        : `${comparison ? "Fahrradvergleich: " + cyclingComparisonLabel(journey, cyclingLimit) : journey.id === recommendedId ? recommendation : `Alternative ${index + 1}`}: Ankunft ${dateLabel(journey.arrival)} ${clock(journey.arrival)}, Abfahrt ${dateLabel(journey.departure)} ${clock(journey.departure)}, Gesamtdauer ${duration(journey.arrival - journey.departure)}, ${effortText}. ${outline}`}
      onclick={() => select(journey)}
    >
      <RouteSummary
        {journey}
        {cyclingLimit}
        {example}
        recommendation={journey.id === recommendedId && !restored
          ? recommendation
          : undefined}
      />
    </button>
    <button
      class="route-detail-link"
      type="button"
      data-detail-journey={journey.id}
      {disabled}
      inert={disabled}
      aria-label={example
        ? "Details zur Beispielroute"
        : `Details: Abfahrt ${clock(journey.departure)}, Ankunft ${clock(journey.arrival)}`}
      onclick={() => details(journey)}>Details ›</button
    >
  </div>
{/each}
