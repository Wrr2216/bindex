/**
 * Location lookups for manifests, over a list of locations held in memory:
 * matching what a move plan calls a destination to a location record, walking
 * a subtree ("everything on floor 3"), and naming the floor and department an
 * item sits in. Pure, so it is tested without a database.
 */

export type PlaceRow = { id: string; name: string; parentId: string | null };

export type PlaceIndex = {
  byId: Map<string, PlaceRow>;
  children: Map<string, PlaceRow[]>;
  /** Printed location code (LOC-XXXXXX), uppercased, to id. */
  byCode: Map<string, string>;
  /** Full path, lowercased and with single " / " separators, to id. */
  byPath: Map<string, string>;
  /** Lowercased name to every id with that name. */
  byName: Map<string, string[]>;
};

const normPath = (s: string) =>
  s
    .split(/\s*(?:\/|>|\\)\s*/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .join(" / ");

/** Names from the top of the tree down to `id`. Stops on a cycle rather than looping. */
export function pathOf(id: string, byId: ReadonlyMap<string, PlaceRow>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = byId.get(cur);
    if (!row) break;
    names.unshift(row.name);
    cur = row.parentId;
  }
  return names;
}

export function buildPlaceIndex(rows: readonly PlaceRow[], codeOf: (id: string) => string): PlaceIndex {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, PlaceRow[]>();
  const byCode = new Map<string, string>();
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
    byCode.set(codeOf(r.id).toUpperCase(), r.id);
    byPath.set(normPath(pathOf(r.id, byId).join(" / ")), r.id);
    const key = r.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), r.id]);
  }
  return { byId, children, byCode, byPath, byName };
}

export type PlaceMatch =
  | { ok: true; id: string }
  | { ok: false; reason: "unknown" | "ambiguous"; candidates: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a person wrote for a place, to a location: its id, its printed code, its
 * full path ("HQ / Level 5 / 5.12") or, when only one location has it, its
 * name. The end of a path also matches ("Level 5 / 5.12"), again only when
 * unambiguous.
 */
export function matchPlace(raw: string, index: PlaceIndex): PlaceMatch {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "unknown", candidates: [] };
  if (UUID.test(value) && index.byId.has(value.toLowerCase())) return { ok: true, id: value.toLowerCase() };
  const byCode = index.byCode.get(value.toUpperCase());
  if (byCode) return { ok: true, id: byCode };

  const path = normPath(value);
  const exact = index.byPath.get(path);
  if (exact) return { ok: true, id: exact };

  if (path.includes(" / ")) {
    const suffix = ` / ${path}`;
    const hits = [...index.byPath.entries()].filter(([p]) => p.endsWith(suffix)).map(([, id]) => id);
    if (hits.length === 1) return { ok: true, id: hits[0]! };
    return { ok: false, reason: hits.length ? "ambiguous" : "unknown", candidates: hits };
  }

  const named = index.byName.get(value.toLowerCase()) ?? [];
  if (named.length === 1) return { ok: true, id: named[0]! };
  return { ok: false, reason: named.length ? "ambiguous" : "unknown", candidates: named };
}

/** `rootId` and every location beneath it. */
export function subtreeIds(rootId: string, index: PlaceIndex): string[] {
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of index.children.get(id) ?? []) stack.push(child.id);
  }
  return out;
}

/**
 * The names between `rootId` and `id`, root first: for a desk at
 * HQ / Level 3 / Finance / Desk 12 under root Level 3, that is
 * [Level 3, Finance, Desk 12]. Empty when `id` is not under the root.
 */
export function pathFromRoot(id: string, rootId: string, index: PlaceIndex): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = index.byId.get(cur);
    if (!row) return [];
    names.unshift(row.name);
    if (cur === rootId) return names;
    cur = row.parentId;
  }
  return [];
}
