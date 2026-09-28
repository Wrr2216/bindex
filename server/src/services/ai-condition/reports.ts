import type { PoolClient } from "pg";
import { pool } from "../../db/client";
import type { ConditionRating, ConditionStage, Defect } from "../../db/tables/ai-condition";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid, publish } from "../event-backbone";
import "./events";
import { assertPhotosOf, photoRefs, type PhotoRef } from "./photos";
import { RATINGS, STAGES, cleanText, normalizeDefects } from "./vocab";

/**
 * Condition reports: one observation of an item's (or a unit's) condition,
 * with its photos, defects and the handling note crews see. A person always
 * confirms a report; AI only ever fills a draft (see vision.ts).
 */

export type ConditionReport = {
  id: string;
  itemId: string;
  itemName: string;
  itemAssetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  stage: ConditionStage;
  stageLabel: string | null;
  rating: ConditionRating | null;
  notes: string | null;
  aiNotes: string | null;
  defects: Defect[];
  handlingNote: string | null;
  attachmentIds: string[];
  /** The attachments that still exist, in the order recorded. */
  photos: PhotoRef[];
  aiAssisted: boolean;
  sweepId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReportInput = {
  itemId: string;
  unitId?: string | null;
  stage: ConditionStage;
  stageLabel?: string | null;
  rating?: ConditionRating | null;
  notes?: string | null;
  aiNotes?: string | null;
  defects?: unknown[];
  handlingNote?: string | null;
  attachmentIds?: string[];
  aiAssisted?: boolean;
  sweepId?: string | null;
};

export type ReportPatch = Partial<Omit<ReportInput, "itemId" | "sweepId">>;

const SELECT = `
  SELECT r.id, r.item_id, i.name AS item_name, i.asset_code AS item_asset_code, r.unit_id,
         COALESCE(NULLIF(u.label, ''), u.serial, u.asset_code) AS unit_label,
         r.stage, r.stage_label, r.rating, r.notes, r.ai_notes, r.defects, r.handling_note,
         r.attachment_ids, r.ai_assisted, r.sweep_id, r.created_by, us.name AS created_by_name,
         r.created_at, r.updated_at
    FROM condition_reports r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN item_units u ON u.id = r.unit_id
    LEFT JOIN users us ON us.oid = r.created_by`;

type Row = {
  id: string;
  item_id: string;
  item_name: string;
  item_asset_code: string;
  unit_id: string | null;
  unit_label: string | null;
  stage: ConditionStage;
  stage_label: string | null;
  rating: ConditionRating | null;
  notes: string | null;
  ai_notes: string | null;
  defects: unknown;
  handling_note: string | null;
  attachment_ids: string[];
  ai_assisted: boolean;
  sweep_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
};

async function present(rows: Row[]): Promise<ConditionReport[]> {
  const photos = await photoRefs(rows.flatMap((r) => r.attachment_ids ?? []));
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    itemAssetCode: r.item_asset_code,
    unitId: r.unit_id,
    unitLabel: r.unit_label,
    stage: r.stage,
    stageLabel: r.stage_label,
    rating: r.rating,
    notes: r.notes,
    aiNotes: r.ai_notes,
    // Stored rows were normalized on the way in; this only guards against a
    // hand-edited row breaking the screen.
    defects: normalizeDefects(r.defects),
    handlingNote: r.handling_note,
    attachmentIds: r.attachment_ids ?? [],
    photos: (r.attachment_ids ?? []).map((id) => photos.get(id)).filter((p): p is PhotoRef => Boolean(p)),
    aiAssisted: r.ai_assisted,
    sweepId: r.sweep_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function getReport(id: string): Promise<ConditionReport | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<Row>(`${SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? (await present(rows))[0]! : null;
}

export type ListReportsOptions = {
  itemId?: string;
  unitId?: string;
  sweepId?: string;
  limit?: number;
  /** Paging: reports created before this one. */
  before?: string;
};

/** Newest first. Without a filter, the most recent reports across everything. */
export async function listReports(opts: ListReportsOptions = {}): Promise<{ reports: ConditionReport[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conds.push(sql.replace("?", `$${params.length}`));
  };
  if (opts.itemId) add("r.item_id = ?", opts.itemId);
  if (opts.unitId) add("r.unit_id = ?", opts.unitId);
  if (opts.sweepId) add("r.sweep_id = ?", opts.sweepId);
  if (opts.before) {
    params.push(opts.before);
    const p = `$${params.length}`;
    conds.push(`(r.created_at, r.id) < (SELECT created_at, id FROM condition_reports WHERE id = ${p})`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query<Row>(
    `${SELECT} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
      ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > limit;
  const page = await present(rows.slice(0, limit));
  return { reports: page, nextBefore: more ? page[page.length - 1]!.id : null };
}

function cleanStage(stage: ConditionStage, label: string | null | undefined): { stage: ConditionStage; stageLabel: string | null } {
  if (!STAGES.includes(stage)) throw badRequest(`stage must be one of ${STAGES.join(", ")}.`);
  const stageLabel = cleanText(label, 40);
  if (stage === "custom" && !stageLabel) throw badRequest("Name the custom stage, such as \"return\" or \"pre-sale\".");
  return { stage, stageLabel: stage === "custom" ? stageLabel : null };
}

function cleanRating(rating: ConditionRating | null | undefined): ConditionRating | null {
  if (rating == null) return null;
  if (!RATINGS.includes(rating)) throw badRequest(`rating must be one of ${RATINGS.join(", ")}.`);
  return rating;
}

const note = (v: string | null | undefined, max: number) => {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) throw badRequest(`Keep notes under ${max} characters.`);
  return s;
};

type Db = Pick<PoolClient, "query">;

/** Throws unless the unit belongs to the item. */
async function assertUnitOf(db: Db, itemId: string, unitId: string): Promise<void> {
  const { rows } = await db.query<{ item_id: string }>("SELECT item_id FROM item_units WHERE id = $1", [unitId]);
  if (!rows[0]) throw notFound("That unit no longer exists.");
  if (rows[0].item_id !== itemId) throw badRequest("That unit belongs to a different item.");
}

/**
 * Insert a report inside a caller's transaction, without publishing. For
 * features that write reports as part of something larger (container capture);
 * they publish after their commit with publishReportCreated.
 */
export async function insertReport(db: Db, input: ReportInput, userOid: string | null): Promise<string> {
  const { stage, stageLabel } = cleanStage(input.stage, input.stageLabel);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO condition_reports
       (item_id, unit_id, stage, stage_label, rating, notes, ai_notes, defects, handling_note,
        attachment_ids, ai_assisted, sweep_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.itemId,
      input.unitId ?? null,
      stage,
      stageLabel,
      cleanRating(input.rating),
      note(input.notes, 4000),
      note(input.aiNotes, 4000),
      JSON.stringify(normalizeDefects(input.defects ?? [])),
      note(input.handlingNote, 300),
      input.attachmentIds ?? [],
      Boolean(input.aiAssisted),
      input.sweepId ?? null,
      userOid,
    ],
  );
  return rows[0]!.id;
}

