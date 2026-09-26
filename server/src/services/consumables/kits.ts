import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  consumableItems,
  equipmentKitLines,
  equipmentKits,
  itemAssignments,
  items,
  itemUnits,
} from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { checkIn, checkInUnit, checkOut, checkOutUnit } from "../assignments";
import { loadHolder, type Actor } from "./stock";

/**
 * Equipment kits: many pieces checked out to one crew, truck or branch in a
 * single scan session. Each piece goes through the ordinary check-out path,
 * so it shows as out on its own page and a return from anywhere in the app
 * counts; the kit only groups those records and says when they are due back.
 */

export type KitLineInput = { itemId: string; unitId?: string | null };

const lineKey = (l: KitLineInput) => `${l.itemId}|${l.unitId ?? ""}`;

type Failure = { itemId: string; unitId: string | null; name: string | null; error: string };

async function openAssignmentId(itemId: string, unitId: string | null): Promise<string | null> {
  const res = await db.execute<{ id: string }>(
    unitId
      ? sql`SELECT id FROM item_assignments WHERE unit_id = ${unitId} AND checked_in_at IS NULL LIMIT 1`
      : sql`SELECT id FROM item_assignments
             WHERE item_id = ${itemId} AND unit_id IS NULL AND checked_in_at IS NULL LIMIT 1`,
  );
  return res.rows[0]?.id ?? null;
}

export async function createKit(
  input: {
    holderId: string;
    expectedReturnAt?: Date | null;
    jobRef?: string | null;
    note?: string | null;
    lines: KitLineInput[];
  },
  actor: Actor,
) {
  const holder = await loadHolder(input.holderId);
  const lines = [...new Map(input.lines.map((l) => [lineKey(l), { itemId: l.itemId, unitId: l.unitId ?? null }])).values()];
  if (!lines.length) throw badRequest("Scan at least one piece of equipment.");

  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const unitIds = lines.map((l) => l.unitId).filter((u): u is string => !!u);
  const [found, units, consumables] = await Promise.all([
    db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, itemIds)),
    unitIds.length
      ? db.select({ id: itemUnits.id, itemId: itemUnits.itemId }).from(itemUnits).where(inArray(itemUnits.id, unitIds))
      : [],
    db.select({ id: consumableItems.itemId }).from(consumableItems).where(inArray(consumableItems.itemId, itemIds)),
  ]);
  const names = new Map(found.map((f) => [f.id, f.name]));
  const unitOwner = new Map(units.map((u) => [u.id, u.itemId]));
  const isConsumable = new Set(consumables.map((c) => c.id));

  const failures: Failure[] = [];
  const valid = lines.filter((l) => {
    const name = names.get(l.itemId) ?? null;
    const fail = (error: string) => {
      failures.push({ itemId: l.itemId, unitId: l.unitId, name, error });
      return false;
    };
    if (!name) return fail("Not found.");
    if (l.unitId && unitOwner.get(l.unitId) !== l.itemId) return fail("That unit does not belong to this item.");
    if (isConsumable.has(l.itemId)) return fail("This is a consumable. Issue it from Supplies instead.");
    return true;
  });
  if (!valid.length) {
    throw badRequest(`Nothing to check out. ${failures.map((f) => `${f.name ?? f.itemId}: ${f.error}`).join(" ")}`);
  }

  const [kit] = await db
    .insert(equipmentKits)
    .values({
      holderEntityId: holder.id,
      holderName: holder.name,
      expectedReturnAt: input.expectedReturnAt ?? null,
      jobRef: input.jobRef?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: actor.oid,
    })
    .returning();
  const kitId = kit!.id;
  const note = `Kit ${kitId.slice(0, 8)}${kit!.jobRef ? ` · ${kit!.jobRef}` : ""}`;

  let out = 0;
  for (const l of valid) {
    try {
      // The assignments service owns the per-piece record, including handing a
      // piece that is still out to someone else over to this holder.
      if (l.unitId) await checkOutUnit(l.unitId, holder.id, actor.oid, note);
      else await checkOut(l.itemId, holder.id, actor.oid, note);
      await db.insert(equipmentKitLines).values({
        kitId,
        itemId: l.itemId,
        unitId: l.unitId,
        assignmentId: await openAssignmentId(l.itemId, l.unitId),
      });
      out += 1;
    } catch (err) {
      failures.push({
        itemId: l.itemId,
        unitId: l.unitId,
        name: names.get(l.itemId) ?? null,
        error: err instanceof Error ? err.message : "Check-out failed.",
      });
    }
  }
  if (!out) {
    await db.delete(equipmentKits).where(eq(equipmentKits.id, kitId));
    throw badRequest(`Nothing was checked out. ${failures[0]?.error ?? ""}`.trim());
  }
  logger.info("consumables.kit.checked_out", { kitId, holderId: holder.id, pieces: out, failed: failures.length });
  return { kit: await getKit(kitId), failures };
}

