import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Readable } from "node:stream";
import { db, pool } from "../../db/client";
import {
  itemUnits,
  items,
  jobItemStageHistory,
  jobItems,
  locations,
  portalNotes,
  shipments,
  type PortalGrant,
} from "../../db/schema";
import { env } from "../../env";
import { badRequest, notFound } from "../../lib/errors";
import { getConfig } from "../config";
import {
  PROGRESS_STAGES,
  hasReached,
  isStage,
  progressByShipment,
  rollupCounts,
  stageList,
  type Progress,
} from "../jobs-core";
import { getAttachmentStream, thumbnail } from "../media-ai-core";
import { mailAvailable } from "./mailer";
import { buildMilestones, noticeFromEvent, type Milestone } from "./milestones";
import {
  NOTE_CONDITIONS,
  PHOTO_STAGES,
  contributorStages,
  highValueCents,
  maskEmail,
} from "./policy";
import { newestPosition, positionFromMetadata, type LastPosition } from "./position";
import type { PortalScopeView } from "./scope";

/**
 * Everything a portal page reads. Each function takes the request's grant and
 * its freshly loaded scope, and selects only named, outward-safe columns: no
 * user ids, no internal notes, no values unless the grant shows values, and
 * nothing outside the scope's lines and records.
 */

export type PortalContext = { grant: PortalGrant; scope: PortalScopeView };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lineNotFound = () => notFound("That line is not part of what this link covers.");

const PROGRESS = PROGRESS_STAGES as readonly string[];
const photoStages = [...PHOTO_STAGES];
const threshold = () => highValueCents(env.PORTAL_HIGH_VALUE);

// ---- Session -----------------------------------------------------------------

export async function sessionInfo(grant: PortalGrant, scope: PortalScopeView | null) {
  const config = await getConfig();
  const contributor = grant.role === "contributor";
  return {
    codeRequired: grant.requireCode,
    verified: scope !== null,
    role: grant.role,
    granteeName: grant.granteeName,
    granteeOrg: grant.granteeOrg,
    expiresAt: grant.expiresAt,
    email: maskEmail(grant.granteeEmail),
    notify: grant.notify,
    mailAvailable: mailAvailable(),
    permissions: { values: grant.showValues, documents: grant.showDocuments },
    scope: scope
      ? {
          kind: scope.kind,
          code: scope.code,
          name: scope.name,
          project: scope.project ? { code: scope.project.code, name: scope.project.name } : null,
        }
      : null,
    contributor:
      scope && contributor
        ? {
            stages: contributorStages(grant.role, grant.allowedStages, isStage).map((name) => {
              const info = stageList().find((s) => s.name === name);
              return { name, label: info?.label ?? name, kind: info?.kind ?? "exception" };
            }),
            photoStages,
            conditions: [...NOTE_CONDITIONS],
            shipments:
              scope.kind === "job"
                ? scope.shipments.map((s) => ({ id: s.id, code: s.code, name: s.name, status: s.status }))
                : [],
          }
        : null,
    instance: {
      appName: config.appName,
      orgName: config.orgName,
      accentColor: config.accentColor,
      currency: config.currency,
      locale: config.locale,
      itemTerm: config.terms.item,
      locationTerm: config.terms.location,
    },
    stages: stageList().map((s) => ({ name: s.name, label: s.label, kind: s.kind, color: s.color })),
  };
}

// ---- Overview ------------------------------------------------------------------

async function scopeProgress(scope: PortalScopeView): Promise<Progress> {
  const rows = await db
    .select({ stage: jobItems.stage, n: sql<number>`count(*)::int` })
    .from(jobItems)
    .where(scope.lines)
    .groupBy(jobItems.stage);
  return rollupCounts(Object.fromEntries(rows.map((r) => [r.stage, r.n])));
}

type Step = "packed" | "loaded" | "delivered" | "placed";

