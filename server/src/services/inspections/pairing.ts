import type { FindingSeverity, PairSource } from "../../db/schema";
import { severityRank } from "./model";

/**
 * Post-move findings against pre-move findings: which damage was already
 * there, which is new, which got worse and which is gone.
 *
 * Pure and deterministic. The decisions that are not (a pair the AI proposed,
 * a pair a person chose or ruled out) are stored on the post finding and
 * passed in; everything else is recomputed from room and spot on every call,
 * so the comparison a signer saw can be rebuilt exactly for verification.
 *
 * Order of precedence, each claiming findings the later steps cannot:
 *   1. a person's decision ("same as pre #3", or "not in the pre-inspection");
 *   2. an AI pair, while both findings still exist and are unclaimed;
 *   3. same room and same spot, the closest descriptions first.
 */

export type PairingFinding = {
  id: string;
  sequence: number;
  room: string;
  locationId: string | null;
  spot: string;
  spotDetail: string | null;
  description: string;
  severity: FindingSeverity;
  preExisting: boolean;
  /** Post findings only: the stored decision. */
  pairedWithId?: string | null;
  pairSource?: PairSource | null;
};

export type ChangeKind = "new" | "worsened" | "resolved" | "unchanged";
export const CHANGE_KINDS: readonly ChangeKind[] = ["new", "worsened", "resolved", "unchanged"];

/** How a pair was decided: stored by a person or the AI, or matched by room and spot. */
export type MatchSource = PairSource | "room_spot";

export type ComparisonEntry<F extends PairingFinding = PairingFinding> = {
  change: ChangeKind;
  pre: F | null;
  post: F | null;
  source: MatchSource | null;
  /**
   * A post finding with no pre match that the crew marked as already there
   * (the facility contact pointed it out, say). Counted as unchanged, not new.
   */
  notedPreExisting: boolean;
};

export type Comparison<F extends PairingFinding = PairingFinding> = {
  entries: ComparisonEntry<F>[];
  counts: Record<ChangeKind, number>;
};

const FILLER = new Set(["the", "room", "rm", "area", "space", "of", "a", "an"]);

/**
 * A room name reduced to what identifies it: case, punctuation and filler
 * words ("Room", "the") dropped, so "Room 3.12" and "3.12" agree. Numbers are
 * kept whole, so "Room 101" and "Room 102" never do.
 */
