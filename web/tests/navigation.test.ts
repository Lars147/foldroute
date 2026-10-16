import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  NavigationEngine,
  navigationJourney,
  projectPath,
  headingDelta,
  freshTransit,
} from "../src/navigation-engine";
import {
  applyTransit,
  matchTrip,
  transitDisruption,
  TransitRefresher,
  transitRetryDelay,
} from "../src/transit-refresh";
import { validNavigationSnapshot } from "../src/navigation-store";
import {
  defaults,
  transition,
  type Journey,
  type Leg,
  type Place,
} from "../src/model";
import { NavigationSession } from "../src/navigation-session";
import type { NavigationStore } from "../src/navigation-store";
import { ApiClient } from "../src/transitous";
import { clock } from "../src/ui";
import {
  assessConnection,
  blocksNavigation,
} from "../src/connection-assessment";
const now = Date.parse("2026-10-06T10:00:00Z") / 1000;
const place = (longitude: number, latitude = 48): Place => ({
  name: `Ort ${longitude}`,
  detail: "",
  latitude,
  longitude,
});
const a = place(11),
  b = place(11.002),
  c = place(11.002, 48.002);
const bike = (): Leg => ({
  kind: "bike",
  from: a,
  to: c,
  start: now,
  end: now + 180,
  distance: 370,
  coordinates: [a, b, c],
  maneuvers: [
    {
      direction: "DEPART",
      streetName: "Erste Straße",
      distance: 149,
      coordinates: [a, b],
    },
    {
      direction: "LEFT",
      streetName: "Zweite Straße",
      distance: 222,
      coordinates: [b, c],
    },
  ],
});
const journey = (legs: Leg[] = [bike()]): Journey =>
  navigationJourney({
    id: "journey",
    origin: legs[0].from,
    destination: legs.at(-1)!.to,
    departure: legs[0].start,
    arrival: legs.at(-1)!.end,
    legs,
    transfers: 0,
    isDirect: legs.every((l) => l.kind !== "transit"),
  });
