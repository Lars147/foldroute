import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Leg } from "../src/model";
import { TransitRefresher, type TransitResult } from "../src/transit-refresh";

const now = Date.parse("2026-10-21T08:00:00Z") / 1000;
const iso = (time: number) => new Date(time * 1000).toISOString();
const leg = (tripId: string, navigationId = tripId): Leg => ({
  kind: "transit",
  navigationId,
  from: { name: "A", detail: "", latitude: 48, longitude: 11, stopId: "A" },
  to: { name: "B", detail: "", latitude: 48.1, longitude: 11.1, stopId: "B" },
  start: now + 10,
  end: now + 120,
  distance: 0,
  coordinates: [],
  transitReference: {
    tripId,
    fromId: "A",
    toId: "B",
    scheduledDeparture: now + 10,
    scheduledArrival: now + 120,
  },
});
const response = () =>
  new Response(
    JSON.stringify({
      legs: [
        {
          from: { stopId: "A", scheduledDeparture: iso(now + 10) },
          to: { stopId: "B", scheduledArrival: iso(now + 120) },
        },
      ],
    }),
  );
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => vi.useRealTimers());

it("delivers current results and polls again while a future trip remains pending", async () => {
  const future = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>((input) =>
    new URL(input.toString()).searchParams.get("tripId") === "future"
      ? future.promise
      : Promise.resolve(response()),
  );
  const refresher = new TransitRefresher(fetcher);
  const onResult = vi.fn<(value: Map<string, TransitResult>) => void>();
  const legs = [leg("current"), leg("future")];
  const pending = refresher.refresh(legs, signal(), now, { onResult });
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).toHaveBeenCalledTimes(1);
  expect([...onResult.mock.calls[0][0].keys()]).toEqual(["current"]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await refresher.refresh(legs, signal(), now)).size).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await refresher.refresh(legs, signal())).get("current")?.kind).toBe(
    "updated",
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  future.resolve(response());
  expect((await pending).size).toBe(2);
});

it("deduplicates trips and recovery events with at most two simultaneous requests", async () => {
  const active = deferred<Response>(),
    future = deferred<Response>();
  let running = 0,
    maximum = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    running += 1;
    maximum = Math.max(maximum, running);
    const trip = new URL(input.toString()).searchParams.get("tripId");
    const result = await (trip === "current"
      ? active.promise
      : trip === "future"
        ? future.promise
        : Promise.resolve(response()));
    running -= 1;
    return result;
  });
  const refresher = new TransitRefresher(fetcher);
  const legs = [
    leg("current", "first"),
    leg("current", "second"),
    leg("future"),
    leg("later"),
  ];
  const pending = refresher.refresh(legs, signal());
  expect(
    (await refresher.refresh(legs, signal(), now, { reason: "online" })).size,
  ).toBe(0);
  expect(
    (await refresher.refresh(legs, signal(), now, { reason: "foreground" }))
      .size,
  ).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  active.resolve(response());
  future.resolve(response());
  expect((await pending).size).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(maximum).toBe(2);
});

