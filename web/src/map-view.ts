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
import type { Journey, Place } from "./model";
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
  private journeys: Journey[] = [];
  private envelope?: L.LatLngBounds;
  private context?: string;
  private manualCamera = false;
  private layoutKey = "";
  private reservedPanelHeight = 0;
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
    const observer = new ResizeObserver(() =>
      requestAnimationFrame(() => this.resize()),
    );
    observer.observe(el("journey-panel"));
    observer.observe(el("map-controls"));
    observer.observe(document.querySelector<HTMLElement>(".map-credit")!);
    window.addEventListener("resize", () => this.resize());
    const redraw = () => {
      if (this.map)
        this.show(this.journeys, this.selected, this.online, this.context);
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
  ) {
    const theme = mapTheme();
    if (online && !this.online) el("map-error").hidden = true;
    this.online = online;
    if (!this.map) {
      this.map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: true,
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
      this.hoverLayers = L.layerGroup().addTo(this.map);
    }
    if (online && (!this.tiles || !this.map.hasLayer(this.tiles))) {
      const unavailable = () => {
        if (!this.online) return;
        el("map-error").hidden = false;
        el("map-error").textContent =
          "Straßenkarte nicht verfügbar. Deine Reise bleibt nutzbar.";
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
    el("map-route").hidden = !selected;
    if (!selected) this.pendingRouteFit = false;
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
    if (nextContext !== this.context || !selected) {
      this.context = nextContext;
      this.envelope = undefined;
      this.manualCamera = false;
      this.locationFocus = undefined;
      this.layoutKey = "";
      this.overviewArea = undefined;
      this.markerHalfWidth = 22;
    }
    this.journeys = routes;
    this.selected = selected;
    const label =
      routes.length > 1 ? "Alle Routen anzeigen" : "Gesamte Route anzeigen";
    el("map-route").setAttribute("aria-label", label);
    el("map-route").title = label;
    const coordinates = this.routeCoordinates();
    const bounds = coordinates.length ? L.latLngBounds(coordinates) : undefined;
    if (bounds && (!this.envelope || !this.envelope.contains(bounds))) {
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
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.clearRouteHover();
      this.hoverLayers!.clearLayers();
      this.hoverPaths.clear();
      this.routes!.clearLayers();
      this.routeLines.clear();
      this.selectedPaths = [];
      const draw = (j: Journey, active: boolean) =>
        j.legs.forEach((leg) => {
          if (leg.coordinates.length < 2) return;
          const points = leg.coordinates.map(
            (p) => [p.latitude, p.longitude] as [number, number],
          );
          if (active) {
            const halo = L.polyline(points, {
              color: theme.halo,
              weight: 10,
              interactive: false,
            }).addTo(this.routes!);
            this.selectedPaths.push(halo);
          }
          const line = L.polyline(points, {
            color: active ? theme.lines[leg.kind] : theme.secondary,
            weight: active ? 6 : 4,
            opacity: active ? 1 : 0.5,
            dashArray: leg.kind === "walk" ? "3 8" : undefined,
            interactive: false,
          }).addTo(this.routes!);
          const lines = this.routeLines.get(j.id) ?? [];
          lines.push(line);
          this.routeLines.set(j.id, lines);
          if (active) this.selectedPaths.push(line);
        });
      journeys
        .filter((j) => j.id !== selected?.id)
        .forEach((j) => draw(j, false));
      if (selected) {
        draw(selected, true);
        this.drawPlaces(selected);
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
    this.resize();
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
  private drawPlaces(journey: Journey) {
    type MapPlace = {
      place: Place;
      kind: "start" | "stop" | "destination";
      label: string;
      number?: number;
    };
    const points: MapPlace[] = [
      { place: journey.origin, kind: "start", label: "Start" },
      ...journey.legs
        .filter((leg) => leg.kind === "stop")
        .map((leg, index): MapPlace => ({
          place: leg.from,
          kind: "stop",
          label: `Zwischenstopp ${index + 1}`,
          number: index + 1,
        })),
      { place: journey.destination, kind: "destination", label: "Ziel" },
    ];
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
        .addTo(this.routes!);
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
  resize() {
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
    const layout = JSON.stringify([
      el("map").clientWidth,
      el("map").clientHeight,
      window.innerWidth >= 900,
      bounds.right - controls.left,
      this.markerHalfWidth,
    ]);
    let changed = layout !== this.layoutKey;
    const height = panelBounds.height;
    if (changed) this.reservedPanelHeight = height;

    this.layoutKey = layout;
    if (!this.manualCamera && (this.fitPending || changed)) {
      if (changed) this.overviewArea = undefined;
      this.fitOverview();
    }
  }
  private routeCoordinates(): [number, number][] {
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
    if (!this.map || !this.selected || el("map-view").hidden || el("map").inert)
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
    if (!this.map || !this.selected || !this.envelope) return;
    const coordinates = this.envelope;
    const desktop = window.innerWidth >= 900,
      bounds = el("map").getBoundingClientRect(),
      panel = el("journey-panel").getBoundingClientRect(),
      controls = el("map-controls").getBoundingClientRect(),
      height = bounds.height,
      leftInset = desktop ? Math.max(0, panel.right - bounds.left) : 0;
    if (bounds.width - leftInset <= 1 || !height) return;
    // Expanded details prioritize reading. Refit once enough map is visible again.
    if (!explicit && !desktop && height - panel.height < 100) return;
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
      Math.max(0, bounds.right - controls.left) + markerPadding,
      bounds.width - left - 1,
    );
    if (explicit) {
      const bottom = desktop
        ? bounds.height
        : Math.max(0, Math.min(bounds.height, panel.top - bounds.top));
      if (bottom <= 1) return;
      const vertical = Math.min(30, (bottom - 1) / 2);
      this.setOverviewBounds(coordinates, {
        paddingTopLeft: [left, vertical],
        paddingBottomRight: [right, bounds.height - bottom + vertical],
        maxZoom: 15,
        animate: false,
      });
      return;
    }
    this.setOverviewBounds(coordinates, {
      paddingTopLeft: [left, 35],
      paddingBottomRight: desktop
        ? [right, 40]
        : [right, Math.max(panel.height, this.reservedPanelHeight) + 45],
      maxZoom: 15,
      animate: false,
    });
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
    const left =
        overlaps && window.innerWidth >= 900
          ? Math.min(bounds.width, Math.max(0, panel.right - bounds.left))
          : 0,
      bottom =
        overlaps && window.innerWidth < 900
          ? Math.min(bounds.height, Math.max(0, panel.top - bounds.top))
          : bounds.height;
    if (left === bounds.width || bottom === 0) return;
    const target = L.point((left + bounds.width) / 2, bottom / 2),
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