export async function publishReportCreated(report: ConditionReport, userOid: string | null): Promise<void> {
  await publish(
    "condition_report.created",
    {
      reportId: report.id,
      itemId: report.itemId,
      itemName: report.itemName,
      unitId: report.unitId,
      stage: report.stageLabel ?? report.stage,
      rating: report.rating,
      defects: report.defects.length,
      handlingNote: report.handlingNote,
      photos: report.attachmentIds.length,
      aiAssisted: report.aiAssisted,
      sweepId: report.sweepId,
    },
    { actor: actorFromOid(userOid), subject: { type: "condition_report", id: report.id } },
  );
}

export async function createReport(input: ReportInput, userOid: string | null): Promise<ConditionReport> {
  const { rows: item } = await pool.query<{ id: string }>("SELECT id FROM items WHERE id = $1", [input.itemId]);
  if (!item[0]) throw notFound("That item no longer exists.");
  if (input.unitId) await assertUnitOf(pool, input.itemId, input.unitId);
  const attachmentIds = await assertPhotosOf(input.itemId, input.attachmentIds ?? []);

  let stage = input.stage;
  if (input.sweepId) {
    const { rows } = await pool.query<{ status: string; stage: ConditionStage }>(
      "SELECT status, stage FROM condition_sweeps WHERE id = $1",
      [input.sweepId],
    );
    if (!rows[0]) throw notFound("That condition sweep no longer exists.");
    if (rows[0].status !== "open") throw badRequest("That condition sweep is closed. Start a new one to keep recording.");
    // Every report in a sweep is at the sweep's stage, so its progress counts one thing.
    stage = rows[0].stage;
  }

  const id = await insertReport(pool, { ...input, stage, attachmentIds }, userOid);
  const report = (await getReport(id))!;
  logger.info("ai_condition.report.created", { id, itemId: report.itemId, rating: report.rating, aiAssisted: report.aiAssisted });
  await publishReportCreated(report, userOid);
  return report;
}

