import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaults,
  migrateSettings,
  lateDepartureDelay,
  selectJourneys,
  type Journey,
  type RouteRequest,
} from "../src/model";
import { updatedPlaces, type StoredPlace } from "../src/places";
import { validSnapshot } from "../src/offline";
import { PlanningSession } from "../src/planning-state";
import { planRoutes } from "../src/planner";
import { ApiClient } from "../src/transitous";
vi.mock("../src/planner", () => ({ planRoutes: vi.fn() }));
vi.mock("../src/search", () => ({ locate: vi.fn() }));

const origin = {
  name: "Start",
  detail: "Adresse",
  latitude: 48.13,
  longitude: 11.57,
};
const destination = { ...origin, name: "Ziel", latitude: 48.18 };
const request: RouteRequest = {
  origin,
  destination,
  timing: "depart",
  time: 1000,
};
const journey = (id: string, departure = 1000, arrival = 2000): Journey => ({
  id,
  origin,
  destination,
  departure,
  arrival,
  transfers: 0,
  isDirect: true,
  legs: [
    {
      kind: "bike",
      from: origin,
      to: destination,
      start: departure,
      end: arrival,
      distance: 5000,
      coordinates: [origin, destination],
    },
  ],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("settings migration and archived snapshots", () => {
  it("merges the larger legacy duration while retaining other preferences", () => {
    const { foldingDuration, ...rest } = defaults;
    expect(
      migrateSettings({ ...rest, foldDuration: 180, unfoldDuration: 120 }),
    ).toEqual(defaults);
    expect(
      migrateSettings({
        ...rest,
        foldDuration: 60,
        unfoldDuration: 150,
        maxWalkingMinutes: 7,
      }),
    ).toEqual({ ...defaults, foldingDuration: 150, maxWalkingMinutes: 7 });
    expect(
      migrateSettings({ ...rest, foldDuration: 0, unfoldDuration: 120 }),
    ).toBeUndefined();
  });
  it("reads version 1 without rewriting its settings or journey", () => {
    const { foldingDuration, ...rest } = defaults;
    const snapshot = {
      version: 1,
      savedAt: 1000,
      request,
      journey: journey("old"),
      settings: { ...rest, foldDuration: 180, unfoldDuration: 120 },
    };
    const original = structuredClone(snapshot);
    expect(validSnapshot(snapshot)).toBe(true);
    expect(snapshot).toEqual(original);
    expect(validSnapshot({ ...snapshot, version: 2 })).toBe(false);
  });
});

describe("places", () => {
  it("favoriting does not mark use; unfavoriting unused entries removes them", () => {
    const entries = updatedPlaces([], origin, "favorite", 100);
    expect(entries[0]).toMatchObject({ favorite: true, lastUsedAt: undefined });
    expect(updatedPlaces(entries, origin, "favorite", 200)).toEqual([]);
  });
  it("deduplicates nearby named places and keeps stop identity", () => {
    const entries = updatedPlaces(
      [],
      { ...origin, stopId: "station" },
      "use",
      100,
    );
    const result = updatedPlaces(
      entries,
      { ...origin, latitude: origin.latitude + 0.0001 },
      "favorite",
      200,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      favorite: true,
      lastUsedAt: 100,
      place: { stopId: "station" },
    });
  });
  it("limits recents to 20 without deleting favorites", () => {
    let entries: StoredPlace[] = updatedPlaces([], origin, "favorite", 0);
    for (let i = 1; i <= 25; i++)
      entries = updatedPlaces(
        entries,
        { ...origin, name: `Ort ${i}` },
        "use",
        i,
      );
    expect(entries).toHaveLength(21);
    expect(entries.some((e) => e.favorite && e.place.name === "Start")).toBe(
      true,
    );
    expect(entries.some((e) => e.place.name === "Ort 1")).toBe(false);
    expect(
      updatedPlaces(
        entries,
        { ...origin, name: "Aktueller Standort" },
        "favorite",
        100,
      ),
    ).toEqual(entries);
  });
});

describe("selection and delayed departures", () => {
  it("ranks by earliest arrival / latest departure rather than duration", () => {
    const early = journey("early", 1000, 2000),
      short = journey("short", 1800, 2100);
    expect(selectJourneys([short, early], "depart")[0].id).toBe("early");
    expect(selectJourneys([short, early], "arrive")[0].id).toBe("short");
  });
  it("uses a fixed request and the inclusive 60-minute boundary", () => {
    expect(
      lateDepartureDelay(journey("a", 4599, 5000), request),
    ).toBeUndefined();
    expect(lateDepartureDelay(journey("a", 4600, 5000), request)).toBe(3600);
    expect(
      lateDepartureDelay(journey("a", 4600, 5000), {
        ...request,
        timing: "now",
      }),
    ).toBe(3600);
    expect(
      lateDepartureDelay(journey("a", 4600, 5000), {
        ...request,
        timing: "arrive",
      }),
    ).toBeUndefined();
  });
  for (const manual of [false, true])
    it(`preserves selection only when manual=${manual}`, async () => {
      vi.stubGlobal("navigator", { onLine: true });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const old = journey("old", 1000, 3760),
        better = journey("better", 1000, 1900);
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield { journeys: [old], status: "searching", issues: [] };
        await gate;
        yield { journeys: [better], status: "complete", issues: [] };
      });
      const session = new PlanningSession(new ApiClient(), () => {});
      const task = session.calculate(request, defaults, false);
      await vi.waitFor(() => expect(session.state.selected?.id).toBe("old"));
      if (manual) session.select("old");
      release();
      await task;
      expect(session.state.selected?.id).toBe(manual ? "old" : "better");
      expect(session.state.journeys.map((j) => j.id)).toEqual(
        manual ? ["better", "old"] : ["better"],
      );
    });
  it("settings invalidation rejects late responses and retains retry context", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield { journeys: [journey("old")], status: "searching", issues: [] };
      await gate;
      yield { journeys: [journey("late")], status: "complete", issues: [] };
    });
    const session = new PlanningSession(new ApiClient(), () => {});
    const task = session.calculate(request, defaults, false);
    await vi.waitFor(() => expect(session.state.selected).toBeDefined());
    session.invalidateForSettings();
    release();
    await task;
    expect(session.state.journeys).toEqual([]);
    expect(session.state.request).toEqual(request);
    vi.mocked(planRoutes).mockImplementation(async function* () {
      throw new Error("offline");
    });
    await session.calculate(
      request,
      { ...defaults, foldingDuration: 240 },
      false,
    );
    expect(session.state.selected).toBeUndefined();
    expect(session.state.request).toEqual(request);
    expect(session.state.message).toBe("offline");
  });
});
