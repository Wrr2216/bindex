import type { CaptureCountRule, CaptureDraftSource, CaptureDraftStatus } from "../../db/tables/bulk-capture";
import type { Detection } from "./detections";
import type { ManifestRow } from "./manifest";
import { categoryKey, colours, compareNames, conflicts, displayCategory, nameTokens, squashText } from "./names";

/**
 * Merging what several images saw into one reviewable list. Pure: the service
 * loads the drafts, calls these, and writes back what changed.
 *
 * The rules, kept conservative because a wrong merge hides a real asset while
 * a missed merge only costs a tap in the review:
 *
 * - Photos: a detection joins an existing entry only when both are in the same
 *   area (room or desk), in the same category, with no conflicting brand or
 *   model, and with names that agree (see compareNames). One image contributes
 *   at most once to an entry, since two things in one frame are two things.
 * - Counts: within one image they add up; across images the count rule
 *   decides. "max" (the default) suits overlapping photos of the same room,
 *   where the same three chairs appear again; "sum" suits photos that do not
 *   overlap.
 * - Manifest lines: joined only when the line number and the description (or
 *   the sticker number) agree, which is what photographing a page twice
 *   produces. Lines are never added together.
 * - A person's edits win: an entry someone edited keeps its fields, and a
 *   quantity someone typed is never recomputed. Deleted entries stay deleted
 *   and still absorb later sightings of the same thing.
 */

export type MergeDraft = {
  /** Null until the draft has been written. */
  id: string | null;
  status: CaptureDraftStatus;
  name: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  qty: number;
  qtyLocked: boolean;
  edited: boolean;
  manual: boolean;
  area: string | null;
  confidence: number | null;
  sources: CaptureDraftSource[];
  note: string | null;
  lineNo: number | null;
  condition: string | null;
  conditionCodes: string[];
  stickerColor: string | null;
  stickerLot: string | null;
  stickerNumber: string | null;
};

export type SourceRef = { sourceId: string; attachmentId: string; area: string | null };

export type MergeResult = {
  /** Existing drafts that changed (the same objects, updated). */
  updated: MergeDraft[];
  /** New drafts, id null, in the order they were seen. */
  created: MergeDraft[];
};

export function emptyDraft(partial: Partial<MergeDraft> & { name: string }): MergeDraft {
  return {
    id: null,
    status: "pending",
    category: null,
    brand: null,
    model: null,
    description: null,
    qty: 1,
    qtyLocked: false,
    edited: false,
    manual: false,
    area: null,
    confidence: null,
    sources: [],
    note: null,
    lineNo: null,
    condition: null,
    conditionCodes: [],
    stickerColor: null,
    stickerLot: null,
    stickerNumber: null,
    ...partial,
  };
}

