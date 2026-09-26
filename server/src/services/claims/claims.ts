import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import {
  attachments,
  claimActivity,
  claimLines,
  claims,
  itemUnits,
  items,
  jobItems,
  jobs,
  locations,
  shipments,
  users,
  type Claim,
  type ClaimActivity,
  type ClaimActivityKind,
  type ClaimLine,
  type ClaimResolution,
  type ClaimStatus,
  type ClaimType,
} from "../../db/schema";
import { env } from "../../env";
import { HttpError, badRequest, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { isExceptionStage, resolveScanCodes, stageLabel } from "../jobs-core";
import { deleteAttachmentsForOwner } from "../media-ai-core";
import { announce } from "./events";
import { buildEvidence } from "./evidence";
import { OPEN_STATUSES, TYPE_INFO, isIncidentCategory, isMoneyType } from "./model";
import { clean, decisionRefusal, withClaimCode, type ClaimActor } from "./shared";
import { claimTotals, normalizeLineDecision, type ClaimTotals } from "./totals";
import { checkTransition, computeSla, transitionStamps, transitionsFrom, type Sla, type Transition } from "./workflow";

/**
 * Claims and incident reports: opening them, their lines, the workflow, the
 * reviewer, comments. The evidence pack is in evidence.ts; printing in
 * documents.ts.
 */

type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export type LineInput = {
  /** The manifest line the item travelled on. Implies the item and unit. */
  jobItemId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  /** Anything a scan produces: asset or unit code, serial, RFID EPC, label link. */
  code?: string | null;
  description?: string | null;
  damageDescription?: string | null;
  estimatedCents?: number | null;
  notes?: string | null;
};

export type LinePatch = {
  description?: string | null;
  damageDescription?: string | null;
  estimatedCents?: number | null;
  approvedCents?: number | null;
  resolution?: ClaimResolution | null;
  notes?: string | null;
};

export type ClaimInput = {
  type: ClaimType;
  title: string;
  description?: string | null;
  category?: string | null;
  jobId?: string | null;
  shipmentId?: string | null;
  locationId?: string | null;
  occurredAt?: string | null;
  carrierReference?: string | null;
  insurerReference?: string | null;
  estimatedTotalCents?: number | null;
  /** Someone else's report taken down by the person entering it (a customer who phoned). */
  reporterName?: string | null;
  reporterEmail?: string | null;
  /** The incident report a claim grew out of. */
  relatedClaimId?: string | null;
  lines?: LineInput[];
};

export type ClaimPatch = Partial<Omit<ClaimInput, "lines" | "relatedClaimId">> & {
  approvedTotalCents?: number | null;
  paymentReference?: string | null;
  slaDueAt?: string | null;
};

export const slaHoursFor = (type: ClaimType): number =>
  type === "incident" ? env.INCIDENT_SLA_HOURS : env.CLAIMS_SLA_HOURS;

const EDITABLE: readonly ClaimStatus[] = OPEN_STATUSES;
const DECIDING: readonly ClaimStatus[] = ["submitted", "under_review"];

// --- Loading ------------------------------------------------------------------------

async function loadClaim(id: string, ex: Executor = db, lock = false): Promise<Claim> {
  const q = ex.select().from(claims).where(eq(claims.id, id)).limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("Claim not found. It may have been deleted.");
  return row;
}

async function loadLines(claimId: string, ex: Executor = db): Promise<ClaimLine[]> {
  return ex.select().from(claimLines).where(eq(claimLines.claimId, claimId)).orderBy(asc(claimLines.position), asc(claimLines.createdAt));
}

function assertEditable(claim: Claim): void {
  if (!EDITABLE.includes(claim.status)) {
    throw badRequest(
      `${claim.code} is ${claim.status.replace(/_/g, " ")}. Reopen it to change it.`,
    );
  }
}

function assertMoneyAllowed(type: ClaimType, fields: Record<string, unknown>): void {
  if (isMoneyType(type)) return;
  const money = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
  if (money.length) {
    throw badRequest("Incident reports carry no money. Leave amounts and resolutions off, or open a claim instead.");
  }
}

function assertDecider(claim: Claim, actor: ClaimActor): void {
  const refusal = decisionRefusal(claim, actor);
  if (refusal) throw forbidden(refusal);
}

// --- Resolving lines -----------------------------------------------------------------

export type ResolvedLine = {
  jobItemId: string | null;
  /** The job and shipment the manifest line is on, when there is one. */
  jobId: string | null;
  shipmentId: string | null;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  declaredValueCents: number | null;
  input: LineInput;
};

export type LineProblem = { input: string; problem: string };

const refKey = (itemId: string, unitId: string | null) => `${itemId}:${unitId ?? ""}`;

/**
 * Turn what a person picked or scanned into lines: the item, the unit, the
 * manifest line when the claim has a job, and a snapshot of the name, code and
 * declared value. Everything is looked up in a few batched queries. What
 * cannot be resolved comes back as a problem, never a guess.
 */
export async function resolveLines(
  inputs: readonly LineInput[],
  ctx: { jobId: string | null },
): Promise<{ lines: ResolvedLine[]; problems: LineProblem[] }> {
  const problems: LineProblem[] = [];
  type Ref = { itemId: string; unitId: string | null; jobItemId: string | null; input: LineInput };
  const refs: Ref[] = [];

  const jobItemIds = inputs.map((i) => i.jobItemId).filter((v): v is string => Boolean(v));
  const jobLineRows = jobItemIds.length
    ? await db
        .select({ id: jobItems.id, jobId: jobItems.jobId, itemId: jobItems.itemId, unitId: jobItems.unitId })
        .from(jobItems)
        .where(inArray(jobItems.id, jobItemIds))
    : [];
  const jobLineById = new Map(jobLineRows.map((r) => [r.id, r]));

  const codes = inputs.map((i) => clean(i.code)).filter((c): c is string => c !== null);
  const resolved = codes.length ? await resolveScanCodes(codes) : new Map();

  for (const input of inputs) {
    if (input.jobItemId) {
      const jl = jobLineById.get(input.jobItemId);
      if (!jl) {
        problems.push({ input: input.jobItemId, problem: "That manifest line does not exist. It may have been removed from its job." });
        continue;
      }
      if (ctx.jobId && jl.jobId !== ctx.jobId) {
        problems.push({ input: input.jobItemId, problem: "That manifest line is on a different job from this claim." });
        continue;
      }
      refs.push({ itemId: jl.itemId, unitId: jl.unitId, jobItemId: jl.id, input });
    } else if (input.itemId) {
      refs.push({ itemId: input.itemId, unitId: input.unitId ?? null, jobItemId: null, input });
    } else {
      const code = clean(input.code);
      if (!code) {
        problems.push({ input: "", problem: "Each line needs an item: a manifest line, an item, or a code to look up." });
        continue;
      }
      const found = (resolved.get(code) ?? []) as { itemId: string; unitId: string | null }[];
      if (found.length === 0) problems.push({ input: code, problem: "Nothing has that code." });
      else if (found.length > 1) problems.push({ input: code, problem: "More than one record has that code. Scan the asset label instead." });
      else refs.push({ itemId: found[0]!.itemId, unitId: found[0]!.unitId, jobItemId: null, input });
    }
  }

  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  const unitIds = [...new Set(refs.map((r) => r.unitId).filter((u): u is string => u !== null))];
  const [itemRows, unitRows] = await Promise.all([
    itemIds.length
      ? db
          .select({ id: items.id, name: items.name, assetCode: items.assetCode, valueCents: items.valueCents })
          .from(items)
          .where(inArray(items.id, itemIds))
      : [],
    unitIds.length
      ? db
          .select({
            id: itemUnits.id,
            itemId: itemUnits.itemId,
            assetCode: itemUnits.assetCode,
            label: itemUnits.label,
            valueCents: itemUnits.valueCents,
          })
          .from(itemUnits)
          .where(inArray(itemUnits.id, unitIds))
      : [],
  ]);
  const itemById = new Map(itemRows.map((r) => [r.id, r]));
  const unitById = new Map(unitRows.map((r) => [r.id, r]));

  // With a job, each item is matched to its manifest line: the unit's own
  // line first, then a line for the whole item.
  const jobMatches = new Map<string, { id: string; shipmentId: string | null }>();
  if (ctx.jobId && itemIds.length) {
    const rows = await db
      .select({ id: jobItems.id, itemId: jobItems.itemId, unitId: jobItems.unitId, shipmentId: jobItems.shipmentId })
      .from(jobItems)
      .where(and(eq(jobItems.jobId, ctx.jobId), inArray(jobItems.itemId, itemIds)));
    for (const r of rows) jobMatches.set(refKey(r.itemId, r.unitId), { id: r.id, shipmentId: r.shipmentId });
  }
  const jobLineShipment = new Map(
    (jobItemIds.length
      ? await db.select({ id: jobItems.id, shipmentId: jobItems.shipmentId }).from(jobItems).where(inArray(jobItems.id, jobItemIds))
      : []
    ).map((r) => [r.id, r.shipmentId]),
  );

  const lines: ResolvedLine[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const item = itemById.get(ref.itemId);
    if (!item) {
      problems.push({ input: ref.itemId, problem: "That item does not exist. It may have been deleted." });
      continue;
    }
    const unit = ref.unitId ? unitById.get(ref.unitId) : null;
    if (ref.unitId && (!unit || unit.itemId !== item.id)) {
      problems.push({ input: ref.unitId, problem: `That unit is not one of ${item.name}'s.` });
      continue;
    }
    const key = refKey(item.id, ref.unitId);
    if (seen.has(key)) continue;
    seen.add(key);

    let jobItemId = ref.jobItemId;
    let jobId = ref.jobItemId ? jobLineById.get(ref.jobItemId)!.jobId : null;
    let shipmentId = ref.jobItemId ? jobLineShipment.get(ref.jobItemId) ?? null : null;
    if (!jobItemId && ctx.jobId) {
      const match = jobMatches.get(key) ?? (ref.unitId ? jobMatches.get(refKey(item.id, null)) : undefined);
      if (match) {
        jobItemId = match.id;
        jobId = ctx.jobId;
        shipmentId = match.shipmentId;
      }
    }
    lines.push({
      jobItemId,
      jobId,
      shipmentId,
      itemId: item.id,
      unitId: ref.unitId,
      itemName: unit?.label ? `${item.name} · ${unit.label}` : item.name,
      assetCode: unit?.assetCode ?? item.assetCode,
      declaredValueCents: unit?.valueCents ?? item.valueCents ?? null,
      input: ref.input,
    });
  }
  return { lines, problems };
}

function lineValues(claimId: string, line: ResolvedLine, position: number): typeof claimLines.$inferInsert {
  return {
    claimId,
    position,
    jobItemId: line.jobItemId,
    itemId: line.itemId,
    unitId: line.unitId,
    itemName: line.itemName,
    assetCode: line.assetCode,
    declaredValueCents: line.declaredValueCents,
    description: clean(line.input.description),
    damageDescription: clean(line.input.damageDescription),
    estimatedCents: line.input.estimatedCents ?? null,
    notes: clean(line.input.notes),
  };
}

/** Keep the claim's totals equal to its lines' sums, in the same transaction as the change. */
async function syncTotals(tx: Executor, claim: Claim): Promise<Claim> {
  const lines = await loadLines(claim.id, tx);
  if (!lines.length) return claim;
  const totals = claimTotals(lines, claim);
  const [row] = await tx
    .update(claims)
    .set({ estimatedTotalCents: totals.estimatedTotalCents, approvedTotalCents: totals.approvedTotalCents, updatedAt: new Date() })
    .where(eq(claims.id, claim.id))
    .returning();
  return row!;
}

async function addActivity(
  tx: Executor,
  claimId: string,
  kind: ClaimActivityKind,
  actor: ClaimActor,
  fields: Partial<Pick<ClaimActivity, "fromStatus" | "toStatus" | "body" | "detail">> = {},
): Promise<ClaimActivity> {
  const [row] = await tx
    .insert(claimActivity)
    .values({
      claimId,
      kind,
      fromStatus: fields.fromStatus ?? null,
      toStatus: fields.toStatus ?? null,
      body: fields.body ?? null,
      detail: fields.detail ?? {},
      authorUserOid: actor.userOid,
      authorName: actor.name,
      authorGrantId: actor.grantId ?? null,
    })
    .returning();
  return row!;
}

/** A job and shipment that agree with each other; a shipment alone implies its job. */
async function jobAndShipment(
  jobId: string | null | undefined,
  shipmentId: string | null | undefined,
): Promise<{ jobId: string | null; shipmentId: string | null }> {
  if (shipmentId) {
    const [s] = await db.select({ jobId: shipments.jobId, code: shipments.code }).from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!s) throw badRequest("That shipment does not exist. Pick one that does.");
    if (jobId && s.jobId !== jobId) throw badRequest(`${s.code} belongs to a different job. Pick one of this job's shipments.`);
    return { jobId: s.jobId, shipmentId };
  }
  if (jobId) {
    const [j] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!j) throw badRequest("That job does not exist. Pick one that does.");
  }
  return { jobId: jobId ?? null, shipmentId: null };
}

