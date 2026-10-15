import { describe, expect, it } from "vitest";
import { historyPlannedAt } from "../src/ui";

describe("history planning dates", () => {
  it("uses local calendar days across a year boundary", () => {
    const now = new Date(2027, 0, 1, 0, 5);
    expect(historyPlannedAt(new Date(2027, 0, 1, 0, 1).getTime() / 1000, now))
      .toBe("Geplant heute, 00:01");
    expect(historyPlannedAt(new Date(2026, 11, 31, 23, 59).getTime() / 1000, now))
      .toBe("Geplant gestern, 23:59");
    expect(historyPlannedAt(new Date(2026, 11, 30, 12).getTime() / 1000, now))
      .toContain("2026");
  });
  it("keeps yesterday independent of the elapsed number of hours", () => {
    expect(historyPlannedAt(new Date(2026, 2, 28, 23, 59).getTime() / 1000,
      new Date(2026, 2, 29, 0, 1))).toBe("Geplant gestern, 23:59");
    const date = historyPlannedAt(new Date(2026, 2, 26, 12).getTime() / 1000,
      new Date(2026, 2, 29));
    expect(date).not.toMatch(/heute|gestern|2026/);
    expect(date).toContain("12:00");
  });
});
