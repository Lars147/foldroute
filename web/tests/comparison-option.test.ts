import { describe, expect, it } from "vitest";
import {
  defaults,
  migrateSettings,
  retainSelectedJourney,
  selectJourneys,
  type Journey,
} from "../src/model";
import { readRouteURL, routeURL } from "../src/route-url";
const place = { name: "Ort", detail: "", latitude: 48.1, longitude: 11.5 };
function journey(id: string, minutes: number, direct = false): Journey {
  return {
    id,
    origin: place,
    destination: place,
    departure: 0,
    arrival: minutes * 60,
    transfers: 0,
    isDirect: direct,
    legs: [
      {
        kind: direct ? "bike" : "transit",
        from: place,
        to: place,
        start: 0,
        end: minutes * 60,
        distance: direct ? 10000 : 0,
        coordinates: [place],
      },
    ],
  };
}
const regular = [
  journey("a", 90),
  journey("b", 95),
  journey("c", 100),
  journey("d", 105),
];
const long = journey("comparison", 46, true);
describe("optional fourth cycling comparison", () => {
  for (const timing of ["depart", "arrive"] as const) {
    it(`adds a comparison after three regular results for ${timing}`, () => {
      const selected = selectJourneys([...regular, long], timing, 4, 30);
      expect(selected.map((j) => j.id)).toEqual(["a", "b", "c", "comparison"]);
      expect(selectJourneys(regular, timing)).toHaveLength(3);
      expect(selectJourneys([long], timing, 4, 30)).toEqual([long]);
      expect(selectJourneys([regular[0], long], timing, 1, 30)).toEqual([
        regular[0],
      ]);
    });
  }
  it("disables only over-limit comparisons, including when no other route exists", () => {
    expect(selectJourneys([...regular, long], "depart", 4, 30, false)).toEqual(
      regular.slice(0, 3),
    );
    expect(selectJourneys([long], "depart", 4, 30, false)).toEqual([]);
    for (const minutes of [29.99, 30]) {
      const short = journey("short", minutes, true);
      expect(selectJourneys([long, short], "depart", 4, 30, false)).toEqual([
        short,
      ]);
    }
    expect(
      selectJourneys([journey("over", 30.01, true)], "depart", 4, 30, false),
    ).toEqual([]);
  });
  it("retains either manual selection without removing the fourth slot or adding regular slots", () => {
    const selected = journey("chosen", 110);
    expect(
      retainSelectedJourney(
        [...regular.slice(0, 3), long],
        selected,
        30,
        true,
      ).map((j) => j.id),
    ).toEqual(["chosen", "a", "b", "comparison"]);
    expect(retainSelectedJourney(regular, long, 30, true)).toEqual([
      ...regular.slice(0, 3),
      long,
    ]);
    expect(retainSelectedJourney(regular, long, 30, false)).toEqual(
      regular.slice(0, 3),
    );
  });
  it("reads older settings without resetting other values", () => {
    const { showCyclingComparison, ...old } = {
      ...defaults,
      maxCyclingMinutes: 17,
    };
    const { foldingDuration, ...legacy } = old;
    expect(
      migrateSettings({ ...legacy, foldDuration: 180, unfoldDuration: 120 }),
    ).toEqual({ ...old, showCyclingComparison: true });
    expect(migrateSettings(old)).toEqual({
      ...old,
      showCyclingComparison: true,
    });
    expect(
      migrateSettings({ ...old, showCyclingComparison: false })
        ?.showCyclingComparison,
    ).toBe(false);
    expect(
      migrateSettings({ ...old, showCyclingComparison: "false" }),
    ).toBeUndefined();
  });
  it("round trips disabled links and defaults old links to enabled", () => {
    const url = routeURL("https://example.org/plan/", {
      request: { origin: place, destination: place, time: 0, timing: "now" },
      settings: { ...defaults, showCyclingComparison: false },
    });
    expect(readRouteURL(url)).toMatchObject({
      kind: "plan",
      plan: { settings: { showCyclingComparison: false } },
    });
    url.searchParams.delete("showCyclingComparison");
    expect(readRouteURL(url)).toMatchObject({
      kind: "plan",
      plan: { settings: { showCyclingComparison: true } },
    });
    url.searchParams.set("showCyclingComparison", "no");
    expect(readRouteURL(url)).toEqual({ kind: "invalid" });
  });
});
