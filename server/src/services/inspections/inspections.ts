import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, pool } from "../../db/client";
import {
  inspectionFindings,
  inspections,
  jobTasks,
  jobs,
  locations,
  type FindingArea,
  type FindingSeverity,
  type Inspection,
  type InspectionFinding,
  type InspectionKind,
  type InspectionStatus,
} from "../../db/schema";
import { HttpError, badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import {
  deleteAttachment,
  deleteAttachmentsForOwner,
  getAttachment,
  listAttachments,
  listSignatures,
  registerOwnerType,
  verifySignature,
  type Attachment,
  type Signature,
  type VerifyResult,
} from "../media-ai-core";
import { completeTasksByKind, updateTask, type Actor } from "../jobs-core";
import { AREAS, SEVERITIES, SIGNOFF_ROLES, TASK_KIND_FOR, isSpot, signStatement, type SignoffRole } from "./model";
import { compareFindings, normalizeRoom, unmatched, type Comparison } from "./pairing";
import { buildSignContent, type ContentFinding, type SignContent } from "./content";
import { publishInspection } from "./events";
import type { KnownRoom } from "./ai";

/**
 * Inspections: a site surveyed before a move, after it, or on its own, as a
 * list of findings (room, spot, description, severity, photos), completed,
 * signed by the facility contact and the crew lead, and for a post-inspection
 * compared with the pre-inspection.
 *
 * Findings can change only while the inspection is a draft. Completing locks
 * them and closes the matching job task; reopening unlocks them, and any
 * signature collected before shows as changed if they are then edited.
 */

registerOwnerType(
  "inspection",
  async (id) => {
    const { rowCount } = await pool.query(`SELECT 1 FROM inspections WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  },
  { table: "inspections", label: "inspection" },
);

export type InspectionActor = Actor & { isAdmin?: boolean };

export type InspectionInput = {
  kind: InspectionKind;
  locationId?: string | null;
  siteName?: string | null;
  jobId?: string | null;
  jobTaskId?: string | null;
  preInspectionId?: string | null;
  inspectors?: string[];
  notes?: string | null;
};

export type FindingInput = {
  area?: FindingArea;
  room?: string | null;
  locationId?: string | null;
  spot?: string;
  spotDetail?: string | null;
  description?: string;
  severity?: FindingSeverity;
  preExisting?: boolean;
  aiGenerated?: boolean;
  aiSuggestion?: Record<string, unknown> | null;
  attachmentIds?: string[];
};

export type InspectionFilters = {
  jobId?: string;
  locationId?: string;
  kind?: InspectionKind;
  status?: InspectionStatus;
  q?: string;
  limit?: number;
};

const clean = (s: string | null | undefined, max: number, field: string): string | null => {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > max) throw badRequest(`${field} is limited to ${max} characters.`);
  return t;
};

const cleanNotes = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  if (!t) return null;
  if (t.length > 4000) throw badRequest("Notes are limited to 4000 characters.");
  return t;
};

function cleanInspectors(list: string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const raw of list) {
    const name = clean(raw, 120, "An inspector's name");
    if (name && !out.includes(name)) out.push(name);
  }
  if (out.length > 20) throw badRequest("List at most 20 inspectors.");
  return out;
}

// ---- Codes -------------------------------------------------------------------

// Crockford base32, as asset and job codes: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function genInspectionCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `INS-${out}`;
}

// ---- Loading -----------------------------------------------------------------

export async function loadInspection(id: string): Promise<Inspection> {
  const [row] = await db.select().from(inspections).where(eq(inspections.id, id)).limit(1);
  if (!row) throw notFound("Inspection not found. It may have been deleted.");
  return row;
}

function assertDraft(inspection: Inspection): void {
  if (inspection.status !== "draft") {
    throw new HttpError(
      409,
      "not_draft",
      `${inspection.code} is ${inspection.status}. Reopen it to change its details or findings.`,
    );
  }
}

/** A location's full path, "Old HQ / Floor 3", for naming a site. */
async function locationPath(id: string): Promise<string> {
  const { rows } = await pool.query<{ path: string | null }>(
    `WITH RECURSIVE up AS (
       SELECT id, name, parent_id, 0 AS depth FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.name, l.parent_id, up.depth + 1 FROM locations l JOIN up ON l.id = up.parent_id WHERE up.depth < 12
     )
     SELECT string_agg(name, ' / ' ORDER BY depth DESC) AS path FROM up`,
    [id],
  );
  const path = rows[0]?.path;
  if (!path) throw badRequest("Location not found. Pick one that exists.");
  return path;
}

/**
 * The rooms of a site, for the room picker and to steer the AI towards names
 * already in use: every location below the site as a path from it ("Floor 3 /
 * Kitchen"), then any free-text room already written on this inspection, its
 * pre-inspection, or earlier inspections of the same site.
 */
export async function knownRooms(inspection: Inspection): Promise<KnownRoom[]> {
  const out: KnownRoom[] = [];
  const seen = new Set<string>();
  const add = (name: string, locationId: string | null) => {
    const key = locationId ?? `text:${normalizeRoom(name)}`;
    if (!name.trim() || seen.has(key)) return;
    seen.add(key);
    out.push({ name, locationId });
  };
  if (inspection.locationId) {
    const { rows } = await pool.query<{ id: string; path: string }>(
      `WITH RECURSIVE sub AS (
         SELECT id, name::text AS path, 1 AS depth FROM locations WHERE parent_id = $1
         UNION ALL
         SELECT l.id, sub.path || ' / ' || l.name, sub.depth + 1 FROM locations l JOIN sub ON l.parent_id = sub.id WHERE sub.depth < 6
       )
       SELECT id, path FROM sub ORDER BY path LIMIT 400`,
      [inspection.locationId],
    );
    for (const r of rows) add(r.path, r.id);
  }
  const siteMatch = inspection.locationId
    ? eq(inspections.locationId, inspection.locationId)
    : eq(inspections.siteName, inspection.siteName);
  const used = await db
    .selectDistinct({ room: inspectionFindings.room, locationId: inspectionFindings.locationId })
    .from(inspectionFindings)
    .innerJoin(inspections, eq(inspections.id, inspectionFindings.inspectionId))
    .where(or(eq(inspections.id, inspection.id), siteMatch))
    .limit(400);
  for (const r of used.sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }))) {
    add(r.room, r.locationId);
  }
  return out;
}

// ---- Listing -------------------------------------------------------------------

const pre = alias(inspections, "pre");

export async function listInspections(filters: InspectionFilters = {}) {
  const conds: SQL[] = [];
  if (filters.jobId) conds.push(eq(inspections.jobId, filters.jobId));
  if (filters.locationId) conds.push(eq(inspections.locationId, filters.locationId));
  if (filters.kind) conds.push(eq(inspections.kind, filters.kind));
  if (filters.status) conds.push(eq(inspections.status, filters.status));
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(inspections.code, like), ilike(inspections.siteName, like), ilike(jobs.code, like), ilike(jobs.name, like))!);
  }
  return db
    .select({
      ...getTableColumns(inspections),
      jobCode: jobs.code,
      jobName: jobs.name,
      preCode: pre.code,
      findingCount: sql<number>`(SELECT count(*)::int FROM inspection_findings f WHERE f.inspection_id = ${inspections.id})`,
    })
    .from(inspections)
    .leftJoin(jobs, eq(jobs.id, inspections.jobId))
    .leftJoin(pre, eq(pre.id, inspections.preInspectionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(inspections.startedAt))
    .limit(Math.min(Math.max(filters.limit ?? 200, 1), 500));
}

// ---- Creating and changing ----------------------------------------------------

async function loadJobRow(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw badRequest("Job not found. Pick one that exists.");
  return job;
}

async function checkPre(preId: string, selfId: string | null): Promise<Inspection> {
  const [row] = await db.select().from(inspections).where(eq(inspections.id, preId)).limit(1);
  if (!row || row.id === selfId) throw badRequest("Pre-inspection not found. Pick one that exists.");
  if (row.kind !== "pre") throw badRequest(`${row.code} is not a pre-inspection. Compare with a pre-move inspection.`);
  return row;
}

/**
 * The pre-inspection a new post-inspection is compared with when none is
 * named: the latest one of the same site, preferring one on the same job.
 */
export async function findPreFor(opts: {
  jobId: string | null;
  locationId: string | null;
  siteName: string;
}): Promise<Inspection | null> {
  const site = opts.locationId ? eq(inspections.locationId, opts.locationId) : eq(inspections.siteName, opts.siteName);
  const order: SQL[] = [];
  if (opts.jobId) order.push(sql`(${inspections.jobId} = ${opts.jobId}) DESC NULLS LAST`);
  order.push(sql`(${inspections.status} <> 'draft') DESC`, desc(inspections.startedAt));
  const rows = await db
    .select()
    .from(inspections)
    .where(and(eq(inspections.kind, "pre"), site))
    .orderBy(...order)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The task a new inspection on a job closes: the one named, or the first open
 * task of the matching kind that no other inspection has claimed.
 */
async function pickTask(jobId: string, kind: InspectionKind, taskId: string | null | undefined, selfId: string | null) {
  if (taskId) {
    const [task] = await db.select().from(jobTasks).where(eq(jobTasks.id, taskId)).limit(1);
    if (!task || task.jobId !== jobId) throw badRequest("That task is not on this job. Pick one of the job's tasks.");
    return task;
  }
  const taskKind = TASK_KIND_FOR[kind];
  if (!taskKind) return null;
  const claimed = db
    .select({ id: inspections.jobTaskId })
    .from(inspections)
    .where(
      and(
        eq(inspections.jobId, jobId),
        sql`${inspections.jobTaskId} IS NOT NULL`,
        selfId ? ne(inspections.id, selfId) : sql`true`,
      ),
    );
  const [task] = await db
    .select()
    .from(jobTasks)
    .where(
      and(
        eq(jobTasks.jobId, jobId),
        eq(jobTasks.kind, taskKind),
        inArray(jobTasks.status, ["todo", "doing"]),
        notInArray(jobTasks.id, claimed),
      ),
    )
    .orderBy(asc(jobTasks.sequence), asc(jobTasks.createdAt))
    .limit(1);
  return task ?? null;
}

async function startTask(jobId: string, taskId: string, actor: Actor): Promise<void> {
  try {
    const [task] = await db.select().from(jobTasks).where(eq(jobTasks.id, taskId)).limit(1);
    if (task?.status === "todo") await updateTask(jobId, taskId, { status: "doing" }, actor);
  } catch (err) {
    // The inspection is what the person asked for; a task that cannot move is logged.
    logger.warn("inspections.task.start_failed", { jobId, taskId, err: String(err) });
  }
}

export async function createInspection(input: InspectionInput, actor: InspectionActor): Promise<Inspection> {
  const job = input.jobId ? await loadJobRow(input.jobId) : null;

  let locationId = input.locationId ?? null;
  let preInspection: Inspection | null = input.preInspectionId ? await checkPre(input.preInspectionId, null) : null;
  if (input.kind !== "post" && preInspection) throw badRequest("Only a post-inspection is compared with a pre-inspection.");
  if (!locationId && !clean(input.siteName, 200, "The site name")) {
    // From a job: the site the pre-inspection was of, or origin before the
    // move and destination after it.
    locationId =
      preInspection?.locationId ??
      (input.kind === "post"
        ? job?.destinationLocationId ?? job?.originLocationId
        : job?.originLocationId ?? job?.destinationLocationId) ??
      null;
  }
  const siteName = clean(input.siteName, 200, "The site name") ?? (locationId ? await locationPath(locationId) : null);
  if (!siteName) throw badRequest("Pick the site being inspected, or type its name.");

  if (input.kind === "post" && !preInspection && input.preInspectionId === undefined) {
    preInspection = await findPreFor({ jobId: job?.id ?? null, locationId, siteName });
  }
  const task = job ? await pickTask(job.id, input.kind, input.jobTaskId, null) : null;
  if (!job && input.jobTaskId) throw badRequest("A task needs its job. Pick the job as well.");

  const inspectors = cleanInspectors(input.inspectors) ?? (actor.name?.trim() ? [actor.name.trim()] : []);
  let row: Inspection | undefined;
  for (let attempt = 0; !row; attempt++) {
    try {
      [row] = await db
        .insert(inspections)
        .values({
          code: genInspectionCode(),
          kind: input.kind,
          jobId: job?.id ?? null,
          jobTaskId: task?.id ?? null,
          locationId,
          siteName,
          preInspectionId: preInspection?.id ?? null,
          inspectors,
          notes: cleanNotes(input.notes),
          startedBy: actor.userOid,
        })
        .returning();
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, "inspections_code_key")) continue;
      throw err;
    }
  }
  if (job && task) await startTask(job.id, task.id, actor);
  logger.info("inspections.created", { id: row.id, code: row.code, kind: row.kind, jobId: row.jobId });
  await publishInspection("inspection.created", row, actor.userOid, {
    preInspectionId: row.preInspectionId,
    jobTaskId: row.jobTaskId,
  });
  return row;
}

export async function updateInspection(id: string, patch: Partial<InspectionInput>, actor: InspectionActor): Promise<Inspection> {
  const current = await loadInspection(id);
  assertDraft(current);
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    throw badRequest("The kind of an inspection cannot change. Start a new one instead.");
  }
  const set: Partial<typeof inspections.$inferInsert> = { updatedAt: new Date() };

  if (patch.locationId !== undefined) {
    set.locationId = patch.locationId;
    if (patch.siteName === undefined && patch.locationId) set.siteName = await locationPath(patch.locationId);
  }
  if (patch.siteName !== undefined) {
    const name = clean(patch.siteName, 200, "The site name");
    if (name) set.siteName = name;
    else if (patch.locationId) set.siteName = await locationPath(patch.locationId);
    else throw badRequest("An inspection needs a site name.");
  }
  if (patch.jobId !== undefined) {
    const job = patch.jobId ? await loadJobRow(patch.jobId) : null;
    set.jobId = job?.id ?? null;
    const task = job ? await pickTask(job.id, current.kind, patch.jobTaskId, current.id) : null;
    set.jobTaskId = task?.id ?? null;
    if (job && task) await startTask(job.id, task.id, actor);
  } else if (patch.jobTaskId !== undefined) {
    if (!current.jobId && patch.jobTaskId) throw badRequest("Pick the job before its task.");
    set.jobTaskId = patch.jobTaskId ? (await pickTask(current.jobId!, current.kind, patch.jobTaskId, current.id))!.id : null;
  }
  if (patch.preInspectionId !== undefined) {
    if (patch.preInspectionId && current.kind !== "post") {
      throw badRequest("Only a post-inspection is compared with a pre-inspection.");
    }
    const target = patch.preInspectionId ? await checkPre(patch.preInspectionId, current.id) : null;
    set.preInspectionId = target?.id ?? null;
    if (target?.id !== current.preInspectionId) {
      // Pairs chosen against another pre-inspection mean nothing against this one.
      await db
        .update(inspectionFindings)
        .set({ pairedWithId: null, pairSource: null })
        .where(eq(inspectionFindings.inspectionId, current.id));
    }
  }
  const inspectors = cleanInspectors(patch.inspectors);
  if (inspectors !== undefined) set.inspectors = inspectors;
  if (patch.notes !== undefined) set.notes = cleanNotes(patch.notes);

  const [row] = await db.update(inspections).set(set).where(eq(inspections.id, id)).returning();
  return row!;
}

export async function deleteInspection(id: string, actor: InspectionActor): Promise<void> {
  const current = await loadInspection(id);
  if (current.status === "signed" && !actor.isAdmin) {
    throw forbidden("A signed inspection is evidence. Only an administrator can delete it.");
  }
  const posts = await db
    .select({ code: inspections.code })
    .from(inspections)
    .where(and(eq(inspections.preInspectionId, id), ne(inspections.status, "draft")));
  if (posts.length && !actor.isAdmin) {
    throw conflict(
      `${posts.map((p) => p.code).join(", ")} ${posts.length === 1 ? "is" : "are"} compared with this inspection. ` +
        "Only an administrator can delete it now.",
    );
  }
  await db.delete(inspections).where(eq(inspections.id, id));
  // The sweep would remove them within the hour; a deliberate delete should not wait.
  await deleteAttachmentsForOwner("inspection", id);
  logger.info("inspections.deleted", { id, code: current.code });
  await publishInspection("inspection.deleted", current, actor.userOid);
}

// ---- Findings ------------------------------------------------------------------

async function loadFinding(inspectionId: string, findingId: string): Promise<InspectionFinding> {
  const [row] = await db
    .select()
    .from(inspectionFindings)
    .where(and(eq(inspectionFindings.id, findingId), eq(inspectionFindings.inspectionId, inspectionId)))
    .limit(1);
  if (!row) throw notFound("Finding not found. It may have been removed.");
  return row;
}

export async function listFindings(inspectionId: string): Promise<InspectionFinding[]> {
  return db
    .select()
    .from(inspectionFindings)
    .where(eq(inspectionFindings.inspectionId, inspectionId))
    .orderBy(asc(inspectionFindings.sequence), asc(inspectionFindings.createdAt));
}

/** Photos a finding may list: files of this inspection, and photos only. */
async function checkPhotos(inspectionId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length > 12) throw badRequest("A finding can show at most 12 photos.");
  for (const id of unique) {
    const a = await getAttachment(id);
    if (!a || a.ownerType !== "inspection" || a.ownerId !== inspectionId) {
      throw badRequest("A photo on this finding is not one of this inspection's files. Upload it to the inspection first.");
    }
    if (a.kind !== "photo") throw badRequest("Only photos can be shown on a finding.");
  }
  return unique;
}

/** Remove photos no finding shows any more, if they were taken for a finding. */
async function prunePhotos(inspectionId: string, candidates: string[]): Promise<void> {
  if (!candidates.length) return;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT unnest(attachment_ids) AS id FROM inspection_findings WHERE inspection_id = $1`,
    [inspectionId],
  );
  const inUse = new Set(rows.map((r) => r.id));
  for (const id of new Set(candidates)) {
    if (inUse.has(id)) continue;
    const a = await getAttachment(id);
    if (a?.ownerType === "inspection" && a.ownerId === inspectionId && a.stage === "finding") {
      await deleteAttachment(id).catch((err) => logger.warn("inspections.photo.prune_failed", { id, err: String(err) }));
    }
  }
}

async function findingRoom(
  inspection: Inspection,
  room: string | null | undefined,
  locationId: string | null | undefined,
): Promise<{ room: string; locationId: string | null }> {
  const typed = clean(room, 200, "The room");
  if (!locationId) {
    if (!typed) throw badRequest("Say which room or place the damage is in.");
    return { room: typed, locationId: null };
  }
  if (typed) return { room: typed, locationId };
  const known = (await knownRooms(inspection)).find((r) => r.locationId === locationId);
  if (known) return { room: known.name, locationId };
  const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, locationId)).limit(1);
  if (!loc) throw badRequest("Room location not found. Pick one that exists.");
  return { room: loc.name, locationId };
}

