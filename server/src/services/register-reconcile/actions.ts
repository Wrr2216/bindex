import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { itemEvents, itemIdentifiers, items, itemUnits, type IdentifierType, type ItemEventAction } from "../../db/schema";
import { reconciliationRuns, registerRows, type RegisterEdit } from "../../db/tables/register-reconcile";
import { badRequest, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { updateUnit } from "../units";
import { executePlan, planForImport } from "./importNew";
import { normalizeEpc, normKey } from "./normalize";
import { listResults, type ResultView } from "./reconcile";
import { publishItemEventsLater } from "../event-backbone";

/**
 * What a person can do from a reconciliation result. Each action is explicit,
 * takes many results at once, skips (and says why) any result it does not
 * apply to, writes an item event for every item it touches, and marks the
 * results it handled so the run shows what is left.
 */

export const COPY_FIELDS = ["name", "model", "serial", "assetTag", "epc", "cost"] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

export type ActionInput =
  | { action: "create_items"; resultIds: string[]; companyId?: string | null; defaultLocationId?: string | null }
  | { action: "move_to_register"; resultIds: string[] }
  | { action: "accept_bindex_location"; resultIds: string[] }
  | { action: "copy_fields"; resultIds: string[]; direction: "to_bindex" | "to_register"; fields: CopyField[] }
  | { action: "flag_missing"; resultIds: string[] }
  | { action: "clear_missing"; resultIds: string[] }
  | { action: "link_proposal"; resultIds: string[] }
  | { action: "ignore"; resultIds: string[]; reason: string }
  | { action: "reopen"; resultIds: string[] };

export type ActionOutcome = {
  action: ActionInput["action"];
  done: number;
  skipped: { resultId: string; reason: string }[];
  created?: { rowId: string; rowNumber: number; itemId: string; assetCode: string }[];
};

type Ctx = {
  runId: string;
  importId: string;
  userOid: string | null;
  events: (typeof itemEvents.$inferInsert)[];
  resolved: { id: string; resolution: "resolved" | "ignored" | null; note: string | null }[];
  skipped: ActionOutcome["skipped"];
};

function event(ctx: Ctx, itemId: string | null, action: ItemEventAction, detail: Record<string, unknown>) {
  ctx.events.push({
    itemId,
    userOid: ctx.userOid,
    action,
    detail: { source: "register", runId: ctx.runId, importId: ctx.importId, ...detail },
  });
}

const skip = (ctx: Ctx, r: ResultView, reason: string) => ctx.skipped.push({ resultId: r.id, reason });
const done = (ctx: Ctx, r: ResultView, note: string, resolution: "resolved" | "ignored" | null = "resolved") =>
  ctx.resolved.push({ id: r.id, resolution, note });

/** Current values here, for copying in either direction. */
async function loadAssets(itemIds: string[], unitIds: string[] = []) {
  const [itemRows, unitRows, idRows] = await Promise.all([
    itemIds.length ? db.select().from(items).where(inArray(items.id, itemIds)) : Promise.resolve([]),
    unitIds.length ? db.select().from(itemUnits).where(inArray(itemUnits.id, unitIds)) : Promise.resolve([]),
    itemIds.length
      ? db
          .select()
          .from(itemIdentifiers)
          .where(and(inArray(itemIdentifiers.itemId, itemIds), inArray(itemIdentifiers.type, ["asset_tag", "serial", "rfid"])))
      : Promise.resolve([]),
  ]);
  return {
    items: new Map(itemRows.map((i) => [i.id, i])),
    units: new Map(unitRows.map((u) => [u.id, u])),
    identifiers: (itemId: string, type: IdentifierType) =>
      idRows.filter((i) => i.itemId === itemId && i.type === type),
  };
}

type Assets = Awaited<ReturnType<typeof loadAssets>>;

/**
 * Put a register key on an item: replace the only existing identifier of that
 * type, or add one. Returns why it could not, or null.
 */
async function setIdentifier(assets: Assets, itemId: string, type: IdentifierType, value: string): Promise<string | null> {
  const existing = assets.identifiers(itemId, type);
  const norm = type === "rfid" ? normalizeEpc : normKey;
  if (existing.some((e) => norm(e.value) === norm(value))) return null;
  try {
    if (existing.length === 1) {
      await db.update(itemIdentifiers).set({ value }).where(eq(itemIdentifiers.id, existing[0]!.id));
    } else {
      await db.insert(itemIdentifiers).values({ itemId, type, value });
    }
    return null;
  } catch (err) {
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value", "uq_item_identifiers_value")) {
      return `${value} is already on another item.`;
    }
    throw err;
  }
}