function problemsError(problems: LineProblem[]): HttpError {
  const first = problems[0]!;
  return new HttpError(
    400,
    "line_problems",
    `${first.input ? `${first.input}: ` : ""}${first.problem}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`,
    { problems },
  );
}

function validateCategory(type: ClaimType, category: string | null | undefined): string | null {
  const c = clean(category);
  if (!c) return null;
  if (type !== "incident") throw badRequest("Only incident reports have a category.");
  if (!isIncidentCategory(c)) throw badRequest(`Unknown incident category "${c}".`);
  return c;
}

// --- Creating -------------------------------------------------------------------------

export async function createClaim(input: ClaimInput, actor: ClaimActor): Promise<ClaimDetail> {
  const title = clean(input.title);
  if (!title) throw badRequest("Give the claim a short title, such as what was damaged and where.");
  const category = validateCategory(input.type, input.category);
  assertMoneyAllowed(input.type, { estimatedTotalCents: input.estimatedTotalCents });
  const lineInputs = input.lines ?? [];
  assertMoneyAllowed(input.type, { estimatedCents: lineInputs.find((l) => l.estimatedCents != null)?.estimatedCents });

  let { jobId, shipmentId } = await jobAndShipment(input.jobId, input.shipmentId);
  const { lines, problems } = await resolveLines(lineInputs, { jobId });
  if (problems.length) throw problemsError(problems);

  // Lines picked from one job (or one shipment) say which the claim is about.
  if (!jobId) {
    const lineJobs = new Set(lines.map((l) => l.jobId));
    if (lineJobs.size === 1 && !lineJobs.has(null)) jobId = [...lineJobs][0]!;
  }
  if (!shipmentId && jobId) {
    const lineShipments = new Set(lines.map((l) => l.shipmentId));
    if (lines.length && lineShipments.size === 1 && !lineShipments.has(null)) shipmentId = [...lineShipments][0]!;
  }

  const config = await getConfig();
  const reporterName = clean(input.reporterName) ?? actor.name;
  const onBehalf = Boolean(clean(input.reporterName));

  const { claim, activity } = await withClaimCode(input.type, (code) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(claims)
        .values({
          code,
          type: input.type,
          category,
          title,
          description: clean(input.description),
          jobId,
          shipmentId,
          locationId: input.locationId ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
          // Taken down for someone else: they are the reporter, not the account.
          reporterUserOid: onBehalf ? null : actor.userOid,
          reporterGrantId: actor.grantId ?? null,
          reporterName,
          reporterEmail: clean(input.reporterEmail) ?? actor.email ?? null,
          currency: config.currency,
          estimatedTotalCents: input.estimatedTotalCents ?? null,
          carrierReference: clean(input.carrierReference),
          insurerReference: clean(input.insurerReference),
          metadata: input.relatedClaimId ? { relatedClaimId: input.relatedClaimId } : {},
          createdBy: actor.userOid,
        })
        .returning();
      let created = row!;
      if (lines.length) {
        await tx.insert(claimLines).values(lines.map((l, i) => lineValues(created.id, l, i + 1))).onConflictDoNothing();
        created = await syncTotals(tx, created);
      }
      const activity = await addActivity(tx, created.id, "created", actor, {
        toStatus: "draft",
        body: onBehalf ? `Reported by ${reporterName}, entered by ${actor.name ?? "someone"}.` : null,
        detail: { lines: lines.length },
      });
      return { claim: created, activity };
    }),
  );

  logger.info("claims.created", { claimId: claim.id, code: claim.code, type: claim.type, lines: lines.length });
  await announce("claim.created", claim, { lines: lines.length, reporter: claim.reporterName }, actor, activity.id);
  return getClaim(claim.id, actor);
}

