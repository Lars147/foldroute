import {
  locationLabel,
  type LocationFix,
  type LocationQuality,
} from "./live-location";
import L from "leaflet";
import { MaplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { GPUInitializationError, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  Journey,
  Leg,
  Place,
  PlanningRoutePreview,
  RouteRequest,
} from "./model";
import { el, node, icon } from "./ui";
import { appearanceEvent, mapAttribution, mapTheme } from "./map-theme";
import { mapStyleEvent } from "./map-style";
import { mountMapStylePicker } from "./map-style-picker";
import { routeHitTest } from "./route-hit-test";
setWorkerUrl(workerUrl);

// Keep Leaflet routes usable on devices where the basemap cannot create a GPU context.
class BasemapLayer extends MaplibreGL {
  override onAdd(map: L.Map): this {
    try {
      super.onAdd(map);
    } catch (error) {
      if (!(error instanceof GPUInitializationError)) throw error;
      this.getContainer().remove();
      this.fire("unavailable");
    }
    return this;
  }
  override onRemove(map: L.Map): this {
    if (this.getMaplibreMap()) super.onRemove(map);
    return this;
  }
}
export class RouteMap {
  private map?: L.Map;
  private tiles?: L.MaplibreGL;
  private basemapTheme?: string;
  private routes?: L.FeatureGroup;
  private places?: L.LayerGroup;
  private placesSignature = "";
  private routeLines = new Map<string, L.Polyline[]>();
  private selectedPaths: L.Polyline[] = [];
  private hoverLayers?: L.LayerGroup;
  private hoverPaths = new Map<string, L.Polyline[]>();
  private hoveredRoute?: string;
  private hoverFrame?: number;
  private hoverTarget?: string;
  private hoverTimer?: ReturnType<typeof setTimeout>;
  private pointerType = matchMedia("(pointer: coarse)").matches
    ? "touch"
    : "mouse";
  private pointers = new Set<number>();
  private suppressRouteClick = false;
  private moving = false;
  private selected?: Journey;
  private previewRequest?: RouteRequest;
  private routePreview?: PlanningRoutePreview;
  private journeys: Journey[] = [];
  private resultsComplete = false;
  private envelope?: L.LatLngBounds;
  private context?: string;
  private manualCamera = false;
  private layoutKey = "";
  private panelLayoutKey = "";
  private mapMessageHeight = 0;
  private layoutSelection?: string;
  private resizeFrame?: number;
  private fitPending = false;
  private overviewArea?: L.Bounds;
  private signature = "";
  private online = true;
  private locationFocus?: Place;
  private liveFix?: LocationFix;
  private liveQuality?: LocationQuality;
  private livePoint?: L.Marker;
  private accuracyCircle?: L.Circle;
  onManualMove?: () => void;
  private adjustingCamera = false;
  private markerHalfWidth = 22;
  private zooming = false;
  private pendingRouteFit = false;
  constructor(
    private onSelect: (id: string) => void,
    private onBackground: () => void,
  ) {
    mountMapStylePicker(el("map-style-control"), "overview");
    const observer = new ResizeObserver(() => this.scheduleResize());
    observer.observe(el("journey-panel"));
    observer.observe(el("map-controls"));
    observer.observe(el("map"));
    observer.observe(el("connection"));
    observer.observe(document.querySelector<HTMLElement>(".app-tabs")!);
    observer.observe(document.querySelector<HTMLElement>(".map-credit")!);
    window.addEventListener("resize", () => this.scheduleResize());
    const redraw = () => {
      if (this.map)
        this.show(
          this.journeys,
          this.selected,
          this.online,
          this.context,
          this.resultsComplete,
          this.previewRequest,
          this.routePreview,
        );
    };
    window.addEventListener(appearanceEvent, redraw);
    window.addEventListener(mapStyleEvent, redraw);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clearRouteHover();
    });
  }
  show(
    journeys: Journey[],
    selected?: Journey,
    online = navigator.onLine,
    context?: string,
    complete = false,
    previewRequest?: RouteRequest,
    routePreview?: PlanningRoutePreview,
  ) {
    const keepPreviewCamera = !!(
      selected &&
      this.previewRequest &&
      this.manualCamera
    );
    this.previewRequest = selected ? undefined : previewRequest;
    this.routePreview = this.previewRequest ? routePreview : undefined;
    const finished = complete && !this.resultsComplete;
    this.resultsComplete = complete;
    const theme = mapTheme();
    if (online && !this.online) el("map-error").hidden = true;
    this.online = online;
    if (!this.map) {
      this.map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: true,
        doubleClickZoom: false,
      }).setView([50, 10], 4);
      this.map.on("click", (event: L.LeafletMouseEvent) => {
        if (this.moving || this.zooming || this.suppressRouteClick) return;
        // WebKit labels compatibility clicks from touch as mouse input.
        const hit = this.hitRoute(
          event.layerPoint,
          this.pointerType === "mouse" ? 12 : 22,
        );
        this.clearRouteHover();
        if (hit.kind === "background") this.onBackground();
        else if (hit.kind === "route" && hit.id !== this.selected?.id)
          this.onSelect(hit.id);
      });
      const container = this.map.getContainer();
      container.addEventListener("pointerdown", (event) => {
        this.pointerType = event.pointerType;
        if (event.pointerType === "mouse") this.cancelPendingHover();
        else this.clearRouteHover();
        if (!this.pointers.size) this.suppressRouteClick = false;
        this.pointers.add(event.pointerId);
        if (this.pointers.size > 1) this.suppressRouteClick = true;
      });
      window.addEventListener("pointerup", (event) =>
        this.pointers.delete(event.pointerId),
      );
      window.addEventListener("pointercancel", (event) => {
        if (this.pointers.delete(event.pointerId))
          this.suppressRouteClick = true;
        this.clearRouteHover();
      });
      container.addEventListener("pointermove", (event) =>
        this.hoverRoute(event),
      );
      container.addEventListener("pointerleave", () =>
        this.clearRouteHover(false),
      );
      this.map.on("movestart", () => {
        this.moving = true;
      });
      this.map.on("moveend", () => {
        this.moving = false;
      });
      this.map.on("movestart zoomstart resize", () => this.clearRouteHover());
      this.map.on("zoomstart", () => {
        this.zooming = true;
      });
      this.map.on("zoomend", () => {
        this.zooming = false;
        if (this.pendingRouteFit) {
          this.pendingRouteFit = false;
          this.fitRoute();
        }
      });
      this.map.on("movestart zoomstart", () => {
        if (!this.adjustingCamera) {
          this.onManualMove?.();
          this.locationFocus = undefined;
          this.manualCamera = true;
        }
      });
      const zoom = L.control
        .zoom({
          zoomInTitle: "Vergrößern",
          zoomOutTitle: "Verkleinern",
        })
        .addTo(this.map);
      el("map-zoom-control").replaceChildren(zoom.getContainer()!);
      this.routes = L.featureGroup().addTo(this.map);
      this.places = L.layerGroup().addTo(this.map);
      this.hoverLayers = L.layerGroup().addTo(this.map);
    }
    if (online && (!this.tiles || !this.map.hasLayer(this.tiles))) {
      const unavailable = () => {
        if (!this.online) return;
        el("map-error").hidden = false;
        el("map-error").textContent = this.previewRequest
          ? "Straßenkarte nicht verfügbar. Die eingegebenen Orte bleiben sichtbar."
          : "Straßenkarte nicht verfügbar. Deine Reise bleibt nutzbar.";
      };
      this.tiles = new BasemapLayer({
        style: theme.style,
        attributionControl: false,
      });
      this.tiles.on("unavailable", unavailable).addTo(this.map);
      const basemap = this.tiles!.getMaplibreMap();
      this.basemapTheme = theme.name;
      basemap?.on("error", unavailable);
      basemap?.on("idle", () => {
        if (this.online) el("map-error").hidden = true;
      });
    }
    if (online && this.basemapTheme !== theme.name) {
      this.tiles!.getMaplibreMap()?.setStyle(theme.style);
      this.basemapTheme = theme.name;
    }
    this.updateLocation(this.liveFix, this.liveQuality);
    el("map-route").hidden = !selected && !this.previewRequest;
    if (!selected && !this.previewRequest) this.pendingRouteFit = false;
    el("map").classList.toggle("offline-map", !online);
    el("map-label").innerHTML = mapAttribution;
    if (!online) {
      el("map-error").hidden = false;
      el("map-error").textContent =
        "Offline · Geladene Kartenbereiche bleiben sichtbar. Neue Bereiche benötigen Internet.";
    }
    const routes =
      selected && !journeys.some((j) => j.id === selected.id)
        ? [...journeys, selected]
        : journeys;
    const nextContext =
      context ??
      (selected
        ? JSON.stringify([selected.origin, selected.destination])
        : undefined);
    if (nextContext !== this.context || (!selected && !this.previewRequest)) {
      this.context = nextContext;
      this.envelope = undefined;
      this.manualCamera = keepPreviewCamera;
      this.locationFocus = undefined;
      this.layoutKey = "";
      this.overviewArea = undefined;
      this.markerHalfWidth = 22;
    }
    this.journeys = routes;
    this.selected = selected;
    this.drawPlaces(selected ?? this.previewRequest);
    const label = this.previewRequest
      ? this.routePreview
        ? "Orte und Teilroute anzeigen"
        : "Alle Orte anzeigen"
      : routes.length > 1
        ? "Alle Routen anzeigen"
        : "Gesamte Route anzeigen";
    el("map-route").setAttribute("aria-label", label);
    el("map-route").title = label;
    // Streaming geometry must not move the request overview. Explicit fit
    // includes the provisional path, even when it leaves the request bounds.
    const coordinates = this.previewRequest
      ? this.requestCoordinates()
      : this.routeCoordinates();
    const bounds = coordinates.length ? L.latLngBounds(coordinates) : undefined;
    if (
      bounds &&
      complete &&
      !this.previewRequest &&
      !this.manualCamera &&
      (finished || !this.envelope?.equals(bounds))
    ) {
      // Optimization can discard detours. Finish with the current routes,
      // using the same bounds as the route-fit button, unless the user moved.
      this.envelope = bounds;
      this.overviewArea = undefined;
      this.fitPending = true;
    } else if (bounds && (!this.envelope || !this.envelope.contains(bounds))) {
      this.envelope = this.envelope ? this.envelope.extend(bounds) : bounds;
      this.fitPending = true;
    }
    const signature = JSON.stringify([
      theme.name,
      routes.map((j) => [
        j.id,
        j.origin,
        j.destination,
        j.legs.map((leg) => [
          leg.kind,
          leg.coordinates,
          leg.kind === "stop" ? leg.from : null,
        ]),
      ]),
      selected?.id,
      this.previewRequest,
      this.routePreview,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.clearRouteHover();
      this.hoverLayers!.clearLayers();
      this.hoverPaths.clear();
      this.routes!.clearLayers();
      this.routeLines.clear();
      this.selectedPaths = [];
      const draw = (legs: Leg[], active: boolean, id?: string) =>
        legs.forEach((leg) => {
          if (leg.coordinates.length < 2) return;
          const provisional = id === undefined;
          const points = leg.coordinates.map(
            (p) => [p.latitude, p.longitude] as [number, number],
          );
          if (active) {
            const halo = L.polyline(points, {
              className: provisional
                ? "planning-route-preview-halo"
                : undefined,
              color: theme.halo,
              weight: 10,
              opacity: provisional ? 0.7 : 1,
              interactive: false,
            }).addTo(this.routes!);
            if (!provisional) this.selectedPaths.push(halo);
          }
          const line = L.polyline(points, {
            className: provisional ? "planning-route-preview-line" : undefined,
            color: active ? theme.lines[leg.kind] : theme.secondary,
            weight: active ? 6 : 4,
            opacity: provisional ? 0.7 : active ? 1 : 0.5,
            dashArray: leg.kind === "walk" ? "3 8" : undefined,
            interactive: false,
          }).addTo(this.routes!);
          if (!provisional) {
            const lines = this.routeLines.get(id) ?? [];
            lines.push(line);
            this.routeLines.set(id, lines);
            if (active) this.selectedPaths.push(line);
          }
        });
      journeys
        .filter((j) => j.id !== selected?.id)
        .forEach((j) => draw(j.legs, false, j.id));
      if (selected) {
        draw(selected.legs, true, selected.id);
      } else if (this.previewRequest) {
        if (this.routePreview) draw(this.routePreview.legs, true);
      }
      // Keep preview paths mounted so interrupted fades continue from their current opacity.
      for (const [id, lines] of this.routeLines) {
        if (id === selected?.id) continue;
        const previews: L.Polyline[] = [];
        for (const line of lines) {
          const points = line.getLatLngs() as L.LatLng[];
          previews.push(
            L.polyline(points, {
              className: "route-preview route-preview-halo",
              color: theme.halo,
              weight: 10,
              interactive: false,
            }).addTo(this.hoverLayers!),
            L.polyline(points, {
              className: "route-preview route-preview-line",
              color: theme.secondary,
              weight: 6,
              opacity: 0.95,
              dashArray: line.options.dashArray,
              interactive: false,
            }).addTo(this.hoverLayers!),
          );
        }
        for (const preview of previews)
          preview.getElement()!.setAttribute("data-preview-route", id);
        this.hoverPaths.set(id, previews);
      }
      this.selectedPaths.forEach((path) => path.bringToFront());
    }
    this.scheduleResize();
  }
  private hitRoute(point: L.Point, radius: number) {
    return routeHitTest(
      [...this.routeLines].flatMap(([id, lines]) =>
        lines.map((line) => ({
          id,
          distance:
            line.closestLayerPoint(point)?.distanceTo(point) ?? Infinity,
        })),
      ),
      radius,
      this.selected?.id,
    );
  }
  private hoverRoute(event: PointerEvent) {
    this.pointerType = event.pointerType;
    if (
      event.pointerType !== "mouse" ||
      event.buttons !== 0 ||
      this.moving ||
      this.zooming ||
      document.hidden ||
      el("map").inert ||
      !matchMedia("(any-hover: hover) and (any-pointer: fine)").matches ||
      (event.target instanceof Element &&
        event.target.closest(
          ".leaflet-marker-icon, .leaflet-popup, .leaflet-control",
        ))
    ) {
      this.clearRouteHover();
      return;
    }
    if (this.hoverFrame !== undefined) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = undefined;
      const hit = this.hitRoute(this.map!.mouseEventToLayerPoint(event), 12);
      const id =
        hit.kind === "route" && hit.id !== this.selected?.id
          ? hit.id
          : undefined;
      // Affordance and clicking always follow current geometry, even during hover intent.
      this.map!.getContainer().style.cursor = id ? "pointer" : "";
      if (hit.kind === "ambiguous" || (hit.kind === "route" && !id)) {
        this.cancelPendingHover();
        this.setRouteHover(undefined);
        return;
      }
      this.queueRouteHover(id);
    });
  }
  private queueRouteHover(id?: string) {
    if (id === this.hoveredRoute) {
      this.cancelPendingHover();
      return;
    }
    if (this.hoverTimer !== undefined && id === this.hoverTarget) return;
    this.cancelPendingHover();
    this.hoverTarget = id;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = undefined;
      this.hoverTarget = undefined;
      if (!document.hidden && !el("map").inert) this.setRouteHover(id);
    }, 80);
  }
  private setRouteHover(id?: string, immediate = false) {
    if (id === this.hoveredRoute && !immediate) return;
    this.hoveredRoute = id;
    for (const [route, paths] of this.hoverPaths)
      for (const path of paths) {
        const element = path.getElement()!;
        element.classList.toggle("is-hovered", route === id);
        element.classList.toggle("route-preview-reset", immediate);
      }
  }
  private cancelPendingHover() {
    if (this.hoverFrame !== undefined) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = undefined;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
    this.hoverTarget = undefined;
  }
  private clearRouteHover(immediate = true) {
    this.cancelPendingHover();
    this.setRouteHover(undefined, immediate);
    this.map?.getContainer().style.removeProperty("cursor");
  }
  private drawPlaces(journey?: Journey | RouteRequest) {
    type MapPlace = {
      place: Place;
      kind: "start" | "stop" | "destination";
      label: string;
      number?: number;
    };
    const stops = !journey
      ? []
      : "legs" in journey
        ? journey.legs
            .filter((leg) => leg.kind === "stop")
            .map((leg) => leg.from)
        : (journey.stops ?? []).map((stop) => stop.place);
    const points: MapPlace[] = journey
      ? [
          { place: journey.origin, kind: "start", label: "Start" },
          ...stops.map((place, index): MapPlace => ({
            place,
            kind: "stop",
            label: `Zwischenstopp ${index + 1}`,
            number: index + 1,
          })),
          { place: journey.destination, kind: "destination", label: "Ziel" },
        ]
      : [];
    const groups = new Map<string, MapPlace[]>();
    for (const point of points) {
      const key = `${point.place.latitude},${point.place.longitude}`;
      const group = groups.get(key) ?? [];
      group.push(point);
      groups.set(key, group);
    }
    this.markerHalfWidth = Math.max(
      this.markerHalfWidth,
      ...Array.from(groups.values(), (group) => 22 * group.length),
    );
    // Geometry, camera context and palettes must not replace focused markers.
    const signature = JSON.stringify(
      points.map(({ place, kind, label, number }) => [
        place.latitude,
        place.longitude,
        place.name,
        kind,
        label,
        number,
      ]),
    );
    if (signature === this.placesSignature) return;
    this.placesSignature = signature;
    this.places!.clearLayers();
    for (const group of groups.values()) {
      const symbols = node("span", "", "route-marker-symbols");
      symbols.setAttribute("aria-hidden", "true");
      const popup = node("div", "", "route-marker-info");
      const labels = group.map(
        (point) => `${point.label}: ${point.place.name}`,
      );
      for (const [index, point] of group.entries()) {
        const slot = node("span", "", "route-marker-slot");
        const symbol = node(
          "span",
          point.number === undefined ? "" : String(point.number),
          `route-marker-symbol route-marker-${point.kind}`,
        );
        if (point.kind === "destination") symbol.append(icon("flag"));
        slot.append(symbol);
        symbols.append(slot);
        popup.append(node("p", labels[index]));
      }
      const width = 44 * group.length;
      const { latitude, longitude } = group[0].place;
      const marker = L.marker([latitude, longitude], {
        icon: L.divIcon({
          html: symbols,
          className: "route-marker",
          iconSize: [width, 44],
          iconAnchor: [width / 2, 22],
          popupAnchor: [0, -16],
        }),
        title: labels.join(" · "),
        keyboard: true,
        bubblingMouseEvents: false,
      })
        .bindPopup(popup)
        .addTo(this.places!);
      const element = marker.getElement()!;
      element.setAttribute("aria-label", labels.join(" · "));
      element.addEventListener("keydown", (event) => {
        if (event.key === " ") {
          event.preventDefault();
          marker.openPopup();
        }
      });
    }
  }
  private scheduleResize() {
    if (this.resizeFrame !== undefined) return;
    // Result rendering can still move status messages out of the map panel.
    this.resizeFrame = requestAnimationFrame(() => this.resize());
  }
  resize() {
    if (this.resizeFrame !== undefined) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = undefined;
    }
    if (!this.map || el("map-view").hidden || el("map").inert) return;
    // Reserve room above the mobile panel for the currently visible controls.
    const controlsSpace = `${Math.ceil(el("map-controls").getBoundingClientRect().height) + 22}px`;
    if (
      el("map-view").style.getPropertyValue("--map-controls-space") !==
      controlsSpace
    )
      el("map-view").style.setProperty("--map-controls-space", controlsSpace);
    const panel = el("journey-panel");
    const bounds = el("map").getBoundingClientRect(),
      panelBounds = panel.getBoundingClientRect(),
      controls = el("map-controls").getBoundingClientRect(),
      credit = document
        .querySelector<HTMLElement>(".map-credit")!
        .getBoundingClientRect(),
      creditBottom = panelBounds.top - 6,
      creditRight = Math.max(
        bounds.right - panelBounds.right,
        creditBottom > controls.top &&
          creditBottom - credit.height < controls.bottom
          ? bounds.right - controls.left + 8
          : 0,
      );
    el("map-view").style.setProperty(
      "--map-panel-top",
      `${Math.max(0, panelBounds.top - bounds.top)}px`,
    );
    el("map-view").style.setProperty("--map-credit-right", `${creditRight}px`);
    const size = this.map.getSize();
    if (size.x !== el("map").clientWidth || size.y !== el("map").clientHeight)
      this.map.invalidateSize({ pan: false });
    if (this.locationFocus) {
      this.centerLocation();
      return;
    }
    const safe = this.safeInsets();
    const layout = JSON.stringify([
      el("map").clientWidth,
      el("map").clientHeight,
      this.hasSidePanel(),
      bounds.right - controls.left,
      this.markerHalfWidth,
      safe,
      getComputedStyle(document.documentElement).fontSize,
      bounds.bottom - panelBounds.bottom,
    ]);
    const changed = layout !== this.layoutKey;
    const panelLayout = JSON.stringify([
      this.hasSidePanel()
        ? panelBounds.right - bounds.left
        : panelBounds.top - bounds.top,
    ]);
    const mapMessageHeight = el("map-error").getBoundingClientRect().height;
    // Refit after result/status reflow, while comparing existing alternatives
    // preserves the shared camera even when their summaries differ in height.
    const panelChanged =
      panelLayout !== this.panelLayoutKey &&
      (this.fitPending ||
        (!!this.previewRequest && mapMessageHeight !== this.mapMessageHeight) ||
        (!this.previewRequest && this.selected?.id === this.layoutSelection));
    this.layoutKey = layout;
    this.panelLayoutKey = panelLayout;
    this.mapMessageHeight = mapMessageHeight;
    this.layoutSelection = this.selected?.id;
    if (!this.manualCamera && (this.fitPending || changed || panelChanged)) {
      if (changed || panelChanged) this.overviewArea = undefined;
      this.fitOverview();
    }
  }
  private requestCoordinates(): [number, number][] {
    const request = this.previewRequest!;
    return [
      request.origin,
      ...(request.stops ?? []).map((stop) => stop.place),
      request.destination,
    ].map((place) => [place.latitude, place.longitude]);
  }
  private routeCoordinates(): [number, number][] {
    if (this.previewRequest)
      return [
        ...this.requestCoordinates(),
        ...(this.routePreview?.legs.flatMap((leg) =>
          leg.coordinates.map(
            (p) => [p.latitude, p.longitude] as [number, number],
          ),
        ) ?? []),
      ];
    return this.journeys
      .flatMap((j) => [
        j.origin,
        j.destination,
        ...j.legs.filter((leg) => leg.kind === "stop").map((leg) => leg.from),
        ...j.legs.flatMap((leg) => leg.coordinates),
      ])
      .map((p) => [p.latitude, p.longitude]);
  }
  fitRoute() {
    if (
      !this.map ||
      (!this.selected && !this.previewRequest) ||
      el("map-view").hidden ||
      el("map").inert
    )
      return;
    this.locationFocus = undefined;
    this.manualCamera = false;
    this.map.stop();
    if (this.zooming) {
      this.pendingRouteFit = true;
      return;
    }
    this.map.closePopup();
    this.map.invalidateSize({ pan: false });
    const coordinates = this.routeCoordinates();
    this.envelope = coordinates.length
      ? L.latLngBounds(coordinates)
      : undefined;
    this.fitOverview(true);
  }
  private fitOverview(explicit = false) {
    if (!this.map || (!this.selected && !this.previewRequest) || !this.envelope)
      return;
    const coordinates = this.envelope;
    const sidebar = this.hasSidePanel(),
      bounds = el("map").getBoundingClientRect(),
      panel = el("journey-panel").getBoundingClientRect(),
      controls = el("map-controls").getBoundingClientRect(),
      height = bounds.height,
      safe = this.safeInsets(),
      leftInset = sidebar
        ? Math.max(safe.left, panel.right - bounds.left)
        : safe.left,
      bottom = sidebar
        ? height - safe.bottom
        : Math.max(0, Math.min(height, panel.top - bounds.top)),
      visibleHeight = bottom - safe.top;
    if (bounds.width - leftInset <= 1 || !height) return;
    if (visibleHeight <= 1) return;
    // Expanded details prioritize reading. Refit once enough map is visible again.
    if (!explicit && !sidebar && visibleHeight < 100) return;
    this.fitPending = false;
    if (
      !explicit &&
      this.overviewArea &&
      [coordinates.getNorthWest(), coordinates.getSouthEast()].every((point) =>
        this.overviewArea!.contains(this.map!.latLngToContainerPoint(point)),
      )
    )
      return;
    const markerPadding = Math.min(
      this.markerHalfWidth + 8,
      (bounds.width - leftInset - 1) / 2,
    );
    const left = leftInset + markerPadding;
    // Reserve the entire control column, plus room for the marker and an 8px gap.
    const right = Math.min(
      Math.max(safe.right, bounds.right - controls.left) + markerPadding,
      bounds.width - left - 1,
    );
    const creditHeight = document
      .querySelector<HTMLElement>(".map-credit")!
      .getBoundingClientRect().height;
    const vertical = Math.min(
      Math.max(30, creditHeight + 8),
      (visibleHeight - 1) / 2,
    );
    this.setOverviewBounds(coordinates, {
      paddingTopLeft: [left, safe.top + vertical],
      paddingBottomRight: [right, height - bottom + vertical],
      maxZoom: 15,
      animate: false,
    });
  }
  private safeInsets() {
    const style = getComputedStyle(el("map-view"));
    return {
      top: parseFloat(style.paddingTop),
      left: parseFloat(style.paddingLeft),
      right: parseFloat(style.paddingRight),
      bottom: parseFloat(style.paddingBottom),
    };
  }
  private hasSidePanel() {
    return (
      window.innerWidth >= 900 ||
      getComputedStyle(el("map-view"))
        .getPropertyValue("--map-panel-layout")
        .trim() === "side"
    );
  }
  private setOverviewBounds(
    bounds: L.LatLngBounds,
    options: L.FitBoundsOptions,
  ) {
    const topLeft = L.point(options.paddingTopLeft ?? [0, 0]);
    const bottomRight = this.map!.getSize().subtract(
      L.point(options.paddingBottomRight ?? [0, 0]),
    );
    this.overviewArea = L.bounds(topLeft, bottomRight);
    this.adjustingCamera = true;
    this.map!.fitBounds(bounds, options);
    this.adjustingCamera = false;
  }
  updateLocation(fix?: LocationFix, state?: LocationQuality) {
    this.liveFix = fix;
    this.liveQuality = state;
    if (!this.map) return;
    if (!fix || !state) {
      this.livePoint?.remove();
      this.accuracyCircle?.remove();
      this.livePoint = undefined;
      this.accuracyCircle = undefined;
      return;
    }
    const point: L.LatLngExpression = [fix.latitude, fix.longitude];
    const label = locationLabel(state);
    const theme = mapTheme();
    const color = state === "stale" ? theme.secondary : theme.location;
    if (!this.accuracyCircle)
      this.accuracyCircle = L.circle(point, {
        radius: fix.accuracy,
        className: "live-location-accuracy",
        interactive: false,
        weight: 1,
        fillOpacity: 0.12,
      }).addTo(this.map);
    this.accuracyCircle
      .setLatLng(point)
      .setRadius(fix.accuracy)
      .setStyle({ color, fillColor: color });
    if (!this.livePoint) {
      this.livePoint = L.marker(point, {
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: "live-location-marker",
          html: '<span class="live-location-dot"></span>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(this.map);
      this.livePoint.bindTooltip(label);
    }
    this.livePoint.setLatLng(point).setTooltipContent(label);
    const marker = this.livePoint.getElement();
    if (marker) {
      marker.dataset.quality = state;
      marker.style.setProperty("--location-color", color);
      marker.setAttribute(
        "aria-label",
        `${label}, Genauigkeit etwa ${Math.round(fix.accuracy)} Meter`,
      );
      marker.title = `${label} · etwa ${Math.round(fix.accuracy)} m`;
    }
  }
  center(place: Place) {
    this.pendingRouteFit = false;
    this.locationFocus = place;
    this.resize();
  }
  private centerLocation() {
    if (!this.map || !this.locationFocus) return;
    const bounds = el("map").getBoundingClientRect(),
      panel = el("journey-panel").getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const overlaps =
      panel.width > 0 &&
      panel.height > 0 &&
      panel.right > bounds.left &&
      panel.left < bounds.right &&
      panel.bottom > bounds.top &&
      panel.top < bounds.bottom;
    const safe = this.safeInsets();
    const left =
        overlaps && this.hasSidePanel()
          ? Math.min(bounds.width, Math.max(0, panel.right - bounds.left))
          : safe.left,
      bottom =
        overlaps && !this.hasSidePanel()
          ? Math.min(bounds.height, Math.max(0, panel.top - bounds.top))
          : bounds.height - safe.bottom;
    if (left >= bounds.width - safe.right || bottom <= safe.top) return;
    const target = L.point(
        (left + bounds.width - safe.right) / 2,
        (safe.top + bottom) / 2,
      ),
      offset = this.map.getSize().divideBy(2).subtract(target),
      place = this.locationFocus,
      center = this.map.unproject(
        this.map.project([place.latitude, place.longitude], 15).add(offset),
        15,
      );
    // Non-animated camera changes emit move/zoom events synchronously.
    // They must not cancel the focus as genuine user gestures do.
    this.adjustingCamera = true;
    this.map.setView(center, 15, { animate: false });
    this.adjustingCamera = false;
  }
}
