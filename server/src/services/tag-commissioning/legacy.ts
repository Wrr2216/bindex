import { and, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { itemIdentifiers, items } from "../../db/schema";
import { HttpError, badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { createItem, recordEvent } from "../items";
import { formatLegacyTag, parseLegacyTag, type LegacyTag } from "./normalize";
import { findColor, getTagSettings } from "./settings";

/**
 * Stickers from an older labelling system: a colour, an optional lot and a
 * number. Each is stored as a 'legacy' identifier in its normalized form, so
 * reading "RED 1234 056" off a box finds the record saved as RED-1234-56.
 */

export type LegacyInput = { color: string; lot?: string | null; number: number };

/**
 * Validate against the palette and normalize the way a typed sticker is, so
 * the form and the scanner can never disagree about the stored value.
 */
export async function legacyValue(input: LegacyInput): Promise<{ tag: LegacyTag; value: string }> {
  const { palette } = await getTagSettings();
  const color = findColor(palette, input.color);
  if (!color) {
    throw badRequest(
      `“${input.color}” is not a sticker colour here. Use one of ${palette.map((c) => c.name).join(", ")}, or add it in the sticker settings.`,
    );
  }
  if (!Number.isSafeInteger(input.number) || input.number < 0) {
    throw badRequest("The sticker number must be a whole number.");
  }
  const lot = input.lot?.trim() || null;
  const tag = parseLegacyTag([color.name, lot, String(input.number)].filter(Boolean).join(" "));
  if (!tag) throw badRequest("A lot is letters and digits only, such as 1234 or A7.");
  return { tag, value: formatLegacyTag(tag) };
}

async function holderOf(value: string): Promise<string> {
  const { rows } = await pool.query<{ name: string; asset_code: string }>(
    `SELECT i.name, i.asset_code FROM item_identifiers ii JOIN items i ON i.id = ii.item_id
      WHERE ii.type = 'legacy' AND ii.value = $1 LIMIT 1`,
    [value],
  );
  return rows[0] ? `${rows[0].name} (${rows[0].asset_code})` : "another record";
}

/** Give an item its sticker, replacing the one it had. */
export async function setItemLegacyTag(itemId: string, input: LegacyInput, userOid: string | null) {
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw notFound("Item not found");
  const { value } = await legacyValue(input);
  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(itemIdentifiers)
        .where(and(eq(itemIdentifiers.itemId, itemId), eq(itemIdentifiers.type, "legacy")));
      await tx.insert(itemIdentifiers).values({ itemId, type: "legacy", value });
    });
  } catch (err) {
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value")) {
      throw conflict(`Sticker ${value} is already on ${await holderOf(value)}.`);
    }
    throw err;
  }
  await recordEvent(itemId, userOid, "updated", { legacyTag: value });
  return { value };
}

export async function removeItemLegacyTag(itemId: string, userOid: string | null): Promise<void> {
  const removed = await db
    .delete(itemIdentifiers)
    .where(and(eq(itemIdentifiers.itemId, itemId), eq(itemIdentifiers.type, "legacy")))
    .returning({ id: itemIdentifiers.id });
  if (removed.length) await recordEvent(itemId, userOid, "updated", { legacyTag: null });
}

/**
 * The next free number after `after` in a colour and lot, so fast entry can
 * pre-fill it. Numbers already on file are stepped over.
 */
export async function nextLegacyNumber(color: string, lot: string | null, after: number): Promise<number> {
  const { rows } = await pool.query<{ number: string }>(
    `SELECT number FROM tag_legacy_stickers
      WHERE color = $1 AND lot IS NOT DISTINCT FROM $2 AND number > $3
      ORDER BY number
      LIMIT 1000`,
    [color, lot, after],
  );
  let next = after + 1;
  for (const r of rows) {
    if (Number(r.number) !== next) break;
    next += 1;
  }
  return next;
}

export type LegacyEntryInput = LegacyInput & {
  name: string;
  locationId?: string | null;
  parentItemId?: string | null;
  category?: string | null;
};

/**
 * Create one item from a sticker during fast entry, and say which number to
 * offer for the next one.
 */
export async function createFromLegacySticker(input: LegacyEntryInput, userOid: string | null) {
  const { tag, value } = await legacyValue(input);
  const item = await createItem(
    {
      name: input.name,
      locationId: input.locationId ?? null,
      parentItemId: input.parentItemId ?? null,
      category: input.category ?? null,
      identifiers: [{ type: "legacy", value }],
    },
    userOid,
  ).catch(async (err: unknown) => {
    // createItem words a clash generically; say which sticker and where.
    if (err instanceof HttpError && err.status === 409) {
      throw conflict(`Sticker ${value} is already on ${await holderOf(value)}.`);
    }
    throw err;
  });
  return {
    item: { id: item.id, name: item.name, assetCode: item.assetCode },
    value,
    next: { color: tag.color, lot: tag.lot, number: await nextLegacyNumber(tag.color, tag.lot, tag.number) },
  };
}