async function stepTimes(scope: PortalScopeView) {
  const rows = await db
    .select({
      stage: jobItemStageHistory.toStage,
      first: sql<Date>`min(${jobItemStageHistory.createdAt})`,
      last: sql<Date>`max(${jobItemStageHistory.createdAt})`,
    })
    .from(jobItemStageHistory)
    .innerJoin(jobItems, eq(jobItems.id, jobItemStageHistory.jobItemId))
    .where(scope.lines)
    .groupBy(jobItemStageHistory.toStage);
  const out: Partial<Record<Step, { first: Date | null; last: Date | null }>> = {};
  for (const step of ["packed", "loaded", "delivered", "placed"] as Step[]) {
    let first: Date | null = null;
    let last: Date | null = null;
    for (const r of rows) {
      if (!hasReached(r.stage, step)) continue;
      const f = new Date(r.first);
      const l = new Date(r.last);
      if (!first || f < first) first = f;
      if (!last || l > last) last = l;
    }
    out[step] = { first, last };
  }
  return out;
}

/** Position of the newest tracking-core fix or zone read of anything on each shipment. */
async function trackedPositions(shipmentIds: string[]): Promise<Map<string, LastPosition>> {
  const out = new Map<string, LastPosition>();
  if (!shipmentIds.length) return out;
  const { rows } = await pool.query<{
    shipment_id: string;
    lat: number | null;
    lng: number | null;
    place: string | null;
    observed_at: Date;
  }>(
    `SELECT DISTINCT ON (ji.shipment_id) ji.shipment_id, ap.lat, ap.lng, l.name AS place, ap.observed_at
       FROM job_items ji
       JOIN asset_positions ap
         ON ap.item_id = ji.item_id AND (ji.unit_id IS NULL OR ap.unit_id IS NULL OR ap.unit_id = ji.unit_id)
       LEFT JOIN locations l ON l.id = ap.location_id
      WHERE ji.shipment_id = ANY($1::uuid[]) AND (ap.lat IS NOT NULL OR ap.location_id IS NOT NULL)
      ORDER BY ji.shipment_id, ap.observed_at DESC`,
    [shipmentIds],
  );
  for (const r of rows) {
    out.set(r.shipment_id, {
      lat: r.lat,
      lng: r.lng,
      place: r.place,
      at: r.observed_at.toISOString(),
      source: "tracking",
    });
  }
  return out;
}

type AuditRow = {
  id: string;
  type: string;
  occurred_at: Date;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
};

/**
 * Geofence events about this scope, from the GPS feature when it is
 * installed. Read from the audit log by type, so nothing here depends on it.
 */
async function geofenceEvents(scope: PortalScopeView): Promise<AuditRow[]> {
  if (!scope.shipmentIds.length && !scope.jobIds.length) return [];
  const jobIds = scope.kind === "shipment" ? [] : scope.jobIds;
  const { rows } = await pool.query<AuditRow>(
    `SELECT id, type, occurred_at, subject_type, subject_id, data FROM audit_log
      WHERE type LIKE 'geofence.%'
        AND ((subject_type = 'shipment' AND subject_id = ANY($1::text[]))
          OR (subject_type = 'job' AND subject_id = ANY($2::text[]))
          OR data->>'shipmentId' = ANY($1::text[])
          OR data->>'jobId' = ANY($2::text[]))
      ORDER BY id DESC LIMIT 20`,
    [scope.shipmentIds, jobIds],
  );
  return rows;
}

const statusWords = (s: string) => s.replace(/_/g, " ");

