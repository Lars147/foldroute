import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LiveLocation,
  LocationError,
  announceLocation,
  quality,
  readFix,
} from "../src/live-location";
let permission: { state: PermissionState; onchange: (() => void) | null };
let callbacks: Map<
  number,
  { success: PositionCallback; error: PositionErrorCallback }
>;
let watch: ReturnType<typeof vi.fn>,
  clear: ReturnType<typeof vi.fn>,
  query: ReturnType<typeof vi.fn>;
const position = (accuracy = 10, timestamp = Date.now(), latitude = 48.13) =>
  ({
    coords: { latitude, longitude: 11.57, accuracy },
    timestamp,
  }) as GeolocationPosition;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function singleRequests() {
  const requests: {
    success: PositionCallback;
    error: PositionErrorCallback;
    options?: PositionOptions;
  }[] = [];
  const single = vi.fn(
    (
      success: PositionCallback,
      error: PositionErrorCallback,
      options?: PositionOptions,
    ) => requests.push({ success, error, options }),
  );
  Object.assign(navigator.geolocation, { getCurrentPosition: single });
  return requests;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  const win = Object.assign(new EventTarget(), { isSecureContext: true });
  vi.stubGlobal("window", win);
  permission = { state: "granted", onchange: null };
  callbacks = new Map();
  let id = 0;
  watch = vi.fn((success: PositionCallback, error: PositionErrorCallback) => {
    callbacks.set(++id, { success, error });
    return id;
  });
  clear = vi.fn();
  query = vi.fn(async () => permission);
  vi.stubGlobal("navigator", {
    geolocation: { watchPosition: watch, clearWatch: clear },
    permissions: { query },
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("starts once for granted permission and ignores callbacks after pause", async () => {
  const changed = vi.fn(),
    service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  service.setActive(true);
  expect(watch).toHaveBeenCalledTimes(1);
  expect(watch.mock.calls[0][2]).toEqual({
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 12000,
  });
  callbacks.get(1)!.success(position());
  expect(changed).toHaveBeenLastCalledWith(
    readFix(position()),
    "current",
    undefined,
  );
  service.setActive(false);
  expect(clear).toHaveBeenCalledWith(1);
  changed.mockClear();
  callbacks.get(1)!.success(position(10, Date.now() + 1, 49));
  expect(changed).not.toHaveBeenCalled();
  service.setActive(true);
  await flush();
  expect(watch).toHaveBeenCalledTimes(2);
});
it("reports automatic recovery only while fresh lookups are allowed and active", async () => {
  singleRequests();
  const service = new LiveLocation(vi.fn());
  expect(service.automaticRefreshActive).toBe(false);
  service.setActive(true);
  await flush();
  expect(service.automaticRefreshActive).toBe(true);
  callbacks.get(1)!.error({ code: 2 } as GeolocationPositionError);
  expect(service.automaticRefreshActive).toBe(true);
  permission.state = "denied";
  permission.onchange!();
  expect(service.automaticRefreshActive).toBe(false);
  permission.state = "granted";
  permission.onchange!();
  expect(service.automaticRefreshActive).toBe(true);
  service.setActive(false);
  expect(service.automaticRefreshActive).toBe(false);
});
it.each(["prompt", "denied"] as const)(
  "does not prompt automatically when permission is %s",
  async (state) => {
    permission.state = state;
    const service = new LiveLocation(vi.fn());
    service.setActive(true);
    await flush();
    expect(watch).not.toHaveBeenCalled();
    permission.state = "granted";
    permission.onchange!();
    expect(watch).toHaveBeenCalledTimes(1);
  },
);
it("stops and removes the marker when permission is revoked", async () => {
  const changed = vi.fn(),
    service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  permission.state = "denied";
  permission.onchange!();
  expect(clear).toHaveBeenCalledWith(1);
  expect(changed).toHaveBeenLastCalledWith(
    undefined,
    undefined,
    expect.objectContaining({ reason: "permission-denied" }),
  );
  changed.mockClear();
  callbacks.get(1)!.success(position());
  expect(changed).not.toHaveBeenCalled();
  permission.state = "granted";
  permission.onchange!();
  expect(watch).toHaveBeenCalledTimes(2);
});
it("does not act on a permission query resolved after leaving the map", async () => {
  let resolve!: (p: unknown) => void;
  query.mockImplementation(() => new Promise((r) => (resolve = r)));
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  service.setActive(false);
  resolve(permission);
  await flush();
  expect(watch).not.toHaveBeenCalled();
});
it("supports explicit location without permission queries and does not auto-resume", async () => {
  query.mockRejectedValue(new Error("unsupported"));
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  expect(watch).not.toHaveBeenCalled();
  const centering = service.center();
  callbacks.get(1)!.success(position());
  expect(await centering).toEqual(readFix(position()));
  service.setActive(false);
  service.setActive(true);
  await flush();
  expect(watch).toHaveBeenCalledTimes(1);
});
it("starts following a successful user-triggered planning fix", async () => {
  query.mockRejectedValue(new Error("unsupported"));
  const service = new LiveLocation(vi.fn());
  announceLocation(position());
  service.setActive(true);
  await flush();
  expect(watch).toHaveBeenCalledTimes(1);
});
it("keeps the watch when a pending centering is cancelled", async () => {
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  const centering = service.center();
  const rejection = expect(centering).rejects.toMatchObject({
    name: "AbortError",
  });
  service.cancelCenter();
  await rejection;
  expect(clear).not.toHaveBeenCalled();
});
it("ages the last fix, retains failures, and recovers on a new measurement", async () => {
  const changed = vi.fn(),
    service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position(200));
  expect(changed.mock.lastCall?.[1]).toBe("inaccurate");
  await vi.advanceTimersByTimeAsync(65000);
  expect(changed.mock.lastCall?.[1]).toBe("stale");
  callbacks.get(1)!.success(position());
  expect(changed.mock.lastCall?.[1]).toBe("current");
  callbacks.get(1)!.error({ code: 2 } as GeolocationPositionError);
  await vi.advanceTimersByTimeAsync(5000);
  expect(changed.mock.lastCall?.[1]).toBe("stale");
  callbacks.get(1)!.success(position());
  expect(changed.mock.lastCall?.[1]).toBe("current");
});
it("ignores invalid and out-of-order measurements", async () => {
  const changed = vi.fn(),
    service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  changed.mockClear();
  callbacks.get(1)!.success(position(-1));
  callbacks.get(1)!.success(position(10, Date.now() - 1000));
  callbacks.get(1)!.success(position(10, Date.now(), 100));
  expect(changed).not.toHaveBeenCalled();
  expect(quality(readFix(position(100))!)).toBe("current");
  expect(quality(readFix(position(101))!)).toBe("inaccurate");
});
it("explicit requests time out without discarding the subscription", async () => {
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  const rejected = expect(service.center()).rejects.toMatchObject({
    name: "LocationError",
    reason: "timeout",
    message: "Standortabfrage dauert zu lange.",
  });
  await vi.advanceTimersByTimeAsync(12000);
  await rejected;
  expect(clear).not.toHaveBeenCalled();
});

it.each([
  [1, "permission-denied"],
  [2, "unavailable"],
  [3, "timeout"],
] as const)(
  "reports provider error %s and recovers with GPS",
  async (code, reason) => {
    const changed = vi.fn(),
      service = new LiveLocation(changed);
    service.setActive(true);
    await flush();
    callbacks.get(1)!.success(position());
    callbacks.get(1)!.error({ code } as GeolocationPositionError);
    const error = changed.mock.lastCall?.[2];
    expect(error).toBeInstanceOf(LocationError);
    expect(error.reason).toBe(reason);
    if (code !== 1) {
      expect(error.message).not.toMatch(/Berechtigung|erlauben|Einstellungen/);
      callbacks.get(1)!.success(position());
      expect(changed).toHaveBeenLastCalledWith(
        readFix(position()),
        "current",
        undefined,
      );
    }
  },
);

it("requests permission again explicitly after denial and recovers after allowing", async () => {
  permission.state = "denied";
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  const denied = expect(service.center(true)).rejects.toThrow(
    "Standortzugriff nicht erlaubt.",
  );
  expect(watch).toHaveBeenCalledTimes(1);
  callbacks.get(1)!.error({ code: 1 } as GeolocationPositionError);
  await denied;
  permission.state = "prompt";
  permission.onchange!();
  expect(watch).toHaveBeenCalledTimes(1);
  const retry = service.center(true);
  expect(watch).toHaveBeenCalledTimes(2);
  callbacks.get(2)!.success(position());
  expect(await retry).toEqual(readFix(position()));
});

it("starts accurate requests with a quick fix while retaining the GPS watch", async () => {
  const single = vi.fn((success: PositionCallback) => success(position(40)));
  Object.assign(navigator.geolocation, { getCurrentPosition: single });
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  expect(await service.center(true)).toEqual(readFix(position(40)));
  expect(single.mock.calls[0][2]).toEqual({
    enableHighAccuracy: false,
    maximumAge: 5000,
    timeout: 5000,
  });
  expect(watch).toHaveBeenCalledTimes(1);
  expect(clear).not.toHaveBeenCalled();
});

it("waits for precise GPS when the cached and quick fixes are inaccurate", async () => {
  Object.assign(navigator.geolocation, {
    getCurrentPosition: (success: PositionCallback) => success(position(500)),
  });
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position(200));
  const resolved = vi.fn();
  const centering = service.center(true).then(resolved);
  await flush();
  expect(resolved).not.toHaveBeenCalled();
  callbacks.get(1)!.success(position(20));
  await centering;
  expect(resolved).toHaveBeenCalledWith(readFix(position(20)));
});

it("ignores a quick fix received after cancelling the request", async () => {
  let success!: PositionCallback;
  Object.assign(navigator.geolocation, {
    getCurrentPosition: (callback: PositionCallback) => {
      success = callback;
    },
  });
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  const rejected = expect(service.center(true)).rejects.toMatchObject({
    name: "AbortError",
  });
  service.cancelCenter();
  await rejected;
  changed.mockClear();
  success(position());
  expect(changed).not.toHaveBeenCalled();
});

it("keeps recent cached locations stale until a new measurement after returning", async () => {
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  const cached = position();
  callbacks.get(1)!.success(cached);
  service.setActive(false);
  vi.advanceTimersByTime(1000);
  service.setActive(true);
  await flush();
  expect(changed).toHaveBeenLastCalledWith(readFix(cached), "stale", undefined);
  expect(watch.mock.calls[1][2].maximumAge).toBe(0);
  const resolved = vi.fn();
  const pending = service.center().then(resolved);
  callbacks.get(2)!.success(cached);
  await flush();
  expect(resolved).not.toHaveBeenCalled();
  callbacks.get(2)!.success(position());
  await pending;
  expect(resolved).toHaveBeenCalledWith(readFix(position()));
});

it("fresh requests replace a silent watch and reject cached quick fixes", async () => {
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  const cached = position();
  callbacks.get(1)!.success(cached);
  const single = vi.fn((success: PositionCallback) => success(cached));
  Object.assign(navigator.geolocation, { getCurrentPosition: single });
  vi.advanceTimersByTime(1000);
  const resolved = vi.fn();
  const pending = service.center(true, { fresh: true }).then(resolved);
  await flush();
  expect(clear).toHaveBeenCalledWith(1);
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[1][2].maximumAge).toBe(0);
  expect(single.mock.calls[0][2].maximumAge).toBe(0);
  expect(resolved).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(readFix(cached), "stale", undefined);
  changed.mockClear();
  callbacks.get(1)!.success(position(10, Date.now(), 49));
  expect(changed).not.toHaveBeenCalled();
  callbacks.get(2)!.success(position(500));
  await flush();
  expect(resolved).not.toHaveBeenCalled();
  callbacks.get(2)!.success(position());
  await pending;
  expect(resolved).toHaveBeenCalledWith(readFix(position()));
});

