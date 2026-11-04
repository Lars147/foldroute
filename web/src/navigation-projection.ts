import type { Coordinate } from "./model";
import type { LocationFix } from "./live-location";
import { distance } from "./geometry";

export interface Projection {
  meters: number;
  distance: number;
  length: number;
  bearing: number;
}
export const headingDelta = (from: number, to: number) =>
  ((((to - from + 180) % 360) + 360) % 360) - 180;

/** Project onto segments, restricting candidates to the current part of the path. */
export function projectPath(
  point: Coordinate,
  path: Coordinate[],
  min = 0,
  max = Infinity,
): Projection {
  let length = 0;
  let best = { meters: 0, distance: Infinity, length: 0, bearing: 0 };
  const scale = Math.cos((point.latitude * Math.PI) / 180);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    const segment = distance(a, b);
    const ax = (a.longitude - point.longitude) * scale,
      ay = a.latitude - point.latitude;
    const dx = (b.longitude - a.longitude) * scale,
      dy = b.latitude - a.latitude;
    const t =
      dx || dy
        ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        : 0;
    const meters = length + segment * t;
    const d = distance(point, {
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    });
    if (meters >= min && meters <= max && d < best.distance - 0.01)
      best = {
        meters,
        distance: d,
        length: 0,
        bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
      };
    length += segment;
  }
  return { ...best, length };
}

/** Street matching must agree for guidance and presentation, including route loops. */
export function projectMovementPath(
  fix: LocationFix,
  path: Coordinate[],
  min = 0,
  max = Infinity,
): Projection | undefined {
  const candidates: Projection[] = [];
  let offset = 0;
  for (let i = 1; i < path.length; i++) {
    const candidate = projectPath(fix, [path[i - 1], path[i]]);
    candidate.meters += offset;
    offset += candidate.length;
    if (
      candidate.meters >= min &&
      candidate.meters <= max &&
      candidate.distance <= Math.max(40, fix.accuracy)
    )
      candidates.push(candidate);
  }
  const selected = selectProjection(
    candidates,
    fix,
    Math.max(30, 2 * fix.accuracy),
  );
  if (!selected) return;
  return { ...selected, length: offset };
}

/** Candidate geometry is shared; callers retain their evidence thresholds. */
export function selectProjection(
  candidates: Projection[],
  fix: LocationFix,
  separationMeters: number,
): Projection | undefined {
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) return;
  const nearby = candidates.filter(
    (c) => c.distance <= best.distance + Math.max(10, fix.accuracy),
  );
  const separated = (a: Projection, b: Projection) =>
    Math.abs(a.meters - b.meters) > separationMeters;
  let selected = best;
  if (nearby.some((c) => separated(best, c))) {
    if (fix.heading === undefined || (fix.speed ?? 0) < 1) return;
    const aligned = nearby.filter(
      (c) => Math.abs(headingDelta(fix.heading!, c.bearing)) <= 60,
    );
    if (!aligned[0] || aligned.some((c) => separated(aligned[0], c))) return;
    selected = aligned[0];
  }
  return selected;
}

/** Reject off-route and ambiguous projections, including overlapping route loops. */
export function projectTransitPath(
  fix: LocationFix,
  path: Coordinate[],
  min: number,
): Projection | undefined {
  const projection = projectPath(fix, path, min);
  if (projection.distance > 100) return;
  let offset = 0;
  for (let i = 1; i < path.length; i++) {
    const alternative = projectPath(fix, [path[i - 1], path[i]]);
    const position = offset + alternative.meters;
    if (
      position >= min &&
      Math.abs(position - projection.meters) > 200 &&
      alternative.distance <= projection.distance + Math.max(10, fix.accuracy)
    )
      return;
    offset += alternative.length;
  }
  return projection;
}