type LineSql = {
  id: string;
  kit_id: string;
  item_id: string;
  item_name: string;
  asset_code: string;
  unit_id: string | null;
  unit_code: string | null;
  unit_label: string | null;
  serial: string | null;
  assignment_id: string | null;
  checked_out_at: Date | string | null;
  checked_in_at: Date | string | null;
};

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function lineView(r: LineSql) {
  const status: "out" | "returned" | "unknown" = !r.assignment_id
    ? "unknown"
    : r.checked_in_at
      ? "returned"
      : "out";
  return {
    id: r.id,
    itemId: r.item_id,
    name: r.item_name,
    assetCode: r.unit_code ?? r.asset_code,
    unitId: r.unit_id,
    unitLabel: r.unit_label,
    serial: r.serial,
    status,
    checkedOutAt: iso(r.checked_out_at),
    checkedInAt: iso(r.checked_in_at),
  };
}

const LINE_SELECT = sql`
  SELECT l.id, l.kit_id, l.item_id, i.name AS item_name, i.asset_code,
         l.unit_id, u.asset_code AS unit_code, u.label AS unit_label, u.serial,
         a.id AS assignment_id, a.checked_out_at, a.checked_in_at
    FROM equipment_kit_lines l
    JOIN items i ON i.id = l.item_id
    LEFT JOIN item_units u ON u.id = l.unit_id
    LEFT JOIN item_assignments a ON a.id = l.assignment_id`;

/**
 * Close every kit whose pieces are all back. Returns can happen from an item's
 * own page, so this runs before kits are listed rather than only after a
 * return made here.
 */
export async function settleKits(): Promise<void> {
  await db.execute(sql`
    UPDATE equipment_kits k SET closed_at = now()
     WHERE k.closed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM equipment_kit_lines l
           JOIN item_assignments a ON a.id = l.assignment_id
          WHERE l.kit_id = k.id AND a.checked_in_at IS NULL)`);
}

function kitView(k: typeof equipmentKits.$inferSelect, lines: ReturnType<typeof lineView>[]) {
  const outCount = lines.filter((l) => l.status === "out").length;
  return {
    id: k.id,
    holderId: k.holderEntityId,
    holderName: k.holderName,
    expectedReturnAt: k.expectedReturnAt,
    jobRef: k.jobRef,
    note: k.note,
    createdBy: k.createdBy,
    createdAt: k.createdAt,
    closedAt: k.closedAt,
    total: lines.length,
    outCount,
    returnedCount: lines.filter((l) => l.status === "returned").length,
    overdue: outCount > 0 && !!k.expectedReturnAt && k.expectedReturnAt.getTime() < Date.now(),
  };
}

export async function getKit(id: string) {
  await settleKits();
  const [kit] = await db.select().from(equipmentKits).where(eq(equipmentKits.id, id)).limit(1);
  if (!kit) throw notFound("Kit not found");
  const res = await db.execute<LineSql>(sql`${LINE_SELECT} WHERE l.kit_id = ${id} ORDER BY i.name, u.asset_code`);
  const lines = res.rows.map(lineView);
  return {
    ...kitView(kit, lines),
    lines,
    // The pieces still out, which is what an end-of-day return is looking for.
    missing: lines.filter((l) => l.status === "out"),
  };
}

export type KitStatus = "open" | "closed" | "overdue" | "all";