function checkFields(input: FindingInput): void {
  if (input.area !== undefined && !(AREAS as readonly string[]).includes(input.area)) {
    throw badRequest("Area must be inside or outside.");
  }
  if (input.spot !== undefined && !isSpot(input.spot)) throw badRequest("Pick where the damage is: wall, floor, door…");
  if (input.severity !== undefined && !(SEVERITIES as readonly string[]).includes(input.severity)) {
    throw badRequest("Severity must be minor, moderate or major.");
  }
}

export async function addFinding(inspectionId: string, input: FindingInput, actor: Actor): Promise<InspectionFinding> {
  const inspection = await loadInspection(inspectionId);
  assertDraft(inspection);
  checkFields(input);
  const description = clean(input.description, 1000, "The description");
  if (!description) throw badRequest("Describe the damage in a few words.");
  const place = await findingRoom(inspection, input.room, input.locationId);
  const attachmentIds = await checkPhotos(inspection.id, input.attachmentIds ?? []);

  const [row] = await db
    .insert(inspectionFindings)
    .values({
      inspectionId,
      sequence: sql`(SELECT coalesce(max(sequence), 0) + 1 FROM inspection_findings WHERE inspection_id = ${inspectionId})`,
      area: input.area ?? "inside",
      room: place.room,
      locationId: place.locationId,
      spot: input.spot ?? "other",
      spotDetail: clean(input.spotDetail, 200, "Where on the spot"),
      description,
      severity: input.severity ?? "minor",
      aiGenerated: input.aiGenerated ?? false,
      aiSuggestion: input.aiSuggestion ?? null,
      // Everything a pre-inspection records was there before the move.
      preExisting: inspection.kind === "pre" ? true : (input.preExisting ?? false),
      attachmentIds,
      createdBy: actor.userOid,
    })
    .returning();
  await touch(inspectionId);
  await publishInspection("inspection.finding_added", inspection, actor.userOid, {
    findingId: row!.id,
    room: row!.room,
    spot: row!.spot,
    severity: row!.severity,
    aiGenerated: row!.aiGenerated,
    photos: row!.attachmentIds.length,
  });
  return row!;
}

