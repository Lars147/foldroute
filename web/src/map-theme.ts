import type { LegKind } from "./model";
import { mapStyle } from "./map-style";

export const appearanceEvent = "foldroute:appearance";
export const mapAttribution =
  '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-Mitwirkende</a>';

export function mapTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (role: string) =>
    styles.getPropertyValue(`--color-${role}`).trim();
  // The selected map palette is independent of the surrounding app appearance.
  return {
    name: mapStyle.preference,
    style: `https://tiles.openfreemap.org/styles/${mapStyle.preference}`,
    halo: color("route-halo"),
    text: color("map-text"),
    surface: color("map-surface"),
    secondary: color("map-secondary"),
    location: color("location"),
    lines: {
      bike: color("bike-stroke"),
      transit: color("transit-stroke"),
      walk: color("map-secondary"),
      fold: color("brand"),
      unfold: color("brand"),
      wait: color("map-secondary"),
      stop: color("map-secondary"),
    } satisfies Record<LegKind, string>,
  };
}
