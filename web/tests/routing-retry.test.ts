import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningSession } from "../src/planning-state";
import { optimizeWalking } from "../src/walking-optimization";
import { ApiClient, baseVariants, type RequestBudget } from "../src/transitous";
import { RoutingRun } from "../src/routing-retry";
import {
  defaults,
  modes,
  PlannerError,
  type PlanningUpdate,
  type RouteRequest,
  type Journey,
  type Leg,
} from "../src/model";
import { planRoutes } from "../src/planner";
import { PlanningRoutingClient } from "../src/planning-routing";
import fixture from "./fixtures/swift-parity.json";
vi.mock("../src/search", () => ({ locate: vi.fn() }));

const epoch = Date.parse("2026-09-04T08:00:00Z");
const url = (name = "a") => new URL(`https://example.test/${name}`);
const request: RouteRequest = {
  origin: { name: "Start", detail: "", latitude: 48.132, longitude: 11.5756 },
  destination: { name: "Ziel", detail: "", latitude: 48.175, longitude: 11.6 },
  timing: "depart",
  time: epoch / 1000,
};
const runs: RoutingRun[] = [];
function context(api: ApiClient, signal = new AbortController().signal) {
  const run = api.createRun(signal);
  runs.push(run);
  return { run, take: vi.fn() };
}
const pause = (seconds?: string, status = 429) =>
  new Response("", {
    status,
    headers: seconds === undefined ? {} : { "Retry-After": seconds },
  });
const ok = () => new Response("{}");
function reply(input: URL) {
  const p = input.searchParams;
  const from = p.get("fromPlace")!.split(",").map(Number);
  const to = p.get("toPlace")!.split(",").map(Number);
  let points = "";
  const previous = [0, 0];
  for (const point of [from, to])
    point.forEach((value, axis) => {
      const rounded = Math.round(value * 1e5),
        delta = rounded - previous[axis];
      previous[axis] = rounded;
      let bits = delta < 0 ? ~(delta << 1) : delta << 1;
      while (bits >= 32) {
        points += String.fromCharCode((32 | (bits & 31)) + 63);
        bits >>>= 5;
      }
      points += String.fromCharCode(bits + 63);
    });
  const direct = p.get("directModes") === "BIKE";
  const start = Date.parse(p.get("time")!),
    end = start + 600000;
  const polyline = { points, precision: 5 };
  const item = {
    id: input.href,
    transfers: 0,
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    legs: [
      {
        mode: direct ? "BIKE" : "BUS",
        tripId: input.href,
        from: { name: "A", lat: from[0], lon: from[1] },
        to: { name: "B", lat: to[0], lon: to[1] },
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        distance: 1000,
        legGeometry: polyline,
        steps: [{ relativeDirection: "DEPART", distance: 1000, polyline }],
      },
    ],
  };
  return new Response(
    JSON.stringify(direct ? { direct: [item] } : { itineraries: [item] }),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});
