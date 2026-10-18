export type RouteHit =
  { kind: "background" | "ambiguous" } | { kind: "route"; id: string };

export function routeHitTest(
  legs: Iterable<{ id: string; distance: number }>,
  radius: number,
  selectedId?: string,
): RouteHit {
  const distances = new Map<string, number>();
  for (const { id, distance } of legs) {
    if (distance <= radius && distance < (distances.get(id) ?? Infinity))
      distances.set(id, distance);
  }
  if (!distances.size) return { kind: "background" };
  const nearest = Math.min(...distances.values());
  const candidates = [...distances].filter(
    ([, distance]) => distance <= nearest + 3,
  );
  // Preserve a selected shared segment; otherwise expose the first matching result.
  if (candidates.length > 1 && candidates.some(([id]) => id === selectedId))
    return { kind: "ambiguous" };
  return { kind: "route", id: candidates[0][0] };
}
