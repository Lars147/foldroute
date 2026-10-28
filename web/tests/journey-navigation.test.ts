import { describe, expect, it } from "vitest";
import { normalizeJourneyNavigation } from "../src/journey-view";

describe("journey history migration", () => {
  it("starts on the map without opening an empty alternatives sheet", () => {
    expect(normalizeJourneyNavigation()).toEqual({
      screen: "map",
      savedOrigin: undefined,
      positions: {},
    });
    expect(
      normalizeJourneyNavigation({ screen: "list", positions: {} }).sheet,
    ).toBeUndefined();
  });

  it("moves the former result list into the alternatives sheet", () => {
    expect(
      normalizeJourneyNavigation(
        {
          screen: "list",
          positions: { list: 120 },
        },
        "selected",
        true,
      ).sheet,
    ).toEqual({ mode: "alternatives", scrollTop: 120 });
  });

  it("restores a former detail page and its reading position", () => {
    expect(
      normalizeJourneyNavigation(
        {
          screen: "detail",
          savedOrigin: "history",
          positions: { "detail:selected": 240 },
        },
        "selected",
        true,
      ),
    ).toEqual({
      screen: "map",
      savedOrigin: "history",
      positions: { "detail:selected": 240 },
      sheet: { mode: "detail", journeyId: "selected", scrollTop: 240 },
    });
  });

  it("keeps a legacy preview separate from the selected route", () => {
    expect(
      normalizeJourneyNavigation(
        {
          screen: "map",
          positions: {},
          alternatives: { previewId: "other", scrollTop: 80 },
        },
        "selected",
        true,
      ).sheet,
    ).toEqual({
      mode: "preview",
      journeyId: "other",
      scrollTop: 0,
      listScrollTop: 80,
    });
  });

  it("copies current sheet state without changing a history snapshot", () => {
    const snapshot = {
      screen: "map" as const,
      positions: { desktop: 20 },
      sheet: { mode: "detail" as const, journeyId: "selected", scrollTop: 60 },
    };
    const restored = normalizeJourneyNavigation(snapshot);
    restored.sheet!.scrollTop = 90;
    restored.positions.desktop = 40;
    expect(snapshot.sheet.scrollTop).toBe(60);
    expect(snapshot.positions.desktop).toBe(20);
  });
});
