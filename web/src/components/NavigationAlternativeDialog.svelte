<script lang="ts">
  import type { NavigationAlternativeModel } from "../navigation-presentation";
  import RouteChoices from "./RouteChoices.svelte";
  import JourneyDetails from "./JourneyDetails.svelte";
  let { model }: { model: NavigationAlternativeModel } = $props();
</script>

<dialog
  id="navigation-alternative"
  data-proposal-id={model.id}
  aria-labelledby="navigation-alternative-title"
  aria-describedby="navigation-alternative-status"
>
  <header class="alternative-heading">
    {#if model.detailJourney}<button
        class="secondary"
        type="button"
        onclick={model.back}
        aria-label="Zurück zu Verbindungen">←</button
      >{/if}
    <h2 id="navigation-alternative-title" tabindex="-1">
      {model.detailJourney ? "Reiseablauf" : "Neue Verbindungen"}
    </h2>
    <button
      id="navigation-alternative-close"
      class="secondary"
      type="button"
      aria-label="Zurück zur Navigation">✕</button
    >
  </header>
  <div class="alternative-content">
    <div id="navigation-alternative-text">
      {#if model.detailJourney}
        <ol class="journey-legs">
          <JourneyDetails
            journey={model.detailJourney}
            restored={false}
            options={{ presentation: "live" }}
          />
        </ol>
      {:else if model.choices?.length}
        <RouteChoices
          journeys={model.choices.map((value) => value.journey)}
          selectedId={model.id}
          recommendedId={model.recommendedId}
          recommendation="Früheste Ankunft"
          restored={false}
          cyclingLimit={model.cyclingLimit ?? 30}
          example={false}
          inSheet={true}
          select={(journey) => model.select?.(journey.id)}
          details={(journey) => model.details?.(journey.id)}
        />
      {/if}
    </div>
    <p id="navigation-alternative-status" role="status">{model.status}</p>
    {#if model.error}<a class="location-help" href="hilfe.html#standort"
        >Hilfe zum Standort</a
      >{/if}
    <footer class="alternative-actions">
      {#if model.retry && !model.choices?.length && !model.needsLocation}<button
          id="navigation-alternative-retry"
          class="secondary"
          type="button"
          disabled={model.busy}
          onclick={model.retry}>Erneut suchen</button
        >{/if}
      <button
        id="navigation-alternative-locate"
        class="secondary"
        type="button"
        hidden={!model.needsLocation}
        disabled={model.busy || model.locating}>Standort erneut anfragen</button
      >
      <button
        id="navigation-accept"
        class="primary"
        type="button"
        disabled={model.busy || !model.available}
        >{model.busy
          ? "Verbindung wird geprüft …"
          : model.stale
            ? "Vorschläge aktualisieren"
            : "Verbindung übernehmen"}</button
      >
      <button
        id="navigation-dismiss"
        class="secondary"
        type="button"
        disabled={model.busy}>Bisherige behalten</button
      >
    </footer>
  </div>
</dialog>
