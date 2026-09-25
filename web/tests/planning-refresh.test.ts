import { afterEach, describe, expect, it, vi } from "vitest";
import { defaults, type Journey, type RouteRequest } from "../src/model";
import { PlanningSession } from "../src/planning-state";
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
});

describe("result context during recalculation", () => {
  for (const status of ["complete", "partial"] as const)
    it(`finishes an empty ${status} update without losing fresh results`, async () => {
      const session = sessionWithArchive();
      vi.mocked(planRoutes).mockImplementation(async function* () {
        yield { journeys: [journey("new")], status: "searching", issues: [] };
        yield {
          journeys: [],
          status,
          issues: status === "partial" ? ["Zeitlimit"] : [],
        };
      });
      await session.calculate(changedRequest, changedSettings, false);
      expect(session.state.selected?.id).toBe("new");
      expect(session.state.busy).toBe(false);
      expect(session.state.message).toBe(
        status === "partial" ? "Suche teilweise abgeschlossen." : "",
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
      yield { journeys: [], status: "searching", issues: [] };
      await first.promise;
      yield { journeys: [journey("new")], status: "searching", issues: [] };
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
    expect(session.state.staleReason).toBeUndefined();
    finish.release();
    await task;
    expect(session.state.selected?.id).toBe("new");
    expect(session.state.message).toBe("Weitere Suche fehlgeschlagen");
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
        yield { journeys: [], status: "complete", issues: [] };
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
        yield { journeys: [journey("late")], status: "complete", issues: [] };
      });
      const task = session.calculate(changedRequest, changedSettings, false);
      await vi.waitFor(() => expect(planRoutes).toHaveBeenCalledOnce());
      if (action === "clear") session.clear();
      else if (action === "archive")
        session.restore(journey("other archive"), request, 200, defaults);
      else {
        vi.mocked(planRoutes).mockImplementationOnce(async function* () {
          yield {
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
        yield { journeys: [journey("first")], status: "searching", issues: [] };
        await better.promise;
        yield {
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
        yield { journeys: [journey("first")], status: "searching", issues: [] };
        yield {
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
    yield { journeys: [journey("first")], status: "searching", issues: [] };
    now += 10_000;
    yield {
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
