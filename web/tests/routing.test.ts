import { describe, it, expect, vi, afterEach } from "vitest";
import fixture from "./fixtures/swift-parity.json";
import {
  defaults,
  selectJourneys,
  worthwhile,
  validSettings,
  type Journey,
  type RouteRequest,
  type Leg,
} from "../src/model";
import {
  baseVariants,
  mapResponse,
  makeURL,
  retryAfter,
  ApiClient,
} from "../src/transitous";
import { decodePolyline, validateGeometry } from "../src/geometry";
import { planRoutes, seeds, compose } from "../src/planner";
const origin = {
  name: "Start",
  detail: "",
  latitude: 48.132,
  longitude: 11.5756,
};
const destination = {
  name: "Ziel",
  detail: "",
  latitude: 48.175,
  longitude: 11.6,
};
const request: RouteRequest = {
  origin,
  destination,
  timing: "depart",
  time: Date.parse("2026-09-04T08:00:00Z") / 1000,
};
const settings = { ...defaults, maxBikeTransfers: 0 };
// Match the settings used by scripts/Parity.swift, independently of web defaults.
const nativeSettings = { ...settings, foldingDuration: 180 };
const snapshot = (j: Journey) => ({
  id: j.id,
  departure: j.departure,
  arrival: j.arrival,
  transfers: j.transfers,
  isDirect: j.isDirect,
  legs: j.legs.map(({ kind, start, end, distance }) => ({
    kind,
    start,
    end,
    distance,
  })),
});
const mapped = (routingSettings = settings) =>
  mapResponse(fixture.multimodal, request, routingSettings, baseVariants[2])
    .journeys;
