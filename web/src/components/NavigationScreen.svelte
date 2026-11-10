<script lang="ts">
  import NavigationAlternativeDialog from "./NavigationAlternativeDialog.svelte";
  import JourneyDetails from "./JourneyDetails.svelte";
  import MapStylePicker from "./MapStylePicker.svelte";
  import Icon from "./Icon.svelte";
  import NavigationSectionTabs from "./NavigationSectionTabs.svelte";
  import NavigationLocationStatus from "./NavigationLocationStatus.svelte";
  import NavigationCompletionControls from "./NavigationCompletionControls.svelte";
  import NavigationFinishSummary from "./NavigationFinishSummary.svelte";
  import { mapAttribution } from "../map-theme";
  import type {
    NavigationAlternativeModel,
    NavigationSectionDetail,
    NavigationCompletionModel,
    NavigationCompletionCommands,
    NavigationTab,
    NavigationLocationStatus as LocationModel,
    NavigationFinishSummary as FinishModel,
  } from "../navigation-presentation";
  let {
    selectSection,
    phaseKeydown,
    endNavigation,
  }: {
    selectSection: (id: string) => void;
    phaseKeydown: (event: KeyboardEvent) => void;
    endNavigation: () => void;
  } = $props();
  let icons = $state<Record<string, string | undefined>>({});
  let locationFeedback = $state.raw({ message: "", help: false });
  export function setIcon(id: string, value: string | undefined) {
    icons[id] = value;
  }
  export function updateLocationFeedback(message: string, help: boolean) {
    locationFeedback = { message, help };
  }
  let text = $state<Record<string, string>>({});
  let hidden = $state<Record<string, boolean>>({});
  let disabled = $state<Record<string, boolean>>({});
  let attributes = $state<Record<string, Record<string, string | undefined>>>(
    {},
  );
  export function setText(id: string, value: string | null | undefined) {
    text[id] = value ?? "";
    icons[id] = undefined;
  }
  export function setHidden(id: string, value: boolean) {
    hidden[id] = value;
  }
  export function setDisabled(id: string, value: boolean) {
    disabled[id] = value;
  }
  export function setAttribute(
    id: string,
    name: string,
    value: string | undefined,
  ) {
    attributes[id] = { ...attributes[id], [name]: value };
  }
  let alternative = $state.raw<NavigationAlternativeModel>({
    status: "",
    busy: false,
    available: false,
    stale: false,
  });
  export function updateAlternative(value: NavigationAlternativeModel) {
    alternative = value;
  }
  let sectionModel = $state.raw<NavigationSectionDetail | undefined>();
  let sectionDetail = $state<{ setMovementSummary(text: string): void }>();
  export function updateSectionDetail(value?: NavigationSectionDetail) {
    sectionModel = value;
  }
  export function updateMovementSummary(value: string) {
    sectionDetail?.setMovementSummary(value);
  }
  let root: HTMLElement;
  let mobile = $state(false);
  let arrived = $state(false);
  export function updateLayout(nextMobile: boolean, nextArrived: boolean) {
    mobile = nextMobile;
    arrived = nextArrived;
  }
  let tabsModel = $state.raw<readonly NavigationTab[]>([]);
  let location: { update(value: LocationModel): void };
  let finish: { update(value: FinishModel): void };
  let controls = $state.raw<NavigationCompletionModel>({
    available: false,
    manualAvailable: false,
    busy: false,
    mobile: false,
    label: "Abschnitt fertig",
    retryVisible: false,
    retryLabel: "Erneut versuchen",
    replanVisible: false,
  });
  let commands = $state.raw<NavigationCompletionCommands>({
    complete() {},
    retry() {},
    replan() {},
  });
  export function updateCompletion(value: NavigationCompletionModel) {
    controls = value;
  }
  export function setCompletionCommands(value: NavigationCompletionCommands) {
    commands = value;
  }
  export function element() {
    return root;
  }
  export function updateTabs(value: readonly NavigationTab[]) {
    tabsModel = value;
  }
  export function updateLocation(value: LocationModel) {
    location.update(value);
  }
  export function updateFinish(value: FinishModel) {
    finish.update(value);
  }
</script>