it("fresh retries work without permission queries after returning", async () => {
  query.mockRejectedValue(new Error("unsupported"));
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  const first = service.center(true);
  callbacks.get(1)!.success(position());
  await first;
  service.setActive(false);
  vi.advanceTimersByTime(1000);
  service.setActive(true);
  await flush();
  expect(watch).toHaveBeenCalledTimes(1);
  const retry = service.center(true, { fresh: true });
  expect(watch).toHaveBeenCalledTimes(2);
  callbacks.get(2)!.success(position());
  expect(await retry).toEqual(readFix(position()));
});

it("restarts another watch after a timeout and ignores old one-shot replies", async () => {
  const singles: PositionCallback[] = [];
  Object.assign(navigator.geolocation, {
    getCurrentPosition: (success: PositionCallback) => singles.push(success),
  });
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  const first = expect(
    service.center(true, { fresh: true }),
  ).rejects.toMatchObject({
    reason: "timeout",
  });
  await vi.advanceTimersByTimeAsync(12000);
  await first;
  const resolved = vi.fn();
  const retry = service.center(true, { fresh: true }).then(resolved);
  expect(clear.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  expect(watch).toHaveBeenCalledTimes(3);
  singles[0](position(10, Date.now(), 49));
  await flush();
  expect(resolved).not.toHaveBeenCalled();
  singles[1](position());
  await retry;
  expect(resolved).toHaveBeenCalledWith(readFix(position()));
});

it("cancels a fresh request when hidden and ignores its late reply after return", async () => {
  let single!: PositionCallback;
  Object.assign(navigator.geolocation, {
    getCurrentPosition: (success: PositionCallback) => (single = success),
  });
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  const pending = expect(
    service.center(true, { fresh: true }),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  service.setActive(false);
  await pending;
  vi.advanceTimersByTime(1000);
  service.setActive(true);
  await flush();
  changed.mockClear();
  single(position(10, Date.now(), 49));
  callbacks.get(2)!.success(position(10, Date.now(), 49));
  expect(changed).not.toHaveBeenCalled();
  callbacks.get(3)!.success(position());
  expect(changed).toHaveBeenLastCalledWith(
    readFix(position()),
    "current",
    undefined,
  );
});

it("does not let a delayed permission query interrupt an explicit fresh request", async () => {
  let resolve!: (status: unknown) => void;
  query.mockImplementation(() => new Promise((done) => (resolve = done)));
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  const pending = service.center(true, { fresh: true });
  permission.state = "prompt";
  resolve(permission);
  await flush();
  expect(clear).not.toHaveBeenCalled();
  expect(watch).toHaveBeenCalledTimes(1);
  callbacks.get(1)!.success(position());
  expect(await pending).toEqual(readFix(position()));
});

it("refreshes a stationary location after 30 seconds without restarting its watch", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(29999);
  expect(requests).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(requests[0].options).toEqual({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 12000,
  });
  for (let i = 0; i < 4; i++) {
    if (i) await vi.advanceTimersByTimeAsync(30000);
    expect(requests).toHaveLength(i + 1);
    requests[i].success(position());
    expect(changed).toHaveBeenLastCalledWith(
      readFix(position()),
      "current",
      undefined,
    );
  }
  expect(watch).toHaveBeenCalledTimes(1);
  expect(clear).not.toHaveBeenCalled();
});

it("does not request extra positions while the watch supplies fresh measurements", async () => {
  const requests = singleRequests();
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  for (let i = 0; i < 6; i++) {
    callbacks.get(1)!.success(position());
    await vi.advanceTimersByTimeAsync(20000);
  }
  expect(requests).toHaveLength(0);
});

it("keeps retrying when inaccurate watch measurements arrive every ten seconds", async () => {
  const requests = singleRequests();
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  for (let i = 0; i < 12; i++) {
    callbacks.get(1)!.success(position(500));
    await vi.advanceTimersByTimeAsync(10000);
  }
  expect(service.automaticRefreshActive).toBe(true);
  expect(requests).toHaveLength(4);
});

it("schedules recovery from the last usable fix rather than a later inaccurate fix", async () => {
  const requests = singleRequests();
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position(500));
  await vi.advanceTimersByTimeAsync(25000);
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(5000);
  callbacks.get(1)!.success(position(500));
  await vi.advanceTimersByTimeAsync(24999);
  expect(requests).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(requests).toHaveLength(1);
});

