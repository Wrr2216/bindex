import { pool } from "../../db/client";
import type { HighValueMode } from "../../db/tables/valuation";

/**
 * The valued records in a place: one row per item, or one per unit for an
 * item whose units are tracked (each unit has its own serial, value and
 * place, which is what an insurer asks for). Used by the report and to fill a
 * declaration from its scope.
 */

export type ValuedRecord = {
  itemId: string;
  unitId: string | null;
  name: string;
  unitLabel: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  status: string;
  assetCode: string;
  primaryImageUrl: string | null;
  /** 1 for a unit; the item's quantity otherwise. */
  quantity: number;
  valueCents: number | null;
  serials: string[];
  locationId: string | null;
  locationName: string | null;
  companyId: string | null;
  companyName: string | null;
  purchaseDate: string | null;
  purchaseCents: number | null;
  vendor: string | null;
  warrantyEnds: string | null;
  highValueMode: HighValueMode;
  lastValuedOn: string | null;
  lastSource: string | null;
  lastConfidence: number | null;
  /** From the newest valuation that described the item (an AI estimate, usually). */
  materials: string | null;
  condition: string | null;
  description: string | null;
  lastValuationId: string | null;
};

export type RecordScope = {
  locationId?: string | null;
  companyId?: string | null;
  /** Include every location nested inside locationId. Default true. */
  includeSublocations?: boolean;
  /** Only these items (for adding picked items to a declaration). */
  itemIds?: string[];
  limit?: number;
};

export async function valuedRecords(scope: RecordScope = {}): Promise<ValuedRecord[]> {
  const params: unknown[] = [];
  const where = ["i.category IS DISTINCT FROM 'Domain'"];
  let tree = "";
  if (scope.locationId) {
    params.push(scope.locationId);
    if (scope.includeSublocations === false) {
      where.push(`coalesce(u.location_id, i.location_id) = $${params.length}`);
    } else {
      tree = `WITH RECURSIVE tree AS (
                SELECT id FROM locations WHERE id = $${params.length}
                UNION SELECT l2.id FROM locations l2 JOIN tree t ON l2.parent_id = t.id
              )`;
      where.push(`coalesce(u.location_id, i.location_id) IN (SELECT id FROM tree)`);
    }
  }
  if (scope.companyId) {
    params.push(scope.companyId);
    where.push(`coalesce(i.company_id, l.company_id) = $${params.length}`);
  }
  if (scope.itemIds) {
    params.push(scope.itemIds);
    where.push(`i.id = ANY($${params.length}::uuid[])`);
  }
  params.push(Math.min(20_000, scope.limit ?? 5_000));

  const { rows } = await pool.query(
    `${tree}
     SELECT i.id AS "itemId", u.id AS "unitId", i.name, u.label AS "unitLabel", i.brand, i.model, i.category,
            coalesce(u.status, i.status) AS status, coalesce(u.asset_code, i.asset_code) AS "assetCode",
            i.primary_image_url AS "primaryImageUrl",
            CASE WHEN u.id IS NULL THEN i.quantity ELSE 1 END AS quantity,
            (CASE WHEN u.id IS NULL THEN i.value_cents ELSE u.value_cents END)::float8 AS "valueCents",
            CASE WHEN u.id IS NULL
                 THEN coalesce((SELECT array_agg(x.value ORDER BY x.created_at) FROM item_identifiers x
                                 WHERE x.item_id = i.id AND x.type = 'serial'), '{}')
                 ELSE CASE WHEN u.serial IS NULL THEN '{}'::text[] ELSE ARRAY[u.serial] END END AS serials,
            l.id AS "locationId", l.name AS "locationName", c.id AS "companyId", c.name AS "companyName",
            coalesce(p.purchase_date, ip.purchase_date)::text AS "purchaseDate",
            -- A unit falls back to the item's purchase date, vendor and warranty (bought
            -- together), but never to its price, which was for all of them.
            p.purchase_cents::float8 AS "purchaseCents",
            coalesce(p.vendor, ip.vendor) AS vendor,
            coalesce(p.warranty_ends, ip.warranty_ends)::text AS "warrantyEnds",
            coalesce(p.high_value, 'auto') AS "highValueMode",
            lv.valued_on::text AS "lastValuedOn", lv.source AS "lastSource", lv.confidence AS "lastConfidence",
            lv.id AS "lastValuationId",
            dv.details->>'materials' AS materials, dv.details->>'condition' AS condition, dv.details->>'description' AS description
       FROM items i
       LEFT JOIN item_units u ON u.item_id = i.id
       LEFT JOIN locations l ON l.id = coalesce(u.location_id, i.location_id)
       LEFT JOIN companies c ON c.id = coalesce(i.company_id, l.company_id)
       LEFT JOIN valuation_profiles p ON p.item_id = i.id AND p.unit_id IS NOT DISTINCT FROM u.id
       LEFT JOIN valuation_profiles ip ON ip.item_id = i.id AND ip.unit_id IS NULL
       LEFT JOIN LATERAL (
         SELECT v.id, v.valued_on, v.source, v.confidence FROM valuations v
          WHERE v.item_id = i.id AND v.unit_id IS NOT DISTINCT FROM u.id
          ORDER BY v.created_at DESC, v.id DESC LIMIT 1
       ) lv ON true
       LEFT JOIN LATERAL (
         SELECT v.details FROM valuations v
          WHERE v.item_id = i.id AND (v.unit_id IS NOT DISTINCT FROM u.id OR v.unit_id IS NULL)
            AND (v.details ? 'materials' OR v.details ? 'condition' OR v.details ? 'description')
          ORDER BY (v.unit_id IS NOT DISTINCT FROM u.id) DESC, v.created_at DESC LIMIT 1
       ) dv ON true
      WHERE ${where.join(" AND ")}
      ORDER BY lower(coalesce(l.name, '')), lower(i.name), u.created_at NULLS FIRST, u.id
      LIMIT $${params.length}`,
    params,
  );
  return rows as ValuedRecord[];
}
