import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaults,
  PlannerError,
  type Journey,
  type RouteRequest,
  type PlanningPhase,
} from "../src/model";
import { PlanningSession } from "../src/planning-state";
import {
  planningProgress,
  stoppedSearchMessage,
} from "../src/planning-progress";
import { planRoutes } from "../src/planner";
import { locate } from "../src/search";
import { ApiClient } from "../src/transitous";

vi.mock("../src/planner", () => ({ planRoutes: vi.fn() }));
vi.mock("../src/search", () => ({ locate: vi.fn() }));

const origin = { name: "Start", detail: "", latitude: 48.13, longitude: 11.57 };
const destination = { ...origin, name: "Ziel", latitude: 48.17 };
const request: RouteRequest = {
  origin,
  destination,
  timing: "depart",
  time: 1000,
};
const changedRequest: RouteRequest = { ...request, time: 2000 };
const changedSettings = { ...defaults, maxCyclingMinutes: 50 };
const journey = (id: string, arrival = 2000): Journey => ({
  id,
  origin,
  destination,
  departure: 1000,
  arrival,
  transfers: 0,
  isDirect: true,
  legs: [
    {
      kind: "bike",
      from: origin,
      to: destination,
      start: 1000,
      end: arrival,
      distance: 1000,
      coordinates: [origin, destination],
    },
  ],
});