const fix = (point = a, seconds = 0, accuracy = 10) => ({
  ...point,
  accuracy,
  timestamp: (now + seconds) * 1000,
});
const ref = {
  tripId: "trip",
  fromId: "A",
  toId: "C",
  scheduledDeparture: now + 300,
  scheduledArrival: now + 900,
};
const train = (): Leg => ({
  kind: "transit",
  from: { ...c, stopId: "A" },
  to: { ...place(11.02), stopId: "C" },
  start: now + 300,
  end: now + 900,
  distance: 0,
  coordinates: [c, place(11.02)],
  line: "S1",
  transitReference: ref,
  transitStatus: { updatedAt: now },
  realtime: true,
});
const iso = (t: number) => new Date(t * 1000).toISOString();
const trip = () => ({
  legs: [
    {
      from: {
        stopId: "A",
        scheduledDeparture: iso(ref.scheduledDeparture),
        departure: iso(ref.scheduledDeparture + 60),
        track: "3",
      },
      to: {
        stopId: "C",
        scheduledArrival: iso(ref.scheduledArrival),
        arrival: iso(ref.scheduledArrival + 90),
      },
      realTime: true,
    },
  ],
});
it("preserves scheduled times when realtime predictions recover", () => {
  let route = journey([
    {
      ...train(),
      scheduledStart: ref.scheduledDeparture,
      scheduledEnd: ref.scheduledArrival,
    },
  ]);
  for (const minutes of [15, 5, 0]) {
    route = applyTransit(
      route,
      0,
      new Map([
        [
          route.legs[0].navigationId!,
          {
            kind: "updated",
            update: {
              departure: ref.scheduledDeparture + minutes * 60,
              arrival: ref.scheduledArrival + minutes * 60,
              realtime: true,
              cancelled: false,
              updatedAt: now,
            },
          },
        ],
      ]),
    );
    expect(route.legs[0]).toMatchObject({
      start: ref.scheduledDeparture + minutes * 60,
      end: ref.scheduledArrival + minutes * 60,
      scheduledStart: ref.scheduledDeparture,
      scheduledEnd: ref.scheduledArrival,
      transitReference: ref,
    });
  }
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("measures distance to segments rather than sparse vertices", () => {
  expect(projectPath(place(11.001), [a, b]).distance).toBeLessThan(0.01);
  expect(headingDelta(359, 1)).toBe(2);
});
it("instructs the next turn at its beginning and advances after reaching it", () => {
  const e = new NavigationEngine(journey());
  expect(e.instruction).toBe("Links abbiegen auf Zweite Straße");
  e.update(fix(a), now * 1000);
  expect(e.distanceToNext).toBeGreaterThan(140);
  e.update(fix(b, 10), (now + 10) * 1000);
  expect(e.instruction).toBe(`Mit dem Rad nach ${c.name}`);
  e.update(fix(c, 30), (now + 30) * 1000);
  expect(e.phase).toBe("arrived");
});
it("rejects noisy, stale and duplicate GPS and only reroutes on three reliable samples", () => {
  const e = new NavigationEngine(journey()),
    away = place(11.01, 48.01);
  expect(e.update(fix(away, 0, 120), now * 1000)).toBe(false);
  expect(e.update(fix(away, 1), (now + 1) * 1000)).toBe(false);
  expect(e.update(fix(away, 1), (now + 1) * 1000)).toBe(false);
  expect(e.update(fix(away, 2), (now + 2) * 1000)).toBe(false);
  expect(e.update(fix(away, 3), (now + 3) * 1000)).toBe(true);
  e.update(fix(away, 4), (now + 100) * 1000);
  expect(e.distanceToNext).toBeUndefined();
});
it("does not jump to the end of a loop at its starting point", () => {
  const l = {
    ...bike(),
    to: a,
    coordinates: [a, b, c, a],
    maneuvers: undefined,
  };
  const e = new NavigationEngine(journey([l]));
  e.update(fix(a), now * 1000);
  expect(e.phase).toBe("active");
  expect(e.progress.meters).toBe(0);
});
it("holds stale transit sections and stops until explicitly confirmed", () => {
  const t = train();
  t.end = now - 1;
  t.start = now - 500;
  t.transitStatus = { updatedAt: now - 121 };
  const e = new NavigationEngine(journey([t, bike()]));
  e.tick(now);
  expect(e.progress.legIndex).toBe(0);
  e.advance(true);
  expect(e.progress.legIndex).toBe(1);
  const stop: Leg = {
    kind: "stop",
    from: a,
    to: a,
    start: now - 60,
    end: now - 1,
    distance: 0,
    coordinates: [a],
    stop: { id: "stop", place: a, stayMinutes: 0 },
  };
  const s = new NavigationEngine(journey([stop, bike()]));
  s.tick(now);
  expect(s.progress.legIndex).toBe(0);
  s.advance(true);
  expect(s.progress.confirmedStops).toEqual(["stop"]);
});
it("matches scheduled events and refuses ambiguous repeated stops", () => {
  const result = matchTrip(trip(), ref, now);
  expect(result).toMatchObject({
    kind: "updated",
    update: {
      departure: now + 360,
      arrival: now + 990,
      platform: "3",
      realtime: true,
    },
  });
  const repeated = trip() as any;
  repeated.legs[0].intermediateStops = [{ ...repeated.legs[0].from }];
  expect(matchTrip(repeated, ref, now)).toEqual({ kind: "unavailable" });
  expect(matchTrip({}, ref, now)).toEqual({ kind: "unavailable" });
});
it("refreshes remaining legs without moving completed steps or changing references", () => {
  const j = journey([bike(), train(), bike()]);
  const result = matchTrip(trip(), ref, now);
  const updated = applyTransit(
    j,
    1,
    new Map([[j.legs[1].navigationId!, result]]),
  );
  expect(updated.legs[0]).toEqual(j.legs[0]);
  expect(updated.legs[1].transitReference).toEqual(ref);
  expect(updated.legs[2].start).toBe(now + 990);
  expect(freshTransit(updated.legs[1], now + 121)).toBe(false);
});
it("detects cancellations and lost connections while retaining the journey", () => {
  const j = journey([bike(), { ...train(), start: now + 30 }]);
  const warning = transitDisruption(j, 0, now, 180)!;
  expect(warning.id).toContain("connection-");
  expect(warning.message).toBe(
    `Anschluss an S1 um ${clock(now + 30)} gefährdet.`,
  );
  const updated = applyTransit(
    j,
    0,
    new Map([
      [
        j.legs[1].navigationId!,
        {
          kind: "updated",
          update: {
            departure: now + 90,
            arrival: now + 960,
            realtime: true,
            cancelled: false,
            updatedAt: now,
          },
        },
      ],
    ]),
  );
  expect(transitDisruption(updated, 0, now, 180)).toEqual({
    id: warning.id,
    message: `Anschluss an S1 um ${clock(now + 90)} gefährdet.`,
  });
  j.legs[1].transitStatus!.cancelled = true;
  expect(transitDisruption(j, 0, now)?.id).toContain("cancelled-");
  expect(transitDisruption(j, 0, now)?.message).toBe(
    "S1: Fahrt oder benötigter Halt fällt aus.",
  );
});
it("groups trip fetches, respects refresh intervals and global trip Retry-After", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(trip()), { status: 200 }));
  const refresher = new TransitRefresher(fetcher);
  const legs = journey([train(), train()]).legs;
  const signal = new AbortController().signal;
  expect((await refresher.refresh(legs, signal, now)).size).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await refresher.refresh(legs, signal, now + 59)).size).toBe(0);
  fetcher.mockResolvedValue(
    new Response("", { status: 429, headers: { "Retry-After": "600" } }),
  );
  await refresher.refresh(legs, signal, now + 60);
  expect((await refresher.refresh(legs, signal, now + 200)).size).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect([1, 2, 3].map(transitRetryDelay)).toEqual([120, 240, 300]);
});
it("validates saved navigation and rejects corrupt progress or maneuver metadata", () => {
  const j = journey();
  const s = {
    version: 1,
    savedAt: now,
    journey: j,
    request: { origin: a, destination: c, time: now, timing: "now" },
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 1, meters: 0, confirmedStops: [] },
  };
  expect(validNavigationSnapshot(s)).toBe(true);
  expect(
    validNavigationSnapshot({ ...s, progress: { ...s.progress, legIndex: 4 } }),
  ).toBe(false);
  j.legs[0].maneuvers![0].coordinates = [{ latitude: NaN, longitude: 0 }];
  expect(validNavigationSnapshot(s)).toBe(false);
});
function sessionHarness(
  plan = vi.fn().mockResolvedValue(journey()),
  routingSettings?: () => typeof defaults,
) {
  const store = {
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: async () => fix(),
    routingSettings,
    storageEnabled: () => true,
    api: new ApiClient(),
    store: store as unknown as NavigationStore,
    plan,
    refresher: { refresh: async () => new Map() } as any,
  });
  return { session, store, plan };
}
const request = {
  origin: a,
  destination: c,
  timing: "now" as const,
  time: now,
};
function connection(departure = now + 400) {
  return journey([
    bike(),
    {
      kind: "fold",
      from: c,
      to: c,
      start: now + 180,
      end: now + 360,
      distance: 0,
      coordinates: [c],
    },
    { ...train(), start: departure, end: departure + 600 },
  ]);
}

