<script lang="ts">
  import { type Journey, type Leg, kindNames } from "../model";
  import { detailTime } from "../journey-detail";
  import { duration, icon, legTextColors } from "../ui";
  import type { JourneyDetailOptions } from "../journey-detail-view";
  import JourneyTransitTime from "./JourneyTransitTime.svelte";

  let {
    journey,
    leg,
    next,
    restored,
    options,
    summary,
  }: {
    journey: Journey;
    leg: Leg;
    next?: Leg;
    restored: boolean;
    options: JourneyDetailOptions;
    summary?: string;
  } = $props();
  const example = $derived(options.presentation === "example");
  const navigation = $derived(options.presentation === "navigation");
  const main = $derived(leg === options.main);
  const compact = $derived(main && !!options.compactMovement);
  const preparation = $derived(["fold", "unfold", "wait"].includes(leg.kind));
  const promoted = $derived(
    navigation && main && ["fold", "unfold"].includes(leg.kind),
  );
  const start = $derived(example ? "" : detailTime(journey, leg.start));
  const end = $derived(example ? "" : detailTime(journey, leg.end));
  const interval = $derived(
    example
      ? duration(leg.end - leg.start)
      : `${start} – ${end} · ${duration(leg.end - leg.start)}`,
  );
  const distance = $derived(
    leg.distance >= 1000
      ? `${(leg.distance / 1000).toFixed(1)} km`
      : `${Math.round(leg.distance)} m`,
  );
  const movementDistance = $derived(
    navigation && main && ["bike", "walk"].includes(leg.kind)
      ? ` · ${distance}`
      : "",
  );
  // Only the fixed application icon set produces this markup.
  const symbol = $derived(icon(leg.kind).innerHTML);
</script>

<li
  class={`detail-step${preparation && !promoted ? " detail-preparation" : ""}${compact ? " navigation-current-movement" : ""}`}
  data-kind={leg.kind}
  style:--leg-color={legTextColors[leg.kind]}
>
  {#if compact}
    <small class="navigation-section-summary"
      >{summary ??
        `Geplant: ${duration(leg.end - leg.start)} · ${distance}`}</small
    >
  {:else}
    <span class="icon leg-symbol" aria-hidden="true">{@html symbol}</span>
    <div class="detail-copy">
      {#if leg.kind === "transit"}
        {#if example}<strong class="detail-heading">{leg.line || "ÖPNV"}</strong
          >
        {:else}<JourneyTransitTime
            {journey}
            {leg}
            event="departure"
            {restored}
          />{/if}
        <p class="detail-place">{leg.from.name}</p>
        {#if leg.headsign}<p class="detail-direction">
            Richtung {leg.headsign}
          </p>{/if}
        {#if leg.platform}<p class="detail-platform">
            Gleis / Steig {leg.platform}
          </p>{/if}
        {#each leg.viaStops ?? [] as visit}
          <p class="detail-place">
            Über {visit.stop.place.name} · {leg.transitStatus?.missingViaStops?.includes(
              visit.stop.id,
            )
              ? "Halt entfällt"
              : "Im Zug bleiben"}
          </p>
        {/each}
        <div class="detail-arrival">
          {#if example}<strong>Ausstieg</strong>
          {:else}<JourneyTransitTime
              {journey}
              {leg}
              event="arrival"
              {restored}
            />{/if}
          <p class="detail-place">{leg.to.name}</p>
          {#if leg.arrivalPlatform}<p class="detail-platform">
              Gleis / Steig {leg.arrivalPlatform}
            </p>{/if}
        </div>
        <small class="detail-meta">{duration(leg.end - leg.start)} Fahrt</small>
        {#if !example && !navigation}<small class="detail-source"
            >{restored
              ? "Gespeicherte Fahrplanangabe"
              : leg.realtime
                ? "Echtzeitdaten zum Zeitpunkt der Abfrage"
                : "Fahrplanzeit"}</small
          >{/if}
      {:else if preparation}
        <strong class="detail-heading">{kindNames[leg.kind]}</strong>
        <small class="detail-meta">{interval}</small>
        {#if !next || next.from.name !== leg.from.name}<p class="detail-place">
            {leg.from.name}
          </p>{/if}
      {:else if leg.kind === "stop"}
        <strong class="detail-heading">Zwischenziel: {leg.to.name}</strong>
        <small class="detail-meta"
          >{example
            ? duration(leg.end - leg.start)
            : `${start} – ${end}`}</small
        >
        <p class="detail-place">
          Geplanter Aufenthalt: {leg.stop?.stayMinutes ??
            Math.ceil((leg.end - leg.start) / 60)} min{example
            ? ""
            : ` · Weiterfahrt ${end}`}
        </p>
      {:else}
        <strong class="detail-heading"
          >{kindNames[leg.kind]} bis {leg.to.name}</strong
        >
        <small class="detail-meta">{interval}{movementDistance}</small>
        <p class="detail-place">Von {leg.from.name}</p>
      {/if}
    </div>
  {/if}
</li>
