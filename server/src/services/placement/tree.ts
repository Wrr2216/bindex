/**
 * The location tree, held in memory, as placement needs it: whether one place
 * is inside another, the names on the way down to a place, finding a room by
 * name under a building, and which floor a place is on. Pure, so the matching
 * rules are tested without a database.
 */

export type PlaceRow = { id: string; name: string; parentId: string | null };

export type Tree = {
  byId: Map<string, PlaceRow>;
  children: Map<string, PlaceRow[]>;
};

export function buildTree(rows: readonly PlaceRow[]): Tree {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = children.get(r.parentId);
    if (list) list.push(r);
    else children.set(r.parentId, [r]);
  }
  return { byId, children };
}

/** Names compare the way people write them: case, and runs of spaces, do not matter. */
export const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** `id`, then its parent, up to the top. Stops on a cycle rather than looping. */
export function ancestry(id: string, tree: Tree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur) && tree.byId.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = tree.byId.get(cur)!.parentId;
  }
  return out;
}

/** Names from the top of the tree down to `id`. */
export const pathNames = (id: string, tree: Tree): string[] =>
  ancestry(id, tree)
    .reverse()
    .map((a) => tree.byId.get(a)!.name);

/** True when `inner` is `outer` or anywhere beneath it. */
export const within = (inner: string, outer: string, tree: Tree): boolean => ancestry(inner, tree).includes(outer);

/**
 * How the place something was seen in relates to where it should be:
 * - same: the very place
 * - inside: somewhere within it (a reader covering one wall of the room)
 * - contains: the place is within where it was seen (seen on the right floor,
 *   destined for a room on it)
 * - apart: neither
 */
export type Relation = "same" | "inside" | "contains" | "apart";

export function relation(seen: string, planned: string, tree: Tree): Relation {
  if (seen === planned) return "same";
  if (within(seen, planned, tree)) return "inside";
  if (within(planned, seen, tree)) return "contains";
  return "apart";
}

/** Every place beneath `rootId` (not the root itself), or every place when root is null. */
function* descendants(rootId: string | null, tree: Tree): Generator<PlaceRow> {
  if (rootId === null) {
    yield* tree.byId.values();
    return;
  }
  const stack = [...(tree.children.get(rootId) ?? [])];
  const seen = new Set<string>([rootId]);
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    yield row;
    stack.push(...(tree.children.get(row.id) ?? []));
  }
}

/** Places beneath `rootId` (anywhere, when null) with this name, minus any `exclude` rejects. */
export function findByName(
  rootId: string | null,
  name: string,
  tree: Tree,
  exclude: (id: string) => boolean = () => false,
): string[] {
  const want = normName(name);
  if (!want) return [];
  const out: string[] = [];
  for (const row of descendants(rootId, tree)) {
    if (normName(row.name) === want && !exclude(row.id)) out.push(row.id);
  }
  return out;
}

/**
 * The names between `ancestorId` (not included) and `id` (included), top
 * first; empty when they are the same place and null when `id` is not beneath
 * `ancestorId`. For Old HQ / L3 / Finance / Desk 12 under Old HQ, that is
 * [L3, Finance, Desk 12].
 */
export function relativeNames(id: string, ancestorId: string, tree: Tree): string[] | null {
  const chain = ancestry(id, tree);
  const at = chain.indexOf(ancestorId);
  if (at < 0) return null;
  return chain
    .slice(0, at)
    .reverse()
    .map((a) => tree.byId.get(a)!.name);
}

/**
 * Follow `names` down from `fromId`, one level per name. Null when a step has
 * no child of that name, or more than one, since guessing a room is worse than
 * asking.
 */
export function descend(fromId: string, names: readonly string[], tree: Tree): string | null {
  let cur = fromId;
  for (const name of names) {
    const want = normName(name);
    const hits = (tree.children.get(cur) ?? []).filter((c) => normName(c.name) === want);
    if (hits.length !== 1) return null;
    cur = hits[0]!.id;
  }
  return cur;
}

// "Level 5", "Floor 3", "L5", "B1", "3rd floor", "Ground", "Mezzanine"...
const FLOOR_PATTERNS = [
  /^(floor|level|lvl|lv|fl|storey|story|etage|deck)\.?\s*[-#:]?\s*[a-z0-9.]{1,6}$/i,
  /^[a-z0-9.]{1,6}(st|nd|rd|th)?\s+(floor|level|storey|story)$/i,
  /^(ground|basement|mezzanine|lower ground|upper ground|penthouse|roof|attic|cellar)(\s+(floor|level))?$/i,
  /^[lbfg]\d{1,3}$/i,
];

export const isFloorName = (name: string): boolean => FLOOR_PATTERNS.some((p) => p.test(name.trim()));

/** The name of the nearest place at or above `id` that reads as a floor, if any. */
export function floorOf(id: string, tree: Tree): string | null {
  for (const a of ancestry(id, tree)) {
    const name = tree.byId.get(a)!.name;
    if (isFloorName(name)) return name.trim();
  }
  return null;
}