it("accepts an accurate refresh after an inaccurate watch sample arrives during the request", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(30000);
  await vi.advanceTimersByTimeAsync(1000);
  callbacks.get(1)!.success(position(500));
  await vi.advanceTimersByTimeAsync(1000);
  requests[0].success(position());
  expect(changed).toHaveBeenLastCalledWith(
    readFix(position()),
    "current",
    undefined,
  );
  expect(requests).toHaveLength(1);
});

it.each([undefined, 2, 3])(
  "bounds silent or failed refreshes (%s) while retaining the last measurement",
  async (code) => {
    const requests = singleRequests();
    const changed = vi.fn();
    const service = new LiveLocation(changed);
    service.setActive(true);
    await flush();
    const original = position();
    callbacks.get(1)!.success(original);
    await vi.advanceTimersByTimeAsync(30000);
    if (code) requests[0].error({ code } as GeolocationPositionError);
    await vi.advanceTimersByTimeAsync(15000);
    expect(requests).toHaveLength(1);
    expect(changed).toHaveBeenLastCalledWith(
      readFix(original),
      "current",
      undefined,
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenLastCalledWith(
      readFix(original),
      "stale",
      undefined,
    );
    requests[0].success(position(10, Date.now(), 49));
    requests[0].error({ code: 1 } as GeolocationPositionError);
    expect(changed.mock.lastCall?.[0]).toEqual(readFix(original));
    expect(clear).not.toHaveBeenCalled();
    requests[1].success(position());
    expect(changed).toHaveBeenLastCalledWith(
      readFix(position()),
      "current",
      undefined,
    );
  },
);

it("rejects cached and invalid refresh replies without renewing their timestamps", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  const original = position();
  callbacks.get(1)!.success(original);
  await vi.advanceTimersByTimeAsync(30000);
  requests[0].success(position(10, Date.now() - 1));
  expect(changed.mock.lastCall?.[0]).toEqual(readFix(original));
  await vi.advanceTimersByTimeAsync(30000);
  requests[1].success(position(10, Date.now(), 100));
  expect(changed.mock.lastCall?.[0]).toEqual(readFix(original));
  await vi.advanceTimersByTimeAsync(5000);
  expect(changed.mock.lastCall?.[1]).toBe("stale");
});