describe("progressive search presentation", () => {
  for (const status of ["complete", "partial"] as const)
    it(
      "restores a cleared " +
        status +
        " status when returning to cached results",
      async () => {
        const session = sessionWithArchive();
        vi.mocked(planRoutes).mockImplementation(async function* () {
          yield {
            journeys: [journey("fresh")],
            status,
            phase: "walking",
            incompletePhases: status === "partial" ? ["walking"] : [],
            issues: status === "partial" ? ["Zeitlimit"] : [],
          };
        });
        await session.calculate(request, defaults, false);
        const message = session.state.message;
        // Leaving a plan clears its visible message before its cache is restored.
        session.stop("");
        const cached = structuredClone(session.state);
        session.clear();
        session.restoreContext(cached);
        expect(session.state.message).toBe(message);
        expect(session.state.searchStatus).toBe(status);
        expect(session.state.selected?.id).toBe("fresh");
        expect(planningProgress(session.state).ready).toBe(false);
      },
    );

  it("restores the stopped status without resuming requests", async () => {
    const session = sessionWithArchive();
    const finish = gate();
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield {
        journeys: [journey("fresh")],
        status: "searching",
        phase: "walking",
        incompletePhases: [],
        issues: [],
      };
      await finish.promise;
    });
    const task = session.calculate(request, defaults, false);
    await vi.waitFor(() =>
      expect(planningProgress(session.state).ready).toBe(true),
    );
    session.stop(stoppedSearchMessage);
    const message = session.state.message;
    session.stop("");
    session.restoreContext(structuredClone(session.state));
    expect(session.state.message).toBe(message);
    expect(session.state.searchStatus).toBe("stopped");
    expect(planningProgress(session.state).ready).toBe(false);
    finish.release();
    await task;
    expect(planRoutes).toHaveBeenCalledOnce();
  });

  for (const [phase, message] of [
    ["base", "Weitere Verbindungen werden gesucht"],
    ["bike-transfers", "Wir prüfen weitere Rad-Umstiege"],
    ["walking", "Wir prüfen kürzere Fußwege"],
    ["via", "Wir prüfen weitere Verbindungen über deine Zwischenziele"],
  ] as const)
    it(`explains the active ${phase} phase while keeping results usable`, async () => {
      const session = sessionWithArchive();
      const finish = gate();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield {
          journeys: [journey("first")],
          status: "searching",
          phase,
          incompletePhases: [],
          issues: [],
        };
        await finish.promise;
        yield {
          journeys: [],
          status: "complete",
          phase,
          incompletePhases: [],
          issues: [],
        };
      });
      const task = session.calculate(request, defaults, false);
      await vi.waitFor(() =>
        expect(planningProgress(session.state).ready).toBe(true),
      );
      expect(session.state.message).toBe(`${message} …`);
      expect(planningProgress(session.state)).toEqual({
        ready: true,
        optimizing: true,
        loading: false,
        message: "",
      });
      finish.release();
      await task;
      expect(session.state.message).toBe("Suche abgeschlossen.");
      expect(planningProgress(session.state)).toEqual({
        ready: true,
        optimizing: false,
        loading: false,
        message: "",
      });
    });

  it("keeps old results marked as loading until the current request returns", async () => {
    const session = sessionWithArchive();
    const finish = gate();
    let signal!: AbortSignal;
    vi.mocked(planRoutes).mockImplementation(
      async function* (_r, _s, currentSignal) {
        signal = currentSignal;
        yield {
          journeys: [],
          status: "searching",
          phase: "base",
          incompletePhases: [],
          issues: [],
        };
        await finish.promise;
        yield {
          journeys: [journey("fresh")],
          status: "complete",
          phase: "base",
          incompletePhases: [],
          issues: [],
        };
      },
    );
    const task = session.calculate(changedRequest, defaults, false);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(session.state.message).toBe("Verbindungen werden gesucht …");
    expect(planningProgress(session.state)).toEqual({
      ready: false,
      optimizing: false,
      loading: true,
      message: "Verbindungen werden gesucht …",
    });
    expect(signal.aborted).toBe(false);
    expect(session.state.busy).toBe(true);
    finish.release();
    await task;
    expect(session.state.selected?.id).toBe("fresh");
  });

  for (const hold of ["selection", "details"] as const)
    it(`keeps ${hold}, results and calculation context after cancellation and a late answer`, async () => {
      const session = sessionWithArchive();
      const next = gate(),
        finish = gate();
      let signal!: AbortSignal;
      vi.mocked(planRoutes).mockImplementation(
        async function* (_r, _s, currentSignal) {
          signal = currentSignal;
          yield {
            journeys: [journey("first"), journey("chosen")],
            status: "searching",
            phase: "base",
            incompletePhases: [],
            issues: [],
          };
          await next.promise;
          yield {
            journeys: [journey("optimized")],
            status: "searching",
            phase: "walking",
            incompletePhases: [],
            issues: [],
          };
          await finish.promise;
          yield {
            journeys: [journey("late")],
            status: "complete",
            phase: "walking",
            incompletePhases: [],
            issues: [],
          };
        },
      );
      const task = session.calculate(request, defaults, false);
      await vi.waitFor(() =>
        expect(planningProgress(session.state).ready).toBe(true),
      );
      if (hold === "selection") session.select("chosen");
      else session.holdSelection();
      const selected = session.state.selected;
      next.release();
      await vi.waitFor(() => expect(session.state.phase).toBe("walking"));
      expect(session.state.selected).toEqual(selected);
      const before = structuredClone(session.state);
      session.stop("");
      expect(signal.aborted).toBe(true);
      expect(session.state).toMatchObject({
        journeys: before.journeys,
        selected: before.selected,
        request: before.request,
        queriedAt: before.queriedAt,
        calculationId: before.calculationId,
        busy: false,
        message: "",
      });
      expect(session.state.recovery).toBeUndefined();
      const stopped = structuredClone(session.state);
      finish.release();
      await task;
      expect(session.state).toEqual(stopped);
    });

  it("keeps results ready and preserves the service pause after partial failure", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const client = new ApiClient();
    const retryAt = Date.now() / 1000 + 60;
    client.retryAt = retryAt;
    const session = new PlanningSession(client, () => {});
    const finish = gate();
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield {
        journeys: [journey("first")],
        status: "searching",
        phase: "walking",
        incompletePhases: ["bike-transfers"],
        issues: ["Serverpause"],
      };
      await finish.promise;
      yield {
        journeys: [],
        status: "partial",
        phase: "walking",
        incompletePhases: ["bike-transfers"],
        issues: ["Serverpause"],
      };
    });
    const task = session.calculate(request, defaults, false);
    await vi.waitFor(() =>
      expect(planningProgress(session.state).ready).toBe(true),
    );
    finish.release();
    await task;
    expect(session.state.issues).toEqual(["Serverpause"]);
    expect(session.state.recovery).toMatchObject({ action: "retry", retryAt });
    expect(planningProgress(session.state)).toEqual({
      ready: true,
      optimizing: false,
      loading: false,
      message: "Optimierung nicht vollständig.",
    });
  });

  it("names incomplete phases when no specific cause is available", async () => {
    const session = sessionWithArchive();
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield {
        journeys: [journey("first")],
        status: "partial",
        phase: "walking",
        incompletePhases: ["bike-transfers", "walking"] as PlanningPhase[],
        issues: [],
      };
    });
    await session.calculate(request, defaults, false);
    expect(session.state.message).toBe(
      "Weitere Rad-Umstiege: Suche unvollständig. Kürzere Fußwege: Prüfung unvollständig.",
    );
    expect(session.state.selected?.id).toBe("first");
    expect(session.state.recovery?.action).toBe("retry");
    expect(planningProgress(session.state).message).toBe(
      "Optimierung nicht vollständig.",
    );
  });

  for (const [issues, message] of [
    [
      ["Suche nach weiteren Rad-Umstiegen: Zeitlimit erreicht."],
      "Optimierung: Zeitlimit erreicht",
    ],
    [
      [
        "Suche über Zwischenziele: Zeitlimit erreicht.",
        "Prüfung kürzerer Fußwege: Zeitlimit erreicht.",
      ],
      "Optimierung: Zeitlimit erreicht",
    ],
    [
      ["Der Dienst hat nicht rechtzeitig geantwortet."],
      "Optimierung: Zeitlimit erreicht",
    ],
    [
      ["Prüfung kürzerer Fußwege: Anfragelimit erreicht."],
      "Optimierung: Anfragelimit erreicht.",
    ],
    [
      [
        "Suche über Zwischenziele: Zeitlimit erreicht.",
        "Dienst nicht verfügbar",
      ],
      "Optimierung nicht vollständig.",
    ],
    [[], "Optimierung nicht vollständig."],
  ] as const)
    it(`summarizes ${issues.join(" / ") || "unspecified failure"} without phase names`, async () => {
      const session = sessionWithArchive();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield {
          journeys: [journey("fresh")],
          status: "partial",
          phase: "walking",
          incompletePhases: ["walking"],
          issues: [...issues],
        };
      });
      await session.calculate(request, defaults, false);
      expect(planningProgress(session.state).message).toBe(message);
      expect(session.state.issues).toEqual(issues);
      expect(session.state.recovery?.action).toBe("retry");
    });
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
function sessionWithArchive() {
  vi.stubGlobal("navigator", { onLine: true });
  const session = new PlanningSession(new ApiClient(), () => {});
  session.restore(journey("archive"), request, 100, defaults);
  return session;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("provisional route state", () => {
  const preview = {
    legs: journey("section").legs,
    startSection: 0,
    endSection: 1,
  };
  const update = {
    journeys: [],
    routePreview: preview,
    status: "searching" as const,
    phase: "via" as const,
    incompletePhases: [],
    issues: [],
  };

  for (const refresh of [false, true])
    it(`keeps provisional geometry separate from results during ${refresh ? "refresh" : "initial search"}`, async () => {
      const session = sessionWithArchive();
      if (!refresh) session.clear();
      const finish = gate();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield update;
        await finish.promise;
        yield {
          ...update,
          journeys: [journey("complete")],
          status: "complete",
        };
      });
      const task = session.calculate(request, defaults, false);
      try {
        await vi.waitFor(() => expect(session.state.phase).toBe("via"));
        expect(session.state.routePreview).toEqual(
          refresh ? undefined : preview,
        );
        expect(session.state.journeys.map((j) => j.id)).toEqual(
          refresh ? ["archive"] : [],
        );
        expect(session.state.selected?.id).toBe(
          refresh ? "archive" : undefined,
        );
        expect(session.state.calculationId).toBeUndefined();
        expect(planningProgress(session.state).ready).toBe(false);
      } finally {
        finish.release();
        await task;
      }
      expect(session.state.selected?.id).toBe("complete");
      expect(session.state.routePreview).toBeUndefined();
    });

  for (const action of ["stop", "new search", "restore", "error"])
    it(`clears provisional geometry on ${action} and ignores obsolete replies`, async () => {
      const session = sessionWithArchive();
      session.clear();
      const finish = gate();
      vi.mocked(planRoutes).mockImplementationOnce(async function* () {
        yield update;
        await finish.promise;
        if (action === "error") throw new Error("Search failed");
        yield { ...update, journeys: [journey("late")], status: "complete" };
      });
      const task = session.calculate(request, defaults, false);
      try {
        await vi.waitFor(() =>
          expect(session.state.routePreview).toEqual(preview),
        );
        if (action === "stop") session.stop("");
        if (action === "restore")
          session.restoreContext(structuredClone(session.state));
        if (action === "new search") {
          vi.mocked(planRoutes).mockImplementationOnce(async function* () {
            yield {
              ...update,
              routePreview: undefined,
              journeys: [journey("new")],
              status: "complete",
            };
          });
          await session.calculate(changedRequest, defaults, false);
        }
        if (action === "error") {
          finish.release();
          await task;
          expect(session.state.message).toBe("Search failed");
        }
        expect(session.state.routePreview).toBeUndefined();
        const current = structuredClone(session.state);
        finish.release();
        await task;
        expect(session.state).toEqual(current);
      } finally {
        finish.release();
        await task;
      }
    });
});

