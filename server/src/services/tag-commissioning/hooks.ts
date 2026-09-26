import { pool } from "../../db/client";
import { legacyTagKey, tagKey } from "./normalize";
import { normalizeEpcHex } from "./epc";

/**
 * The small surface the core item service calls into. Kept free of any import
 * of services/items so the two cannot load in a cycle.
 */

export { normalizeIdentifierValue, legacyTagKey } from "./normalize";

export type TagMatch = {
  itemId: string;
  unitId: string | null;
  via: "tag" | "legacy" | "epc";
};

/**
 * Match a scanned or typed code that an exact identifier lookup can miss:
 *
 * - an RFID or NFC UID in another format ("04:a2:3b" for 04A23B),
 * - a legacy sticker as a person types it ("RED 1234 056" for RED-1234-56),
 * - an EPC assigned for encoding but never recorded as a tag,
 *
 * and say which unit the tag is on, when it is on one. No side effects: this
 * never records a scan.
 */
export async function resolveTagCode(code: string): Promise<TagMatch | null> {
  const key = tagKey(code) || null;
  const legacy = legacyTagKey(code);
  const epc = normalizeEpcHex(code);
  if (!key && !legacy && !epc) return null;
  const { rows } = await pool.query<{ item_id: string; unit_id: string | null; via: TagMatch["via"] }>(
    `SELECT item_id, unit_id, via FROM (
       SELECT ii.item_id, tiu.unit_id, 'tag' AS via, 1 AS rank
         FROM item_identifiers ii
         LEFT JOIN tag_identifier_units tiu ON tiu.identifier_id = ii.id
        WHERE ii.type IN ('rfid', 'nfc')
          AND upper(regexp_replace(ii.value, '[^0-9A-Za-z]', '', 'g')) = $1::text
       UNION ALL
       SELECT ii.item_id, NULL::uuid, 'legacy', 2
         FROM item_identifiers ii
        WHERE ii.type = 'legacy' AND ii.value = $2::text
       UNION ALL
       SELECT te.item_id, te.unit_id, 'epc', 3
         FROM tag_epcs te
        WHERE te.epc = $3::text
     ) m
     ORDER BY rank
     LIMIT 1`,
    [key, legacy, epc],
  );
  const row = rows[0];
  return row ? { itemId: row.item_id, unitId: row.unit_id, via: row.via } : null;
}