export async function updateFinding(
  inspectionId: string,
  findingId: string,
  patch: FindingInput,
  actor: Actor,
): Promise<InspectionFinding> {
  const inspection = await loadInspection(inspectionId);
  assertDraft(inspection);
  const current = await loadFinding(inspectionId, findingId);
  checkFields(patch);
  const set: Partial<typeof inspectionFindings.$inferInsert> = { updatedAt: new Date() };
  if (patch.area !== undefined) set.area = patch.area;
  if (patch.room !== undefined || patch.locationId !== undefined) {
    const place = await findingRoom(
      inspection,
      patch.room !== undefined ? patch.room : patch.locationId !== undefined ? null : current.room,
      patch.locationId !== undefined ? patch.locationId : current.locationId,
    );
    set.room = place.room;
    set.locationId = place.locationId;
  }
  if (patch.spot !== undefined) set.spot = patch.spot;
  if (patch.spotDetail !== undefined) set.spotDetail = clean(patch.spotDetail, 200, "Where on the spot");
  if (patch.description !== undefined) {
    const description = clean(patch.description, 1000, "The description");
    if (!description) throw badRequest("Describe the damage in a few words.");
    set.description = description;
  }
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.preExisting !== undefined && inspection.kind !== "pre") set.preExisting = patch.preExisting;
  let removed: string[] = [];
  if (patch.attachmentIds !== undefined) {
    set.attachmentIds = await checkPhotos(inspectionId, patch.attachmentIds);
    removed = current.attachmentIds.filter((id) => !set.attachmentIds!.includes(id));
  }
  const [row] = await db.update(inspectionFindings).set(set).where(eq(inspectionFindings.id, findingId)).returning();
  await prunePhotos(inspectionId, removed);
  await touch(inspectionId);
  await publishInspection("inspection.finding_updated", inspection, actor.userOid, {
    findingId,
    changed: Object.keys(set).filter((k) => k !== "updatedAt"),
  });
  return row!;
}