describe("returning from navigation", () => {
  it("keeps the explicit selection, alternatives and query time with updated journey data", async () => {
    const session = sessionWithArchive();
    vi.spyOn(Date, "now").mockReturnValue(123_000);
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield {
        phase: "base",
        incompletePhases: [],
        journeys: [journey("first"), journey("chosen"), journey("third")],
        status: "complete",
        issues: [],
      };
    });
    await session.calculate(request, defaults, false);
    session.select("chosen");
    const calculationId = session.state.calculationId;
    const updated = journey("chosen", 2100);
    const renamed = {
      ...request,
      origin: { ...origin, name: "Aktueller Standort" },
    };
    vi.spyOn(Date, "now").mockReturnValue(456_000);
    session.returnFromNavigation(updated, renamed, defaults);
    expect(session.state.journeys.map((item) => item.id)).toEqual([
      "first",
      "chosen",
      "third",
    ]);
    expect(session.state.selected).toEqual(updated);
    expect(session.state.journeys[1]).toBe(session.state.selected);
    expect(session.state.queriedAt).toBe(123);
    expect(session.state.calculationId).toBe(calculationId);
    expect(session.state.restored).toBe(false);
    expect(session.state.message).toBe("");
    expect(session.state.request).toEqual(renamed);
    expect(planRoutes).toHaveBeenCalledOnce();
    updated.arrival = 9999;
    expect(session.state.selected?.arrival).toBe(2100);
  });

  for (const change of [
    "origin",
    "destination",
    "stops",
    "settings",
    "time",
    "replacement",
  ] as const)
    it(`does not mix old alternatives with a changed ${change}`, () => {
      const session = sessionWithArchive();
      session.restoreContext({
        ...session.state,
        journeys: [journey("archive"), journey("other")],
        calculationId: "old",
      });
      const nextRequest = structuredClone(request);
      let nextSettings = defaults;
      if (change === "origin") nextRequest.origin.latitude += 0.01;
      if (change === "destination") nextRequest.destination.longitude += 0.01;
      if (change === "stops")
        nextRequest.stops = [{ id: "via", place: origin, stayMinutes: 5 }];
      if (change === "settings") nextSettings = changedSettings;
      if (change === "time") nextRequest.time += 60;
      session.returnFromNavigation(
        journey("archive"),
        nextRequest,
        nextSettings,
        change === "replacement",
      );
      expect(session.state.journeys.map((item) => item.id)).toEqual([
        "archive",
      ]);
      expect(session.state.request).toEqual(nextRequest);
      expect(session.state.resultSettings).toEqual(nextSettings);
      expect(session.state.calculationId).toBeUndefined();
      expect(session.state.queriedAt).toBe(100);
      expect(session.state.restored).toBe(false);
      expect(planRoutes).not.toHaveBeenCalled();
    });

  it("clears a pending search and recovery without letting a late result replace the navigated journey", async () => {
    const session = sessionWithArchive();
    const pending = gate();
    vi.mocked(planRoutes).mockImplementation(async function* () {
      await pending.promise;
      yield {
        phase: "base",
        incompletePhases: [],
        journeys: [journey("late")],
        status: "complete",
        issues: [],
      };
    });
    const task = session.calculate(changedRequest, defaults, false);
    session.returnFromNavigation(journey("archive"), request, defaults);
    expect(session.state.pendingRequest).toBeUndefined();
    expect(session.state.pendingRequestResolved).toBeUndefined();
    expect(session.state.staleReason).toBeUndefined();
    expect(session.state.recovery).toBeUndefined();
    expect(session.state.busy).toBe(false);
    pending.release();
    await task;
    expect(session.state.selected?.id).toBe("archive");
  });

  it("leaves archive copies archived until navigation actually returns, including offline", () => {
    const session = sessionWithArchive();
    expect(session.state.restored).toBe(true);
    vi.stubGlobal("navigator", { onLine: false });
    session.returnFromNavigation(journey("archive"), request, defaults);
    expect(session.state.restored).toBe(false);
    expect(session.state.queriedAt).toBe(100);
    expect(session.state.resultSettings).toEqual(defaults);
    expect(planRoutes).not.toHaveBeenCalled();
    session.restore(journey("archive"), request, 100, defaults);
    expect(session.state.restored).toBe(true);
  });
});

