<script lang="ts">
  import Icon from "./Icon.svelte";
  import {
    cyclingExcess,
    cyclingComparisonLabel,
    journeyEffort,
    journeyOutline,
    type Journey,
  } from "../model";
  import { duration, routeSymbolColor } from "../ui";
  import { journeyEndpointTime } from "../journey-time";
  let {
    journey,
    cyclingLimit,
    example = false,
    recommendation,
  }: {
    journey: Journey;
    cyclingLimit: number;
    example?: boolean;
    recommendation?: string;
  } = $props();
  const comparison = $derived(cyclingExcess(journey, cyclingLimit) > 0);
  const effort = $derived(journeyEffort(journey));
  const transfers = $derived(
    `${effort.transfers} ${effort.transfers === 1 ? "Umstieg" : "Umstiege"}`,
  );
  const effortText = $derived(
    effort.cyclingSeconds > 0
      ? `${duration(effort.cyclingSeconds)} Rad · ${transfers}`
      : transfers,
  );
  const stages = $derived(
    journey.legs.filter(
      (leg) => !["fold", "unfold", "wait"].includes(leg.kind),
    ),
  );
</script>

{#if recommendation}<span class="route-recommendation">{recommendation}</span
  >{/if}
<span class="route-choice-time">
  <strong
    class="route-choice-arrival"
    style:--stage-color={comparison ? routeSymbolColor("bike") : undefined}
  >
    {#if comparison}<Icon name="bike" /><span class="visually-hidden">
        ·
      </span>{/if}
    {example
      ? `${duration(journey.arrival - journey.departure)} gesamt`
      : `${journeyEndpointTime(journey, "arrival")} an`}
  </strong>
  {#if !example}<span class="visually-hidden">{" · "}</span><span
      class="route-choice-schedule"
      >Ab {journeyEndpointTime(journey, "departure")} · {duration(
        journey.arrival - journey.departure,
      )}</span
    >{/if}
</span>
<span class="route-outline" aria-hidden="true">
  {#each stages as leg, index}
    {@const symbol =
      leg.kind === "transit" && ["BUS", "COACH"].includes(leg.mode ?? "")
        ? "bus"
        : leg.kind}
    {@const namedRail =
      leg.kind === "transit" &&
      ["SUBURBAN", "SUBWAY", "REGIONAL_RAIL"].includes(leg.mode ?? "") &&
      !!leg.line?.trim()}
    <span
      class="route-stage"
      data-kind={leg.kind}
      data-symbol={symbol}
      style:--stage-color={routeSymbolColor(leg.kind, leg.mode)}
    >
      {#if index}<span class="route-stage-arrow">→</span>{/if}
      {#if !namedRail}<Icon name={symbol} />{/if}
      {#if leg.kind === "transit"}<span class="route-line"
          >{leg.line?.trim() || "ÖPNV"}</span
        >
      {:else if leg.kind === "stop"}<span class="route-stop-name"
          >{leg.from.name}</span
        >{/if}
    </span>
  {/each}
</span>
<span class="route-choice-effort" aria-hidden="true">
  <span class="route-effort-label">Gesamt:</span>
  {#if effort.cyclingSeconds > 0}<span
      class="route-effort-metric"
      data-kind="bike"
      title="Gesamte Zeit auf dem Fahrrad"
      >{duration(effort.cyclingSeconds)} Rad</span
    >{/if}
  <span
    class="route-effort-metric"
    data-kind="transfer"
    title="Anzahl der Umstiege">{effort.transfers} Umst.</span
  >
</span>
<span class="sr-only"
  >{comparison
    ? `Fahrradvergleich: ${cyclingComparisonLabel(journey, cyclingLimit)}. `
    : ""}{journeyOutline(journey)}. {effortText}</span
>
