import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { items, itemIdentifiers, itemUnits, locations } from "../db/schema";
import { recordEvent } from "./items";
import { unitItemIdsByAssetCode } from "./units";
import { recordSpotCheck } from "./spotcheck";
import { notFound } from "../lib/errors";

export type VerifyRef = { id: string; name: string; assetCode: string };
export type VerifyUnexpected = VerifyRef & { locationName: string | null };
export type VerifyResult = {
  present: VerifyRef[];
  missing: VerifyRef[];
  unexpected: VerifyUnexpected[];
  unresolved: string[];
};

/**
 * Resolve scanned codes (RFID/EPC/NFC UIDs, item or unit asset codes, unit
 * serials) to item ids in one batched pass. Exact matches only. This is the bulk-read path, so
 * no fuzzy model matching like the interactive scanner does.
 */
async function resolveCodes(codes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // code -> itemId
  if (!codes.length) return map;
  const [byIdentifier, byAsset, byUnitCode, byUnit] = await Promise.all([
    db
      .select({ value: itemIdentifiers.value, itemId: itemIdentifiers.itemId })
      .from(itemIdentifiers)
      .where(inArray(itemIdentifiers.value, codes)),
    db.select({ assetCode: items.assetCode, id: items.id }).from(items).where(inArray(items.assetCode, codes)),
    unitItemIdsByAssetCode(codes),
    db
      .select({ serial: itemUnits.serial, itemId: itemUnits.itemId })
      .from(itemUnits)
      .where(inArray(itemUnits.serial, codes)),
  ]);
  for (const r of byIdentifier) map.set(r.value, r.itemId);
  for (const r of byAsset) if (!map.has(r.assetCode)) map.set(r.assetCode, r.id);
  for (const r of byUnitCode) if (!map.has(r.assetCode)) map.set(r.assetCode, r.itemId);
  for (const r of byUnit) if (r.serial && !map.has(r.serial)) map.set(r.serial, r.itemId);
  return map;
}

/** Reconcile a set of scanned codes against the items expected in a location. */
export async function verifyLocation(locationId: string, rawCodes: string[]): Promise<VerifyResult> {
  const [loc] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);
  if (!loc) throw notFound("Location not found");

  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  const expected = await db
    .select({ id: items.id, name: items.name, assetCode: items.assetCode })
    .from(items)
    .where(eq(items.locationId, locationId))
    .orderBy(items.name);
  const expectedIds = new Set(expected.map((e) => e.id));

  const codeToItem = await resolveCodes(codes);
  const matched = new Set([...codeToItem.values()]);
  const unresolved = codes.filter((c) => !codeToItem.has(c));

  const present = expected.filter((e) => matched.has(e.id));
  const missing = expected.filter((e) => !matched.has(e.id));

  const unexpectedIds = [...matched].filter((id) => !expectedIds.has(id));
  const unexpected: VerifyUnexpected[] = unexpectedIds.length
    ? await db
        .select({
          id: items.id,
          name: items.name,
          assetCode: items.assetCode,
          locationName: locations.name,
        })
        .from(items)
        .leftJoin(locations, eq(items.locationId, locations.id))
        .where(inArray(items.id, unexpectedIds))
    : [];

  return { present, missing, unexpected, unresolved };
}

/** Apply a reconciliation: mark present items spot-checked, flag missing ones. */
export async function applyVerify(
  presentIds: string[],
  missingIds: string[],
  userOid: string | null,
  userName: string,
): Promise<void> {
  for (const id of presentIds) await recordSpotCheck(id, true, userOid, userName);
  for (const id of missingIds) await recordSpotCheck(id, false, userOid, userName);
}

// --- Building-wide audit (walk the aisles) --------------------------------

export type AuditMissingItem = { id: string; name: string; assetCode: string };
export type AuditLocationGroup = {
  locationId: string | null;
  locationName: string | null; // null => items with no location ("Unassigned")
  total: number;
  seen: number;
  missing: AuditMissingItem[];
};
export type AuditResult = {
  totalItems: number;
  seenItems: number;
  missingItems: number;
  seenIds: string[]; // in-scope items that were read (for "apply")
  unknownCodes: string[];
  locations: AuditLocationGroup[];
};

/**
 * Reconcile a rolling set of scanned tags against every item in scope (the whole
 * building, or one company), grouped by location so the report says exactly which
 * aisle/tote still has items unaccounted for. Stateless: the client sends the
 * accumulated tag set as the walk progresses.
 */
export async function auditReconcile(rawCodes: string[], companyId?: string): Promise<AuditResult> {
  const codes = [...new Set(rawCodes.map((c) => c.trim()).filter(Boolean))];
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      assetCode: items.assetCode,
      locationId: items.locationId,
      locationName: locations.name,
    })
    .from(items)
    .leftJoin(locations, eq(items.locationId, locations.id))
    .where(companyId ? eq(locations.companyId, companyId) : undefined);

  const codeToItem = await resolveCodes(codes);
  const matched = new Set([...codeToItem.values()]);
  const unknownCodes = codes.filter((c) => !codeToItem.has(c));

  const groups = new Map<string, AuditLocationGroup>();
  const seenIds: string[] = [];
  for (const r of rows) {
    const key = r.locationId ?? "__none";
    let g = groups.get(key);
    if (!g) {
      g = { locationId: r.locationId, locationName: r.locationName, total: 0, seen: 0, missing: [] };
      groups.set(key, g);
    }
    g.total += 1;
    if (matched.has(r.id)) {
      g.seen += 1;
      seenIds.push(r.id);
    } else {
      g.missing.push({ id: r.id, name: r.name, assetCode: r.assetCode });
    }
  }

  const locationGroups = [...groups.values()].sort((a, b) =>
    (a.locationName ?? "~").localeCompare(b.locationName ?? "~"),
  );

  return {
    totalItems: rows.length,
    seenItems: seenIds.length,
    missingItems: rows.length - seenIds.length,
    seenIds,
    unknownCodes,
    locations: locationGroups,
  };
}

/**
 * Commit an audit: bulk-mark every read item spot-checked (clearing any missing
 * flag), and optionally flag the not-seen ones missing. Bulk updates + a single
 * audit event (not one per item) to stay cheap at building scale.
 */
export async function applyAudit(
  seenIds: string[],
  missingIds: string[],
  userOid: string | null,
  userName: string,
): Promise<void> {
  if (seenIds.length) {
    await db
      .update(items)
      .set({
        lastSpotCheckedAt: new Date(),
        lastSpotCheckedBy: userName,
        flaggedMissing: false,
        updatedAt: new Date(),
      })
      .where(inArray(items.id, seenIds));
  }
  if (missingIds.length) {
    await db
      .update(items)
      .set({ flaggedMissing: true, updatedAt: new Date() })
      .where(inArray(items.id, missingIds));
  }
  await recordEvent(null, userOid, "updated", {
    audit: true,
    seen: seenIds.length,
    flaggedMissing: missingIds.length,
  });
}
