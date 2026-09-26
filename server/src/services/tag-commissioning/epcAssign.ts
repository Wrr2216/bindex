import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { tagEpcs, type TagEpc } from "../../db/schema";
import { logger } from "../../lib/logger";
import {
  decodeGiai96,
  encodeBindex96,
  encodeBindex96Opaque,
  encodeGiai96,
  type EpcScheme,
} from "./epc";
import { getTagSettings } from "./settings";

/**
 * Which EPC each item or unit gets when Bindex writes the tag.
 *
 * An EPC is assigned the first time anyone asks for it and kept, so the value
 * on the item page is the one that ends up on the tag. Until it has been sent
 * to an encoder it follows the settings: set a GS1 company prefix and the
 * next look turns a private EPC into GIAI-96. Once encoded it never changes.
 */

export type EpcTarget = {
  itemId: string;
  unitId: string | null;
  /** The printed code, which the private scheme packs into the EPC. */
  assetCode: string;
};

export type AssignedEpc = Pick<TagEpc, "id" | "itemId" | "unitId" | "scheme" | "epc" | "giaiSerial" | "encodedAt">;

export const targetKey = (t: { itemId: string; unitId: string | null }) =>
  t.unitId ? `unit:${t.unitId}` : `item:${t.itemId}`;

const GIAI_FILTER = 0; // "All others" in the GS1 filter table for GIAI.

function isCurrent(
  row: AssignedEpc,
  target: EpcTarget,
  scheme: EpcScheme,
  companyPrefix: string,
): boolean {
  if (row.encodedAt) return true;
  if (row.scheme !== scheme) return false;
  if (scheme === "giai-96") return decodeGiai96(row.epc)?.companyPrefix === companyPrefix;
  return row.epc === bindexEpc(target);
}

const bindexEpc = (t: EpcTarget) =>
  encodeBindex96(t.assetCode) ?? encodeBindex96Opaque(t.unitId ?? t.itemId);

async function nextGiaiSerial(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("SELECT nextval('tag_giai_serial_seq') AS n");
  return Number(rows[0]!.n);
}

/**
 * A restore into a fresh database leaves the sequence behind the serials it
 * brought back. Move it past them.
 */
async function catchUpGiaiSequence(): Promise<void> {
  await pool.query(
    `SELECT setval('tag_giai_serial_seq', GREATEST((SELECT coalesce(max(giai_serial), 0) FROM tag_epcs), 1))`,
  );
}

async function loadExisting(targets: EpcTarget[]): Promise<Map<string, AssignedEpc>> {
  const itemIds = targets.filter((t) => !t.unitId).map((t) => t.itemId);
  const unitIds = targets.flatMap((t) => (t.unitId ? [t.unitId] : []));
  const conds = [
    itemIds.length ? and(inArray(tagEpcs.itemId, itemIds), isNull(tagEpcs.unitId)) : undefined,
    unitIds.length ? inArray(tagEpcs.unitId, unitIds) : undefined,
  ].filter((c): c is NonNullable<typeof c> => !!c);
  if (!conds.length) return new Map();
  const rows = await db.select().from(tagEpcs).where(or(...conds));
  return new Map(rows.map((r) => [targetKey(r), r]));
}

async function assignOne(
  target: EpcTarget,
  existing: AssignedEpc | undefined,
  scheme: EpcScheme,
  companyPrefix: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let epc: string;
    let giaiSerial: number | null = null;
    if (scheme === "giai-96") {
      giaiSerial = existing?.giaiSerial ?? (await nextGiaiSerial());
      epc = encodeGiai96({
        filter: GIAI_FILTER,
        companyPrefix,
        assetReference: String(giaiSerial),
      });
    } else {
      epc = bindexEpc(target);
    }

    const now = new Date();
    const written = existing
      ? await db
          .update(tagEpcs)
          .set({ scheme, epc, giaiSerial, updatedAt: now })
          .where(and(eq(tagEpcs.id, existing.id), isNull(tagEpcs.encodedAt)))
          .returning({ id: tagEpcs.id })
          .catch((err: unknown) => (isEpcClash(err) ? [] : Promise.reject(err)))
      : await db
          .insert(tagEpcs)
          .values({ itemId: target.itemId, unitId: target.unitId, scheme, epc, giaiSerial })
          // Another request assigning the same record at the same moment wins;
          // its row is read back below.
          .onConflictDoNothing()
          .returning({ id: tagEpcs.id });
    if (written.length) return;

    // Nothing written: either someone else assigned this record first (fine,
    // it is read back), or the EPC is taken because the GIAI sequence is
    // behind restored serials.
    const again = (await loadExisting([target])).get(targetKey(target));
    if (again && (again.encodedAt || isCurrent(again, target, scheme, companyPrefix))) return;
    if (scheme === "giai-96") {
      await catchUpGiaiSequence();
      existing = again ? { ...again, giaiSerial: null } : undefined;
    } else {
      logger.warn("tags.epc.assign_clash", { itemId: target.itemId, unitId: target.unitId, epc });
      return;
    }
  }
}

const isEpcClash = (err: unknown) => {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    const e = cur as { code?: unknown; cause?: unknown };
    if (e.code === "23505") return true;
    cur = e.cause;
  }
  return false;
};

/**
 * The EPC for each target, assigning or refreshing where needed. Keyed by
 * targetKey(). Records whose assignment failed are left out.
 */
export async function ensureEpcs(targets: EpcTarget[]): Promise<Map<string, AssignedEpc>> {
  if (!targets.length) return new Map();
  const { epcScheme, gs1CompanyPrefix } = await getTagSettings();
  const existing = await loadExisting(targets);
  const stale = targets.filter((t) => {
    const row = existing.get(targetKey(t));
    return !row || !isCurrent(row, t, epcScheme, gs1CompanyPrefix);
  });
  for (const t of stale) {
    await assignOne(t, existing.get(targetKey(t)), epcScheme, gs1CompanyPrefix);
  }
  return stale.length ? loadExisting(targets) : existing;
}

/** Freeze these EPCs: labels carrying them have gone to an encoder. */
export async function markEncoded(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db
    .update(tagEpcs)
    .set({ encodedAt: sql`coalesce(${tagEpcs.encodedAt}, now())`, updatedAt: new Date() })
    .where(inArray(tagEpcs.id, ids));
}