it("keeps the accuracy limit on fresh automatic measurements", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(30000);
  requests[0].success(position(101));
  expect(changed).toHaveBeenLastCalledWith(
    readFix(position(101)),
    "inaccurate",
    undefined,
  );
});

it("lets manual requests supersede automatic replies and suppress further refreshes", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(30000);
  const resolved = vi.fn();
  const pending = service.center(true, { fresh: true }).then(resolved);
  expect(requests).toHaveLength(2);
  changed.mockClear();
  requests[0].success(position(10, Date.now(), 49));
  requests[0].error({ code: 1 } as GeolocationPositionError);
  await flush();
  expect(changed).not.toHaveBeenCalled();
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(requests).toHaveLength(2);
  requests[1].success(position());
  await pending;
  expect(resolved).toHaveBeenCalledWith(readFix(position()));
});

it("does not start an automatic refresh while a manual request is pending", async () => {
  const requests = singleRequests();
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(29000);
  const pending = service.center(true, { fresh: true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(requests).toHaveLength(1);
  requests[0].success(position());
  await pending;
});

it("ignores automatic replies and errors superseded by a watch measurement", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(30000);
  callbacks.get(1)!.success(position());
  changed.mockClear();
  requests[0].success(position(10, Date.now(), 49));
  requests[0].error({ code: 1 } as GeolocationPositionError);
  expect(changed).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it("stops refreshing while inactive and ignores replies from the previous activation", async () => {
  const requests = singleRequests();
  const changed = vi.fn();
  const service = new LiveLocation(changed);
  service.setActive(true);
  await flush();
  callbacks.get(1)!.success(position());
  await vi.advanceTimersByTimeAsync(30000);
  service.setActive(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(requests).toHaveLength(1);
  service.setActive(true);
  await flush();
  changed.mockClear();
  requests[0].success(position(10, Date.now(), 49));
  requests[0].error({ code: 1 } as GeolocationPositionError);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30000);
  expect(requests).toHaveLength(2);
  requests[1].success(position());
  expect(changed.mock.lastCall?.[1]).toBe("current");
});

it.each(["prompt", "denied"] as const)(
  "never prompts through automatic refresh when permission is %s",
  async (state) => {
    const requests = singleRequests();
    permission.state = state;
    const service = new LiveLocation(vi.fn());
    service.setActive(true);
    await flush();
    await vi.advanceTimersByTimeAsync(90000);
    expect(requests).toHaveLength(0);
    expect(watch).not.toHaveBeenCalled();
  },
);

it("refreshes without Permissions API only after a successful explicit fix in this activation", async () => {
  query.mockRejectedValue(new Error("unsupported"));
  const requests = singleRequests();
  const service = new LiveLocation(vi.fn());
  service.setActive(true);
  await flush();
  await vi.advanceTimersByTimeAsync(60000);
  expect(requests).toHaveLength(0);
  const pending = service.center();
  callbacks.get(1)!.success(position());
  await pending;
  await vi.advanceTimersByTimeAsync(30000);
  expect(requests).toHaveLength(1);
  service.setActive(false);
  service.setActive(true);
  await flush();
  await vi.advanceTimersByTimeAsync(60000);
  expect(requests).toHaveLength(1);
});

it.each(["permission-change", "provider-error"])(
  "removes the location and stops automatic refresh on denial through %s",
  async (source) => {
    const requests = singleRequests();
    const changed = vi.fn();
    const service = new LiveLocation(changed);
    service.setActive(true);
    await flush();
    callbacks.get(1)!.success(position());
    await vi.advanceTimersByTimeAsync(30000);
    if (source === "permission-change") {
      permission.state = "denied";
      permission.onchange!();
    } else requests[0].error({ code: 1 } as GeolocationPositionError);
    expect(changed).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ reason: "permission-denied" }),
    );
    requests[0].success(position());
    await vi.advanceTimersByTimeAsync(60000);
    expect(requests).toHaveLength(1);
    expect(changed.mock.lastCall?.[0]).toBeUndefined();
    expect(clear).toHaveBeenCalledWith(1);
  },
);