it("does not repeat a queued trip already refreshed after a section change", async () => {
  const future = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>((input) =>
    new URL(input.toString()).searchParams.get("tripId") === "future"
      ? future.promise
      : Promise.resolve(response()),
  );
  const refresher = new TransitRefresher(fetcher);
  const pending = refresher.refresh(
    [leg("current"), leg("future"), leg("later")],
    signal(),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(
    (
      await refresher.refresh([leg("later")], signal(), undefined, {
        activeTripId: "later",
      })
    ).size,
  ).toBe(1);
  future.resolve(response());
  expect((await pending).size).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("starts success intervals at completion and keeps unavailable waits during recovery", async () => {
  const delayed = deferred<Response>();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(delayed.promise)
    .mockImplementation(async () => response());
  const refresher = new TransitRefresher(fetcher);
  const pending = refresher.refresh([leg("current")], signal());
  await vi.advanceTimersByTimeAsync(5_000);
  delayed.resolve(response());
  await pending;
  await vi.advanceTimersByTimeAsync(59_000);
  expect(
    (
      await refresher.refresh([leg("current")], signal(), undefined, {
        reason: "foreground",
      })
    ).size,
  ).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await refresher.refresh([leg("current")], signal())).size).toBe(1);
  fetcher.mockResolvedValue(new Response("", { status: 404 }));
  await vi.advanceTimersByTimeAsync(60_000);
  await refresher.refresh([leg("current")], signal());
  const calls = fetcher.mock.calls.length;
  for (const reason of ["online", "foreground"] as const)
    expect(
      (
        await refresher.refresh([leg("current")], signal(), undefined, {
          reason,
        })
      ).size,
    ).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(300_000);
  expect((await refresher.refresh([leg("current")], signal())).size).toBe(1);
});

it.each(["online", "foreground"] as const)(
  "%s skips active network retry wait only",
  async (reason) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("offline"));
    const refresher = new TransitRefresher(fetcher);
    const legs = [leg("current"), leg("future")];
    await refresher.refresh(legs, signal());
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await refresher.refresh(legs, signal())).size).toBe(0);
    fetcher.mockImplementation(async () => response());
    expect(
      [...(await refresher.refresh(legs, signal(), undefined, { reason }))].map(
        ([id]) => id,
      ),
    ).toEqual(["current"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_000);
    expect((await refresher.refresh(legs, signal())).size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      [...(await refresher.refresh(legs, signal()))].map(([id]) => id),
    ).toEqual(["current"]);
  },
);

it("online refreshes recent success while foreground preserves its interval", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response());
  const refresher = new TransitRefresher(fetcher);
  await refresher.refresh([leg("current")], signal());
  expect(
    (
      await refresher.refresh([leg("current")], signal(), undefined, {
        reason: "foreground",
      })
    ).size,
  ).toBe(0);
  expect(
    (
      await refresher.refresh([leg("current")], signal(), undefined, {
        reason: "online",
      })
    ).size,
  ).toBe(1);
});

it.each([429, 503])(
  "preserves global HTTP %s Retry-After during recovery",
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", { status, headers: { "Retry-After": "600" } }),
      )
      .mockImplementation(async () => response());
    const refresher = new TransitRefresher(fetcher),
      legs = [leg("current")];
    expect((await refresher.refresh(legs, signal())).get("current")).toEqual({
      kind: "failed",
      retryAt: now + 600,
    });
    await vi.advanceTimersByTimeAsync(599_000);
    for (const reason of ["online", "foreground"] as const)
      expect(
        (await refresher.refresh(legs, signal(), undefined, { reason })).size,
      ).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await refresher.refresh(legs, signal())).size).toBe(1);
  },
);

it("uses progressive network backoff and resets after success", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new TypeError("offline"));
  const refresher = new TransitRefresher(fetcher),
    legs = [leg("current")];
  for (const delay of [120, 240, 300]) {
    expect((await refresher.refresh(legs, signal())).get("current")?.kind).toBe(
      "failed",
    );
    await vi.advanceTimersByTimeAsync((delay - 1) * 1000);
    expect((await refresher.refresh(legs, signal())).size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
  }
  fetcher.mockImplementation(async () => response());
  await refresher.refresh(legs, signal());
  await vi.advanceTimersByTimeAsync(60_000);
  fetcher.mockRejectedValue(new TypeError("offline"));
  await refresher.refresh(legs, signal());
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await refresher.refresh(legs, signal())).size).toBe(1);
});

it("aborts without retry penalty and keeps 20 second timeout and no-store", async () => {
  const fetcher = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason),
        );
      }),
  );
  const refresher = new TransitRefresher(fetcher),
    controller = new AbortController();
  const pending = refresher.refresh([leg("current")], controller.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await rejected;
  fetcher.mockImplementationOnce(async () => response());
  expect((await refresher.refresh([leg("current")], signal())).size).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  const timeout = refresher.refresh([leg("current")], signal());
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await timeout).get("current")?.kind).toBe("failed");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
});