afterEach(() => {
  runs.splice(0).forEach((run) => run.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("routing HTTP retries", () => {
  it.each([true, false])(
    "direct batch runs preserve parent budget stopping (initial=%s)",
    async (initiallyStopped) => {
      const fetcher = vi.fn(async () => pause("5"));
      const api = new ApiClient(fetcher);
      const budget = { take: vi.fn(), stopped: initiallyStopped };
      const task = api
        .batch(
          request,
          defaults,
          baseVariants[0],
          new AbortController().signal,
          budget,
        )
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      budget.stopped = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await task).toMatchObject({ code: "budget" });
      expect(fetcher).toHaveBeenCalledTimes(initiallyStopped ? 0 : 1);
    },
  );

  it("does not retry503 when a parallel429 has already entered a shared wait", async () => {
    const fetcher = vi.fn(async (input: URL) =>
      input.pathname === "/a" ? pause("5") : pause(undefined, 503),
    );
    const api = new ApiClient(fetcher as typeof fetch);
    const budget = context(api);
    const signal = new AbortController().signal;
    const task = Promise.allSettled([
      api.json(url(), signal, false, budget),
      api.json(url("b"), signal, false, budget),
    ]);
    await vi.runAllTimersAsync();
    const results = await task;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(api.retryAt).toBe(epoch / 1000 + 15);
  });
  it("ignores an old429 arriving after cancellation while a new run is active", async () => {
    let release!: (response: Response) => void;
    let active = 0,
      peak = 0;
    const fetcher = vi.fn(async (input: URL) => {
      active++;
      peak = Math.max(active, peak);
      const response =
        input.pathname === "/old"
          ? await new Promise<Response>((resolve) => {
              release = resolve;
            })
          : await new Promise<Response>((resolve) =>
              setTimeout(() => resolve(ok()), 10),
            );
      active--;
      return response;
    });
    const api = new ApiClient(fetcher as typeof fetch);
    const old = new AbortController();
    const first = api
      .json(url("old"), old.signal, false, context(api, old.signal))
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    old.abort();
    const signal = new AbortController().signal;
    const budget = context(api, signal);
    const current = Promise.all([
      api.json(url("new1"), signal, false, budget),
      api.json(url("new2"), signal, false, budget),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    release(pause("60"));
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ name: "AbortError" });
    await expect(current).resolves.toEqual([{}, {}]);
    expect(api.retryAt).toBe(0);
    expect(peak).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("updates terminal recovery when another outstanding request extends the pause", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    let geocode = false;
    const fetcher = vi.fn(async () => pause(geocode ? "60" : "30"));
    const api = new ApiClient(fetcher);
    const session = new PlanningSession(api, () => {});
    const task = session.calculate(
      request,
      { ...defaults, excludedTransitModes: Object.keys(modes) },
      false,
    );
    await vi.runAllTimersAsync();
    await task;
    expect(session.state.recovery?.retryAt).toBe(epoch / 1000 + 30);
    geocode = true;
    // An already running geocode can return while routing is paused.
    api.retryAt = 0;
    await vi.advanceTimersByTimeAsync(10000);
    await expect(
      api.searchPlaces("Berlin", new AbortController().signal),
    ).rejects.toMatchObject({ code: "429" });
    expect(session.state.recovery?.retryAt).toBe(epoch / 1000 + 70);
    expect(session.state.message).toBe("Anfragelimit erreicht");
  });
  it.each([15, 16])(
    "shares one wait budget between actual via sections (15+%i)",
    async (seconds) => {
      const counts = new Map<string, number>();
      const via = { ...request.origin, name: "Via", latitude: 48.15 };
      const fetcher = vi.fn(async (input: URL) => {
        const count = (counts.get(input.href) ?? 0) + 1;
        counts.set(input.href, count);
        return count === 1
          ? pause(
              input.searchParams.get("fromPlace")!.startsWith("48.132,")
                ? "15"
                : String(seconds),
            )
          : reply(input);
      });
      const api = new ApiClient(fetcher as typeof fetch);
      const updates: PlanningUpdate[] = [];
      const task = (async () => {
        for await (const update of planRoutes(
          { ...request, stops: [{ id: "via", place: via, stayMinutes: 0 }] },
          { ...defaults, excludedTransitModes: Object.keys(modes) },
          new AbortController().signal,
          api,
        ))
          updates.push(update);
      })();
      const result = task.catch((error) => error);
      await vi.runAllTimersAsync();
      const error = await result;
      if (seconds === 15) {
        expect(error).toBeUndefined();
        expect(updates.at(-1)?.status).toBe("complete");
        expect(
          updates.at(-1)?.journeys[0].legs.some((leg) => leg.kind === "stop"),
        ).toBe(true);
      } else
        expect(error).toMatchObject({
          failures: expect.arrayContaining([
            expect.objectContaining({ code: "429" }),
          ]),
        });
      expect(fetcher).toHaveBeenCalledTimes(seconds === 15 ? 4 : 3);
    },
  );

  it("keeps the64-request via cap across real HTTP retries", async () => {
    const counts = new Map<string, number>();
    const fetcher = vi.fn(async (input: URL) => {
      const count = (counts.get(input.href) ?? 0) + 1;
      counts.set(input.href, count);
      return count < 3 ? pause("0") : reply(input);
    });
    const api = new ApiClient(fetcher as typeof fetch);
    const updates: PlanningUpdate[] = [];
    const task = (async () => {
      for await (const update of planRoutes(
        {
          ...request,
          stops: [48.14, 48.15, 48.16].map((latitude, i) => ({
            id: String(i),
            place: { ...request.origin, name: `Via${i}`, latitude },
            stayMinutes: 0,
          })),
        },
        defaults,
        new AbortController().signal,
        api,
      ))
        updates.push(update);
    })().catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await task;
    expect(fetcher).toHaveBeenCalledTimes(64);
    expect(error?.failures ?? updates.at(-1)?.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "budget" })]),
    );
  });

  it("charges walking retries to the six-attempt budget", async () => {
    const legs: Leg[] = Array.from({ length: 5 }, (_, i): Leg[] => {
      const start = epoch / 1000 + i * 1800;
      return [
        {
          kind: "walk",
          from: request.origin,
          to: request.destination,
          start,
          end: start + 600,
          distance: 1000,
          coordinates: [request.origin, request.destination],
        },
        {
          kind: "transit",
          from: request.destination,
          to: request.origin,
          start: start + 600,
          end: start + 1200,
          distance: 1000,
          coordinates: [request.destination, request.origin],
          line: "Bus",
        },
      ];
    }).flat();
    const journey: Journey = {
      id: "walks",
      origin: request.origin,
      destination: request.origin,
      departure: legs[0].start,
      arrival: legs.at(-1)!.end,
      legs,
      isDirect: false,
      transfers: 4,
    };
    const fetcher = vi.fn(async () => pause("0"));
    const api = new ApiClient(fetcher);
    const updates: { incomplete: boolean; failures?: { code: string }[] }[] =
      [];
    const task = (async () => {
      for await (const update of optimizeWalking(
        [journey],
        request,
        defaults,
        new AbortController().signal,
        api,
        context(api),
      ))
        updates.push(update);
    })();
    await vi.runAllTimersAsync();
    await task;
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(updates.at(-1)?.incomplete).toBe(true);
  });
  it("does not round a30s header below the acceptance boundary", async () => {
    let now = epoch;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const fetcher = vi.fn(async () => pause("30"));
    const api = new ApiClient(fetcher);
    await expect(
      api.json(url(), new AbortController().signal, false, context(api)),
    ).rejects.toMatchObject({ code: "429" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([10000, 15000, 60000])(
    "adds accepted pauses to a%i ms working deadline",
    async (milliseconds) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(pause("5"))
        .mockResolvedValueOnce(ok());
      const api = new ApiClient(fetcher);
      const budget = context(api);
      const deadline = budget.run.deadline(milliseconds);
      const task = api.json(url(), new AbortController().signal, false, budget);
      await vi.advanceTimersByTimeAsync(milliseconds + 4999);
      await expect(task).resolves.toEqual({});
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(deadline.signal.aborted).toBe(true);
      deadline.dispose();
    },
  );

  it("counts overlapping accepted pauses once and preserves successful in-flight work", async () => {
    let release!: (response: Response) => void;
    const seen = new Map<string, number>();
    const fetcher = vi.fn(async (input: URL) => {
      const count = (seen.get(input.pathname) ?? 0) + 1;
      seen.set(input.pathname, count);
      if (count > 1) return ok();
      return input.pathname === "/a"
        ? pause("20")
        : new Promise<Response>((resolve) => {
            release = resolve;
          });
    });
    const api = new ApiClient(fetcher as typeof fetch);
    const budget = context(api);
    const deadline = budget.run.deadline(10000);
    const signal = new AbortController().signal;
    const task = Promise.all([
      api.json(url(), signal, false, budget),
      api.json(url("b"), signal, false, budget),
    ]);
    await vi.advanceTimersByTimeAsync(10000);
    release(pause("15"));
    await vi.advanceTimersByTimeAsync(14999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(task).resolves.toEqual([{}, {}]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(9999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it("shares HTTP permits across separate runs of the same API client", async () => {
    let active = 0,
      peak = 0;
    const api = new ApiClient(
      vi.fn(async () => {
        active++;
        peak = Math.max(active, peak);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return ok();
      }),
    );
    const task = Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api.json(
          url(String(i)),
          new AbortController().signal,
          false,
          context(api),
        ),
      ),
    );
    await vi.runAllTimersAsync();
    await task;
    expect(peak).toBe(2);
  });

  it.each([true, false])(
    "retries only geometry recovery and keeps valid first-response journeys (success=%s)",
    async (succeeds) => {
      const mixed = structuredClone(fixture.direct);
      const invalid = structuredClone(mixed.direct[0]);
      invalid.id = "invalid";
      invalid.legs[0].legGeometry.points = "!";
      mixed.direct.push(invalid);
      const fetcher = vi.fn(async (_input: URL, init?: RequestInit) => {
        if (init?.cache !== "reload")
          return new Response(JSON.stringify(mixed));
        if (succeeds && fetcher.mock.calls.length === 3)
          return new Response(JSON.stringify(fixture.direct));
        return pause("1");
      });
      const api = new ApiClient(fetcher as typeof fetch);
      const budget = context(api);
      const task = api.batch(
        request,
        defaults,
        baseVariants[0],
        new AbortController().signal,
        budget,
      );
      await vi.runAllTimersAsync();
      const batch = await task;
      expect(batch.journeys).toHaveLength(1);
      expect(batch.stop).toBe(false);
      expect(batch.issues.length).toBe(succeeds ? 0 : 1);
      if (!succeeds)
        expect(batch.failures).toMatchObject([
          {
            code: "429",
            requestKey: expect.stringContaining("geometry-recovery"),
          },
        ]);
      expect(fetcher).toHaveBeenCalledTimes(succeeds ? 3 : 4);
      expect(budget.take).toHaveBeenCalledTimes(succeeds ? 3 : 4);
      const calls = fetcher.mock.calls;
      expect(
        calls
          .slice(1)
          .every(
            ([input, init]) =>
              input.href === calls[0][0].href && init?.cache === "reload",
          ),
      ).toBe(true);
    },
  );

  it("manually resumes a real session with fresh retry allowance and successful batches retained", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const counts = new Map<string, number>();
    const fetcher = vi.fn(async (input: URL) => {
      const count = (counts.get(input.href) ?? 0) + 1;
      counts.set(input.href, count);
      const p = input.searchParams;
      if (
        p.get("preTransitModes") === "WALK" &&
        p.get("postTransitModes") === "WALK" &&
        count <= 4
      )
        return pause("1");
      return new Response(
        JSON.stringify(
          p.get("directModes") === "BIKE"
            ? fixture.direct
            : { itineraries: [] },
        ),
      );
    });
    const api = new ApiClient(fetcher as typeof fetch);
    const session = new PlanningSession(api, () => {});
    const first = session.calculate(
      request,
      { ...defaults, maxBikeTransfers: 0 },
      false,
    );
    await vi.runAllTimersAsync();
    await first;
    expect(session.state.searchStatus).toBe("partial");
    const before = new Map(counts);
    const calculationId = session.state.calculationId;
    const second = session.resumeOptimization();
    await vi.runAllTimersAsync();
    await second;
    expect(session.state.searchStatus).toBe("complete");
    expect(session.state.calculationId).toBe(calculationId);
    expect(session.state.failures).toEqual([]);
    for (const [key, count] of counts)
      expect(count).toBe(before.get(key)! + (before.get(key) === 3 ? 2 : 0));
  });
  it.each([undefined, "invalid", " ", "-5"])(
    "geocoding429 stays immediate, with exactly5s fallback (%s)",
    async (header) => {
      const fetcher = vi.fn(async () => pause(header));
      const api = new ApiClient(fetcher);
      await expect(
        api.searchPlaces("Berlin", new AbortController().signal),
      ).rejects.toMatchObject({ code: "429" });
      expect(api.retryAt).toBe(epoch / 1000 + 5);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("retries the first routing request without leaving transient issues", async () => {
    let count = 0;
    const fetcher = vi.fn(async () =>
      ++count === 1 ? pause() : new Response(JSON.stringify(fixture.direct)),
    );
    const api = new ApiClient(fetcher);
    const updates: PlanningUpdate[] = [];
    const task = (async () => {
      for await (const update of planRoutes(
        request,
        { ...defaults, excludedTransitModes: Object.keys(modes) },
        new AbortController().signal,
        api,
      ))
        updates.push(update);
    })();
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(updates.every((update) => !update.issues.length)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)).toMatchObject({
      status: "complete",
      issues: [],
      failures: [],
    });
    expect(updates.at(-1)?.journeys.length).toBeGreaterThan(0);
  });

  it.each([29, 30])("accepts waits strictly below30s (%i)", async (seconds) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(pause(String(seconds)))
      .mockResolvedValueOnce(ok());
    const api = new ApiClient(fetcher);
    const budget = context(api);
    const task = api.json(url(), new AbortController().signal, false, budget);
    if (seconds === 30) {
      await expect(task).rejects.toMatchObject({ code: "429" });
      expect(fetcher).toHaveBeenCalledOnce();
    } else {
      await vi.advanceTimersByTimeAsync(29000);
      await expect(task).resolves.toEqual({});
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it.each([15, 16])(
    "counts successive wait intervals once, maximum30s (15+%i)",
    async (second) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(pause("15"))
        .mockResolvedValueOnce(pause(String(second)))
        .mockResolvedValueOnce(ok());
      const api = new ApiClient(fetcher);
      const task = api.json(
        url(),
        new AbortController().signal,
        false,
        context(api),
      );
      const result = task.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(30000);
      if (second === 15) expect(await result).toEqual({ value: {} });
      else expect(await result).toMatchObject({ error: { code: "429" } });
      expect(fetcher).toHaveBeenCalledTimes(second === 15 ? 3 : 2);
    },
  );

  it("preserves retry exhaustion across phases and refreshes allowance on manual runs", async () => {
    let succeed = false;
    const fetcher = vi.fn(async () => (succeed ? ok() : pause("1")));
    const api = new ApiClient(fetcher);
    const budget = context(api);
    const signal = new AbortController().signal;
    const task = api.json(url(), signal, false, budget);
    const rejected = expect(task).rejects.toMatchObject({
      code: "429",
      stops: false,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(api.json(url(), signal, false, budget)).rejects.toMatchObject({
      code: "429",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    budget.run.dispose();
    succeed = true;
    const next = context(api);
    const retry = api.json(url(), signal, false, next);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(retry).resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rechecks an extended shared pause and stops queued work without cancelling siblings", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(async (input: URL) =>
      input.pathname === "/b"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : pause("20"),
    );
    const api = new ApiClient(fetcher as typeof fetch);
    const budget = context(api);
    const signal = new AbortController().signal;
    const a = api.json(url(), signal, false, budget).catch((error) => error);
    const b = api.json(url("b"), signal, false, budget).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    release(pause("29"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await a).toMatchObject({ code: "429" });
    expect(await b).toMatchObject({ code: "429" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(api.retryAt).toBe(epoch / 1000 + 39);
  });

  it("limits real HTTP attempts to two, including retries, and releases permits after errors", async () => {
    let active = 0,
      peak = 0;
    const counts = new Map<string, number>();
    const fetcher = vi.fn(async (input: URL) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      const count = (counts.get(input.href) ?? 0) + 1;
      counts.set(input.href, count);
      return count === 1 ? pause("1") : ok();
    });
    const api = new ApiClient(fetcher as typeof fetch);
    const budget = context(api);
    const tasks = Array.from({ length: 5 }, (_, i) =>
      api.json(url(String(i)), new AbortController().signal, false, budget),
    );
    const task = Promise.all(tasks);
    await vi.runAllTimersAsync();
    await expect(task).resolves.toHaveLength(5);
    expect(peak).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(budget.take).toHaveBeenCalledTimes(10);
  });

  it("pauses work deadlines while an in-flight HTTP timeout keeps running", async () => {
    const fetcher = vi.fn(async (input: URL, init?: RequestInit) =>
      input.pathname === "/b"
        ? new Promise<Response>((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(init!.signal!.reason),
            ),
          )
        : pause("29"),
    );
    const api = new ApiClient(fetcher as typeof fetch);
    const budget = context(api);
    const deadline = budget.run.deadline(
      15000,
      new PlannerError("deadline", "work"),
    );
    const signal = new AbortController().signal;
    const b = api.json(url("b"), signal, false, budget).catch((error) => error);
    const a = api.json(url(), signal, false, budget).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await b).toMatchObject({ code: "timeout" });
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(23999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(await a).toMatchObject({ code: "429" });
    deadline.dispose();
  });

  it("keeps503 separate and retains its15s fallback", async () => {
    const fetcher = vi.fn(async () => pause(undefined, 503));
    const api = new ApiClient(fetcher);
    await expect(
      api.json(url(), new AbortController().signal, false, context(api)),
    ).rejects.toMatchObject({ code: "503" });
    expect(api.retryAt).toBe(epoch / 1000 + 15);
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("aborts cooldown and permit queues without sending late requests", async () => {
    const fetcher = vi.fn(async () => pause("5"));
    const api = new ApiClient(fetcher);
    const controller = new AbortController();
    const budget = context(api, controller.signal);
    const task = Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        api.json(url(String(i)), controller.signal, false, budget),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await task).every((result) => result.status === "rejected")).toBe(
      true,
    );
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it("counts retries against the real attempt budget", async () => {
    const fetcher = vi.fn(async () => pause("1"));
    const api = new ApiClient(fetcher);
    const run = context(api).run;
    let attempts = 0;
    const budget: RequestBudget = {
      run,
      take() {
        if (attempts === 2) throw new PlannerError("budget", "limit", true);
        attempts++;
      },
    };
    const result = api
      .json(url(), new AbortController().signal, false, budget)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ code: "budget" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains successful batches while a new execution retries only missing responses", async () => {
    let count = 0;
    const api = new ApiClient(
      vi.fn(async () => {
        count++;
        return new Response(JSON.stringify(fixture.direct));
      }),
    );
    const client = new PlanningRoutingClient(api);
    const signal = new AbortController().signal;
    const first = context(api);
    await client.batch(request, defaults, baseVariants[0], signal, first);
    first.run.dispose();
    await client.batch(
      request,
      defaults,
      baseVariants[0],
      signal,
      context(api),
    );
    expect(count).toBe(1);
  });
});
