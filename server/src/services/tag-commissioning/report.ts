import { pool } from "../../db/client";
import { CODE_TYPES, TAG_TIERS, classifyTier, type TagTier } from "./tiers";

/**
 * Items by tag tier, per location: how much of a site can be bulk-read by
 * RFID, and how much still depends on stickers or scanning one at a time.
 */

export type TierCounts = Record<TagTier, number> & { total: number };

export type TierReportRow = TierCounts & {
  locationId: string | null;
  locationName: string | null;
  parentId: string | null;
};

const empty = (): TierCounts => ({ total: 0, none: 0, barcode: 0, legacy: 0, rfid: 0, rfid_nfc: 0 });

/**
 * One row per location that holds items directly, plus one for items with no
 * location. With `locationId`, only that location and everything inside it.
 */
export async function tierReport(locationId?: string): Promise<{ rows: TierReportRow[]; totals: TierCounts }> {
  // Grouped by the facts rather than the tier so the rule lives in one place,
  // classifyTier, and not also in SQL.
  const { rows } = await pool.query<{
    location_id: string | null;
    has_rfid: boolean;
    has_nfc: boolean;
    has_legacy: boolean;
    has_code: boolean;
    scanned: boolean;
    n: string;
  }>(
    `WITH RECURSIVE scope(id) AS (
       SELECT id FROM locations WHERE id = $1::uuid
       UNION
       SELECT l.id FROM locations l JOIN scope s ON l.parent_id = s.id
     ),
     facts AS (
       SELECT i.id, i.location_id,
              coalesce(bool_or(ii.type = 'rfid'), false)   AS has_rfid,
              coalesce(bool_or(ii.type = 'nfc'), false)    AS has_nfc,
              coalesce(bool_or(ii.type = 'legacy'), false) AS has_legacy,
              coalesce(bool_or(ii.type = ANY($2::text[])), false) AS has_code,
              EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.action = 'scanned') AS scanned
         FROM items i
         LEFT JOIN item_identifiers ii ON ii.item_id = i.id
        WHERE i.category IS DISTINCT FROM 'Domain'
          AND ($1::uuid IS NULL OR i.location_id IN (SELECT id FROM scope))
        GROUP BY i.id
     )
     SELECT location_id, has_rfid, has_nfc, has_legacy, has_code, scanned, count(*) AS n
       FROM facts
      GROUP BY 1, 2, 3, 4, 5, 6`,
    [locationId ?? null, CODE_TYPES],
  );

  const byLocation = new Map<string | null, TierCounts>();
  const totals = empty();
  for (const r of rows) {
    const tier = classifyTier({
      hasRfid: r.has_rfid,
      hasNfc: r.has_nfc,
      hasLegacy: r.has_legacy,
      hasCode: r.has_code,
      scanned: r.scanned,
    });
    const n = Number(r.n);
    const counts = byLocation.get(r.location_id) ?? empty();
    counts[tier] += n;
    counts.total += n;
    totals[tier] += n;
    totals.total += n;
    byLocation.set(r.location_id, counts);
  }

  const ids = [...byLocation.keys()].filter((id): id is string => id !== null);
  const names = ids.length
    ? (
        await pool.query<{ id: string; name: string; parent_id: string | null }>(
          "SELECT id, name, parent_id FROM locations WHERE id = ANY($1::uuid[])",
          [ids],
        )
      ).rows
    : [];
  const nameById = new Map(names.map((n) => [n.id, n]));

  const out: TierReportRow[] = [...byLocation].map(([id, counts]) => ({
    locationId: id,
    locationName: id ? (nameById.get(id)?.name ?? null) : null,
    parentId: id ? (nameById.get(id)?.parent_id ?? null) : null,
    ...counts,
  }));
  out.sort((a, b) =>
    a.locationId === null ? 1 : b.locationId === null ? -1 : (a.locationName ?? "").localeCompare(b.locationName ?? ""),
  );
  return { rows: out, totals };
}

export { TAG_TIERS };