export function normalizeRoom(room: string): string {
  return room
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

/** The last level of a "Floor 3 / Kitchen" path. */
const lastSegment = (room: string) => room.split(/\s*[/>]\s*/).pop() ?? room;

/**
 * Two findings are in the same room when both name the same location record,
 * or, when either is free text, their names agree. A location-linked name is
 * a path below the site ("Floor 3 / Kitchen"), so free text is also checked
 * against its last level.
 */
export function sameRoom(
  a: Pick<PairingFinding, "room" | "locationId">,
  b: Pick<PairingFinding, "room" | "locationId">,
): boolean {
  if (a.locationId && b.locationId) return a.locationId === b.locationId;
  const na = normalizeRoom(a.room);
  const nb = normalizeRoom(b.room);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (a.locationId && normalizeRoom(lastSegment(a.room)) === nb) return true;
  if (b.locationId && na === normalizeRoom(lastSegment(b.room))) return true;
  return false;
}

const STOP = new Set(["the", "a", "an", "and", "of", "on", "in", "to", "with", "at", "by", "near", "is", "are"]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/** Dice coefficient over the words of two descriptions: 0 for nothing shared, 1 for the same words. */
export function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return (2 * shared) / (wa.size + wb.size);
}

const describe = (f: PairingFinding) => `${f.spotDetail ?? ""} ${f.description}`;

function classify<F extends PairingFinding>(pre: F, post: F, source: MatchSource): ComparisonEntry<F> {
  const change: ChangeKind = severityRank(post.severity) > severityRank(pre.severity) ? "worsened" : "unchanged";
  return { change, pre, post, source, notedPreExisting: false };
}

export function compareFindings<F extends PairingFinding>(preFindings: F[], postFindings: F[]): Comparison<F> {
  const preById = new Map(preFindings.map((f) => [f.id, f]));
  const claimedPre = new Set<string>();
  const settledPost = new Set<string>();
  const entries: ComparisonEntry<F>[] = [];
  const bySequence = (a: F, b: F) => a.sequence - b.sequence || a.id.localeCompare(b.id);
  const post = [...postFindings].sort(bySequence);

  // 1 and 2: stored decisions, a person's before the AI's.
  for (const source of ["manual", "ai"] as const) {
    for (const f of post) {
      if (settledPost.has(f.id) || f.pairSource !== source) continue;
      const target = f.pairedWithId ? preById.get(f.pairedWithId) : undefined;
      if (target && !claimedPre.has(target.id)) {
        claimedPre.add(target.id);
        settledPost.add(f.id);
        entries.push(classify(target, f, source));
      } else if (source === "manual" && !f.pairedWithId) {
        // Ruled out by a person: never paired automatically.
        settledPost.add(f.id);
      }
    }
  }

  // 3: same room and spot. Every candidate pair is scored and the closest
  // descriptions pair first, so two scuffs and a dent on one wall pair with
  // the scuffs and the dent they resemble rather than in the order written.
  const candidates: { pre: F; post: F; score: number }[] = [];
  for (const p of post) {
    if (settledPost.has(p.id)) continue;
    for (const b of preFindings) {
      if (claimedPre.has(b.id) || b.spot !== p.spot || !sameRoom(b, p)) continue;
      candidates.push({ pre: b, post: p, score: textSimilarity(describe(b), describe(p)) });
    }
  }
  candidates.sort(
    (x, y) => y.score - x.score || x.pre.sequence - y.pre.sequence || x.post.sequence - y.post.sequence,
  );
  for (const c of candidates) {
    if (claimedPre.has(c.pre.id) || settledPost.has(c.post.id)) continue;
    claimedPre.add(c.pre.id);
    settledPost.add(c.post.id);
    entries.push(classify(c.pre, c.post, "room_spot"));
  }

  const paired = new Set(entries.map((e) => e.post!.id));
  for (const f of post) {
    if (paired.has(f.id)) continue;
    entries.push(
      f.preExisting
        ? { change: "unchanged", pre: null, post: f, source: null, notedPreExisting: true }
        : { change: "new", pre: null, post: f, source: null, notedPreExisting: false },
    );
  }
  for (const b of [...preFindings].sort(bySequence)) {
    if (!claimedPre.has(b.id)) entries.push({ change: "resolved", pre: b, post: null, source: null, notedPreExisting: false });
  }

  // New damage first, then what got worse, what is gone and what is the same;
  // within each, in the order the findings were written.
  const order = (e: ComparisonEntry<F>) => CHANGE_KINDS.indexOf(e.change);
  const seq = (e: ComparisonEntry<F>) => (e.post ?? e.pre)!.sequence;
  entries.sort((a, b) => order(a) - order(b) || seq(a) - seq(b) || (a.pre?.sequence ?? -1) - (b.pre?.sequence ?? -1));

  const counts = { new: 0, worsened: 0, resolved: 0, unchanged: 0 } satisfies Record<ChangeKind, number>;
  for (const e of entries) counts[e.change]++;
  return { entries, counts };
}

/**
 * The findings still unmatched after the stored decisions and the room-and-spot
 * rule: what is worth asking the AI about. Findings a person ruled out are not
 * offered again.
 */
export function unmatched<F extends PairingFinding>(preFindings: F[], postFindings: F[]): { pre: F[]; post: F[] } {
  const withoutAi = postFindings.map((f) => (f.pairSource === "ai" ? { ...f, pairSource: null, pairedWithId: null } : f));
  const { entries } = compareFindings(preFindings, withoutAi);
  const ruledOut = new Set(postFindings.filter((f) => f.pairSource === "manual" && !f.pairedWithId).map((f) => f.id));
  return {
    pre: entries.filter((e) => e.change === "resolved").map((e) => e.pre!),
    post: entries
      .filter((e) => e.pre === null && e.post && !ruledOut.has(e.post.id))
      .map((e) => postFindings.find((f) => f.id === e.post!.id)!),
  };
}
