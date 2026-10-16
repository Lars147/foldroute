import { distance } from "./geometry";
import type { Coordinate, Leg, Maneuver } from "./model";

export interface NavigationCue {
  key: string;
  meters: number;
  maneuver: Maneuver;
}

const plain = (direction: string) =>
  direction === "CONTINUE" || direction === "DEPART";
export const verticalManeuver = (direction: string) =>
  direction === "STAIRS" || direction === "ELEVATOR";
const bearing = (from: Coordinate, to: Coordinate) =>
  (Math.atan2(
    (to.longitude - from.longitude) *
      Math.cos(((from.latitude + to.latitude) / 2) * (Math.PI / 180)),
    to.latitude - from.latitude,
  ) *
    180) /
  Math.PI;
const angle = (from: number, to: number) =>
  ((((to - from + 180) % 360) + 360) % 360) - 180;

function directionFor(turn: number): string {
  const side = turn < 0 ? "LEFT" : "RIGHT";
  if (Math.abs(turn) >= 165) return `UTURN_${side}`;
  return Math.abs(turn) >= 135 ? `HARD_${side}` : side;
}

/** Derive guidance without changing the path or persisted source-step indices. */
export function navigationCues(
  leg: Leg,
  path: Coordinate[],
  stepOffsets: number[],
): NavigationCue[] {
  const steps = leg.maneuvers ?? [];
  const supplied = steps.flatMap((maneuver, index) =>
    plain(maneuver.direction)
      ? []
      : [{ key: `step:${index}`, meters: stepOffsets[index], maneuver }],
  );
  const points: { coordinate: Coordinate; meters: number; index: number }[] =
    [];
  let total = 0;
  path.forEach((coordinate, index) => {
    if (index) total += distance(path[index - 1], coordinate);
    if (
      !points.length ||
      distance(points.at(-1)!.coordinate, coordinate) >= 0.05
    )
      points.push({ coordinate, meters: total, index });
  });
  const protectedSpans = steps.flatMap((step, index) =>
    verticalManeuver(step.direction)
      ? [[stepOffsets[index] - 10, (stepOffsets[index + 1] ?? total) + 10]]
      : [],
  );
  const sample = (meters: number): Coordinate => {
    // Binary search keeps dense route geometry cheap to inspect.
    let low = 1,
      high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].meters < meters) low = middle + 1;
      else high = middle;
    }
    const from = points[low - 1],
      to = points[low],
      fraction = (meters - from.meters) / (to.meters - from.meters);
    return {
      latitude:
        from.coordinate.latitude +
        (to.coordinate.latitude - from.coordinate.latitude) * fraction,
      longitude:
        from.coordinate.longitude +
        (to.coordinate.longitude - from.coordinate.longitude) * fraction,
    };
  };
  const inferred: (NavigationCue & { turn: number })[] = [];
  let stepIndex = 0,
    clusterEnd = -Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const { coordinate, meters, index } = points[i];
    while (stepIndex + 1 < steps.length && stepOffsets[stepIndex + 1] <= meters)
      stepIndex++;
    if (
      meters < 3 ||
      total - meters < 3 ||
      (steps.length && !plain(steps[stepIndex].direction)) ||
      supplied.some((cue) => Math.abs(cue.meters - meters) <= 10) ||
      protectedSpans.some(([start, end]) => meters >= start && meters <= end)
    )
      continue;
    const local = angle(
      bearing(points[i - 1].coordinate, coordinate),
      bearing(coordinate, points[i + 1].coordinate),
    );
    const turn = angle(
      bearing(sample(Math.max(0, meters - 10)), coordinate),
      bearing(coordinate, sample(Math.min(total, meters + 10))),
    );
    if (
      Math.abs(local) < 30 - 1e-6 ||
      Math.abs(turn) < 45 - 1e-6 ||
      (local * turn <= 0 && !(Math.abs(local) >= 165 && Math.abs(turn) >= 165))
    )
      continue;
    const cue = {
      key: `geometry:${index}`,
      meters,
      turn,
      maneuver: {
        direction: directionFor(turn),
        streetName: steps[stepIndex]?.streetName?.trim() ?? "",
        distance: 0,
        coordinates: [coordinate],
      },
    };
    const previous = inferred.at(-1);
    if (previous && meters - clusterEnd <= 10 && previous.turn * turn > 0) {
      if (Math.abs(turn) > Math.abs(previous.turn))
        inferred[inferred.length - 1] = cue;
    } else inferred.push(cue);
    clusterEnd = meters;
  }
  return [...supplied, ...inferred].sort((a, b) => a.meters - b.meters);
}
