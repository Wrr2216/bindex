import { and, eq, inArray } from "drizzle-orm";
import { Transform, type Readable } from "node:stream";
import { db } from "../../db/client";
import { itemUnits, items, jobItems, portalNotes, type PortalCondition } from "../../db/schema";
import { HttpError, badRequest, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { publish } from "../event-backbone";
import {
  isStage,
  planAdvance,
  resolveScanCodes,
  setLineStage,
  uniqueCodes,
  type AdvanceResult,
  type LineOutcome,
  type ScanRef,
} from "../jobs-core";
import { saveAttachment, sign } from "../media-ai-core";
import { NOT_IN_SCOPE, withPortalScope } from "./guard";
import { HANDOFF_STATEMENT, handoffContent, signatureImage } from "./handoff";
import {
  DEFAULT_PHOTO_STAGE,
  MAX_PORTAL_SCAN,
  NOTE_CONDITIONS,
  PHOTO_MAX_BYTES,
  contributorStages,
  isPhotoStage,
  portalActor,
  portalActorName,
} from "./policy";
import { findLine, lineSummaries, type PortalContext, type PortalLine } from "./views";

/**
 * What a contributor link (a subcontracted crew) can change: scan its own
 * lines to a stage, add condition notes and photos, and sign a handoff. Each
 * is attributed to the grant, never to a user: stage history records the
 * grant's name with `via: "portal"`, files record `portal:<grant id>` as
 * their creator, and every action is published with the grant as its actor.
 */

function assertContributor(ctx: PortalContext): void {
  if (ctx.grant.role !== "contributor") {
    throw forbidden("This link can view only. Ask whoever shared it for a crew link to record work.");
  }
  // The database refuses a contributor on a project; this keeps the rule
  // true even for a row written some other way.
  if (ctx.scope.kind !== "job" && ctx.scope.kind !== "shipment") {
    throw forbidden("A crew link works on one job or one shipment.");
  }
}

const subjectOf = (ctx: PortalContext) => ({ type: "portal_grant", id: ctx.grant.id });

/** The one job a contributor works on. */
function scopeJobId(ctx: PortalContext): string {
  const job = ctx.scope.jobs[0];
  if (!job) throw notFound("That job no longer exists.");
  return job.id;
}

/**
 * The shipment a scan works: a shipment link always its own, a job link the
 * one picked (which must be on the job) or none.
 */
function scanShipment(ctx: PortalContext, requested: string | null | undefined): string | null {
  if (ctx.scope.kind === "shipment") {
    if (requested && requested !== ctx.scope.targetId) throw notFound("That shipment is not part of what this link covers.");
    return ctx.scope.targetId;
  }
  if (!requested) return null;
  if (!ctx.scope.shipmentIds.includes(requested)) throw notFound("That shipment is not part of what this link covers.");
  return requested;
}

export type ScanLine = Pick<
  PortalLine,
  "id" | "itemName" | "code" | "assetCode" | "unitCode" | "stage" | "room" | "floor" | "crateNo" | "shipmentCode"
> & { scanned: string | null };

export type PortalScanResult = {
  stage: string;
  shipmentId: string | null;
  advanced: ScanLine[];
  alreadyAt: ScanLine[];
  /** On this job but another of its shipments (job links only). */
  wrongShipment: ScanLine[];
  /** Known, but not on what this link covers. Nothing more is said about it. */
  notInScope: string[];
  unknown: string[];
  blocked: (ScanLine & { reason: string })[];
};

/**
 * Move the lines a batch of codes names to `stage`, within this grant only.
 *
 * Codes are resolved and matched with the jobs core's own resolver and
 * planner, but against this scope's lines alone, so a code for anything
 * outside comes back as notInScope without saying where it is. The chosen
 * lines are then moved by id through the core (its rules, lock, guards and
 * history), with the portal guard vetoing any line this call did not choose.
 * `force` is never used: a crew cannot move a line backwards or off another
 * shipment.
 */
export async function portalScan(
  ctx: PortalContext,
  input: { codes: string[]; stage: string; shipmentId?: string | null; note?: string | null },
): Promise<PortalScanResult> {
  assertContributor(ctx);
  const allowed = contributorStages(ctx.grant.role, ctx.grant.allowedStages, isStage);
  if (!allowed.includes(input.stage)) {
    throw badRequest(`This link cannot record "${input.stage}". Pick one of: ${allowed.join(", ")}.`);
  }
  const codes = uniqueCodes(input.codes);
  if (!codes.length) throw badRequest("Scan or type at least one code.");
  if (codes.length > MAX_PORTAL_SCAN) throw badRequest(`Send at most ${MAX_PORTAL_SCAN} codes at a time.`);
  const jobId = scopeJobId(ctx);
  const shipmentId = scanShipment(ctx, input.shipmentId);

  const resolved = await resolveScanCodes(codes);
  const itemIds = [...new Set([...resolved.values()].flat().map((r: ScanRef) => r.itemId))];
  const candidates = itemIds.length
    ? await db
        .select({
          id: jobItems.id,
          itemId: jobItems.itemId,
          unitId: jobItems.unitId,
          stage: jobItems.stage,
          shipmentId: jobItems.shipmentId,
        })
        .from(jobItems)
        .where(and(ctx.scope.lines, inArray(jobItems.itemId, itemIds)))
    : [];
  const plan = planAdvance(codes, resolved, candidates, input.stage, { shipmentId });
  const codeOf = new Map<string, string>();
  for (const bucket of [plan.advance, plan.already, plan.wrongShipment, plan.blocked]) {
    for (const p of bucket) if (!codeOf.has(p.line.id)) codeOf.set(p.line.id, p.code);
  }

  const ids = plan.advance.map((p) => p.line.id);
  let applied: AdvanceResult | null = null;
  if (ids.length) {
    applied = await withPortalScope({ grantId: ctx.grant.id, jobId, allowed: new Set(ids) }, () =>
      setLineStage(jobId, ids, input.stage, {
        shipmentId,
        via: "portal",
        userOid: null,
        actor: portalActorName(ctx.grant),
        note: input.note?.trim().slice(0, 500) || null,
      }),
    );
  }

  // What the core did wins over the plan: another scanner may have moved a
  // line between the two.
  const outcome = new Map<string, { bucket: "advanced" | "alreadyAt" | "wrongShipment" | "blocked"; reason?: string }>();
  for (const p of plan.already) outcome.set(p.line.id, { bucket: "alreadyAt" });
  for (const p of plan.wrongShipment) outcome.set(p.line.id, { bucket: "wrongShipment" });
  for (const p of plan.blocked) outcome.set(p.line.id, { bucket: "blocked", reason: p.reason });
  const mark = (list: LineOutcome[] | undefined, bucket: "advanced" | "alreadyAt" | "wrongShipment") => {
    for (const l of list ?? []) outcome.set(l.jobItemId, { bucket });
  };
  mark(applied?.advanced, "advanced");
  mark(applied?.alreadyAt, "alreadyAt");
  mark(applied?.wrongShipment, "wrongShipment");
  for (const l of applied?.blocked ?? []) outcome.set(l.jobItemId, { bucket: "blocked", reason: l.reason });

  const summaries = await lineSummaries(ctx, [...outcome.keys()]);
  const result: PortalScanResult = {
    stage: input.stage,
    shipmentId,
    advanced: [],
    alreadyAt: [],
    wrongShipment: [],
    notInScope: plan.notOnJob.map((n) => n.code),
    unknown: plan.unknown,
    blocked: [],
  };
  for (const [id, o] of outcome) {
    const line = summaries.get(id);
    if (!line) continue;
    const entry: ScanLine = {
      id: line.id,
      itemName: line.itemName,
      code: line.code,
      assetCode: line.assetCode,
      unitCode: line.unitCode,
      stage: line.stage,
      room: line.room,
      floor: line.floor,
      crateNo: line.crateNo,
      shipmentCode: line.shipmentCode,
      scanned: codeOf.get(id) ?? null,
    };
    if (o.bucket === "blocked") {
      // The portal guard's own veto means "not ours", which is what the crew should hear.
      if (o.reason === NOT_IN_SCOPE && entry.scanned) result.notInScope.push(entry.scanned);
      else result.blocked.push({ ...entry, reason: o.reason ?? "Refused." });
    } else {
      result[o.bucket].push(entry);
    }
  }

  logger.info("portal.scan", {
    grantId: ctx.grant.id,
    jobId,
    stage: input.stage,
    advanced: result.advanced.length,
    notInScope: result.notInScope.length,
    unknown: result.unknown.length,
  });
  await publish(
    "portal.scanned",
    {
      jobId,
      shipmentId,
      stage: input.stage,
      advanced: result.advanced.length,
      alreadyAt: result.alreadyAt.length,
      wrongShipment: result.wrongShipment.length,
      notInScope: result.notInScope.length,
      unknown: result.unknown.length,
      blocked: result.blocked.length,
      jobItemIds: result.advanced.slice(0, 500).map((l) => l.id),
    },
    { actor: portalActor(ctx.grant), subject: subjectOf(ctx) },
  );
  return result;
}

export async function addNote(
  ctx: PortalContext,
  lineId: string,
  input: { body: string; condition?: PortalCondition | null },
) {
  assertContributor(ctx);
  const body = input.body.trim();
  if (!body) throw badRequest("Write the note first.");
  if (body.length > 2000) throw badRequest("Keep the note under 2000 characters.");
  if (input.condition && !(NOTE_CONDITIONS as readonly string[]).includes(input.condition)) {
    throw badRequest(`Condition must be one of ${NOTE_CONDITIONS.join(", ")}.`);
  }
  const line = await findLine(ctx, lineId);
  const [note] = await db
    .insert(portalNotes)
    .values({
      grantId: ctx.grant.id,
      author: portalActorName(ctx.grant),
      jobId: scopeJobId(ctx),
      jobItemId: line.id,
      itemId: line.itemId,
      unitId: line.unitId,
      condition: input.condition ?? null,
      body,
    })
    .returning({
      id: portalNotes.id,
      author: portalNotes.author,
      condition: portalNotes.condition,
      body: portalNotes.body,
      createdAt: portalNotes.createdAt,
    });
  await publish(
    "portal.note_added",
    { jobId: scopeJobId(ctx), jobItemId: line.id, itemId: line.itemId, unitId: line.unitId, condition: note!.condition, noteId: note!.id },
    { actor: portalActor(ctx.grant), subject: subjectOf(ctx) },
  );
  return { ...note!, mine: true };
}

/** Pass bytes through, failing once more than `max` have gone by. */
function capped(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > max) {
        done(new HttpError(413, "too_large", `Photos are limited to ${Math.round(max / 1024 / 1024)} MB.`));
        return;
      }
      done(null, chunk);
    },
  });
}

