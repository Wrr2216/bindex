import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  consumableItems,
  itemAssignments,
  items,
  itemIdentifiers,
  itemUnits,
  locations,
} from "../../db/schema";
import { locationCode } from "../../lib/codes";

/**
 * Turn scanned codes into items, units or locations in a fixed number of
 * queries. Supplies are scanned all day, so unlike the interactive scanner
 * this records no "scanned" history event: a roll of tape would otherwise
 * bury everything else in its timeline.
 *
 * Accepts what a label or reader produces: an identifier (barcode, RFID,
 * serial), an item or unit asset code, a unit serial, a location code, or the
 * URL printed in a label's QR code.
 */

export type Resolved =
  | { kind: "item"; itemId: string; unitId: string | null }
  | { kind: "location"; locationId: string };

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ITEM_LINK = new RegExp(`/items/(${UUID})(?:\\?(?:.*&)?unit=(${UUID}))?`);
const LOCATION_LINK = new RegExp(`/locations/(${UUID})(?:[/?#]|$)`);

/** Pull an item, unit or location id out of a label's QR URL. Pure. */
export function parseDeepLink(
  code: string,
): { itemId: string; unitId: string | null } | { locationId: string } | null {
  const item = code.match(ITEM_LINK);
  if (item) return { itemId: item[1]!.toLowerCase(), unitId: item[2]?.toLowerCase() ?? null };
  const loc = code.match(LOCATION_LINK);
  if (loc) return { locationId: loc[1]!.toLowerCase() };
  return null;
}

export async function resolveCodes(rawCodes: string[]): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  if (!codes.length) return out;

  const linkedItems = new Map<string, { itemId: string; unitId: string | null }>();
  const linkedLocations = new Map<string, string>();
  const plain: string[] = [];
  for (const c of codes) {
    const link = parseDeepLink(c);
    if (!link) plain.push(c);
    else if ("locationId" in link) linkedLocations.set(c, link.locationId);
    else linkedItems.set(c, link);
  }

  // A location code is derived from the id, so match it on the id's prefix.
  const locPrefix = locationCode("00000000-0000-0000-0000-000000000000").split("-")[0]!;
  const locHex = new Map<string, string>(); // hex -> code
  for (const c of plain) {
    const m = c.toUpperCase().match(/^([A-Z0-9]+)-([0-9A-F]{6})$/);
    if (m && m[1] === locPrefix) locHex.set(m[2]!, c);
  }

  const itemIds = [...new Set([...linkedItems.values()].map((l) => l.itemId))];
  const locIds = [...new Set(linkedLocations.values())];

  const [byIdentifier, byAsset, byUnitCode, byUnitSerial, existingItems, existingLocs, byLocCode] =
    await Promise.all([
      plain.length
        ? db
            .select({ value: itemIdentifiers.value, itemId: itemIdentifiers.itemId })
            .from(itemIdentifiers)
            .innerJoin(items, eq(items.id, itemIdentifiers.itemId))
            .where(inArray(itemIdentifiers.value, plain))
            // A shared product code resolves to the most recently touched item,
            // the same tie-break the interactive scanner uses.
            .orderBy(desc(items.updatedAt))
        : [],
      plain.length
        ? db.select({ code: items.assetCode, id: items.id }).from(items).where(inArray(items.assetCode, plain))
        : [],
      plain.length
        ? db
            .select({ code: itemUnits.assetCode, id: itemUnits.id, itemId: itemUnits.itemId })
            .from(itemUnits)
            .where(inArray(itemUnits.assetCode, plain))
        : [],
      plain.length
        ? db
            .select({ code: itemUnits.serial, id: itemUnits.id, itemId: itemUnits.itemId })
            .from(itemUnits)
            .where(inArray(itemUnits.serial, plain))
        : [],
      itemIds.length
        ? db.select({ id: items.id }).from(items).where(inArray(items.id, itemIds))
        : [],
      locIds.length
        ? db.select({ id: locations.id }).from(locations).where(inArray(locations.id, locIds))
        : [],
      locHex.size
        ? db
            .select({ id: locations.id, hex: sql<string>`upper(substr(replace(${locations.id}::text, '-', ''), 1, 6))` })
            .from(locations)
            .where(
              inArray(sql`upper(substr(replace(${locations.id}::text, '-', ''), 1, 6))`, [...locHex.keys()]),
            )
        : [],
    ]);

  const setOnce = (code: string, r: Resolved) => {
    if (!out.has(code)) out.set(code, r);
  };
  for (const r of byIdentifier) setOnce(r.value, { kind: "item", itemId: r.itemId, unitId: null });
  for (const r of byAsset) setOnce(r.code, { kind: "item", itemId: r.id, unitId: null });
  for (const r of byUnitCode) setOnce(r.code, { kind: "item", itemId: r.itemId, unitId: r.id });
  for (const r of byUnitSerial) {
    if (r.code) setOnce(r.code, { kind: "item", itemId: r.itemId, unitId: r.id });
  }
  for (const r of byLocCode) {
    const code = locHex.get(r.hex);
    if (code) setOnce(code, { kind: "location", locationId: r.id });
  }

  const liveItems = new Set(existingItems.map((r) => r.id));
  for (const [code, link] of linkedItems) {
    if (liveItems.has(link.itemId)) out.set(code, { kind: "item", ...link });
  }
  const liveLocs = new Set(existingLocs.map((r) => r.id));
  for (const [code, id] of linkedLocations) {
    if (liveLocs.has(id)) out.set(code, { kind: "location", locationId: id });
  }
  return out;
}