async function recordRegisterEdit(
  rowId: string,
  changes: Partial<Record<CopyField | "locationText" | "bindexCode", string | number | null>>,
  by: string | null,
) {
  const [row] = await db.select().from(registerRows).where(eq(registerRows.id, rowId)).limit(1);
  if (!row) return;
  const at = new Date().toISOString();
  const edits: Record<string, RegisterEdit> = { ...row.edits };
  const set: Partial<typeof registerRows.$inferInsert> = {};
  const current: Record<string, string | number | null> = {
    name: row.name,
    model: row.model,
    serial: row.serial,
    assetTag: row.assetTag,
    epc: row.epc,
    cost: row.costCents,
    locationText: row.locationText,
    bindexCode: row.bindexCode,
  };
  for (const [field, value] of Object.entries(changes)) {
    const before = current[field] ?? null;
    // The first "from" is what the source system holds; keep it across edits.
    const from = edits[field]?.from ?? (before == null ? null : String(before));
    edits[field] = { from, to: value == null ? null : String(value), at, by };
    if (field === "cost") set.costCents = value == null ? null : Number(value);
    else (set as Record<string, unknown>)[field] = value;
  }
  await db.update(registerRows).set({ ...set, edits }).where(eq(registerRows.id, rowId));
}

async function moveToRegister(ctx: Ctx, results: ResultView[]) {
  for (const r of results) {
    if (!r.classes.includes("misplaced")) {
      skip(ctx, r, "Not misplaced.");
      continue;
    }
    if (!r.asset?.exists || !r.registerLocation) {
      skip(ctx, r, r.asset?.exists ? "The register location is not mapped to a location here." : "The item no longer exists.");
      continue;
    }
    const to = r.registerLocation.id;
    const from = r.asset.location?.id ?? null;
    if (from === to) {
      done(ctx, r, "Already there.");
      continue;
    }
    if (r.asset.unitId) {
      await db.update(itemUnits).set({ locationId: to, updatedAt: new Date() }).where(eq(itemUnits.id, r.asset.unitId));
    } else {
      await db.update(items).set({ locationId: to, updatedAt: new Date() }).where(eq(items.id, r.asset.itemId));
    }
    event(ctx, r.asset.itemId, "moved", { from, to, unitId: r.asset.unitId ?? undefined, reason: "register location" });
    done(ctx, r, `Moved to ${r.registerLocation.path ?? "the register location"}.`);
  }
}

async function acceptBindexLocation(ctx: Ctx, results: ResultView[]) {
  for (const r of results) {
    if (!r.classes.includes("misplaced") || !r.row || !r.asset?.exists) {
      skip(ctx, r, "Not a misplaced register row.");
      continue;
    }
    const path = r.asset.location?.path ?? null;
    await recordRegisterEdit(r.row.id, { locationText: path }, ctx.userOid);
    event(ctx, r.asset.itemId, "updated", {
      acceptedLocation: r.asset.location?.id ?? null,
      registerLocation: r.row.locationText,
      unitId: r.asset.unitId ?? undefined,
    });
    done(ctx, r, `Kept the location here${path ? ` (${path})` : ""}; register copy updated.`);
  }
}