describe("pending search time", () => {
  it("resolves now after location and retains that time across stop and context restore", async () => {
    const session = sessionWithArchive();
    const location = gate(),
      results = gate();
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(locate).mockImplementation(async () => {
      await location.promise;
      return origin;
    });
    vi.mocked(planRoutes).mockImplementation(async function* () {
      await results.promise;
      yield {
        phase: "base",
        incompletePhases: [],
        journeys: [journey("late")],
        status: "complete",
        issues: [],
      };
    });
    const task = session.calculate(
      { ...request, timing: "now" },
      defaults,
      true,
    );
    expect(session.state.pendingRequestResolved).toBe(false);
    expect(planRoutes).not.toHaveBeenCalled();
    now = 145_000;
    location.release();
    await vi.waitFor(() => expect(planRoutes).toHaveBeenCalledOnce());
    expect(session.state.pendingRequest).toMatchObject({
      timing: "now",
      time: 145,
    });
    expect(session.state.pendingRequestResolved).toBe(true);
    expect(session.state.request).toEqual(request);
    session.stop();
    const context = structuredClone(session.state);
    session.restoreContext(context);
    expect(session.state.pendingRequestResolved).toBe(true);
    expect(session.state.pendingRequest?.time).toBe(145);
    results.release();
    await task;
    expect(session.state.selected?.id).toBe("archive");
    session.clear();
    expect(session.state.pendingRequestResolved).toBeUndefined();
  });

  for (const outcome of ["offline", "location", "service"] as const)
    it(`distinguishes the pending time after a ${outcome} failure and resets on retry`, async () => {
      const session = sessionWithArchive();
      vi.spyOn(Date, "now").mockReturnValue(145_000);
      if (outcome === "offline") vi.stubGlobal("navigator", { onLine: false });
      vi.mocked(locate).mockImplementation(async () => {
        throw new Error("Standort nicht verfügbar");
      });
      vi.mocked(planRoutes).mockImplementation(async function* () {
        throw new PlannerError("service", "Routendienst nicht verfügbar");
      });
      await session.calculate(
        { ...request, timing: "now" },
        defaults,
        outcome === "location",
      );
      expect(session.state.pendingRequestResolved).toBe(outcome === "service");
      expect(session.state.selected?.id).toBe("archive");
      if (outcome === "service")
        expect(session.state.pendingRequest?.time).toBe(145);
      session.stop();
      expect(session.state.pendingRequestResolved).toBe(outcome === "service");
      vi.stubGlobal("navigator", { onLine: true });
      const location = gate();
      vi.mocked(locate).mockImplementation(async () => {
        await location.promise;
        return origin;
      });
      const retry = session.calculate(
        { ...request, timing: "now" },
        defaults,
        true,
      );
      expect(session.state.pendingRequestResolved).toBe(false);
      session.stop();
      location.release();
      await retry;
      expect(session.state.pendingRequestResolved).toBe(false);
    });
});

