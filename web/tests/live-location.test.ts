import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LiveLocation,
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
  expect(changed).toHaveBeenLastCalledWith(readFix(position()), "current");
  service.setActive(false);
  expect(clear).toHaveBeenCalledWith(1);
  changed.mockClear();
  callbacks.get(1)!.success(position(10, Date.now() + 1, 49));
  expect(changed).not.toHaveBeenCalled();
  service.setActive(true);
  await flush();
  expect(watch).toHaveBeenCalledTimes(2);
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
  expect(changed).toHaveBeenLastCalledWith();
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
  const rejected = expect(service.center()).rejects.toThrow("dauert zu lange");
  await vi.advanceTimersByTimeAsync(12000);
  await rejected;
  expect(clear).not.toHaveBeenCalled();
});
