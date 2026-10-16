import type { Journey, Leg } from "./model";
import { kindNames } from "./model";
import { detailGroups } from "./journey-detail";

export interface NavigationSection {
  id: string;
  main: Leg;
  legs: Leg[];
}

const mainStep = (leg: Leg) => leg.kind !== "wait";

/** Every action has its own tab; waiting stays with a neighbouring step. */
export function navigationSections(journey: Journey): NavigationSection[] {
  const groups: Leg[][] = [];
  let pending: Leg[] = [];
  for (const leg of detailGroups(journey).flat()) {
    if (!mainStep(leg)) {
      pending.push(leg);
      continue;
    }
    // Waiting before a planned stop must not become part of its stay.
    if (leg.kind === "stop" && groups.length && pending.length) {
      groups.at(-1)!.push(...pending);
      pending = [];
    }
    groups.push([...pending, leg]);
    pending = [];
  }
  if (pending.length) {
    if (groups.length) groups.at(-1)!.push(...pending);
    else groups.push(pending);
  }
  return groups.map((legs) => {
    const main = legs.find(mainStep) ?? legs[0];
    if (!main.navigationId)
      throw new Error("Navigation section requires a stable leg ID");
    return { id: main.navigationId, main, legs };
  });
}

export function sectionLabel(section: NavigationSection): string {
  const leg = section.main;
  return leg.kind === "transit" ? leg.line || "ÖPNV" : kindNames[leg.kind];
}
