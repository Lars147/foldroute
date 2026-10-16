import type { Place } from "./model";

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
}
export type SharedDestination =
  | { kind: "place"; place: Place }
  | { kind: "query"; query: string }
  | { kind: "unsupported" }
  | { kind: "invalid" };

export const shareKeys = ["shareTitle", "shareText", "shareUrl"] as const;
export const unsupportedShare =
  "Adresse aus dem Kartenlink nicht erkannt. Bitte Ziel eingeben.";
const links = /(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/)[^\s<>]+/gi;
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const useful = (value: string) =>
  value.length >= 2 &&
  !/^(?:apple maps|google maps|karten|maps|standort)$/i.test(value);

function target(value: string, name?: string): SharedDestination {
  const query = clean(value);
  if (!query) return { kind: "unsupported" };
  const pair = query.match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
  if (pair) {
    const latitude = Number(pair[1]),
      longitude = Number(pair[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
      return { kind: "invalid" };
    return {
      kind: "place",
      place: {
        latitude,
        longitude,
        name: name || "Geteiltes Ziel",
        detail: "",
      },
    };
  }
  if (/^[\d+.,\s-]+$/.test(query)) return { kind: "invalid" };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(query)) return { kind: "unsupported" };
  return { kind: "query", query };
}

function mapTarget(raw: string): SharedDestination {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unsupported" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { kind: "unsupported" };
  const p = url.searchParams,
    host = url.hostname.toLowerCase();
  if (host === "maps.apple.com") {
    const label = p.get("name") || p.get("q") || undefined;
    if (p.has("daddr")) return target(p.get("daddr")!);
    if (url.pathname === "/directions" && p.has("destination"))
      return target(p.get("destination")!);
    if (url.pathname === "/place" && p.has("coordinate"))
      return target(p.get("coordinate")!, label);
    // A bare ll or center is only a map viewport, not a destination pin.
    if (p.has("ll") && p.get("q")) return target(p.get("ll")!, label);
    if (p.get("address")) return target(p.get("address")!);
    if (p.get("q")) return target(p.get("q")!);
  }
  if (
    /^(?:www\.|maps\.)?google\.(?:com|de|at|ch|co\.uk)$/.test(host) &&
    (url.pathname.startsWith("/maps") || host.startsWith("maps."))
  ) {
    for (const key of ["destination", "query", "q", "daddr"])
      if (p.get(key)) return target(p.get(key)!);
  }
  return { kind: "unsupported" };
}

/** Pure parsing only: never fetch a shared URL or infer a pin from the viewport. */
export function parseSharedDestination(
  payload: SharePayload,
): SharedDestination {
  const values = [payload.url ?? "", payload.text ?? "", payload.title ?? ""];
  if (values.some((v) => v.length > 8192) || values.every((v) => !v.trim()))
    return { kind: "invalid" };
  for (const value of values) {
    for (const match of value.matchAll(links)) {
      const parsed = mapTarget(match[0]);
      if (parsed.kind !== "unsupported") return parsed;
    }
  }
  for (const value of [payload.text ?? "", payload.title ?? ""]) {
    const text = clean(value.replace(links, ""));
    if (useful(text)) return target(text);
  }
  return { kind: "unsupported" };
}

export function readShareURL(url: URL): SharePayload | undefined {
  if (!shareKeys.some((key) => url.searchParams.has(key))) return;
  return {
    title: url.searchParams.get("shareTitle") ?? "",
    text: url.searchParams.get("shareText") ?? "",
    url: url.searchParams.get("shareUrl") ?? "",
  };
}