it("rejects an alternative that becomes unreachable while the planner is responding", async () => {
  const plan = vi.fn(async () => {
    vi.setSystemTime((now + 50) * 1000);
    return connection();
  });
  const { session } = sessionHarness(plan);
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  session.disruption = { id: "missed", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  expect(plan.mock.calls[0][0].time).toBe(now + 30);
  expect(session.alternative).toBeUndefined();
  expect(session.engine).toBe(previous);
  expect(session.message).toContain("Keine aktuell erreichbare Verbindung");
  await session.stop();
});

it.each(["proposal", "reroute"])(
  "selects a reachable planner result during %s",
  async (action) => {
    const api = new ApiClient();
    vi.spyOn(api, "batch").mockImplementation(
      async (_request, _settings, variant) => ({
        journeys: variant.direct
          ? []
          : [
              { ...connection(now + 200), id: "missed" },
              { ...connection(now + 900), id: "reachable" },
            ],
        issues: [],
        stop: false,
        rejected: false,
      }),
    );
    const session = new NavigationSession({
      changed: vi.fn(),
      locate: async () => fix(),
      storageEnabled: () => false,
      api,
      store: {
        clear: vi.fn().mockResolvedValue(undefined),
      } as unknown as NavigationStore,
      refresher: {
        refresh: async () => new Map(),
      } as unknown as TransitRefresher,
    });
    await session.start(journey(), request, {
      ...defaults,
      maxBikeTransfers: 0,
    });
    if (action === "proposal") {
      session.disruption = { id: "missed", message: "Anschluss gefährdet" };
      await session.proposeAlternative();
      expect(session.alternative?.journey.id).toBe("reachable");
      await session.acceptAlternative();
    } else {
      await session.reroute();
      expect(session.engine?.journey.id).toBe("reachable");
    }
    await session.refresh();
    expect(session.disruption).toBeUndefined();
    await session.stop();
  },
);

it("allows accepting the selected future departure after its boarding reserve disappears", async () => {
  const { session, plan } = sessionHarness(
    vi.fn().mockResolvedValue(connection()),
  );
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  session.disruption = { id: "missed", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  vi.setSystemTime((now + 41) * 1000);
  await session.acceptAlternative();
  expect(session.engine).not.toBe(previous);
  expect(session.engine?.journey.legs.at(-1)?.start).toBe(now + 400);
  expect(plan).toHaveBeenCalledTimes(1);
  await session.stop();
});

it("does not treat the already boarded train as a missed departure when accepting", async () => {
  const t = { ...train(), start: now - 60 };
  const j = journey([t, bike()]);
  const { session } = sessionHarness();
  await session.start(j, request, defaults, {
    version: 1,
    savedAt: now,
    journey: j,
    request,
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  });
  session.disruption = { id: "missed", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  await session.acceptAlternative();
  expect(session.message).toBe("");
  expect(session.engine?.leg.navigationId).toBe(j.legs[0].navigationId);
  await session.stop();
});
it("aborts a pending reroute on stop and ignores its late result", async () => {
  let resolve!: (journey: Journey) => void;
  const plan = vi.fn(
    () =>
      new Promise<Journey>((r) => {
        resolve = r;
      }),
  );
  const { session, store } = sessionHarness(plan);
  await session.start(journey(), request, defaults);
  const pending = session.reroute();
  await session.stop();
  resolve(journey());
  await pending;
  expect(session.engine).toBeUndefined();
  expect(store.clear).toHaveBeenCalled();
});
it("restores expired timed sections without skipping them based only on clock time", async () => {
  const t = { ...train(), start: now - 500, end: now - 100 };
  const j = journey([t, bike()]),
    { session } = sessionHarness();
  const snapshot = {
    version: 1 as const,
    savedAt: now - 500,
    journey: j,
    request,
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  };
  await session.start(j, request, defaults, snapshot);
  await vi.advanceTimersByTimeAsync(2000);
  expect(session.engine?.progress.legIndex).toBe(0);
  expect(session.resumeNeedsConfirmation).toBe(true);
  session.completeLeg(session.engine!.leg.navigationId!);
  expect(session.engine?.progress.legIndex).toBe(1);
  await session.stop();
});
it("pauses navigation on hide and requires a new fix when returning", async () => {
  const { session } = sessionHarness();
  await session.start(journey(), request, defaults);
  vi.setSystemTime((now + 10) * 1000);
  session.setForeground(false);
  session.setForeground(true);
  session.updateLocation(fix(b, 1), "current");
  expect(session.fixQuality).toBe("stale");
  session.updateLocation(fix(b, 11), "current");
  expect(session.fixQuality).toBe("current");
  await session.stop();
});
it("rejoins the current street leg after a foreground gap without skipping other legs", () => {
  const long = {
    ...bike(),
    to: place(11.02),
    coordinates: [a, place(11.02)],
    maneuvers: undefined,
  };
  const e = new NavigationEngine(journey([long, train()]));
  e.update(fix(a), now * 1000);
  e.invalidateLocation();
  e.update(fix(place(11.01), 120), (now + 120) * 1000);
  expect(e.progress.meters).toBeGreaterThan(700);
  expect(e.progress.legIndex).toBe(0);
});
it("failed rerouting retains active route and does not repeatedly re-request", async () => {
  const plan = vi.fn().mockRejectedValue(new Error("offline"));
  const { session } = sessionHarness(plan);
  await session.start(journey(), request, defaults);
  const active = session.engine;
  await session.reroute();
  expect(session.engine).toBe(active);
  expect(session.retryAvailable).toBe(true);
  for (let i = 1; i < 7; i++)
    session.updateLocation(fix(place(11.03), i), "current");
  expect(plan).toHaveBeenCalledTimes(1);
  await session.stop();
});
it("keeps onboard leg while offering an alternative from the intended exit", async () => {
  const t = train(),
    j = journey([t, bike()]);
  const { session, plan } = sessionHarness();
  await session.start(j, request, defaults, {
    version: 1,
    savedAt: now,
    journey: j,
    request,
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  });
  session.disruption = { id: "test", message: "Anschluss gefährdet" };
  const original = session.engine;
  await session.proposeAlternative();
  expect(session.engine).toBe(original);
  expect(plan.mock.calls[0][0].origin).toEqual(t.to);
  expect(plan.mock.calls[0][0].time).toBe(t.end + defaults.foldingDuration);
  await session.acceptAlternative();
  expect(session.engine?.leg.navigationId).toBe(original?.leg.navigationId);
  expect(session.engine?.journey.legs[1].kind).toBe("unfold");
  expect(session.message).toBe("");
  await session.stop();
});

it("accepts a valid alternative once, preserves confirmed stops and saves the new route", async () => {
  const preferences = { ...defaults, cyclingSpeedKilometersPerHour: 22 };
  const { session, store, plan } = sessionHarness(undefined, () => preferences);
  await session.start(journey(), request, defaults);
  const previous = session.engine!;
  previous.progress.confirmedStops = ["visited"];
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  expect(plan.mock.calls[0][1]).toEqual(preferences);
  expect(session.settings).toEqual(defaults);
  await Promise.all([session.acceptAlternative(), session.acceptAlternative()]);
  expect(session.engine).not.toBe(previous);
  expect(session.settings).toEqual(preferences);
  expect(session.engine?.progress.confirmedStops).toEqual(["visited"]);
  expect(session.alternative).toBeUndefined();
  expect(session.message).toBe("");
  expect(store.save.mock.lastCall?.[0].journey).toEqual(
    session.engine?.journey,
  );
  await session.stop();
});

it("refreshes an expired proposal after locating and requires confirmation again", async () => {
  const { session, plan } = sessionHarness();
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  vi.setSystemTime((now + 121) * 1000);
  await session.acceptAlternative();
  expect(session.engine).toBe(previous);
  expect(session.alternative).toBeUndefined();
  expect(session.alternativeNeedsLocation).toBe(true);
  expect(session.message).toContain("Standort erneut anfragen");
  session.updateLocation(fix(a, 121), "current");
  await session.resumeAlternativeAfterLocation();
  expect(plan).toHaveBeenCalledTimes(2);
  expect(session.alternative).toBeDefined();
  expect(session.engine).toBe(previous);
  expect(session.message).toContain("bestätigen");
  await session.acceptAlternative();
  expect(session.engine).not.toBe(previous);
  await session.stop();
});

it.each(["network", "geometry"])(
  "keeps the active route on %s failure during proposal refresh",
  async (failure) => {
    const { session, plan } = sessionHarness();
    await session.start(journey(), request, defaults);
    const previous = session.engine;
    session.disruption = { id: "connection", message: "Anschluss gefährdet" };
    if (failure === "network")
      plan.mockRejectedValueOnce(new Error("Netzwerkfehler"));
    else
      plan.mockResolvedValueOnce(
        journey([{ ...bike(), coordinates: [], maneuvers: [] }]),
      );
    await session.proposeAlternative();
    expect(session.alternative).toBeUndefined();
    expect(session.engine).toBe(previous);
    expect(session.retryAvailable).toBe(true);
    expect(session.message).toContain("Bisherige Route bleibt erhalten");
    await session.stop();
  },
);

it("reports activation failure instead of throwing from the accept handler", async () => {
  const { session } = sessionHarness();
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  session.alternative!.journey.legs[0].coordinates = [];
  session.alternative!.journey.legs[0].maneuvers = [];
  await expect(session.acceptAlternative()).resolves.toBeUndefined();
  expect(session.engine).toBe(previous);
  expect(session.message).toContain("Bisherige Route bleibt erhalten");
  expect(session.alternative).toBeUndefined();
  await session.stop();
});

it("discards a proposal as soon as GPS advances to another section", async () => {
  const { session } = sessionHarness();
  await session.start(
    journey([
      bike(),
      { ...bike(), from: c, to: a, coordinates: [c, b, a], maneuvers: [] },
    ]),
    request,
    defaults,
  );
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  session.updateLocation(fix(c, 20), "current");
  expect(session.engine?.progress.legIndex).toBe(1);
  expect(session.alternative).toBeUndefined();
  await session.stop();
});

it("does not publish a late alternative after navigation ends", async () => {
  let resolve!: (route: Journey) => void;
  const plan = vi.fn(
    () =>
      new Promise<Journey>((done) => {
        resolve = done;
      }),
  );
  const { session } = sessionHarness(plan);
  await session.start(journey(), request, defaults);
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  const proposing = session.proposeAlternative();
  await session.stop();
  resolve(journey());
  await proposing;
  expect(session.engine).toBeUndefined();
  expect(session.alternative).toBeUndefined();
  expect(session.message).toBe("");
});
it("an elevator anchor survives validation and produces a maneuver at that point", async () => {
  const { validateStreetGeometry } = await import("../src/geometry");
  const validated = validateStreetGeometry(
    [a, b, c],
    [
      { direction: "DEPART", distance: 149, coordinates: [a, b] },
      { direction: "ELEVATOR", distance: 0, coordinates: [] },
      { direction: "LEFT", distance: 222, coordinates: [b, c] },
    ],
    a,
    c,
    false,
    370,
  );
  expect(validated.steps[1].coordinates).toEqual([b]);
});

it("retains coincident elevator guidance and requires confirmation at a vertical endpoint", () => {
  const leg: Leg = {
    ...bike(),
    kind: "walk",
    from: a,
    to: a,
    distance: 0,
    coordinates: [a],
    maneuvers: [
      { direction: "ELEVATOR", streetName: "", distance: 0, coordinates: [a] },
    ],
  };
  const engine = new NavigationEngine(journey([leg]));
  expect(engine.instruction).toBe("Aufzug nehmen");
  engine.update(fix(a), now * 1000);
  expect(engine.phase).toBe("active");
  engine.advance(true);
  expect(engine.phase).toBe("arrived");
});

it("retains a cancelled selection after a delayed transit check without silently planning", async () => {
  const api = new ApiClient();
  const batch = vi.spyOn(api, "batch").mockImplementation(async (input) => {
    const leg = { ...bike(), start: input.time, end: input.time + 180 };
    return { journeys: [journey([leg])], issues: [], rejected: 0, stop: false };
  });
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: async () => fix(),
    storageEnabled: () => false,
    api,
    store: {
      clear: vi.fn().mockResolvedValue(undefined),
    } as unknown as NavigationStore,
    refresher: {
      refresh: async () => {
        vi.setSystemTime((now + 5) * 1000);
        return new Map();
      },
    } as unknown as TransitRefresher,
  });
  const cancelled = {
    ...train(),
    to: c,
    coordinates: [c],
    transitStatus: { updatedAt: now, cancelled: true },
  };
  await session.start(journey([bike(), cancelled]), request, defaults);
  expect(batch).not.toHaveBeenCalled();
  expect(session.engine).toBeUndefined();
  expect(session.assessment?.status).toBe("cancelled");
  await session.stop();
});

it.each([
  [721, 2, 1],
  [-721, -2, -1],
  [1080, 10, 10],
  [0, 180, -180],
])("normalizes heading delta from %s to %s", (from, to, expected) =>
  expect(headingDelta(from, to)).toBe(expected),
);

it("retains a turn throughout the last 25 meters of its approach", () => {
  const engine = new NavigationEngine(journey());
  engine.update(fix(place(11.00175)), now * 1000);
  expect(engine.distanceToNext).toBeLessThan(25);
  expect(engine.instruction).toBe("Links abbiegen auf Zweite Straße");
  engine.update(fix(b, 1), (now + 1) * 1000);
  expect(engine.maneuver).toBeUndefined();
});

it("shows a turn less than 25 meters from the starting point", () => {
  const corner = place(11.0001);
  const leg = bike();
  leg.maneuvers![0].coordinates = [a, corner];
  leg.maneuvers![1].coordinates = [corner, c];
  const engine = new NavigationEngine(journey([leg]));
  expect(engine.instruction).toBe("Links abbiegen auf Zweite Straße");
  expect(engine.distanceToNext).toBeGreaterThan(0);
  expect(engine.distanceToNext).toBeLessThan(25);
});

it.each([0, 1])(
  "keeps waiting ahead of folding when current section is %s",
  (index) => {
    const route = journey([
      { ...bike(), end: now + 360 },
      transition("wait", c, now + 360, now + 360),
      transition("fold", c, now + 360, now + 540),
      { ...train(), start: now + 540 },
    ]);
    expect(applyTransit(route, index, new Map()).legs).toEqual(route.legs);
    const delayed = applyTransit(
      route,
      index,
      new Map([
        [
          route.legs[3].navigationId!,
          {
            kind: "updated",
            update: {
              departure: now + 660,
              arrival: now + 1020,
              realtime: true,
              cancelled: false,
              updatedAt: now,
            },
          },
        ],
      ]),
    );
    expect(delayed.legs[1].end).toBe(now + 480);
    expect(delayed.legs[2]).toMatchObject({ start: now + 480, end: now + 660 });
    expect(transitDisruption(delayed, index, now)).toBeUndefined();
  },
);

it("reserves folding and boarding time after a current transfer wait", () => {
  const route = journey([
    { ...train(), start: now - 600, end: now },
    { ...bike(), from: c, to: c },
    transition("wait", c, now + 180, now + 180),
    transition("fold", c, now + 180, now + 360),
    transition("wait", c, now + 360, now + 540),
    { ...train(), start: now + 540 },
  ]);
  const updated = applyTransit(route, 2, new Map());
  expect(updated.legs).toEqual(route.legs);
  expect(transitDisruption(updated, 2, now + 180)).toBeUndefined();
});

it("reserves movement between folding and boarding when scheduling waits", () => {
  const route = journey([
    { ...bike(), end: now + 300 },
    transition("wait", c, now + 300, now + 300),
    transition("fold", c, now + 300, now + 480),
    {
      ...bike(),
      kind: "walk" as const,
      from: c,
      start: now + 480,
      end: now + 540,
    },
    { ...train(), start: now + 540 },
  ]);
  expect(applyTransit(route, 0, new Map()).legs).toEqual(route.legs);
});

it.each(["startup", "reroute"])(
  "rejects a route that expires during automatic %s",
  async (action) => {
    const plan = vi.fn(async () => {
      vi.setSystemTime((now + 50) * 1000);
      return connection(now + 400);
    });
    const { session } = sessionHarness(plan);
    if (action === "startup") {
      await expect(
        session.start(journey(), request, defaults, undefined, true),
      ).rejects.toThrow("Keine aktuell erreichbare Verbindung");
      expect(session.engine).toBeUndefined();
    } else {
      const initial =
        action === "stop"
          ? journey([
              {
                ...transition("stop", a, now - 10, now),
                stop: { id: "stop", place: a, stayMinutes: 0 },
              },
              {
                ...train(),
                transitStatus: { failure: "unavailable" as const },
              },
            ])
          : journey();
      await session.start(initial, request, defaults);
      const engine = session.engine;
      if (action === "stop") await session.continueStop();
      else await session.reroute();
      expect(session.engine).toBe(engine);
      expect(session.retryAvailable).toBe(true);
      expect(session.message).toContain("Keine aktuell erreichbare Verbindung");
    }
    await session.stop();
  },
);

it("requires confirmation when a saved section expires during transit refresh", async () => {
  const route = journey([transition("wait", a, now - 10, now + 1), bike()]);
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: async () => fix(),
    storageEnabled: () => false,
    api: new ApiClient(),
    store: { clear: vi.fn() } as unknown as NavigationStore,
    refresher: {
      refresh: async () => {
        vi.setSystemTime((now + 2) * 1000);
        return new Map();
      },
    } as unknown as TransitRefresher,
  });
  await session.start(route, request, defaults, {
    version: 1,
    savedAt: now - 10,
    journey: route,
    request,
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  });
  expect(session.resumeNeedsConfirmation).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.engine?.progress.legIndex).toBe(0);
  await session.stop();
});