export async function overview(ctx: PortalContext) {
  const { scope } = ctx;
  const [progress, times, perShipment, tracked, fences, statusRows] = await Promise.all([
    scopeProgress(scope),
    stepTimes(scope),
    progressByShipment(scope.shipmentIds),
    trackedPositions(scope.shipmentIds),
    geofenceEvents(scope),
    scope.shipmentIds.length
      ? pool.query<{ shipment_id: string; to_status: string; created_at: Date }>(
          `SELECT shipment_id, to_status, created_at FROM shipment_status_history
            WHERE shipment_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 30`,
          [scope.shipmentIds],
        )
      : Promise.resolve({ rows: [] as { shipment_id: string; to_status: string; created_at: Date }[] }),
  ]);

  const shipmentById = new Map(scope.shipments.map((s) => [s.id, s]));
  const fenceUpdates = fences
    .map((r) => {
      const notice = noticeFromEvent({
        id: Number(r.id),
        type: r.type,
        occurredAt: r.occurred_at,
        subject: r.subject_type && r.subject_id ? { type: r.subject_type, id: r.subject_id } : null,
        data: r.data ?? {},
      });
      return notice ? { at: r.occurred_at, title: notice.title, kind: "location" as const, arriving: notice.key.endsWith(":arrived") } : null;
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);
  const lastArrival = fenceUpdates.find((u) => u.arriving);

  const milestones: Milestone[] = buildMilestones({
    createdAt: scope.createdAt,
    progress,
    stepTimes: times,
    shipments: scope.shipments.map((s) => ({ departedAt: s.departedAt, arrivedAt: s.arrivedAt })),
    lastArrival: lastArrival ? { at: lastArrival.at, label: lastArrival.title } : null,
  });

  const updates = [
    ...statusRows.rows.map((r) => {
      const s = shipmentById.get(r.shipment_id);
      return { at: r.created_at, title: `${s?.name ?? "Shipment"} (${s?.code ?? ""}): ${statusWords(r.to_status)}`, kind: "status" as const };
    }),
    ...fenceUpdates.map(({ at, title, kind }) => ({ at, title, kind })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 30)
    .map((u) => ({ ...u, at: u.at.toISOString() }));

  return {
    scope: {
      kind: scope.kind,
      code: scope.code,
      name: scope.name,
      project: scope.project ? { code: scope.project.code, name: scope.project.name } : null,
    },
    jobs: scope.jobs.map((j) => ({
      id: j.id,
      code: j.code,
      name: j.name,
      status: j.status,
      origin: j.originName,
      destination: j.destinationName,
      scheduledStart: j.scheduledStart,
      scheduledEnd: j.scheduledEnd,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
    })),
    shipments: scope.shipments.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      jobId: s.jobId,
      status: s.status,
      carrier: s.carrier,
      vehicle: s.vehicleName,
      sealNumbers: s.sealNumbers,
      weightKg: s.weightKg,
      volumeM3: s.volumeM3,
      distanceKm: s.distanceKm,
      eta: s.eta,
      departedAt: s.departedAt,
      arrivedAt: s.arrivedAt,
      progress: perShipment.get(s.id) ?? rollupCounts({}),
      lastPosition: newestPosition(positionFromMetadata(s.metadata), tracked.get(s.id) ?? null),
    })),
    progress,
    milestones,
    updates,
  };
}

// ---- Manifest lines ------------------------------------------------------------

const destination = alias(locations, "portal_line_destination");

/** Stage is outside the progress ladder: missing, damaged, wrong shipment, … */
const exceptionSql = (): SQL => sql`${jobItems.stage} NOT IN (${sql.join(PROGRESS.map((s) => sql`${s}`), sql`, `)})`;

const photoMatch = (stages: readonly string[]): SQL => sql`EXISTS (
  SELECT 1 FROM attachments a
   WHERE a.kind = 'photo' AND a.stage = ANY(${sql.param([...stages])}::text[])
     AND ((a.owner_type = 'item' AND a.owner_id = ${jobItems.itemId})
       OR (a.owner_type = 'unit' AND a.owner_id = ${jobItems.unitId})))`;

/** A contributor's condition note, or a photo filed as damage. */
const conditionNotedSql = (): SQL =>
  sql`(EXISTS (SELECT 1 FROM portal_notes pn WHERE pn.job_item_id = ${jobItems.id}) OR ${photoMatch(["damage"])})`;
const handlingSql = (): SQL => sql`COALESCE(btrim(${jobItems.notes}), '') <> ''`;
const valueSql = () => sql<number | null>`COALESCE(${itemUnits.valueCents}, ${items.valueCents})`;
const highValueSql = (): SQL => {
  const t = threshold();
  return t > 0 ? sql`COALESCE(${itemUnits.valueCents}, ${items.valueCents}) >= ${t}` : sql`false`;
};
const roomSql = () => sql<string | null>`COALESCE(${destination.name}, ${jobItems.destinationLabel})`;

function lineColumns() {
  return {
    id: jobItems.id,
    itemId: jobItems.itemId,
    unitId: jobItems.unitId,
    stage: jobItems.stage,
    stageAt: jobItems.stageAt,
    shipmentId: jobItems.shipmentId,
    destinationLabel: jobItems.destinationLabel,
    floor: jobItems.floor,
    department: jobItems.department,
    crateNo: jobItems.crateNo,
    notes: jobItems.notes,
    itemName: items.name,
    brand: items.brand,
    model: items.model,
    assetCode: items.assetCode,
    unitCode: itemUnits.assetCode,
    unitLabel: itemUnits.label,
    destinationName: destination.name,
    shipmentCode: shipments.code,
    valueCents: valueSql(),
    highValue: sql<boolean>`${highValueSql()}`,
    exception: sql<boolean>`${exceptionSql()}`,
    conditionNoted: sql<boolean>`${conditionNotedSql()}`,
    noteCount: sql<number>`(SELECT count(*) FROM portal_notes pn WHERE pn.job_item_id = ${jobItems.id})::int`,
    photoCount: sql<number>`(SELECT count(*) FROM attachments a
      WHERE a.kind = 'photo' AND a.stage = ANY(${sql.param(photoStages)}::text[])
        AND ((a.owner_type = 'item' AND a.owner_id = ${jobItems.itemId})
          OR (a.owner_type = 'unit' AND a.owner_id = ${jobItems.unitId})))::int`,
  };
}