describe("result context during recalculation", () => {
  for (const code of ["empty", "service"] as const)
    it(`explains past ${code} results without losing the prior selection`, async () => {
      const session = sessionWithArchive();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        throw new PlannerError(code, "Routendienst nicht verfügbar");
      });
      await session.calculate(
        { ...changedRequest, timing: "arrive" },
        changedSettings,
        false,
      );
      expect(session.state.message).toBe(
        code === "empty"
          ? "Für diesen Zeitpunkt wurden keine passenden Verbindungen gefunden."
          : "Routendienst nicht verfügbar",
      );
      expect(session.state.selected?.id).toBe("archive");
      expect(session.state.pendingRequest).toMatchObject({
        timing: "arrive",
        time: changedRequest.time,
      });
      expect(session.state.recovery?.action).toBe(
        code === "empty" ? "adjust" : "retry",
      );
    });
  for (const status of ["complete", "partial"] as const)
    it(`finishes an empty ${status} update without losing fresh results`, async () => {
      const session = sessionWithArchive();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("new")],
          status: "searching",
          issues: [],
        };
        yield {
          phase: "base",
          incompletePhases: status === "partial" ? ["base"] : [],
          journeys: [],
          status,
          issues: status === "partial" ? ["Zeitlimit"] : [],
        };
      });
      await session.calculate(changedRequest, changedSettings, false);
      expect(session.state.selected?.id).toBe("new");
      expect(session.state.busy).toBe(false);
      expect(session.state.message).toBe(
        status === "partial" ? "Zeitlimit" : "Suche abgeschlossen.",
      );
      expect(session.state.request).toEqual(changedRequest);
      expect(session.state.resultSettings).toEqual(changedSettings);
    });

  it("restores a historical fallback without reusing its calculation for persistence", () => {
    const session = sessionWithArchive();
    session.invalidateForSettings();
    const context = structuredClone({
      ...session.state,
      calculationId: "old",
      busy: true,
    });
    session.clear();
    session.restoreContext(context);
    expect(session.state).toMatchObject({
      selected: { id: "archive" },
      request,
      queriedAt: 100,
      resultSettings: defaults,
      restored: true,
      busy: false,
    });
    expect(session.state.calculationId).toBeUndefined();
    expect(session.state.staleReason).toBe(context.staleReason);
    expect(planRoutes).not.toHaveBeenCalled();
  });

  it("replaces the archived tuple only with nonempty results and retains new partial results", async () => {
    const session = sessionWithArchive();
    const first = gate(),
      finish = gate();
    vi.mocked(planRoutes).mockImplementation(async function* () {
      yield {
        phase: "base",
        incompletePhases: [],
        journeys: [],
        status: "searching",
        issues: [],
      };
      await first.promise;
      yield {
        phase: "base",
        incompletePhases: [],
        journeys: [journey("new")],
        status: "searching",
        issues: [],
      };
      await finish.promise;
      throw new Error("Weitere Suche fehlgeschlagen");
    });
    session.invalidateForSettings();
    const task = session.calculate(changedRequest, changedSettings, false);
    await vi.waitFor(() => expect(planRoutes).toHaveBeenCalledOnce());
    expect(session.state).toMatchObject({
      selected: { id: "archive" },
      request,
      resultSettings: defaults,
      queriedAt: 100,
      restored: true,
      pendingRequest: changedRequest,
    });
    first.release();
    await vi.waitFor(() => expect(session.state.selected?.id).toBe("new"));
    expect(session.state).toMatchObject({
      request: changedRequest,
      resultSettings: changedSettings,
      restored: false,
    });
    expect(session.state.queriedAt).toBeGreaterThan(100);
    expect(session.state.pendingRequest).toBeUndefined();
    expect(session.state.pendingRequestResolved).toBeUndefined();
    expect(session.state.staleReason).toBeUndefined();
    finish.release();
    await task;
    expect(session.state.selected?.id).toBe("new");
    expect(session.state.message).toBe("Weitere Suche fehlgeschlagen");
    expect(session.state.issues).toContain("Weitere Suche fehlgeschlagen");
    expect(session.state.request).toEqual(changedRequest);
    expect(session.state.resultSettings).toEqual(changedSettings);
  });

  for (const outcome of ["offline", "service pause", "empty"] as const)
    it(`retains the archive on ${outcome} before fresh results`, async () => {
      const session = sessionWithArchive();
      if (outcome === "offline") vi.stubGlobal("navigator", { onLine: false });
      vi.mocked(planRoutes).mockImplementation(async function* () {
        if (outcome === "service pause")
          throw new Error("Pause: erneut versuchen");
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [],
          status: "complete",
          issues: [],
        };
      });
      session.invalidateForSettings();
      const result = await session.calculate(
        changedRequest,
        changedSettings,
        outcome === "offline",
      );
      expect(result).toBeUndefined();
      expect(session.state).toMatchObject({
        selected: { id: "archive" },
        request,
        resultSettings: defaults,
        queriedAt: 100,
        restored: true,
        busy: false,
      });
      expect(session.state.staleReason).toBeTruthy();
      expect(session.state.message).not.toBe("");
      if (outcome === "offline") {
        expect(planRoutes).not.toHaveBeenCalled();
        expect(locate).not.toHaveBeenCalled();
      }
    });

  for (const action of ["clear", "archive", "new plan"] as const)
    it(`invalidates delayed refresh responses on ${action}`, async () => {
      const session = sessionWithArchive();
      const pending = gate();
      vi.mocked(planRoutes).mockImplementationOnce(async function* () {
        await pending.promise;
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("late")],
          status: "complete",
          issues: [],
        };
      });
      const task = session.calculate(changedRequest, changedSettings, false);
      await vi.waitFor(() => expect(planRoutes).toHaveBeenCalledOnce());
      if (action === "clear") session.clear();
      else if (action === "archive")
        session.restore(journey("other archive"), request, 200, defaults);
      else {
        vi.mocked(planRoutes).mockImplementationOnce(async function* () {
          yield {
            phase: "base",
            incompletePhases: [],
            journeys: [journey("new plan")],
            status: "complete",
            issues: [],
          };
        });
        session.clear();
        await session.calculate(request, defaults, false);
      }
      pending.release();
      await task;
      expect(session.state.selected?.id).toBe(
        action === "clear"
          ? undefined
          : action === "archive"
            ? "other archive"
            : "new plan",
      );
    });
});