it("clears resume confirmation when continuing an expired stop", async () => {
  const route = journey([
    {
      ...transition("stop", a, now - 10, now - 1),
      stop: { id: "stop", place: a, stayMinutes: 0 },
    },
    transition("unfold", a, now, now + 1),
    bike(),
  ]);
  const { session } = sessionHarness();
  await session.start(route, request, defaults, {
    version: 1,
    savedAt: now - 10,
    journey: route,
    request,
    settings: defaults,
    progress: { legIndex: 0, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  });
  expect(session.resumeNeedsConfirmation).toBe(true);
  await session.continueStop();
  expect(session.resumeNeedsConfirmation).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(session.engine?.leg.kind).toBe("bike");
  await session.stop();
});

it("checkpoints distance without saving every location update and flushes on hide", async () => {
  const { session, store } = sessionHarness();
  await session.start(
    journey([{ ...bike(), maneuvers: undefined }]),
    request,
    defaults,
  );
  session.updateLocation(fix(place(11.001), 1), "current");
  const writes = store.save.mock.calls.length;
  expect(store.save.mock.lastCall![0].progress.meters).toBeGreaterThan(50);
  session.updateLocation(fix(place(11.00105), 2), "current");
  expect(store.save).toHaveBeenCalledTimes(writes);
  session.setForeground(false);
  expect(store.save).toHaveBeenCalledTimes(writes + 1);
  expect(store.save.mock.lastCall![0].progress.meters).toBe(
    session.engine!.progress.meters,
  );
  await session.stop();
});

it("restores a loop from its latest distance instead of a previously traversed segment", async () => {
  const coordinates = [a, b, c, a, b];
  const route = journey([
    {
      ...bike(),
      to: b,
      coordinates,
      maneuvers: undefined,
      distance: projectPath(a, coordinates).length,
      end: now + 900,
    },
  ]);
  const { session, store } = sessionHarness();
  await session.start(route, request, defaults);
  for (const [point, seconds] of [
    [b, 10],
    [c, 30],
    [a, 60],
  ] as const) {
    vi.setSystemTime((now + seconds) * 1000);
    session.updateLocation(fix(point, seconds), "current");
  }
  session.setForeground(false);
  const snapshot = store.save.mock.lastCall![0];
  expect(snapshot.progress.meters).toBeGreaterThan(600);
  const restored = new NavigationEngine(snapshot.journey, snapshot.progress);
  restored.update(fix(a, 61), (now + 61) * 1000);
  expect(restored.progress.meters).toBeGreaterThan(600);
  await session.stop();
});

it("new navigation calculations use personal preferences and failed calculations preserve result settings", async () => {
  const preferences = {
    ...defaults,
    cyclingSpeedKilometersPerHour: 22,
    foldingDuration: 120,
  };
  const plan = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(journey());
  const { session, store } = sessionHarness(plan, () => preferences);
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  await session.reroute();
  expect(plan.mock.calls[0][1]).toEqual(preferences);
  expect(session.engine).toBe(previous);
  expect(session.settings).toEqual(defaults);
  await session.reroute();
  expect(session.settings).toEqual(preferences);
  expect(store.save.mock.lastCall?.[0].settings).toEqual(preferences);
  await session.stop();
});

it.each([60, 120, 121, 600])(
  "warns without blocking a future train for %s seconds of estimated lateness",
  async (late) => {
    const route = journey([
      { ...bike(), end: now + 1000 + late },
      { ...train(), start: now + 1000, end: now + 1600 },
    ]);
    const { session, store, plan } = sessionHarness();
    const original = structuredClone(route);
    const deadline = {
      ...request,
      timing: "arrive" as const,
      time: route.arrival,
    };
    const prepared = await session.prepareStart(route, deadline, defaults);
    expect(prepared.assessment.status).toBe("risk");
    expect(blocksNavigation(prepared.assessment)).toBe(false);
    expect(session.engine).toBeUndefined();
    expect(store.save).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(session.activateStart(prepared)).toBe(true);
    expect(session.engine?.journey.legs.at(-1)?.transitReference).toEqual(ref);
    expect(session.request?.timing).toBe("arrive");
    expect(session.request?.time).toBe(deadline.time);
    expect(route).toEqual(original);
    await session.stop();
  },
);

it("allows a past bike departure while keeping the selected train and projecting existing progress", async () => {
  const route = connection(now + 400);
  route.legs[0].start = now - 180;
  route.legs[0].end = now;
  route.departure = now - 180;
  const api = new ApiClient();
  const batch = vi.spyOn(api, "batch");
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: async () => fix(c),
    storageEnabled: () => false,
    api,
    store: { clear: vi.fn() } as unknown as NavigationStore,
    refresher: {
      refresh: async () => new Map(),
    } as unknown as TransitRefresher,
  });
  const prepared = await session.prepareStart(route, request, defaults);
  expect(prepared.assessment.status).toBe("ready");
  expect(batch).not.toHaveBeenCalled();
  session.activateStart(prepared);
  expect(session.engine?.leg.kind).toBe("fold");
  expect(session.engine?.journey.legs.at(-1)?.transitReference).toEqual(ref);
  await session.stop();
});

