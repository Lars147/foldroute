import { describe, expect, it } from "vitest";
import {
  backupKeys,
  validateBackup,
  encodeBackup,
  decodeBackup,
  backupLimit,
} from "../src/backup-codec";
import { emptyNavigationStatistics } from "../src/navigation-summary";
const sample = () => ({
  format: "foldroute-backup",
  version: 1,
  exportedAt: new Date().toISOString(),
  settings: Object.fromEntries(backupKeys.map((k) => [k, null])),
  storage: { history: false, navigation: true, statistics: false },
  places: [],
  history: [],
  statistics: emptyNavigationStatistics(),
});
describe("backup format", () => {
  it("roundtrips empty retained data and disabled storage choices", async () => {
    const value = validateBackup(sample());
    expect(
      await decodeBackup(new File([encodeBackup(value)], "backup.json")),
    ).toEqual(value);
  });
  it("rejects incompatible and damaged data without silently filtering", () => {
    for (const patch of [
      { version: 2 },
      { history: [{}] },
      { places: [null] },
      { statistics: null },
      { exportedAt: "bad" },
      { storage: { history: false } },
    ])
      expect(() => validateBackup({ ...sample(), ...patch })).toThrow();
  });
  it("rejects duplicate place and trip identities", () => {
    const place = {
      id: "a",
      favorite: true,
      place: { name: "A", detail: "", latitude: 48, longitude: 11 },
    };
    expect(() =>
      validateBackup({ ...sample(), places: [place, place] }),
    ).toThrow();
    expect(() =>
      validateBackup({
        ...sample(),
        statistics: {
          ...emptyNavigationStatistics(),
          completedIds: ["x", "x"],
        },
      }),
    ).toThrow();
  });
  it("rejects unknown settings values and drops unrelated storage keys", () => {
    const value = sample();
    expect(() =>
      validateBackup({
        ...value,
        settings: { ...value.settings, "foldroute.mapStyle": "invalid" },
      }),
    ).toThrow();
    expect(
      validateBackup({
        ...value,
        settings: { ...value.settings, foreign: "secret" },
      }).settings,
    ).not.toHaveProperty("foreign");
  });
  it("rejects oversize files before reading their contents", async () => {
    const file = {
      size: backupLimit + 1,
      text: () => {
        throw new Error("Should not read");
      },
    } as unknown as File;
    await expect(decodeBackup(file)).rejects.toThrow("50 MiB");
  });
});
