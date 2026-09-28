import { descend, findByName, floorOf, normName, relativeNames, within, type Tree } from "./tree";

/**
 * Proposing destinations for manifest lines that have none, from where each
 * line came from. Pure: the service loads the lines, the tree and the job's
 * room map, and applies what the person accepts.
 *
 * In order of preference:
 *
 * 1. The job's room map. A row maps an origin place to a destination place,
 *    and covers everything beneath it: with "Old HQ / L3 / Finance" mapped to
 *    "New HQ / L5 / Finance", a desk at ".../Finance/Desk 12" goes to
 *    ".../Finance/Desk 12" at the new site when there is one, and to the new
 *    Finance area when there is not. The nearest mapped place wins.
 * 2. The same path. With both ends of the move known (the job's origin and
 *    destination, or roots the person picks), L3 / 3.14 under the origin goes
 *    to L3 / 3.14 under the destination.
 * 3. The same room name, anywhere under the destination, when exactly one
 *    place has it (or exactly one whose parent also has the same name).
 * 4. The line's department, when exactly one place under the destination is
 *    named after it.
 *
 * Nothing is guessed: a name that matches two places is reported as
 * ambiguous and left for a person or a room map row.
 */

export type ProposalReason = "room_map" | "same_path" | "same_name" | "department";

export type ProposalLine = {
  id: string;
  originLocationId: string | null;
  destinationLocationId: string | null;
  department: string | null;
  floor: string | null;
};

export type Proposal = {
  jobItemId: string;
  destinationLocationId: string;
  reason: ProposalReason;
  /**
   * A floor to set with it: the one the destination's path names, when the
   * line has no floor, or has the floor of the destination being replaced.
   */
  floor: string | null;
  /** The line already has a destination, and this would replace it. */
  replaces: string | null;
};

export type Unmatched = {
  jobItemId: string;
  originLocationId: string | null;
  reason: "no_origin" | "no_match" | "ambiguous";
  candidates: string[];
};

export type ProposalOptions = {
  /** Origin place to origin place-or-area, then destination; see the rules above. */
  roomMap?: ReadonlyMap<string, string>;
  /** Top of the move's origin, such as the old building. */
  originRootId?: string | null;
  /** Top of the move's destination, such as the new building. */
  destinationRootId?: string | null;
  /** Also propose for lines that already have a destination. */
  overwrite?: boolean;
};

export type ProposalResult = { proposals: Proposal[]; unmatched: Unmatched[]; skipped: number };

type Found = { id: string; reason: ProposalReason } | { ambiguous: string[] } | null;

function viaRoomMap(origin: string, tree: Tree, roomMap: ReadonlyMap<string, string>): Found {
  // Walk up from the origin itself; the nearest mapped place decides.
  let cur: string | null = origin;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const target = roomMap.get(cur);
    if (target && tree.byId.has(target)) {
      const rest = relativeNames(origin, cur, tree) ?? [];
      return { id: (rest.length ? descend(target, rest, tree) : null) ?? target, reason: "room_map" };
    }
    cur = tree.byId.get(cur)?.parentId ?? null;
  }
  return null;
}

function byName(
  name: string,
  destinationRoot: string | null,
  tree: Tree,
  notOrigin: (id: string) => boolean,
  originParentName: string | null,
): Found {
  const hits = findByName(destinationRoot, name, tree, notOrigin);
  if (hits.length === 1) return { id: hits[0]!, reason: "same_name" };
  if (hits.length > 1 && originParentName) {
    // Two "Kitchen"s: prefer the one whose parent is named like the origin's.
    const want = originParentName.trim().toLowerCase();
    const narrowed = hits.filter((h) => {
      const parent = tree.byId.get(h)?.parentId;
      return parent ? tree.byId.get(parent)!.name.trim().toLowerCase() === want : false;
    });
    if (narrowed.length === 1) return { id: narrowed[0]!, reason: "same_name" };
  }
  return hits.length ? { ambiguous: hits } : null;
}

/**
 * The floor to write with a new destination. A floor the plan chose is kept;
 * one that only echoed the old destination's floor follows the new one.
 */
function nextFloor(line: ProposalLine, destinationId: string, tree: Tree): string | null {
  const next = floorOf(destinationId, tree);
  if (!line.floor) return next;
  const old = line.destinationLocationId ? floorOf(line.destinationLocationId, tree) : null;
  if (!old || !next || normName(old) !== normName(line.floor) || normName(next) === normName(old)) return null;
  return next;
}

export function proposeDestinations(
  lines: readonly ProposalLine[],
  tree: Tree,
  opts: ProposalOptions = {},
): ProposalResult {
  const roomMap = opts.roomMap ?? new Map<string, string>();
  const originRoot = opts.originRootId && tree.byId.has(opts.originRootId) ? opts.originRootId : null;
  const destinationRoot =
    opts.destinationRootId && tree.byId.has(opts.destinationRootId) ? opts.destinationRootId : null;
  const out: ProposalResult = { proposals: [], unmatched: [], skipped: 0 };

  for (const line of lines) {
    if (line.destinationLocationId && !opts.overwrite) {
      out.skipped += 1;
      continue;
    }
    const origin = line.originLocationId && tree.byId.has(line.originLocationId) ? line.originLocationId : null;
    // A room at the origin is never its own destination, and without a
    // destination root nothing at the origin site should be proposed either.
    const notOrigin = (id: string) =>
      (origin !== null && id === origin) || (originRoot !== null && within(id, originRoot, tree));

    let found: Found = null;
    let ambiguous: string[] = [];
    const note = (f: Found) => {
      if (f && "ambiguous" in f && !ambiguous.length) ambiguous = f.ambiguous;
      return f && "id" in f ? f : null;
    };

    if (origin) {
      found = note(viaRoomMap(origin, tree, roomMap));
      if (!found && originRoot && destinationRoot) {
        const rest = relativeNames(origin, originRoot, tree);
        const id = rest && rest.length ? descend(destinationRoot, rest, tree) : null;
        if (id) found = { id, reason: "same_path" };
      }
      if (!found) {
        const row = tree.byId.get(origin)!;
        const parentName = row.parentId ? (tree.byId.get(row.parentId)?.name ?? null) : null;
        found = note(byName(row.name, destinationRoot, tree, notOrigin, parentName));
      }
    }
    if (!found && line.department) {
      const f = byName(line.department, destinationRoot, tree, notOrigin, null);
      found = note(f && "id" in f ? { id: f.id, reason: "department" } : f);
    }

    if (!found) {
      out.unmatched.push({
        jobItemId: line.id,
        originLocationId: origin,
        reason: ambiguous.length ? "ambiguous" : origin || line.department ? "no_match" : "no_origin",
        candidates: ambiguous,
      });
      continue;
    }
    if (found.id === line.destinationLocationId) {
      out.skipped += 1;
      continue;
    }
    out.proposals.push({
      jobItemId: line.id,
      destinationLocationId: found.id,
      reason: found.reason,
      floor: nextFloor(line, found.id, tree),
      replaces: line.destinationLocationId,
    });
  }
  return out;
}
