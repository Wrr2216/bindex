import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db/client";
import { listUnits, findUnitByAssetCode, findUnitBySerial } from "./units";
import {
  items,
  itemIdentifiers,
  itemImages,
  itemEvents,
  itemAssignments,
  itemUnits,
  locations,
  companies,
  entities,
  type IdentifierType,
  type ItemEventAction,
} from "../db/schema";
import { conflict, isUniqueViolation, notFound } from "../lib/errors";
import { env } from "../env";
import { logger } from "../lib/logger";
import { lookupItemFields } from "./enrichment";
import { savePhotoFromUrl } from "./photos";
import { publishItemEvent } from "./event-backbone/bus";

export type IdentifierInput = { type: IdentifierType; value: string };
export type CreateItemInput = {
  name: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  primaryImageUrl?: string | null;
  parentItemId?: string | null;
  locationId?: string | null;
  utilizedByEntityId?: string | null;
  companyId?: string | null;
  valueCents?: number | null;
  expiresAt?: string | Date | null;
  quantity?: number;
  enrichmentSource?: string | null;
  metadata?: Record<string, unknown>;
  identifiers?: IdentifierInput[];
  images?: string[];
};

export async function recordEvent(
  itemId: string | null,
  userOid: string | null,
  action: ItemEventAction,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(itemEvents).values({ itemId, userOid, action, detail });
  await publishItemEvent(itemId, userOid, action, detail);
}

async function assemble(itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw notFound("Item not found");

  const [identifiers, images, children, events, location, entity, assignments, units, company] =
    await Promise.all([
      db.select().from(itemIdentifiers).where(eq(itemIdentifiers.itemId, itemId)),
      db.select().from(itemImages).where(eq(itemImages.itemId, itemId)).orderBy(itemImages.sort),
      db.select().from(items).where(eq(items.parentItemId, itemId)),
      db
        .select()
        .from(itemEvents)
        .where(eq(itemEvents.itemId, itemId))
        .orderBy(desc(itemEvents.createdAt))
        .limit(50),
      item.locationId
        ? db.select({ name: locations.name }).from(locations).where(eq(locations.id, item.locationId)).limit(1)
        : Promise.resolve([]),
      item.utilizedByEntityId
        ? db.select().from(entities).where(eq(entities.id, item.utilizedByEntityId)).limit(1)
        : Promise.resolve([]),
      // Item-level history only. A unit's check-outs are listed on that unit,
      // and letting them through here would make the item look checked out.
      db
        .select()
        .from(itemAssignments)
        .where(and(eq(itemAssignments.itemId, itemId), isNull(itemAssignments.unitId)))
        .orderBy(desc(itemAssignments.checkedOutAt))
        .limit(50),
      listUnits(itemId),
      item.companyId
        ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, item.companyId)).limit(1)
        : Promise.resolve([]),
    ]);

  return {
    ...item,
    locationName: location[0]?.name ?? null,
    companyName: company[0]?.name ?? null,
    utilizedByEntityName: entity[0]?.name ?? null,
    identifiers,
    images,
    children,
    events,
    assignments,
    units,
  };
}

export type ItemDetail = Awaited<ReturnType<typeof assemble>>;

export const getItemDetail = (id: string) => assemble(id);

export type ItemKind = "physical" | "digital" | "all";

export function isDigitalCategory(category: string | null): boolean {
  return category === "Domain";
}

function kindCondition(kind: ItemKind) {
  if (kind === "digital") return eq(items.category, "Domain");
  // IS DISTINCT FROM, not <>: `category <> 'Domain'` is NULL (i.e. not true) for
  // uncategorised items, which silently hid every item saved without a category.
  if (kind === "physical") return sql`${items.category} IS DISTINCT FROM 'Domain'`;
  return undefined;
}

/** Resolve a scanned value to its item, by identifier or by printed asset code. */
export async function getByIdentifier(value: string, userOid: string | null) {
  const code = value.trim();

  // A product code (UPC/SKU) may be shared by several items, so resolve to the
  // most recently touched one so scanning is at least deterministic.
  const [idRow] = await db
    .select({ itemId: itemIdentifiers.itemId })
    .from(itemIdentifiers)
    .innerJoin(items, eq(items.id, itemIdentifiers.itemId))
    .where(eq(itemIdentifiers.value, code))
    .orderBy(desc(items.updatedAt))
    .limit(1);

  let itemId = idRow?.itemId;
  let matchedUnitId: string | null = null;
  if (!itemId) {
    const [byCode] = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.assetCode, code))
      .limit(1);
    itemId = byCode?.id;
  }
  if (!itemId) {
    // A unit's own printed code or serial resolves to its item; remember
    // which unit was scanned so the UI can highlight it.
    const unit = (await findUnitByAssetCode(code)) ?? (await findUnitBySerial(code));
    if (unit) {
      itemId = unit.itemId;
      matchedUnitId = unit.id;
    }
  }
  if (!itemId) {
    // Fall back to an exact (case-insensitive) model/SKU match, but only when
    // it's unambiguous (exactly one item has that model).
    const byModel = await db.select({ id: items.id }).from(items).where(ilike(items.model, code)).limit(2);
    if (byModel.length === 1) itemId = byModel[0]!.id;
  }

  if (!itemId) return null;
  await recordEvent(itemId, userOid, "scanned", { value: code });
  return { ...(await assemble(itemId)), matchedUnitId };
}

