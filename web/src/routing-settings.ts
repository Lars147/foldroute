export const modes = {
  suburbanRail: { name: "S-Bahn", values: ["SUBURBAN"] },
  subway: { name: "U-Bahn", values: ["SUBWAY"] },
  tram: { name: "Tram", values: ["TRAM"] },
  bus: { name: "Bus", values: ["BUS", "COACH"] },
  regionalRail: { name: "Regionalzüge", values: ["REGIONAL_RAIL"] },
  longDistanceRail: {
    name: "Fernzüge",
    values: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"],
  },
};
export type ModePreference = keyof typeof modes;
export interface RoutingSettings {
  showCyclingComparison: boolean;
  foldingDuration: number;
  cyclingSpeedKilometersPerHour: number;
  maxCyclingMinutes: number;
  maxWalkingMinutes: number;
  transferMinutes: number;
  maxBikeTransfers: number;
  excludedTransitModes: ModePreference[];
}
export const defaults: RoutingSettings = {
  showCyclingComparison: true,
  foldingDuration: 180,
  cyclingSpeedKilometersPerHour: 15,
  maxCyclingMinutes: 30,
  maxWalkingMinutes: 2,
  transferMinutes: 3,
  maxBikeTransfers: 2,
  excludedTransitModes: [],
};
export const ranges = {
  cyclingSpeedKilometersPerHour: [10, 30, 1],
  maxCyclingMinutes: [1, 60, 1],
  maxWalkingMinutes: [1, 15, 1],
  transferMinutes: [0, 30, 1],
  foldingDuration: [60, 600, 30],
  maxBikeTransfers: [0, 3, 1],
} as const;
export function validSettings(value: unknown): value is RoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as RoutingSettings;
  return (
    typeof v.showCyclingComparison === "boolean" &&
    Object.entries(ranges).every(([key, [min, max, step]]) => {
      const n = v[key as keyof typeof ranges];
      return (
        Number.isFinite(n) &&
        n >= min &&
        n <= max &&
        Math.abs((n - min) / step - Math.round((n - min) / step)) < 1e-6
      );
    }) &&
    Array.isArray(v.excludedTransitModes) &&
    new Set(v.excludedTransitModes).size === v.excludedTransitModes.length &&
    v.excludedTransitModes.every((m) => Object.hasOwn(modes, m))
  );
}
export type StoredRoutingSettings = Omit<
  RoutingSettings,
  "showCyclingComparison" | "transferMinutes"
> & { showCyclingComparison?: boolean; transferMinutes?: number };
export function validStoredSettings(
  value: unknown,
): value is StoredRoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as StoredRoutingSettings;
  return (
    (v.showCyclingComparison === undefined ||
      typeof v.showCyclingComparison === "boolean") &&
    (v.transferMinutes === undefined ||
      typeof v.transferMinutes === "number") &&
    validSettings({
      ...v,
      showCyclingComparison: v.showCyclingComparison ?? true,
      transferMinutes: v.transferMinutes ?? defaults.transferMinutes,
    })
  );
}
export type LegacyRoutingSettings = Omit<
  StoredRoutingSettings,
  "foldingDuration"
> & {
  foldDuration: number;
  unfoldDuration: number;
};
export function validLegacySettings(
  value: unknown,
): value is LegacyRoutingSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as LegacyRoutingSettings;
  return (
    [v.foldDuration, v.unfoldDuration].every(
      (n, i) =>
        Number.isFinite(n) &&
        n >= (i === 0 ? 60 : 30) &&
        n <= 600 &&
        n % 30 === 0,
    ) && validStoredSettings({ ...v, foldingDuration: 180 })
  );
}
function routingSettingsFields(
  value:
    | StoredRoutingSettings
    | Omit<LegacyRoutingSettings, "foldDuration" | "unfoldDuration">,
) {
  const {
    cyclingSpeedKilometersPerHour,
    maxCyclingMinutes,
    maxWalkingMinutes,
    transferMinutes = defaults.transferMinutes,
    maxBikeTransfers,
    excludedTransitModes,
  } = value;
  return {
    cyclingSpeedKilometersPerHour,
    maxCyclingMinutes,
    maxWalkingMinutes,
    transferMinutes,
    maxBikeTransfers,
    excludedTransitModes,
  };
}
export function migrateSettings(value: unknown): RoutingSettings | undefined {
  if (validStoredSettings(value))
    return {
      ...routingSettingsFields(value),
      foldingDuration: value.foldingDuration,
      showCyclingComparison: value.showCyclingComparison ?? true,
    };
  if (!validLegacySettings(value)) return undefined;
  const { foldDuration, unfoldDuration, ...rest } = value;
  return {
    ...routingSettingsFields(rest),
    showCyclingComparison: rest.showCyclingComparison ?? true,
    foldingDuration: Math.max(60, foldDuration, unfoldDuration),
  };
}
