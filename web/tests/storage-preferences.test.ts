import { expect, it } from "vitest";
import { readStoragePreferences } from "../src/storage-preferences";

for (const legacy of [true, false, undefined])
  it(`migrates legacy enabled=${legacy} into all three preferences`, () => {
    const enabled = legacy !== false;
    expect(readStoragePreferences(undefined, legacy)).toEqual({
      history: enabled,
      navigation: enabled,
      statistics: enabled,
    });
  });
it("retains independent choices when the legacy switch differs", () => {
  const preferences = { history: false, navigation: true, statistics: false };
  expect(readStoragePreferences(preferences, true)).toEqual(preferences);
  expect(readStoragePreferences(preferences, false)).toEqual(preferences);
});
it("uses the legacy choice only for missing or invalid fields", () => {
  expect(
    readStoragePreferences({ history: false, navigation: "yes" }, true),
  ).toEqual({ history: false, navigation: true, statistics: true });
});
