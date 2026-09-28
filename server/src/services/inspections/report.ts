import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { jobs, locations, type FindingArea, type Inspection, type InspectionStatus } from "../../db/schema";
import { contentHash, type Attachment } from "../media-ai-core";
import {
  AREA_LABEL,
  KIND_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  SIGNOFF_LABEL,
  SIGNOFF_ROLES,
  STATUS_LABEL,
  spotLabel,
  type SignoffRole,
} from "./model";
import { compareFindings, normalizeRoom, type ChangeKind, type MatchSource } from "./pairing";
import { findingViews, loadInspection, signContentFor, signaturesOf, type FindingView } from "./inspections";

/**
 * Everything a report shows, gathered once and rendered twice: as the PDF and
 * as the read-only page a share link opens. Plain data, so the renderers are
 * pure and testable without a database.
 */

export type ReportPhoto = { id: string; mime: string; caption: string | null; width: number | null; height: number | null };

export type ReportFinding = {
  id: string;
  number: number;
  area: FindingArea;
  areaLabel: string;
  room: string;
  spot: string;
  spotLabel: string;
  spotDetail: string | null;
  description: string;
  severity: FindingView["severity"];
  severityLabel: string;
  preExisting: boolean;
  aiGenerated: boolean;
  photos: ReportPhoto[];
};

export type ReportRoom = { area: FindingArea; room: string; findings: ReportFinding[] };

export type ReportSignature = {
  id: string;
  role: SignoffRole | null;
  signerName: string;
  signerRole: string | null;
  signerEmail: string | null;
  signedAt: Date;
  statement: string;
  imageId: string | null;
  valid: boolean;
  reason: string;
  contentHash: string;
};

export type ReportComparisonEntry = {
  change: ChangeKind;
  pre: ReportFinding | null;
  post: ReportFinding | null;
  source: MatchSource | null;
  notedPreExisting: boolean;
};

export type InspectionReport = {
  id: string;
  code: string;
  kind: Inspection["kind"];
  kindLabel: string;
  status: InspectionStatus;
  statusLabel: string;
  siteName: string;
  siteAddress: string | null;
  job: { code: string; name: string } | null;
  startedAt: Date;
  completedAt: Date | null;
  signedAt: Date | null;
  inspectors: string[];
  notes: string | null;
  findings: ReportFinding[];
  rooms: ReportRoom[];
  severityCounts: Record<FindingView["severity"], number>;
  pre: {
    id: string;
    code: string;
    status: InspectionStatus;
    startedAt: Date;
    completedAt: Date | null;
    findings: ReportFinding[];
  } | null;
  comparison: { counts: Record<ChangeKind, number>; entries: ReportComparisonEntry[] } | null;
  signoffs: { role: SignoffRole; label: string; signature: ReportSignature | null }[];
  otherSignatures: ReportSignature[];
  /** sha256 of the signed-content JSON as the record stands, printed so a reader can match it to a signature. */
  contentHash: string;
  generatedAt: Date;
};

const photo = (a: Attachment): ReportPhoto => ({
  id: a.id,
  mime: a.mime,
  caption: a.caption,
  width: a.width,
  height: a.height,
});

export function reportFinding(f: FindingView): ReportFinding {
  return {
    id: f.id,
    number: f.number,
    area: f.area,
    areaLabel: AREA_LABEL[f.area],
    room: f.room,
    spot: f.spot,
    spotLabel: spotLabel(f.spot),
    spotDetail: f.spotDetail,
    description: f.description,
    severity: f.severity,
    severityLabel: SEVERITY_LABEL[f.severity],
    preExisting: f.preExisting,
    aiGenerated: f.aiGenerated,
    photos: f.photos.filter((p) => p.kind === "photo").map(photo),
  };
}

/** Findings by room, inside before outside, rooms in the order they were first visited. */
export function groupByRoom(findings: ReportFinding[]): ReportRoom[] {
  const rooms = new Map<string, ReportRoom>();
  for (const f of findings) {
    const key = `${f.area}:${normalizeRoom(f.room) || f.room.toLowerCase()}`;
    let room = rooms.get(key);
    if (!room) rooms.set(key, (room = { area: f.area, room: f.room, findings: [] }));
    room.findings.push(f);
  }
  return [...rooms.values()].sort((a, b) => (a.area === b.area ? 0 : a.area === "inside" ? -1 : 1));
}