it("blocks only a known departed train and keeps missing data explicitly uncertain", async () => {
  for (const fresh of [true, false]) {
    const t = {
      ...train(),
      from: a,
      coordinates: [a, c],
      start: now - 30,
      transitStatus: fresh
        ? { updatedAt: now }
        : { failure: "network" as const },
    };
    const { session, plan } = sessionHarness();
    const prepared = await session.start(journey([t]), request, defaults);
    expect(prepared.assessment.status).toBe(fresh ? "departed" : "unknown");
    expect(!!session.engine).toBe(!fresh);
    expect(plan).not.toHaveBeenCalled();
    await session.stop();
  }
});

it("rechecks departure between preparation and activation without persisting an active navigation", async () => {
  const { session, store } = sessionHarness();
  const prepared = await session.prepareStart(
    journey([{ ...train(), from: a, coordinates: [a, c], start: now + 1 }]),
    request,
    defaults,
  );
  vi.setSystemTime((now + 2) * 1000);
  expect(session.activateStart(prepared)).toBe(false);
  expect(prepared.assessment.status).toBe("departed");
  expect(store.save).not.toHaveBeenCalled();
  expect(session.engine).toBeUndefined();
  await session.stop();
});

it("invalidates a prepared start when the user cancels", async () => {
  const { session, store } = sessionHarness();
  const prepared = await session.prepareStart(journey(), request, defaults);
  session.cancelStart();
  expect(session.activateStart(prepared)).toBe(false);
  expect(store.save).not.toHaveBeenCalled();
  await session.stop();
});

