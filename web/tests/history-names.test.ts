import { afterEach, expect, it, vi } from "vitest";
import {
  genericHistoryName,
  reverseAddress,
  HistoryNameQueue,
} from "../src/history-names";
import {
  historySnapshot,
  retainHistory,
  type HistoryEntry,
} from "../src/offline";
import { defaults } from "../src/model";
const coordinate = { latitude: 48.1372, longitude: 11.5756 };
const address = {
  type: "ADDRESS",
  lat: coordinate.latitude,
  lon: coordinate.longitude,
  street: "Marienplatz",
  houseNumber: "22",
  areas: [
    { name: "München", default: true },
    { name: "Altstadt", adminLevel: 9 },
  ],
};
const place = { ...coordinate, name: "Startpunkt", detail: "" };
function entry(id = "a"): HistoryEntry {
  return {
    id,
    calculationId: id,
    snapshot: {
      version: 3,
      savedAt: 10,
      settings: defaults,
      request: {
        origin: { ...place },
        destination: { ...place, name: "Daglfing", latitude: 48.15 },
        time: 10,
        timing: "now",
      },
      journey: {
        id,
        origin: { ...place },
        destination: { ...place, name: "Daglfing", latitude: 48.15 },
        departure: 10,
        arrival: 20,
        transfers: 0,
        isDirect: true,
        legs: [],
      },
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
it("formats near addresses, missing numbers and distant locality fallbacks", () => {
  expect(reverseAddress([address], coordinate)).toBe("Marienplatz 22, München");
  expect(
    reverseAddress([{ ...address, houseNumber: undefined }], coordinate),
  ).toBe("Marienplatz, München");
  expect(reverseAddress([{ ...address, lat: 49 }], coordinate)).toBe(
    "Altstadt, München",
  );
  expect(
    reverseAddress([{ ...address, lat: NaN }], coordinate),
  ).toBeUndefined();
  expect(reverseAddress({}, coordinate)).toBeUndefined();
  expect(genericHistoryName(" Aktueller Standort ")).toBe(true);
  expect(genericHistoryName("Daglfing")).toBe(false);
});
it("keeps display metadata separate and retains it only for unchanged coordinates", () => {
  const original = entry();
  original.placeNames = { origin: "Marienplatz 22, München" };
  const opened = historySnapshot(original);
  expect(opened.request.origin.name).toBe("Marienplatz 22, München");
  expect(original.snapshot.request.origin.name).toBe("Startpunkt");
  expect(opened.request.origin.latitude).toBe(coordinate.latitude);
  const newer = entry("b");
  newer.snapshot.savedAt = 20;
  expect(retainHistory([original], newer)[0].placeNames).toEqual(
    original.placeNames,
  );
  newer.snapshot.request.origin.latitude += 0.00001;
  expect(retainHistory([original], newer)[0].placeNames).toBeUndefined();
});
it("serializes lookups, shares equal coordinates and skips named places", async () => {
  let finish!: (value: string) => void;
  const resolve = vi.fn(
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  const save = vi.fn(async () => {});
  const queue = new HistoryNameQueue(resolve, save);
  queue.setActive(true);
  queue.enqueue([entry(), entry("b")]);
  expect(resolve).toHaveBeenCalledTimes(1);
  finish("Marienplatz 22, München");
  await flush();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(2);
});
it("ignores late responses after cancellation and clears cached data", async () => {
  let finish!: (value: string) => void;
  const resolve = vi.fn(
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  const save = vi.fn(async () => {});
  const queue = new HistoryNameQueue(resolve, save);
  queue.setActive(true);
  queue.enqueue([entry()]);
  queue.clear();
  finish("Old result");
  await flush();
  expect(save).not.toHaveBeenCalled();
  queue.enqueue([entry()]);
  expect(resolve).toHaveBeenCalledTimes(2);
  queue.setActive(false);
  finish("Cancelled");
  await flush();
  expect(save).not.toHaveBeenCalled();
});
it("retries failures only on a later visit after five minutes", async () => {
  vi.useFakeTimers();
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue("Marienplatz 22, München");
  const save = vi.fn(async () => {});
  const queue = new HistoryNameQueue(resolve, save);
  queue.setActive(true);
  queue.enqueue([entry()]);
  await flush();
  queue.enqueue([entry()]);
  await flush();
  expect(resolve).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300000);
  queue.enqueue([entry()]);
  await flush();
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledOnce();
});
it("times out requests without losing history", async () => {
  vi.useFakeTimers();
  const resolve = vi.fn(
    (_point, signal: AbortSignal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  const save = vi.fn(async () => {});
  const queue = new HistoryNameQueue(resolve, save);
  queue.setActive(true);
  queue.enqueue([entry()]);
  await vi.advanceTimersByTimeAsync(10000);
  expect(save).not.toHaveBeenCalled();
  queue.enqueue([entry()]);
  await flush();
  expect(resolve).toHaveBeenCalledTimes(1);
});