const areaKey = (a: string | null | undefined) => (a ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const sameArea = (a: string | null | undefined, b: string | null | undefined) => areaKey(a) === areaKey(b);

/** Per-image counts, each image's own lines added together, in order of first appearance. */
export function countsBySource(sources: CaptureDraftSource[]): { sourceId: string; qty: number; names: string[] }[] {
  const groups = new Map<string, { sourceId: string; qty: number; names: string[] }>();
  for (const s of sources) {
    const g = groups.get(s.sourceId) ?? { sourceId: s.sourceId, qty: 0, names: [] };
    g.qty += s.qty;
    g.names.push(s.name);
    groups.set(s.sourceId, g);
  }
  return [...groups.values()];
}

/** The quantity the sources support under a count rule, or null with no sources. */
export function qtyFromSources(sources: CaptureDraftSource[], rule: CaptureCountRule): number | null {
  const counts = countsBySource(sources).map((g) => g.qty);
  if (!counts.length) return null;
  const n = rule === "sum" ? counts.reduce((a, b) => a + b, 0) : Math.max(...counts);
  return Math.max(1, Math.min(100_000, n));
}

const hasSource = (d: MergeDraft, sourceId: string) => d.sources.some((s) => s.sourceId === sourceId);

function recount(d: MergeDraft, rule: CaptureCountRule): void {
  if (d.qtyLocked) return;
  const q = qtyFromSources(d.sources, rule);
  if (q !== null) d.qty = q;
}

function bestConfidence(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** How well a detection matches a draft, by the draft's name or any name an image gave it. */
function photoMatch(d: MergeDraft, det: Detection): number {
  if (categoryKey(d.category, d.name) !== categoryKey(det.category, det.name)) return 0;
  if (conflicts(d.brand, det.brand) || conflicts(d.model, det.model)) return 0;
  // Colours count across every name the entry has had, so "red office chair"
  // cannot slip in through an earlier photo's plain "office chair".
  const names = [d.name, ...d.sources.map((s) => s.name)];
  const theirs = colours(det.name);
  const ours = new Set(names.flatMap((n) => [...colours(n)]));
  if (theirs.size && ours.size && ![...theirs].some((c) => ours.has(c))) return 0;
  let best = 0;
  for (const name of names) {
    const m = compareNames(name, det.name);
    if (m.same && m.score > best) best = m.score;
  }
  return best;
}

/**
 * Fold one photo's detections into the drafts. `drafts` is not modified;
 * changed drafts come back as copies in `updated`.
 */
export function mergePhotoDetections(
  drafts: MergeDraft[],
  detections: Detection[],
  source: SourceRef,
  rule: CaptureCountRule,
): MergeResult {
  const work = drafts.map((d) => ({ ...d, sources: [...d.sources], conditionCodes: [...d.conditionCodes] }));
  const updated = new Set<MergeDraft>();
  const created: MergeDraft[] = [];

  // Surer detections pick first, so a vague second line cannot take the
  // match a clear one should have had. New entries still keep the order the
  // model listed them in.
  const order = new Map(detections.map((d, i) => [d, i]));
  const createdAt = new Map<MergeDraft, number>();
  const ordered = [...detections].sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
  for (const det of ordered) {
    let best: MergeDraft | null = null;
    let bestScore = 0;
    for (const d of work) {
      if (d.status === "created" || !sameArea(d.area, source.area) || hasSource(d, source.sourceId)) continue;
      const score = photoMatch(d, det);
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    const contribution: CaptureDraftSource = {
      sourceId: source.sourceId,
      attachmentId: source.attachmentId,
      name: det.name,
      qty: det.qty,
      bbox: det.bbox,
      confidence: det.confidence,
    };
    if (best) {
      best.sources.push(contribution);
      recount(best, rule);
      best.confidence = bestConfidence(best.confidence, det.confidence);
      if (!best.edited) {
        best.brand ??= det.brand;
        best.model ??= det.model;
        best.description ??= det.description;
        // Prefer the more specific name: "black office chair" over "chair".
        const current = new Set(nameTokens(best.name));
        const next = nameTokens(det.name);
        if (next.length > current.size && [...current].every((t) => next.includes(t))) best.name = det.name;
      }
      updated.add(best);
      continue;
    }
    const draft = emptyDraft({
      name: det.name,
      category: det.category,
      brand: det.brand,
      model: det.model,
      description: det.description,
      qty: det.qty,
      area: source.area,
      confidence: det.confidence,
      sources: [contribution],
    });
    created.push(draft);
    createdAt.set(draft, order.get(det)!);
    // New drafts from this image are closed to the rest of it by hasSource.
    work.push(draft);
  }
  created.sort((a, b) => createdAt.get(a)! - createdAt.get(b)!);
  return { updated: [...updated], created };
}

// ---- Manifests -------------------------------------------------------------

function descriptionsAgree(a: string, b: string): boolean {
  const sa = new Set(nameTokens(a));
  const sb = new Set(nameTokens(b));
  if (!sa.size || !sb.size) return false;
  const shared = [...sa].filter((w) => sb.has(w)).length;
  if (shared === sa.size || shared === sb.size) return true;
  return shared / new Set([...sa, ...sb]).size >= 0.5;
}

const compatible = (a: string | null, b: string | null) => !a || !b || squashText(a) === squashText(b);

function manifestMatch(d: MergeDraft, row: ManifestRow): boolean {
  const sticker = squashText(row.sticker?.number);
  if (sticker && sticker === squashText(d.stickerNumber)) {
    return compatible(d.stickerLot, row.sticker?.lot ?? null) && compatible(d.stickerColor, row.sticker?.color ?? null);
  }
  if (row.lineNo === null || d.lineNo !== row.lineNo) return false;
  return descriptionsAgree(d.name, row.description) || d.sources.some((s) => descriptionsAgree(s.name, row.description));
}

/** Fold one page's manifest rows into the drafts. A line read twice is kept once, at the larger count. */
export function mergeManifestRows(drafts: MergeDraft[], rows: ManifestRow[], source: SourceRef): MergeResult {
  const work = drafts.map((d) => ({ ...d, sources: [...d.sources], conditionCodes: [...d.conditionCodes] }));
  const updated = new Set<MergeDraft>();
  const created: MergeDraft[] = [];

  for (const row of rows) {
    const area = row.room ?? source.area;
    const contribution: CaptureDraftSource = {
      sourceId: source.sourceId,
      attachmentId: source.attachmentId,
      name: row.description,
      qty: row.qty,
      bbox: null,
      confidence: row.confidence,
    };
    const match = work.find((d) => d.status !== "created" && !hasSource(d, source.sourceId) && manifestMatch(d, row));
    if (match) {
      match.sources.push(contribution);
      recount(match, "max");
      match.confidence = bestConfidence(match.confidence, row.confidence);
      if (!match.edited) {
        match.lineNo ??= row.lineNo;
        match.condition ??= row.condition;
        if (!match.conditionCodes.length) match.conditionCodes = [...row.conditionCodes];
        match.stickerColor ??= row.sticker?.color ?? null;
        match.stickerLot ??= row.sticker?.lot ?? null;
        match.stickerNumber ??= row.sticker?.number ?? null;
        match.area ??= area;
        match.description ??= row.notes;
      }
      updated.add(match);
      continue;
    }
    const draft = emptyDraft({
      name: row.description,
      category: displayCategory(null, row.description),
      description: row.notes,
      qty: row.qty,
      area,
      confidence: row.confidence,
      sources: [contribution],
      lineNo: row.lineNo,
      condition: row.condition,
      conditionCodes: [...row.conditionCodes],
      stickerColor: row.sticker?.color ?? null,
      stickerLot: row.sticker?.lot ?? null,
      stickerNumber: row.sticker?.number ?? null,
    });
    created.push(draft);
    work.push(draft);
  }
  return { updated: [...updated], created };
}

// ---- Removing an image -------------------------------------------------------

/**
 * Take one image's contributions back out, before it is re-read or deleted.
 * An entry that only that image supported goes too, unless a person edited it
 * or typed it in.
 */
export function withoutSource(
  drafts: MergeDraft[],
  sourceId: string,
  rule: CaptureCountRule,
): { updated: MergeDraft[]; removed: MergeDraft[] } {
  const updated: MergeDraft[] = [];
  const removed: MergeDraft[] = [];
  for (const d of drafts) {
    if (d.status === "created" || !hasSource(d, sourceId)) continue;
    const sources = d.sources.filter((s) => s.sourceId !== sourceId);
    if (!sources.length && !d.edited && !d.manual) {
      removed.push(d);
      continue;
    }
    const next = { ...d, sources };
    recount(next, rule);
    updated.push(next);
  }
  return { updated, removed };
}

/**
 * An image moved to another area (room or desk). Entries only it supported
 * that a person edited or deleted move with it as they are, so no edit is lost
 * and nothing deleted comes back; everything else it saw is taken out and
 * merged again in the new area, where it may join what other images saw.
 */
export function moveSource(
  drafts: MergeDraft[],
  source: SourceRef,
  reading: { kind: "photo"; items: Detection[] } | { kind: "manifest"; rows: ManifestRow[] },
  rule: CaptureCountRule,
): { updated: MergeDraft[]; created: MergeDraft[]; removed: MergeDraft[] } {
  const own = (d: MergeDraft) =>
    d.status !== "created" && d.sources.length > 0 && d.sources.every((s) => s.sourceId === source.sourceId);
  const moving = drafts.filter((d) => own(d) && (d.edited || d.status === "discarded")).map((d) => ({ ...d, area: source.area }));
  const movingIds = new Set(moving.map((d) => d.id));
  // What the moved entries already stand for is not merged a second time.
  const kept = new Set(moving.flatMap((d) => d.sources.map((s) => s.name)));

  const rest = drafts.filter((d) => !movingIds.has(d.id));
  const out = withoutSource(rest, source.sourceId, rule);
  const removedIds = new Set(out.removed.map((d) => d.id));
  const updatedById = new Map(out.updated.map((d) => [d.id, d]));
  const current = [...rest.filter((d) => !removedIds.has(d.id)).map((d) => updatedById.get(d.id) ?? d), ...moving];

  const merged =
    reading.kind === "manifest"
      ? mergeManifestRows(current, reading.rows.filter((r) => !kept.has(r.description)), source)
      : mergePhotoDetections(current, reading.items.filter((i) => !kept.has(i.name)), source, rule);

  const updated = new Map<string | null, MergeDraft>([...out.updated, ...moving].map((d) => [d.id, d]));
  for (const d of merged.updated) updated.set(d.id, d);
  return { updated: [...updated.values()], created: merged.created, removed: out.removed };
}

/** Recompute every unlocked quantity, after the count rule changes. */
export function recountAll(drafts: MergeDraft[], rule: CaptureCountRule): MergeDraft[] {
  const changed: MergeDraft[] = [];
  for (const d of drafts) {
    if (d.status === "created" || d.qtyLocked || !d.sources.length) continue;
    const q = qtyFromSources(d.sources, rule);
    if (q !== null && q !== d.qty) changed.push({ ...d, qty: q });
  }
  return changed;
}

// ---- Merging and splitting by hand -----------------------------------------

/**
 * A person says these entries are one thing. The first keeps its fields
 * (blanks filled from the others); counts follow the count rule over all their
 * images, or add up when any count was typed by hand.
 */
export function mergeByHand(target: MergeDraft, others: MergeDraft[], rule: CaptureCountRule): MergeDraft {
  const all = [target, ...others];
  const sources = all.flatMap((d) => d.sources);
  const anyLocked = all.some((d) => d.qtyLocked) || !sources.length;
  const pick = <K extends keyof MergeDraft>(k: K): MergeDraft[K] => {
    for (const d of all) if (d[k] !== null && d[k] !== undefined) return d[k];
    return target[k];
  };
  const names = all.map((d) => `“${d.name}”`);
  const merged: MergeDraft = {
    ...target,
    brand: pick("brand"),
    model: pick("model"),
    description: pick("description"),
    lineNo: pick("lineNo"),
    condition: pick("condition"),
    conditionCodes: all.find((d) => d.conditionCodes.length)?.conditionCodes ?? [],
    stickerColor: pick("stickerColor"),
    stickerLot: pick("stickerLot"),
    stickerNumber: pick("stickerNumber"),
    confidence: all.reduce<number | null>((c, d) => bestConfidence(c, d.confidence), null),
    sources,
    edited: true,
    manual: all.every((d) => d.manual),
    qtyLocked: anyLocked,
    qty: anyLocked ? Math.min(100_000, all.reduce((n, d) => n + d.qty, 0)) : (qtyFromSources(sources, rule) ?? target.qty),
    note: `Merged by hand from ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`,
  };
  return merged;
}

/**
 * Undo a merge: one entry per image it was seen in, each with that image's
 * count. Null when it was only seen in one image.
 */
export function splitBySource(d: MergeDraft): MergeDraft[] | null {
  const groups = countsBySource(d.sources);
  if (groups.length < 2) return null;
  return groups.map((g, i) => ({
    ...d,
    id: i === 0 ? d.id : null,
    name: d.edited ? d.name : g.names[0]!,
    sources: d.sources.filter((s) => s.sourceId === g.sourceId),
    qty: g.qty,
    qtyLocked: false,
    note: `Split from “${d.name}”.`,
  }));
}

/** Split `n` off an entry, for "these are two different kinds after all". */
export function splitByQty(d: MergeDraft, n: number): [MergeDraft, MergeDraft] | null {
  if (!Number.isInteger(n) || n < 1 || n >= d.qty) return null;
  return [
    { ...d, qty: d.qty - n, qtyLocked: true, note: `Split ${n} off into a separate entry.` },
    { ...d, id: null, qty: n, qtyLocked: true, edited: true, note: `Split off “${d.name}”.` },
  ];
}

// ---- Explaining ----------------------------------------------------------------

/**
 * Why an entry looks the way it does, in one or two sentences for the review
 * screen. Null when there is nothing to explain (seen once, untouched).
 */
export function explainDraft(
  d: MergeDraft,
  labelFor: (sourceId: string) => string,
  opts: { rule: CaptureCountRule; manifest?: boolean },
): string | null {
  const parts: string[] = [];
  const groups = countsBySource(d.sources);
  if (groups.length >= 2) {
    const seen = groups.map((g) => `${labelFor(g.sourceId)} (${g.qty})`);
    const list = `${seen.slice(0, -1).join(", ")} and ${seen[seen.length - 1]}`;
    if (opts.manifest) {
      parts.push(`Read from ${list}: the same line, kept once at the larger count.`);
    } else {
      parts.push(`Seen in ${list}.`);
      if (d.qtyLocked) parts.push("The quantity was set by hand.");
      else if (opts.rule === "max") parts.push("Overlapping photos usually show the same things, so the largest count is used.");
      else parts.push("These photos do not overlap, so the counts are added.");
    }
    const names = [...new Map(d.sources.map((s) => [s.name.toLowerCase(), s.name])).values()];
    if (names.length > 1 && !opts.manifest) {
      parts.push(`Called ${names.slice(0, -1).map((n) => `“${n}”`).join(", ")} and “${names[names.length - 1]}”.`);
    }
  } else if (d.qtyLocked && d.sources.length && !d.note) {
    parts.push("The quantity was set by hand.");
  }
  if (d.note) parts.push(d.note);
  return parts.length ? parts.join(" ") : null;
}