it("offers rerouted multimodal journeys without replacing the active selection", async () => {
  const { session, plan } = sessionHarness(
    vi.fn().mockResolvedValue({ ...connection(now + 1000), id: "new" }),
  );
  await session.start(connection(now + 900), request, defaults);
  const original = session.engine;
  await session.reroute();
  expect(session.engine).toBe(original);
  expect(session.alternative?.journey.id).toBe("new");
  await session.refresh();
  expect(session.alternative?.reason).toBe("reroute");
  session.dismissAlternative();
  expect(session.engine).toBe(original);
  await session.reroute();
  await session.acceptAlternative();
  expect(session.engine?.journey.id).toBe("new");
  expect(plan).toHaveBeenCalledTimes(2);
  await session.stop();
});

it("confirms a stop only when its newly planned continuation is accepted", async () => {
  const stop = {
    ...transition("stop", a, now, now),
    stop: { id: "pause", place: a, stayMinutes: 0 },
  };
  const { session } = sessionHarness(vi.fn().mockResolvedValue(journey()));
  await session.start(
    journey([stop, train()]),
    { ...request, stops: [stop.stop] },
    defaults,
  );
  const engine = session.engine!;
  engine.journey.legs[1].transitStatus!.cancelled = true;
  await session.continueStop();
  expect(session.engine).toBe(engine);
  expect(engine.progress.confirmedStops).toEqual([]);
  expect(session.alternative?.reason).toBe("stop");
  await session.refresh();
  expect(session.alternative?.reason).toBe("stop");
  await session.acceptAlternative();
  expect(session.engine).not.toBe(engine);
  expect(session.engine?.progress.confirmedStops).toContain("pause");
  await session.stop();
});