// --- Reading --------------------------------------------------------------------------

export type ClaimFilters = {
  status?: ClaimStatus[];
  type?: ClaimType;
  /** Claims ask for money; incidents do not. */
  kind?: "claim" | "incident";
  jobId?: string;
  shipmentId?: string;
  /** A user id, or "none" for unassigned. */
  assignee?: string;
  q?: string;
  overdue?: boolean;
  limit?: number;
  offset?: number;
};

export type ClaimSummary = Claim & {
  jobCode: string | null;
  shipmentCode: string | null;
  lineCount: number;
  sla: Sla;
};

export async function listClaims(filters: ClaimFilters = {}): Promise<{ claims: ClaimSummary[]; total: number }> {
  const q = filters.q?.trim();
  const now = new Date();
  const where = and(
    filters.status?.length ? inArray(claims.status, filters.status) : undefined,
    filters.type ? eq(claims.type, filters.type) : undefined,
    filters.kind === "incident" ? eq(claims.type, "incident") : filters.kind === "claim" ? sql`${claims.type} <> 'incident'` : undefined,
    filters.jobId ? eq(claims.jobId, filters.jobId) : undefined,
    filters.shipmentId ? eq(claims.shipmentId, filters.shipmentId) : undefined,
    filters.assignee === "none" ? isNull(claims.assigneeUserOid) : filters.assignee ? eq(claims.assigneeUserOid, filters.assignee) : undefined,
    filters.overdue
      ? and(inArray(claims.status, ["submitted", "under_review"]), lt(claims.slaDueAt, now))
      : undefined,
    q
      ? or(
          ilike(claims.code, `%${q}%`),
          ilike(claims.title, `%${q}%`),
          ilike(claims.carrierReference, `%${q}%`),
          ilike(claims.insurerReference, `%${q}%`),
          ilike(claims.reporterName, `%${q}%`),
        )
      : undefined,
  );
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 200), 1), 1000);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const lineCount = sql<number>`(SELECT count(*)::int FROM claim_lines l WHERE l.claim_id = ${claims.id})`;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ claim: claims, jobCode: jobs.code, shipmentCode: shipments.code, lineCount })
      .from(claims)
      .leftJoin(jobs, eq(claims.jobId, jobs.id))
      .leftJoin(shipments, eq(claims.shipmentId, shipments.id))
      .where(where)
      .orderBy(desc(claims.createdAt), desc(claims.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(claims).where(where),
  ]);
  return {
    total,
    claims: rows.map((r) => ({
      ...r.claim,
      jobCode: r.jobCode,
      shipmentCode: r.shipmentCode,
      lineCount: r.lineCount,
      sla: computeSla(r.claim, now),
    })),
  };
}

