import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, itemEvents, itemIdentifiers, items, locations } from "../../db/schema";
import { registerImports, registerRows } from "../../db/tables/register-reconcile";
import { conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { normalizeEpc, normKey } from "./normalize";
import { planImport, type ExistingKeys, type ImportPlan, type PlanRow } from "./plan";
import { loadLocationIndex } from "./store";

/**
 * "Import as new items": for moving off Snipe-IT, Homebox or a spreadsheet.
 * The preview and the commit share one planner, and the commit only goes ahead
 * when its plan is the one that was previewed.
 */

export type ImportOptions = {
  companyId?: string | null;
  defaultLocationId?: string | null;
  /** Limit to these register rows; all rows otherwise. */
  rowIds?: string[];
};

/** Identity keys already on file, each with the printed code that holds it. */
export async function loadExistingKeys(): Promise<ExistingKeys> {
  const [ids, units] = await Promise.all([
    db
      .select({ type: itemIdentifiers.type, value: itemIdentifiers.value, code: items.assetCode })
      .from(itemIdentifiers)
      .innerJoin(items, eq(items.id, itemIdentifiers.itemId))
      .where(inArray(itemIdentifiers.type, ["asset_tag", "serial", "rfid"])),
    db.execute<{ serial: string; code: string }>(
      sql`SELECT serial, asset_code AS code FROM item_units WHERE serial IS NOT NULL`,
    ),
  ]);
  const keys: ExistingKeys = { assetTags: new Map(), serials: new Map(), epcs: new Map() };
  for (const r of ids) {
    if (r.type === "asset_tag") keys.assetTags.set(normKey(r.value)!, r.code);
    else if (r.type === "serial") keys.serials.set(normKey(r.value)!, r.code);
    else keys.epcs.set(normalizeEpc(r.value)!, r.code);
  }
  for (const r of units.rows) keys.serials.set(normKey(r.serial)!, r.code);
  return keys;
}

async function validateTargets(opts: ImportOptions): Promise<void> {
  if (opts.companyId) {
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, opts.companyId)).limit(1);
    if (!c) throw notFound("That group no longer exists.");
  }
  if (opts.defaultLocationId) {
    const [l] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, opts.defaultLocationId)).limit(1);
    if (!l) throw notFound("That location no longer exists.");
  }
}

export async function planForImport(importId: string, opts: ImportOptions): Promise<ImportPlan> {
  const [imp] = await db.select().from(registerImports).where(eq(registerImports.id, importId)).limit(1);
  if (!imp) throw notFound("Register import not found");
  await validateTargets(opts);
  const [stored, locIndex, existing] = await Promise.all([
    opts.rowIds?.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(registerRows)
          .where(and(eq(registerRows.importId, importId), opts.rowIds ? inArray(registerRows.id, opts.rowIds) : undefined))
          .orderBy(asc(registerRows.rowNumber)),
    loadLocationIndex(),
    loadExistingKeys(),
  ]);
  const rows: PlanRow[] = stored.map((r) => ({
    id: r.id,
    rowNumber: r.rowNumber,
    assetTag: r.assetTag,
    serial: r.serial,
    epc: r.epc,
    name: r.name,
    model: r.model,
    brand: r.brand,
    category: r.category,
    description: r.description,
    locationText: r.locationText,
    registerLocationId: locIndex.resolve(r.locationText).locationId,
    custodian: r.custodian,
    costCents: r.costCents,
    purchaseDate: r.purchaseDate,
    quantity: r.quantity,
    createdItemId: r.createdItemId,
  }));
  return planImport(rows, existing, {
    importId,
    importName: imp.name,
    companyId: opts.companyId ?? null,
    defaultLocationId: opts.defaultLocationId ?? null,
  });
}

/** The plan, with location paths so a person can read it. */
export async function previewImport(importId: string, opts: ImportOptions) {
  const plan = await planForImport(importId, opts);
  const locIndex = await loadLocationIndex();
  return {
    ...plan,
    create: plan.create.map((c) => ({ ...c, locationPath: locIndex.path(c.locationId) })),
  };
}

export type CreatedItem = { rowId: string; rowNumber: number; itemId: string; assetCode: string };

/**
 * Create the planned items in one transaction: items, their identifiers, one
 * "created" event each, and a link from each register row to what it made.
 */
export async function executePlan(
  plan: ImportPlan,
  userOid: string | null,
  eventDetail: Record<string, unknown>,
): Promise<CreatedItem[]> {
  if (!plan.create.length) return [];
  const created: CreatedItem[] = [];
  try {
    await db.transaction(async (tx) => {
      // Two people pressing "create" on the same rows: the second waits here,
      // then finds the rows already used and stops instead of duplicating.
      const locked = await tx
        .select({ id: registerRows.id, createdItemId: registerRows.createdItemId })
        .from(registerRows)
        .where(inArray(registerRows.id, plan.create.map((c) => c.rowId)))
        .orderBy(registerRows.id)
        .for("update");
      if (locked.some((r) => r.createdItemId)) {
        throw conflict("Some of these rows were imported meanwhile. Preview again.");
      }
      for (let i = 0; i < plan.create.length; i += 500) {
        const part = plan.create.slice(i, i + 500).map((c) => ({ ...c, itemId: randomUUID() }));
        // Ids are chosen here so identifiers and events can be written without
        // relying on the order rows come back in.
        const inserted = await tx
          .insert(items)
          .values(
            part.map((c) => ({
              id: c.itemId,
              name: c.name,
              brand: c.brand,
              model: c.model,
              category: c.category,
              description: c.description,
              quantity: c.quantity,
              valueCents: c.valueCents,
              locationId: c.locationId,
              companyId: c.companyId,
              enrichmentSource: "register",
              metadata: c.metadata,
              createdBy: userOid,
            })),
          )
          .returning({ id: items.id, assetCode: items.assetCode });
        const codes = new Map(inserted.map((r) => [r.id, r.assetCode]));
        const identifiers = part.flatMap((c) => c.identifiers.map((idf) => ({ itemId: c.itemId, type: idf.type, value: idf.value })));
        if (identifiers.length) await tx.insert(itemIdentifiers).values(identifiers);
        await tx.insert(itemEvents).values(
          part.map((c) => ({
            itemId: c.itemId,
            userOid,
            action: "created" as const,
            detail: { name: c.name, source: "register", row: c.rowNumber, ...eventDetail },
          })),
        );
        await tx.execute(sql`
          UPDATE register_rows r SET created_item_id = x.item_id
            FROM jsonb_to_recordset(${JSON.stringify(part.map((c) => ({ id: c.rowId, item_id: c.itemId })))}::jsonb)
                 AS x(id uuid, item_id uuid)
           WHERE r.id = x.id AND r.created_item_id IS NULL`);
        for (const c of part) {
          created.push({ rowId: c.rowId, rowNumber: c.rowNumber, itemId: c.itemId, assetCode: codes.get(c.itemId) ?? "" });
        }
      }
    });
  } catch (err) {
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value", "uq_item_identifiers_value")) {
      throw conflict("An identifier in this register was added to another item meanwhile. Preview again.");
    }
    throw err;
  }
  return created;
}

export async function commitImport(importId: string, opts: ImportOptions, planHash: string, userOid: string | null) {
  const plan = await planForImport(importId, opts);
  if (plan.hash !== planHash) {
    throw conflict("The register or the inventory changed since the preview. Preview again before importing.");
  }
  const created = await executePlan(plan, userOid, { importId });
  logger.info("register.import_new.done", { importId, created: created.length, skipped: plan.skip.length, by: userOid });
  return { created, skipped: plan.skip };
}