it("absorbs existing waiting time before warning and preserves the boarding reserve", () => {
  const route = journey([
    bike(),
    transition("wait", c, now + 180, now + 400),
    { ...train(), start: now + 600 },
  ]);
  expect(assessConnection(route, 0, now).status).toBe("ready");
  expect(assessConnection(route, 0, now + 100).status).toBe("ready");
  expect(assessConnection(route, 0, now + 250).status).toBe("unknown");
  route.legs[2].transitStatus = { updatedAt: now + 450 };
  expect(assessConnection(route, 0, now + 450).status).toBe("risk");
});

it("starts folding at actual arrival and does not automatically board a departed train", () => {
  const route = connection(now + 300);
  const engine = new NavigationEngine(route);
  engine.advance(false, now + 400);
  expect(engine.leg.kind).toBe("fold");
  expect(engine.leg.start).toBe(now + 400);
  expect(engine.leg.end).toBe(now + 580);
  engine.journey.legs[2].transitStatus = { updatedAt: now + 581 };
  engine.tick(now + 581);
  expect(engine.leg.kind).toBe("fold");
  engine.advance(true, now + 581);
  expect(engine.leg.kind).toBe("transit");
});

it("an earlier arrival can recover the same connection while retaining the full folding duration", () => {
  const engine = new NavigationEngine(connection(now + 300));
  engine.advance(false, now + 50);
  expect(engine.leg.kind).toBe("fold");
  expect(engine.leg.end - engine.leg.start).toBe(180);
  engine.journey.legs[2].transitStatus = { updatedAt: now + 230 };
  engine.tick(now + 230);
  expect(engine.leg.kind).toBe("transit");
  expect(engine.leg.start).toBe(now + 300);
});

