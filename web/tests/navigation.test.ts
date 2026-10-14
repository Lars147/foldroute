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
import { defaults, type Journey, type Leg, type Place } from "../src/model";
import { NavigationSession } from "../src/navigation-session";
import type { NavigationStore } from "../src/navigation-store";
import { ApiClient } from "../src/transitous";
import { clock } from "../src/ui";
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
    `Anschluss an S1 um ${clock(now + 30)} voraussichtlich nicht erreichbar.`,
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
    message: `Anschluss an S1 um ${clock(now + 90)} voraussichtlich nicht erreichbar.`,
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
function sessionHarness(plan = vi.fn().mockResolvedValue(journey())) {
  const store = {
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const session = new NavigationSession({
    changed: vi.fn(),
    locate: async () => fix(),
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

it("selects a reachable planner result instead of the fastest missed connection", async () => {
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
  await session.start(journey(), request, { ...defaults, maxBikeTransfers: 0 });
  session.disruption = { id: "missed", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  expect(session.alternative?.journey.id).toBe("reachable");
  await session.acceptAlternative();
  await session.refresh();
  expect(session.disruption).toBeUndefined();
  await session.stop();
});

it("rechecks reachability on acceptance even before the proposal expires", async () => {
  const plan = vi
    .fn()
    .mockResolvedValueOnce(connection())
    .mockResolvedValueOnce(connection(now + 900));
  const { session } = sessionHarness(plan);
  await session.start(journey(), request, defaults);
  const previous = session.engine;
  session.disruption = { id: "missed", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  expect(session.alternative).toBeDefined();
  vi.setSystemTime((now + 41) * 1000);
  await session.acceptAlternative();
  expect(session.engine).toBe(previous);
  expect(plan).toHaveBeenCalledTimes(2);
  expect(session.alternative?.journey.legs.at(-1)?.start).toBe(now + 900);
  expect(session.message).toContain("bestätigen");
  await session.acceptAlternative();
  await session.refresh();
  expect(session.engine).not.toBe(previous);
  expect(session.disruption).toBeUndefined();
  expect(plan).toHaveBeenCalledTimes(2);
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
  const { session, store } = sessionHarness();
  await session.start(journey(), request, defaults);
  const previous = session.engine!;
  previous.progress.confirmedStops = ["visited"];
  session.disruption = { id: "connection", message: "Anschluss gefährdet" };
  await session.proposeAlternative();
  await Promise.all([session.acceptAlternative(), session.acceptAlternative()]);
  expect(session.engine).not.toBe(previous);
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
  session.updateLocation(fix(c, 1), "current");
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

it("starts through the real planner after a delayed transit check invalidates the connection", async () => {
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
  expect(batch).toHaveBeenCalled();
  expect(batch.mock.calls[0][0].time).toBe(now + 5);
  expect(session.engine?.phase).toBe("active");
  expect(session.engine?.journey.legs[0].kind).toBe("bike");
  await session.stop();
});