export async function removeFinding(inspectionId: string, findingId: string, actor: Actor): Promise<void> {
  const inspection = await loadInspection(inspectionId);
  assertDraft(inspection);
  const current = await loadFinding(inspectionId, findingId);
  const [dependent] = await db
    .select({ code: inspections.code })
    .from(inspectionFindings)
    .innerJoin(inspections, eq(inspections.id, inspectionFindings.inspectionId))
    .where(and(eq(inspectionFindings.pairedWithId, findingId), ne(inspections.status, "draft")))
    .limit(1);
  if (dependent) {
    throw conflict(`${dependent.code} compares its findings with this one. Reopen ${dependent.code} before removing it.`);
  }
  await db.delete(inspectionFindings).where(eq(inspectionFindings.id, findingId));
  await prunePhotos(inspectionId, current.attachmentIds);
  await touch(inspectionId);
  await publishInspection("inspection.finding_removed", inspection, actor.userOid, {
    findingId,
    room: current.room,
    spot: current.spot,
    description: current.description,
  });
}

async function touch(inspectionId: string): Promise<void> {
  await db.update(inspections).set({ updatedAt: new Date() }).where(eq(inspections.id, inspectionId));
}

// ---- Comparison ------------------------------------------------------------------

type Loaded = { inspection: Inspection; findings: InspectionFinding[] };

