import { normalizeLocationText } from "./normalize";

/**
 * Register location text to a location in this instance, in the documented
 * order: the full path ("Warehouse / Aisle 3"), then a name that exactly one
 * location has, then the mapping a person saved for text that neither found.
 *
 * Deliberately no partial matching. A register saying "Chicago / Storage"
 * must not land on "Denver / Storage" because only one location is called
 * Storage: that would send someone to move things to the wrong building.
 */

export type LocationNode = { id: string; name: string; parentId: string | null };

export type LocationResolution = {
  locationId: string | null;
  via: "path" | "name" | "mapping" | null;
  /** More than one location has this path or name, so none was chosen. */
  ambiguous: boolean;
};

export type LocationIndex = {
  resolve(text: string | null | undefined): LocationResolution;
  path(id: string | null | undefined): string | null;
};

export function buildLocationIndex(
  locations: LocationNode[],
  mapping: { sourceText: string; locationId: string }[],
): LocationIndex {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const pathCache = new Map<string, string>();

  const pathOf = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached) return cached;
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(node.name);
      cur = node.parentId;
    }
    const path = parts.join(" / ");
    pathCache.set(id, path);
    return path;
  };

  const byPath = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string | null, id: string) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const l of locations) {
    add(byPath, normalizeLocationText(pathOf(l.id)), l.id);
    add(byName, normalizeLocationText(l.name), l.id);
  }
  const mapped = new Map<string, string>();
  for (const m of mapping) {
    const key = normalizeLocationText(m.sourceText);
    if (key && byId.has(m.locationId)) mapped.set(key, m.locationId);
  }

  return {
    resolve(text) {
      const key = normalizeLocationText(text);
      if (!key) return { locationId: null, via: null, ambiguous: false };
      let ambiguous = false;
      const paths = byPath.get(key) ?? [];
      if (paths.length === 1) return { locationId: paths[0]!, via: "path", ambiguous: false };
      if (paths.length > 1) ambiguous = true;
      const names = byName.get(key) ?? [];
      if (names.length === 1) return { locationId: names[0]!, via: "name", ambiguous: false };
      if (names.length > 1) ambiguous = true;
      const m = mapped.get(key);
      if (m) return { locationId: m, via: "mapping", ambiguous: false };
      return { locationId: null, via: null, ambiguous };
    },
    path(id) {
      return id && byId.has(id) ? pathOf(id) : null;
    },
  };
}
