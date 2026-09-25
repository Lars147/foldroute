import { afterEach, expect, it, vi } from "vitest";
import { localMinute, parseLocalMinute, timeSummary } from "../src/time-picker";
afterEach(() => vi.useRealTimers());
it("rejects malformed dates and normalised invalid wall times", () => {
  expect(parseLocalMinute("2026-02-30T12:00")).toBeUndefined();
  expect(parseLocalMinute("2026-09-22T24:00")).toBeUndefined();
  expect(parseLocalMinute("2026-09-22T7:05")).toBeUndefined();
  expect(localMinute(parseLocalMinute("2026-09-22T07:05")!)).toBe(
    "2026-09-22T07:05",
  );
});
it("summarises dynamic now and fixed departure and arrival", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 22, 10));
  expect(timeSummary("now", "")).toBe("Jetzt");
  expect(timeSummary("depart", "2026-09-22T12:00")).toBe("Heute, ab 12:00");
  expect(timeSummary("arrive", "2026-09-23T18:00")).toBe("Morgen, an 18:00");
});