afterEach(() => vi.useRealTimers());
describe("Shared Swift fixtures", () => {
  it("matches native multimodal mapping and folding timestamps", () =>
    expect(mapped(nativeSettings).map(snapshot)).toEqual(
      fixture.expectedTransit,
    ));
  it("matches native final selection with direct cycling", () => {
    const all = [
      ...mapped(nativeSettings),
      ...mapResponse(fixture.direct, request, nativeSettings, baseVariants[0])
        .journeys,
    ];
    expect(selectJourneys(all, "depart").map(snapshot)).toEqual(
      fixture.expected,
    );
  });
  for (const scenario of fixture.scenarios)
    it(`matches native ${scenario.timing} with ${scenario.duration}s shared folding`, () => {
      const query = {
        ...request,
        timing: scenario.timing as "depart" | "arrive",
        time: scenario.time,
      };
      const mapped = mapResponse(
        fixture.multimodal,
        query,
        { ...settings, foldingDuration: scenario.duration },
        baseVariants[2],
      ).journeys;
      expect(selectJourneys(mapped, query.timing).map(snapshot)).toEqual(
        scenario.expected,
      );
    });
  it("rejects bike access for a walking-only variant", () =>
    expect(
      mapResponse(fixture.multimodal, request, settings, baseVariants[1])
        .journeys,
    ).toEqual([]));
  it("applies custom fold/unfold durations", () => {
    const j = mapResponse(
      fixture.multimodal,
      request,
      { ...settings, foldingDuration: 60 },
      baseVariants[2],
    ).journeys[0];
    expect(
      j.legs.find((l) => l.kind === "fold")!.end -
        j.legs.find((l) => l.kind === "fold")!.start,
    ).toBe(60);
    expect(j.arrival - mapped()[0].arrival).toBe(-120);
  });
  it("excludes cancelled services", () => {
    const f = structuredClone(fixture.multimodal);
    (f.itineraries[0].legs[1] as any).cancelled = true;
    expect(mapResponse(f, request, settings, baseVariants[2]).journeys).toEqual(
      [],
    );
  });
  it("flags invalid street geometry", () => {
    const f = structuredClone(fixture.multimodal);
    f.itineraries[0].legs[0].legGeometry.points = "!";
    expect(mapResponse(f, request, settings, baseVariants[2]).rejected).toBe(
      true,
    );
  });
});
describe("Requests and service resilience", () => {
  it("adjusts departure and arrival queries around configured folding", () => {
    expect(
      makeURL(request, settings, baseVariants[2]).searchParams.get("time"),
    ).toBe("2026-09-04T08:03:00Z");
    expect(
      makeURL(
        { ...request, timing: "arrive" },
        settings,
        baseVariants[2],
      ).searchParams.get("time"),
    ).toBe("2026-09-04T07:57:00Z");
  });
  it("passes limits, speed and exclusions", () => {
    const u = makeURL(
      request,
      {
        ...settings,
        cyclingSpeedKilometersPerHour: 18,
        excludedTransitModes: ["bus"],
      },
      baseVariants[2],
    );
    expect(u.searchParams.get("cyclingSpeed")).toBe("5.000");
    expect(u.searchParams.get("transitModes")).not.toMatch(/BUS|COACH/);
    expect(u.searchParams.get("maxPreTransitTime")).toBe("1800");
  });
  it("honors Retry-After and sends no automatic HTTP retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      );
    const api = new ApiClient(fetcher);
    await expect(
      api.json(new URL("https://example.test"), new AbortController().signal),
    ).rejects.toMatchObject({ code: "429", stops: true });
    await expect(
      api.json(new URL("https://example.test"), new AbortController().signal),
    ).rejects.toMatchObject({ code: "pause" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("parses seconds and HTTP dates", () => {
    expect(retryAfter("60", 100)).toBe(160);
    expect(retryAfter("Thu, 01 Jan 1970 00:03:00 GMT", 100)).toBe(180);
    expect(retryAfter("bad", 100)).toBeUndefined();
  });
  it("retains successful routes after individual service errors", async () => {
    vi.setSystemTime(request.time * 1000);
    const fetcher = vi.fn(async (url: URL) =>
      url.searchParams.get("directModes") === "BIKE"
        ? new Response(JSON.stringify(fixture.direct))
        : new Response("", { status: 500 }),
    );
    const updates = [];
    for await (const u of planRoutes(
      request,
      settings,
      new AbortController().signal,
      new ApiClient(fetcher as any),
    ))
      updates.push(u);
    expect(updates.at(-1)?.journeys).toHaveLength(1);
    expect(updates.at(-1)?.status).toBe("partial");
  });
  it("does not start requests after cancellation", async () => {
    const c = new AbortController();
    c.abort();
    const fetcher = vi.fn();
    await expect(
      new ApiClient(fetcher).json(new URL("https://example.test"), c.signal),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("Geometry and options", () => {
  it("decodes the published polyline reference", () =>
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5)).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]));
  it("rejects truncated polylines and disconnected street geometry", () => {
    expect(() => decodePolyline("_", 5)).toThrow();
    expect(() =>
      validateGeometry(
        [origin, destination],
        [],
        destination,
        origin,
        false,
        1000,
      ),
    ).toThrow();
  });
  it("permits short walks without a supplied polyline", () =>
    expect(
      validateGeometry(
        [],
        [],
        origin,
        { ...origin, latitude: origin.latitude + 0.0001 },
        true,
        12,
      ),
    ).toHaveLength(2));
  it("rejects out-of-range settings", () => {
    expect(validSettings(defaults)).toBe(true);
    expect(validSettings({ ...defaults, foldingDuration: 0 })).toBe(false);
    expect(
      validSettings({ ...defaults, excludedTransitModes: ["invalid"] }),
    ).toBe(false);
  });
  it("requires material time or cycling-distance benefit", () => {
    const j = mapped()[0],
      d = { ...j, isDirect: true };
    expect(worthwhile({ ...j, arrival: d.arrival - 179 }, d, "depart")).toBe(
      false,
    );
    expect(worthwhile({ ...j, arrival: d.arrival - 180 }, d, "depart")).toBe(
      true,
    );
  });
});
describe("Internal bike connections", () => {
  const a = { ...origin, latitude: 48.14 },
    b = { ...origin, latitude: 48.15 },
    c = { ...origin, latitude: 48.16 };
  const leg = (
    kind: Leg["kind"],
    from = origin,
    to = a,
    start = 0,
    end = 100,
  ): Leg => ({
    kind,
    from,
    to,
    start,
    end,
    distance: kind === "bike" ? 500 : 0,
    coordinates: [from, to],
  });
  const journey = (id: string, legs: Leg[]): Journey => ({
    id,
    origin,
    destination,
    departure: legs[0].start,
    arrival: legs.at(-1)!.end,
    legs,
    transfers: 0,
    isDirect: false,
  });
  it("composes forward, includes folding buffer and rejects disconnected parts", () => {
    const req = { ...request, time: 0 };
    const base = journey("base", [
      leg("transit", origin, a, 0, 100),
      leg("walk", a, destination, 100, 1200),
    ]);
    const seed = seeds([base], req, defaults, 0)[0];
    const part = journey("part", [
      leg("bike", a, b, 460, 760),
      leg("fold", b, b, 760, 940),
      leg("transit", b, destination, 940, 1060),
    ]);
    const result = compose(seed, part, req, defaults);
    expect(result?.legs.map((l) => l.kind)).toEqual([
      "transit",
      "unfold",
      "bike",
      "fold",
      "wait",
      "transit",
    ]);
    expect(result?.transfers).toBe(1);
    expect(
      compose(
        seed,
        {
          ...part,
          legs: [{ ...part.legs[0], from: c }, ...part.legs.slice(1)],
        },
        req,
        defaults,
      ),
    ).toBeUndefined();
  });
  it("composes backwards and respects arrival deadline", () => {
    const req = { ...request, timing: "arrive" as const, time: 2000 };
    const base = journey("base", [
      leg("walk", origin, b, 0, 800),
      leg("transit", b, destination, 1000, 1500),
    ]);
    const seed = seeds([base], req, defaults, 0)[0];
    const part = journey("part", [
      leg("transit", origin, a, 0, 100),
      leg("unfold", a, a, 100, 280),
      leg("bike", a, b, 280, 600),
    ]);
    expect(compose(seed, part, req, defaults)?.legs.map((l) => l.kind)).toEqual(
      ["transit", "unfold", "bike", "fold", "wait", "transit"],
    );
    expect(
      compose(seed, part, { ...req, time: 1400 }, defaults),
    ).toBeUndefined();
  });
});

it("accepts real Berlin route geometry captured from Transitous", async () => {
  const { default: raw } = await import("./fixtures/berlin-direct.json");
  const req: RouteRequest = {
    origin: { name: "Start", detail: "", latitude: 52.52, longitude: 13.405 },
    destination: {
      name: "Ziel",
      detail: "",
      latitude: 52.51,
      longitude: 13.43,
    },
    timing: "depart",
    time: Date.parse(raw.direct[0].startTime) / 1000,
  };
  const result = mapResponse(raw, req, settings, baseVariants[0]);
  expect(result.rejected).toBe(false);
  expect(result.journeys).toHaveLength(1);
  expect(result.journeys[0].legs[0].coordinates.length).toBeGreaterThan(2);
});

it("accepts real Berlin transit and station access geometry", async () => {
  const { default: raw } = await import("./fixtures/berlin-transit.json");
  const req: RouteRequest = {
    origin: { name: "Start", detail: "", latitude: 52.52, longitude: 13.405 },
    destination: { name: "Ziel", detail: "", latitude: 52.4, longitude: 13.6 },
    timing: "depart",
    time: Date.parse(raw.itineraries[0].startTime) / 1000 - 180,
  };
  const batch = mapResponse(raw, req, defaults, baseVariants[2]);
  expect(batch.rejected).toBe(false);
  expect(batch.journeys).toHaveLength(1);
  expect(batch.journeys[0].legs.some((l) => l.kind === "transit")).toBe(true);
  expect(batch.journeys[0].legs.some((l) => l.kind === "fold")).toBe(true);
});