const PATCHABLE = ["stage", "stageLabel", "rating", "notes", "aiNotes", "defects", "handlingNote", "attachmentIds", "aiAssisted"] as const;

/**
 * Correct a report. Any signed-in person may, as with items; the event lists
 * each changed field before and after, so the audit log keeps what it said.
 */
export async function updateReport(id: string, patch: ReportPatch, userOid: string | null): Promise<ConditionReport> {
  const current = await getReport(id);
  if (!current) throw notFound("Condition report not found. It may have been deleted.");
  if (patch.unitId !== undefined && patch.unitId !== current.unitId) {
    if (patch.unitId) await assertUnitOf(pool, current.itemId, patch.unitId);
  }

  const stage = cleanStage(patch.stage ?? current.stage, patch.stageLabel !== undefined ? patch.stageLabel : current.stageLabel);
  if (current.sweepId && stage.stage !== current.stage) {
    throw badRequest("A report made during a sweep keeps the sweep's stage.");
  }
  const next = {
    unitId: patch.unitId !== undefined ? patch.unitId : current.unitId,
    stage: stage.stage,
    stageLabel: stage.stageLabel,
    rating: patch.rating !== undefined ? cleanRating(patch.rating) : current.rating,
    notes: patch.notes !== undefined ? note(patch.notes, 4000) : current.notes,
    aiNotes: patch.aiNotes !== undefined ? note(patch.aiNotes, 4000) : current.aiNotes,
    defects: patch.defects !== undefined ? normalizeDefects(patch.defects) : current.defects,
    handlingNote: patch.handlingNote !== undefined ? note(patch.handlingNote, 300) : current.handlingNote,
    attachmentIds:
      patch.attachmentIds !== undefined ? await assertPhotosOf(current.itemId, patch.attachmentIds) : current.attachmentIds,
    aiAssisted: patch.aiAssisted !== undefined ? Boolean(patch.aiAssisted) : current.aiAssisted,
  };

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of [...PATCHABLE, "unitId"] as const) {
    const from = current[key];
    const to = next[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  if (!Object.keys(changes).length) return current;

  await pool.query(
    `UPDATE condition_reports
        SET unit_id = $2, stage = $3, stage_label = $4, rating = $5, notes = $6, ai_notes = $7, defects = $8,
            handling_note = $9, attachment_ids = $10, ai_assisted = $11, updated_at = now()
      WHERE id = $1`,
    [
      id,
      next.unitId,
      next.stage,
      next.stageLabel,
      next.rating,
      next.notes,
      next.aiNotes,
      JSON.stringify(next.defects),
      next.handlingNote,
      next.attachmentIds,
      next.aiAssisted,
    ],
  );
  const report = (await getReport(id))!;
  await publish(
    "condition_report.updated",
    { reportId: id, itemId: report.itemId, changed: Object.keys(changes), changes },
    { actor: actorFromOid(userOid), subject: { type: "condition_report", id } },
  );
  return report;
}

/**
 * Remove a report. Reports are evidence (claims read them), so only the
 * person who recorded one, or an administrator, may delete it. Its photos
 * stay with the item.
 */
export async function deleteReport(id: string, user: { oid: string; role: string }): Promise<void> {
  const current = await getReport(id);
  if (!current) throw notFound("Condition report not found. It may have been deleted.");
  if (user.role !== "admin" && current.createdBy !== user.oid) {
    throw forbidden("Only the person who recorded this report, or an administrator, can delete it.");
  }
  await pool.query("DELETE FROM condition_reports WHERE id = $1", [id]);
  logger.info("ai_condition.report.deleted", { id, itemId: current.itemId });
  await publish(
    "condition_report.deleted",
    {
      reportId: id,
      itemId: current.itemId,
      itemName: current.itemName,
      unitId: current.unitId,
      stage: current.stageLabel ?? current.stage,
      rating: current.rating,
      createdAt: current.createdAt,
    },
    { actor: actorFromOid(user.oid), subject: { type: "condition_report", id } },
  );
}

/** The latest report of an item (or unit), for pre-filling the next one. */
export async function latestReport(itemId: string, unitId?: string | null): Promise<ConditionReport | null> {
  const { rows } = await pool.query<Row>(
    `${SELECT} WHERE r.item_id = $1 AND ${unitId ? "r.unit_id = $2" : "r.unit_id IS NULL"}
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    unitId ? [itemId, unitId] : [itemId],
  );
  return rows[0] ? (await present(rows))[0]! : null;
}
