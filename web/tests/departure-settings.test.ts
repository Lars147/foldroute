import { expect, it } from "vitest";
import { defaults, migrateSettings } from "../src/model";
it("ignores obsolete departure lead without resetting personal routing options", () => {
  const settings = { ...defaults, maxCyclingMinutes: 17, foldingDuration: 240 };
  expect(migrateSettings(settings)).toEqual(settings);
  for (const departureLeadMinutes of [0, 2, 15, "obsolete"]) {
    expect(migrateSettings({ ...settings, departureLeadMinutes })).toEqual(
      settings,
    );
  }
  const { foldingDuration, ...legacy } = settings;
  expect(
    migrateSettings({
      ...legacy,
      foldDuration: 240,
      unfoldDuration: 180,
      departureLeadMinutes: 2,
    }),
  ).toEqual(settings);
});