async function withFindings(id: string): Promise<Loaded> {
  const inspection = await loadInspection(id);
  return { inspection, findings: await listFindings(id) };
}

/**
 * The post-inspection against its pre-inspection, or null for anything else.
 * The findings carry whatever extra fields the caller loaded them with.
 */
export function comparisonOf<F extends InspectionFinding>(
  inspection: Inspection,
  preFindings: F[] | null,
  findings: F[],
): Comparison<F> | null {
  if (inspection.kind !== "post" || !inspection.preInspectionId || !preFindings) return null;
  return compareFindings(preFindings, findings);
}

export async function getComparison(id: string) {
  const { inspection, findings } = await withFindings(id);
  if (inspection.kind !== "post") throw badRequest("Only a post-inspection is compared with a pre-inspection.");
  if (!inspection.preInspectionId) return { preInspection: null, comparison: null };
  const preInspection = await loadInspection(inspection.preInspectionId);
  return { preInspection, comparison: comparisonOf(inspection, await listFindings(preInspection.id), findings) };
}

/**
 * Pair one post finding by hand: with a pre finding, with nothing ("this is
 * new"), or back to automatic.
 */
export async function setPairing(
  inspectionId: string,
  findingId: string,
  choice: { preFindingId: string | null } | { auto: true },
  actor: Actor,
): Promise<InspectionFinding> {
  const inspection = await loadInspection(inspectionId);
  assertDraft(inspection);
  if (inspection.kind !== "post" || !inspection.preInspectionId) {
    throw badRequest("Pick the pre-inspection to compare with first.");
  }
  await loadFinding(inspectionId, findingId);
  let set: { pairedWithId: string | null; pairSource: "manual" | null };
  if ("auto" in choice) set = { pairedWithId: null, pairSource: null };
  else {
    if (choice.preFindingId) {
      const [target] = await db
        .select({ id: inspectionFindings.id })
        .from(inspectionFindings)
        .where(
          and(
            eq(inspectionFindings.id, choice.preFindingId),
            eq(inspectionFindings.inspectionId, inspection.preInspectionId),
          ),
        )
        .limit(1);
      if (!target) throw badRequest("That finding is not on the pre-inspection this is compared with.");
      // One pre finding pairs with one post finding: a person's choice takes it from any other.
      await db
        .update(inspectionFindings)
        .set({ pairedWithId: null, pairSource: null })
        .where(
          and(
            eq(inspectionFindings.inspectionId, inspectionId),
            eq(inspectionFindings.pairedWithId, choice.preFindingId),
            ne(inspectionFindings.id, findingId),
          ),
        );
    }
    set = { pairedWithId: choice.preFindingId, pairSource: "manual" };
  }
  const [row] = await db
    .update(inspectionFindings)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(inspectionFindings.id, findingId))
    .returning();
  await touch(inspectionId);
  await publishInspection("inspection.finding_updated", inspection, actor.userOid, {
    findingId,
    changed: ["pairing"],
    pairedWithId: set.pairedWithId,
    pairing: "auto" in choice ? "auto" : "manual",
  });
  return row!;
}

