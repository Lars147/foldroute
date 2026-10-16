import { describe, expect, it } from "vitest";
import type { Journey, Leg, LegKind } from "../src/model";
import { navigationSections, sectionLabel } from "../src/navigation-sections";

const place = { name: "Bahnhof", detail: "", latitude: 48, longitude: 11 };
function journey(kinds: LegKind[]): Journey {
  const legs: Leg[] = kinds.map((kind, index) => ({
    navigationId: `leg-${index}`,
    kind,
    from: place,
    to: place,
    start: index * 120,
    end: (index + 1) * 120,
    distance: 0,
    coordinates: [place],
  }));
  return {
    id: "sections",
    origin: place,
    destination: place,
    departure: 0,
    arrival: legs.at(-1)!.end,
    legs,
    transfers: 1,
    isDirect: false,
  };
}

describe("navigation sections", () => {
  it("maps folding and unfolding to stable peer tabs without changing progress data", () => {
    const route = journey([
      "bike",
      "fold",
      "wait",
      "transit",
      "unfold",
      "bike",
    ]);
    const before = structuredClone(route);
    const sections = navigationSections(route);
    expect(sections.map((s) => s.legs.map((l) => l.kind))).toEqual([
      ["bike"],
      ["fold"],
      ["wait", "transit"],
      ["unfold"],
      ["bike"],
    ]);
    expect(sections.map((s) => s.id)).toEqual([
      "leg-0",
      "leg-1",
      "leg-3",
      "leg-4",
      "leg-5",
    ]);
    for (const leg of route.legs) {
      expect(sections.filter((s) => s.legs.includes(leg))).toHaveLength(1);
    }
    expect(route).toEqual(before);
  });

  it("keeps each transit line, walking transfer and stop distinct", () => {
    const route = journey([
      "bike",
      "fold",
      "transit",
      "walk",
      "wait",
      "transit",
      "stop",
      "unfold",
      "bike",
    ]);
    route.legs[2].line = "S6";
    route.legs[5].line = "U3";
    const sections = navigationSections(route);
    expect(sections.map(sectionLabel)).toEqual([
      "Rad",
      "Falten",
      "S6",
      "Zu Fuß",
      "U3",
      "Zwischenziel",
      "Entfalten",
      "Rad",
    ]);
    expect(sections[4].legs.map((l) => l.kind)).toEqual(["wait", "transit"]);
    expect(sections[6].legs.map((l) => l.kind)).toEqual(["unfold"]);
  });

  it("retains folding around stops and attaches trailing waiting to the last section", () => {
    const route = journey([
      "fold",
      "stop",
      "unfold",
      "bike",
      "fold",
      "stop",
      "wait",
    ]);
    expect(
      navigationSections(route).map((s) => s.legs.map((l) => l.kind)),
    ).toEqual([
      ["fold"],
      ["stop"],
      ["unfold"],
      ["bike"],
      ["fold"],
      ["stop", "wait"],
    ]);
  });

  it("includes uncovered waits only once and keeps IDs through realtime updates", () => {
    const route = journey(["bike", "fold", "transit"]);
    route.legs[2].start += 90;
    route.legs[2].end += 90;
    const first = navigationSections(route);
    expect(first[2].legs.map((l) => l.kind)).toEqual(["wait", "transit"]);
    const revised = structuredClone(route);
    revised.legs[2].platform = "4";
    revised.legs[2].start += 60;
    expect(navigationSections(revised).map((s) => s.id)).toEqual(
      first.map((s) => s.id),
    );
  });

  it("keeps unfolding selectable at the end of a route", () => {
    const sections = navigationSections(journey(["unfold", "wait"]));
    expect(sections).toHaveLength(1);
    expect(sectionLabel(sections[0])).toBe("Entfalten");
  });

  it("keeps waits at stop boundaries and before folding in the correct order", () => {
    const route = journey([
      "bike",
      "wait",
      "stop",
      "wait",
      "unfold",
      "bike",
      "wait",
    ]);
    expect(
      navigationSections(route).map((section) =>
        section.legs.map((leg) => leg.kind),
      ),
    ).toEqual([
      ["bike", "wait"],
      ["stop"],
      ["wait", "unfold"],
      ["bike", "wait"],
    ]);
    const gap = journey(["bike", "fold", "transit"]);
    gap.legs[1].start += 60;
    expect(navigationSections(gap)[1].legs.map((leg) => leg.kind)).toEqual([
      "wait",
      "fold",
    ]);
  });

  it("keeps a waiting-only remainder accessible", () => {
    const sections = navigationSections(journey(["wait"]));
    expect(sections).toHaveLength(1);
    expect(sectionLabel(sections[0])).toBe("Warten");
  });
});
