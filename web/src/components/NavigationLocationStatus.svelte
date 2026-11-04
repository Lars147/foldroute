<script lang="ts">
  import type { NavigationLocationStatus } from "../navigation-presentation";
  let status = $state.raw<NavigationLocationStatus>({
    primary: "",
    estimate: "",
  });
  export function update(value: NavigationLocationStatus) {
    status = value;
  }
</script>

<div
  id="navigation-gps-status"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  hidden={!status.primary}
>
  <strong id="navigation-gps-primary">{status.primary}</strong>
  <span id="navigation-gps-estimate" hidden={!status.estimate}
    >{status.estimate}</span
  >
</div>
