import type { LegKind } from "./model";
export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) => {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
};
export const clock = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
export const duration = (seconds: number) => {
  const minutes = Math.ceil(seconds / 60),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${minutes} min`;
};
export const dateLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
  });
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const paths: Record<string, string> = {
  bike: '<circle cx="5" cy="17" r="3.5"/><circle cx="19" cy="17" r="3.5"/><path d="m5 17 5-9 5 9H5m5-9h6l3 9M8 5h4m4-1h3v4"/>',
  fold: '<path d="m3 3 6 6M3 9h6V3m12 18-6-6m6 0h-6v6"/>',
  unfold: '<path d="m9 9-6-6m0 6V3h6m6 12 6 6m-6 0h6v-6"/>',
  transit:
    '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 11h14M12 3v8m-4 7-3 3m11-3 3 3M9 21h6M8 14h1m6 0h1"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m7 21 4-7 2-6 3 4 4 1M5 12l4-4h4m-2 6 5 7"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stop: '<path d="M12 22s8-8 8-14a8 8 0 0 0-16 0c0 6 8 14 8 14Z"/><circle cx="12" cy="8" r="3"/>',
  location: '<path d="m3 10 18-7-7 18-3-8-8-3Z"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16m6-14v16"/>',
  settings:
    '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  "fit-route": '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  share: '<path d="M12 16V3m-4 4 4-4 4 4M8 10H5v11h14V10h-3"/>',
  flag: '<path d="M5 21V3m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
};
export function icon(name: LegKind | keyof typeof paths) {
  const span = node("span", "", "icon");
  span.setAttribute("aria-hidden", "true");
  if (name === "bike") {
    span.innerHTML =
      '<svg viewBox="130 230 760 620" fill="none" stroke="currentColor" stroke-width="42" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="280" cy="690" r="125"/><circle cx="740" cy="690" r="125"/><path d="M280 690 430 615 520 545 685 550M430 615 395 505 520 545M395 505 380 300M685 550 650 300H735M685 550 740 690M322 285H448"/><path d="m520 503 42 42-42 42-42-42Z" fill="currentColor" stroke="none"/></svg>';
    return span;
  }
  // All markup comes from this fixed icon set, never from a provider response.
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[name] ?? paths.map}</svg>`;
  return span;
}
export const legColors: Record<LegKind, string> = {
  bike: "#2ec5ce",
  transit: "#7667e8",
  fold: "#ffd43b",
  unfold: "#ffd43b",
  walk: "#91d5b3",
  wait: "#ffd43b",
  stop: "#ffd43b",
};
