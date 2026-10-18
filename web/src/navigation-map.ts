import Map from "ol/Map.js";
import View from "ol/View.js";
import { defaults as defaultInteractions } from "ol/interaction/defaults.js";
import VectorLayer from "ol/layer/Vector.js";
import LayerGroup from "ol/layer/Group.js";
import { apply } from "ol-mapbox-style";
import VectorSource from "ol/source/Vector.js";
import Feature from "ol/Feature.js";
import LineString from "ol/geom/LineString.js";
import Point from "ol/geom/Point.js";
import CircleGeometry from "ol/geom/Circle.js";
import { fromLonLat } from "ol/proj.js";
import { Style, Stroke, Fill, Circle, Text, RegularShape } from "ol/style.js";
import "ol/ol.css";
import {
  headingDelta,
  projectPath,
  projectTransitPath,
  type NavigationEngine,
} from "./navigation-engine";
import { type LocationFix, type LocationQuality } from "./live-location";
import type { Coordinate, LegKind } from "./model";
import { appearanceEvent, mapAttribution, mapTheme } from "./map-theme";
import { mapStyleEvent } from "./map-style";
import {
  MarkerMotion,
  TransitPath,
  type MarkerPosition,
  type TransitEstimateSource,
  type TransitPosition,
} from "./navigation-estimate";
const xy = (p: Coordinate) => fromLonLat([p.longitude, p.latitude]);
const navigationZoom: Partial<Record<LegKind, number>> = {
  bike: 17,
  walk: 18,
  transit: 15,
};
export class NavigationMap {
  private map: Map;
  private view: View;
  private routes = new VectorSource();
  private location = new VectorSource();
  private marker = new Feature(new Point([0, 0]));
  private accuracy = new Feature(new CircleGeometry([0, 0], 0));
  private markerImage?: RegularShape;
  private motion = new MarkerMotion();
  private motionKey = "";
  private animationFrame?: number;
  private animationWakeup?: ReturnType<typeof setTimeout>;
  private suspended = false;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private displayed?: MarkerPosition;
  private displayedLeg?: string;
  private stationPathKey = "";
  private stationPath?: TransitPath;
  private lastDrawAt?: number;
  private desiredHeading?: number;
  private followLayout?: { size: [number, number]; anchor: [number, number] };
  private tiles = new LayerGroup();
  private basemapTheme?: string;
  private basemapVersion = 0;
  private frame?: {
    engine: NavigationEngine;
    fix?: LocationFix;
    state?: LocationQuality;
    estimate?: TransitEstimateSource;
  };
  private following = true;
  private heading?: number;
  private lastFix?: LocationFix;
  private signature = "";
  private kind?: LegKind;
  private defaultZoom = navigationZoom.bike!;
  private observer: ResizeObserver;
  private events = new AbortController();
  constructor(
    private target: HTMLElement,
    private panel: HTMLElement,
    private top: HTMLElement,
    private changed: (following: boolean) => void,
    private positionChanged: (position: TransitPosition) => void = () => {},
  ) {
    this.view = new View({
      center: fromLonLat([10, 50]),
      zoom: this.defaultZoom,
      maxZoom: 19,
      constrainRotation: false,
    });
    const publishZoom = () => {
      target.dataset.zoom = String(this.view.getZoom());
    };
    this.view.on("change:resolution", publishZoom);
    publishZoom();
    this.view.on("change:center", () => {
      target.dataset.center = JSON.stringify(this.view.getCenter());
    });
    this.map = new Map({
      target,
      view: this.view,
      interactions: defaultInteractions({ onFocusOnly: false }),
      layers: [
        this.tiles,
        new VectorLayer({ source: this.routes }),
        new VectorLayer({ source: this.location }),
      ],
      controls: [],
    });
    this.location.addFeatures([this.accuracy, this.marker]);
    document.addEventListener(
      "visibilitychange",
      () => {
        this.stopAnimation();
        if (document.hidden) this.suspended = true;
        if (!document.hidden && this.frame)
          this.update(
            this.frame.engine,
            this.frame.fix,
            this.frame.state,
            this.frame.estimate,
          );
      },
      { signal: this.events.signal },
    );
    this.reducedMotion.addEventListener(
      "change",
      () => {
        this.stopAnimation();
        if (this.frame)
          this.update(
            this.frame.engine,
            this.frame.fix,
            this.frame.state,
            this.frame.estimate,
          );
      },
      { signal: this.events.signal },
    );
    this.map.on("pointerdrag", () => this.pause());
    target.addEventListener("wheel", () => this.pause(), {
      passive: true,
      signal: this.events.signal,
    });
    target.addEventListener("touchmove", () => this.pause(), {
      passive: true,
      signal: this.events.signal,
    });
    target.addEventListener(
      "keydown",
      (event) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "+",
            "-",
          ].includes(event.key)
        )
          this.pause();
      },
      { signal: this.events.signal },
    );
    this.observer = new ResizeObserver(() => {
      this.map.updateSize();
      this.position();
    });
    this.observer.observe(target);
    this.observer.observe(panel);
    this.observer.observe(top);
    window.addEventListener(
      appearanceEvent,
      () => {
        if (this.frame)
          this.update(
            this.frame.engine,
            this.frame.fix,
            this.frame.state,
            this.frame.estimate,
          );
      },
      { signal: this.events.signal },
    );
    window.addEventListener(
      mapStyleEvent,
      () => {
        if (this.frame)
          this.update(
            this.frame.engine,
            this.frame.fix,
            this.frame.state,
            this.frame.estimate,
          );
      },
      { signal: this.events.signal },
    );
    const credit = target.parentElement!.querySelector(".navigation-credit");
    if (credit)
      credit.innerHTML =
        mapAttribution +
        ' · <a href="https://transitous.org/sources/">Fahrtdaten</a>';
  }
  pause() {
    this.following = false;
    this.target.dataset.following = "false";
    this.changed(false);
  }
  freeze() {
    this.stopAnimation();
    this.view.cancelAnimations();
    this.frame = undefined;
  }
  center() {
    this.view.cancelAnimations();
    this.view.setZoom(this.defaultZoom);
    this.following = true;
    this.target.dataset.following = "true";
    this.changed(true);
    this.position();
  }
  update(
    engine: NavigationEngine,
    fix?: LocationFix,
    state?: LocationQuality,
    estimate?: TransitEstimateSource,
  ) {
    this.frame = { engine, fix, state, estimate };
    if (document.hidden) {
      this.suspended = true;
      this.stopAnimation();
      return;
    }
    if (this.suspended) {
      this.suspended = false;
      this.motionKey = "";
    }
    const theme = mapTheme();
    if (navigator.onLine && this.basemapTheme !== theme.name) {
      this.basemapTheme = theme.name;
      const version = ++this.basemapVersion;
      const next = new LayerGroup();
      void apply(next, theme.style)
        .then(() => {
          if (this.events.signal.aborted || version !== this.basemapVersion) {
            next.dispose();
            return;
          }
          const previous = this.tiles;
          this.tiles = next;
          this.map.getLayers().setAt(0, next);
          previous.dispose();
          delete this.target.dataset.tileError;
        })
        .catch(() => {
          next.dispose();
          if (!this.events.signal.aborted && version === this.basemapVersion)
            this.target.dataset.tileError = "true";
        });
    }
    const signature = JSON.stringify([
      theme.name,
      engine.journey.legs.map((l) => [l.navigationId, l.coordinates]),
      engine.progress.legIndex,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.routes.clear();
      engine.journey.legs.forEach((leg, index) => {
        if (leg.coordinates.length < 2) return;
        const feature = new Feature(new LineString(leg.coordinates.map(xy)));
        feature.setStyle([
          new Style({
            stroke: new Stroke({
              color: theme.halo,
              width: index === engine.progress.legIndex ? 11 : 8,
            }),
          }),
          new Style({
            stroke: new Stroke({
              color:
                index < engine.progress.legIndex
                  ? theme.secondary
                  : theme.lines[leg.kind],
              width: index === engine.progress.legIndex ? 7 : 4,
              lineDash: leg.kind === "walk" ? [3, 8] : undefined,
            }),
          }),
        ]);
        this.routes.addFeature(feature);
      });
      const points = [
        engine.journey.origin,
        ...engine.journey.legs.flatMap((l) => (l.stop ? [l.stop.place] : [])),
        engine.journey.destination,
      ];
      points.forEach((point, index) => {
        const feature = new Feature(new Point(xy(point)));
        feature.setStyle(
          new Style({
            image: new Circle({
              radius: 12,
              fill: new Fill({
                color: index === 0 ? theme.surface : theme.text,
              }),
              stroke: new Stroke({
                color: index === 0 ? theme.text : theme.surface,
                width: 2,
              }),
            }),
            text: new Text({
              text:
                index === 0
                  ? ""
                  : index === points.length - 1
                    ? "Z"
                    : String(index),
              fill: new Fill({ color: theme.surface }),
              font: "bold 12px sans-serif",
            }),
          }),
        );
        this.routes.addFeature(feature);
      });
    }
    if (this.kind !== engine.leg.kind) {
      this.kind = engine.leg.kind;
      const zoom = navigationZoom[this.kind];
      if (zoom !== undefined) {
        this.defaultZoom = zoom;
        if (this.following) this.view.setZoom(zoom);
      }
    }
    if (fix && state === "current") {
      this.lastFix = fix;
      const course =
        fix.heading !== undefined && (fix.speed ?? 0) >= 1
          ? fix.heading
          : undefined;
      const initial = projectPath(fix, engine.leg.coordinates).bearing;
      const desired = course ?? this.desiredHeading ?? initial;
      this.desiredHeading =
        this.desiredHeading === undefined
          ? desired
          : this.desiredHeading +
            headingDelta(this.desiredHeading, desired) * 0.4;
    }
    this.accuracy.setStyle(
      estimate
        ? []
        : new Style({
            fill: new Fill({ color: `${theme.location}20` }),
            stroke: new Stroke({ color: `${theme.location}80`, width: 1 }),
          }),
    );
    this.markerImage = new RegularShape({
      points: 3,
      radius: 13,
      radius2: 7,
      rotation: ((this.heading ?? 0) * Math.PI) / 180,
      rotateWithView: true,
      fill: estimate
        ? new Fill({ color: theme.surface })
        : new Fill({
            color: state === "current" ? theme.location : theme.secondary,
          }),
      stroke: new Stroke({
        color: estimate ? theme.secondary : theme.halo,
        width: 3,
      }),
    });
    this.marker.setStyle(new Style({ image: this.markerImage }));
    const stationPathKey = JSON.stringify([
      engine.leg.navigationId,
      engine.leg.kind,
      engine.leg.coordinates,
      engine.leg.transitStops,
      engine.leg.transitStatus?.cancelled,
    ]);
    if (this.stationPathKey !== stationPathKey) {
      this.stationPathKey = stationPathKey;
      this.stationPath = TransitPath.create(engine.leg);
    }
    const now = Date.now() / 1000;
    const motionKey = JSON.stringify(
      estimate
        ? [
            engine.leg.navigationId,
            "estimated",
            estimate.timeline.path.key,
            engine.leg.start,
            engine.leg.end,
            engine.leg.transitStops,
            estimate.confirmedIndex,
            estimate.confirmedMeters,
          ]
        : [
            engine.leg.navigationId,
            "gps",
            this.lastFix,
            this.desiredHeading,
            stationPathKey,
            engine.progress.meters,
          ],
    );
    if (motionKey !== this.motionKey) {
      this.stopAnimation();
      this.motionKey = motionKey;
      const point = this.lastFix ?? engine.leg.from;
      const meters =
        this.lastFix && this.stationPath
          ? projectTransitPath(
              this.lastFix,
              this.stationPath.path.coordinates,
              Math.max(0, engine.progress.meters - 100),
            )?.meters
          : undefined;
      this.motion.setTarget(
        estimate
          ? {
              path: estimate.timeline.path,
              sample: (time) =>
                estimate.timeline.sample(
                  time,
                  estimate.confirmedIndex,
                  estimate.confirmedMeters,
                ),
            }
          : {
              sample: () => ({
                point,
                meters,
                bearing: this.desiredHeading ?? 0,
              }),
            },
        now,
        engine.leg.kind === "transit" &&
          !this.reducedMotion.matches &&
          !document.hidden,
        this.displayed && {
          ...this.displayed,
          meters:
            this.displayedLeg === engine.leg.navigationId
              ? this.displayed.meters
              : undefined,
          bearing: this.heading ?? this.displayed.bearing,
        },
      );
    }
    this.target.dataset.positionSource = estimate
      ? "estimated"
      : state === "current"
        ? "gps"
        : "last-known";
    this.target.dataset.following = String(this.following);
    this.drawMarker(now);
    this.displayedLeg = engine.leg.navigationId;
    if (!this.lastFix && !estimate) this.view.setCenter(xy(engine.leg.from));
    this.position();
    this.startAnimation();
  }
  private drawMarker(now: number) {
    const position = this.motion.sample(now, !this.reducedMotion.matches);
    this.positionChanged({
      navigationId: this.frame!.engine.leg.navigationId,
      meters: position.meters,
      path: this.stationPath,
      source: this.frame!.estimate
        ? "estimated"
        : this.frame!.state === "current"
          ? "gps"
          : "last-known",
    });
    const previousHeading = this.heading;
    const elapsed =
      this.lastDrawAt === undefined ? 0 : Math.max(0, now - this.lastDrawAt);
    this.heading =
      this.heading === undefined ||
      this.reducedMotion.matches ||
      this.frame?.engine.leg.kind !== "transit"
        ? position.bearing
        : this.heading +
          headingDelta(this.heading, position.bearing) *
            (1 - Math.exp(-elapsed / 0.15));
    this.lastDrawAt = now;
    const radius =
      (this.lastFix?.accuracy ?? 0) /
      Math.max(0.1, Math.cos((position.point.latitude * Math.PI) / 180));
    if (
      this.displayed?.point.latitude === position.point.latitude &&
      this.displayed.point.longitude === position.point.longitude &&
      this.displayed.meters === position.meters &&
      Math.abs((previousHeading ?? 0) - this.heading) < 0.00001 &&
      this.accuracy.getGeometry()!.getRadius() === radius
    )
      return;
    this.displayed = position;
    this.marker.getGeometry()!.setCoordinates(xy(position.point));
    this.markerImage!.setRotation((this.heading * Math.PI) / 180);
    this.marker.changed();
    this.accuracy.getGeometry()!.setCenter(xy(position.point));
    this.accuracy.getGeometry()!.setRadius(radius);
    this.target.dataset.bearing = String(this.heading);
    this.target.dataset.position = JSON.stringify(position.point);
    this.followMarker();
  }
  private startAnimation() {
    if (
      this.animationFrame !== undefined ||
      this.animationWakeup !== undefined ||
      this.reducedMotion.matches ||
      document.hidden ||
      this.events.signal.aborted
    )
      return;
    const estimate = this.frame?.estimate;
    if (!this.motion.correcting) {
      const now = Date.now() / 1000;
      const next = estimate?.timeline.nextMovementAt(
        now,
        estimate.confirmedIndex,
        estimate.confirmedMeters,
      );
      if (next === undefined) return;
      if (next > now) {
        this.animationWakeup = setTimeout(
          () => {
            this.animationWakeup = undefined;
            this.drawMarker(Date.now() / 1000);
            this.startAnimation();
          },
          (next - now) * 1000,
        );
        return;
      }
    }
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = undefined;
      this.drawMarker(Date.now() / 1000);
      this.startAnimation();
    });
  }
  private stopAnimation() {
    if (this.animationFrame !== undefined)
      cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
    if (this.animationWakeup !== undefined) clearTimeout(this.animationWakeup);
    this.animationWakeup = undefined;
  }
  private position() {
    // Panel translate is visual only: following uses its final layout position.
    const bounds = this.target.getBoundingClientRect(),
      top = this.top.getBoundingClientRect(),
      panelTop =
        this.target.parentElement!.getBoundingClientRect().top +
        this.panel.offsetTop;
    if (!bounds.width || !bounds.height) return;
    const screen = this.target.parentElement!;
    screen.style.setProperty(
      "--navigation-header-bottom",
      `${Math.max(0, top.bottom - bounds.top)}px`,
    );
    screen.style.setProperty(
      "--navigation-panel-top",
      `${Math.max(0, panelTop - bounds.top)}px`,
    );
    const controls = screen
        .querySelector(".navigation-map-controls")!
        .getBoundingClientRect(),
      credit = screen
        .querySelector(".navigation-credit")!
        .getBoundingClientRect(),
      creditBottom = panelTop - 6;
    screen.style.setProperty(
      "--navigation-credit-offset",
      `${creditBottom > controls.top && creditBottom - credit.height < controls.bottom ? controls.width + 8 : 0}px`,
    );
    const upper = Math.max(0, top.bottom - bounds.top + 12),
      lower = Math.max(upper, panelTop - bounds.top - 12);
    this.followLayout = {
      size: [bounds.width, bounds.height],
      anchor: [bounds.width / 2, upper + ((lower - upper) * 2) / 3],
    };
    this.followMarker();
  }
  private followMarker() {
    if (
      !this.following ||
      !this.displayed ||
      !this.followLayout ||
      (!this.lastFix && !this.frame?.estimate) ||
      this.target.hidden
    )
      return;
    const heading = (-(this.heading ?? 0) * Math.PI) / 180;
    this.view.setRotation(heading);
    this.view.centerOn(
      xy(this.displayed.point),
      this.followLayout.size,
      this.followLayout.anchor,
    );
  }
  dispose() {
    this.stopAnimation();
    this.events.abort();
    this.observer.disconnect();
    this.map.setTarget(undefined);
    this.map.dispose();
  }
}
