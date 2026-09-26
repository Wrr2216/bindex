import { asc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { itemIdentifiers, itemUnits, items, tagIdentifierUnits } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { recordEvent } from "../items";
import { decodeGiai96, describeEpc } from "./epc";
import { ensureEpcs, targetKey, type AssignedEpc } from "./epcAssign";
import { resolveTagCode } from "./hooks";
import { normalizeTagUid, tagKey } from "./normalize";
import { CODE_TYPES, classifyTier, type TagTier, type TierFacts } from "./tiers";

export type TagType = "rfid" | "nfc";

export type BoundTag = {
  id: string;
  type: TagType;
  value: string;
  unitId: string | null;
  createdAt: Date;
};

export type LegacySticker = {
  identifierId: string;
  value: string;
  color: string;
  lot: string | null;
  number: number;
};

export type EpcView = {
  scheme: AssignedEpc["scheme"];
  epc: string;
  /** GS1 tag URI for GIAI-96, null for the private scheme. */
  uri: string | null;
  encodedAt: Date | null;
};

const epcView = (row: AssignedEpc | undefined): EpcView | null =>
  row
    ? {
        scheme: row.scheme,
        epc: row.epc,
        uri: row.scheme === "giai-96" ? (decodeGiai96(row.epc)?.tagUri ?? null) : null,
        encodedAt: row.encodedAt,
      }
    : null;

/** Tier facts for many items in one query, keyed by item id. */
export async function tierFacts(itemIds: string[]): Promise<Map<string, TierFacts>> {
  const out = new Map<string, TierFacts>();
  if (!itemIds.length) return out;
  const { rows } = await pool.query<{
    id: string;
    has_rfid: boolean;
    has_nfc: boolean;
    has_legacy: boolean;
    has_code: boolean;
    scanned: boolean;
  }>(
    `SELECT i.id,
            coalesce(bool_or(ii.type = 'rfid'), false)   AS has_rfid,
            coalesce(bool_or(ii.type = 'nfc'), false)    AS has_nfc,
            coalesce(bool_or(ii.type = 'legacy'), false) AS has_legacy,
            coalesce(bool_or(ii.type = ANY($2::text[])), false) AS has_code,
            EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.action = 'scanned') AS scanned
       FROM items i
       LEFT JOIN item_identifiers ii ON ii.item_id = i.id
      WHERE i.id = ANY($1::uuid[])
      GROUP BY i.id`,
    [itemIds, CODE_TYPES],
  );
  for (const r of rows) {
    out.set(r.id, {
      hasRfid: r.has_rfid,
      hasNfc: r.has_nfc,
      hasLegacy: r.has_legacy,
      hasCode: r.has_code,
      scanned: r.scanned,
    });
  }
  return out;
}

async function legacyStickers(itemIds: string[]): Promise<Map<string, LegacySticker[]>> {
  const out = new Map<string, LegacySticker[]>();
  if (!itemIds.length) return out;
  const { rows } = await pool.query<{
    item_id: string;
    identifier_id: string;
    value: string;
    color: string;
    lot: string | null;
    number: string;
  }>(
    `SELECT ls.item_id, ls.identifier_id, ii.value, ls.color, ls.lot, ls.number
       FROM tag_legacy_stickers ls
       JOIN item_identifiers ii ON ii.id = ls.identifier_id
      WHERE ls.item_id = ANY($1::uuid[])
      ORDER BY ii.created_at`,
    [itemIds],
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push({
      identifierId: r.identifier_id,
      value: r.value,
      color: r.color,
      lot: r.lot,
      number: Number(r.number),
    });
    out.set(r.item_id, list);
  }
  return out;
}

export type TagSummary = { tier: TagTier; legacy: LegacySticker | null };

/** Tier and first legacy sticker for a page of items, for lists and cards. */
export async function summarize(itemIds: string[]): Promise<Record<string, TagSummary>> {
  const ids = [...new Set(itemIds)];
  const [facts, stickers] = await Promise.all([tierFacts(ids), legacyStickers(ids)]);
  const out: Record<string, TagSummary> = {};
  for (const [id, f] of facts) {
    out[id] = { tier: classifyTier(f), legacy: stickers.get(id)?.[0] ?? null };
  }
  return out;
}

async function boundTags(itemId: string): Promise<BoundTag[]> {
  const { rows } = await pool.query<{
    id: string;
    type: TagType;
    value: string;
    unit_id: string | null;
    created_at: Date;
  }>(
    `SELECT ii.id, ii.type, ii.value, tiu.unit_id, ii.created_at
       FROM item_identifiers ii
       LEFT JOIN tag_identifier_units tiu ON tiu.identifier_id = ii.id
      WHERE ii.item_id = $1 AND ii.type IN ('rfid', 'nfc')
      ORDER BY ii.created_at`,
    [itemId],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    unitId: r.unit_id,
    createdAt: r.created_at,
  }));
}

