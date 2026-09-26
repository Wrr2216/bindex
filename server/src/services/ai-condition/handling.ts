import { pool } from "../../db/client";
import type { ConditionRating, ContainerFlag } from "../../db/tables/ai-condition";
import { flagLabel, normalizeFlags } from "./vocab";

/**
 * How an item should be handled, for anything that shows it to a crew: the
 * scan overlay, a manifest line, a placement card.
 *
 * The note comes from the item's most recent condition report, so recording a
 * new report replaces it (the report form carries the previous note forward
 * unless someone clears it). Handling marks such as Fragile come from the
 * item's most recent container capture.
 *
 * Other features call handlingNoteFor / handlingNotesForRefs; both run a fixed
 * number of queries however many items they are given.
 */

export type HandlingNote = {
  itemId: string;
  unitId: string | null;
  note: string | null;
  rating: ConditionRating | null;
  reportId: string | null;
  reportedAt: Date | null;
  flags: ContainerFlag[];
  /** One line for a manifest or a card: marks, a poor rating, then the note. */
  text: string;
};

const RATING_WORD: Partial<Record<ConditionRating, string>> = { poor: "Poor condition", damaged: "Damaged" };

/** "Fragile · This side up. Damaged. Handle with care to prevent further scratching." */
export function handlingText(h: { flags: readonly ContainerFlag[]; rating: ConditionRating | null; note: string | null }): string {
  const parts: string[] = [];
  if (h.flags.length) parts.push(h.flags.map(flagLabel).join(" · "));
  const warn = h.rating ? RATING_WORD[h.rating] : undefined;
  if (warn) parts.push(warn);
  const note = h.note?.trim();
  if (note) parts.push(note);
  return parts.map((p) => p.replace(/[.\s]+$/, "")).join(". ") + (parts.length ? "." : "");
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type ReportRow = { key: string; id: string; handling_note: string | null; rating: ConditionRating | null; created_at: Date };

export type HandlingRef = { itemId: string; unitId?: string | null };

/**
 * Handling for each reference, in input order; null where there is nothing
 * to say. A unit uses its own latest report, or the item's when it has none.
 */
export async function handlingNotesForRefs(refs: readonly HandlingRef[]): Promise<(HandlingNote | null)[]> {
  const itemIds = [...new Set(refs.map((r) => r.itemId).filter(isUuid))];
  const unitIds = [...new Set(refs.map((r) => r.unitId).filter((u): u is string => Boolean(u && isUuid(u))))];
  if (!itemIds.length) return refs.map(() => null);

  const [itemReports, unitReports, captures] = await Promise.all([
    pool.query<ReportRow>(
      `SELECT DISTINCT ON (item_id) item_id::text AS key, id, handling_note, rating, created_at
         FROM condition_reports
        WHERE item_id = ANY($1::uuid[]) AND unit_id IS NULL
        ORDER BY item_id, created_at DESC, id DESC`,
      [itemIds],
    ),
    unitIds.length
      ? pool.query<ReportRow>(
          `SELECT DISTINCT ON (unit_id) unit_id::text AS key, id, handling_note, rating, created_at
             FROM condition_reports
            WHERE unit_id = ANY($1::uuid[])
            ORDER BY unit_id, created_at DESC, id DESC`,
          [unitIds],
        )
      : Promise.resolve({ rows: [] as ReportRow[] }),
    pool.query<{ item_id: string; flags: string[] }>(
      `SELECT DISTINCT ON (item_id) item_id, flags
         FROM container_captures
        WHERE item_id = ANY($1::uuid[])
        ORDER BY item_id, created_at DESC, id DESC`,
      [itemIds],
    ),
  ]);

  const byItem = new Map(itemReports.rows.map((r) => [r.key, r]));
  const byUnit = new Map(unitReports.rows.map((r) => [r.key, r]));
  const flagsByItem = new Map(captures.rows.map((r) => [r.item_id, normalizeFlags(r.flags)]));

  return refs.map((ref) => {
    const report = (ref.unitId && byUnit.get(ref.unitId)) || byItem.get(ref.itemId) || null;
    const flags = flagsByItem.get(ref.itemId) ?? [];
    const note = report?.handling_note?.trim() || null;
    const rating = report?.rating ?? null;
    if (!note && !flags.length && !rating) return null;
    return {
      itemId: ref.itemId,
      unitId: ref.unitId ?? null,
      note,
      rating,
      reportId: report?.id ?? null,
      reportedAt: report?.created_at ?? null,
      flags,
      text: handlingText({ flags, rating, note }),
    };
  });
}

/**
 * Handling for whole items, keyed by item id; items with nothing to say are
 * absent. The entry point for manifests (T03) and placement cards (T11).
 */
export async function handlingNoteFor(itemIds: readonly string[]): Promise<Map<string, HandlingNote>> {
  const unique = [...new Set(itemIds)];
  const notes = await handlingNotesForRefs(unique.map((itemId) => ({ itemId })));
  const out = new Map<string, HandlingNote>();
  notes.forEach((n) => {
    if (n) out.set(n.itemId, n);
  });
  return out;
}