/** Domain-only list for the dedicated Domains page. */
export async function listDomains() {
  return listOrSearch({ kind: "digital" });
}

export async function listOrSearch(opts: {
  q?: string;
  locationId?: string;
  companyId?: string;
  kind?: ItemKind;
  limit?: number;
  offset?: number;
}) {
  const kind: ItemKind = opts.kind ?? "physical";
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const q = opts.q?.trim();

  if (!q) {
    const conds = [
      kindCondition(kind),
      opts.locationId ? eq(items.locationId, opts.locationId) : undefined,
      opts.companyId ? eq(items.companyId, opts.companyId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => !!c);
    return db
      .select({
        item: items,
        locationName: locations.name,
        companyName: companies.name,
        utilizedByEntityName: entities.name,
      })
      .from(items)
      .leftJoin(locations, eq(items.locationId, locations.id))
      .leftJoin(companies, eq(items.companyId, companies.id))
      .leftJoin(entities, eq(items.utilizedByEntityId, entities.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(items.updatedAt))
      .limit(limit)
      .offset(offset)
      .then((rows) =>
        rows.map((r) => ({
          ...r.item,
          locationName: r.locationName,
          companyName: r.companyName,
          utilizedByEntityName: r.utilizedByEntityName,
        })),
      );
  }

  // Exact identifier + full-text + trigram fuzzy, ranked.
  const params: unknown[] = [q, limit, offset];
  let companyFilter = "";
  if (opts.companyId) {
    params.push(opts.companyId);
    companyFilter = `AND i.company_id = $${params.length}`;
  }
  let kindFilter = "";
  if (kind === "physical") {
    kindFilter = "AND i.category IS DISTINCT FROM 'Domain'";
  } else if (kind === "digital") {
    kindFilter = "AND i.category = 'Domain'";
  }
  const res = await pool.query(
    `SELECT i.*, l.name AS location_name, c.name AS company_name, e.name AS utilized_by_entity_name,
            ts_rank(i.search_tsv, plainto_tsquery('english', $1)) AS rank,
            GREATEST(
              similarity(i.name, $1),
              similarity(coalesce(i.brand,''), $1),
              similarity(coalesce(i.model,''), $1)
            ) AS sim
       FROM items i
       LEFT JOIN locations l ON l.id = i.location_id
       LEFT JOIN companies c ON c.id = i.company_id
       LEFT JOIN entities e ON e.id = i.utilized_by_entity_id
      WHERE (i.search_tsv @@ plainto_tsquery('english', $1)
         OR i.name ILIKE '%' || $1 || '%'
         OR i.brand ILIKE '%' || $1 || '%'
         OR i.model ILIKE '%' || $1 || '%'
         OR i.asset_code ILIKE '%' || $1 || '%'
         OR i.ninjaone_asset_id ILIKE '%' || $1 || '%'
         OR EXISTS (
              SELECT 1 FROM item_identifiers ii
               WHERE ii.item_id = i.id AND ii.value ILIKE '%' || $1 || '%'
            )
         OR EXISTS (
              SELECT 1 FROM item_units iu
               WHERE iu.item_id = i.id
                 AND (iu.asset_code ILIKE '%' || $1 || '%'
                   OR iu.serial ILIKE '%' || $1 || '%'
                   OR iu.label ILIKE '%' || $1 || '%')
            )) ${kindFilter} ${companyFilter}
      ORDER BY rank DESC, sim DESC, i.updated_at DESC
      LIMIT $2 OFFSET $3`,
    params,
  );
  // Map snake_case SQL columns to the camelCase shape the rest of the API uses.
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    brand: r.brand,
    model: r.model,
    category: r.category,
    primaryImageUrl: r.primary_image_url,
    parentItemId: r.parent_item_id,
    locationId: r.location_id,
    quantity: r.quantity,
    status: r.status,
    valueCents: r.value_cents === null ? null : Number(r.value_cents),
    expiresAt: r.expires_at,
    enrichmentSource: r.enrichment_source,
    metadata: r.metadata,
    assetCode: r.asset_code,
    ninjaoneDeviceId: r.ninjaone_device_id,
    ninjaoneAssetId: r.ninjaone_asset_id,
    ninjaoneOrg: r.ninjaone_org,
    ninjaoneSyncedAt: r.ninjaone_synced_at,
    utilizedByEntityId: r.utilized_by_entity_id,
    companyId: r.company_id,
    lastSpotCheckedAt: r.last_spot_checked_at,
    lastSpotCheckedBy: r.last_spot_checked_by,
    flaggedMissing: r.flagged_missing,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    locationName: r.location_name,
    companyName: r.company_name,
    utilizedByEntityName: r.utilized_by_entity_name,
  }));
}

