import { and, asc, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  attachments,
  users,
  jobItems,
  jobs,
  shipments,
  type Claim,
  type ClaimActivity,
  type ClaimLine,
} from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getShipment, lineHistory, stageLabel } from "../jobs-core";
import { contentHash, getSignature, listSignatures } from "../media-ai-core";
import { STATUS_LABELS } from "./model";
import type { ConditionReport, CustodyHop } from "./normalize";
import {
  availability,
  conditionReportsFor,
  custodyHopsFor,
  detectShapes,
  type SourceAvailability,
} from "./sources";
import { attachmentPhase, sortNotes, tripFromHistory, type ConditionNote, type Phase, type Trip } from "./trip";

/**
 * The evidence pack: everything already on file about each line's item,
 * gathered when it is asked for rather than attached by hand. For each line:
 * its manifest line's trip (every stage change, with when, how and who), its
 * condition notes and reports, the custody hops it went through, its photos
 * placed before or after the trip, and the audit-log entries that record all
 * of it. Read-only: nothing here writes, and nothing in the pack is edited
 * from the claim.
 */

export type EvidenceAttachment = {
  id: string;
  owner: "item" | "unit" | "claim_line" | "claim" | "condition_report";
  kind: string;
  stage: string | null;
  phase: Phase;
  caption: string | null;
  mime: string;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  createdBy: string | null;
  /** Who took it, by name, as far as the accounts say. */
  createdByName: string | null;
  url: string;
  thumbUrl: string | null;
};

export type EvidenceStageStep = {
  id: string;
  fromStage: string | null;
  toStage: string;
  label: string;
  at: string;
  via: string;
  deviceId: string | null;
  actor: string | null;
  note: string | null;
  shipmentCode: string | null;
};

export type EvidenceAudit = { id: number; type: string; occurredAt: string; hash: string; actorName: string | null };

export type EvidenceSignature = {
  id: string;
  signerName: string;
  signerRole: string | null;
  statement: string;
  signedAt: string;
  contentHash: string;
  ownerType: string;
};

export type CustodyEvidence = CustodyHop & { signatures: EvidenceSignature[] };

export type LineEvidence = {
  lineId: string;
  position: number;
  itemId: string | null;
  unitId: string | null;
  itemName: string | null;
  assetCode: string | null;
  jobItemId: string | null;
  jobId: string | null;
  jobCode: string | null;
  shipmentCode: string | null;
  currentStage: string | null;
  trip: Trip | null;
  stageHistory: EvidenceStageStep[];
  conditionNotes: ConditionNote[];
  conditionReports: ConditionReport[];
  custody: CustodyEvidence[];
  attachments: EvidenceAttachment[];
  audit: EvidenceAudit[];
};

export type TimelineEntry = {
  at: string;
  kind: "stage" | "condition" | "custody" | "shipment" | "claim";
  lineId: string | null;
  label: string;
  detail: string | null;
};

export type ShipmentEvidence = {
  id: string;
  code: string;
  name: string;
  status: string;
  carrier: string | null;
  sealNumbers: string[];
  departedAt: string | null;
  arrivedAt: string | null;
  history: { from: string | null; to: string; at: string; forced: boolean; reason: string | null; actor: string | null }[];
};

export type EvidencePack = {
  claimId: string;
  code: string;
  generatedAt: string;
  /** sha256 of the pack's content (everything but the audit ids and the timeline, which only grow). */
  hash: string;
  /** The fingerprint taken on submission, and whether the pack still matches it. */
  frozen: { hash: string; at: string } | null;
  unchangedSinceSubmission: boolean | null;
  sources: SourceAvailability;
  lines: LineEvidence[];
  claim: {
    attachments: EvidenceAttachment[];
    signatures: EvidenceSignature[];
    shipment: ShipmentEvidence | null;
    audit: EvidenceAudit[];
  };
  timeline: TimelineEntry[];
};

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

type AttachmentRow = {
  id: string;
  ownerType: string;
  ownerId: string;
  kind: string;
  stage: string | null;
  caption: string | null;
  mime: string;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
  createdBy: string | null;
};

