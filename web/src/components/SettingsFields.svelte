<script lang="ts">
  import { untrack } from "svelte";
  import NumberField from "./NumberField.svelte";
  import { modes, type RoutingSettings, type ModePreference } from "../model";
  import type { SettingsValidation } from "../settings-validation";
  let {
    section,
    read,
    change,
    validation,
  }: {
    section: "basic" | "extra" | "optimization" | "modes";
    read: () => RoutingSettings;
    change: (value: RoutingSettings) => void;
    validation: SettingsValidation;
  } = $props();
  let excluded = $state(untrack(() => [...read().excludedTransitModes]));
  function toggleMode(mode: ModePreference, checked: boolean) {
    excluded = checked
      ? excluded.filter((value) => value !== mode)
      : [...excluded, mode];
    excluded = (Object.keys(modes) as ModePreference[]).filter((value) =>
      excluded.includes(value),
    );
    change({ ...read(), excludedTransitModes: [...excluded] });
  }
</script>

{#if section === "basic"}
  <NumberField
    field="cyclingSpeedKilometersPerHour"
    label="Radgeschwindigkeit"
    {read}
    {change}
    {validation}
  />
  <NumberField
    field="maxCyclingMinutes"
    label="Maximale Radzeit je Etappe"
    hint="Pro Radetappe. Falten, Entfalten und Umstiegszeit kommen hinzu."
    {read}
    {change}
    {validation}
  />
  <NumberField
    field="foldingDuration"
    label="Zeit je Falten / Entfalten"
    {read}
    {change}
    {validation}
  />
{:else if section === "extra"}
  <NumberField
    field="maxWalkingMinutes"
    label="Fußweg zur / von der Haltestelle"
    hint="Maximale Gehzeit je Weg zur ersten oder von der letzten Haltestelle. Fußwege beim Umsteigen können länger sein."
    {read}
    {change}
    {validation}
  />
  <NumberField
    field="transferMinutes"
    label="Umstiegszeit"
    hint="Zusätzliche Zeit bei jedem Umstieg, auch mit Rad zwischen Linien. Falten und Entfalten werden separat eingeplant."
    {read}
    {change}
    {validation}
  />
{:else if section === "optimization"}
  <NumberField
    field="maxBikeTransfers"
    label="Radverbindungen zwischen Linien"
    hint="Maximale Anzahl der Radverbindungen zwischen ÖPNV-Linien. Weniger Radverbindungen beschleunigen die Routenoptimierung. Bei 0 werden keine zusätzlichen Rad-Umstiege gesucht."
    {read}
    {change}
    {validation}
  />
  <label class="toggle-row"
    ><span
      >Fahrradvergleich anzeigen<small id="cycling-comparison-hint"
        >Zeigt zusätzlich die reine Radstrecke.</small
      ></span
    >
    <input
      type="checkbox"
      id="showCyclingComparison"
      role="switch"
      aria-describedby="cycling-comparison-hint"
      checked={read().showCyclingComparison}
      onchange={(event) =>
        change({
          ...read(),
          showCyclingComparison: event.currentTarget.checked,
        })}
    />
  </label>
{:else}
  {#each Object.entries(modes) as [key, mode] (key)}
    <label class="toggle-row"
      ><span>{mode.name}</span><input
        type="checkbox"
        data-mode={key}
        checked={!excluded.includes(key as ModePreference)}
        onchange={(event) =>
          toggleMode(key as ModePreference, event.currentTarget.checked)}
      /></label
    >
  {/each}
{/if}