describe("reading a progressive result", () => {
  for (const beforeFirst of [true, false])
    it(`holds details opened beforeFirst=${beforeFirst} and resets on a new calculation`, async () => {
      vi.stubGlobal("navigator", { onLine: true });
      const first = gate(),
        better = gate();
      vi.mocked(planRoutes).mockImplementationOnce(async function* () {
        await first.promise;
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("first")],
          status: "searching",
          issues: [],
        };
        await better.promise;
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("better", 1500)],
          status: "complete",
          issues: [],
        };
      });
      const session = new PlanningSession(new ApiClient(), () => {});
      const task = session.calculate(request, defaults, false);
      if (beforeFirst) session.holdSelection();
      first.release();
      await vi.waitFor(() => expect(session.state.selected?.id).toBe("first"));
      if (!beforeFirst) session.holdSelection();
      better.release();
      await task;
      expect(session.state.selected?.id).toBe("first");
      expect(session.state.journeys.map((j) => j.id).sort()).toEqual([
        "better",
        "first",
      ]);
      vi.mocked(planRoutes).mockImplementationOnce(async function* () {
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("first")],
          status: "searching",
          issues: [],
        };
        yield {
          phase: "base",
          incompletePhases: [],
          journeys: [journey("better", 1500)],
          status: "complete",
          issues: [],
        };
      });
      await session.calculate(request, defaults, false);
      expect(session.state.selected?.id).toBe("better");
    });
});

