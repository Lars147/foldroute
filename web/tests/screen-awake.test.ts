import { afterEach, expect, it, vi } from "vitest";
import { ScreenAwake } from "../src/screen-awake";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function sentinel() {
  return Object.assign(new EventTarget(), { release: vi.fn(async () => {}) });
}
afterEach(() => vi.unstubAllGlobals());
it("requests once while active and releases on leaving, then reacquires", async () => {
  const lock = sentinel();
  const request = vi.fn(async () => lock);
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const awake = new ScreenAwake();
  awake.setActive(true);
  awake.setActive(true);
  await flush();
  expect(request).toHaveBeenCalledExactlyOnceWith("screen");
  awake.setActive(false);
  expect(lock.release).toHaveBeenCalledOnce();
  awake.setActive(true);
  await flush();
  expect(request).toHaveBeenCalledTimes(2);
});
it("releases a late grant without replacing the current lock", async () => {
  const old = sentinel(),
    current = sentinel();
  let grant!: (lock: ReturnType<typeof sentinel>) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    )
    .mockResolvedValue(current);
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const awake = new ScreenAwake();
  awake.setActive(true);
  awake.setActive(false);
  awake.setActive(true);
  await flush();
  grant(old);
  await flush();
  expect(old.release).toHaveBeenCalledOnce();
  expect(current.release).not.toHaveBeenCalled();
  awake.setActive(false);
  expect(current.release).toHaveBeenCalledOnce();
});
it("handles unsupported browsers and rejected requests without retry loops", async () => {
  vi.stubGlobal("navigator", {});
  const unsupported = new ScreenAwake();
  expect(() => unsupported.setActive(true)).not.toThrow();
  const request = vi.fn().mockRejectedValue(new Error("low power"));
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const awake = new ScreenAwake();
  awake.setActive(true);
  await flush();
  awake.setActive(true);
  await flush();
  expect(request).toHaveBeenCalledOnce();
});
it("accepts system release and requests again on returning to the route", async () => {
  const lock = sentinel();
  const request = vi.fn(async () => lock);
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const awake = new ScreenAwake();
  awake.setActive(true);
  await flush();
  lock.dispatchEvent(new Event("release"));
  awake.setActive(false);
  expect(lock.release).not.toHaveBeenCalled();
  awake.setActive(true);
  await flush();
  expect(request).toHaveBeenCalledTimes(2);
});
