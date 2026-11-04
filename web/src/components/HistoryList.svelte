<script lang="ts">
  import Icon from "./Icon.svelte";
  import { historySnapshot, type HistoryEntry } from "../offline";
  import { historyPlannedAt } from "../ui";
  let {
    entries,
    online,
    open,
    remove,
  }: {
    entries: readonly HistoryEntry[];
    online: boolean;
    open: (entry: HistoryEntry) => void;
    remove: (id: string) => void;
  } = $props();
</script>

{#each entries as entry (entry.id)}
  {@const snapshot = historySnapshot(entry)}
  {@const journey = snapshot.journey}
  {@const request = snapshot.request}
  {@const origin =
    journey.origin.name === "Aktueller Standort"
      ? "Startpunkt"
      : journey.origin.name}
  {@const description = `Von ${origin} nach ${journey.destination.name}${request.stops?.length ? `, über ${request.stops.map((stop) => stop.place.name).join(", ")}` : ""}`}
  <li class="history-row" data-history-id={entry.id}>
    <button
      class="history-open"
      type="button"
      aria-label={`${online ? "Strecke erneut planen" : "Gespeicherten Stand ansehen"}: ${description}`}
      aria-describedby={`history-time-${entry.id}`}
      onclick={() => open(entry)}
    >
      <span class="history-origin"
        ><span class="route-origin-marker" aria-hidden="true"></span><span
          >{origin}</span
        ></span
      >
      <strong class="history-destination"
        ><Icon name="flag" /><span>{journey.destination.name}</span></strong
      >
      {#if request.stops?.length}<small class="history-via"
          >Über {request.stops
            .map((stop) => stop.place.name)
            .join(" · ")}</small
        >{/if}
      <time
        class="history-timestamp"
        id={`history-time-${entry.id}`}
        datetime={new Date(entry.snapshot.savedAt * 1000).toISOString()}
        >{historyPlannedAt(entry.snapshot.savedAt)}</time
      >
      <Icon name="chevron" class="history-chevron" />
    </button>
    <button
      class="history-remove"
      title="Strecke löschen"
      type="button"
      aria-label={`Strecke löschen: ${description}`}
      onclick={() => remove(entry.id)}
    >
      <Icon name="trash" /><span class="history-remove-label">Löschen</span>
    </button>
  </li>
{/each}