export async function listKits(opts: { status?: KitStatus; holderId?: string; limit?: number }) {
  await settleKits();
  const status = opts.status ?? "open";
  const res = await db.execute<{ id: string }>(sql`
    SELECT k.id FROM equipment_kits k
     WHERE true
       ${status === "open" || status === "overdue" ? sql`AND k.closed_at IS NULL` : sql``}
       ${status === "closed" ? sql`AND k.closed_at IS NOT NULL` : sql``}
       ${status === "overdue" ? sql`AND k.expected_return_at < now()` : sql``}
       ${opts.holderId ? sql`AND k.holder_entity_id = ${opts.holderId}` : sql``}
     ORDER BY k.created_at DESC
     LIMIT ${Math.min(opts.limit ?? 100, 500)}`);
  const ids = res.rows.map((r) => r.id);
  if (!ids.length) return [];
  const [kits, lines] = await Promise.all([
    db.select().from(equipmentKits).where(inArray(equipmentKits.id, ids)),
    db.execute<LineSql>(sql`${LINE_SELECT} WHERE l.kit_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
  ]);
  const byKit = new Map<string, ReturnType<typeof lineView>[]>();
  for (const r of lines.rows) byKit.set(r.kit_id, [...(byKit.get(r.kit_id) ?? []), lineView(r)]);
  const order = new Map(ids.map((id, i) => [id, i]));
  return kits
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((k) => kitView(k, byKit.get(k.id) ?? []));
}

/** Every piece still out on a kit that was due back before now. */
export async function listOverdue() {
  const res = await db.execute<LineSql & { holder_id: string | null; holder_name: string; expected_return_at: Date | string }>(sql`
    SELECT l.id, l.kit_id, l.item_id, i.name AS item_name, i.asset_code,
           l.unit_id, u.asset_code AS unit_code, u.label AS unit_label, u.serial,
           a.id AS assignment_id, a.checked_out_at, a.checked_in_at,
           k.holder_entity_id AS holder_id, k.holder_name, k.expected_return_at
      FROM equipment_kit_lines l
      JOIN equipment_kits k ON k.id = l.kit_id
      JOIN items i ON i.id = l.item_id
      JOIN item_assignments a ON a.id = l.assignment_id
      LEFT JOIN item_units u ON u.id = l.unit_id
     WHERE a.checked_in_at IS NULL AND k.expected_return_at < now()
     ORDER BY k.expected_return_at, k.holder_name, i.name`);
  return res.rows.map((r) => ({
    ...lineView(r),
    kitId: r.kit_id,
    holderId: r.holder_id,
    holderName: r.holder_name,
    expectedReturnAt: iso(r.expected_return_at),
  }));
}

type SheetSql = {
  assignment_id: string;
  item_id: string;
  item_name: string;
  asset_code: string;
  unit_id: string | null;
  unit_code: string | null;
  unit_label: string | null;
  checked_out_at: Date | string;
  checked_in_at: Date | string | null;
  kit_id: string | null;
  expected_return_at: Date | string | null;
  job_ref: string | null;
};

/**
 * The end-of-day view for one holder: everything that went out to them or
 * came back from them since `since`, plus anything of theirs still out from
 * before, with what is still out flagged. Includes single check-outs made
 * outside a kit, since the holder is accountable for those too.
 */
export async function holderEquipment(holderId: string, since: Date) {
  const res = await db.execute<SheetSql>(sql`
    SELECT a.id AS assignment_id, a.item_id, i.name AS item_name, i.asset_code,
           a.unit_id, u.asset_code AS unit_code, u.label AS unit_label,
           a.checked_out_at, a.checked_in_at,
           k.id AS kit_id, k.expected_return_at, k.job_ref
      FROM item_assignments a
      JOIN items i ON i.id = a.item_id
      LEFT JOIN item_units u ON u.id = a.unit_id
      LEFT JOIN equipment_kit_lines l ON l.assignment_id = a.id
      LEFT JOIN equipment_kits k ON k.id = l.kit_id
     WHERE a.entity_id = ${holderId}
       AND (a.checked_in_at IS NULL OR a.checked_in_at >= ${since} OR a.checked_out_at >= ${since})
     ORDER BY i.name, u.asset_code`);
  const now = Date.now();
  const rows = res.rows.map((r) => {
    const expected = iso(r.expected_return_at);
    return {
      assignmentId: r.assignment_id,
      itemId: r.item_id,
      name: r.item_name,
      assetCode: r.unit_code ?? r.asset_code,
      unitId: r.unit_id,
      unitLabel: r.unit_label,
      kitId: r.kit_id,
      jobRef: r.job_ref,
      checkedOutAt: iso(r.checked_out_at)!,
      checkedInAt: iso(r.checked_in_at),
      expectedReturnAt: expected,
      overdue: !r.checked_in_at && !!expected && new Date(expected).getTime() < now,
    };
  });
  const sinceMs = since.getTime();
  return {
    since: since.toISOString(),
    wentOut: rows.filter((r) => new Date(r.checkedOutAt).getTime() >= sinceMs),
    cameBack: rows.filter((r) => r.checkedInAt),
    stillOut: rows.filter((r) => !r.checkedInAt),
  };
}

/**
 * Check pieces back in. A piece out to a different holder is still taken
 * back, since it is physically here, and flagged so someone can ask why.
 */
export async function returnEquipment(
  input: { holderId?: string | null; lines: KitLineInput[] },
  actor: Actor,
) {
  const holderId = input.holderId ?? null;
  if (holderId) await loadHolder(holderId);
  const lines = [...new Map(input.lines.map((l) => [lineKey(l), { itemId: l.itemId, unitId: l.unitId ?? null }])).values()];
  if (!lines.length) throw badRequest("Scan at least one piece to return.");

  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const found = await db
    .select({ id: items.id, name: items.name, assetCode: items.assetCode })
    .from(items)
    .where(inArray(items.id, itemIds));
  const byId = new Map(found.map((f) => [f.id, f]));

  const returned: {
    itemId: string;
    unitId: string | null;
    name: string;
    fromHolderId: string | null;
    fromHolderName: string;
    wrongHolder: boolean;
  }[] = [];
  const notOut: { itemId: string; unitId: string | null; name: string | null }[] = [];

  for (const l of lines) {
    const item = byId.get(l.itemId);
    if (!item) {
      notOut.push({ ...l, name: null });
      continue;
    }
    let open = (
      await db
        .select()
        .from(itemAssignments)
        .where(
          l.unitId
            ? sql`${itemAssignments.unitId} = ${l.unitId} AND ${itemAssignments.checkedInAt} IS NULL`
            : sql`${itemAssignments.itemId} = ${l.itemId} AND ${itemAssignments.unitId} IS NULL AND ${itemAssignments.checkedInAt} IS NULL`,
        )
        .limit(1)
    )[0];
    if (!open && !l.unitId) {
      // The item's own label was scanned but its units are what went out. If
      // exactly one of them is out to this holder, that is the one coming back.
      const units = await db
        .select()
        .from(itemAssignments)
        .where(
          sql`${itemAssignments.itemId} = ${l.itemId} AND ${itemAssignments.unitId} IS NOT NULL
              AND ${itemAssignments.checkedInAt} IS NULL
              ${holderId ? sql`AND ${itemAssignments.entityId} = ${holderId}` : sql``}`,
        )
        .limit(2);
      if (units.length === 1) open = units[0];
    }
    if (!open) {
      notOut.push({ ...l, name: item.name });
      continue;
    }
    if (open.unitId) await checkInUnit(open.unitId, actor.oid, null);
    else await checkIn(open.itemId, actor.oid, null);
    returned.push({
      itemId: l.itemId,
      unitId: open.unitId,
      name: item.name,
      fromHolderId: open.entityId,
      fromHolderName: open.entityName,
      wrongHolder: !!holderId && open.entityId !== holderId,
    });
  }
  await settleKits();
  logger.info("consumables.kit.returned", {
    holderId,
    returned: returned.length,
    notOut: notOut.length,
    wrongHolder: returned.filter((r) => r.wrongHolder).length,
  });
  const stillOut = holderId ? (await holderEquipment(holderId, new Date())).stillOut : [];
  return { returned, notOut, stillOut };
}
