import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearSearchLocation,
  locate,
  prepareSearchLocation,
} from "../src/search";

const position = () =>
  ({
    coords: { latitude: 48.13, longitude: 11.57, accuracy: 10 },
    timestamp: Date.now(),
  }) as GeolocationPosition;
let requested: PositionCallback[];
let announced: ReturnType<typeof vi.fn>;

beforeEach(() => {
  requested = [];
  announced = vi.fn();
  const win = Object.assign(new EventTarget(), { isSecureContext: true });
  win.addEventListener("foldroute-location", announced);
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", {
    permissions: { query: async () => ({ state: "granted" }) },
    geolocation: {
      getCurrentPosition: (success: PositionCallback) =>
        requested.push(success),
    },
  });
});
afterEach(() => {
  clearSearchLocation();
  vi.unstubAllGlobals();
});

it("warms the search bias without publishing a location for navigation or maps", async () => {
  const pending = prepareSearchLocation();
  await Promise.resolve();
  requested[0](position());
  expect(await pending).toBe(true);
  expect(announced).not.toHaveBeenCalled();
  expect(await prepareSearchLocation()).toBe(false);
  expect(requested).toHaveLength(1);
});

it("publishes an explicitly requested location", async () => {
  const pending = locate();
  const fix = position();
  requested[0](fix);
  expect(await pending).toMatchObject({ latitude: 48.13, longitude: 11.57 });
  expect(announced).toHaveBeenCalledOnce();
  expect(announced.mock.calls[0][0].detail).toBe(fix);
});

it("discards a late search location after clearing local data", async () => {
  const pending = prepareSearchLocation();
  await Promise.resolve();
  clearSearchLocation();
  requested[0](position());
  expect(await pending).toBe(false);
  const retry = prepareSearchLocation();
  await Promise.resolve();
  expect(requested).toHaveLength(2);
  requested[1](position());
  expect(await retry).toBe(true);
  expect(announced).not.toHaveBeenCalled();
});
