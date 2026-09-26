import { inArray, or } from "drizzle-orm";
import { db } from "../../db/client";
import { itemIdentifiers, itemUnits, items } from "../../db/schema";
import type { ScanRef } from "./match";

/**
 * Batch code resolver for manifest scanning: many codes in, the items (and
 * units) they name out, in four queries whatever the batch size.
 *
 * It deliberately differs from the interactive scanner (services/items
 * getByIdentifier): no fuzzy model match, and no "scanned" item events, since a
 * reader at a dock door would otherwise write thousands of them an hour. T01
 * has an equivalent for reader sightings; the two are to be merged when both
 * land.
 *
 * A product code (UPC, SKU) can name several items, so each code maps to a
 * list, best first: the unit a unit code or serial names, then the item an
 * asset code or identity identifier (serial, asset tag, MAC, RFID) names, then
 * items sharing a product code.
 */

const IDENTITY_TYPES = new Set(["serial", "asset_tag", "mac", "rfid"]);
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// Labels carry a QR of the item's page, sometimes with the unit highlighted.
const DEEP_LINK = new RegExp(`/items/(${UUID})(?:[/?#][\\s\\S]*?unit=(${UUID}))?`);

/** An item page link as printed on a label, if the code is one. */
export function parseDeepLink(code: string): ScanRef | null {
  const m = DEEP_LINK.exec(code);
  if (!m) return null;
  return { itemId: m[1]!.toLowerCase(), unitId: m[2]?.toLowerCase() ?? null };
}

/** Case variants a reader may send the same code in (EPCs arrive in either case). */
const variants = (code: string) => [...new Set([code, code.toUpperCase(), code.toLowerCase()])];

export async function resolveScanCodes(rawCodes: readonly string[]): Promise<Map<string, ScanRef[]>> {
  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  const out = new Map<string, ScanRef[]>();
  if (codes.length === 0) return out;

  // Lookup value -> the scanned codes it stands for.
  const byValue = new Map<string, string[]>();
  const links = new Map<string, ScanRef>();
  for (const code of codes) {
    const link = parseDeepLink(code);
    if (link) {
      links.set(code, link);
      continue;
    }
    for (const v of variants(code)) byValue.set(v, [...(byValue.get(v) ?? []), code]);
  }
  const values = [...byValue.keys()];

  const linkedItemIds = [...new Set([...links.values()].map((l) => l.itemId))];
  const linkedUnitIds = [...new Set([...links.values()].flatMap((l) => (l.unitId ? [l.unitId] : [])))];
  const unitColumns = {
    id: itemUnits.id,
    itemId: itemUnits.itemId,
    assetCode: itemUnits.assetCode,
    serial: itemUnits.serial,
  };

  const [unitRows, itemRows, identifierRows, linkedItems, linkedUnits] = await Promise.all([
    values.length
      ? db
          .select(unitColumns)
          .from(itemUnits)
          .where(or(inArray(itemUnits.assetCode, values), inArray(itemUnits.serial, values)))
      : [],
    values.length
      ? db.select({ id: items.id, assetCode: items.assetCode }).from(items).where(inArray(items.assetCode, values))
      : [],
    values.length
      ? db
          .select({ itemId: itemIdentifiers.itemId, type: itemIdentifiers.type, value: itemIdentifiers.value })
          .from(itemIdentifiers)
          .where(inArray(itemIdentifiers.value, values))
      : [],
    linkedItemIds.length ? db.select({ id: items.id }).from(items).where(inArray(items.id, linkedItemIds)) : [],
    linkedUnitIds.length ? db.select(unitColumns).from(itemUnits).where(inArray(itemUnits.id, linkedUnitIds)) : [],
  ]);

  const tiers = new Map<string, ScanRef[][]>(); // code -> [units, items, identity ids, product ids]
  const push = (value: string | null, tier: number, ref: ScanRef) => {
    if (!value) return;
    for (const code of byValue.get(value) ?? []) {
      const list = tiers.get(code) ?? [[], [], [], []];
      list[tier]!.push(ref);
      tiers.set(code, list);
    }
  };
  for (const u of unitRows) {
    const ref = { itemId: u.itemId, unitId: u.id };
    if (byValue.has(u.assetCode)) push(u.assetCode, 0, ref);
    if (u.serial && byValue.has(u.serial)) push(u.serial, 0, ref);
  }
  for (const i of itemRows) push(i.assetCode, 1, { itemId: i.id, unitId: null });
  for (const r of identifierRows) {
    push(r.value, IDENTITY_TYPES.has(r.type) ? 2 : 3, { itemId: r.itemId, unitId: null });
  }

  for (const [code, list] of tiers) {
    const seen = new Set<string>();
    const refs: ScanRef[] = [];
    for (const ref of list.flat()) {
      const key = `${ref.itemId}:${ref.unitId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    out.set(code, refs);
  }

  const itemIds = new Set(linkedItems.map((i) => i.id));
  const unitsById = new Map(linkedUnits.map((u) => [u.id, u.itemId]));
  for (const [code, link] of links) {
    if (!itemIds.has(link.itemId)) continue;
    // A unit id that does not belong to the linked item is ignored rather than trusted.
    const unitId = link.unitId && unitsById.get(link.unitId) === link.itemId ? link.unitId : null;
    out.set(code, [{ itemId: link.itemId, unitId }]);
  }
  return out;
}
