import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Journey, Place } from "./model";
import { el, node, icon, legColors } from "./ui";
export class RouteMap {
  private map?: L.Map;
  private tiles?: L.TileLayer;
  private routes?: L.FeatureGroup;
  private selected?: Journey;
  private signature = "";
  private online = true;
  private locationFocus?: Place;
  private adjustingCamera = false;
  private markerHalfWidth = 22;
  private zooming = false;
  private pendingRouteFit = false;
  constructor(
    private onSelect: (id: string) => void,
    private onBackground: () => void,
  ) {
    new ResizeObserver(() => this.resize()).observe(el("journey-panel"));
    window.addEventListener("resize", () => this.resize());
  }
  show(journeys: Journey[], selected?: Journey, online = navigator.onLine) {
    if (!this.map) {
      this.map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: true,
      }).setView([50, 10], 4);
      this.map.on("click", this.onBackground);
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
        if (!this.adjustingCamera) this.locationFocus = undefined;
      });
      L.control.zoom({ position: "topright" }).addTo(this.map);
      this.routes = L.featureGroup().addTo(this.map);
      this.tiles = L.tileLayer(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19 },
      );
      this.tiles.on("tileerror", () => {
        el("map-error").hidden = false;
        el("map-error").textContent =
          "Straßenkarte nicht verfügbar. Deine Reise bleibt nutzbar.";
      });
      this.tiles.on("tileload", () => {
        if (this.online) el("map-error").hidden = true;
      });
    }
    el("map-route").hidden = !selected;
    if (!selected) this.pendingRouteFit = false;
    this.online = online;
    if (online && !this.map.hasLayer(this.tiles!)) this.tiles!.addTo(this.map);
    if (!online && this.map.hasLayer(this.tiles!)) this.tiles!.remove();
    el("map").classList.toggle("offline-map", !online);
    el("map-label").textContent = online
      ? "© OpenStreetMap-Mitwirkende"
      : "Gespeicherter Streckenverlauf · Ohne Straßenkarte";
    if (!online) {
      el("map-error").hidden = false;
      el("map-error").textContent = "Offline · Straßenkarte nicht verfügbar.";
    }
    const signature = JSON.stringify([journeys.map((j) => j.id), selected?.id]);
    if (signature !== this.signature) {
      this.signature = signature;
      if (selected?.id !== this.selected?.id) this.locationFocus = undefined;
      this.selected = selected;
      this.routes!.clearLayers();
      const draw = (j: Journey, active: boolean) =>
        j.legs.forEach((leg) => {
          if (leg.coordinates.length < 2) return;
          L.polyline(
            leg.coordinates.map(
              (p) => [p.latitude, p.longitude] as [number, number],
            ),
            {
              color: active ? legColors[leg.kind] : "#838d99",
              weight: active ? 6 : 4,
              opacity: active ? 1 : 0.5,
              dashArray: leg.kind === "walk" ? "3 8" : undefined,
            },
          )
            .on("click", (event) => {
              L.DomEvent.stopPropagation(event);
              this.onSelect(j.id);
            })
            .addTo(this.routes!);
        });
      journeys
        .filter((j) => j.id !== selected?.id)
        .forEach((j) => draw(j, false));
      if (selected) {
        draw(selected, true);
        this.drawPlaces(selected);
      }
      this.resize();
    } else this.map.invalidateSize({ pan: false });
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
      22,
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
    if (!this.map || el("map-view").hidden) return;
    this.map.invalidateSize({ pan: false });
    if (this.locationFocus) {
      this.centerLocation();
      return;
    }
    this.fitSelectedRoute();
  }
  fitRoute() {
    if (!this.map || !this.selected || el("map-view").hidden) return;
    this.locationFocus = undefined;
    this.map.stop();
    if (this.zooming) {
      this.pendingRouteFit = true;
      return;
    }
    this.map.closePopup();
    this.map.invalidateSize({ pan: false });
    this.fitSelectedRoute(true);
  }
  private fitSelectedRoute(explicit = false) {
    if (!this.map || !this.selected) return;
    const coordinates = [
      this.selected.origin,
      this.selected.destination,
      ...this.selected.legs.flatMap((leg) => leg.coordinates),
    ].map((p) => [p.latitude, p.longitude] as [number, number]);
    if (!coordinates.length) return;
    const desktop = window.innerWidth >= 900,
      panel = el("journey-panel").getBoundingClientRect(),
      height = el("map").clientHeight;
    // Expanded details prioritize reading. Refit once enough map is visible again.
    if (!explicit && !desktop && height - panel.height < 100) return;
    const markerPadding = this.markerHalfWidth + 8;
    if (explicit) {
      const bounds = el("map").getBoundingClientRect();
      const left = desktop ? Math.max(0, panel.right - bounds.left) : 0;
      const bottom = desktop
        ? bounds.height
        : Math.max(0, Math.min(bounds.height, panel.top - bounds.top));
      if (bounds.width <= left || bottom <= 0) return;
      const horizontal = Math.min(markerPadding, (bounds.width - left - 1) / 2);
      const vertical = Math.min(30, (bottom - 1) / 2);
      // Keep the route clear of the map buttons, without negative fitting space.
      const right = Math.min(
        Math.max(80 + this.markerHalfWidth, horizontal),
        bounds.width - left - horizontal - 1,
      );
      this.map.fitBounds(L.latLngBounds(coordinates), {
        paddingTopLeft: [left + horizontal, vertical],
        paddingBottomRight: [right, bounds.height - bottom + vertical],
        maxZoom: 15,
        animate: false,
      });
      return;
    }
    this.map.fitBounds(L.latLngBounds(coordinates), {
      paddingTopLeft: desktop
        ? [Math.max(460, panel.right + markerPadding), 35]
        : [Math.max(28, markerPadding), 35],
      paddingBottomRight: desktop
        ? [Math.max(65, markerPadding), 40]
        : [Math.max(45, markerPadding), panel.height + 45],
      maxZoom: 15,
      animate: false,
    });
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