it("resolves current time after location once per calculation without lead", async () => {
  const session = sessionWithArchive();
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(locate).mockImplementation(async () => {
    now += 30_000;
    return origin;
  });
  const queries: RouteRequest[] = [];
  vi.mocked(planRoutes).mockImplementation(async function* (query) {
    queries.push(structuredClone(query));
    yield {
      phase: "base",
      incompletePhases: [],
      journeys: [journey("first")],
      status: "searching",
      issues: [],
    };
    now += 10_000;
    yield {
      phase: "base",
      incompletePhases: [],
      journeys: [journey("optimized")],
      status: "complete",
      issues: [],
    };
  });
  const settings = { ...defaults };
  await session.calculate(
    {
      ...request,
      timing: "now",
      stops: [{ id: "via", place: origin, stayMinutes: 3 }],
    },
    settings,
    true,
  );
  expect(queries[0].time).toBe(130);
  expect(queries[0].stops).toHaveLength(1);
  expect(session.state.request?.time).toBe(130);
  await session.calculate({ ...request, timing: "now" }, settings, false);
  expect(queries[1].time).toBe(140);
  for (const timing of ["depart", "arrive"] as const) {
    await session.calculate({ ...request, timing }, settings, false);
    expect(queries.at(-1)?.time).toBe(request.time);
  }
  vi.restoreAllMocks();
});

describe("explicit planning recovery", () => {
  for (const code of ["service", "empty", "input", "timeout", "429"])
    it(`offers a typed recovery for ${code} without losing the failed request`, async () => {
      const session = sessionWithArchive();
      const failedRequest = {
        ...changedRequest,
        stops: [{ id: "pause", place: origin, stayMinutes: 15 }],
      };
      const retryAt = code === "429" ? Date.now() / 1000 + 30 : undefined;
      vi.mocked(planRoutes).mockImplementation(async function* () {
        throw new PlannerError(code, "Translated error", false, retryAt);
      });
      await session.calculate(failedRequest, changedSettings, false);
      expect(session.state.recovery).toEqual({
        action: ["empty", "input"].includes(code) ? "adjust" : "retry",
        request: failedRequest,
        retryAt,
      });
      expect(session.state.request).toEqual(request);
      expect(session.state.selected?.id).toBe("archive");
      session.stop("");
      expect(session.state.recovery).toBeUndefined();
    });
});

