import { afterEach, expect, it, vi } from "vitest";
import { journeyTimeRange } from "../src/journey-view";
afterEach(() => vi.useRealTimers());
it("shows departure and arrival with dates only when needed", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 22, 12));
  const range = (day: number, arrivalDay: number) =>
    journeyTimeRange({
      departure: new Date(2026, 8, day, 22, 31).getTime() / 1000,
      arrival:
        new Date(
          2026,
          8,
          arrivalDay,
          arrivalDay === day ? 23 : 0,
          35,
        ).getTime() / 1000,
    });
  expect(range(22, 22)).toBe("22:31 → 23:35");
  expect(range(23, 23)).toBe("23. Sept. · 22:31 → 23:35");
  expect(range(22, 23)).toBe("22. Sept. 22:31 → 23. Sept. 00:35");
});