async function loadItem(itemId: string) {
  const [item] = await db
    .select({ id: items.id, name: items.name, assetCode: items.assetCode, category: items.category })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw notFound("Item not found");
  return item;
}

/**
 * Everything the item page shows about tags: its tier, the tags and sticker
 * on it, and the EPC it gets when encoded, for the item and for each unit.
 */
export async function getItemTags(itemId: string) {
  const item = await loadItem(itemId);
  const units = await db
    .select({ id: itemUnits.id, assetCode: itemUnits.assetCode, label: itemUnits.label })
    .from(itemUnits)
    .where(eq(itemUnits.itemId, itemId))
    .orderBy(asc(itemUnits.createdAt));

  // Domains have nothing to stick a tag on.
  const physical = item.category !== "Domain";
  const [facts, tags, stickers, epcs] = await Promise.all([
    tierFacts([itemId]),
    boundTags(itemId),
    legacyStickers([itemId]),
    physical
      ? ensureEpcs([
          { itemId, unitId: null, assetCode: item.assetCode },
          ...units.map((u) => ({ itemId, unitId: u.id, assetCode: u.assetCode })),
        ])
      : Promise.resolve(new Map<string, AssignedEpc>()),
  ]);
  const f = facts.get(itemId)!;

  return {
    itemId,
    physical,
    tier: classifyTier(f),
    scanned: f.scanned,
    tags: tags.filter((t) => !t.unitId),
    legacy: stickers.get(itemId) ?? [],
    epc: epcView(epcs.get(targetKey({ itemId, unitId: null }))),
    units: units.map((u) => ({
      id: u.id,
      assetCode: u.assetCode,
      label: u.label,
      tags: tags.filter((t) => t.unitId === u.id),
      epc: epcView(epcs.get(targetKey({ itemId, unitId: u.id }))),
    })),
  };
}

export type ItemTags = Awaited<ReturnType<typeof getItemTags>>;

type ExistingTag = { id: string; item_id: string; type: string; unit_id: string | null; name: string; asset_code: string };

