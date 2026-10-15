import { describe, expect, it } from "vitest";
import { detailGroups, detailTime } from "../src/journey-detail";
import type { Journey, Leg, LegKind } from "../src/model";
const place = { name: "Pasing", detail: "", latitude: 48, longitude: 11 };
const leg = (kind: LegKind, start: number, end: number): Leg => ({
  kind,
  from: place,
  to: place,
  start,
  end,
  distance: 0,
  coordinates: [place],
});
const journey = (legs: Leg[]): Journey => ({
  id: "test",
  origin: place,
  destination: place,
  departure: legs[0].start,
  arrival: legs.at(-1)!.end,
  legs,
  transfers: 1,
  isDirect: false,
});

describe("open journey detail groups", () => {
  it("keeps every real step once, groups preparation and does not mutate routing data", () => {
    const input = journey([
      leg("bike", 0, 600),
      leg("fold", 600, 780),
      leg("transit", 780, 1800),
      leg("unfold", 1800, 1980),
      leg("bike", 1980, 2400),
    ]);
    const before = structuredClone(input);
    const groups = detailGroups(input);
    expect(groups.map((g) => g.map((l) => l.kind))).toEqual([
      ["bike"],
      ["fold", "transit"],
      ["unfold", "bike"],
    ]);
    expect(groups.flat()).toEqual(input.legs);
    expect(input).toEqual(before);
  });
  it("adds only uncovered gaps and never duplicates explicit waiting", () => {
    const groups = detailGroups(
      journey([
        leg("transit", 0, 600),
        leg("wait", 600, 900),
        leg("walk", 900, 1020),
        leg("transit", 1140, 1800),
      ]),
    );
    expect(
      groups
        .flat()
        .filter((l) => l.kind === "wait")
        .map((l) => [l.start, l.end]),
    ).toEqual([
      [600, 900],
      [1020, 1140],
    ]);
    expect(
      detailGroups(
        journey([
          leg("wait", 0, 600),
          leg("fold", 100, 200),
          leg("transit", 600, 900),
        ]),
      )
        .flat()
        .filter((l) => l.kind === "wait"),
    ).toHaveLength(1);
  });
  it("keeps stop boundaries and trailing preparation", () => {
    expect(
      detailGroups(
        journey([
          leg("fold", 0, 180),
          leg("stop", 180, 780),
          leg("unfold", 780, 960),
          leg("bike", 960, 1200),
          leg("wait", 1200, 1260),
        ]),
      ).map((g) => g.map((l) => l.kind)),
    ).toEqual([["fold"], ["stop"], ["unfold", "bike"], ["wait"]]);
  });
  it("keeps a direct bike ride as a single step", () => {
    const input = journey([leg("bike", 0, 900)]);
    expect(detailGroups(input)).toEqual([input.legs]);
  });
  it("adds dates to both sides of a midnight crossing", () => {
    const start = new Date(2026, 9, 15, 23, 50).getTime() / 1000;
    const end = new Date(2026, 9, 16, 0, 20).getTime() / 1000;
    const input = journey([leg("transit", start, end)]);
    expect(detailTime(input, start)).toMatch(/15\..*23:50/);
    expect(detailTime(input, end)).toMatch(/16\..*00:20/);
    expect(detailTime(journey([leg("bike", start, start + 60)]), start)).toBe(
      "23:50",
    );
  });
});
