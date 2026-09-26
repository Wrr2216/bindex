import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  items,
  itemUnits,
  teardownGuides,
  teardownParts,
  teardownSteps,
  type TeardownGuideRow,
  type TeardownJobStatus,
  type TeardownPartKind,
  type TeardownPartRow,
  type TeardownSource,
  type TeardownStepRow,
} from "../../db/schema";
import { badRequest, conflict, notFound } from "../../lib/errors";
import {
  deleteAttachment,
  deleteAttachmentsForOwner,
  getAttachment,
  listAttachments,
  type Attachment,
} from "../media-ai-core";
import { LIMITS, clip, normalizeKind, type Draft } from "./extract";

/**
 * Teardown guides, their steps and their parts: reading, writing and applying
 * what the processing job read from the narration. The job itself is in
 * pipeline.ts and worker.ts.
 */

/** Attachments of a guide (its step pictures) are owned by this type. */
export const GUIDE_OWNER = "teardown_guide";
export const KEYFRAME_STAGE = "keyframe";

export type JobNote = { code: string; message: string };

export type ItemRef = {
  id: string;
  name: string;
  assetCode: string;
  brand: string | null;
  model: string | null;
  category: string | null;
};
export type UnitRef = { id: string; assetCode: string; label: string | null; serial: string | null };

export type StepView = {
  id: string;
  n: number;
  title: string;
  instruction: string;
  start: number | null;
  end: number | null;
  callout: string | null;
  source: TeardownSource;
  keyframe: { id: string; url: string; thumbUrl: string | null } | null;
  updatedAt: Date;
};

export type PartView = {
  id: string;
  stepId: string | null;
  stepN: number | null;
  name: string;
  kind: TeardownPartKind;
  qty: number;
  note: string | null;
  source: TeardownSource;
  heardAs: string | null;
  edited: boolean;
  reassembledAt: Date | null;
  reassembledBy: string | null;
};

