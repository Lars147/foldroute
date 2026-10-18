import { describe, expect, it } from "vitest";
import { routeHitTest } from "../src/route-hit-test";

describe("route hit targets", () => {
  for (const radius of [12, 22]) {
    it(`includes the ${radius}px boundary and rejects points outside it`, () => {
      expect(
        routeHitTest([{ id: "alternative", distance: radius }], radius),
      ).toEqual({ kind: "route", id: "alternative" });
      expect(
        routeHitTest([{ id: "alternative", distance: radius + 0.01 }], radius),
      ).toEqual({ kind: "background" });
    });
  }

  it("groups legs by journey before deciding whether a hit is ambiguous", () => {
    expect(
      routeHitTest(
        [
          { id: "alternative", distance: 8 },
          { id: "alternative", distance: 1 },
          { id: "selected", distance: 6 },
        ],
        12,
      ),
    ).toEqual({ kind: "route", id: "alternative" });
  });

  it("uses nearest geometry rather than drawing order or selected status", () => {
    const legs = [
      { id: "alternative", distance: 1 },
      { id: "selected", distance: 5 },
      { id: "other", distance: 11 },
    ];
    for (const order of [legs, [...legs].reverse()])
      expect(routeHitTest(order, 12)).toEqual({
        kind: "route",
        id: "alternative",
      });
  });

  it("preserves selection when it belongs to shared segments or near ties within 3px", () => {
    for (const gap of [0, 2.99, 3]) {
      const legs = [
        { id: "one", distance: 4 },
        { id: "two", distance: 4 + gap },
      ];
      for (const order of [legs, [...legs].reverse()])
        for (const selected of ["one", "two"])
          expect(routeHitTest(order, 22, selected)).toEqual({
            kind: "ambiguous",
          });
    }
    expect(
      routeHitTest(
        [
          { id: "one", distance: 4 },
          { id: "two", distance: 7.01 },
        ],
        22,
        "two",
      ),
    ).toEqual({ kind: "route", id: "one" });
  });

  it("makes overlapping alternatives selectable when current selection is elsewhere", () => {
    const legs = [
      { id: "first-result", distance: 2 },
      { id: "closer-result", distance: 0 },
      { id: "selected", distance: 8 },
    ];
    expect(routeHitTest(legs, 12, "selected")).toEqual({
      kind: "route",
      id: "first-result",
    });
    expect(routeHitTest(legs, 12)).toEqual({
      kind: "route",
      id: "first-result",
    });
    expect(routeHitTest([...legs].reverse(), 12, "selected")).toEqual({
      kind: "route",
      id: "closer-result",
    });
    expect(
      routeHitTest(
        [
          { id: "one", distance: 4 },
          { id: "two", distance: 4 },
          { id: "three", distance: 4 },
          { id: "selected", distance: 30 },
        ],
        22,
        "selected",
      ),
    ).toEqual({ kind: "route", id: "one" });
  });

  it("still prefers clearly nearer alternatives over result order", () => {
    expect(
      routeHitTest(
        [
          { id: "first-result", distance: 4 },
          { id: "closer-result", distance: 0 },
          { id: "selected", distance: 8 },
        ],
        12,
        "selected",
      ),
    ).toEqual({ kind: "route", id: "closer-result" });
  });

  it("ignores other routes outside the target and unrendered or empty geometry", () => {
    expect(
      routeHitTest(
        [
          { id: "one", distance: 11 },
          { id: "two", distance: 13 },
          { id: "offscreen", distance: Infinity },
        ],
        12,
      ),
    ).toEqual({ kind: "route", id: "one" });
    expect(routeHitTest([], 22)).toEqual({ kind: "background" });
    expect(routeHitTest([{ id: "offscreen", distance: Infinity }], 22)).toEqual(
      { kind: "background" },
    );
  });
});
