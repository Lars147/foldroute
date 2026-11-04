<script lang="ts">
  import { icon } from "../ui";
  let {
    name,
    class: className = "",
  }: { name: Parameters<typeof icon>[0]; class?: string } = $props();
</script>

<!-- icon() reads only the application's fixed SVG catalogue. -->
<span class={`icon${className ? ` ${className}` : ""}`} aria-hidden="true"
  >{@html icon(name).innerHTML}</span
>
