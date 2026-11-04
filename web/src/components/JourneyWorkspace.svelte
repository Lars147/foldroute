<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import PlanningToast from "./PlanningToast.svelte";
  import RetryCountdownText from "./RetryCountdownText.svelte";
  import RouteChoices from "./RouteChoices.svelte";
  import RouteSummary from "./RouteSummary.svelte";
  import JourneyDetails from "./JourneyDetails.svelte";
  import MapStylePicker from "./MapStylePicker.svelte";
  import type {
    WorkspaceChoices,
    WorkspaceDetail,
    WorkspaceLayout,
    WorkspaceToast,
    WorkspaceTextId,
  } from "../journey-workspace-presentation";
  import type { Journey, RouteStop } from "../model";
  let {
    rootToastChanged,
  }: { rootToastChanged(value: Snippet | undefined): void } = $props();
  onMount(() => {
    rootToastChanged(root_toast);
    return () => untrack(() => rootToastChanged(undefined));
  });
  let startNoticeHelp = $state(false);
  export function updateStartNotice(message: string, help: boolean) {
    text["navigation-start-notice"] = message;
    startNoticeHelp = !!message && help;
  }
  let start = $state({ checking: false, restored: false });
  export function updateStart(checking: boolean, restored: boolean) {
    start = { checking, restored };
  }
  let choices = $state.raw<WorkspaceChoices | undefined>();
  let summary = $state.raw<
    { journey: Journey; cyclingLimit: number; example: boolean } | undefined
  >();
  let detail = $state.raw<WorkspaceDetail | undefined>();
  export function updateChoices(value: WorkspaceChoices) {
    choices = value;
  }
  export function updateSummary(value?: typeof summary) {
    summary = value;
  }
  export function updateDetail(value?: WorkspaceDetail) {
    detail = value;
  }

  let toastModel = $state.raw<WorkspaceToast>({ visible: false, message: "" });
  let toastPlacement = $state<"root" | "sheet" | "inline">("root");
  let toastStyles = $state<Record<string, string>>({});
  let mapToast = $state(false);
  let recoveryToast = $state(false);
  export function updateToast(value: WorkspaceToast) {
    toastModel = value;
  }
  export function setToastVisible(value: boolean) {
    toastModel = { ...toastModel, visible: value };
  }
  export function setToastRetryAt(value: number) {
    toastModel = { ...toastModel, retryAt: value };
  }
  export function setToastPlacement(value: typeof toastPlacement) {
    toastPlacement = value;
  }
  export function setToastMap(value: boolean) {
    mapToast = value;
  }
  export function setToastStyle(name: string, value: string) {
    toastStyles[name] = value;
  }
  export function setRecoveryToast(value: boolean) {
    recoveryToast = value;
  }
  let retryAt = $state<Record<string, number>>({});
  let stops = $state.raw<readonly RouteStop[]>([]);
  export function updateStops(value: readonly RouteStop[]) {
    stops = value;
  }
  export function setRetryAt(id: string, value: number) {
    retryAt[id] = value;
  }
  let text = $state<Record<string, string>>({});
  let hidden = $state<Record<string, boolean>>({});
  let inert = $state<Record<string, boolean>>({});
  let disabled = $state<Record<string, boolean>>({});
  let attributes = $state<Record<string, Record<string, string | undefined>>>(
    {},
  );
  let classes = $state<Record<string, string>>({});
  let flags = $state<Record<string, Record<string, boolean>>>({});
  let commands = $state.raw<Record<string, (event: MouseEvent) => void>>({});
  function command(id: string) {
    return (event: MouseEvent) => commands[id]?.(event);
  }
  function classValue(id: string, fallback: string) {
    return [
      classes[id] ?? fallback,
      ...Object.entries(flags[id] ?? {})
        .filter(([, value]) => value)
        .map(([key]) => key),
    ]
      .filter(Boolean)
      .join(" ");
  }
  export function setText(
    id: WorkspaceTextId,
    value: string | null | undefined,
  ) {
    text[id] = value ?? "";
    return value;
  }
  export function setHidden(id: string, value: boolean) {
    hidden[id] = value;
    return value;
  }
  export function setInert(id: string, value: boolean) {
    inert[id] = value;
    return value;
  }
  export function setDisabled(id: string, value: boolean) {
    disabled[id] = value;
    return value;
  }
  export function setClass(id: string, value: string) {
    classes[id] = value;
    return value;
  }
  export function toggleClass(id: string, name: string, value: boolean) {
    flags[id] = { ...flags[id], [name]: value };
  }
  export function setAttribute(
    id: string,
    name: string,
    value: string | undefined,
  ) {
    attributes[id] = { ...attributes[id], [name]: value };
  }
  export function setCommand(id: string, command: (event: MouseEvent) => void) {
    commands = { ...commands, [id]: command };
  }

  let layout = $state<WorkspaceLayout>({
    desktop: matchMedia("(min-width: 900px)").matches,
    requestPreview: false,
    restored: false,
    example: false,
  });
  export function updateLayout(value: WorkspaceLayout) {
    layout = value;
  }
  function placement(
    id: string,
  ): "desktop" | "sheet" | "map" | "search" | "actions" | "more" | "toast" {
    const sheet = layout.sheetMode;
    if (id === "planning-recovery" && recoveryToast) return "toast";
    if (id === "result-nav") return layout.desktop ? "desktop" : "actions";
    if (id === "navigation-start")
      return layout.restored ? "more" : layout.desktop ? "desktop" : "actions";
    if (id === "replan-saved")
      return layout.restored && !layout.desktop ? "actions" : "desktop";
    if (id === "example-plan-own")
      return layout.desktop ? "desktop" : "actions";
    if (
      [
        "choices",
        "panel-details",
        "status",
        "saved-notice",
        "stale-notice",
      ].includes(id)
    ) {
      if (
        sheet &&
        (sheet !== "detail" ||
          ["panel-details", "saved-notice", "stale-notice"].includes(id))
      )
        return "sheet";
      return "desktop";
    }
    if (
      sheet &&
      sheet !== "detail" &&
      [
        "issues",
        "map-error",
        "late-departure",
        "cycling-comparison",
        "planning-recovery",
      ].includes(id)
    )
      return "sheet";
    if (
      layout.requestPreview &&
      ["planning-recovery", "map-error"].includes(id)
    )
      return "search";
    return layout.desktop ? "desktop" : "map";
  }
