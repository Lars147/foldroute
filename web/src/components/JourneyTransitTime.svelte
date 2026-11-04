<script lang="ts">
  import type { Journey, Leg } from "../model";
  import { detailTransitTime } from "../journey-detail";
  let {
    journey,
    leg,
    event,
    restored,
  }: {
    journey: Journey;
    leg: Leg;
    event: "departure" | "arrival";
    restored: boolean;
  } = $props();
  const time = $derived(detailTransitTime(journey, leg, event));
  const departure = $derived(event === "departure");
</script>

<strong class={departure ? "detail-heading" : ""}
  >{departure
    ? `Ab ${time.time} · ${leg.line || "ÖPNV"}`
    : `${time.time} · Ausstieg`}{#if time.delay}<span class="sr-only">
      (laut Fahrplan)</span
    >{/if}</strong
>
{#if time.delay}
  <p class="detail-delay" data-event={event}>
    <span aria-hidden="true">{time.delay.time} · +{time.delay.minutes} min</span
    ><span class="sr-only"
      >{restored ? "Gespeicherte Prognose:" : "Voraussichtlich"}
      {departure ? "Abfahrt" : "Ankunft"}
      {time.delay.time}, {time.delay.minutes} Minuten Verspätung.</span
    >
  </p>
{/if}