export type GuideJob = {
  status: TeardownJobStatus;
  stage: string | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  notes: JobNote[];
  attempts: number;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type DraftView =
  | { complete: true; steps: Draft["steps"]; parts: Draft["parts"] }
  | { complete: false; windowsDone: number; windowsTotal: number };

export type TranscriptView = {
  text: string;
  segments: { start: number; end: number; text: string }[];
  language: string | null;
  complete: boolean;
};

export type GuideView = {
  id: string;
  title: string;
  notes: string | null;
  itemId: string;
  unitId: string | null;
  item: ItemRef | null;
  unit: UnitRef | null;
  video: Attachment | null;
  durationSec: number | null;
  transcript: TranscriptView | null;
  draft: DraftView | null;
  job: GuideJob;
  steps: StepView[];
  parts: PartView[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GuideSummary = {
  id: string;
  title: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  itemAssetCode: string;
  unitName: string | null;
  videoAttachmentId: string | null;
  stepCount: number;
  partCount: number;
  partsReassembled: number;
  draftPending: boolean;
  job: { status: TeardownJobStatus; stage: string | null };
  createdAt: Date;
  updatedAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);

const GUIDE_GONE = "That teardown guide does not exist. It may have been deleted.";

// ---- Reading ------------------------------------------------------------------------

export async function getGuideRow(id: string): Promise<TeardownGuideRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(teardownGuides).where(eq(teardownGuides.id, id)).limit(1);
  return row ?? null;
}

async function requireGuideRow(id: string): Promise<TeardownGuideRow> {
  const row = await getGuideRow(id);
  if (!row) throw notFound(GUIDE_GONE);
  return row;
}

export async function getItemRef(itemId: string): Promise<ItemRef | null> {
  const [row] = await db
    .select({
      id: items.id,
      name: items.name,
      assetCode: items.assetCode,
      brand: items.brand,
      model: items.model,
      category: items.category,
    })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  return row ?? null;
}

export async function getUnitRef(unitId: string | null): Promise<(UnitRef & { itemId: string }) | null> {
  if (!unitId) return null;
  const [row] = await db
    .select({
      id: itemUnits.id,
      itemId: itemUnits.itemId,
      assetCode: itemUnits.assetCode,
      label: itemUnits.label,
      serial: itemUnits.serial,
    })
    .from(itemUnits)
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  return row ?? null;
}

export const unitName = (u: Pick<UnitRef, "label" | "serial" | "assetCode">): string =>
  u.label?.trim() || u.serial?.trim() || u.assetCode;

/** "Dell PowerEdge R740", for prompts. */
export function equipmentLine(item: ItemRef | null, unit: UnitRef | null): string | null {
  if (!item) return null;
  const makeModel = [item.brand, item.model].filter(Boolean).join(" ");
  const base = makeModel && !item.name.includes(makeModel) ? `${item.name} (${makeModel})` : item.name;
  return unit ? `${base}, unit ${unitName(unit)}` : base;
}

export async function listStepRows(guideId: string): Promise<TeardownStepRow[]> {
  return db
    .select()
    .from(teardownSteps)
    .where(eq(teardownSteps.guideId, guideId))
    .orderBy(asc(teardownSteps.position), asc(teardownSteps.createdAt), asc(teardownSteps.id));
}

export async function listPartRows(guideId: string): Promise<TeardownPartRow[]> {
  return db
    .select()
    .from(teardownParts)
    .where(eq(teardownParts.guideId, guideId))
    .orderBy(asc(teardownParts.position), asc(teardownParts.createdAt), asc(teardownParts.id));
}

function jobOf(row: TeardownGuideRow): GuideJob {
  const p = row.jobProgress as { done?: unknown; total?: unknown } | null;
  return {
    status: row.jobStatus,
    stage: row.jobStage,
    progress:
      p && typeof p.done === "number" && typeof p.total === "number" ? { done: p.done, total: p.total } : null,
    error: row.jobError,
    notes: Array.isArray(row.jobNotes) ? row.jobNotes : [],
    attempts: row.jobAttempts,
    queuedAt: row.jobQueuedAt,
    startedAt: row.jobStartedAt,
    finishedAt: row.jobFinishedAt,
  };
}

function draftOf(raw: Record<string, unknown> | null): DraftView | null {
  if (!raw) return null;
  if (raw.complete === true) {
    return {
      complete: true,
      steps: Array.isArray(raw.steps) ? (raw.steps as Draft["steps"]) : [],
      parts: Array.isArray(raw.parts) ? (raw.parts as Draft["parts"]) : [],
    };
  }
  return {
    complete: false,
    windowsDone: typeof raw.windowsDone === "number" ? raw.windowsDone : 0,
    windowsTotal: typeof raw.windowsTotal === "number" ? raw.windowsTotal : 0,
  };
}

function transcriptOf(raw: Record<string, unknown> | null): TranscriptView | null {
  if (!raw) return null;
  return {
    text: typeof raw.text === "string" ? raw.text : "",
    segments: Array.isArray(raw.segments) ? (raw.segments as TranscriptView["segments"]) : [],
    language: typeof raw.language === "string" ? raw.language : null,
    complete: raw.complete === true,
  };
}

/** Steps numbered in order, with their pictures, and parts tied to those numbers. */
export function presentSteps(
  steps: TeardownStepRow[],
  parts: TeardownPartRow[],
  keyframes: Map<string, Attachment>,
): { steps: StepView[]; parts: PartView[] } {
  const numberOf = new Map<string, number>();
  const stepViews = steps.map((s, i) => {
    numberOf.set(s.id, i + 1);
    const kf = s.keyframeAttachmentId ? keyframes.get(s.keyframeAttachmentId) : undefined;
    return {
      id: s.id,
      n: i + 1,
      title: s.title,
      instruction: s.instruction,
      start: s.startSec,
      end: s.endSec,
      callout: s.callout,
      source: s.source,
      keyframe: kf ? { id: kf.id, url: kf.url, thumbUrl: kf.thumbUrl } : null,
      updatedAt: s.updatedAt,
    };
  });
  const partViews = parts
    .map((p) => ({
      id: p.id,
      stepId: p.stepId,
      stepN: p.stepId ? (numberOf.get(p.stepId) ?? null) : null,
      name: p.name,
      kind: p.kind,
      qty: p.qty,
      note: p.note,
      source: p.source,
      heardAs: p.heardAs,
      edited: p.edited,
      reassembledAt: p.reassembledAt,
      reassembledBy: p.reassembledBy,
    }))
    // In the order they came off; parts with no step go last.
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.stepN ?? Infinity) - (b.p.stepN ?? Infinity) || a.i - b.i)
    .map(({ p }) => p);
  return { steps: stepViews, parts: partViews };
}