/**
 * Store AI pairs for what the room-and-spot rule left unmatched. Earlier AI
 * pairs are cleared first, so running it again reconsiders them; a person's
 * choices are left alone.
 */
export async function storeAiPairs(
  inspectionId: string,
  run: (pre: InspectionFinding[], post: InspectionFinding[]) => Promise<{ preId: string; postId: string }[] | null>,
): Promise<{ available: boolean; considered: { pre: number; post: number }; paired: number }> {
  const inspection = await loadInspection(inspectionId);
  assertDraft(inspection);
  if (inspection.kind !== "post" || !inspection.preInspectionId) {
    throw badRequest("Pick the pre-inspection to compare with first.");
  }
  const [preFindings, postFindings] = await Promise.all([
    listFindings(inspection.preInspectionId),
    listFindings(inspectionId),
  ]);
  const open = unmatched(preFindings, postFindings);
  const considered = { pre: open.pre.length, post: open.post.length };
  const pairs = await run(open.pre, open.post);
  if (pairs === null) return { available: false, considered, paired: 0 };
  await db.transaction(async (tx) => {
    await tx
      .update(inspectionFindings)
      .set({ pairedWithId: null, pairSource: null })
      .where(and(eq(inspectionFindings.inspectionId, inspectionId), eq(inspectionFindings.pairSource, "ai")));
    for (const p of pairs) {
      await tx
        .update(inspectionFindings)
        .set({ pairedWithId: p.preId, pairSource: "ai", updatedAt: new Date() })
        .where(
          and(
            eq(inspectionFindings.id, p.postId),
            eq(inspectionFindings.inspectionId, inspectionId),
            or(isNull(inspectionFindings.pairSource), eq(inspectionFindings.pairSource, "ai")),
          ),
        );
    }
  });
  return { available: true, considered, paired: pairs.length };
}

// ---- Signing content ---------------------------------------------------------

async function contentFindings(inspectionId: string, findings: InspectionFinding[]): Promise<ContentFinding[]> {
  const files = new Map((await listAttachments("inspection", inspectionId)).map((a) => [a.id, a]));
  return findings.map((f) => ({ ...f, photos: f.attachmentIds.map((id) => files.get(id)?.sha256 ?? null) }));
}

/** The JSON a signer of this inspection attests to, rebuilt from the record as it is now. */
export async function signContentFor(inspection: Inspection): Promise<SignContent> {
  const findings = await contentFindings(inspection.id, await listFindings(inspection.id));
  let comparison: Comparison<ContentFinding> | null = null;
  if (inspection.kind === "post" && inspection.preInspectionId) {
    const preFindings = await contentFindings(inspection.preInspectionId, await listFindings(inspection.preInspectionId));
    comparison = compareFindings(preFindings, findings);
  }
  return buildSignContent({ inspection, findings, comparison });
}