export type DescribedCode = {
  code: string;
  kind: "item" | "location" | "unknown";
  itemId: string | null;
  unitId: string | null;
  locationId: string | null;
  name: string | null;
  /** The printed code of what was scanned: the unit's own code for a unit. */
  assetCode: string | null;
  unitLabel: string | null;
  consumable: boolean;
  /** Who has it now, when it is checked out. */
  outTo: { holderId: string | null; holderName: string } | null;
};

/**
 * Resolve codes and say what each one is, in the shape a scan session shows
 * while it collects: the name, whether it is a consumable (which does not
 * belong in a kit) and who has it now.
 */
export async function describeCodes(rawCodes: string[]): Promise<DescribedCode[]> {
  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  const resolved = await resolveCodes(codes);
  const itemIds = new Set<string>();
  const unitIds = new Set<string>();
  const locIds = new Set<string>();
  for (const r of resolved.values()) {
    if (r.kind === "location") locIds.add(r.locationId);
    else {
      itemIds.add(r.itemId);
      if (r.unitId) unitIds.add(r.unitId);
    }
  }
  const [itemRows, unitRows, locRows, open, consumables] = await Promise.all([
    itemIds.size
      ? db
          .select({ id: items.id, name: items.name, assetCode: items.assetCode })
          .from(items)
          .where(inArray(items.id, [...itemIds]))
      : [],
    unitIds.size
      ? db
          .select({ id: itemUnits.id, itemId: itemUnits.itemId, assetCode: itemUnits.assetCode, label: itemUnits.label })
          .from(itemUnits)
          .where(inArray(itemUnits.id, [...unitIds]))
      : [],
    locIds.size
      ? db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, [...locIds]))
      : [],
    itemIds.size
      ? db
          .select({
            itemId: itemAssignments.itemId,
            unitId: itemAssignments.unitId,
            entityId: itemAssignments.entityId,
            entityName: itemAssignments.entityName,
          })
          .from(itemAssignments)
          .where(and(inArray(itemAssignments.itemId, [...itemIds]), isNull(itemAssignments.checkedInAt)))
      : [],
    itemIds.size
      ? db
          .select({ id: consumableItems.itemId })
          .from(consumableItems)
          .where(inArray(consumableItems.itemId, [...itemIds]))
      : [],
  ]);
  const itemById = new Map(itemRows.map((r) => [r.id, r]));
  const unitById = new Map(unitRows.map((r) => [r.id, r]));
  const locById = new Map(locRows.map((r) => [r.id, r]));
  const isConsumable = new Set(consumables.map((c) => c.id));
  const openKey = (itemId: string, unitId: string | null) => `${itemId}|${unitId ?? ""}`;
  const openBy = new Map(open.map((o) => [openKey(o.itemId, o.unitId), o]));

  return codes.map((code): DescribedCode => {
    const r = resolved.get(code);
    const blank = {
      code,
      itemId: null,
      unitId: null,
      locationId: null,
      name: null,
      assetCode: null,
      unitLabel: null,
      consumable: false,
      outTo: null,
    };
    if (!r) return { ...blank, kind: "unknown" };
    if (r.kind === "location") {
      const loc = locById.get(r.locationId);
      return { ...blank, kind: "location", locationId: r.locationId, name: loc?.name ?? null };
    }
    const item = itemById.get(r.itemId);
    const unit = r.unitId ? unitById.get(r.unitId) : undefined;
    // A unit link naming a unit of some other item is treated as the item alone.
    const unitId = unit && unit.itemId === r.itemId ? unit.id : null;
    const o = openBy.get(openKey(r.itemId, unitId));
    return {
      ...blank,
      kind: "item",
      itemId: r.itemId,
      unitId,
      name: item?.name ?? null,
      assetCode: (unitId ? unit?.assetCode : item?.assetCode) ?? null,
      unitLabel: unitId ? (unit?.label ?? null) : null,
      consumable: isConsumable.has(r.itemId),
      outTo: o ? { holderId: o.entityId, holderName: o.entityName } : null,
    };
  });
}
