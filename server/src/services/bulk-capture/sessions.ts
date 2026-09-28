import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  captureDrafts,
  captureSessions,
  captureSources,
  items,
  locations,
  type CaptureCountRule,
  type CaptureDeskTemplate,
  type CaptureDraftRow,
  type CaptureMode,
  type CaptureSessionRow,
  type CaptureSourceKind,
  type CaptureSourceRow,
} from "../../db/schema";
import { env } from "../../env";
import { badRequest, conflict, describeError, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { visionJson } from "../ai";
import { actorFromOid, publish, registerEventTypes } from "../event-backbone";
import { recordEvent } from "../items";
import {
  deleteAttachment,
  deleteAttachmentsForOwner,
  getAttachment,
  readAttachmentBytes,
  registerOwnerType,
  saveAttachment,
} from "../media-ai-core";
import { savePhoto } from "../photos";
import { checkDesks, type DeskCheck } from "./desk";
import { PHOTO_SYSTEM, deskPrompt, normalizePhotoReading, walkthroughPrompt, type PhotoReading } from "./detections";
import { MANIFEST_PROMPT, MANIFEST_SYSTEM, normalizeManifest, type ManifestReading } from "./manifest";
import {
  emptyDraft,
  explainDraft,
  mergeByHand,
  moveSource,
  recountAll,
  splitByQty,
  splitBySource,
  withoutSource,
  type MergeDraft,
  type SourceRef,
} from "./merge";
import {
  attachmentToTempFile,
  cropJpeg,
  decodeImage,
  extractFrames,
  frameTimes,
  mediaTools,
  probeDuration,
  removeTemp,
  renderPdfPages,
} from "./media";
import { displayCategory } from "./names";
import { getBulkCaptureSettings } from "./settings";

/**
 * Capture sessions: sources in, drafts reviewed, items out. Nothing in here
 * creates an item except commitSession, which runs only when a person
 * confirms the reviewed list.
 */

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

registerOwnerType(
  "capture_session",
  async (id) => {
    const { rowCount } = await pool.query("SELECT 1 FROM capture_sessions WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  },
  { table: "capture_sessions", label: "capture session" },
);

registerEventTypes([
  {
    type: "capture_session.committed",
    group: "Bulk capture",
    subject: "capture_session",
    description:
      "Reviewed entries from a walkthrough, desk survey or paper inventory were created as items. Each item also gets its own item.created.",
  },
]);

export const MODE_LABEL: Record<CaptureMode, string> = {
  walkthrough: "Walkthrough",
  desk: "Desk survey",
  manifest: "Paper inventory",
};

// ---- Views -------------------------------------------------------------------

export type SourceView = {
  id: string;
  attachmentId: string;
  originAttachmentId: string | null;
  kind: CaptureSourceKind;
  position: number;
  label: string;
  frameMs: number | null;
  pageNo: number | null;
  area: string | null;
  status: CaptureSourceRow["status"];
  error: string | null;
  /** How many things (or manifest lines) the model reported. */
  found: number | null;
  /** The model's description of the space, walkthroughs only. */
  room: string | null;
  url: string;
  thumbUrl: string;
};

export type DraftView = Omit<CaptureDraftRow, "sources" | "sessionId" | "createdAt"> & {
  sources: (CaptureDraftRow["sources"][number] & { label: string; missing: boolean })[];
  explanation: string | null;
};

export type SessionView = Omit<CaptureSessionRow, "visionCalls" | "imageCap"> & {
  modeLabel: string;
  locationName: string | null;
  cap: { imageCap: number; used: number; remaining: number; instanceMax: number };
  /** Images waiting for the model. */
  toAnalyse: number;
  sources: SourceView[];
  drafts: DraftView[];
  deskCheck: DeskCheck[] | null;
  counts: { pending: number; discarded: number; created: number };
  tools: { vision: boolean; video: boolean; pdf: boolean };
};

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function sourceLabel(s: Pick<CaptureSourceRow, "kind" | "position" | "frameMs" | "pageNo">): string {
  if (s.kind === "video_frame") return `frame ${s.position}${s.frameMs !== null ? ` (${mmss(s.frameMs)})` : ""}`;
  if (s.kind === "pdf_page") return `page ${s.pageNo ?? s.position}`;
  return `photo ${s.position}`;
}

function presentSource(s: CaptureSourceRow): SourceView {
  const r = (s.result ?? {}) as { items?: unknown[]; rows?: unknown[]; room?: unknown };
  const found = Array.isArray(r.items) ? r.items.length : Array.isArray(r.rows) ? r.rows.length : null;
  return {
    id: s.id,
    attachmentId: s.attachmentId,
    originAttachmentId: s.originAttachmentId,
    kind: s.kind,
    position: s.position,
    label: sourceLabel(s),
    frameMs: s.frameMs,
    pageNo: s.pageNo,
    area: s.area,
    status: s.status,
    error: s.error,
    found: s.status === "analysed" ? found : null,
    room: typeof r.room === "string" ? r.room : null,
    url: `/api/attachments/${s.attachmentId}`,
    thumbUrl: `/api/attachments/${s.attachmentId}/thumb`,
  };
}

function presentDraft(d: CaptureDraftRow, session: CaptureSessionRow, labels: Map<string, string>): DraftView {
  const { sessionId: _s, createdAt: _c, ...rest } = d;
  return {
    ...rest,
    sources: d.sources.map((s) => ({ ...s, label: labels.get(s.sourceId) ?? "a removed image", missing: !labels.has(s.sourceId) })),
    explanation: explainDraft(d, (id) => labels.get(id) ?? "a removed image", {
      rule: session.countRule,
      manifest: session.mode === "manifest",
    }),
  };
}

async function loadSession(id: string): Promise<CaptureSessionRow> {
  if (!isUuid(id)) throw notFound("Capture session not found. It may have been deleted.");
  const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, id)).limit(1);
  if (!row) throw notFound("Capture session not found. It may have been deleted.");
  return row;
}

const loadSources = (sessionId: string) =>
  db.select().from(captureSources).where(eq(captureSources.sessionId, sessionId)).orderBy(asc(captureSources.position));

const loadDrafts = (sessionId: string) =>
  db.select().from(captureDrafts).where(eq(captureDrafts.sessionId, sessionId)).orderBy(asc(captureDrafts.position));

export async function getSessionDetail(id: string): Promise<SessionView> {
  const session = await loadSession(id);
  const [sources, drafts, settings, location] = await Promise.all([
    loadSources(id),
    loadDrafts(id),
    getBulkCaptureSettings(),
    session.locationId
      ? db.select({ name: locations.name }).from(locations).where(eq(locations.id, session.locationId)).limit(1)
      : Promise.resolve([]),
  ]);
  const labels = new Map(sources.map((s) => [s.id, sourceLabel(s)]));
  const { visionCalls, imageCap, ...rest } = session;
  const tools = mediaTools();
  return {
    ...rest,
    modeLabel: MODE_LABEL[session.mode],
    locationName: location[0]?.name ?? null,
    cap: { imageCap, used: visionCalls, remaining: Math.max(0, imageCap - visionCalls), instanceMax: settings.maxImagesPerSession },
    toAnalyse: sources.filter((s) => s.status === "pending" || s.status === "analysing").length,
    sources: sources.map(presentSource),
    drafts: drafts.map((d) => presentDraft(d, session, labels)),
    deskCheck:
      session.mode === "desk" && session.deskTemplate
        ? checkDesks(drafts, session.deskTemplate, sources.map((s) => s.area))
        : null,
    counts: {
      pending: drafts.filter((d) => d.status === "pending").length,
      discarded: drafts.filter((d) => d.status === "discarded").length,
      created: drafts.filter((d) => d.status === "created").length,
    },
    tools: { vision: env.llmVisionConfigured, ...tools },
  };
}

export type SessionSummary = {
  id: string;
  mode: CaptureMode;
  modeLabel: string;
  title: string;
  status: CaptureSessionRow["status"];
  locationId: string | null;
  locationName: string | null;
  sources: number;
  toAnalyse: number;
  draftsPending: number;
  draftsCreated: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listSessions(): Promise<SessionSummary[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.mode, s.title, s.status, s.location_id AS "locationId", l.name AS "locationName",
            s.created_by AS "createdBy", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM capture_sources x WHERE x.session_id = s.id) AS sources,
            (SELECT count(*)::int FROM capture_sources x WHERE x.session_id = s.id AND x.status IN ('pending', 'analysing')) AS "toAnalyse",
            (SELECT count(*)::int FROM capture_drafts d WHERE d.session_id = s.id AND d.status = 'pending') AS "draftsPending",
            (SELECT count(*)::int FROM capture_drafts d WHERE d.session_id = s.id AND d.status = 'created') AS "draftsCreated"
       FROM capture_sessions s
       LEFT JOIN locations l ON l.id = s.location_id
      ORDER BY s.updated_at DESC
      LIMIT 200`,
  );
  return rows.map((r: SessionSummary) => ({ ...r, modeLabel: MODE_LABEL[r.mode] }));
}

// ---- Sessions ----------------------------------------------------------------

export type CreateSessionInput = {
  mode: CaptureMode;
  title?: string | null;
  locationId?: string | null;
  imageCap?: number | null;
  countRule?: CaptureCountRule;
  deskTemplateId?: string | null;
};

async function assertLocation(id: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  const [loc] = await db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.id, id)).limit(1);
  if (!loc) throw notFound("That location no longer exists. Pick another.");
  return loc;
}

async function templateFor(id: string | null | undefined): Promise<CaptureDeskTemplate> {
  const { deskTemplates } = await getBulkCaptureSettings();
  if (!id) return deskTemplates[0]!;
  const t = deskTemplates.find((x) => x.id === id);
  if (!t) throw badRequest(`There is no desk template "${id}". Pick one of: ${deskTemplates.map((x) => x.name).join(", ")}.`);
  return t;
}

async function checkCap(cap: number | null | undefined): Promise<number> {
  const { maxImagesPerSession } = await getBulkCaptureSettings();
  if (cap === null || cap === undefined) return maxImagesPerSession;
  if (cap > maxImagesPerSession) {
    throw badRequest(`An administrator allows at most ${maxImagesPerSession} images per session. Lower the cap, or ask for it to be raised in Settings.`);
  }
  return cap;
}

export async function createSession(input: CreateSessionInput, userOid: string | null): Promise<SessionView> {
  const loc = await assertLocation(input.locationId);
  const imageCap = await checkCap(input.imageCap);
  const deskTemplate = input.mode === "desk" ? await templateFor(input.deskTemplateId) : null;
  const date = new Date().toISOString().slice(0, 10);
  const title = input.title?.trim() || `${MODE_LABEL[input.mode]}${loc ? ` of ${loc.name}` : ""}, ${date}`;
  const [row] = await db
    .insert(captureSessions)
    .values({
      mode: input.mode,
      title: title.slice(0, 200),
      locationId: loc?.id ?? null,
      imageCap,
      countRule: input.countRule ?? "max",
      deskTemplate,
      createdBy: userOid,
    })
    .returning();
  logger.info("bulk_capture.session.created", { id: row!.id, mode: input.mode });
  return getSessionDetail(row!.id);
}

export type UpdateSessionInput = {
  title?: string;
  locationId?: string | null;
  imageCap?: number;
  countRule?: CaptureCountRule;
  deskTemplateId?: string;
};

export async function updateSession(id: string, patch: UpdateSessionInput): Promise<SessionView> {
  const session = await loadSession(id);
  const set: Partial<CaptureSessionRow> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw badRequest("Give the session a title.");
    set.title = t.slice(0, 200);
  }
  if (patch.locationId !== undefined) set.locationId = (await assertLocation(patch.locationId))?.id ?? null;
  if (patch.imageCap !== undefined) set.imageCap = await checkCap(patch.imageCap);
  if (patch.deskTemplateId !== undefined) {
    if (session.mode !== "desk") throw badRequest("Only a desk survey uses a desk template.");
    set.deskTemplate = await templateFor(patch.deskTemplateId);
  }
  await db.transaction(async (tx) => {
    await tx.update(captureSessions).set(set).where(eq(captureSessions.id, id));
    if (patch.countRule !== undefined && patch.countRule !== session.countRule) {
      await tx.update(captureSessions).set({ countRule: patch.countRule }).where(eq(captureSessions.id, id));
      const drafts = await tx.select().from(captureDrafts).where(eq(captureDrafts.sessionId, id));
      for (const d of recountAll(drafts, patch.countRule)) {
        await tx.update(captureDrafts).set({ qty: d.qty, updatedAt: new Date() }).where(eq(captureDrafts.id, d.id!));
      }
    }
  });
  return getSessionDetail(id);
}

/** Delete a session, its drafts and its images. Items already created keep their own copies. */
export async function deleteSession(id: string): Promise<void> {
  await loadSession(id);
  await db.delete(captureSessions).where(eq(captureSessions.id, id));
  const files = await deleteAttachmentsForOwner("capture_session", id);
  logger.info("bulk_capture.session.deleted", { id, files });
}

// ---- Sources -----------------------------------------------------------------

type NewSource = {
  attachmentId: string;
  originAttachmentId: string | null;
  kind: CaptureSourceKind;
  frameMs?: number | null;
  pageNo?: number | null;
};

async function lockOpenSession(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: string,
): Promise<CaptureSessionRow> {
  const [s] = await tx.select().from(captureSessions).where(eq(captureSessions.id, id)).for("update");
  if (!s) throw notFound("Capture session not found. It may have been deleted.");
  if (s.status === "committed") {
    throw conflict("This session has already been turned into items. Start a new session to capture more.");
  }
  return s;
}

async function insertSources(sessionId: string, area: string | null, list: NewSource[]): Promise<CaptureSourceRow[]> {
  return db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, sessionId);
    const [{ count, maxPos }] = (await tx
      .select({ count: sql<number>`count(*)::int`, maxPos: sql<number>`coalesce(max(${captureSources.position}), 0)::int` })
      .from(captureSources)
      .where(eq(captureSources.sessionId, sessionId))) as [{ count: number; maxPos: number }];
    if (count + list.length > session.imageCap) throw conflict(capMessage(session.imageCap, count));
    const rows = await tx
      .insert(captureSources)
      .values(
        list.map((s, i) => ({
          sessionId,
          attachmentId: s.attachmentId,
          originAttachmentId: s.originAttachmentId,
          kind: s.kind,
          position: maxPos + i + 1,
          frameMs: s.frameMs ?? null,
          pageNo: s.pageNo ?? null,
          area,
        })),
      )
      .returning();
    await tx.update(captureSessions).set({ updatedAt: new Date() }).where(eq(captureSessions.id, sessionId));
    return rows;
  });
}

async function roomLeft(sessionId: string): Promise<{ left: number; cap: number; count: number }> {
  const session = await loadSession(sessionId);
  if (session.status === "committed") {
    throw conflict("This session has already been turned into items. Start a new session to capture more.");
  }
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(captureSources)
    .where(eq(captureSources.sessionId, sessionId))) as [{ count: number }];
  return { left: Math.max(0, session.imageCap - count), cap: session.imageCap, count };
}

const capMessage = (cap: number, count: number) =>
  `This session is capped at ${cap} images and has ${count}. Remove some, raise the cap, or start another session.`;

const cleanArea = (area: string | null | undefined): string | null => area?.trim().replace(/\s+/g, " ").slice(0, 80) || null;

export type AddSourceResult = { added: SourceView[]; message: string | null };

/**
 * Add an uploaded file to a session. The file is uploaded first with the
 * attachments API (owner type capture_session), so progress and size limits
 * work as for any other file. A photo becomes one source; a video is sampled
 * into frames with ffmpeg; a PDF is rendered page by page with pdftoppm.
 */
export async function addSource(
  sessionId: string,
  input: { attachmentId: string; area?: string | null },
  userOid: string | null,
): Promise<AddSourceResult> {
  const attachment = await getAttachment(input.attachmentId);
  if (!attachment || attachment.ownerType !== "capture_session" || attachment.ownerId !== sessionId) {
    throw badRequest("Upload the file to this session first (owner type capture_session), then add it.");
  }
  const area = cleanArea(input.area);
  const tools = mediaTools();

  const refuse = async (message: string, status: "bad" | "conflict" = "bad"): Promise<never> => {
    // The upload is useless to the session; do not leave it behind.
    await deleteAttachment(attachment.id).catch(() => undefined);
    throw status === "conflict" ? conflict(message) : badRequest(message);
  };

  const { left, cap, count } = await roomLeft(sessionId);
  if (left <= 0) return refuse(capMessage(cap, count), "conflict");

  try {
    if (attachment.mime === "image/heic" || attachment.mime === "image/heif") {
      return await refuse(
        "HEIC photos cannot be sent to the vision model. Set the camera to JPEG (Most Compatible on an iPhone), or convert the photos, and add them again.",
      );
    }
    if (attachment.mime.startsWith("image/")) {
      const rows = await insertSources(sessionId, area, [{ attachmentId: attachment.id, originAttachmentId: null, kind: "photo" }]);
      return { added: rows.map(presentSource), message: null };
    }

    if (attachment.kind === "video") {
      if (!tools.video) {
        return await refuse("Videos cannot be read on this server because ffmpeg is not installed. Take photos instead.");
      }
      const tmp = await attachmentToTempFile(attachment.id, "video");
      const sampled = await (async () => {
        try {
          const duration = await probeDuration(tmp.file);
          return duration ? { duration, frames: await extractFrames(tmp.file, frameTimes(duration, left)) } : null;
        } finally {
          await removeTemp(tmp.dir);
        }
      })();
      if (!sampled) return await refuse("That video could not be read. Record it again, or take photos instead.");
      if (!sampled.frames.length) {
        return await refuse("No frames could be taken from that video. Record it again, or take photos instead.");
      }
      const saved = await saveDerived(
        sessionId,
        attachment.id,
        sampled.frames.map((f) => ({ bytes: f.bytes, frameMs: f.ms })),
        "frame",
        userOid,
      );
      const rows = await insertSourcesOrClean(sessionId, area, saved.map((s) => ({ ...s, kind: "video_frame" as const })));
      const wanted = frameTimes(sampled.duration, Number.MAX_SAFE_INTEGER).length;
      return {
        added: rows.map(presentSource),
        message: `Took ${rows.length} frame${rows.length === 1 ? "" : "s"} from ${mmss(sampled.duration * 1000)} of video${
          wanted > rows.length ? `; the session's image cap allowed no more` : ""
        }.`,
      };
    }

    if (attachment.mime === "application/pdf") {
      if (!tools.pdf) {
        return await refuse(
          "PDF pages cannot be read on this server because pdftoppm (poppler-utils) is not installed. Photograph the pages or upload them as images.",
        );
      }
      const tmp = await attachmentToTempFile(attachment.id, "pdf");
      let pages: { page: number; bytes: Buffer }[];
      let total: number | null;
      try {
        ({ pages, total } = await renderPdfPages(tmp.file, left));
      } catch (err) {
        logger.warn("bulk_capture.pdf.render_failed", { sessionId, err: describeError(err) });
        return await refuse("That PDF could not be read. If it is password protected, remove the password and upload it again.");
      } finally {
        await removeTemp(tmp.dir);
      }
      if (!pages.length) return await refuse("That PDF has no pages that could be read.");
      const saved = await saveDerived(sessionId, attachment.id, pages.map((p) => ({ bytes: p.bytes, pageNo: p.page })), "page", userOid);
      const rows = await insertSourcesOrClean(sessionId, area, saved.map((s) => ({ ...s, kind: "pdf_page" as const })));
      const skipped = total !== null ? total - rows.length : 0;
      return {
        added: rows.map(presentSource),
        message: `Rendered ${rows.length} page${rows.length === 1 ? "" : "s"}${
          skipped > 0 ? `; ${skipped} more did not fit under the session's image cap` : ""
        }.`,
      };
    }
  } catch (err) {
    if (isUniqueViolation(err, "uq_capture_sources_attachment")) throw conflict("That file is already in this session.");
    throw err;
  }

  return refuse(
    `A ${attachment.kind} (${attachment.mime}) cannot be read here. Add photos${tools.video ? ", a video" : ""}${tools.pdf ? " or a PDF" : ""}.`,
  );
}

type Derived = { attachmentId: string; originAttachmentId: string; frameMs?: number | null; pageNo?: number | null };

async function saveDerived(
  sessionId: string,
  originId: string,
  images: { bytes: Buffer; frameMs?: number; pageNo?: number }[],
  stage: "frame" | "page",
  userOid: string | null,
): Promise<Derived[]> {
  const out: Derived[] = [];
  for (const img of images) {
    const a = await saveAttachment({
      ownerType: "capture_session",
      ownerId: sessionId,
      kind: "photo",
      stage,
      mime: "image/jpeg",
      bytes: img.bytes,
      caption: img.frameMs !== undefined ? `Frame at ${mmss(img.frameMs)}` : `Page ${img.pageNo}`,
      meta: { fromAttachmentId: originId, ...(img.frameMs !== undefined ? { frameMs: img.frameMs } : { page: img.pageNo }) },
      createdBy: userOid,
    });
    out.push({ attachmentId: a.id, originAttachmentId: originId, frameMs: img.frameMs ?? null, pageNo: img.pageNo ?? null });
  }
  return out;
}

async function insertSourcesOrClean(sessionId: string, area: string | null, list: NewSource[]): Promise<CaptureSourceRow[]> {
  try {
    return await insertSources(sessionId, area, list);
  } catch (err) {
    for (const s of list) await deleteAttachment(s.attachmentId).catch(() => undefined);
    throw err;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeMerge(
  tx: Tx,
  sessionId: string,
  result: { updated: MergeDraft[]; created: MergeDraft[]; removed?: MergeDraft[] },
): Promise<void> {
  const now = new Date();
  for (const d of result.removed ?? []) await tx.delete(captureDrafts).where(eq(captureDrafts.id, d.id!));
  for (const d of result.updated) {
    await tx
      .update(captureDrafts)
      .set({ ...draftFields(d), updatedAt: now })
      .where(and(eq(captureDrafts.id, d.id!), eq(captureDrafts.sessionId, sessionId)));
  }
  if (result.created.length) {
    const [{ maxPos }] = (await tx
      .select({ maxPos: sql<number>`coalesce(max(${captureDrafts.position}), 0)::int` })
      .from(captureDrafts)
      .where(eq(captureDrafts.sessionId, sessionId))) as [{ maxPos: number }];
    await tx.insert(captureDrafts).values(
      result.created.map((d, i) => ({
        ...draftFields(d),
        // Only a split copy or a hand-added entry carries a location of its own.
        locationId: (d as { locationId?: string | null }).locationId ?? null,
        sessionId,
        position: maxPos + i + 1,
      })),
    );
  }
}

function draftFields(d: MergeDraft) {
  return {
    status: d.status,
    name: d.name,
    category: d.category,
    brand: d.brand,
    model: d.model,
    description: d.description,
    qty: d.qty,
    qtyLocked: d.qtyLocked,
    edited: d.edited,
    manual: d.manual,
    area: d.area,
    confidence: d.confidence,
    sources: d.sources,
    note: d.note,
    lineNo: d.lineNo,
    condition: d.condition,
    conditionCodes: d.conditionCodes,
    stickerColor: d.stickerColor,
    stickerLot: d.stickerLot,
    stickerNumber: d.stickerNumber,
  };
}

type StoredReading = ({ kind: "photo" } & PhotoReading) | ({ kind: "manifest" } & ManifestReading);

/**
 * Fold an image's reading into the drafts in the image's area. For an image
 * read before (its area changed) this replaces what it said, keeping any
 * entry a person edited or deleted; see moveSource.
 */
function remerge(session: CaptureSessionRow, drafts: MergeDraft[], source: CaptureSourceRow, reading: StoredReading) {
  const ref: SourceRef = { sourceId: source.id, attachmentId: source.attachmentId, area: source.area };
  return moveSource(drafts, ref, reading, session.countRule);
}

export async function updateSource(sessionId: string, sourceId: string, patch: { area?: string | null }): Promise<SessionView> {
  await db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, sessionId);
    const [source] = await tx
      .select()
      .from(captureSources)
      .where(and(eq(captureSources.id, sourceId), eq(captureSources.sessionId, sessionId)));
    if (!source) throw notFound("That image is no longer in this session.");
    if (patch.area === undefined) return;
    const next = { ...source, area: cleanArea(patch.area) };
    await tx.update(captureSources).set({ area: next.area }).where(eq(captureSources.id, sourceId));
    // Its entries belong to the new area now; the stored reading is re-merged
    // there, so no second vision call is needed.
    if (source.status === "analysed" && source.result) {
      const drafts = await tx.select().from(captureDrafts).where(eq(captureDrafts.sessionId, sessionId));
      await writeMerge(tx, sessionId, remerge(session, drafts, next, source.result as StoredReading));
    }
  });
  return getSessionDetail(sessionId);
}

export async function removeSource(sessionId: string, sourceId: string): Promise<SessionView> {
  const attachmentId = await db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, sessionId);
    const [source] = await tx
      .select()
      .from(captureSources)
      .where(and(eq(captureSources.id, sourceId), eq(captureSources.sessionId, sessionId)));
    if (!source) throw notFound("That image is no longer in this session.");
    const drafts = await tx.select().from(captureDrafts).where(eq(captureDrafts.sessionId, sessionId));
    const out = withoutSource(drafts, sourceId, session.countRule);
    await writeMerge(tx, sessionId, { ...out, created: [] });
    await tx.delete(captureSources).where(eq(captureSources.id, sourceId));
    return source.attachmentId;
  });
  await deleteAttachment(attachmentId).catch((err) =>
    logger.warn("bulk_capture.source.attachment_delete_failed", { sessionId, attachmentId, err: describeError(err) }),
  );
  return getSessionDetail(sessionId);
}

export async function retrySource(sessionId: string, sourceId: string): Promise<SessionView> {
  const updated = await db
    .update(captureSources)
    .set({ status: "pending", error: null, claimedAt: null })
    .where(and(eq(captureSources.id, sourceId), eq(captureSources.sessionId, sessionId), eq(captureSources.status, "failed")))
    .returning({ id: captureSources.id });
  if (!updated.length) throw badRequest("Only an image whose reading failed can be tried again.");
  return getSessionDetail(sessionId);
}

// ---- Analysis ----------------------------------------------------------------

const MAX_EDGE_SENT = 1600;
// A claim older than this belongs to a request that died; the image is free again.
const STALE_CLAIM = "5 minutes";

export type AnalyseResult = { available: boolean; analysed: number; failed: number; session: SessionView };

type Outcome = { ok: true; reading: StoredReading } | { ok: false; error: string };

async function readSource(session: CaptureSessionRow, source: CaptureSourceRow): Promise<Outcome> {
  let image: { mime: string; bytes: Buffer; width: number | null; height: number | null };
  try {
    const { attachment, bytes } = await readAttachmentBytes(source.attachmentId, 40 * 1024 * 1024);
    if (!attachment.mime.startsWith("image/")) return { ok: false, error: "This file is not an image." };
    image = { mime: attachment.mime, bytes, width: attachment.width, height: attachment.height };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The image could not be opened." };
  }
  const context = { sessionId: session.id, sourceId: source.id };
  if (session.mode === "manifest") {
    const raw = await visionJson({
      event: "ai.bulk_capture.manifest",
      system: MANIFEST_SYSTEM,
      prompt: MANIFEST_PROMPT,
      images: [{ mime: image.mime, bytes: image.bytes }],
      maxTokens: 4000,
      context,
    });
    const reading = normalizeManifest(raw);
    if (!reading) return { ok: false, error: "The page could not be read. Retake it flat, in good light, filling the frame." };
    return { ok: true, reading: { kind: "manifest", ...reading } };
  }
  const raw = await visionJson({
    event: "ai.bulk_capture.photo",
    system: PHOTO_SYSTEM,
    prompt: session.mode === "desk" ? deskPrompt(source.area, session.deskTemplate) : walkthroughPrompt(source.area),
    images: [{ mime: image.mime, bytes: image.bytes }],
    maxTokens: 2000,
    context,
  });
  // Pixel boxes are relative to the copy the model was sent, not the original.
  const scale = image.width && image.height ? Math.min(1, MAX_EDGE_SENT / Math.max(image.width, image.height)) : 1;
  const sent = image.width && image.height ? { width: Math.round(image.width * scale), height: Math.round(image.height * scale) } : null;
  const reading = normalizePhotoReading(raw, sent);
  if (!reading) return { ok: false, error: "The photo could not be read. Try again, or retake it with more light." };
  return { ok: true, reading: { kind: "photo", ...reading } };
}

/**
 * Send the next waiting images to the vision model and merge what it saw.
 * The cost guard is enforced here: images are claimed and counted against the
 * session's cap in one transaction, before any call is made.
 */
export async function analyse(sessionId: string, opts: { limit: number }): Promise<AnalyseResult> {
  if (!env.llmVisionConfigured) {
    return { available: false, analysed: 0, failed: 0, session: await getSessionDetail(sessionId) };
  }
  const { session, claimed } = await db.transaction(async (tx) => {
    const s = await lockOpenSession(tx, sessionId);
    const waiting = sql`${captureSources.sessionId} = ${sessionId} AND (${captureSources.status} = 'pending' OR (${captureSources.status} = 'analysing' AND ${captureSources.claimedAt} < now() - ${STALE_CLAIM}::interval))`;
    const remaining = s.imageCap - s.visionCalls;
    const n = Math.min(opts.limit, Math.max(0, remaining));
    if (n <= 0) {
      const [{ count }] = (await tx.select({ count: sql<number>`count(*)::int` }).from(captureSources).where(waiting)) as [
        { count: number },
      ];
      if (count > 0) {
        throw conflict(
          `This session has used all ${s.imageCap} of its image analyses. Raise its cap to analyse the ${count} still waiting.`,
        );
      }
      return { session: s, claimed: [] as CaptureSourceRow[] };
    }
    const pick = await tx
      .select({ id: captureSources.id })
      .from(captureSources)
      .where(waiting)
      .orderBy(asc(captureSources.position))
      .limit(n)
      .for("update", { skipLocked: true });
    if (!pick.length) return { session: s, claimed: [] as CaptureSourceRow[] };
    const rows = await tx
      .update(captureSources)
      .set({ status: "analysing", claimedAt: new Date(), error: null })
      .where(inArray(captureSources.id, pick.map((p) => p.id)))
      .returning();
    await tx
      .update(captureSessions)
      .set({ visionCalls: sql`${captureSessions.visionCalls} + ${rows.length}`, updatedAt: new Date() })
      .where(eq(captureSessions.id, sessionId));
    return { session: s, claimed: rows.sort((a, b) => a.position - b.position) };
  });

  const outcomes = await Promise.all(claimed.map((src) => readSource(session, src)));
  let analysed = 0;
  let failed = 0;
  for (let i = 0; i < claimed.length; i++) {
    const outcome = outcomes[i]!;
    const src = claimed[i]!;
    await db.transaction(async (tx) => {
      const s = await lockOpenSession(tx, sessionId);
      const [current] = await tx.select().from(captureSources).where(eq(captureSources.id, src.id));
      // Removed while the model was reading it.
      if (!current) return;
      if (!outcome.ok) {
        await tx.update(captureSources).set({ status: "failed", error: outcome.error, analysedAt: new Date() }).where(eq(captureSources.id, src.id));
        failed++;
        return;
      }
      const reading = outcome.reading;
      let area = current.area;
      // A desk number read off a sign names an unlabelled desk.
      if (!area && reading.kind === "photo" && s.mode === "desk" && reading.deskLabel) area = cleanArea(reading.deskLabel);
      const next = { ...current, area };
      const drafts = await tx.select().from(captureDrafts).where(eq(captureDrafts.sessionId, sessionId));
      await writeMerge(tx, sessionId, remerge(s, drafts, next, reading));
      await tx
        .update(captureSources)
        .set({ status: "analysed", area, result: reading as unknown as Record<string, unknown>, error: null, analysedAt: new Date() })
        .where(eq(captureSources.id, src.id));
      analysed++;
    });
  }
  if (claimed.length) logger.info("bulk_capture.analysed", { sessionId, analysed, failed });
  return { available: true, analysed, failed, session: await getSessionDetail(sessionId) };
}

// ---- Reviewing drafts ----------------------------------------------------------

export type DraftInput = {
  name?: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  qty?: number;
  area?: string | null;
  locationId?: string | null;
  lineNo?: number | null;
  condition?: string | null;
  stickerColor?: string | null;
  stickerLot?: string | null;
  stickerNumber?: string | null;
  status?: "pending" | "discarded";
};

const trimOrNull = (v: string | null | undefined, max: number) => (v === undefined ? undefined : v?.trim().slice(0, max) || null);

function draftPatch(input: DraftInput): Partial<CaptureDraftRow> {
  const set: Partial<CaptureDraftRow> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest("Give the entry a name.");
    set.name = name.slice(0, 200);
  }
  const text: [keyof DraftInput & keyof CaptureDraftRow, number][] = [
    ["category", 60],
    ["brand", 80],
    ["model", 80],
    ["description", 1000],
    ["condition", 300],
    ["stickerColor", 30],
    ["stickerLot", 40],
    ["stickerNumber", 40],
  ];
  for (const [k, max] of text) {
    const v = trimOrNull(input[k] as string | null | undefined, max);
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  if (input.area !== undefined) set.area = cleanArea(input.area);
  if (input.qty !== undefined) {
    set.qty = input.qty;
    set.qtyLocked = true;
  }
  if (input.lineNo !== undefined) set.lineNo = input.lineNo;
  if (input.locationId !== undefined) set.locationId = input.locationId;
  return set;
}

async function lockDraft(tx: Tx, sessionId: string, draftId: string): Promise<CaptureDraftRow> {
  if (!isUuid(draftId)) throw notFound("That entry is no longer in this session.");
  const [d] = await tx
    .select()
    .from(captureDrafts)
    .where(and(eq(captureDrafts.id, draftId), eq(captureDrafts.sessionId, sessionId)))
    .for("update");
  if (!d) throw notFound("That entry is no longer in this session.");
  if (d.status === "created") throw conflict("That entry is already an item. Edit the item itself instead.");
  return d;
}

export async function addDraft(sessionId: string, input: DraftInput & { name: string }): Promise<SessionView> {
  if (input.locationId) await assertLocation(input.locationId);
  await db.transaction(async (tx) => {
    await lockOpenSession(tx, sessionId);
    const fields = draftPatch(input);
    const draft = {
      ...emptyDraft({
        ...(fields as Partial<MergeDraft>),
        name: fields.name!,
        category: displayCategory(fields.category ?? null, fields.name),
        manual: true,
        edited: true,
        qtyLocked: true,
      }),
      locationId: fields.locationId ?? null,
    };
    await writeMerge(tx, sessionId, { updated: [], created: [draft] });
  });
  return getSessionDetail(sessionId);
}

export async function updateDraft(sessionId: string, draftId: string, input: DraftInput): Promise<SessionView> {
  if (input.locationId) await assertLocation(input.locationId);
  await db.transaction(async (tx) => {
    await lockOpenSession(tx, sessionId);
    await lockDraft(tx, sessionId, draftId);
    const set = draftPatch(input);
    const { status, ...rest } = input;
    // Restoring or deleting is not an edit; changing a field is.
    if (Object.values(rest).some((v) => v !== undefined)) set.edited = true;
    if (status) set.status = status;
    await tx
      .update(captureDrafts)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(captureDrafts.id, draftId));
  });
  return getSessionDetail(sessionId);
}

export async function mergeDrafts(sessionId: string, ids: string[]): Promise<SessionView> {
  const unique = [...new Set(ids)];
  if (unique.length < 2) throw badRequest("Pick at least two entries to merge.");
  await db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, sessionId);
    const drafts: CaptureDraftRow[] = [];
    for (const id of unique) drafts.push(await lockDraft(tx, sessionId, id));
    if (drafts.some((d) => d.status !== "pending")) throw badRequest("Restore deleted entries before merging them.");
    // The first picked keeps its place and name.
    const [target, ...others] = drafts as [CaptureDraftRow, ...CaptureDraftRow[]];
    const merged = mergeByHand(target, others, session.countRule);
    await writeMerge(tx, sessionId, { updated: [merged], created: [], removed: others });
  });
  return getSessionDetail(sessionId);
}

export async function splitDraft(
  sessionId: string,
  draftId: string,
  how: { by: "source" } | { qty: number },
): Promise<SessionView> {
  await db.transaction(async (tx) => {
    await lockOpenSession(tx, sessionId);
    const d = await lockDraft(tx, sessionId, draftId);
    if ("by" in how) {
      const parts = splitBySource(d);
      if (!parts) throw badRequest("This entry was only seen in one image. Split off a quantity instead.");
      const [first, ...rest] = parts;
      await writeMerge(tx, sessionId, { updated: [first!], created: rest });
    } else {
      const parts = splitByQty(d, how.qty);
      if (!parts) throw badRequest(`Split off between 1 and ${Math.max(1, d.qty - 1)}.`);
      await writeMerge(tx, sessionId, { updated: [parts[0]], created: [parts[1]] });
    }
  });
  return getSessionDetail(sessionId);
}

// ---- Commit --------------------------------------------------------------------

export type CommitOptions = {
  /** Only these entries; all pending ones when omitted. */
  draftIds?: string[];
  /** One item per piece rather than one item with a quantity. */
  individual?: boolean;
  /** Put each area (room, desk) in its own child location, creating it when missing. */
  areaLocations?: boolean;
};

export type CommitResult = {
  created: { draftId: string; name: string; itemIds: string[] }[];
  itemCount: number;
  photos: { saved: number; failed: number };
  session: SessionView;
};

// Splitting a count into separate records is for desks and rooms, not for a
// line of 3,000 cartons.
const MAX_PIECES = 100;

type LocationRef = { id: string; companyId: string | null };

function captureMetadata(session: CaptureSessionRow, d: CaptureDraftRow, piece: string | null): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    capture: {
      sessionId: session.id,
      draftId: d.id,
      mode: session.mode,
      sourceAttachmentIds: [...new Set(d.sources.map((s) => s.attachmentId))],
      ...(d.area ? { area: d.area } : {}),
      ...(piece ? { piece } : {}),
    },
  };
  if (session.mode === "desk" && d.area) meta.desk = d.area;
  if (session.mode === "manifest") {
    meta.manifest = {
      lineNo: d.lineNo,
      conditionCodes: d.conditionCodes,
      condition: d.condition,
      room: d.area,
    };
  }
  // Legacy lot stickers ride in metadata until tag commissioning can hold them as identifiers.
  if (d.stickerColor || d.stickerLot || d.stickerNumber) {
    meta.sticker = { color: d.stickerColor, lot: d.stickerLot, number: d.stickerNumber };
  }
  return meta;
}

/**
 * Turn the reviewed entries into items, in one transaction: all of them or
 * none. Each item records where it came from in metadata.capture, and gets
 * its own copy of the photo (cropped to the thing when the model gave a box)
 * or page it was read from, so it keeps its evidence if the session is later
 * deleted.
 *
 * Items made here skip the background product lookup the item form starts:
 * fifty lookups at once would be slow and cost money, and the lookup remains
 * one tap away on each item.
 */
export async function commitSession(sessionId: string, opts: CommitOptions, userOid: string | null): Promise<CommitResult> {
  const { session, made } = await db.transaction(async (tx) => {
    const session = await lockOpenSession(tx, sessionId);
    let drafts = await tx
      .select()
      .from(captureDrafts)
      .where(and(eq(captureDrafts.sessionId, sessionId), eq(captureDrafts.status, "pending")))
      .orderBy(asc(captureDrafts.position))
      .for("update");
    if (opts.draftIds?.length) {
      const wanted = new Set(opts.draftIds);
      drafts = drafts.filter((d) => wanted.has(d.id));
    }
    if (!drafts.length) throw badRequest("Nothing to create: every entry is deleted or already an item.");
    const tooMany = opts.individual ? drafts.find((d) => d.qty > MAX_PIECES) : undefined;
    if (tooMany) {
      throw badRequest(`“${tooMany.name}” has ${tooMany.qty}; one record per piece is limited to ${MAX_PIECES}. Split it, or create it as one item with a quantity.`);
    }

    // Where each entry goes: its own location, else its area's, else the session's.
    const locIds = [...new Set([session.locationId, ...drafts.map((d) => d.locationId)].filter((x): x is string => Boolean(x)))];
    const known = new Map<string, LocationRef>();
    if (locIds.length) {
      for (const l of await tx.select({ id: locations.id, companyId: locations.companyId }).from(locations).where(inArray(locations.id, locIds))) {
        known.set(l.id, l);
      }
    }
    const base = session.locationId ? known.get(session.locationId) ?? null : null;
    const byArea = new Map<string, LocationRef | null>();
    for (const area of new Set(drafts.map((d) => d.area).filter((a): a is string => Boolean(a)))) {
      const key = area.toLowerCase();
      const [existing] = await tx
        .select({ id: locations.id, companyId: locations.companyId })
        .from(locations)
        .where(and(sql`lower(${locations.name}) = ${key}`, base ? eq(locations.parentId, base.id) : isNull(locations.parentId)))
        .limit(1);
      if (existing) byArea.set(key, existing);
      else if (opts.areaLocations) {
        const [row] = await tx
          .insert(locations)
          .values({ name: area, parentId: base?.id ?? null, companyId: base?.companyId ?? null })
          .returning({ id: locations.id, companyId: locations.companyId });
        byArea.set(key, row!);
      } else byArea.set(key, null);
    }

    const made: { draft: CaptureDraftRow; itemIds: string[] }[] = [];
    for (const d of drafts) {
      const loc = (d.locationId && known.get(d.locationId)) || (d.area && byArea.get(d.area.toLowerCase())) || base;
      const pieces = opts.individual ? d.qty : 1;
      const rows = await tx
        .insert(items)
        .values(
          Array.from({ length: pieces }, (_, i) => ({
            name: d.name,
            description: d.description,
            brand: d.brand,
            model: d.model,
            category: d.category,
            locationId: loc?.id ?? null,
            companyId: loc?.companyId ?? null,
            quantity: opts.individual ? 1 : d.qty,
            enrichmentSource: "bulk-capture",
            metadata: captureMetadata(session, d, pieces > 1 ? `${i + 1} of ${pieces}` : null),
            createdBy: userOid,
          })),
        )
        .returning({ id: items.id });
      const itemIds = rows.map((r) => r.id);
      await tx
        .update(captureDrafts)
        .set({ status: "created", createdItemIds: itemIds, updatedAt: new Date() })
        .where(eq(captureDrafts.id, d.id));
      made.push({ draft: d, itemIds });
    }

    const [{ left }] = (await tx
      .select({ left: sql<number>`count(*)::int` })
      .from(captureDrafts)
      .where(and(eq(captureDrafts.sessionId, sessionId), eq(captureDrafts.status, "pending")))) as [{ left: number }];
    await tx
      .update(captureSessions)
      .set(
        left === 0
          ? { status: "committed", committedAt: new Date(), committedBy: userOid, updatedAt: new Date() }
          : { updatedAt: new Date() },
      )
      .where(eq(captureSessions.id, sessionId));
    return { session, made };
  });

  const itemIds = made.flatMap((m) => m.itemIds);
  for (const m of made) {
    for (const id of m.itemIds) {
      await recordEvent(id, userOid, "created", { name: m.draft.name, source: "bulk-capture", sessionId });
    }
  }
  await publish(
    "capture_session.committed",
    { sessionId, mode: session.mode, title: session.title, locationId: session.locationId, itemIds, entries: made.length },
    { actor: actorFromOid(userOid), subject: { type: "capture_session", id: sessionId } },
  );
  logger.info("bulk_capture.committed", { sessionId, entries: made.length, items: itemIds.length });

  const photos = await attachEvidence(session, made, userOid);
  return {
    created: made.map((m) => ({ draftId: m.draft.id, name: m.draft.name, itemIds: m.itemIds })),
    itemCount: itemIds.length,
    photos,
    session: await getSessionDetail(sessionId),
  };
}

/** The image that best shows an entry: a boxed sighting if there is one, the surest first. */
function bestSource(d: CaptureDraftRow, live: Set<string>) {
  const usable = d.sources.filter((s) => live.has(s.attachmentId));
  return (
    usable
      .slice()
      .sort((a, b) => Number(Boolean(b.bbox)) - Number(Boolean(a.bbox)) || (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null
  );
}

/**
 * Give every created item its own copy of the image it came from. Runs after
 * the items are committed (an attachment needs its owner to exist), so a
 * failure here leaves the items and only costs the picture; it is logged and
 * counted.
 */
async function attachEvidence(
  session: CaptureSessionRow,
  made: { draft: CaptureDraftRow; itemIds: string[] }[],
  userOid: string | null,
): Promise<{ saved: number; failed: number }> {
  const sources = await loadSources(session.id);
  const byAttachment = new Map(sources.map((s) => [s.attachmentId, s]));
  const live = new Set(byAttachment.keys());
  const plan = made
    .map((m) => ({ ...m, source: bestSource(m.draft, live) }))
    .filter((p): p is typeof p & { source: NonNullable<typeof p.source> } => p.source !== null);
  // Decode each image once, one at a time: a decoded 12 MP photo is ~50 MB.
  const groups = new Map<string, typeof plan>();
  for (const p of plan) groups.set(p.source.attachmentId, [...(groups.get(p.source.attachmentId) ?? []), p]);

  let saved = 0;
  let failed = 0;
  for (const [attachmentId, entries] of groups) {
    const src = byAttachment.get(attachmentId)!;
    let img: Awaited<ReturnType<typeof decodeImage>> = null;
    try {
      img = await decodeImage((await readAttachmentBytes(attachmentId, 40 * 1024 * 1024)).bytes);
    } catch (err) {
      logger.warn("bulk_capture.evidence.read_failed", { sessionId: session.id, attachmentId, err: describeError(err) });
    }
    for (const p of entries) {
      if (!img) {
        failed += p.itemIds.length;
        continue;
      }
      const bbox = session.mode === "manifest" ? null : p.source.bbox;
      const bytes = cropJpeg(img, bbox, bbox ? 800 : 1280);
      for (const itemId of p.itemIds) {
        try {
          await saveAttachment({
            ownerType: "item",
            ownerId: itemId,
            kind: "photo",
            stage: "capture",
            mime: "image/jpeg",
            bytes,
            caption: `From “${session.title}”, ${sourceLabel(src)}`.slice(0, 500),
            meta: {
              captureSessionId: session.id,
              draftId: p.draft.id,
              sourceAttachmentId: attachmentId,
              sourceId: src.id,
              bbox,
              ...(src.frameMs !== null ? { frameMs: src.frameMs } : {}),
              ...(src.pageNo !== null ? { page: src.pageNo } : {}),
            },
            createdBy: userOid,
          });
          // A crop of the thing itself is a fair main photo; a room or a page is not.
          if (bbox) await savePhoto(itemId, "image/jpeg", bytes);
          saved++;
        } catch (err) {
          failed++;
          logger.warn("bulk_capture.evidence.save_failed", { sessionId: session.id, itemId, err: describeError(err) });
        }
      }
    }
  }
  return { saved, failed };
}