/** Any RFID or NFC identifier whose letters and digits match. */
export async function findTagByKey(value: string): Promise<ExistingTag | null> {
  const key = tagKey(value);
  if (!key) return null;
  const { rows } = await pool.query<ExistingTag>(
    `SELECT ii.id, ii.item_id, ii.type, tiu.unit_id, i.name, i.asset_code
       FROM item_identifiers ii
       JOIN items i ON i.id = ii.item_id
       LEFT JOIN tag_identifier_units tiu ON tiu.identifier_id = ii.id
      WHERE ii.type IN ('rfid', 'nfc')
        AND upper(regexp_replace(ii.value, '[^0-9A-Za-z]', '', 'g')) = $1
      LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function assertUnitOf(itemId: string, unitId: string): Promise<void> {
  const [unit] = await db
    .select({ itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  if (!unit || unit.itemId !== itemId) throw notFound("That unit does not belong to this item.");
}

/**
 * Bind a tag read from a reader or a phone to an item, or to one of its units.
 * Binding the same tag to the same place again is a no-op; a tag bound
 * anywhere else is refused, never moved.
 */
export async function bindTag(
  itemId: string,
  input: { type: TagType; value: string; unitId?: string | null },
  userOid: string | null,
): Promise<{ tag: BoundTag; created: boolean }> {
  await loadItem(itemId);
  const unitId = input.unitId ?? null;
  if (unitId) await assertUnitOf(itemId, unitId);
  const value = normalizeTagUid(input.value);
  if (!tagKey(value)) throw badRequest("That read has no tag ID in it. Read the tag again.");

  const existing = await findTagByKey(value);
  if (existing) {
    if (existing.item_id !== itemId) {
      throw conflict(
        `That tag is already on ${existing.name} (${existing.asset_code}). Remove it there first.`,
      );
    }
    if (existing.type !== input.type) {
      throw conflict(
        `That tag is already bound to this item as ${existing.type === "rfid" ? "an RFID" : "an NFC"} tag.`,
      );
    }
    // Same item: moving a tag between the item and one of its units is a
    // correction, not a rebind.
    if ((existing.unit_id ?? null) !== unitId) {
      await db.delete(tagIdentifierUnits).where(eq(tagIdentifierUnits.identifierId, existing.id));
      if (unitId) await db.insert(tagIdentifierUnits).values({ identifierId: existing.id, unitId });
    }
    const [row] = await db.select().from(itemIdentifiers).where(eq(itemIdentifiers.id, existing.id));
    return {
      tag: { id: row!.id, type: input.type, value: row!.value, unitId, createdAt: row!.createdAt },
      created: false,
    };
  }

  const row = await db
    .transaction(async (tx) => {
      const [created] = await tx
        .insert(itemIdentifiers)
        .values({ itemId, type: input.type, value })
        .returning();
      if (unitId) await tx.insert(tagIdentifierUnits).values({ identifierId: created!.id, unitId });
      return created!;
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, "uq_item_identifiers_identity_value")) {
        throw conflict("That code is already on file as another identifier. Remove it there first.");
      }
      throw err;
    });

  await recordEvent(itemId, userOid, "updated", {
    tagBound: { type: input.type, value, unitId },
  });
  return {
    tag: { id: row.id, type: input.type, value: row.value, unitId, createdAt: row.createdAt },
    created: true,
  };
}

export type CodeLookup = {
  found: boolean;
  itemId?: string;
  unitId?: string | null;
  name?: string;
  assetCode?: string;
  /** What a raw EPC decodes to, when it is one of the two schemes. */
  epc?: ReturnType<typeof describeEpc>;
};

/**
 * Would a scan of this code open something? The same order the scanner uses,
 * without recording a scan. Used by the phone's tap lookup to decide between
 * opening a record and offering to bind an unknown tag.
 */
export async function lookupCode(raw: string): Promise<CodeLookup> {
  const code = raw.trim();
  if (!code) return { found: false };
  const { rows } = await pool.query<{ item_id: string; unit_id: string | null }>(
    `SELECT item_id, unit_id FROM (
       SELECT ii.item_id, tiu.unit_id, 1 AS rank
         FROM item_identifiers ii
         LEFT JOIN tag_identifier_units tiu ON tiu.identifier_id = ii.id
        WHERE ii.value = $1
       UNION ALL
       SELECT id, NULL::uuid, 2 FROM items WHERE asset_code = $1
       UNION ALL
       SELECT item_id, id, 3 FROM item_units WHERE asset_code = $1 OR serial = $1
     ) m ORDER BY rank LIMIT 1`,
    [code],
  );
  let hit: { itemId: string; unitId: string | null } | null = rows[0]
    ? { itemId: rows[0].item_id, unitId: rows[0].unit_id }
    : null;
  if (!hit) {
    const tag = await resolveTagCode(code);
    if (tag) hit = { itemId: tag.itemId, unitId: tag.unitId };
  }
  const epc = describeEpc(code);
  if (!hit) return { found: false, epc: epc.scheme ? epc : undefined };
  const [item] = await db
    .select({ name: items.name, assetCode: items.assetCode })
    .from(items)
    .where(eq(items.id, hit.itemId))
    .limit(1);
  return {
    found: true,
    itemId: hit.itemId,
    unitId: hit.unitId,
    name: item?.name,
    assetCode: item?.assetCode,
    epc: epc.scheme ? epc : undefined,
  };
}