async function copyFields(ctx: Ctx, results: ResultView[], direction: "to_bindex" | "to_register", fields: CopyField[]) {
  if (!fields.length) throw badRequest("Choose at least one field to copy.");
  const assets = await loadAssets(
    [...new Set(results.flatMap((r) => (r.asset?.exists ? [r.asset.itemId] : [])))],
    [...new Set(results.flatMap((r) => (r.asset?.unitId ? [r.asset.unitId] : [])))],
  );
  for (const r of results) {
    if (!r.row || !r.asset?.exists) {
      skip(ctx, r, "Needs both a register row and an item.");
      continue;
    }
    const item = assets.items.get(r.asset.itemId)!;
    const unit = r.asset.unitId ? assets.units.get(r.asset.unitId) : undefined;
    const copied: string[] = [];
    const problems: string[] = [];

    if (direction === "to_bindex") {
      const row = r.row;
      const itemPatch: Partial<typeof items.$inferInsert> = {};
      for (const f of fields) {
        if (f === "name" && row.name) itemPatch.name = row.name;
        else if (f === "model" && row.model) itemPatch.model = row.model;
        else if (f === "cost" && row.costCents != null) {
          if (unit) {
            await updateUnit(unit.id, { valueCents: row.costCents });
            copied.push(f);
          } else itemPatch.valueCents = row.costCents;
        } else if (f === "serial" && row.serial) {
          if (unit) {
            try {
              await updateUnit(unit.id, { serial: row.serial });
              copied.push(f);
            } catch (err) {
              problems.push(err instanceof Error ? err.message : String(err));
            }
          } else {
            const why = await setIdentifier(assets, item.id, "serial", row.serial);
            if (why) problems.push(why);
            else copied.push(f);
          }
        } else if (f === "assetTag" && row.assetTag) {
          const why = await setIdentifier(assets, item.id, "asset_tag", row.assetTag);
          if (why) problems.push(why);
          else copied.push(f);
        } else if (f === "epc" && row.epc) {
          const why = await setIdentifier(assets, item.id, "rfid", row.epc);
          if (why) problems.push(why);
          else copied.push(f);
        }
      }
      const patched = Object.keys(itemPatch);
      if (patched.length) {
        await db.update(items).set({ ...itemPatch, updatedAt: new Date() }).where(eq(items.id, item.id));
        copied.push(...fields.filter((f) => (f === "cost" ? "valueCents" : f) in itemPatch));
      }
      if (copied.length) {
        event(ctx, item.id, "updated", { direction, fields: copied, row: row.rowNumber, unitId: unit?.id });
      }
    } else {
      const changes: Partial<Record<CopyField, string | number | null>> = {};
      const first = (type: IdentifierType) => assets.identifiers(item.id, type)[0]?.value ?? null;
      for (const f of fields) {
        if (f === "name") changes.name = item.name;
        else if (f === "model") changes.model = item.model;
        else if (f === "cost") changes.cost = unit ? unit.valueCents : item.valueCents;
        else if (f === "serial") changes.serial = unit ? unit.serial : first("serial");
        else if (f === "assetTag") changes.assetTag = first("asset_tag");
        else if (f === "epc") changes.epc = first("rfid");
      }
      await recordRegisterEdit(r.row.id, changes, ctx.userOid);
      copied.push(...Object.keys(changes));
      event(ctx, item.id, "updated", { direction, fields: copied, row: r.row.rowNumber, unitId: unit?.id });
    }

    if (!copied.length) {
      skip(ctx, r, problems[0] ?? "Nothing to copy: the chosen fields are empty on that side.");
      continue;
    }
    const where = direction === "to_bindex" ? "here" : "into the register copy";
    done(ctx, r, `Copied ${copied.join(", ")} ${where}.${problems.length ? ` Not copied: ${problems.join(" ")}` : ""}`);
  }
}