export async function buildReport(id: string): Promise<InspectionReport> {
  const inspection = await loadInspection(id);
  const [{ findings }, job, location, preInspection] = await Promise.all([
    findingViews(id),
    inspection.jobId
      ? db.select({ code: jobs.code, name: jobs.name }).from(jobs).where(eq(jobs.id, inspection.jobId)).then((r) => r[0] ?? null)
      : null,
    inspection.locationId
      ? db.select({ address: locations.address }).from(locations).where(eq(locations.id, inspection.locationId)).then((r) => r[0] ?? null)
      : null,
    inspection.kind === "post" && inspection.preInspectionId
      ? loadInspection(inspection.preInspectionId).catch(() => null)
      : null,
  ]);
  const preViews = preInspection ? (await findingViews(preInspection.id)).findings : null;
  const content = await signContentFor(inspection);
  const signatures = await signaturesOf(inspection, content);

  const post = findings.map(reportFinding);
  const before = preViews?.map(reportFinding) ?? null;
  const byId = new Map([...(before ?? []), ...post].map((f) => [f.id, f]));
  const comparison =
    preViews && before
      ? (() => {
          const c = compareFindings(preViews, findings);
          return {
            counts: c.counts,
            entries: c.entries.map((e) => ({
              change: e.change,
              pre: e.pre ? byId.get(e.pre.id)! : null,
              post: e.post ? byId.get(e.post.id)! : null,
              source: e.source,
              notedPreExisting: e.notedPreExisting,
            })),
          };
        })()
      : null;

  const severityCounts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as InspectionReport["severityCounts"];
  for (const f of post) severityCounts[f.severity]++;

  const toReport = (s: (typeof signatures)[number]): ReportSignature => ({
    id: s.id,
    role: s.role,
    signerName: s.signerName,
    signerRole: s.signerRole,
    signerEmail: s.signerEmail,
    signedAt: s.signedAt,
    statement: s.statement,
    imageId: s.attachmentId,
    valid: s.verification.valid,
    reason: s.verification.reason,
    contentHash: s.contentHash,
  });

  return {
    id: inspection.id,
    code: inspection.code,
    kind: inspection.kind,
    kindLabel: KIND_LABEL[inspection.kind],
    status: inspection.status,
    statusLabel: STATUS_LABEL[inspection.status],
    siteName: inspection.siteName,
    siteAddress: location?.address ?? null,
    job,
    startedAt: inspection.startedAt,
    completedAt: inspection.completedAt,
    signedAt: inspection.signedAt,
    inspectors: inspection.inspectors,
    notes: inspection.notes,
    findings: post,
    rooms: groupByRoom(post),
    severityCounts,
    pre: preInspection
      ? {
          id: preInspection.id,
          code: preInspection.code,
          status: preInspection.status,
          startedAt: preInspection.startedAt,
          completedAt: preInspection.completedAt,
          findings: before ?? [],
        }
      : null,
    comparison,
    signoffs: SIGNOFF_ROLES.map((role) => {
      const s = signatures.find((v) => v.role === role);
      return { role, label: SIGNOFF_LABEL[role], signature: s ? toReport(s) : null };
    }),
    otherSignatures: signatures.filter((s) => !s.role).map(toReport),
    contentHash: contentHash(content),
    generatedAt: new Date(),
  };
}

/** Every file a report shows, which is exactly what a share link may serve. */
export function reportFileIds(report: InspectionReport): Set<string> {
  const ids = new Set<string>();
  for (const f of [...report.findings, ...(report.pre?.findings ?? [])]) for (const p of f.photos) ids.add(p.id);
  for (const s of [...report.signoffs.map((x) => x.signature), ...report.otherSignatures]) if (s?.imageId) ids.add(s.imageId);
  return ids;
}

/**
 * The same set as reportFileIds, without building the report: the photos the
 * findings list (the pre-inspection's too, for a post-inspection) and the
 * signature images. A share page asks once per photo, so this stays cheap.
 */
export async function reportFileIdsFor(inspectionId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT unnest(f.attachment_ids)::text AS id
       FROM inspections i
       JOIN inspection_findings f
         ON f.inspection_id = i.id OR (i.kind = 'post' AND f.inspection_id = i.pre_inspection_id)
      WHERE i.id = $1
     UNION
     SELECT attachment_id::text FROM signatures
      WHERE owner_type = 'inspection' AND owner_id = $1 AND attachment_id IS NOT NULL`,
    [inspectionId],
  );
  return new Set(rows.map((r) => r.id));
}