{#snippet yesAction()}<button
    id="navigation-confirm-yes"
    class="primary"
    type="button"
    hidden={hidden["navigation-confirm-yes"] ?? false}
    disabled={disabled["navigation-confirm-yes"] ?? false}
    {...attributes["navigation-confirm-yes"]}
    >{text["navigation-confirm-yes"] ?? "Best\u00e4tigen"}</button
  >{/snippet}
{#snippet noAction()}<button
    id="navigation-confirm-no"
    class="secondary"
    type="button"
    hidden={hidden["navigation-confirm-no"] ?? false}
    disabled={disabled["navigation-confirm-no"] ?? false}
    {...attributes["navigation-confirm-no"]}
    >{text["navigation-confirm-no"] ?? "Abbrechen"}</button
  >{/snippet}
{#snippet guidance()}<div
    class="navigation-instruction"
    id="navigation-guidance"
    hidden={hidden["navigation-guidance"] ?? false}
    {...attributes["navigation-guidance"]}
  >
    <span
      id="navigation-arrow"
      aria-hidden="true"
      {...attributes["navigation-arrow"]}
      >{#if icons["navigation-arrow"]}<Icon
          name={icons["navigation-arrow"]!}
        />{:else}{text["navigation-arrow"] ?? "↑"}{/if}</span
    >
    <div>
      <strong
        id="navigation-distance"
        hidden={hidden["navigation-distance"] ?? false}
        {...attributes["navigation-distance"]}
        >{text["navigation-distance"] ?? ""}</strong
      >
      <h1
        id="navigation-instruction"
        tabindex="-1"
        hidden={hidden["navigation-instruction"] ?? false}
        {...attributes["navigation-instruction"]}
      >
        {text["navigation-instruction"] ?? "Navigation wird vorbereitet \u2026"}
      </h1>
      <p
        id="navigation-detail"
        hidden={hidden["navigation-detail"] ?? false}
        {...attributes["navigation-detail"]}
      >
        {text["navigation-detail"] ?? ""}
      </p>
    </div>
  </div>{/snippet}
{#snippet context()}<span
    id="navigation-context"
    hidden={hidden["navigation-context"] ?? true}
    {...attributes["navigation-context"]}
    ><strong
      id="navigation-context-title"
      hidden={hidden["navigation-context-title"] ?? false}
      {...attributes["navigation-context-title"]}
      >{text["navigation-context-title"] ?? ""}</strong
    ><span
      id="navigation-context-detail"
      hidden={hidden["navigation-context-detail"] ?? false}
      {...attributes["navigation-context-detail"]}
      >{text["navigation-context-detail"] ?? ""}</span
    ><span
      id="navigation-context-status"
      hidden={hidden["navigation-context-status"] ?? false}
      {...attributes["navigation-context-status"]}
      >{text["navigation-context-status"] ?? ""}</span
    ></span
  >{/snippet}
{#snippet endAction()}<button
    id="navigation-end"
    class="secondary"
    type="button"
    onclick={endNavigation}
    aria-label={arrived ? "Fahrt abschließen" : "Navigation beenden"}
    title={arrived ? "Fahrt abschließen" : "Navigation beenden"}
    hidden={hidden["navigation-end"] ?? false}
    disabled={disabled["navigation-end"] ?? false}
    {...attributes["navigation-end"]}
    >{#if mobile && !arrived}<Icon name="close" />{:else}{arrived
        ? "Fahrt abschließen"
        : "Navigation beenden"}{/if}</button
  >{/snippet}
<section
  bind:this={root}
  id="navigation-view"
  class="navigation-screen navigation-managed"
  aria-label="Aktive Navigation"
  hidden={hidden["navigation-view"] ?? true}
  {...attributes["navigation-view"]}
>
  <!-- The map adapter implements keyboard interaction on its stable host. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    id="navigation-map"
    role="application"
    tabindex="0"
    aria-label="Navigationskarte in Fahrtrichtung"
    hidden={hidden["navigation-map"] ?? false}
    {...attributes["navigation-map"]}
  ></div>
  <div
    class="navigation-top"
    id="navigation-top"
    hidden={hidden["navigation-top"] ?? false}
    {...attributes["navigation-top"]}
  >
    {#if mobile}{@render guidance()}{:else}<NavigationSectionTabs
        model={tabsModel}
        select={selectSection}
        keydown={phaseKeydown}
      />{/if}
  </div>
  <span
    id="navigation-undo-announcement"
    class="sr-only"
    role="status"
    aria-live="polite"
    hidden={hidden["navigation-undo-announcement"] ?? false}
    {...attributes["navigation-undo-announcement"]}
    >{text["navigation-undo-announcement"] ?? ""}</span
  >
  <div
    id="navigation-undo"
    class="toast"
    hidden={hidden["navigation-undo"] ?? true}
    {...attributes["navigation-undo"]}
  >
    <button
      id="navigation-undo-button"
      type="button"
      hidden={hidden["navigation-undo-button"] ?? false}
      disabled={disabled["navigation-undo-button"] ?? false}
      {...attributes["navigation-undo-button"]}
      ><Icon name="undo" />{text["navigation-undo-button"] ??
        "Rückgängig"}</button
    >
  </div>
  <span
    id="navigation-auto-announcement"
    class="sr-only"
    role="status"
    aria-live="polite"
    hidden={hidden["navigation-auto-announcement"] ?? false}
    {...attributes["navigation-auto-announcement"]}
    >{text["navigation-auto-announcement"] ?? ""}</span
  >
  <div
    id="navigation-auto-complete"
    class="toast"
    hidden={hidden["navigation-auto-complete"] ?? true}
    {...attributes["navigation-auto-complete"]}
  >
    <span
      id="navigation-auto-label"
      aria-hidden="true"
      {...attributes["navigation-auto-label"]}
      >{text["navigation-auto-label"] ?? ""}</span
    ><button
      id="navigation-auto-cancel"
      type="button"
      hidden={hidden["navigation-auto-cancel"] ?? false}
      disabled={disabled["navigation-auto-cancel"] ?? false}
      {...attributes["navigation-auto-cancel"]}
      >{text["navigation-auto-cancel"] ?? "Abbrechen"}</button
    ><span id="navigation-auto-countdown-host" style="display: contents"></span>
  </div>
  <NavigationLocationStatus bind:this={location} />
  <div
    class="navigation-map-controls"
    role="group"
    aria-label="Kartensteuerung"
  >
    <button
      id="navigation-audio"
      class="navigation-icon-button secondary"
      type="button"
      aria-label="Ton ausschalten"
      title="Ton ausschalten"
      hidden={hidden["navigation-audio"] ?? false}
      disabled={disabled["navigation-audio"] ?? false}
      {...attributes["navigation-audio"]}
      ><Icon name={icons["navigation-audio"] ?? "volume"} /></button
    >
    <button
      id="navigation-center"
      class="navigation-center navigation-icon-button secondary"
      type="button"
      aria-label="Navigation zentrieren"
      title="Navigation zentrieren"
      data-following="true"
      hidden={hidden["navigation-center"] ?? false}
      disabled={disabled["navigation-center"] ?? false}
      {...attributes["navigation-center"]}
      ><Icon name={icons["navigation-center"] ?? "crosshair"} /></button
    >
    <div
      id="navigation-style-control"
      hidden={hidden["navigation-style-control"] ?? false}
      {...attributes["navigation-style-control"]}
    >
      <MapStylePicker id="navigation" />
    </div>
  </div>
  <div class="navigation-credit">{@html mapAttribution}</div>
  <article
    class="navigation-panel"
    id="navigation-panel"
    aria-label="Navigationshinweise"
    hidden={hidden["navigation-panel"] ?? false}
    {...attributes["navigation-panel"]}
  >
    {#if !mobile}{@render guidance()}{/if}
    <div
      id="navigation-summary"
      hidden={hidden["navigation-summary"] ?? false}
      {...attributes["navigation-summary"]}
    >
      <button
        id="navigation-details-toggle"
        type="button"
        aria-expanded="false"
        aria-controls="navigation-details"
        aria-describedby="navigation-context-title navigation-context-detail navigation-context-status navigation-remaining"
        hidden={hidden["navigation-details-toggle"] ?? false}
        disabled={disabled["navigation-details-toggle"] ?? false}
        {...attributes["navigation-details-toggle"]}
        ><span class="navigation-grip" aria-hidden="true"
        ></span>{#if mobile}{@render context()}{/if}<strong
          id="navigation-remaining"
          hidden={hidden["navigation-remaining"] ?? false}
          {...attributes["navigation-remaining"]}
          >{text["navigation-remaining"] ?? ""}</strong
        ><span
          id="navigation-summary-label"
          hidden={hidden["navigation-summary-label"] ?? false}
          {...attributes["navigation-summary-label"]}
          >{text["navigation-summary-label"] ?? "Reisedetails"}</span
        ><Icon name="chevron" class="navigation-expand" /></button
      >
      <div
        id="navigation-end-slot"
        hidden={hidden["navigation-end-slot"] ?? false}
        {...attributes["navigation-end-slot"]}
      >
        {#if mobile}{@render endAction()}{/if}
      </div>
    </div>
    <div
      id="navigation-alert"
      hidden={hidden["navigation-alert"] ?? true}
      {...attributes["navigation-alert"]}
    >
      <p
        id="navigation-alert-summary"
        role="status"
        aria-atomic="true"
        hidden={hidden["navigation-alert-summary"] ?? false}
        {...attributes["navigation-alert-summary"]}
      >
        {text["navigation-alert-summary"] ?? ""}
      </p>
      <button
        id="navigation-alert-open"
        class={attributes["navigation-alert-open"]?.["data-primary"] === "true"
          ? "primary"
          : "secondary"}
        type="button"
        hidden={hidden["navigation-alert-open"] ?? false}
        disabled={disabled["navigation-alert-open"] ?? false}
        {...attributes["navigation-alert-open"]}
        >{text["navigation-alert-open"] ?? "Details"}</button
      >
    </div>
    <div
      id="navigation-context-slot"
      hidden={hidden["navigation-context-slot"] ?? false}
      {...attributes["navigation-context-slot"]}
    >
      {#if !mobile}{@render context()}{/if}
    </div>
    <div
      id="navigation-section-preview"
      role="region"
      hidden={hidden["navigation-section-preview"] ?? true}
      {...attributes["navigation-section-preview"]}
    >
      <strong
        id="navigation-section-preview-title"
        hidden={hidden["navigation-section-preview-title"] ?? false}
        {...attributes["navigation-section-preview-title"]}
        >{text["navigation-section-preview-title"] ?? ""}</strong
      >
      <p
        id="navigation-section-preview-meta"
        hidden={hidden["navigation-section-preview-meta"] ?? false}
        {...attributes["navigation-section-preview-meta"]}
      >
        {text["navigation-section-preview-meta"] ?? ""}
      </p>
      <p
        id="navigation-section-preview-place"
        hidden={hidden["navigation-section-preview-place"] ?? false}
        {...attributes["navigation-section-preview-place"]}
      >
        {text["navigation-section-preview-place"] ?? ""}
      </p>
    </div>
    <ol
      id="navigation-stations-preview"
      class="navigation-stations"
      aria-label="Kommende Halte"
      hidden={hidden["navigation-stations-preview"] ?? true}
      {...attributes["navigation-stations-preview"]}
    ></ol>
    <span
      id="navigation-stations-announcement"
      class="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      hidden={hidden["navigation-stations-announcement"] ?? false}
      {...attributes["navigation-stations-announcement"]}
      >{text["navigation-stations-announcement"] ?? ""}</span
    >
    <div
      id="navigation-details"
      hidden={hidden["navigation-details"] ?? false}
      {...attributes["navigation-details"]}
    >
      <div
        id="navigation-section-detail"
        role="tabpanel"
        tabindex="0"
        hidden={hidden["navigation-section-detail"] ?? false}
        {...attributes["navigation-section-detail"]}
      >
        <span
          id="navigation-stage"
          class="sr-only"
          hidden={hidden["navigation-stage"] ?? false}
          {...attributes["navigation-stage"]}
          >{text["navigation-stage"] ?? ""}</span
        >
        <div
          id="navigation-section-content"
          hidden={hidden["navigation-section-content"] ?? false}
          {...attributes["navigation-section-content"]}
        >
          {#key sectionModel}{#if sectionModel}<ol class="journey-legs">
                <JourneyDetails
                  bind:this={sectionDetail}
                  journey={sectionModel.journey}
                  restored={false}
                  options={sectionModel.options}
                />
              </ol>{/if}{/key}
        </div>
        <ol
          id="navigation-stations-detail"
          class="navigation-stations"
          aria-label="Stationen bis zum Ausstieg"
          hidden={hidden["navigation-stations-detail"] ?? true}
          {...attributes["navigation-stations-detail"]}
        ></ol>
        <p
          id="navigation-station-status"
          hidden={hidden["navigation-station-status"] ?? false}
          {...attributes["navigation-station-status"]}
        >
          {text["navigation-station-status"] ?? ""}
        </p>
        <p
          id="navigation-transit-status"
          hidden={hidden["navigation-transit-status"] ?? false}
          {...attributes["navigation-transit-status"]}
        >
          {text["navigation-transit-status"] ?? ""}
        </p>
      </div>
      <p
        id="navigation-current-transit-status"
        hidden={hidden["navigation-current-transit-status"] ?? false}
        {...attributes["navigation-current-transit-status"]}
      >
        {text["navigation-current-transit-status"] ?? ""}
      </p>
      <p
        id="navigation-arrival-warning"
        role="status"
        hidden={hidden["navigation-arrival-warning"] ?? false}
        {...attributes["navigation-arrival-warning"]}
      >
        {text["navigation-arrival-warning"] ?? ""}
      </p>
      <div
        id="navigation-location"
        hidden={hidden["navigation-location"] ?? true}
        {...attributes["navigation-location"]}
      >
        <p
          id="navigation-location-status"
          role="status"
          hidden={hidden["navigation-location-status"] ?? false}
          {...attributes["navigation-location-status"]}
        >
          {locationFeedback.message}{#if locationFeedback.message && locationFeedback.help}
            {" "}
            <a class="location-help" href="hilfe.html#standort"
              >Hilfe zum Standort</a
            >{/if}
        </p>
        <div class="navigation-actions">
          <button
            id="navigation-locate"
            class="secondary"
            hidden={hidden["navigation-locate"] ?? true}
            disabled={disabled["navigation-locate"] ?? false}
            {...attributes["navigation-locate"]}
            >{text["navigation-locate"] ?? "Standort erneut anfragen"}</button
          >
        </div>
      </div>
      <p
        id="navigation-network-status"
        hidden={hidden["navigation-network-status"] ?? false}
        {...attributes["navigation-network-status"]}
      >
        {text["navigation-network-status"] ?? ""}
      </p>
      <p
        id="navigation-status"
        role="status"
        hidden={hidden["navigation-status"] ?? false}
        {...attributes["navigation-status"]}
      >
        {text["navigation-status"] ?? ""}
      </p>
      <p
        id="navigation-disruption"
        role="status"
        hidden={hidden["navigation-disruption"] ?? false}
        {...attributes["navigation-disruption"]}
      >
        {text["navigation-disruption"] ?? ""}
      </p>
      <p
        id="navigation-storage-status"
        hidden={hidden["navigation-storage-status"] ?? false}
        {...attributes["navigation-storage-status"]}
      >
        {text["navigation-storage-status"] ?? ""}
      </p>
      <p
        id="navigation-audio-status"
        hidden={hidden["navigation-audio-status"] ?? false}
        {...attributes["navigation-audio-status"]}
      >
        {text["navigation-audio-status"] ?? ""}
      </p>
      <NavigationCompletionControls mode="manual" model={controls} {commands} />
    </div>
    <div
      id="navigation-phases-slot"
      hidden={hidden["navigation-phases-slot"] ?? false}
      {...attributes["navigation-phases-slot"]}
    >
      {#if mobile}<NavigationSectionTabs
          model={tabsModel}
          select={selectSection}
          keydown={phaseKeydown}
        />{/if}
    </div>
    <div
      id="navigation-quick-actions"
      class="navigation-actions"
      hidden={hidden["navigation-quick-actions"] ?? false}
      {...attributes["navigation-quick-actions"]}
    >
      <div
        id="navigation-detail-actions"
        class="navigation-actions"
        hidden={hidden["navigation-detail-actions"] ?? false}
        {...attributes["navigation-detail-actions"]}
      >
        <NavigationCompletionControls
          mode="primary"
          model={controls}
          {commands}
        />{#if !mobile}{@render endAction()}{/if}
      </div>
    </div>
    <NavigationFinishSummary bind:this={finish} />
  </article>
  <NavigationAlternativeDialog model={alternative} />
  <dialog
    id="navigation-confirm"
    aria-labelledby="navigation-confirm-title"
    aria-describedby="navigation-confirm-message"
    hidden={hidden["navigation-confirm"] ?? false}
    {...attributes["navigation-confirm"]}
  >
    <h2
      id="navigation-confirm-title"
      hidden={hidden["navigation-confirm-title"] ?? false}
      {...attributes["navigation-confirm-title"]}
    >
      {text["navigation-confirm-title"] ?? "Navigation best\u00e4tigen"}
    </h2>
    <p
      id="navigation-confirm-message"
      hidden={hidden["navigation-confirm-message"] ?? false}
      {...attributes["navigation-confirm-message"]}
    >
      {text["navigation-confirm-message"] ?? ""}
    </p>
    <div class="navigation-actions">
      {#if attributes["navigation-confirm"]?.["data-kind"] === "end"}{@render noAction()}{@render yesAction()}{:else}{@render yesAction()}{@render noAction()}{/if}
    </div>
  </dialog>
</section>

<style>
  :global(.navigation-managed #navigation-quick-actions) {
    display: contents;
  }
  :global(.navigation-managed #navigation-detail-actions) {
    display: flex;
  }
  @media (max-width: 899px) {
    :global(.navigation-managed #navigation-quick-actions) {
      display: flex;
    }
    :global(.navigation-managed #navigation-detail-actions) {
      display: contents;
    }
  }
</style>