export async function signRequest(id: string, role: SignoffRole) {
  const inspection = await loadInspection(id);
  if (inspection.status === "draft") throw badRequest("Complete the inspection before it is signed.");
  return {
    ownerType: "inspection",
    ownerId: inspection.id,
    role,
    statement: signStatement(inspection.kind, inspection.siteName, role),
    content: await signContentFor(inspection),
  };
}

export type SignatureView = Signature & {
  verification: Pick<VerifyResult, "valid" | "reason">;
  role: SignoffRole | null;
};

export async function signaturesOf(inspection: Inspection, content?: SignContent): Promise<SignatureView[]> {
  const list = await listSignatures("inspection", inspection.id);
  if (!list.length) return [];
  const current = content ?? (await signContentFor(inspection));
  const out: SignatureView[] = [];
  for (const s of list) {
    const v = await verifySignature(s.id, current);
    out.push({
      ...s,
      verification: { valid: v.valid, reason: v.reason },
      role:
        s.id === inspection.facilitySignatureId ? "facility_contact" : s.id === inspection.crewSignatureId ? "crew_lead" : null,
    });
  }
  return out;
}

const bothSigned = (views: SignatureView[]) =>
  SIGNOFF_ROLES.every((role) => views.some((v) => v.role === role && v.verification.valid));

// ---- Lifecycle ---------------------------------------------------------------------

async function closeTask(inspection: Inspection, actor: Actor): Promise<string[]> {
  if (!inspection.jobId) return [];
  try {
    if (inspection.jobTaskId) {
      const [task] = await db.select().from(jobTasks).where(eq(jobTasks.id, inspection.jobTaskId)).limit(1);
      if (task && task.status !== "done" && task.status !== "skipped") {
        await updateTask(inspection.jobId, task.id, { status: "done" }, actor);
        return [task.id];
      }
      return [];
    }
    const kind = TASK_KIND_FOR[inspection.kind];
    if (!kind) return [];
    return (await completeTasksByKind(inspection.jobId, kind, actor)).map((t) => t.id);
  } catch (err) {
    logger.warn("inspections.task.complete_failed", { id: inspection.id, jobId: inspection.jobId, err: String(err) });
    return [];
  }
}

export async function completeInspection(id: string, actor: Actor): Promise<Inspection> {
  const current = await loadInspection(id);
  if (current.status !== "draft") return current;
  const now = new Date();
  const [completed] = await db
    .update(inspections)
    .set({ status: "completed", completedAt: now, completedBy: actor.name ?? actor.userOid, updatedAt: now })
    .where(and(eq(inspections.id, id), eq(inspections.status, "draft")))
    .returning();
  if (!completed) return loadInspection(id);

  // Signatures collected before a reopen still count if nothing they covered changed.
  let row = completed;
  const views = await signaturesOf(completed);
  if (bothSigned(views)) {
    [row] = (await db
      .update(inspections)
      .set({ status: "signed", signedAt: now })
      .where(eq(inspections.id, id))
      .returning()) as [Inspection];
  }

  const tasks = await closeTask(row, actor);
  const summary = await findingSummary(row);
  logger.info("inspections.completed", { id, code: row.code, tasks: tasks.length });
  await publishInspection("inspection.completed", row, actor.userOid, { ...summary, completedTaskIds: tasks });
  if (row.status === "signed") await publishInspection("inspection.signed", row, actor.userOid, { reused: true });
  return row;
}

async function findingSummary(inspection: Inspection) {
  const findings = await listFindings(inspection.id);
  const out: Record<string, unknown> = { findings: findings.length };
  if (inspection.kind === "post" && inspection.preInspectionId) {
    const cmp = compareFindings(await listFindings(inspection.preInspectionId), findings);
    out.comparison = cmp.counts;
  }
  return out;
}

export async function reopenInspection(id: string, actor: Actor): Promise<Inspection> {
  const current = await loadInspection(id);
  if (current.status === "draft") return current;
  const [row] = await db
    .update(inspections)
    .set({ status: "draft", completedAt: null, completedBy: null, signedAt: null, updatedAt: new Date() })
    .where(eq(inspections.id, id))
    .returning();
  // The task stood for this inspection being done, and it no longer is.
  if (current.jobId && current.jobTaskId) {
    try {
      const [task] = await db.select().from(jobTasks).where(eq(jobTasks.id, current.jobTaskId)).limit(1);
      if (task?.status === "done") await updateTask(current.jobId, task.id, { status: "doing" }, actor);
    } catch (err) {
      logger.warn("inspections.task.reopen_failed", { id, err: String(err) });
    }
  }
  await publishInspection("inspection.reopened", row!, actor.userOid, { previousStatus: current.status });
  return row!;
}