async function setMissing(ctx: Ctx, results: ResultView[], missing: boolean) {
  for (const r of results) {
    const wanted = missing ? "bindex_only" : "flagged_missing";
    if (!r.classes.includes(wanted) || !r.asset?.exists) {
      skip(ctx, r, missing ? "Only records missing from the register can be flagged." : "Not flagged missing.");
      continue;
    }
    if (r.asset.unitId) {
      await db
        .update(itemUnits)
        .set({ status: missing ? "missing" : "active", updatedAt: new Date() })
        .where(and(eq(itemUnits.id, r.asset.unitId), missing ? sql`true` : eq(itemUnits.status, "missing")));
    }
    if (!r.asset.unitId || !missing) {
      await db.update(items).set({ flaggedMissing: missing, updatedAt: new Date() }).where(eq(items.id, r.asset.itemId));
    }
    event(ctx, r.asset.itemId, "updated", { flaggedMissing: missing, unitId: r.asset.unitId ?? undefined });
    done(ctx, r, missing ? "Flagged missing." : "Missing flag cleared.");
  }
}

async function linkProposal(ctx: Ctx, results: ResultView[]) {
  const proposalIds = [...new Set(results.flatMap((r) => (r.proposal ? [r.proposal.itemId] : [])))];
  const found = proposalIds.length
    ? await db.select({ id: items.id, assetCode: items.assetCode }).from(items).where(inArray(items.id, proposalIds))
    : [];
  const codes = new Map(found.map((f) => [f.id, f.assetCode]));
  const assets = await loadAssets(found.map((f) => f.id));
  for (const r of results) {
    const code = r.proposal ? codes.get(r.proposal.itemId) : undefined;
    if (!r.row || !r.proposal || !code) {
      skip(ctx, r, r.proposal ? "The proposed item no longer exists." : "No proposed match to link.");
      continue;
    }
    const added: string[] = [];
    const problems: string[] = [];
    for (const [type, value] of [
      ["asset_tag", r.row.assetTag],
      ["serial", r.row.serial],
      ["rfid", r.row.epc],
    ] as [IdentifierType, string | null][]) {
      if (!value) continue;
      const why = await setIdentifier(assets, r.proposal.itemId, type, value);
      if (why) problems.push(why);
      else added.push(type);
    }
    // The printed code in the register copy makes the next run match exactly,
    // even for a row with no keys of its own.
    await recordRegisterEdit(r.row.id, { bindexCode: code }, ctx.userOid);
    event(ctx, r.proposal.itemId, "updated", {
      linked: true,
      row: r.row.rowNumber,
      score: r.proposal.score,
      identifiersAdded: added,
    });
    done(ctx, r, `Linked to ${code}.${problems.length ? ` Not added: ${problems.join(" ")}` : ""}`);
  }
}

async function createItems(ctx: Ctx, results: ResultView[], companyId: string | null, defaultLocationId: string | null): Promise<ActionOutcome["created"]> {
  const eligible = results.filter((r) => {
    if (!r.classes.includes("register_only") || !r.row) {
      skip(ctx, r, "Only rows missing from the inventory can be created.");
      return false;
    }
    return true;
  });
  const plan = await planForImport(ctx.importId, {
    companyId,
    defaultLocationId,
    rowIds: eligible.map((r) => r.row!.id),
  });
  const byRow = new Map(eligible.map((r) => [r.row!.id, r]));
  for (const s of plan.skip) skip(ctx, byRow.get(s.rowId)!, s.reason);
  const created = await executePlan(plan, ctx.userOid, { importId: ctx.importId, runId: ctx.runId });
  for (const c of created) done(ctx, byRow.get(c.rowId)!, `Created ${c.assetCode}.`);
  return created;
}