it("retains the reason for a reroute after asking for location again", async () => {
  const { session } = sessionHarness(
    vi.fn().mockResolvedValue({ ...connection(now + 1000), id: "new" }),
  );
  await session.start(connection(now + 900), request, defaults);
  session.updateLocation(undefined);
  await session.reroute();
  expect(session.alternativeNeedsLocation).toBe(true);
  const original = session.engine;
  session.updateLocation(fix(a, 20), "current");
  await session.resumeAlternativeAfterLocation();
  expect(session.alternative?.reason).toBe("reroute");
  await session.refresh();
  expect(session.alternative?.reason).toBe("reroute");
  expect(session.engine).toBe(original);
  await session.stop();
});

it("starts the waiting prefix of a proposed stop continuation at the current stop", async () => {
  const stop = {
    ...transition("stop", a, now, now + 60),
    stop: { id: "pause", place: a, stayMinutes: 1 },
  };
  const route = journey([
    { ...bike(), from: c, to: a, coordinates: [c, b, a], maneuvers: [] },
    stop,
    train(),
  ]);
  const { session } = sessionHarness(vi.fn().mockResolvedValue(journey()));
  const snapshot = {
    version: 1 as const,
    savedAt: now,
    journey: route,
    request,
    settings: defaults,
    progress: { legIndex: 1, maneuverIndex: 0, meters: 0, confirmedStops: [] },
  };
  await session.start(route, request, defaults, snapshot);
  session.engine!.journey.legs[2].transitStatus!.cancelled = true;
  await session.continueStop();
  expect(session.alternative?.journey.origin).toEqual(a);
  expect(session.alternative?.journey.departure).toBe(now);
  expect(session.alternative?.journey.legs[0]).toMatchObject({
    kind: "wait",
    start: now,
    end: now + 60,
  });
  expect(session.engine!.progress.confirmedStops).toEqual([]);
  await session.acceptAlternative();
  expect(session.engine!.progress.confirmedStops).toEqual(["pause"]);
  await session.stop();
});