/**
 * Put a signature into one of the two sign-off slots. The signature must be on
 * this inspection and match it as it is now, which is what stops a signature
 * made on a draft, or before an edit, from counting. With both slots filled
 * and valid, the inspection is signed.
 */
export async function recordSignoff(
  id: string,
  role: SignoffRole,
  signatureId: string,
  actor: Actor,
): Promise<{ inspection: Inspection; signatures: SignatureView[] }> {
  const current = await loadInspection(id);
  if (current.status === "draft") throw badRequest("Complete the inspection before it is signed.");
  const content = await signContentFor(current);
  const mine = (await listSignatures("inspection", id)).find((s) => s.id === signatureId);
  if (!mine) throw badRequest("That signature is not on this inspection. Sign again.");
  const check = await verifySignature(signatureId, content);
  if (!check.valid) {
    throw new HttpError(
      409,
      "content_changed",
      "The inspection changed after this signature was made, so it does not cover what is there now. Sign again.",
    );
  }
  const column = role === "facility_contact" ? { facilitySignatureId: signatureId } : { crewSignatureId: signatureId };
  let [row] = (await db
    .update(inspections)
    .set({ ...column, updatedAt: new Date() })
    .where(eq(inspections.id, id))
    .returning()) as [Inspection];
  const views = await signaturesOf(row, content);
  await publishInspection("inspection.signoff_added", row, actor.userOid, {
    role,
    signatureId,
    signerName: mine.signerName,
    contentHash: mine.contentHash,
  });
  if (row.status !== "signed" && bothSigned(views)) {
    [row] = (await db
      .update(inspections)
      .set({ status: "signed", signedAt: new Date() })
      .where(eq(inspections.id, id))
      .returning()) as [Inspection];
    logger.info("inspections.signed", { id, code: row.code });
    await publishInspection("inspection.signed", row, actor.userOid, {
      facilitySignatureId: row.facilitySignatureId,
      crewSignatureId: row.crewSignatureId,
      contentHash: mine.contentHash,
    });
  }
  return { inspection: row, signatures: views };
}

// ---- Detail -------------------------------------------------------------------------

export type FindingView = InspectionFinding & { number: number; photos: Attachment[] };

function viewFindings(findings: InspectionFinding[], files: Map<string, Attachment>): FindingView[] {
  return findings.map((f, i) => ({
    ...f,
    number: i + 1,
    photos: f.attachmentIds.map((id) => files.get(id)).filter((a): a is Attachment => Boolean(a)),
  }));
}

export async function findingViews(inspectionId: string): Promise<{ findings: FindingView[]; files: Attachment[] }> {
  const [findings, files] = await Promise.all([listFindings(inspectionId), listAttachments("inspection", inspectionId)]);
  return { findings: viewFindings(findings, new Map(files.map((a) => [a.id, a]))), files };
}

export async function getInspectionDetail(id: string) {
  const inspection = await loadInspection(id);
  const [{ findings, files }, job, task, preInspection, rooms, location] = await Promise.all([
    findingViews(id),
    inspection.jobId
      ? db
          .select({
            id: jobs.id,
            code: jobs.code,
            name: jobs.name,
            status: jobs.status,
            originLocationId: jobs.originLocationId,
            destinationLocationId: jobs.destinationLocationId,
          })
          .from(jobs)
          .where(eq(jobs.id, inspection.jobId))
          .then((r) => r[0] ?? null)
      : null,
    inspection.jobTaskId
      ? db
          .select({ id: jobTasks.id, title: jobTasks.title, kind: jobTasks.kind, status: jobTasks.status })
          .from(jobTasks)
          .where(eq(jobTasks.id, inspection.jobTaskId))
          .then((r) => r[0] ?? null)
      : null,
    inspection.preInspectionId ? loadInspection(inspection.preInspectionId).catch(() => null) : null,
    knownRooms(inspection),
    inspection.locationId
      ? db
          .select({ id: locations.id, name: locations.name, address: locations.address })
          .from(locations)
          .where(eq(locations.id, inspection.locationId))
          .then((r) => r[0] ?? null)
      : null,
  ]);
  const pre = preInspection ? await findingViews(preInspection.id) : null;
  const comparison = comparisonOf(inspection, pre?.findings ?? null, findings);
  const content = await signContentFor(inspection);
  return {
    ...inspection,
    job,
    task,
    location,
    preInspection: preInspection
      ? {
          id: preInspection.id,
          code: preInspection.code,
          status: preInspection.status,
          siteName: preInspection.siteName,
          startedAt: preInspection.startedAt,
          completedAt: preInspection.completedAt,
        }
      : null,
    findings,
    preFindings: pre?.findings ?? [],
    photos: files.filter((a) => a.kind === "photo" && a.stage !== "finding"),
    rooms,
    comparison: comparison
      ? {
          counts: comparison.counts,
          entries: comparison.entries.map((e) => ({
            change: e.change,
            preId: e.pre?.id ?? null,
            postId: e.post?.id ?? null,
            source: e.source,
            notedPreExisting: e.notedPreExisting,
          })),
        }
      : null,
    signatures: await signaturesOf(inspection, content),
    editable: inspection.status === "draft",
  };
}
