<script lang="ts">
  import type { NavigationFinishSummary } from "../navigation-presentation";
  let summary = $state.raw<NavigationFinishSummary>({
    visible: false,
    providers: [],
    origin: "",
    destination: "",
    time: "",
    distance: "",
    sinceResume: false,
    status: "",
  });
  export function update(value: NavigationFinishSummary) {
    summary = value;
  }
</script>

<div id="navigation-finish" hidden={!summary.visible}>
  <div class="navigation-finish-content" id="navigation-finish-content">
    <div class="navigation-finish-trip">
      <header class="navigation-finish-header">
        <span class="navigation-finish-mark" aria-hidden="true"
          ><svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            focusable="false"><path d="m5 12 4 4L19 6" /></svg
          ></span
        >
        <div>
          <h1 id="navigation-finish-heading" tabindex="-1">Ziel erreicht</h1>
          <p id="navigation-finish-route">
            <span id="navigation-finish-origin">{summary.origin}</span><span
              aria-hidden="true"
            >
              →
            </span><span class="sr-only"> nach </span><span
              id="navigation-finish-destination">{summary.destination}</span
            >
          </p>
        </div>
      </header>
      <dl class="navigation-finish-metrics" aria-label="Diese Fahrt">
        <div>
          <dt>Unterwegs</dt>
          <dd id="navigation-finish-time">{summary.time}</dd>
        </div>
        <div>
          <dt>Routenlänge</dt>
          <dd id="navigation-finish-distance">{summary.distance}</dd>
        </div>
      </dl>
      <p id="navigation-finish-resumed" hidden={!summary.sinceResume}>
        Zeit und Strecke seit Wiederaufnahme erfasst.
      </p>
    </div>
    <section
      id="navigation-finish-totals"
      aria-labelledby="navigation-finish-totals-heading"
      hidden={!summary.totals}
    >
      <h2 id="navigation-finish-totals-heading">Deine Wege mit FoldRoute</h2>
      <dl class="navigation-finish-metrics navigation-finish-overall">
        <div>
          <dt>Fahrten</dt>
          <dd id="navigation-finish-count">{summary.totals?.count ?? ""}</dd>
        </div>
        <div>
          <dt>Strecke</dt>
          <dd id="navigation-finish-total-distance">
            {summary.totals?.distance ?? ""}
          </dd>
        </div>
        <div>
          <dt>Zeit</dt>
          <dd id="navigation-finish-total-time">
            {summary.totals?.time ?? ""}
          </dd>
        </div>
      </dl>
    </section>
    <p id="navigation-finish-storage" role="status">{summary.status}</p>
    <nav
      id="navigation-support"
      aria-label="FoldRoute unterstützen"
      hidden={!summary.providers.length}
    >
      <div id="navigation-support-links">
        {#each summary.providers as provider}
          <a
            href={provider.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={provider.label === provider.name
              ? `Über ${provider.name} unterstützen`
              : `${provider.label} (über ${provider.name})`}
            >{provider.label}<span aria-hidden="true">↗</span></a
          >
        {/each}
      </div>
    </nav>
  </div>
  <div class="navigation-finish-actions">
    <button id="navigation-finish-close" class="primary" type="button"
      >Fahrt abschließen</button
    >
  </div>
</div>