export type ClaimLineView = ClaimLine & {
  /** The item's name now, which may differ from the snapshot taken when the line was added. */
  currentItemName: string | null;
  stage: string | null;
  stageLabel: string | null;
  jobCode: string | null;
  shipmentCode: string | null;
  photoCount: number;
};

export type ClaimDetail = Claim & {
  jobCode: string | null;
  jobName: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
  locationName: string | null;
  lines: ClaimLineView[];
  activity: ClaimActivity[];
  totals: ClaimTotals;
  sla: Sla;
  /** The moves open from here, for this type. */
  transitions: Transition[];
  /** Whether the person asking may approve, deny or pay, and if not, why. */
  viewer: { canDecide: boolean; decideRefusal: string | null };
};

export async function getClaim(id: string, viewer?: ClaimActor): Promise<ClaimDetail> {
  const [head] = await db
    .select({
      claim: claims,
      jobCode: jobs.code,
      jobName: jobs.name,
      shipmentCode: shipments.code,
      shipmentName: shipments.name,
      locationName: locations.name,
    })
    .from(claims)
    .leftJoin(jobs, eq(claims.jobId, jobs.id))
    .leftJoin(shipments, eq(claims.shipmentId, shipments.id))
    .leftJoin(locations, eq(claims.locationId, locations.id))
    .where(eq(claims.id, id))
    .limit(1);
  if (!head) throw notFound("Claim not found. It may have been deleted.");
  const claim = head.claim;

  const lineShipments = schema.shipments;
  const [lineRows, activity] = await Promise.all([
    db
      .select({
        line: claimLines,
        currentItemName: items.name,
        stage: jobItems.stage,
        jobCode: jobs.code,
        shipmentCode: lineShipments.code,
      })
      .from(claimLines)
      .leftJoin(items, eq(claimLines.itemId, items.id))
      .leftJoin(jobItems, eq(claimLines.jobItemId, jobItems.id))
      .leftJoin(jobs, eq(jobItems.jobId, jobs.id))
      .leftJoin(lineShipments, eq(jobItems.shipmentId, lineShipments.id))
      .where(eq(claimLines.claimId, id))
      .orderBy(asc(claimLines.position), asc(claimLines.createdAt)),
    db.select().from(claimActivity).where(eq(claimActivity.claimId, id)).orderBy(asc(claimActivity.createdAt), asc(claimActivity.id)),
  ]);

  const photoCounts = await countPhotos(lineRows.map((r) => r.line));
  const lines: ClaimLineView[] = lineRows.map((r) => ({
    ...r.line,
    currentItemName: r.currentItemName,
    stage: r.stage,
    stageLabel: r.stage ? stageLabel(r.stage) : null,
    jobCode: r.jobCode,
    shipmentCode: r.shipmentCode,
    photoCount: photoCounts.get(r.line.id) ?? 0,
  }));
  const refusal = viewer ? decisionRefusal(claim, viewer) : "Sign in to decide claims.";
  return {
    ...claim,
    jobCode: head.jobCode,
    jobName: head.jobName,
    shipmentCode: head.shipmentCode,
    shipmentName: head.shipmentName,
    locationName: head.locationName,
    lines,
    activity,
    totals: claimTotals(lines, claim),
    sla: computeSla(claim, new Date()),
    transitions: transitionsFrom(claim.type, claim.status),
    viewer: { canDecide: refusal === null, decideRefusal: refusal },
  };
}