function lineQuery() {
  return db
    .select(lineColumns())
    .from(jobItems)
    .innerJoin(items, eq(jobItems.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
    .leftJoin(destination, eq(jobItems.destinationLocationId, destination.id))
    .leftJoin(shipments, eq(jobItems.shipmentId, shipments.id));
}

type LineRow = Awaited<ReturnType<ReturnType<typeof lineQuery>["where"]>>[number];

function presentLine(r: LineRow, grant: PortalGrant) {
  const handling = Boolean(r.notes?.trim());
  return {
    id: r.id,
    itemName: r.itemName,
    brand: r.brand,
    model: r.model,
    code: r.unitCode ?? r.assetCode,
    assetCode: r.assetCode,
    unitCode: r.unitCode,
    unitLabel: r.unitLabel,
    stage: r.stage,
    stageAt: r.stageAt,
    shipmentId: r.shipmentId,
    shipmentCode: r.shipmentCode,
    room: r.destinationName ?? r.destinationLabel,
    destinationLabel: r.destinationLabel,
    floor: r.floor,
    department: r.department,
    crateNo: r.crateNo,
    handlingNotes: r.notes,
    flags: {
      highValue: Boolean(r.highValue),
      exception: Boolean(r.exception),
      conditionNoted: Boolean(r.conditionNoted),
      handling,
    },
    flagged: Boolean(r.highValue || r.exception || r.conditionNoted || handling),
    // Values stay out of the payload entirely unless the link may see them.
    ...(grant.showValues ? { valueCents: r.valueCents === null ? null : Number(r.valueCents) } : {}),
    noteCount: r.noteCount,
    photoCount: r.photoCount,
  };
}

export type PortalLine = ReturnType<typeof presentLine>;

export type LineQuery = {
  q?: string;
  stage?: string;
  room?: string;
  floor?: string;
  department?: string;
  shipmentId?: string;
  flag?: "flagged" | "high_value" | "exception" | "noted";
  limit?: number;
  offset?: number;
};

function assertShipmentInScope(scope: PortalScopeView, id: string): void {
  if (!scope.shipmentIds.includes(id)) throw notFound("That shipment is not part of what this link covers.");
}

function filterSql(scope: PortalScopeView, f: LineQuery): SQL {
  const conds: (SQL | undefined)[] = [scope.lines];
  if (f.stage) conds.push(eq(jobItems.stage, f.stage));
  if (f.room) conds.push(sql`${roomSql()} = ${f.room}`);
  if (f.floor) conds.push(eq(jobItems.floor, f.floor));
  if (f.department) conds.push(eq(jobItems.department, f.department));
  if (f.shipmentId) {
    assertShipmentInScope(scope, f.shipmentId);
    conds.push(eq(jobItems.shipmentId, f.shipmentId));
  }
  if (f.flag === "high_value") conds.push(highValueSql());
  if (f.flag === "exception") conds.push(exceptionSql());
  if (f.flag === "noted") conds.push(sql`(${conditionNotedSql()} OR ${handlingSql()})`);
  if (f.flag === "flagged") {
    conds.push(sql`(${highValueSql()} OR ${exceptionSql()} OR ${conditionNotedSql()} OR ${handlingSql()})`);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(
      ${items.name} ILIKE ${like} OR ${items.brand} ILIKE ${like} OR ${items.model} ILIKE ${like}
      OR ${items.assetCode} ILIKE ${like} OR ${itemUnits.assetCode} ILIKE ${like}
      OR ${jobItems.crateNo} ILIKE ${like} OR ${roomSql()} ILIKE ${like}
      OR ${jobItems.floor} ILIKE ${like} OR ${jobItems.department} ILIKE ${like}
      OR EXISTS (SELECT 1 FROM item_identifiers ii WHERE ii.item_id = ${jobItems.itemId} AND lower(ii.value) = lower(${q})))`);
  }
  return and(...conds)!;
}

const lineOrder = [
  asc(jobItems.floor),
  asc(jobItems.department),
  asc(jobItems.destinationLabel),
  asc(items.name),
  asc(itemUnits.assetCode),
  asc(jobItems.id),
];

async function facets(scope: PortalScopeView) {
  const rows = await db
    .select({
      room: roomSql(),
      floor: jobItems.floor,
      department: jobItems.department,
      stage: jobItems.stage,
      n: sql<number>`count(*)::int`,
    })
    .from(jobItems)
    .leftJoin(destination, eq(jobItems.destinationLocationId, destination.id))
    .where(scope.lines)
    .groupBy(roomSql(), jobItems.floor, jobItems.department, jobItems.stage);

  const byRoom = new Map<string, Record<string, number>>();
  const floors = new Set<string>();
  const departments = new Set<string>();
  const stages: Record<string, number> = {};
  for (const r of rows) {
    const key = r.room ?? "";
    const counts = byRoom.get(key) ?? {};
    counts[r.stage] = (counts[r.stage] ?? 0) + r.n;
    byRoom.set(key, counts);
    if (r.floor) floors.add(r.floor);
    if (r.department) departments.add(r.department);
    stages[r.stage] = (stages[r.stage] ?? 0) + r.n;
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return {
    rooms: [...byRoom.entries()]
      .map(([room, counts]) => ({ room: room || null, progress: rollupCounts(counts) }))
      .sort((a, b) => (a.room === null ? 1 : b.room === null ? -1 : collator.compare(a.room, b.room)))
      .slice(0, 300),
    floors: [...floors].sort(collator.compare),
    departments: [...departments].sort(collator.compare),
    stages,
  };
}

export async function listLines(ctx: PortalContext, f: LineQuery) {
  if (f.stage && !isStage(f.stage)) throw badRequest(`Unknown stage "${f.stage}".`);
  const where = filterSql(ctx.scope, f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [rows, [{ total } = { total: 0 }], facetData] = await Promise.all([
    lineQuery().where(where).orderBy(...lineOrder).limit(limit).offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(jobItems)
      .innerJoin(items, eq(jobItems.itemId, items.id))
      .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
      .leftJoin(destination, eq(jobItems.destinationLocationId, destination.id))
      .where(where),
    facets(ctx.scope),
  ]);
  return { lines: rows.map((r) => presentLine(r, ctx.grant)), total, facets: facetData };
}

/** One line, only when it is in scope. */
export async function findLine(ctx: PortalContext, lineId: string): Promise<LineRow> {
  if (!UUID.test(lineId)) throw lineNotFound();
  const [row] = await lineQuery().where(and(ctx.scope.lines, eq(jobItems.id, lineId))).limit(1);
  if (!row) throw lineNotFound();
  return row;
}

async function linePhotos(itemIds: string[], unitIds: string[]) {
  if (!itemIds.length && !unitIds.length) return [];
  const { rows } = await pool.query<{
    id: string;
    owner_type: string;
    owner_id: string;
    stage: string | null;
    caption: string | null;
    width: number | null;
    height: number | null;
    created_at: Date;
    by_portal: boolean;
  }>(
    `SELECT id, owner_type, owner_id, stage, caption, width, height, created_at,
            (meta ? 'portal') AS by_portal
       FROM attachments
      WHERE kind = 'photo' AND stage = ANY($3::text[])
        AND ((owner_type = 'item' AND owner_id = ANY($1::uuid[])) OR (owner_type = 'unit' AND owner_id = ANY($2::uuid[])))
      ORDER BY created_at, id`,
    [itemIds, unitIds, photoStages],
  );
  return rows.map((r) => ({
    id: r.id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    stage: r.stage,
    caption: r.caption,
    width: r.width,
    height: r.height,
    createdAt: r.created_at.toISOString(),
    byPortal: r.by_portal,
  }));
}

export async function lineDetail(ctx: PortalContext, lineId: string) {
  const row = await findLine(ctx, lineId);
  const [photos, notes, history] = await Promise.all([
    linePhotos([row.itemId], row.unitId ? [row.unitId] : []),
    db
      .select({
        id: portalNotes.id,
        author: portalNotes.author,
        condition: portalNotes.condition,
        body: portalNotes.body,
        createdAt: portalNotes.createdAt,
        mine: sql<boolean>`${portalNotes.grantId} IS NOT DISTINCT FROM ${ctx.grant.id}::uuid`,
      })
      .from(portalNotes)
      .where(eq(portalNotes.jobItemId, row.id))
      .orderBy(asc(portalNotes.createdAt)),
    db
      .select({
        from: jobItemStageHistory.fromStage,
        to: jobItemStageHistory.toStage,
        via: jobItemStageHistory.via,
        at: jobItemStageHistory.createdAt,
      })
      .from(jobItemStageHistory)
      .where(eq(jobItemStageHistory.jobItemId, row.id))
      .orderBy(desc(jobItemStageHistory.createdAt))
      .limit(50),
  ]);
  return {
    line: presentLine(row, ctx.grant),
    photos: photos.map(({ ownerType: _o, ownerId: _i, ...p }) => p),
    notes,
    history,
  };
}

export async function flaggedLines(ctx: PortalContext) {
  const rows = await lineQuery()
    .where(filterSql(ctx.scope, { flag: "flagged" }))
    .orderBy(...lineOrder)
    .limit(200);
  const photos = await linePhotos(
    [...new Set(rows.map((r) => r.itemId))],
    [...new Set(rows.map((r) => r.unitId).filter((u): u is string => Boolean(u)))],
  );
  return {
    lines: rows.map((r) => ({
      ...presentLine(r, ctx.grant),
      photoIds: photos
        .filter((p) => (p.ownerType === "item" && p.ownerId === r.itemId) || (p.ownerType === "unit" && p.ownerId === r.unitId))
        .slice(-4)
        .map((p) => p.id),
    })),
    highValueThreshold: ctx.grant.showValues ? threshold() : null,
  };
}

// ---- Documents and receipts ----------------------------------------------------

/** Records whose own files and signatures this scope shares. */
function documentOwners(scope: PortalScopeView) {
  return {
    projectIds: scope.kind === "project" ? [scope.targetId] : [],
    jobIds: scope.kind === "shipment" ? [] : scope.jobIds,
    shipmentIds: scope.shipmentIds,
  };
}

/** Owner condition on table `alias`, with the owners' ids as $1 (projects), $2 (jobs), $3 (shipments). */
const ownerSql = (alias: string) => `(
  (${alias}.owner_type = 'project' AND ${alias}.owner_id = ANY($1::uuid[]))
  OR (${alias}.owner_type = 'job' AND ${alias}.owner_id = ANY($2::uuid[]))
  OR (${alias}.owner_type = 'shipment' AND ${alias}.owner_id = ANY($3::uuid[])))`;

function ownerLabel(scope: PortalScopeView, type: string, id: string): string {
  if (type === "project") return scope.project ? `${scope.project.name} (${scope.project.code})` : "Project";
  if (type === "job") {
    const j = scope.jobs.find((x) => x.id === id);
    return j ? `${j.name} (${j.code})` : "Job";
  }
  const s = scope.shipments.find((x) => x.id === id);
  return s ? `${s.name} (${s.code})` : "Shipment";
}

const safeName = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120) : null;

export async function documents(ctx: PortalContext) {
  if (!ctx.grant.showDocuments) return { shared: false, documents: [], receipts: [] };
  const owners = documentOwners(ctx.scope);
  const params = [owners.projectIds, owners.jobIds, owners.shipmentIds];
  const [files, sigs] = await Promise.all([
    pool.query<{
      id: string;
      owner_type: string;
      owner_id: string;
      kind: string;
      mime: string;
      stage: string | null;
      caption: string | null;
      size_bytes: string;
      filename: unknown;
      created_at: Date;
    }>(
      `SELECT id, owner_type, owner_id, kind, mime, stage, caption, size_bytes, meta->'filename' AS filename, created_at
         FROM attachments a
        WHERE kind IN ('document', 'photo') AND ${ownerSql("a")}
        ORDER BY created_at DESC, id LIMIT 200`,
      params,
    ),
    pool.query<{
      id: string;
      owner_type: string;
      owner_id: string;
      signer_name: string;
      signer_role: string | null;
      statement: string;
      content_hash: string;
      attachment_id: string | null;
      signed_at: Date;
    }>(
      `SELECT id, owner_type, owner_id, signer_name, signer_role, statement, content_hash, attachment_id, signed_at
         FROM signatures s
        WHERE ${ownerSql("s")}
        ORDER BY signed_at DESC, id LIMIT 200`,
      params,
    ),
  ]);
  return {
    shared: true,
    documents: files.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      mime: r.mime,
      stage: r.stage,
      caption: r.caption,
      filename: safeName(r.filename),
      sizeBytes: Number(r.size_bytes),
      createdAt: r.created_at.toISOString(),
      owner: ownerLabel(ctx.scope, r.owner_type, r.owner_id),
    })),
    // Signer email, address and browser stay inside; the name, role, words
    // and fingerprint are what a receipt shows.
    receipts: sigs.rows.map((r) => ({
      id: r.id,
      signerName: r.signer_name,
      signerRole: r.signer_role,
      statement: r.statement,
      contentHash: r.content_hash,
      imageId: r.attachment_id,
      signedAt: r.signed_at.toISOString(),
      owner: ownerLabel(ctx.scope, r.owner_type, r.owner_id),
    })),
  };
}

// ---- Files ------------------------------------------------------------------------

/**
 * Whether this grant may fetch an attachment: a photo of a line in scope, on
 * a stage the portal shows; or, when the grant shares documents, a document,
 * photo or signature image filed on the scope's own records.
 */
async function fileAllowed(ctx: PortalContext, id: string): Promise<boolean> {
  const owners = documentOwners(ctx.scope);
  const lineCheck = ctx.scope.lines;
  const docs = ctx.grant.showDocuments;
  const rows = await db.execute(sql`
    SELECT 1 FROM attachments a
     WHERE a.id = ${id}::uuid AND (
       (a.kind = 'photo' AND a.stage = ANY(${sql.param(photoStages)}::text[]) AND EXISTS (
          SELECT 1 FROM job_items WHERE ${lineCheck}
             AND ((a.owner_type = 'item' AND job_items.item_id = a.owner_id)
               OR (a.owner_type = 'unit' AND job_items.unit_id = a.owner_id))))
       OR (${docs}::boolean AND a.kind IN ('document', 'photo', 'signature') AND (
          (a.owner_type = 'project' AND a.owner_id = ANY(${sql.param(owners.projectIds)}::uuid[]))
          OR (a.owner_type = 'job' AND a.owner_id = ANY(${sql.param(owners.jobIds)}::uuid[]))
          OR (a.owner_type = 'shipment' AND a.owner_id = ANY(${sql.param(owners.shipmentIds)}::uuid[]))))
     )`);
  return rows.rows.length > 0;
}

export type PortalFile =
  | { kind: "bytes"; mime: string; bytes: Buffer; filename: string; inline: boolean }
  | { kind: "stream"; mime: string; stream: Readable; size: number; filename: string; inline: boolean };

const inlineMime = (mime: string) => mime.startsWith("image/") || mime === "application/pdf";

export async function openFile(ctx: PortalContext, id: string, thumbWidth?: number): Promise<PortalFile> {
  const missing = () => notFound("That file is not shared through this link.");
  if (!UUID.test(id) || !(await fileAllowed(ctx, id))) throw missing();
  if (thumbWidth) {
    const t = await thumbnail(id, thumbWidth);
    if (!t) throw missing();
    return { kind: "bytes", mime: "image/jpeg", bytes: t.bytes, filename: `${id.slice(0, 8)}.jpg`, inline: true };
  }
  const opened = await getAttachmentStream(id);
  if (opened.status === 416) throw missing();
  const a = opened.attachment;
  const ext = a.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  return {
    kind: "stream",
    mime: a.mime,
    stream: opened.stream,
    size: opened.size,
    filename: safeName(a.meta.filename) ?? `${a.kind}-${a.id.slice(0, 8)}.${ext}`,
    inline: inlineMime(a.mime),
  };
}

/** Line summaries by id, for scan results. Only lines in scope come back. */
export async function lineSummaries(ctx: PortalContext, ids: string[]) {
  if (!ids.length) return new Map<string, PortalLine>();
  const rows = await lineQuery().where(and(ctx.scope.lines, inArray(jobItems.id, ids)));
  return new Map(rows.map((r) => [r.id, presentLine(r, ctx.grant)]));
}