</script>

<section
  id="map-view"
  class={classValue("map-view", "map-screen")}
  aria-label="Reiseübersicht"
  hidden={hidden["map-view"] ?? true}
  inert={inert["map-view"] ?? false}
  {...attributes["map-view"]}
>
  <div
    id="map"
    aria-label="Routenkarte"
    hidden={hidden["map"] ?? false}
    inert={inert["map"] ?? false}
    class={classValue("map", "")}
    {...attributes["map"]}
  ></div>
  <div
    id="map-controls"
    class={classValue("map-controls", "map-controls")}
    role="group"
    aria-label="Kartensteuerung"
    hidden={hidden["map-controls"] ?? false}
    inert={inert["map-controls"] ?? false}
    {...attributes["map-controls"]}
  >
    <button
      id="map-location"
      class={classValue("map-location", "map-location icon-button")}
      aria-label="Karte auf aktuellen Standort zentrieren"
      data-icon="location"
      hidden={hidden["map-location"] ?? false}
      inert={inert["map-location"] ?? false}
      disabled={disabled["map-location"] ?? false}
      {...attributes["map-location"]}
      onclick={command("map-location")}><Icon name="location" /></button
    >
    <button
      id="map-route"
      class={classValue("map-route", "map-location map-route icon-button")}
      type="button"
      aria-label="Gesamte Route anzeigen"
      title="Gesamte Route anzeigen"
      data-icon="fit-route"
      hidden={hidden["map-route"] ?? true}
      inert={inert["map-route"] ?? false}
      disabled={disabled["map-route"] ?? false}
      {...attributes["map-route"]}
      onclick={command("map-route")}><Icon name="fit-route" /></button
    >
    <div
      id="map-style-control"
      class={classValue("map-style-control", "map-style-control")}
      hidden={hidden["map-style-control"] ?? false}
      inert={inert["map-style-control"] ?? false}
      {...attributes["map-style-control"]}
    >
      <MapStylePicker id="overview" />
    </div>
    <div
      id="map-zoom-control"
      class={classValue("map-zoom-control", "map-zoom-control")}
      role="group"
      aria-label="Zoom"
      hidden={hidden["map-zoom-control"] ?? false}
      inert={inert["map-zoom-control"] ?? false}
      {...attributes["map-zoom-control"]}
    ></div>
  </div>
  <div class="map-credit">
    <span
      id="map-label"
      hidden={hidden["map-label"] ?? false}
      inert={inert["map-label"] ?? false}
      class={classValue("map-label", "")}
      {...attributes["map-label"]}
      ><a href="https://openmaptiles.org/">© OpenMapTiles</a> ·
      <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a
      ></span
    >
  </div>
  <article
    id="journey-panel"
    class={classValue("journey-panel", "journey-panel")}
    aria-label="Verbindungen und Reiseablauf"
    hidden={hidden["journey-panel"] ?? false}
    inert={inert["journey-panel"] ?? false}
    {...attributes["journey-panel"]}
  >
    <header
      id="result-header"
      hidden={hidden["result-header"] ?? false}
      inert={inert["result-header"] ?? false}
      class={classValue("result-header", "")}
      {...attributes["result-header"]}
    >
      <div class="planning-context">
        <h1
          id="result-context"
          class={classValue("result-context", "sr-only")}
          tabindex="-1"
          hidden={hidden["result-context"] ?? false}
          inert={inert["result-context"] ?? false}
          {...attributes["result-context"]}
        >
          {text["result-context"] ?? "Verbindungen"}
        </h1>
        <div class="panel-tools">
          {#if layout.example}<div class="route-request example-route-request">
              {@render request_places()}
            </div>{/if}
          <button
            id="adjust-route"
            class={classValue("adjust-route", "route-request")}
            type="button"
            aria-label="Route anpassen"
            aria-describedby="route-origin route-request-stops route-destination route-request-meta"
            hidden={hidden["adjust-route"] ?? false}
            inert={inert["adjust-route"] ?? false}
            disabled={disabled["adjust-route"] ?? false}
            {...attributes["adjust-route"]}
            onclick={command("adjust-route")}
            >{#if !layout.example}{@render request_places()}{/if}</button
          >
          <div class="panel-tool-actions">
            <button
              id="route-more"
              class={classValue("route-more", "icon-button")}
              type="button"
              aria-label="Weitere Routenaktionen"
              aria-haspopup="dialog"
              aria-controls="route-actions-dialog"
              data-icon="more"
              hidden={hidden["route-more"] ?? false}
              inert={inert["route-more"] ?? false}
              disabled={disabled["route-more"] ?? false}
              {...attributes["route-more"]}
              onclick={command("route-more")}><Icon name="more" /></button
            >
            <button
              id="close-route"
              class={classValue("close-route", "icon-button")}
              type="button"
              aria-label="Route schließen"
              data-icon="close"
              hidden={hidden["close-route"] ?? false}
              inert={inert["close-route"] ?? false}
              disabled={disabled["close-route"] ?? false}
              {...attributes["close-route"]}
              onclick={command("close-route")}><Icon name="close" /></button
            >
          </div>
        </div>
        <div
          id="planning-context-footer"
          class={classValue(
            "planning-context-footer",
            "planning-context-footer",
          )}
          hidden={hidden["planning-context-footer"] ?? false}
          inert={inert["planning-context-footer"] ?? false}
          {...attributes["planning-context-footer"]}
        >
          <div class="planning-context-meta">
            <span
              id="route-request-meta"
              hidden={hidden["route-request-meta"] ?? false}
              inert={inert["route-request-meta"] ?? false}
              class={classValue("route-request-meta", "")}
              {...attributes["route-request-meta"]}
              >{text["route-request-meta"] ?? ""}</span
            >
            <div
              id="result-freshness"
              hidden={hidden["result-freshness"] ?? false}
              inert={inert["result-freshness"] ?? false}
              class={classValue("result-freshness", "")}
              {...attributes["result-freshness"]}
            >
              <span
                id="result-stand"
                hidden={hidden["result-stand"] ?? false}
                inert={inert["result-stand"] ?? false}
                class={classValue("result-stand", "")}
                {...attributes["result-stand"]}
                >{text["result-stand"] ?? ""}</span
              >
            </div>
          </div>
        </div>
        <p
          id="map-request-meta"
          hidden={hidden["map-request-meta"] ?? true}
          inert={inert["map-request-meta"] ?? false}
          class={classValue("map-request-meta", "")}
          {...attributes["map-request-meta"]}
        >
          {text["map-request-meta"] ?? ""}
        </p>
      </div>
      <div
        id="search-preview"
        hidden={hidden["search-preview"] ?? true}
        inert={inert["search-preview"] ?? false}
        class={classValue("search-preview", "")}
        {...attributes["search-preview"]}
      >
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2
            id="search-preview-heading"
            tabindex="-1"
            hidden={hidden["search-preview-heading"] ?? false}
            inert={inert["search-preview-heading"] ?? false}
            class={classValue("search-preview-heading", "")}
            {...attributes["search-preview-heading"]}
          >
            <span
              id="search-preview-spinner"
              aria-hidden="true"
              hidden={hidden["search-preview-spinner"] ?? false}
              inert={inert["search-preview-spinner"] ?? false}
              class={classValue("search-preview-spinner", "")}
              {...attributes["search-preview-spinner"]}
            ></span>
            <span
              id="search-preview-title"
              hidden={hidden["search-preview-title"] ?? false}
              inert={inert["search-preview-title"] ?? false}
              class={classValue("search-preview-title", "")}
              {...attributes["search-preview-title"]}
              >{text["search-preview-title"] ?? ""}</span
            >
          </h2>
          <p
            id="search-preview-detail"
            hidden={hidden["search-preview-detail"] ?? false}
            inert={inert["search-preview-detail"] ?? false}
            class={classValue("search-preview-detail", "")}
            {...attributes["search-preview-detail"]}
          >
            {text["search-preview-detail"] ?? ""}<RetryCountdownText
              until={retryAt["search-preview-detail"] ?? 0}
            />
          </p>
          <div class="search-preview-hint-slot">
            <p
              id="search-preview-hint-reserve"
              aria-hidden="true"
              hidden={hidden["search-preview-hint-reserve"] ?? false}
              inert={inert["search-preview-hint-reserve"] ?? false}
              class={classValue("search-preview-hint-reserve", "")}
              {...attributes["search-preview-hint-reserve"]}
            >
              {text["search-preview-hint-reserve"] ?? ""}
            </p>
            <p
              id="search-preview-hint"
              hidden={hidden["search-preview-hint"] ?? true}
              inert={inert["search-preview-hint"] ?? false}
              class={classValue("search-preview-hint", "")}
              {...attributes["search-preview-hint"]}
            >
              {text["search-preview-hint"] ?? ""}
            </p>
          </div>
        </div>
        <div
          id="search-preview-feedback"
          hidden={hidden["search-preview-feedback"] ?? false}
          inert={inert["search-preview-feedback"] ?? false}
          class={classValue("search-preview-feedback", "")}
          {...attributes["search-preview-feedback"]}
        >
          {#if placement("planning-recovery") === "search"}{@render planning_recovery()}{/if}
          {#if placement("map-error") === "search"}{@render map_error()}{/if}
        </div>
      </div>
      <div
        id="map-preview"
        hidden={hidden["map-preview"] ?? true}
        inert={inert["map-preview"] ?? false}
        class={classValue("map-preview", "")}
        {...attributes["map-preview"]}
      >
        <div class="map-preview-heading">
          <h2
            id="map-preview-heading"
            tabindex="-1"
            hidden={hidden["map-preview-heading"] ?? false}
            inert={inert["map-preview-heading"] ?? false}
            class={classValue("map-preview-heading", "")}
            {...attributes["map-preview-heading"]}
          >
            {text["map-preview-heading"] ?? ""}
          </h2>
          <button
            id="map-open-details"
            class={classValue("map-open-details", "text-button")}
            type="button"
            aria-haspopup="dialog"
            aria-controls="alternatives-dialog"
            aria-expanded="false"
            hidden={hidden["map-open-details"] ?? false}
            inert={inert["map-open-details"] ?? false}
            disabled={disabled["map-open-details"] ?? false}
            {...attributes["map-open-details"]}
            onclick={command("map-open-details")}
          >
            Details <span aria-hidden="true">›</span>
          </button>
        </div>
        <div
          id="map-preview-summary"
          class={classValue("map-preview-summary", "route-summary")}
          hidden={hidden["map-preview-summary"] ?? false}
          inert={inert["map-preview-summary"] ?? false}
          {...attributes["map-preview-summary"]}
        >
          {#if summary}<RouteSummary {...summary} />{/if}
        </div>
        <div
          id="map-preview-feedback"
          hidden={hidden["map-preview-feedback"] ?? false}
          inert={inert["map-preview-feedback"] ?? false}
          class={classValue("map-preview-feedback", "")}
          {...attributes["map-preview-feedback"]}
        >
          <p
            id="map-preview-status"
            role="status"
            tabindex="-1"
            hidden={hidden["map-preview-status"] ?? true}
            inert={inert["map-preview-status"] ?? false}
            class={classValue("map-preview-status", "")}
            {...attributes["map-preview-status"]}
          >
            {text["map-preview-status"] ?? ""}<RetryCountdownText
              until={retryAt["map-preview-status"] ?? 0}
            />
          </p>

          {#if placement("planning-recovery") === "map"}{@render planning_recovery()}{/if}
          {#if placement("issues") === "map"}{@render issues()}{/if}
          {#if placement("late-departure") === "map"}{@render late_departure()}{/if}
          {#if placement("cycling-comparison") === "map"}{@render cycling_comparison()}{/if}
          {#if placement("map-error") === "map"}{@render map_error()}{/if}
          {#if placement("navigation-start-notice") === "map"}{@render navigation_start_notice()}{/if}
          {#if placement("navigation-start-recovery") === "map"}{@render navigation_start_recovery()}{/if}
        </div>
        <div
          id="map-preview-actions"
          hidden={hidden["map-preview-actions"] ?? false}
          inert={inert["map-preview-actions"] ?? false}
          class={classValue("map-preview-actions", "")}
          {...attributes["map-preview-actions"]}
        >
          {#if placement("result-nav") === "actions"}{@render result_nav()}{/if}
          {#if placement("navigation-start") === "actions"}{@render navigation_start()}{/if}
          {#if placement("replan-saved") === "actions"}{@render replan_saved()}{/if}
          {#if placement("example-plan-own") === "actions"}{@render example_plan_own()}{/if}
        </div>
      </div>
    </header>
    {#if layout.desktop}{@render result_nav()}{/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Independent scroll region must be reachable by keyboard.) -->
    <div
      role="region"
      id="panel-content"
      class={classValue("panel-content", "panel-content")}
      tabindex="0"
      aria-label="Reiseinformationen"
      hidden={hidden["panel-content"] ?? false}
      inert={inert["panel-content"] ?? false}
      {...attributes["panel-content"]}
    >
      <label
        id="plan-link-fallback"
        class={classValue("plan-link-fallback", "plan-link-actions")}
        hidden={hidden["plan-link-fallback"] ?? true}
        inert={inert["plan-link-fallback"] ?? false}
        {...attributes["plan-link-fallback"]}
      >
        Link zum Kopieren
        <input
          id="plan-link-value"
          type="text"
          readonly
          aria-label="Planungslink"
          hidden={hidden["plan-link-value"] ?? false}
          inert={inert["plan-link-value"] ?? false}
          disabled={disabled["plan-link-value"] ?? false}
          class={classValue("plan-link-value", "")}
          {...attributes["plan-link-value"]}
        />
      </label>
      <div
        id="planning-feedback-slot"
        hidden={hidden["planning-feedback-slot"] ?? false}
        inert={inert["planning-feedback-slot"] ?? false}
        class={classValue("planning-feedback-slot", "")}
        {...attributes["planning-feedback-slot"]}
      >
        {#if toastPlacement === "inline"}{@render toast_content()}{/if}
      </div>
      {#if placement("status") === "desktop"}{@render status()}{/if}
      {#if placement("issues") === "desktop"}{@render issues()}{/if}
      {#if placement("saved-notice") === "desktop"}{@render saved_notice()}{/if}
      {#if placement("stale-notice") === "desktop"}{@render stale_notice()}{/if}
      {#if placement("planning-recovery") === "desktop"}{@render planning_recovery()}{/if}
      {#if placement("choices") === "desktop"}{@render choices_content()}{/if}
      {#if placement("late-departure") === "desktop"}{@render late_departure()}{/if}
      {#if placement("map-error") === "desktop"}{@render map_error()}{/if}
      {#if placement("cycling-comparison") === "desktop"}{@render cycling_comparison()}{/if}
      {#if placement("panel-details") === "desktop"}{@render panel_details()}{/if}
    </div>
    <div
      id="panel-actions"
      class="panel-actions"
      hidden={hidden["panel-actions"] ?? true}
    >
      {#if placement("navigation-start-notice") === "desktop"}{@render navigation_start_notice()}{/if}
      {#if placement("navigation-start-recovery") === "desktop"}{@render navigation_start_recovery()}{/if}
      <div
        id="route-start-summary"
        aria-live="polite"
        hidden={hidden["route-start-summary"] ?? false}
        inert={inert["route-start-summary"] ?? false}
        class={classValue("route-start-summary", "")}
        {...attributes["route-start-summary"]}
      >
        <strong
          id="route-start-arrival"
          hidden={hidden["route-start-arrival"] ?? false}
          inert={inert["route-start-arrival"] ?? false}
          class={classValue("route-start-arrival", "")}
          {...attributes["route-start-arrival"]}
          >{text["route-start-arrival"] ?? ""}</strong
        ><span
          id="route-start-duration"
          hidden={hidden["route-start-duration"] ?? false}
          inert={inert["route-start-duration"] ?? false}
          class={classValue("route-start-duration", "")}
          {...attributes["route-start-duration"]}
          >{text["route-start-duration"] ?? ""}</span
        >
      </div>
      {#if placement("navigation-start") === "desktop"}{@render navigation_start()}{/if}
      {#if placement("replan-saved") === "desktop"}{@render replan_saved()}{/if}
      {#if placement("example-plan-own") === "desktop"}{@render example_plan_own()}{/if}
    </div>
  </article>
</section>
<dialog
  id="alternatives-dialog"
  aria-labelledby="alternatives-title"
  closedby="closerequest"
  hidden={hidden["alternatives-dialog"] ?? false}
  inert={inert["alternatives-dialog"] ?? false}
  class={classValue("alternatives-dialog", "")}
  {...attributes["alternatives-dialog"]}
>
  <header class="alternatives-header">
    <button
      id="alternatives-back"
      class={classValue("alternatives-back", "icon-button")}
      type="button"
      aria-label="Zurück zu den Alternativen"
      hidden={hidden["alternatives-back"] ?? true}
      inert={inert["alternatives-back"] ?? false}
      disabled={disabled["alternatives-back"] ?? false}
      {...attributes["alternatives-back"]}
      onclick={command("alternatives-back")}
    >
      <span data-icon="chevron" aria-hidden="true"><Icon name="chevron" /></span
      >
    </button>
    <h2
      id="alternatives-title"
      tabindex="-1"
      hidden={hidden["alternatives-title"] ?? false}
      inert={inert["alternatives-title"] ?? false}
      class={classValue("alternatives-title", "")}
      {...attributes["alternatives-title"]}
    >
      {text["alternatives-title"] ?? "Alternativen"}
    </h2>
    <button
      id="alternatives-close"
      class={classValue("alternatives-close", "icon-button")}
      type="button"
      aria-label="Alternativen schließen"
      hidden={hidden["alternatives-close"] ?? false}
      inert={inert["alternatives-close"] ?? false}
      disabled={disabled["alternatives-close"] ?? false}
      {...attributes["alternatives-close"]}
      onclick={command("alternatives-close")}
    >
      <span data-icon="close" aria-hidden="true"><Icon name="close" /></span>
    </button>
  </header>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Modal scroll region must be reachable by keyboard.) -->
  <div
    role="region"
    id="alternatives-body"
    tabindex="0"
    aria-label="Verbindungen und Reiseablauf"
    hidden={hidden["alternatives-body"] ?? false}
    inert={inert["alternatives-body"] ?? false}
    class={classValue("alternatives-body", "")}
    {...attributes["alternatives-body"]}
  >
    <div
      id="alternatives-feedback-slot"
      hidden={hidden["alternatives-feedback-slot"] ?? false}
      inert={inert["alternatives-feedback-slot"] ?? false}
      class={classValue("alternatives-feedback-slot", "")}
      {...attributes["alternatives-feedback-slot"]}
    >
      {#if toastPlacement === "sheet"}{@render toast_content()}{/if}
    </div>
    {#if placement("status") === "sheet"}{@render status()}{/if}
    {#if placement("saved-notice") === "sheet"}{@render saved_notice()}{/if}
    {#if placement("stale-notice") === "sheet"}{@render stale_notice()}{/if}
    {#if placement("issues") === "sheet"}{@render issues()}{/if}
    {#if placement("planning-recovery") === "sheet"}{@render planning_recovery()}{/if}
    {#if placement("map-error") === "sheet"}{@render map_error()}{/if}
    {#if placement("late-departure") === "sheet"}{@render late_departure()}{/if}
    {#if placement("cycling-comparison") === "sheet"}{@render cycling_comparison()}{/if}
    {#if placement("choices") === "sheet"}{@render choices_content()}{/if}
    {#if placement("panel-details") === "sheet"}{@render panel_details()}{/if}
  </div>
  <footer
    id="alternatives-footer"
    hidden={hidden["alternatives-footer"] ?? true}
    inert={inert["alternatives-footer"] ?? false}
    class={classValue("alternatives-footer", "")}
    {...attributes["alternatives-footer"]}
  >
    <button
      id="alternatives-select"
      class={classValue("alternatives-select", "primary")}
      type="button"
      hidden={hidden["alternatives-select"] ?? false}
      inert={inert["alternatives-select"] ?? false}
      disabled={disabled["alternatives-select"] ?? false}
      {...attributes["alternatives-select"]}
      onclick={command("alternatives-select")}
    >
      Verbindung auswählen
    </button>
  </footer>
  <span
    id="alternatives-announcement"
    class={classValue("alternatives-announcement", "sr-only")}
    role="status"
    aria-live="polite"
    hidden={hidden["alternatives-announcement"] ?? false}
    inert={inert["alternatives-announcement"] ?? false}
    {...attributes["alternatives-announcement"]}
    >{text["alternatives-announcement"] ?? ""}</span
  >
</dialog>
<dialog
  id="route-actions-dialog"
  aria-labelledby="route-actions-title"
  hidden={hidden["route-actions-dialog"] ?? false}
  inert={inert["route-actions-dialog"] ?? false}
  class={classValue("route-actions-dialog", "")}
  {...attributes["route-actions-dialog"]}
>
  {#if placement("navigation-start") === "more"}{@render navigation_start()}{/if}
  <h2
    id="route-actions-title"
    hidden={hidden["route-actions-title"] ?? false}
    inert={inert["route-actions-title"] ?? false}
    class={classValue("route-actions-title", "")}
    {...attributes["route-actions-title"]}
  >
    Routenaktionen
  </h2>
  <dl
    id="route-action-context"
    hidden={hidden["route-action-context"] ?? false}
    inert={inert["route-action-context"] ?? false}
    class={classValue("route-action-context", "")}
    {...attributes["route-action-context"]}
  >
    <div>
      <dt>Start</dt>
      <dd
        id="route-action-origin"
        hidden={hidden["route-action-origin"] ?? false}
        inert={inert["route-action-origin"] ?? false}
        class={classValue("route-action-origin", "")}
        {...attributes["route-action-origin"]}
      >
        {text["route-action-origin"] ?? ""}
      </dd>
    </div>
    <div>
      <dt>Ziel</dt>
      <dd
        id="route-action-destination"
        hidden={hidden["route-action-destination"] ?? false}
        inert={inert["route-action-destination"] ?? false}
        class={classValue("route-action-destination", "")}
        {...attributes["route-action-destination"]}
      >
        {text["route-action-destination"] ?? ""}
      </dd>
    </div>
    <div>
      <dt>Zeitvorgabe</dt>
      <dd
        id="route-action-time"
        hidden={hidden["route-action-time"] ?? false}
        inert={inert["route-action-time"] ?? false}
        class={classValue("route-action-time", "")}
        {...attributes["route-action-time"]}
      >
        {text["route-action-time"] ?? ""}
      </dd>
    </div>
    <div
      id="route-action-stops-row"
      hidden={hidden["route-action-stops-row"] ?? true}
      inert={inert["route-action-stops-row"] ?? false}
      class={classValue("route-action-stops-row", "")}
      {...attributes["route-action-stops-row"]}
    >
      <dt>Zwischenstopps</dt>
      <dd
        id="route-action-stops"
        hidden={hidden["route-action-stops"] ?? false}
        inert={inert["route-action-stops"] ?? false}
        class={classValue("route-action-stops", "")}
        {...attributes["route-action-stops"]}
      >
        {text["route-action-stops"] ?? ""}
      </dd>
    </div>
  </dl>
  <p
    id="route-action-stand"
    hidden={hidden["route-action-stand"] ?? false}
    inert={inert["route-action-stand"] ?? false}
    class={classValue("route-action-stand", "")}
    {...attributes["route-action-stand"]}
  >
    {text["route-action-stand"] ?? ""}
  </p>
  <button
    id="share-plan"
    type="button"
    class={classValue("share-plan", "secondary")}
    hidden={hidden["share-plan"] ?? true}
    inert={inert["share-plan"] ?? false}
    disabled={disabled["share-plan"] ?? false}
    {...attributes["share-plan"]}
    onclick={command("share-plan")}
  >
    Planung teilen
  </button>
  <button
    id="refresh-route"
    type="button"
    class={classValue("refresh-route", "secondary")}
    hidden={hidden["refresh-route"] ?? false}
    inert={inert["refresh-route"] ?? false}
    disabled={disabled["refresh-route"] ?? false}
    {...attributes["refresh-route"]}
    onclick={command("refresh-route")}
    >{text["refresh-route"] ?? "Aktualisieren"}</button
  >

  <button
    id="route-actions-close"
    type="button"
    class={classValue("route-actions-close", "secondary")}
    hidden={hidden["route-actions-close"] ?? false}
    inert={inert["route-actions-close"] ?? false}
    disabled={disabled["route-actions-close"] ?? false}
    {...attributes["route-actions-close"]}
    onclick={command("route-actions-close")}
  >
    Schließen
  </button>
</dialog>
{#snippet result_nav()}<div
    id="result-nav"
    class={classValue("result-nav", "result-nav")}
    hidden={hidden["result-nav"] ?? false}
    inert={inert["result-nav"] ?? false}
    {...attributes["result-nav"]}
  >
    <button
      id="result-back"
      class={classValue("result-back", "text-button")}
      type="button"
      hidden={hidden["result-back"] ?? true}
      inert={inert["result-back"] ?? false}
      disabled={disabled["result-back"] ?? false}
      {...attributes["result-back"]}
      onclick={command("result-back")}
      >{text["result-back"] ?? "‹ Alle Verbindungen"}</button
    >
  </div>{/snippet}
{#snippet choices_content()}<div
    id="choices"
    class={classValue("choices", "route-choices")}
    role="group"
    aria-label="Verbindung auswählen"
    hidden={hidden["choices"] ?? false}
    inert={inert["choices"] ?? false}
    {...attributes["choices"]}
  >
    {#if choices}<RouteChoices {...choices} />{/if}
  </div>{/snippet}
{#snippet panel_details()}<div
    id="panel-details"
    class={classValue("panel-details", "panel-details")}
    hidden={hidden["panel-details"] ?? true}
    inert={inert["panel-details"] ?? true}
    {...attributes["panel-details"]}
  >
    <h2
      id="journey-heading"
      tabindex="-1"
      hidden={hidden["journey-heading"] ?? false}
      inert={inert["journey-heading"] ?? false}
      class={classValue("journey-heading", "")}
      {...attributes["journey-heading"]}
    >
      {text["journey-heading"] ?? ""}
    </h2>
    <p
      id="journey-effort"
      hidden={hidden["journey-effort"] ?? false}
      inert={inert["journey-effort"] ?? false}
      class={classValue("journey-effort", "")}
      {...attributes["journey-effort"]}
    >
      {text["journey-effort"] ?? ""}
    </p>
    <div
      id="journey-detail"
      hidden={hidden["journey-detail"] ?? false}
      inert={inert["journey-detail"] ?? false}
      class={classValue("journey-detail", "")}
      {...attributes["journey-detail"]}
    >
      {#if detail}<p class="journey-distance">{detail.distance}</p>
        <ol class="journey-legs">
          <JourneyDetails
            journey={detail.journey}
            restored={detail.restored}
            options={detail.options}
          />
        </ol>{/if}
    </div>
  </div>{/snippet}
{#snippet status()}<p
    id="status"
    class={classValue("status", "panel-status")}
    role="status"
    aria-live="polite"
    tabindex="-1"
    hidden={hidden["status"] ?? false}
    inert={inert["status"] ?? false}
    {...attributes["status"]}
  >
    {text["status"] ?? ""}<RetryCountdownText until={retryAt["status"] ?? 0} />
  </p>{/snippet}
{#snippet saved_notice()}<p
    id="saved-notice"
    class={classValue("saved-notice", "notice")}
    hidden={hidden["saved-notice"] ?? true}
    inert={inert["saved-notice"] ?? false}
    {...attributes["saved-notice"]}
  >
    {text["saved-notice"] ?? ""}
  </p>{/snippet}
{#snippet stale_notice()}<p
    id="stale-notice"
    class={classValue("stale-notice", "notice")}
    role="status"
    hidden={hidden["stale-notice"] ?? true}
    inert={inert["stale-notice"] ?? false}
    {...attributes["stale-notice"]}
  >
    {text["stale-notice"] ?? ""}
  </p>{/snippet}
{#snippet issues()}<p
    id="issues"
    class={classValue("issues", "notice")}
    hidden={hidden["issues"] ?? true}
    inert={inert["issues"] ?? false}
    {...attributes["issues"]}
  >
    {text["issues"] ?? ""}
  </p>{/snippet}
{#snippet map_error()}<p
    id="map-error"
    class={classValue("map-error", "map-error")}
    role="status"
    hidden={hidden["map-error"] ?? true}
    inert={inert["map-error"] ?? false}
    {...attributes["map-error"]}
  >
    {text["map-error"] ?? ""}
  </p>{/snippet}
{#snippet late_departure()}<div
    id="late-departure"
    class={classValue("late-departure", "notice")}
    hidden={hidden["late-departure"] ?? true}
    inert={inert["late-departure"] ?? false}
    {...attributes["late-departure"]}
  >
    <span
      id="late-departure-text"
      hidden={hidden["late-departure-text"] ?? false}
      inert={inert["late-departure-text"] ?? false}
      class={classValue("late-departure-text", "")}
      {...attributes["late-departure-text"]}
      >{text["late-departure-text"] ?? ""}</span
    >
    <button
      id="late-settings"
      type="button"
      class={classValue("late-settings", "text-button")}
      hidden={hidden["late-settings"] ?? false}
      inert={inert["late-settings"] ?? false}
      disabled={disabled["late-settings"] ?? false}
      {...attributes["late-settings"]}
      onclick={command("late-settings")}
    >
      Einstellungen öffnen
    </button>
  </div>{/snippet}
{#snippet cycling_comparison()}<p
    id="cycling-comparison"
    class={classValue("cycling-comparison", "notice")}
    role="status"
    hidden={hidden["cycling-comparison"] ?? true}
    inert={inert["cycling-comparison"] ?? false}
    {...attributes["cycling-comparison"]}
  >
    {text["cycling-comparison"] ?? ""}
  </p>{/snippet}
{#snippet navigation_start_notice()}<p
    id="navigation-start-notice"
    role="status"
    tabindex="-1"
    hidden={hidden["navigation-start-notice"] ?? true}
    inert={inert["navigation-start-notice"] ?? false}
    class={classValue("navigation-start-notice", "")}
    {...attributes["navigation-start-notice"]}
  >
    {text["navigation-start-notice"] ?? ""}{#if startNoticeHelp}{" "}<a
        class="location-help"
        href="hilfe.html#standort">Hilfe zum Standort</a
      >{/if}
  </p>{/snippet}
{#snippet navigation_start_recovery()}<div
    id="navigation-start-recovery"
    hidden={hidden["navigation-start-recovery"] ?? true}
    inert={inert["navigation-start-recovery"] ?? false}
    class={classValue("navigation-start-recovery", "")}
    {...attributes["navigation-start-recovery"]}
  >
    <button
      id="navigation-search-now"
      type="button"
      class={classValue("navigation-search-now", "primary")}
      hidden={hidden["navigation-search-now"] ?? true}
      inert={inert["navigation-search-now"] ?? false}
      disabled={disabled["navigation-search-now"] ?? false}
      {...attributes["navigation-search-now"]}
      onclick={command("navigation-search-now")}
    >
      {text["navigation-search-now"] ?? "Ab jetzt suchen"}
    </button>
    <button
      id="navigation-start-retry"
      type="button"
      class={classValue("navigation-start-retry", "primary")}
      hidden={hidden["navigation-start-retry"] ?? true}
      inert={inert["navigation-start-retry"] ?? false}
      disabled={disabled["navigation-start-retry"] ?? false}
      {...attributes["navigation-start-retry"]}
      onclick={command("navigation-start-retry")}
    >
      {text["navigation-start-retry"] ?? "Erneut versuchen"}
    </button>
  </div>{/snippet}
{#snippet planning_recovery()}<div
    id="planning-recovery"
    class={classValue("planning-recovery", "planning-recovery")}
    hidden={hidden["planning-recovery"] ?? true}
    inert={inert["planning-recovery"] ?? false}
    {...attributes["planning-recovery"]}
  >
    <button
      id="recover-planning"
      class={classValue("recover-planning", "text-button")}
      type="button"
      hidden={hidden["recover-planning"] ?? false}
      inert={inert["recover-planning"] ?? false}
      disabled={disabled["recover-planning"] ?? false}
      {...attributes["recover-planning"]}
      onclick={command("recover-planning")}
    >
      <span class="recovery-icon" data-icon="refresh" aria-hidden="true"
        ><Icon name="refresh" /></span
      >
      <span
        id="recovery-label"
        hidden={hidden["recovery-label"] ?? false}
        inert={inert["recovery-label"] ?? false}
        class={classValue("recovery-label", "")}
        {...attributes["recovery-label"]}
        >{text["recovery-label"] ?? "Erneut versuchen"}</span
      >
    </button>
    <span
      id="recovery-wait"
      class={classValue("recovery-wait", "message")}
      hidden={hidden["recovery-wait"] ?? true}
      inert={inert["recovery-wait"] ?? false}
      {...attributes["recovery-wait"]}>{text["recovery-wait"] ?? ""}</span
    >
  </div>{/snippet}
{#snippet navigation_start()}<button
    id="navigation-start"
    class={classValue("navigation-start", "primary")}
    type="button"
    aria-label="Navigation starten"
    hidden={hidden["navigation-start"] ?? true}
    inert={inert["navigation-start"] ?? false}
    disabled={disabled["navigation-start"] ?? false}
    {...attributes["navigation-start"]}
    onclick={command("navigation-start")}
  >
    {#if start.checking}Wird geprüft …{:else if start.restored}Mit gespeicherter
      Route starten{:else}<Icon name="location" />Los{/if}
  </button>{/snippet}
{#snippet replan_saved()}<button
    id="replan-saved"
    type="button"
    class={classValue("replan-saved", "primary")}
    hidden={hidden["replan-saved"] ?? true}
    inert={inert["replan-saved"] ?? false}
    disabled={disabled["replan-saved"] ?? false}
    {...attributes["replan-saved"]}
    onclick={command("replan-saved")}
  >
    Jetzt neu planen
  </button>{/snippet}
{#snippet example_plan_own()}<a
    id="example-plan-own"
    class={classValue("example-plan-own", "primary example-plan-own")}
    href="./"
    hidden={hidden["example-plan-own"] ?? true}
    inert={inert["example-plan-own"] ?? false}
    {...attributes["example-plan-own"]}
  >
    Eigene Route planen
  </a>{/snippet}
{#snippet toast_content()}
  <PlanningToast
    model={toastModel}
    styles={toastStyles}
    {mapToast}
    recovery={recoveryToast ? planning_recovery : undefined}
  />
{/snippet}
{#snippet root_toast()}
  {#if toastPlacement === "root"}{@render toast_content()}{/if}
{/snippet}

{#snippet request_places()}
  <span class="route-request-places">
    <span class="route-request-chain">
      <span class="route-request-point route-request-origin">
        <span class="route-request-marker" aria-hidden="true">
          <span class="route-origin-marker"></span>
        </span>
        <span
          id="route-origin"
          hidden={hidden["route-origin"] ?? false}
          inert={inert["route-origin"] ?? false}
          class={classValue(
            "route-origin",
            layout.example ? "example-origin" : "",
          )}
          {...attributes["route-origin"]}
          >{text["route-origin"] ?? "Start"}</span
        >
      </span>
      <span
        id="route-request-stops"
        class={classValue("route-request-stops", "route-request-stops")}
        hidden={hidden["route-request-stops"] ?? false}
        inert={inert["route-request-stops"] ?? false}
        {...attributes["route-request-stops"]}
        >{#each stops as stop, index}<span
            class="route-request-point route-request-stop"
            ><span
              class="route-request-marker route-request-stop-marker"
              aria-hidden="true">{index + 1}</span
            ><span class="route-request-stop-name"
              ><span class="sr-only">Zwischenziel {index + 1}:{" "}</span>{stop
                .place.name}</span
            ></span
          >{/each}</span
      >
      <span class="route-request-point route-request-destination">
        <span class="route-request-marker" aria-hidden="true">
          {#if layout.example}
            <Icon name="flag" class="route-destination-marker" />
          {:else}
            <span class="route-destination-marker" data-icon="flag"
              ><Icon name="flag" /></span
            >
          {/if}
        </span>
        <span
          id="route-destination"
          hidden={hidden["route-destination"] ?? false}
          inert={inert["route-destination"] ?? false}
          class={classValue(
            "route-destination",
            layout.example ? "example-destination" : "",
          )}
          {...attributes["route-destination"]}
          >{text["route-destination"] ?? "Ziel"}</span
        >
      </span>
    </span>
    {#if !layout.example}<span
        class="route-edit-icon"
        data-icon="edit"
        aria-hidden="true"><Icon name="edit" /></span
      >{/if}
  </span>
{/snippet}