export async function addPhoto(
  ctx: PortalContext,
  lineId: string,
  input: { body: Readable; mime: string | null; contentLength: number | null; stage?: string | null; caption?: string | null },
) {
  assertContributor(ctx);
  const stage = (input.stage || DEFAULT_PHOTO_STAGE).toLowerCase();
  if (!isPhotoStage(stage)) throw badRequest(`Photo stage must be one of the listed stages, such as ${DEFAULT_PHOTO_STAGE}.`);
  if (input.contentLength !== null && input.contentLength > PHOTO_MAX_BYTES) {
    throw new HttpError(413, "too_large", `Photos are limited to ${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  const line = await findLine(ctx, lineId);
  const limiter = capped(PHOTO_MAX_BYTES);
  input.body.on("error", (err) => limiter.destroy(err));
  const saved = await saveAttachment({
    ownerType: line.unitId ? "unit" : "item",
    ownerId: line.unitId ?? line.itemId,
    kind: "photo",
    stage,
    caption: input.caption?.trim().slice(0, 500) || null,
    mime: input.mime,
    stream: input.body.pipe(limiter),
    expectedSize: input.contentLength,
    meta: {
      portal: {
        grantId: ctx.grant.id,
        by: portalActorName(ctx.grant),
        jobId: scopeJobId(ctx),
        jobItemId: line.id,
        shipmentId: line.shipmentId,
      },
    },
    createdBy: `portal:${ctx.grant.id}`,
  });
  await publish(
    "portal.photo_added",
    { jobId: scopeJobId(ctx), jobItemId: line.id, itemId: line.itemId, unitId: line.unitId, attachmentId: saved.id, stage },
    { actor: portalActor(ctx.grant), subject: subjectOf(ctx) },
  );
  return {
    id: saved.id,
    stage: saved.stage,
    caption: saved.caption,
    width: saved.width,
    height: saved.height,
    createdAt: saved.createdAt,
    byPortal: true,
  };
}

/** The lines a handoff covers, as the signed content lists them. */
async function handoffLines(ownerKind: "job" | "shipment", ownerId: string) {
  const rows = await db
    .select({
      id: jobItems.id,
      stage: jobItems.stage,
      name: items.name,
      assetCode: items.assetCode,
      unitCode: itemUnits.assetCode,
    })
    .from(jobItems)
    .innerJoin(items, eq(jobItems.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
    .where(ownerKind === "shipment" ? eq(jobItems.shipmentId, ownerId) : eq(jobItems.jobId, ownerId));
  return rows.map((r) => ({ id: r.id, code: r.unitCode ?? r.assetCode, name: r.name, stage: r.stage }));
}

export async function signHandoff(
  ctx: PortalContext,
  input: {
    signerName: string;
    signerRole?: string | null;
    image?: string | null;
    shipmentId?: string | null;
    ip: string | null;
    userAgent: string | null;
  },
) {
  assertContributor(ctx);
  const shipmentId = scanShipment(ctx, input.shipmentId);
  const owner = shipmentId
    ? (() => {
        const s = ctx.scope.shipments.find((x) => x.id === shipmentId)!;
        return { kind: "shipment" as const, id: s.id, code: s.code, name: s.name };
      })()
    : (() => {
        const j = ctx.scope.jobs[0]!;
        return { kind: "job" as const, id: j.id, code: j.code, name: j.name };
      })();
  const image = signatureImage(input.image);
  if (input.image && !image) throw badRequest("The signature must be a PNG, JPEG or WebP image.");
  if (!image) throw badRequest("Sign in the box first.");
  const lines = await handoffLines(owner.kind, owner.id);
  if (!lines.length) throw badRequest(`${owner.name} has nothing on it to hand over yet.`);
  const content = handoffContent({ grant: ctx.grant, owner, lines });
  const signature = await sign({
    ownerType: owner.kind,
    ownerId: owner.id,
    signerName: input.signerName,
    signerRole: input.signerRole ?? ctx.grant.granteeOrg,
    signerEmail: ctx.grant.granteeEmail,
    statement: HANDOFF_STATEMENT,
    content,
    image,
    ip: input.ip,
    userAgent: input.userAgent,
    signedByUser: null,
  });
  await publish(
    "portal.handoff_signed",
    {
      signatureId: signature.id,
      contentHash: signature.contentHash,
      ownerType: owner.kind,
      ownerId: owner.id,
      ownerCode: owner.code,
      lines: lines.length,
      byStage: content.byStage,
      signerName: signature.signerName,
    },
    { actor: portalActor(ctx.grant), subject: subjectOf(ctx) },
  );
  return {
    id: signature.id,
    signerName: signature.signerName,
    signerRole: signature.signerRole,
    statement: signature.statement,
    contentHash: signature.contentHash,
    imageId: signature.attachmentId,
    signedAt: signature.signedAt,
    owner: `${owner.name} (${owner.code})`,
    lines: lines.length,
  };
}