describe("continuing optimization", () => {
  const partial = {
    phase: "walking" as const,
    incompletePhases: ["walking" as const],
    journeys: [journey("first"), journey("chosen")],
    status: "partial" as const,
    issues: ["Zeitlimit erreicht"],
  };

  it("keeps the calculation, resolved location and reading state across retries", async () => {
    const session = sessionWithArchive();
    vi.mocked(locate).mockResolvedValue(origin);
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield partial;
    });
    await session.calculate({ ...request, timing: "now" }, defaults, true);
    session.select("chosen");
    session.holdSelection();
    const before = structuredClone(session.state);
    const finish = gate();
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield { ...partial, journeys: [], status: "searching", issues: [] };
      await finish.promise;
      yield {
        ...partial,
        journeys: [journey("better", 1500)],
        status: "complete",
        issues: [],
        incompletePhases: [],
      };
    });
    const resume = session.resumeOptimization();
    await vi.waitFor(() => expect(session.state.busy).toBe(true));
    expect(planningProgress(session.state)).toMatchObject({
      ready: true,
      optimizing: true,
      loading: false,
    });
    expect(session.state).toMatchObject({
      calculationId: before.calculationId,
      queriedAt: before.queriedAt,
      request: before.request,
      resultSettings: before.resultSettings,
      selected: before.selected,
    });
    expect(session.state.pendingRequest).toBeUndefined();
    expect(session.state.staleReason).toBeUndefined();
    // Selection changes while the continuation is running must also be held.
    session.select("first");
    finish.release();
    await resume;
    expect(session.state.selected?.id).toBe("first");
    expect(session.state.issues).toEqual([]);
    expect(session.state.recovery).toBeUndefined();
    expect(session.state.calculationId).toBe(before.calculationId);
    expect(session.state.queriedAt).toBe(before.queriedAt);
    expect(locate).toHaveBeenCalledOnce();
    expect(vi.mocked(planRoutes).mock.calls[1][0]).toEqual(before.request);
    expect(vi.mocked(planRoutes).mock.calls[1][3]).toBe(
      vi.mocked(planRoutes).mock.calls[0][3],
    );
  });

  it("keeps usable results after another failure and clears old errors on success", async () => {
    const session = sessionWithArchive();
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield partial;
    });
    await session.calculate(request, defaults, false);
    session.select("chosen");
    const before = structuredClone(session.state);
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      throw new Error("Neuer Fehler");
    });
    await session.resumeOptimization();
    expect(session.state.journeys).toEqual(before.journeys);
    expect(session.state.selected).toEqual(before.selected);
    expect(session.state.issues).toEqual(["Neuer Fehler"]);
    expect(session.state.recovery).toMatchObject({
      action: "retry",
      mode: "optimization",
    });
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield {
        ...partial,
        status: "complete",
        incompletePhases: [],
        issues: [],
      };
    });
    await session.resumeOptimization();
    expect(session.state.searchStatus).toBe("complete");
    expect(session.state.issues).toEqual([]);
    expect(session.state.recovery).toBeUndefined();
  });

  for (const blocked of ["offline", "pause", "stop", "settings", "restore"])
    it(`does not resume after ${blocked}`, async () => {
      const session = sessionWithArchive();
      vi.mocked(planRoutes).mockImplementationOnce(async function* () {
        yield partial;
      });
      await session.calculate(request, defaults, false);
      if (blocked === "offline") vi.stubGlobal("navigator", { onLine: false });
      if (blocked === "pause")
        session.state.recovery!.retryAt = Date.now() / 1000 + 60;
      if (blocked === "stop") session.stop("");
      if (blocked === "settings") session.invalidateForSettings();
      if (blocked === "restore") {
        session.restoreContext(structuredClone(session.state));
        expect(session.state.recovery?.mode).toBe("search");
      }
      await session.resumeOptimization();
      expect(planRoutes).toHaveBeenCalledOnce();
    });

  it("ignores a late continuation after a new calculation starts", async () => {
    const session = sessionWithArchive();
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield partial;
    });
    await session.calculate(request, defaults, false);
    const finish = gate();
    let signal!: AbortSignal;
    vi.mocked(planRoutes).mockImplementationOnce(async function* (_r, _s, s) {
      signal = s;
      await finish.promise;
      yield { ...partial, journeys: [journey("late")] };
    });
    const resume = session.resumeOptimization();
    vi.mocked(planRoutes).mockImplementationOnce(async function* () {
      yield { ...partial, journeys: [journey("new")] };
    });
    await session.calculate(changedRequest, changedSettings, false);
    const current = structuredClone(session.state);
    expect(signal.aborted).toBe(true);
    expect(vi.mocked(planRoutes).mock.calls[2][3]).not.toBe(
      vi.mocked(planRoutes).mock.calls[0][3],
    );
    finish.release();
    await resume;
    expect(session.state).toEqual(current);
  });
});