export async function guideKeyframes(guideId: string): Promise<Map<string, Attachment>> {
  const list = await listAttachments(GUIDE_OWNER, guideId, { kind: "photo" });
  return new Map(list.map((a) => [a.id, a]));
}

export async function getGuide(id: string): Promise<GuideView> {
  const row = await requireGuideRow(id);
  const [item, unit, steps, parts, keyframes, video] = await Promise.all([
    getItemRef(row.itemId),
    getUnitRef(row.unitId),
    listStepRows(row.id),
    listPartRows(row.id),
    guideKeyframes(row.id),
    row.videoAttachmentId ? getAttachment(row.videoAttachmentId) : Promise.resolve(null),
  ]);
  const presented = presentSteps(steps, parts, keyframes);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    itemId: row.itemId,
    unitId: row.unitId,
    item,
    unit: unit ? { id: unit.id, assetCode: unit.assetCode, label: unit.label, serial: unit.serial } : null,
    video,
    durationSec: row.durationSec ?? (video?.durationMs ? video.durationMs / 1000 : null),
    transcript: transcriptOf(row.transcript),
    draft: draftOf(row.draft),
    job: jobOf(row),
    steps: presented.steps,
    parts: presented.parts,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type SummaryRow = {
  id: string;
  title: string;
  item_id: string;
  unit_id: string | null;
  item_name: string;
  item_asset_code: string;
  unit_label: string | null;
  unit_serial: string | null;
  unit_asset_code: string | null;
  video_attachment_id: string | null;
  step_count: number;
  part_count: number;
  parts_reassembled: number;
  draft_pending: boolean;
  job_status: TeardownJobStatus;
  job_stage: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Guides of one item (its units' included), or the most recently changed across the instance. */
export async function listGuides(opts: { itemId?: string; q?: string; limit?: number } = {}): Promise<GuideSummary[]> {
  if (opts.itemId && !isUuid(opts.itemId)) return [];
  const q = opts.q?.trim();
  const { rows } = await pool.query<SummaryRow>(
    `SELECT g.id, g.title, g.item_id, g.unit_id, g.video_attachment_id, g.job_status, g.job_stage,
            g.created_at, g.updated_at,
            i.name AS item_name, i.asset_code AS item_asset_code,
            u.label AS unit_label, u.serial AS unit_serial, u.asset_code AS unit_asset_code,
            (SELECT count(*) FROM teardown_steps s WHERE s.guide_id = g.id)::int AS step_count,
            (SELECT count(*) FROM teardown_parts p WHERE p.guide_id = g.id)::int AS part_count,
            (SELECT count(*) FROM teardown_parts p WHERE p.guide_id = g.id AND p.reassembled_at IS NOT NULL)::int
              AS parts_reassembled,
            COALESCE((g.draft->>'complete')::boolean, false) AS draft_pending
       FROM teardown_guides g
       JOIN items i ON i.id = g.item_id
       LEFT JOIN item_units u ON u.id = g.unit_id
      WHERE ($1::uuid IS NULL OR g.item_id = $1::uuid)
        AND ($2::text IS NULL OR g.title ILIKE $2 OR i.name ILIKE $2 OR i.asset_code ILIKE $2)
      ORDER BY g.updated_at DESC, g.id
      LIMIT $3`,
    [opts.itemId ?? null, q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, Math.min(500, opts.limit ?? 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    itemId: r.item_id,
    unitId: r.unit_id,
    itemName: r.item_name,
    itemAssetCode: r.item_asset_code,
    unitName: r.unit_id && r.unit_asset_code ? unitName({ label: r.unit_label, serial: r.unit_serial, assetCode: r.unit_asset_code }) : null,
    videoAttachmentId: r.video_attachment_id,
    stepCount: r.step_count,
    partCount: r.part_count,
    partsReassembled: r.parts_reassembled,
    draftPending: r.draft_pending,
    job: { status: r.job_status, stage: r.job_stage },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ---- Guides -------------------------------------------------------------------------

const cleanText = (v: string | null | undefined, max: number, what: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) throw badRequest(`Keep the ${what} under ${max} characters.`);
  return s;
};

/**
 * Check a video (or narration audio) may be the guide's: an attachment of the
 * item or one of its units. Returns the unit it belongs to, if any.
 */
async function checkVideo(attachmentId: string, itemId: string, unitId: string | null): Promise<{ unitId: string | null }> {
  const a = await getAttachment(attachmentId);
  if (!a) throw notFound("That video is not attached any more. Upload it again.");
  if (a.kind !== "video" && a.kind !== "audio") {
    throw badRequest("A teardown guide is made from a video, or an audio recording of the narration.");
  }
  if (a.ownerType === "item" && a.ownerId === itemId) return { unitId };
  if (a.ownerType === "unit") {
    const unit = await getUnitRef(a.ownerId);
    if (unit && unit.itemId === itemId && (!unitId || unitId === unit.id)) return { unitId: unit.id };
  }
  throw badRequest("That video belongs to a different record. Attach it to this one first.");
}

export type CreateGuideInput = {
  itemId: string;
  unitId?: string | null;
  title?: string | null;
  notes?: string | null;
  videoAttachmentId?: string | null;
};

export async function createGuide(input: CreateGuideInput, userOid: string | null): Promise<TeardownGuideRow> {
  const item = await getItemRef(input.itemId);
  if (!item) throw notFound("That item does not exist. It may have been deleted.");
  let unitId = input.unitId ?? null;
  if (unitId) {
    const unit = await getUnitRef(unitId);
    if (!unit || unit.itemId !== item.id) throw badRequest("That unit does not belong to this item.");
  }
  if (input.videoAttachmentId) unitId = (await checkVideo(input.videoAttachmentId, item.id, unitId)).unitId;
  const title = cleanText(input.title, 200, "title") ?? `${clip(item.name, 180)} teardown`;
  const [row] = await db
    .insert(teardownGuides)
    .values({
      itemId: item.id,
      unitId,
      title,
      notes: cleanText(input.notes, 4000, "notes"),
      videoAttachmentId: input.videoAttachmentId ?? null,
      createdBy: userOid,
    })
    .returning();
  return row!;
}

export type UpdateGuideInput = { title?: string; notes?: string | null; videoAttachmentId?: string | null };

/** Returns whether the video changed, so the caller can offer to process the new one. */
export async function updateGuide(id: string, patch: UpdateGuideInput): Promise<{ videoChanged: boolean }> {
  const row = await requireGuideRow(id);
  const set: Partial<TeardownGuideRow> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const title = cleanText(patch.title, 200, "title");
    if (!title) throw badRequest("Give the guide a title.");
    set.title = title;
  }
  if (patch.notes !== undefined) set.notes = cleanText(patch.notes, 4000, "notes");
  let videoChanged = false;
  if (patch.videoAttachmentId !== undefined && patch.videoAttachmentId !== row.videoAttachmentId) {
    if (row.jobStatus === "running") throw conflict("This guide's video is being processed. Wait for it to finish, or stop it first.");
    if (patch.videoAttachmentId) {
      set.unitId = (await checkVideo(patch.videoAttachmentId, row.itemId, row.unitId)).unitId;
    }
    set.videoAttachmentId = patch.videoAttachmentId;
    // What was read from the old video does not describe the new one. Steps
    // stay: a person may have written them.
    set.transcript = null;
    set.draft = null;
    set.durationSec = null;
    set.refinedAt = null;
    videoChanged = true;
  }
  await db.update(teardownGuides).set(set).where(eq(teardownGuides.id, id));
  return { videoChanged };
}

export async function deleteGuide(id: string): Promise<TeardownGuideRow> {
  const row = await requireGuideRow(id);
  // Step pictures belong to the guide; the video belongs to the item and stays.
  await deleteAttachmentsForOwner(GUIDE_OWNER, id);
  await db.delete(teardownGuides).where(eq(teardownGuides.id, id));
  return row;
}

const touch = (guideId: string) =>
  db.update(teardownGuides).set({ updatedAt: new Date() }).where(eq(teardownGuides.id, guideId));

/**
 * Remove step pictures that were just unlinked (a replaced picture, a deleted
 * step), when no step points at them any more. Only the ones named: a picture
 * uploaded a moment ago and not yet assigned must not be swept up with them.
 */
export async function pruneKeyframes(guideId: string, unlinked: (string | null | undefined)[]): Promise<void> {
  const candidates = [...new Set(unlinked.filter((v): v is string => !!v))];
  if (!candidates.length) return;
  const used = new Set(
    (await listStepRows(guideId)).map((s) => s.keyframeAttachmentId).filter((v): v is string => !!v),
  );
  for (const id of candidates) {
    if (used.has(id)) continue;
    const a = await getAttachment(id);
    if (a?.ownerType === GUIDE_OWNER && a.ownerId === guideId) await deleteAttachment(id).catch(() => undefined);
  }
}

// ---- Steps --------------------------------------------------------------------------

export type StepInput = {
  title?: string;
  instruction?: string | null;
  start?: number | null;
  end?: number | null;
  callout?: string | null;
  keyframeAttachmentId?: string | null;
};

function checkTimes(start: number | null, end: number | null): void {
  if (start !== null && end !== null && end < start) throw badRequest("A step cannot end before it starts.");
}

async function checkKeyframe(guideId: string, attachmentId: string): Promise<void> {
  const a = await getAttachment(attachmentId);
  if (!a || a.ownerType !== GUIDE_OWNER || a.ownerId !== guideId) {
    throw badRequest("Upload the picture to this guide first (owner type teardown_guide).");
  }
  if (!a.mime.startsWith("image/")) throw badRequest("A step's picture has to be a photo.");
}

async function stepRow(stepId: string): Promise<TeardownStepRow> {
  const [row] = isUuid(stepId)
    ? await db.select().from(teardownSteps).where(eq(teardownSteps.id, stepId)).limit(1)
    : [];
  if (!row) throw notFound("That step does not exist. It may have been deleted.");
  return row;
}

/** Rewrite positions 1..n in the given order. */
async function writeOrder(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(
    `UPDATE teardown_steps s SET position = o.pos
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos)
      WHERE s.id = o.id AND s.position <> o.pos`,
    [ids],
  );
}

/** Add a step after step `afterN` (0 puts it first; omitted, last). */
export async function addStep(guideId: string, input: StepInput & { title: string; afterN?: number }): Promise<string> {
  await requireGuideRow(guideId);
  const title = cleanText(input.title, LIMITS.title, "step title");
  if (!title) throw badRequest("Give the step a title.");
  const start = input.start ?? null;
  const end = input.end ?? null;
  checkTimes(start, end);
  if (input.keyframeAttachmentId) await checkKeyframe(guideId, input.keyframeAttachmentId);
  const ordered = (await listStepRows(guideId)).map((s) => s.id);
  const at = input.afterN === undefined ? ordered.length : Math.max(0, Math.min(ordered.length, input.afterN));
  const id = randomUUID();
  await db.insert(teardownSteps).values({
    id,
    guideId,
    position: at + 1,
    title,
    instruction: cleanText(input.instruction, LIMITS.instruction, "instruction") ?? "",
    startSec: start,
    endSec: end,
    callout: cleanText(input.callout, LIMITS.callout, "callout"),
    keyframeAttachmentId: input.keyframeAttachmentId ?? null,
    source: "manual",
  });
  ordered.splice(at, 0, id);
  await writeOrder(ordered);
  await touch(guideId);
  return guideId;
}

export async function updateStep(stepId: string, patch: StepInput & { n?: number }): Promise<string> {
  const row = await stepRow(stepId);
  const set: Partial<TeardownStepRow> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const title = cleanText(patch.title, LIMITS.title, "step title");
    if (!title) throw badRequest("Give the step a title.");
    set.title = title;
  }
  if (patch.instruction !== undefined) set.instruction = cleanText(patch.instruction, LIMITS.instruction, "instruction") ?? "";
  if (patch.callout !== undefined) set.callout = cleanText(patch.callout, LIMITS.callout, "callout");
  if (patch.start !== undefined) set.startSec = patch.start;
  if (patch.end !== undefined) set.endSec = patch.end;
  checkTimes(set.startSec !== undefined ? set.startSec : row.startSec, set.endSec !== undefined ? set.endSec : row.endSec);
  let pictureChanged = false;
  if (patch.keyframeAttachmentId !== undefined && patch.keyframeAttachmentId !== row.keyframeAttachmentId) {
    if (patch.keyframeAttachmentId) await checkKeyframe(row.guideId, patch.keyframeAttachmentId);
    set.keyframeAttachmentId = patch.keyframeAttachmentId;
    pictureChanged = true;
  }
  await db.update(teardownSteps).set(set).where(eq(teardownSteps.id, stepId));
  if (patch.n !== undefined) {
    const ordered = (await listStepRows(row.guideId)).map((s) => s.id).filter((id) => id !== stepId);
    ordered.splice(Math.max(0, Math.min(ordered.length, patch.n - 1)), 0, stepId);
    await writeOrder(ordered);
  }
  if (pictureChanged) await pruneKeyframes(row.guideId, [row.keyframeAttachmentId]);
  await touch(row.guideId);
  return row.guideId;
}

export async function deleteStep(stepId: string): Promise<string> {
  const row = await stepRow(stepId);
  await db.delete(teardownSteps).where(eq(teardownSteps.id, stepId));
  await writeOrder((await listStepRows(row.guideId)).map((s) => s.id));
  await pruneKeyframes(row.guideId, [row.keyframeAttachmentId]);
  await touch(row.guideId);
  return row.guideId;
}

// ---- Parts --------------------------------------------------------------------------

export type PartInput = {
  name?: string;
  kind?: TeardownPartKind;
  qty?: number;
  stepId?: string | null;
  note?: string | null;
};

async function checkStepOfGuide(guideId: string, stepId: string | null | undefined): Promise<void> {
  if (!stepId) return;
  const step = await stepRow(stepId);
  if (step.guideId !== guideId) throw badRequest("That step belongs to a different guide.");
}

async function partRow(partId: string): Promise<TeardownPartRow> {
  const [row] = isUuid(partId)
    ? await db.select().from(teardownParts).where(eq(teardownParts.id, partId)).limit(1)
    : [];
  if (!row) throw notFound("That part does not exist. It may have been deleted.");
  return row;
}

export async function addPart(guideId: string, input: PartInput & { name: string }): Promise<string> {
  await requireGuideRow(guideId);
  const name = cleanText(input.name, LIMITS.partName, "part name");
  if (!name) throw badRequest("Name the part.");
  await checkStepOfGuide(guideId, input.stepId);
  const { rows } = await pool.query<{ next: number }>(
    `SELECT COALESCE(max(position), 0) + 1 AS next FROM teardown_parts WHERE guide_id = $1`,
    [guideId],
  );
  await db.insert(teardownParts).values({
    guideId,
    stepId: input.stepId ?? null,
    position: rows[0]?.next ?? 1,
    name,
    kind: input.kind ?? normalizeKind(null, name),
    qty: input.qty ?? 1,
    note: cleanText(input.note, 500, "note"),
    source: "manual",
  });
  await touch(guideId);
  return guideId;
}

export async function updatePart(
  partId: string,
  patch: PartInput & { reassembled?: boolean },
  userOid: string | null,
): Promise<{ guideId: string; reassembledChanged: boolean }> {
  const row = await partRow(partId);
  const set: Partial<TeardownPartRow> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, LIMITS.partName, "part name");
    if (!name) throw badRequest("Name the part.");
    set.name = name;
  }
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.qty !== undefined) set.qty = patch.qty;
  if (patch.note !== undefined) set.note = cleanText(patch.note, 500, "note");
  if (patch.stepId !== undefined) {
    await checkStepOfGuide(row.guideId, patch.stepId);
    set.stepId = patch.stepId;
  }
  if (set.name !== undefined || set.kind !== undefined || set.qty !== undefined) set.edited = true;
  let reassembledChanged = false;
  if (patch.reassembled !== undefined && patch.reassembled !== (row.reassembledAt !== null)) {
    set.reassembledAt = patch.reassembled ? new Date() : null;
    set.reassembledBy = patch.reassembled ? userOid : null;
    reassembledChanged = true;
  }
  await db.update(teardownParts).set(set).where(eq(teardownParts.id, partId));
  await touch(row.guideId);
  return { guideId: row.guideId, reassembledChanged };
}

export async function deletePart(partId: string): Promise<string> {
  const row = await partRow(partId);
  await db.delete(teardownParts).where(eq(teardownParts.id, partId));
  await touch(row.guideId);
  return row.guideId;
}

/** Clear every reassembly tick, to start putting it back together again. */
export async function resetReassembly(guideId: string): Promise<void> {
  await requireGuideRow(guideId);
  await db
    .update(teardownParts)
    .set({ reassembledAt: null, reassembledBy: null, updatedAt: new Date() })
    .where(eq(teardownParts.guideId, guideId));
  await touch(guideId);
}

export async function reassemblyProgress(guideId: string): Promise<{ total: number; done: number }> {
  const { rows } = await pool.query<{ total: number; done: number }>(
    `SELECT count(*)::int AS total, count(reassembled_at)::int AS done FROM teardown_parts WHERE guide_id = $1`,
    [guideId],
  );
  return rows[0] ?? { total: 0, done: 0 };
}

// ---- Applying what was read from the narration --------------------------------------

/**
 * Replace a guide's steps and parts with a draft, in one transaction. Steps
 * come in as `narration`; their pictures are grabbed afterwards by the job.
 * `expectToken` makes the write conditional on still holding the job.
 */
export async function writeDraft(guideId: string, draft: Draft, expectToken?: string): Promise<boolean> {
  let unlinked: (string | null)[] = [];
  const applied = await db.transaction(async (tx) => {
    const cond = expectToken
      ? and(eq(teardownGuides.id, guideId), eq(teardownGuides.jobToken, expectToken))
      : eq(teardownGuides.id, guideId);
    const locked = await tx
      .update(teardownGuides)
      .set({ draft: null, refinedAt: null, updatedAt: new Date() })
      .where(cond)
      .returning({ id: teardownGuides.id });
    if (!locked.length) return false;
    await tx.delete(teardownParts).where(eq(teardownParts.guideId, guideId));
    const removed = await tx
      .delete(teardownSteps)
      .where(eq(teardownSteps.guideId, guideId))
      .returning({ keyframe: teardownSteps.keyframeAttachmentId });
    unlinked = removed.map((r) => r.keyframe);
    const ids = draft.steps.map(() => randomUUID());
    if (draft.steps.length) {
      await tx.insert(teardownSteps).values(
        draft.steps.map((s, i) => ({
          id: ids[i]!,
          guideId,
          position: i + 1,
          title: s.title,
          instruction: s.instruction,
          startSec: s.start,
          endSec: s.end,
          callout: s.callout,
          source: "narration" as const,
        })),
      );
    }
    if (draft.parts.length) {
      await tx.insert(teardownParts).values(
        draft.parts.map((p, i) => ({
          guideId,
          stepId: p.step ? (ids[p.step - 1] ?? null) : null,
          position: i + 1,
          name: p.name,
          kind: p.kind,
          qty: p.qty,
          source: "narration" as const,
        })),
      );
    }
    return true;
  });
  if (applied) await pruneKeyframes(guideId, unlinked);
  return applied;
}

/** Accept the steps read from the narration over the ones already there. */
export async function applyDraft(guideId: string): Promise<void> {
  const row = await requireGuideRow(guideId);
  const draft = draftOf(row.draft);
  if (!draft || !draft.complete) throw conflict("There is nothing read from the narration waiting to be applied.");
  await writeDraft(guideId, { steps: draft.steps, parts: draft.parts });
}

export async function discardDraft(guideId: string): Promise<void> {
  const row = await requireGuideRow(guideId);
  if (row.jobStatus === "running") throw conflict("The narration is still being read. Stop it first.");
  await db.update(teardownGuides).set({ draft: null, updatedAt: new Date() }).where(eq(teardownGuides.id, guideId));
}

// ---- Housekeeping ---------------------------------------------------------------------

/**
 * Remove guides whose item is gone, and forget units that are. Guides have no
 * foreign key to items (see the migration), so this is what cascades a
 * delete; the attachment sweep then removes their step pictures.
 */
export async function sweepOrphanGuides(): Promise<number> {
  const gone = await pool.query(
    `DELETE FROM teardown_guides g
      WHERE g.created_at < now() - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = g.item_id)`,
  );
  await pool.query(
    `UPDATE teardown_guides g SET unit_id = NULL
      WHERE g.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM item_units u WHERE u.id = g.unit_id)`,
  );
  return gone.rowCount ?? 0;
}

export const guideExists = async (id: string): Promise<boolean> => (await getGuideRow(id)) !== null;
