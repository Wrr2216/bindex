import type { Location } from "../types";

/**
 * Display label for a location in pickers/lists. Nested locations show their
 * full ancestor path, so a tote reads like "Warehouse / Shelf A / Tote 1".
 */
export function locationPath(
  l: Pick<Location, "id" | "name" | "parentId" | "parentName">,
  byId?: Map<string, Pick<Location, "id" | "name" | "parentId">>,
): string {
  // With only one location in hand, the immediate parent the server sent is
  // as much of the path as can be shown.
  if (!byId) return l.parentName ? `${l.parentName} / ${l.name}` : l.name;
  const parts = [l.name];
  const seen = new Set<string>([l.id]);
  let cur = l.parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = byId.get(cur);
    if (!p) break;
    parts.unshift(p.name);
    cur = p.parentId ?? null;
  }
  return parts.join(" / ");
}

/** Build a labeler over a full location list so each gets its complete path. */
export function makeLocationLabel(
  locations: Pick<Location, "id" | "name" | "parentId" | "parentName">[],
): (l: Pick<Location, "id" | "name" | "parentId" | "parentName">) => string {
  const byId = new Map(locations.map((l) => [l.id, l]));
  return (l) => locationPath(l, byId);
}

/** Backwards-compatible single-location label (immediate parent only). */
export function locationLabel(l: Pick<Location, "id" | "name" | "parentId" | "parentName">): string {
  return locationPath(l);
}