/** Photos on file for each line: its item's, its unit's and its own. */
async function countPhotos(lines: readonly ClaimLine[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const owners = new Map<string, string[]>();
  const add = (ownerId: string | null, lineId: string) => {
    if (!ownerId) return;
    owners.set(ownerId, [...(owners.get(ownerId) ?? []), lineId]);
  };
  for (const l of lines) {
    add(l.itemId, l.id);
    add(l.unitId, l.id);
    add(l.id, l.id);
  }
  if (!owners.size) return out;
  const rows = await db
    .select({ ownerType: attachments.ownerType, ownerId: attachments.ownerId, n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(
      and(
        inArray(attachments.ownerType, ["item", "unit", "claim_line"]),
        inArray(attachments.ownerId, [...owners.keys()]),
        inArray(attachments.kind, ["photo", "video"]),
      ),
    )
    .groupBy(attachments.ownerType, attachments.ownerId);
  for (const r of rows) {
    for (const lineId of owners.get(r.ownerId) ?? []) {
      const line = lines.find((l) => l.id === lineId)!;
      // An item's photos count for its unit lines too, but not the other way round.
      const applies =
        (r.ownerType === "item" && r.ownerId === line.itemId) ||
        (r.ownerType === "unit" && r.ownerId === line.unitId) ||
        (r.ownerType === "claim_line" && r.ownerId === line.id);
      if (applies) out.set(lineId, (out.get(lineId) ?? 0) + r.n);
    }
  }
  return out;
}

export async function getEvidence(id: string) {
  const claim = await loadClaim(id);
  const [lines, activity] = await Promise.all([
    loadLines(id),
    db.select().from(claimActivity).where(eq(claimActivity.claimId, id)).orderBy(asc(claimActivity.createdAt)),
  ]);
  return buildEvidence(claim, lines, activity);
}

// --- Editing ----------------------------------------------------------------------------

export async function updateClaim(id: string, patch: ClaimPatch, actor: ClaimActor): Promise<ClaimDetail> {
  const current = await loadClaim(id);
  if (current.status === "closed") throw badRequest(`${current.code} is closed. Reopen it to change it.`);

  const set: Partial<typeof claims.$inferInsert> = {};
  const changed: string[] = [];
  const touch = <K extends keyof typeof claims.$inferInsert>(key: K, value: (typeof claims.$inferInsert)[K]) => {
    set[key] = value;
    changed.push(key);
  };

  if (patch.type !== undefined && patch.type !== current.type) {
    if (current.status !== "draft") throw badRequest("The type can only be changed while the claim is a draft.");
    if (isMoneyType(patch.type) !== isMoneyType(current.type)) {
      throw badRequest(
        patch.type === "incident"
          ? "A claim cannot become an incident report. Open an incident report separately."
          : "An incident report cannot become a claim. Open a claim from it instead, so the report stays as it was.",
      );
    }
    touch("type", patch.type);
  }
  const type = patch.type ?? current.type;

  if (patch.title !== undefined) {
    const title = clean(patch.title);
    if (!title) throw badRequest("A claim needs a title.");
    touch("title", title);
  }
  if (patch.description !== undefined) touch("description", clean(patch.description));
  if (patch.category !== undefined) touch("category", validateCategory(type, patch.category));
  if (patch.locationId !== undefined) touch("locationId", patch.locationId);
  if (patch.occurredAt !== undefined) touch("occurredAt", patch.occurredAt ? new Date(patch.occurredAt) : null);
  if (patch.carrierReference !== undefined) touch("carrierReference", clean(patch.carrierReference));
  if (patch.insurerReference !== undefined) touch("insurerReference", clean(patch.insurerReference));
  if (patch.paymentReference !== undefined) touch("paymentReference", clean(patch.paymentReference));
  if (patch.reporterName !== undefined) touch("reporterName", clean(patch.reporterName));
  if (patch.reporterEmail !== undefined) touch("reporterEmail", clean(patch.reporterEmail));

  if (patch.jobId !== undefined || patch.shipmentId !== undefined) {
    assertEditable(current);
    const next = await jobAndShipment(
      patch.jobId !== undefined ? patch.jobId : current.jobId,
      patch.shipmentId !== undefined ? patch.shipmentId : patch.jobId !== undefined && patch.jobId !== current.jobId ? null : current.shipmentId,
    );
    if (next.jobId !== current.jobId) touch("jobId", next.jobId);
    if (next.shipmentId !== current.shipmentId) touch("shipmentId", next.shipmentId);
  }

  if (patch.estimatedTotalCents !== undefined || patch.approvedTotalCents !== undefined) {
    assertMoneyAllowed(type, { estimatedTotalCents: patch.estimatedTotalCents, approvedTotalCents: patch.approvedTotalCents });
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(claimLines)
      .where(eq(claimLines.claimId, id));
    if (n > 0) throw badRequest("This claim's totals are the sums of its lines. Change the lines instead.");
    if (patch.estimatedTotalCents !== undefined) {
      assertEditable(current);
      touch("estimatedTotalCents", patch.estimatedTotalCents);
    }
    if (patch.approvedTotalCents !== undefined) {
      if (!DECIDING.includes(current.status)) throw badRequest("Submit the claim before entering what is approved.");
      assertDecider(current, actor);
      touch("approvedTotalCents", patch.approvedTotalCents);
    }
  }

  if (patch.slaDueAt !== undefined) {
    if (!DECIDING.includes(current.status)) throw badRequest("The deadline runs from submission until a decision. It can only be moved in between.");
    if (!patch.slaDueAt) throw badRequest("A submitted claim needs a deadline.");
    assertDecider(current, actor);
    touch("slaDueAt", new Date(patch.slaDueAt));
    // A moved deadline is a new one: announce the breach again if it passes.
    set.slaBreachedAt = null;
  }

  if (!changed.length) return getClaim(id, actor);
  const { claim, activity } = await db.transaction(async (tx) => {
    const [row] = await tx.update(claims).set({ ...set, updatedAt: new Date() }).where(eq(claims.id, id)).returning();
    const activity = await addActivity(tx, id, "update", actor, { detail: { changed } });
    return { claim: row!, activity };
  });
  await announce("claim.updated", claim, { changed }, actor, activity.id);
  return getClaim(id, actor);
}

export async function deleteClaim(id: string, actor: ClaimActor): Promise<void> {
  const claim = await loadClaim(id);
  if (claim.status !== "draft") {
    throw badRequest(`${claim.code} has been submitted, so it is part of the record. Close it instead of deleting it.`);
  }
  if (actor.role !== "admin" && claim.createdBy !== actor.userOid) {
    throw forbidden("Only whoever opened a draft, or an administrator, can delete it.");
  }
  const lineIds = (await loadLines(id)).map((l) => l.id);
  await db.delete(claims).where(eq(claims.id, id));
  // Files go now rather than waiting for the orphan sweep.
  await Promise.all([
    deleteAttachmentsForOwner("claim", id),
    ...lineIds.map((lineId) => deleteAttachmentsForOwner("claim_line", lineId)),
  ]).catch((err) => logger.warn("claims.delete.files_failed", { claimId: id, err: String(err) }));
  logger.info("claims.deleted", { claimId: id, code: claim.code });
}

// --- Lines --------------------------------------------------------------------------------

export async function addLines(
  id: string,
  inputs: LineInput[],
  actor: ClaimActor,
): Promise<{ added: number; alreadyOnClaim: number; problems: LineProblem[]; claim: ClaimDetail }> {
  const current = await loadClaim(id);
  assertEditable(current);
  assertMoneyAllowed(current.type, { estimatedCents: inputs.find((l) => l.estimatedCents != null)?.estimatedCents });
  const { lines, problems } = await resolveLines(inputs, { jobId: current.jobId });

  let added = 0;
  const result = lines.length
    ? await db.transaction(async (tx) => {
        const claim = await loadClaim(id, tx, true);
        assertEditable(claim);
        const [{ max } = { max: 0 }] = await tx
          .select({ max: sql<number>`coalesce(max(${claimLines.position}), 0)::int` })
          .from(claimLines)
          .where(eq(claimLines.claimId, id));
        const inserted = await tx
          .insert(claimLines)
          .values(lines.map((l, i) => lineValues(id, l, max + i + 1)))
          .onConflictDoNothing()
          .returning({ id: claimLines.id });
        added = inserted.length;
        if (!added) return null;
        const updated = await syncTotals(tx, claim);
        const activity = await addActivity(tx, id, "lines", actor, { detail: { added: inserted.map((r) => r.id) } });
        return { claim: updated, activity };
      })
    : null;
  if (result) {
    await announce("claim.lines_changed", result.claim, { added, updated: 0, removed: 0 }, actor, result.activity.id);
  }
  return { added, alreadyOnClaim: lines.length - added, problems, claim: await getClaim(id, actor) };
}

export async function updateLine(id: string, lineId: string, patch: LinePatch, actor: ClaimActor): Promise<ClaimDetail> {
  const decides = patch.approvedCents !== undefined || patch.resolution !== undefined;
  const { claim, activity, fields } = await db.transaction(async (tx) => {
    const claim = await loadClaim(id, tx, true);
    assertEditable(claim);
    assertMoneyAllowed(claim.type, {
      estimatedCents: patch.estimatedCents,
      approvedCents: patch.approvedCents,
      resolution: patch.resolution,
    });
    if (decides) {
      if (!DECIDING.includes(claim.status)) throw badRequest("Submit the claim before deciding its lines.");
      assertDecider(claim, actor);
    }
    const [line] = await tx.select().from(claimLines).where(and(eq(claimLines.id, lineId), eq(claimLines.claimId, id))).limit(1);
    if (!line) throw notFound("That line is not on this claim.");

    const next = normalizeLineDecision({
      ...line,
      ...(patch.description !== undefined ? { description: clean(patch.description) } : {}),
      ...(patch.damageDescription !== undefined ? { damageDescription: clean(patch.damageDescription) } : {}),
      ...(patch.notes !== undefined ? { notes: clean(patch.notes) } : {}),
      ...(patch.estimatedCents !== undefined ? { estimatedCents: patch.estimatedCents } : {}),
      ...(patch.approvedCents !== undefined ? { approvedCents: patch.approvedCents } : {}),
      ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
    });
    const fields = Object.keys(patch).filter((k) => patch[k as keyof LinePatch] !== undefined);
    await tx
      .update(claimLines)
      .set({
        description: next.description,
        damageDescription: next.damageDescription,
        notes: next.notes,
        estimatedCents: next.estimatedCents,
        approvedCents: next.approvedCents,
        resolution: next.resolution,
        updatedAt: new Date(),
      })
      .where(eq(claimLines.id, lineId));
    const updated = await syncTotals(tx, claim);
    const activity = await addActivity(tx, id, "lines", actor, { detail: { updated: [lineId], fields } });
    return { claim: updated, activity, fields };
  });
  await announce("claim.lines_changed", claim, { added: 0, updated: 1, removed: 0, lineId, fields }, actor, activity.id);
  return getClaim(id, actor);
}

export async function removeLine(id: string, lineId: string, actor: ClaimActor): Promise<ClaimDetail> {
  const { claim, activity } = await db.transaction(async (tx) => {
    const claim = await loadClaim(id, tx, true);
    assertEditable(claim);
    const removed = await tx
      .delete(claimLines)
      .where(and(eq(claimLines.id, lineId), eq(claimLines.claimId, id)))
      .returning({ id: claimLines.id, itemName: claimLines.itemName });
    if (!removed.length) throw notFound("That line is not on this claim.");
    const updated = await syncTotals(tx, claim);
    const activity = await addActivity(tx, id, "lines", actor, { detail: { removed: [lineId], itemName: removed[0]!.itemName } });
    return { claim: updated, activity };
  });
  await deleteAttachmentsForOwner("claim_line", lineId).catch(() => undefined);
  await announce("claim.lines_changed", claim, { added: 0, updated: 0, removed: 1, lineId }, actor, activity.id);
  return getClaim(id, actor);
}

// --- Workflow --------------------------------------------------------------------------------

export type StatusInput = {
  status: ClaimStatus;
  note?: string | null;
  /** When marking paid: what was paid, if not the approved total. */
  paidTotalCents?: number | null;
  paymentReference?: string | null;
};

const CHECK_STATUS: Record<string, number> = { note_required: 400, amount_required: 400, lines_required: 400 };

export async function setStatus(id: string, input: StatusInput, actor: ClaimActor): Promise<ClaimDetail> {
  const to = input.status;
  const note = clean(input.note);

  // The fingerprint of what was on file when it was submitted. Read before the
  // transaction; the status is checked again inside it.
  let evidenceHash: string | null = null;
  if (to === "submitted") {
    const before = await loadClaim(id);
    evidenceHash = (await buildEvidence(before, await loadLines(id))).hash;
  }

  const { claim, from, activity } = await db.transaction(async (tx) => {
    const claim = await loadClaim(id, tx, true);
    const lines = await loadLines(id, tx);
    const totals = claimTotals(lines, claim);
    const check = checkTransition({ type: claim.type, status: claim.status, to, note, totals });
    if (!check.ok) throw new HttpError(CHECK_STATUS[check.code] ?? 409, check.code, check.message);
    if (check.transition.decision) assertDecider(claim, actor);

    const now = new Date();
    const set: Partial<typeof claims.$inferInsert> = {
      status: to,
      ...transitionStamps(claim, to, now, slaHoursFor(claim.type)),
      updatedAt: now,
    };
    if (to === "submitted") {
      set.evidenceHash = evidenceHash;
      set.evidenceFrozenAt = now;
    }
    if (to === "paid") {
      const paid = input.paidTotalCents ?? totals.approvedTotalCents;
      if (paid === null || paid === undefined || paid <= 0) throw badRequest("Enter the amount paid.");
      set.paidTotalCents = paid;
      if (input.paymentReference !== undefined) set.paymentReference = clean(input.paymentReference);
    }
    const [row] = await tx.update(claims).set(set).where(eq(claims.id, id)).returning();
    const activity = await addActivity(tx, id, "status", actor, {
      fromStatus: claim.status,
      toStatus: to,
      body: note,
      detail: {
        action: check.transition.action,
        ...(to === "submitted" ? { evidenceHash } : {}),
        ...(to === "paid" ? { paidTotalCents: set.paidTotalCents, paymentReference: set.paymentReference ?? null } : {}),
      },
    });
    return { claim: row!, from: claim.status, activity };
  });

  logger.info("claims.status_changed", { claimId: id, code: claim.code, from, to });
  await announce(
    "claim.status_changed",
    claim,
    { from, to, note, ...(to === "submitted" ? { evidenceHash, slaDueAt: claim.slaDueAt } : {}) },
    actor,
    activity.id,
  );
  return getClaim(id, actor);
}

export async function assignClaim(
  id: string,
  target: { userOid: string | null },
  actor: ClaimActor,
): Promise<ClaimDetail> {
  const current = await loadClaim(id);
  if (current.status === "closed") throw badRequest(`${current.code} is closed. Reopen it to change the reviewer.`);
  const to = target.userOid;
  const self = to !== null && to === actor.userOid;
  if (actor.role !== "admin") {
    // Anyone can pick up an unassigned claim or put one down; handing a claim
    // to someone else, or taking one from them, is an administrator's call.
    const pickingUp = self && !current.assigneeUserOid;
    const puttingDown = to === null && current.assigneeUserOid === actor.userOid;
    if (!pickingUp && !puttingDown) {
      throw forbidden(
        current.assigneeUserOid && current.assigneeUserOid !== actor.userOid
          ? `${current.assigneeName ?? "Someone else"} is reviewing this claim. An administrator can reassign it.`
          : "You can take an unassigned claim yourself; an administrator assigns it to someone else.",
      );
    }
  }
  let name: string | null = null;
  if (to) {
    if (self) name = actor.name;
    else {
      const [u] = await db.select({ name: users.name, disabled: users.disabled }).from(users).where(eq(users.oid, to)).limit(1);
      if (!u || u.disabled) throw badRequest("That person has no active account here. Pick someone who can sign in.");
      name = u.name;
    }
  }
  if (to === current.assigneeUserOid) return getClaim(id, actor);

  const { claim, activity } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(claims)
      .set({ assigneeUserOid: to, assigneeName: name, assignedAt: to ? new Date() : null, updatedAt: new Date() })
      .where(eq(claims.id, id))
      .returning();
    const activity = await addActivity(tx, id, "assignment", actor, {
      body: to ? `Assigned to ${name ?? to}` : "Unassigned",
      detail: { from: current.assigneeUserOid, fromName: current.assigneeName, to, toName: name },
    });
    return { claim: row!, activity };
  });
  await announce("claim.assigned", claim, { from: current.assigneeUserOid, to, toName: name }, actor, activity.id);
  return getClaim(id, actor);
}

/** Comments are kept whole in the claim; events carry at most this much of one. */
const EVENT_BODY_MAX = 2000;

export async function addComment(id: string, body: string, actor: ClaimActor): Promise<ClaimActivity> {
  const text = clean(body);
  if (!text) throw badRequest("Write something first.");
  const claim = await loadClaim(id);
  const activity = await addActivity(db, id, "comment", actor, { body: text });
  await announce(
    "claim.commented",
    claim,
    { commentId: activity.id, body: text.length > EVENT_BODY_MAX ? `${text.slice(0, EVENT_BODY_MAX)}…` : text },
    actor,
    activity.id,
  );
  return activity;
}

export async function recordExport(id: string, format: "pdf" | "xlsx", actor: ClaimActor): Promise<void> {
  const claim = await loadClaim(id);
  const activity = await addActivity(db, id, "export", actor, { detail: { format } });
  await announce("claim.exported", claim, { format }, actor, activity.id);
}

// --- Pickers ------------------------------------------------------------------------------------

export type Candidate = {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  stage: string;
  stageLabel: string;
  /** In an exception stage (damaged, missing, refused...): the lines a claim usually starts from. */
  flagged: boolean;
  stageNote: string | null;
  shipmentId: string | null;
  shipmentCode: string | null;
  declaredValueCents: number | null;
  /** Open claims already listing this line. */
  claims: { id: string; code: string; status: ClaimStatus }[];
};

/** A job's manifest lines, flagged ones first, for picking what a claim is about. */
export async function claimCandidates(jobId: string, shipmentId?: string | null): Promise<Candidate[]> {
  const rows = await db
    .select({
      jobItemId: jobItems.id,
      itemId: jobItems.itemId,
      unitId: jobItems.unitId,
      itemName: items.name,
      unitLabel: itemUnits.label,
      assetCode: items.assetCode,
      unitCode: itemUnits.assetCode,
      stage: jobItems.stage,
      shipmentId: jobItems.shipmentId,
      shipmentCode: shipments.code,
      itemValue: items.valueCents,
      unitValue: itemUnits.valueCents,
      stageNote: sql<string | null>`(SELECT h.note FROM job_item_stage_history h
                                      WHERE h.job_item_id = ${jobItems.id} AND h.note IS NOT NULL
                                      ORDER BY h.created_at DESC LIMIT 1)`,
    })
    .from(jobItems)
    .innerJoin(items, eq(jobItems.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
    .leftJoin(shipments, eq(jobItems.shipmentId, shipments.id))
    .where(and(eq(jobItems.jobId, jobId), shipmentId ? eq(jobItems.shipmentId, shipmentId) : undefined))
    .orderBy(asc(items.name), asc(itemUnits.assetCode))
    .limit(5000);
  const ids = rows.map((r) => r.jobItemId);
  const onClaims = ids.length
    ? await db
        .select({ jobItemId: claimLines.jobItemId, id: claims.id, code: claims.code, status: claims.status })
        .from(claimLines)
        .innerJoin(claims, eq(claimLines.claimId, claims.id))
        .where(and(inArray(claimLines.jobItemId, ids), inArray(claims.status, ["draft", "submitted", "under_review", "approved"])))
    : [];
  const out: Candidate[] = rows.map((r) => ({
    jobItemId: r.jobItemId,
    itemId: r.itemId,
    unitId: r.unitId,
    itemName: r.unitLabel ? `${r.itemName} · ${r.unitLabel}` : r.itemName,
    assetCode: r.unitCode ?? r.assetCode,
    stage: r.stage,
    stageLabel: stageLabel(r.stage),
    flagged: isExceptionStage(r.stage),
    stageNote: r.stageNote,
    shipmentId: r.shipmentId,
    shipmentCode: r.shipmentCode,
    declaredValueCents: r.unitValue ?? r.itemValue ?? null,
    claims: onClaims.filter((c) => c.jobItemId === r.jobItemId).map(({ id, code, status }) => ({ id, code, status })),
  }));
  return out.sort((a, b) => Number(b.flagged) - Number(a.flagged));
}

/** People a claim can be assigned to: every active account. */
export async function listReviewers(viewer: ClaimActor): Promise<{ userOid: string; name: string }[]> {
  const rows = await db
    .select({ userOid: users.oid, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.disabled, false))
    .orderBy(asc(users.name));
  const out = rows.map((r) => ({ userOid: r.userOid, name: r.name || r.email }));
  // Trusted mode's owner has no account row.
  if (viewer.userOid && !viewer.grantId && !viewer.userOid.startsWith("api-key:") && !out.some((r) => r.userOid === viewer.userOid)) {
    out.unshift({ userOid: viewer.userOid, name: viewer.name ?? viewer.userOid });
  }
  return out;
}

export { TYPE_INFO };
