import { describe, expect, it } from "vitest";
import cases from "./fixtures/shared-destinations.json";
import {
  parseSharedDestination,
  readShareURL,
} from "../src/shared-destination";

describe("shared destinations (same fixtures as iOS)", () => {
  for (const fixture of cases)
    it(fixture.name, () => {
      const result = parseSharedDestination(fixture.payload);
      const normalized =
        result.kind === "place"
          ? {
              kind: result.kind,
              latitude: result.place.latitude,
              longitude: result.place.longitude,
              name: result.place.name,
            }
          : result;
      expect(normalized).toEqual(fixture.expected);
    });
  it("keeps inbound sharing separate from existing route links", () => {
    expect(
      readShareURL(new URL("https://example.com/plan/?to=48,11&toName=Ziel")),
    ).toBeUndefined();
    expect(
      readShareURL(
        new URL("https://example.com/plan/?shareText=Stra%C3%9Fe+1"),
      ),
    ).toEqual({ title: "", text: "Straße 1", url: "" });
  });
});
