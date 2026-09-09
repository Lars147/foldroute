import { describe, expect, it } from "vitest";
import { defaults } from "../src/model";
import { readRouteURL, routeURL, type RouteLink } from "../src/route-url";
const plan: RouteLink = {
  request: {
    origin: {
      latitude: 48.149853,
      longitude: 11.461872,
      name: "Pasing & West",
      detail: "München",
    },
    destination: {
      latitude: 48.149143,
      longitude: 11.649353,
      name: "Gräfelfing / Bahnhofstr. 3a",
      detail: "",
    },
    timing: "depart",
    time: Date.parse("2026-09-09T12:06:00Z") / 1000,
  },
  settings: {
    ...defaults,
    maxCyclingMinutes: 17,
    excludedTransitModes: ["bus", "tram"],
  },
};
describe("planning links", () => {
  it("round trips named endpoints, UTC time and every routing option under a subpath", () => {
    const url = routeURL("https://example.org/foldroute/plan/", plan);
    expect(url.pathname).toBe("/foldroute/plan/");
    const parsed = readRouteURL(url);
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") throw new Error("Expected plan");
    expect(parsed.plan).toEqual({
      ...plan,
      request: {
        ...plan.request,
        origin: { ...plan.request.origin, detail: "" },
      },
    });
    expect(routeURL(url, parsed.plan).href).toBe(url.href);
  });
  it("preserves arrival mode and represents now without a frozen timestamp", () => {
    expect(
      readRouteURL(
        routeURL("https://example.org/", {
          ...plan,
          request: { ...plan.request, timing: "arrive" },
        }),
      ),
    ).toMatchObject({
      kind: "plan",
      plan: { request: { timing: "arrive", time: plan.request.time } },
    });
    const url = routeURL("https://example.org/", {
      ...plan,
      request: { ...plan.request, timing: "now" },
    });
    expect(url.searchParams.has("time")).toBe(false);
    expect(readRouteURL(url)).toMatchObject({
      kind: "plan",
      plan: { request: { timing: "now", time: 0 } },
    });
  });
  it("turns both current-location labels into fixed points", () => {
    const url = routeURL("https://example.org/", {
      ...plan,
      request: {
        ...plan.request,
        origin: { ...plan.request.origin, name: "Aktueller Standort" },
        destination: {
          ...plan.request.destination,
          name: "Aktueller Standort",
        },
      },
    });
    expect(readRouteURL(url)).toMatchObject({
      kind: "plan",
      plan: {
        request: {
          origin: { name: "Startpunkt" },
          destination: { name: "Zielpunkt" },
        },
      },
    });
  });
  it.each([
    ["v", "2"],
    ["from", "91,11"],
    ["to", "NaN,11"],
    ["from", ",11"],
    ["timing", "later"],
    ["time", "not-a-date"],
    ["time", "2026-02-30T12:00:00Z"],
    ["time", "2026-09-09T12:06:00"],
    ["maxCyclingMinutes", ""],
    ["maxCyclingMinutes", "61"],
    ["foldingDuration", "61"],
    ["excludedTransitModes", "plane"],
  ])("rejects invalid %s = %s", (key, value) => {
    const url = routeURL("https://example.org/", plan);
    url.searchParams.set(key, value);
    expect(readRouteURL(url)).toEqual({ kind: "invalid" });
  });
  it("rejects incomplete and duplicate fields without filling personal defaults", () => {
    const url = routeURL("https://example.org/", plan);
    url.searchParams.delete("maxWalkingMinutes");
    expect(readRouteURL(url)).toEqual({ kind: "invalid" });
    const duplicate = routeURL("https://example.org/", plan);
    duplicate.searchParams.append("from", "1,1");
    expect(readRouteURL(duplicate)).toEqual({ kind: "invalid" });
  });
  it("clears only route parameters and preserves unrelated query parameters and anchors", () => {
    const url = routeURL(
      "https://example.org/plan/?utm_source=test#main",
      plan,
    );
    const empty = routeURL(url);
    expect(empty.href).toBe("https://example.org/plan/?utm_source=test#main");
    expect(readRouteURL(empty)).toEqual({ kind: "none" });
  });
});