export async function runAction(runId: string, input: ActionInput, user: { oid: string | null; name: string }): Promise<ActionOutcome> {
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, runId)).limit(1);
  if (!run) throw notFound("Reconciliation run not found");
  const ids = [...new Set(input.resultIds)];
  if (!ids.length) throw badRequest("Select at least one result.");
  const { results } = await listResults(runId, { ids, status: "all", limit: ids.length });
  const ctx: Ctx = {
    runId,
    importId: run.importId,
    userOid: user.oid,
    events: [],
    resolved: [],
    skipped: [],
  };
  const known = new Set(results.map((r) => r.id));
  for (const id of ids) if (!known.has(id)) ctx.skipped.push({ resultId: id, reason: "Not a result of this run." });

  // A handled result is only acted on again after it is reopened.
  const open = input.action === "reopen" ? results : results.filter((r) => {
    if (r.resolution) skip(ctx, r, r.resolution === "ignored" ? "Ignored; reopen it first." : "Already resolved; reopen it first.");
    return !r.resolution;
  });

  let created: ActionOutcome["created"];
  switch (input.action) {
    case "create_items":
      created = await createItems(ctx, open, input.companyId ?? null, input.defaultLocationId ?? null);
      break;
    case "move_to_register":
      await moveToRegister(ctx, open);
      break;
    case "accept_bindex_location":
      await acceptBindexLocation(ctx, open);
      break;
    case "copy_fields":
      await copyFields(ctx, open, input.direction, input.fields);
      break;
    case "flag_missing":
      await setMissing(ctx, open, true);
      break;
    case "clear_missing":
      await setMissing(ctx, open, false);
      break;
    case "link_proposal":
      await linkProposal(ctx, open);
      break;
    case "ignore": {
      const reason = input.reason.trim();
      if (!reason) throw badRequest("Say why these are being ignored.");
      for (const r of open) {
        if (r.asset?.exists) {
          event(ctx, r.asset.itemId, "updated", { ignored: true, reason, classes: r.classes, unitId: r.asset.unitId ?? undefined });
        }
        done(ctx, r, reason, "ignored");
      }
      const rowOnly = open.filter((r) => !r.asset?.exists).length;
      if (rowOnly) event(ctx, null, "updated", { ignored: true, reason, registerRows: rowOnly });
      break;
    }
    case "reopen": {
      for (const r of open) {
        if (!r.resolution) {
          skip(ctx, r, "Already open.");
          continue;
        }
        if (r.asset?.exists) {
          event(ctx, r.asset.itemId, "updated", { reopened: true, was: r.resolution, unitId: r.asset.unitId ?? undefined });
        }
        done(ctx, r, "", null);
      }
      break;
    }
  }

  const now = new Date();
  if (ctx.resolved.length) {
    await db.execute(sql`
      UPDATE reconciliation_results res SET
        resolution = x.resolution,
        resolution_note = nullif(x.note, ''),
        resolved_by = CASE WHEN x.resolution IS NULL THEN NULL ELSE ${user.name} END,
        resolved_at = CASE WHEN x.resolution IS NULL THEN NULL ELSE ${now}::timestamptz END
      FROM jsonb_to_recordset(${JSON.stringify(ctx.resolved)}::jsonb) AS x(id uuid, resolution text, note text)
      WHERE res.id = x.id AND res.run_id = ${runId}`);
  }
  for (let i = 0; i < ctx.events.length; i += 1000) {
    await db.insert(itemEvents).values(ctx.events.slice(i, i + 1000));
  }
  publishItemEventsLater(
    ctx.events.map((e) => ({
      itemId: e.itemId ?? null,
      userOid: e.userOid ?? null,
      action: e.action,
      detail: (e.detail ?? {}) as Record<string, unknown>,
    })),
  );
  logger.info("register.action", {
    runId,
    action: input.action,
    done: ctx.resolved.length,
    skipped: ctx.skipped.length,
    by: user.oid,
  });
  return { action: input.action, done: ctx.resolved.length, skipped: ctx.skipped, ...(created ? { created } : {}) };
}
