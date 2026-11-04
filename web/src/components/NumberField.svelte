<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ranges, type RoutingSettings } from "../model";
  import type { SettingsValidation } from "../settings-validation";
  let {
    field,
    label,
    hint = "",
    read,
    change,
    validation,
  }: {
    field: keyof typeof ranges;
    label: string;
    hint?: string;
    read: () => RoutingSettings;
    change: (value: RoutingSettings) => void;
    validation: SettingsValidation;
  } = $props();
  let input: HTMLInputElement;
  let row: HTMLLabelElement;
  let invalid = $state(false);
  let message = $state("");
  const divisor = $derived(field === "foldingDuration" ? 60 : 1);
  const unit = $derived(
    field === "cyclingSpeedKilometersPerHour"
      ? "km/h"
      : field === "maxBikeTransfers"
        ? ""
        : "min",
  );
  const hintId = $derived(
    field === "maxCyclingMinutes" ? "cycling-limit-hint" : `${field}-hint`,
  );
  onMount(() =>
    validation.bind(input, row, (state) => {
      // Native blur during teardown belongs to the external validation adapter.
      untrack(() => {
        invalid = state.invalid;
        message = state.message;
      });
    }),
  );
</script>

<label bind:this={row!} class="setting-row">
  <span
    >{label}{#if hint}<small id={hintId}>{hint}</small>{/if}</span
  >
  <span class="setting-value">
    <input
      bind:this={input!}
      type="number"
      id={field}
      required
      min={ranges[field][0] / divisor}
      max={ranges[field][1] / divisor}
      step={ranges[field][2] / divisor}
      value={read()[field] / divisor}
      aria-invalid={invalid}
      aria-describedby={[
        hint ? hintId : "",
        unit ? `${field}-unit` : "",
        `${field}-error`,
      ]
        .filter(Boolean)
        .join(" ")}
      oninput={() => {
        if (input.checkValidity())
          change({ ...read(), [field]: Number(input.value) * divisor });
      }}
    />
    <span class="setting-unit" id={`${field}-unit`}>{unit}</span>
  </span>
  <small class="setting-error" id={`${field}-error`} hidden={!invalid}
    >{message}</small
  >
</label>