/** Every photo, video, recording and document on the given owners, in one query. */
async function attachmentsFor(owners: { type: string; ids: string[] }[], extraIds: string[]): Promise<AttachmentRow[]> {
  const conds: SQL[] = [];
  for (const o of owners) {
    if (o.ids.length) conds.push(and(eq(attachments.ownerType, o.type), inArray(attachments.ownerId, o.ids))!);
  }
  if (extraIds.length) conds.push(inArray(attachments.id, extraIds));
  if (!conds.length) return [];
  return db
    .select({
      id: attachments.id,
      ownerType: attachments.ownerType,
      ownerId: attachments.ownerId,
      kind: attachments.kind,
      stage: attachments.stage,
      caption: attachments.caption,
      mime: attachments.mime,
      sha256: attachments.sha256,
      width: attachments.width,
      height: attachments.height,
      createdAt: attachments.createdAt,
      createdBy: attachments.createdBy,
    })
    .from(attachments)
    // A signature's image is shown with its signature, not as a photo.
    .where(and(or(...conds), ne(attachments.kind, "signature")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
}

function present(
  a: AttachmentRow,
  owner: EvidenceAttachment["owner"],
  trip: Trip | null,
  names: Map<string, string>,
): EvidenceAttachment {
  return {
    id: a.id,
    owner,
    kind: a.kind,
    stage: a.stage,
    phase: attachmentPhase(a, trip),
    caption: a.caption,
    mime: a.mime,
    sha256: a.sha256,
    width: a.width,
    height: a.height,
    createdAt: iso(a.createdAt),
    createdBy: a.createdBy,
    createdByName: a.createdBy ? names.get(a.createdBy) ?? null : null,
    url: `/api/attachments/${a.id}`,
    thumbUrl: a.mime.startsWith("image/") ? `/api/attachments/${a.id}/thumb` : null,
  };
}

type AuditRow = {
  id: string;
  type: string;
  occurred_at: Date;
  hash: string;
  actor_name: string | null;
  subject_type: string | null;
  subject_id: string | null;
  job_item_ids: string[] | null;
};

/**
 * Audit-log entries about the lines' items and units, the stage changes that
 * moved their manifest lines, and the claim itself. Newest first, bounded.
 */
async function auditFor(
  claimId: string,
  itemIds: string[],
  unitIds: string[],
  jobIds: string[],
  jobItemIds: string[],
): Promise<AuditRow[]> {
  try {
    const { rows } = await pool.query<AuditRow>(
      `SELECT a.id::text AS id, a.type, a.occurred_at, a.hash, a.actor_name, a.subject_type, a.subject_id,
              CASE WHEN a.type = 'job.stage_changed' THEN ARRAY(
                SELECT l->>'jobItemId'
                  FROM jsonb_array_elements(CASE jsonb_typeof(a.data->'lines') WHEN 'array' THEN a.data->'lines' ELSE '[]'::jsonb END) l
                 WHERE l->>'jobItemId' = ANY($5::text[])) END AS job_item_ids
         FROM audit_log a
        WHERE (a.subject_type = 'claim' AND a.subject_id = $1)
           OR (a.subject_type = 'item' AND a.subject_id = ANY($2::text[]))
           OR (a.subject_type = 'unit' AND a.subject_id = ANY($3::text[]))
           OR (a.subject_type = 'job' AND a.subject_id = ANY($4::text[]) AND a.type = 'job.stage_changed'
               AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(CASE jsonb_typeof(a.data->'lines') WHEN 'array' THEN a.data->'lines' ELSE '[]'::jsonb END) l
                  WHERE l->>'jobItemId' = ANY($5::text[])))
        ORDER BY a.id DESC
        LIMIT 2000`,
      [claimId, itemIds, unitIds, jobIds, jobItemIds],
    );
    return rows;
  } catch (err) {
    // The pack is still worth having without its audit ids.
    logger.warn("claims.evidence.audit_failed", { claimId, err: describeError(err) });
    return [];
  }
}

/**
 * Names for the account ids that uploaded photos and wrote reports, so the
 * pack reads "Dana Ruiz" rather than an id. Unknown ids are left unnamed.
 */
async function accountNames(oids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(oids.filter((o): o is string => Boolean(o)))];
  const out = new Map<string, string>();
  for (const oid of wanted) {
    if (oid === "trusted:owner") out.set(oid, env.TRUSTED_USER_NAME);
    else if (oid.startsWith("api-key:")) out.set(oid, "API key");
  }
  const lookup = wanted.filter((o) => !out.has(o));
  if (lookup.length) {
    const rows = await db.select({ oid: users.oid, name: users.name, email: users.email }).from(users).where(inArray(users.oid, lookup));
    for (const r of rows) out.set(r.oid, r.name || r.email);
  }
  return out;
}

const auditView = (r: AuditRow): EvidenceAudit => ({
  id: Number(r.id),
  type: r.type,
  occurredAt: iso(r.occurred_at),
  hash: r.hash,
  actorName: r.actor_name,
});

const signatureView = (s: {
  id: string;
  signerName: string;
  signerRole: string | null;
  statement: string;
  signedAt: Date;
  contentHash: string;
  ownerType: string;
}): EvidenceSignature => ({
  id: s.id,
  signerName: s.signerName,
  signerRole: s.signerRole,
  statement: s.statement,
  signedAt: iso(s.signedAt),
  contentHash: s.contentHash,
  ownerType: s.ownerType,
});

const covers = (r: { itemId: string | null; unitId: string | null }, line: { itemId: string | null; unitId: string | null }) =>
  r.itemId !== null && r.itemId === line.itemId && (r.unitId === null || line.unitId === null || r.unitId === line.unitId);

function reportNote(r: ConditionReport): string {
  return [
    r.rating ? `Rated ${r.rating}.` : null,
    r.notes,
    r.aiNotes ? `AI: ${r.aiNotes}` : null,
    r.defects.length
      ? `Defects: ${r.defects.map((d) => [d.severity, d.type, d.area && `on ${d.area}`].filter(Boolean).join(" ")).join("; ")}.`
      : null,
    r.handlingNote ? `Handling: ${r.handlingNote}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

async function shipmentEvidence(id: string | null): Promise<ShipmentEvidence | null> {
  if (!id) return null;
  try {
    const s = await getShipment(id);
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      status: s.status,
      carrier: s.carrier,
      sealNumbers: s.sealNumbers,
      departedAt: s.departedAt ? iso(s.departedAt) : null,
      arrivedAt: s.arrivedAt ? iso(s.arrivedAt) : null,
      history: s.history.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        at: iso(h.createdAt),
        forced: h.forced,
        reason: h.reason,
        actor: h.actor,
      })),
    };
  } catch {
    return null;
  }
}

/** The part of the pack its fingerprint covers: what was on file, not the ids that index it. */
export function evidenceFingerprint(pack: Pick<EvidencePack, "lines" | "claim">): string {
  return contentHash({
    lines: pack.lines.map(({ audit: _a, ...line }) => ({
      ...line,
      // Names are looked up when the pack is built; a renamed account is not a changed record.
      conditionNotes: line.conditionNotes.map(({ by: _b, ...n }) => n),
      attachments: line.attachments.map((a) => ({ id: a.id, sha256: a.sha256, stage: a.stage, caption: a.caption })),
    })),
    claim: {
      attachments: pack.claim.attachments.map((a) => ({ id: a.id, sha256: a.sha256 })),
      signatures: pack.claim.signatures,
      shipment: pack.claim.shipment,
    },
  });
}

export async function buildEvidence(
  claim: Claim,
  lines: readonly ClaimLine[],
  activity: readonly ClaimActivity[] = [],
): Promise<EvidencePack> {
  const shapes = await detectShapes();
  const sources = availability(shapes);
  const refs = lines
    .filter((l): l is ClaimLine & { itemId: string } => l.itemId !== null)
    .map((l) => ({ itemId: l.itemId, unitId: l.unitId }));
  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  const unitIds = [...new Set(lines.map((l) => l.unitId).filter((u): u is string => u !== null))];
  const jobItemIds = [...new Set(lines.map((l) => l.jobItemId).filter((j): j is string => j !== null))];

  const jobLines = jobItemIds.length
    ? await db
        .select({
          id: jobItems.id,
          jobId: jobItems.jobId,
          stage: jobItems.stage,
          notes: jobItems.notes,
          jobCode: jobs.code,
          shipmentCode: shipments.code,
        })
        .from(jobItems)
        .innerJoin(jobs, eq(jobItems.jobId, jobs.id))
        .leftJoin(shipments, eq(jobItems.shipmentId, shipments.id))
        .where(inArray(jobItems.id, jobItemIds))
    : [];
  const jobLineById = new Map(jobLines.map((j) => [j.id, j]));
  const jobIds = [...new Set(jobLines.map((j) => j.jobId))];

  const [histories, reports, hops, shipment, claimSignatures] = await Promise.all([
    Promise.all(jobItemIds.map(async (id) => [id, await lineHistory(id)] as const)).then((h) => new Map(h)),
    conditionReportsFor(shapes, itemIds),
    custodyHopsFor(shapes, refs),
    shipmentEvidence(claim.shipmentId),
    Promise.all([
      claim.shipmentId ? listSignatures("shipment", claim.shipmentId) : [],
      claim.jobId ? listSignatures("job", claim.jobId) : [],
    ]).then((s) => s.flat().map(signatureView)),
  ]);

  const reportAttachmentIds = [...new Set(reports.rows.flatMap((r) => r.attachmentIds))];
  const [files, auditRows, hopSignatures] = await Promise.all([
    attachmentsFor(
      [
        { type: "item", ids: itemIds },
        { type: "unit", ids: unitIds },
        { type: "claim_line", ids: lines.map((l) => l.id) },
        { type: "claim", ids: [claim.id] },
      ],
      reportAttachmentIds,
    ),
    auditFor(claim.id, itemIds, unitIds, jobIds, jobItemIds),
    Promise.all(
      [...new Set(hops.rows.flatMap((h) => h.signatureIds))].map(async (id) => [id, await getSignature(id)] as const),
    ).then((pairs) => new Map(pairs.filter(([, s]) => s !== null).map(([id, s]) => [id, signatureView(s!)]))),
  ]);
  const names = await accountNames([...files.map((f) => f.createdBy), ...reports.rows.map((r) => r.createdBy)]);

  const lineEvidence: LineEvidence[] = lines.map((line) => {
    const jobLine = line.jobItemId ? jobLineById.get(line.jobItemId) ?? null : null;
    const history = line.jobItemId ? histories.get(line.jobItemId) ?? [] : [];
    const trip = history.length ? tripFromHistory(history) : null;

    const lineReports = reports.rows.filter((r) => covers(r, line));
    const lineHops = hops.rows
      .filter((h) => line.itemId !== null && h.items.some((i) => covers(i, line)))
      .map((h) => ({ ...h, signatures: h.signatureIds.map((id) => hopSignatures.get(id)).filter((s) => s !== undefined) }));

    const lineReportIds = new Set(lineReports.flatMap((r) => r.attachmentIds));
    const seen = new Set<string>();
    const lineFiles: EvidenceAttachment[] = [];
    for (const f of files) {
      let owner: EvidenceAttachment["owner"] | null = null;
      if (f.ownerType === "claim_line" && f.ownerId === line.id) owner = "claim_line";
      else if (f.ownerType === "unit" && line.unitId !== null && f.ownerId === line.unitId) owner = "unit";
      else if (f.ownerType === "item" && f.ownerId === line.itemId) owner = "item";
      else if (lineReportIds.has(f.id)) owner = "condition_report";
      if (!owner || seen.has(f.id)) continue;
      seen.add(f.id);
      lineFiles.push(present(f, owner, trip, names));
    }

    const notes: ConditionNote[] = [];
    if (jobLine?.notes) {
      notes.push({ source: "line", at: null, stage: null, text: jobLine.notes, by: null, ref: jobLine.id });
    }
    for (const h of history) {
      if (h.note) {
        notes.push({ source: "stage", at: iso(h.createdAt), stage: h.toStage, text: h.note, by: h.actor, ref: h.id });
      }
    }
    for (const r of lineReports) {
      const text = reportNote(r);
      if (text) {
        const by = r.createdBy ? names.get(r.createdBy) ?? null : null;
        notes.push({ source: "condition_report", at: r.createdAt, stage: r.stage, text, by, ref: r.id });
      }
    }
    for (const f of lineFiles) {
      if (f.caption) notes.push({ source: "photo", at: f.createdAt, stage: f.stage ?? f.phase, text: f.caption, by: f.createdByName, ref: f.id });
    }
    for (const h of lineHops) {
      if (h.conditionNote) notes.push({ source: "custody", at: h.at, stage: null, text: h.conditionNote, by: h.to, ref: h.id });
    }

    const audit = auditRows
      .filter(
        (a) =>
          (a.subject_type === "item" && a.subject_id === line.itemId) ||
          (a.subject_type === "unit" && line.unitId !== null && a.subject_id === line.unitId) ||
          (line.jobItemId !== null && (a.job_item_ids ?? []).includes(line.jobItemId)),
      )
      .map(auditView);

    return {
      lineId: line.id,
      position: line.position,
      itemId: line.itemId,
      unitId: line.unitId,
      itemName: line.itemName,
      assetCode: line.assetCode,
      jobItemId: line.jobItemId,
      jobId: jobLine?.jobId ?? null,
      jobCode: jobLine?.jobCode ?? null,
      shipmentCode: jobLine?.shipmentCode ?? null,
      currentStage: jobLine?.stage ?? null,
      trip,
      stageHistory: history.map((h) => ({
        id: h.id,
        fromStage: h.fromStage,
        toStage: h.toStage,
        label: stageLabel(h.toStage),
        at: iso(h.createdAt),
        via: h.via,
        deviceId: h.deviceId,
        actor: h.actor,
        note: h.note,
        shipmentCode: h.shipmentCode,
      })),
      conditionNotes: sortNotes(notes),
      conditionReports: lineReports,
      custody: lineHops,
      attachments: lineFiles,
      audit,
    };
  });

  const claimFiles = files
    .filter((f) => f.ownerType === "claim" && f.ownerId === claim.id)
    .map((f) => present(f, "claim", null, names));
  const claimAudit = auditRows.filter((a) => a.subject_type === "claim").map(auditView);

  const pack: Omit<EvidencePack, "hash" | "unchangedSinceSubmission"> = {
    claimId: claim.id,
    code: claim.code,
    generatedAt: new Date().toISOString(),
    frozen:
      claim.evidenceHash && claim.evidenceFrozenAt ? { hash: claim.evidenceHash, at: iso(claim.evidenceFrozenAt) } : null,
    sources,
    lines: lineEvidence,
    claim: { attachments: claimFiles, signatures: claimSignatures, shipment, audit: claimAudit },
    timeline: buildTimeline(lineEvidence, shipment, activity),
  };
  const hash = evidenceFingerprint(pack);
  return { ...pack, hash, unchangedSinceSubmission: pack.frozen ? pack.frozen.hash === hash : null };
}

const lineName = (l: LineEvidence) => l.itemName ?? l.assetCode ?? "Line";

/** Everything with a time on it, oldest first: the story an adjuster reads top to bottom. */
export function buildTimeline(
  lines: readonly LineEvidence[],
  shipment: ShipmentEvidence | null,
  activity: readonly Pick<ClaimActivity, "kind" | "fromStatus" | "toStatus" | "body" | "authorName" | "createdAt" | "detail">[],
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const l of lines) {
    for (const s of l.stageHistory) {
      out.push({
        at: s.at,
        kind: "stage",
        lineId: l.lineId,
        label: `${lineName(l)}: ${s.label}`,
        detail: [s.note, s.actor && `by ${s.actor}`, s.via && `via ${s.via}`, s.shipmentCode].filter(Boolean).join(" · ") || null,
      });
    }
    for (const r of l.conditionReports) {
      if (!r.createdAt) continue;
      out.push({
        at: r.createdAt,
        kind: "condition",
        lineId: l.lineId,
        label: `${lineName(l)}: condition ${r.stage ?? "report"}${r.rating ? `, ${r.rating}` : ""}`,
        detail: reportNote(r) || null,
      });
    }
    for (const h of l.custody) {
      if (!h.at) continue;
      out.push({
        at: h.at,
        kind: "custody",
        lineId: l.lineId,
        label: `${lineName(l)}: handed from ${h.from ?? "?"} to ${h.to ?? "?"}`,
        detail: [h.sealNumbers.length ? `seals ${h.sealNumbers.join(", ")}` : null, h.conditionNote].filter(Boolean).join(" · ") || null,
      });
    }
  }
  if (shipment) {
    for (const h of shipment.history) {
      out.push({
        at: h.at,
        kind: "shipment",
        lineId: null,
        label: `${shipment.code} ${h.to.replace(/_/g, " ")}`,
        detail: [h.forced ? `forced: ${h.reason ?? ""}` : null, h.actor].filter(Boolean).join(" · ") || null,
      });
    }
  }
  for (const a of activity) {
    if (a.kind !== "created" && a.kind !== "status") continue;
    out.push({
      at: iso(a.createdAt),
      kind: "claim",
      lineId: null,
      label: a.kind === "created" ? "Reported" : STATUS_LABELS[a.toStatus ?? "draft"],
      detail: [a.body, a.authorName && `by ${a.authorName}`].filter(Boolean).join(" · ") || null,
    });
  }
  return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