export async function createItem(input: CreateItemInput, userOid: string | null) {
  const created = await db.transaction(async (tx) => {
    const [item] = await tx
      .insert(items)
      .values({
        name: input.name,
        description: input.description ?? null,
        brand: input.brand ?? null,
        model: input.model ?? null,
        category: input.category ?? null,
        primaryImageUrl: input.primaryImageUrl ?? input.images?.[0] ?? null,
        parentItemId: input.parentItemId ?? null,
        locationId: input.locationId ?? null,
        utilizedByEntityId: input.utilizedByEntityId ?? null,
        companyId: input.companyId ?? null,
        valueCents: input.valueCents ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        quantity: input.quantity ?? 1,
        enrichmentSource: input.enrichmentSource ?? "manual",
        metadata: input.metadata ?? {},
        createdBy: userOid,
      })
      .returning();

    if (input.identifiers?.length) {
      await tx
        .insert(itemIdentifiers)
        .values(input.identifiers.map((id) => ({ itemId: item!.id, type: id.type, value: id.value.trim() })));
    }
    if (input.images?.length) {
      await tx.insert(itemImages).values(
        input.images.map((url, i) => ({ itemId: item!.id, url, isPrimary: i === 0, sort: i })),
      );
    }
    return item!;
  }).catch((err: unknown) => {
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value", "uq_item_identifiers_value")) {
      throw conflict("One of those identifiers is already assigned to another item.");
    }
    throw err;
  });

  await recordEvent(created.id, userOid, "created", { name: created.name });

  // Fills in a description and photo in the background when the person left
  // them blank. Only ever writes into empty fields.
  void enrichNewItem(created, input).catch((err) =>
    logger.warn("items.create.background_enrich_error", { id: created.id, err: String(err) }),
  );

  return assemble(created.id);
}

/** Best-effort description and photo for a newly created item. */
async function enrichNewItem(
  created: { id: string; name: string; description: string | null; primaryImageUrl: string | null },
  input: CreateItemInput,
): Promise<void> {
  if (created.description || created.primaryImageUrl) return;
  if (!env.llmConfigured && !env.webSearchConfigured) return;

  const identifier =
    input.identifiers?.find((i) => i.type === "upc")?.value ??
    input.identifiers?.find((i) => i.type === "sku")?.value ??
    input.identifiers?.find((i) => i.type === "serial")?.value ??
    null;

  const { description, images } = await lookupItemFields({
    name: created.name,
    brand: input.brand,
    model: input.model,
    identifier,
  });

  if (description && !created.description) {
    await db
      .update(items)
      .set({ description, updatedAt: new Date() })
      .where(eq(items.id, created.id));
  }
  if (images.length && !created.primaryImageUrl) {
    await savePhotoFromUrl(created.id, images[0]!).catch((err) =>
      logger.warn("items.create.background_enrich_photo_error", {
        id: created.id,
        err: String(err),
      }),
    );
  }
}

export async function updateItem(
  id: string,
  patch: Partial<CreateItemInput>,
  userOid: string | null,
) {
  const [existing] = await db.select().from(items).where(eq(items.id, id)).limit(1);
  if (!existing) throw notFound("Item not found");

  await db
    .update(items)
    .set({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      brand: patch.brand ?? existing.brand,
      model: patch.model ?? existing.model,
      category: patch.category ?? existing.category,
      primaryImageUrl: patch.primaryImageUrl ?? existing.primaryImageUrl,
      parentItemId: patch.parentItemId === undefined ? existing.parentItemId : patch.parentItemId,
      locationId: patch.locationId === undefined ? existing.locationId : patch.locationId,
      utilizedByEntityId:
        patch.utilizedByEntityId === undefined
          ? existing.utilizedByEntityId
          : patch.utilizedByEntityId,
      companyId:
        patch.companyId === undefined ? existing.companyId : patch.companyId,
      valueCents: patch.valueCents === undefined ? existing.valueCents : patch.valueCents,
      expiresAt:
        patch.expiresAt === undefined
          ? existing.expiresAt
          : patch.expiresAt
            ? new Date(patch.expiresAt)
            : null,
      quantity: patch.quantity ?? existing.quantity,
      metadata: patch.metadata ?? existing.metadata,
      updatedAt: new Date(),
    })
    .where(eq(items.id, id));

  await recordEvent(id, userOid, "updated", { fields: Object.keys(patch) });
  return assemble(id);
}

