import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Journey, Place } from "./model";
import { el, node, legColors } from "./ui";
export class RouteMap {
  private map?: L.Map;
  private tiles?: L.TileLayer;
  private routes?: L.FeatureGroup;
  private selected?: Journey;
  private signature = "";
  private online = true;
  private locationFocus?: Place;
  private adjustingCamera = false;
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
        selected.legs
          .filter((l) => l.kind === "stop")
          .forEach((leg, index) => {
            L.circleMarker([leg.from.latitude, leg.from.longitude], {
              radius: 10,
              color: "#171a1c",
              weight: 2,
              fillColor: "#ffd43b",
              fillOpacity: 1,
            })
              .bindTooltip(node("span", `${index + 1}: ${leg.from.name}`), {
                permanent: true,
              })
              .addTo(this.routes!);
          });
        for (const [p, label] of [
          [selected.origin, "Start"],
          [selected.destination, "Ziel"],
        ] as const)
          L.circleMarker([p.latitude, p.longitude], {
            radius: 7,
            color: "#fff",
            weight: 3,
            fillColor: "#171a1c",
            fillOpacity: 1,
          })
            .bindTooltip(node("span", `${label}: ${p.name}`))
            .addTo(this.routes!);
      }
      this.resize();
    } else this.map.invalidateSize({ pan: false });
  }
  resize() {
    if (!this.map || el("map-view").hidden) return;
    this.map.invalidateSize({ pan: false });
    if (this.locationFocus) {
      this.centerLocation();
      return;
    }
    if (!this.selected) return;
    const coordinates = this.selected.legs.flatMap((l) =>
      l.coordinates.map((p) => [p.latitude, p.longitude] as [number, number]),
    );
    if (!coordinates.length) return;
    const desktop = window.innerWidth >= 900,
      panel = el("journey-panel").getBoundingClientRect(),
      height = el("map").clientHeight;
    // Expanded details prioritize reading. Refit once enough map is visible again.
    if (!desktop && height - panel.height < 100) return;
    this.map.fitBounds(L.latLngBounds(coordinates), {
      paddingTopLeft: desktop ? [460, 35] : [28, 35],
      paddingBottomRight: desktop ? [65, 40] : [45, panel.height + 45],
      maxZoom: 15,
      animate: false,
    });
  }
  center(place: Place) {
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