export async function deleteItem(id: string, userOid: string | null) {
  const deleted = await db.delete(items).where(eq(items.id, id)).returning({ id: items.id });
  if (!deleted.length) throw notFound("Item not found");
  await recordEvent(null, userOid, "deleted", { itemId: id });
}

export async function addIdentifier(itemId: string, input: IdentifierInput) {
  try {
    const [row] = await db
      .insert(itemIdentifiers)
      .values({ itemId, type: input.type, value: input.value.trim() })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value", "uq_item_identifiers_value")) {
      throw conflict("That identifier is already assigned to another item.");
    }
    throw err;
  }
}

export async function removeIdentifier(identifierId: string) {
  await db.delete(itemIdentifiers).where(eq(itemIdentifiers.id, identifierId));
}

export const getChildren = (itemId: string) =>
  db.select().from(items).where(and(eq(items.parentItemId, itemId)));

export type ManifestContent = {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  assetCode: string;
  quantity: number;
  serials: string[];
  flaggedMissing: boolean;
};

export type ContainerManifest = {
  id: string;
  name: string;
  assetCode: string;
  locationName: string | null;
  companyName: string | null;
  contents: ManifestContent[];
};

/**
 * Map each item id to its serial numbers (from tracked units and `serial`-type
 * identifiers). Shared by container and location packing slips.
 */
export async function serialsForItems(itemIds: string[]): Promise<Map<string, string[]>> {
  const byItem = new Map<string, string[]>();
  if (!itemIds.length) return byItem;
  const add = (id: string, serial: string | null | undefined) => {
    const s = serial?.trim();
    if (!s) return;
    const list = byItem.get(id) ?? [];
    if (!list.includes(s)) list.push(s);
    byItem.set(id, list);
  };
  const [units, serialIds] = await Promise.all([
    db
      .select({ itemId: itemUnits.itemId, serial: itemUnits.serial })
      .from(itemUnits)
      .where(inArray(itemUnits.itemId, itemIds)),
    db
      .select({ itemId: itemIdentifiers.itemId, value: itemIdentifiers.value })
      .from(itemIdentifiers)
      .where(and(inArray(itemIdentifiers.itemId, itemIds), eq(itemIdentifiers.type, "serial"))),
  ]);
  for (const u of units) add(u.itemId, u.serial);
  for (const r of serialIds) add(r.itemId, r.value);
  return byItem;
}

/**
 * Gather a container's contents for a printable packing slip: every child item
 * with its serial numbers (from tracked units and `serial`-type identifiers).
 */
export async function getContainerManifest(itemId: string): Promise<ContainerManifest> {
  const detail = await assemble(itemId);
  const serialsByItem = await serialsForItems(detail.children.map((c) => c.id));

  return {
    id: detail.id,
    name: detail.name,
    assetCode: detail.assetCode,
    locationName: detail.locationName,
    companyName: detail.companyName,
    contents: detail.children.map((c) => ({
      id: c.id,
      name: c.name,
      brand: c.brand,
      model: c.model,
      assetCode: c.assetCode,
      quantity: c.quantity,
      serials: serialsByItem.get(c.id) ?? [],
      flaggedMissing: c.flaggedMissing,
    })),
  };
}

export type BulkSet = {
  locationId?: string | null;
  utilizedByEntityId?: string | null;
  companyId?: string | null;
  status?: string;
};

/** Apply a small patch to many items at once. */
export async function bulkUpdate(ids: string[], set: BulkSet, userOid: string | null) {
  if (!ids.length) return { updated: 0 };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (set.locationId !== undefined) patch.locationId = set.locationId;
  if (set.utilizedByEntityId !== undefined) patch.utilizedByEntityId = set.utilizedByEntityId;
  if (set.companyId !== undefined) patch.companyId = set.companyId;
  if (set.status !== undefined) patch.status = set.status;
  await db.update(items).set(patch).where(inArray(items.id, ids));
  await recordEvent(null, userOid, "updated", { bulk: true, ids, set });
  return { updated: ids.length };
}

export async function bulkDelete(ids: string[], userOid: string | null) {
  if (!ids.length) return { deleted: 0 };
  await db.delete(items).where(inArray(items.id, ids));
  await recordEvent(null, userOid, "deleted", { bulk: true, ids });
  return { deleted: ids.length };
}
