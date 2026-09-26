import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline as pipe } from "node:stream/promises";
import { pool } from "../../db/client";
import type { TeardownGuideRow } from "../../db/schema";
import { env } from "../../env";
import { logger } from "../../lib/logger";
import { aiAvailability, chatJson, transcribe, visionJson, type Transcript } from "../ai";
import {
  deleteAttachment,
  getAttachment,
  getAttachmentStream,
  readAttachmentBytes,
  saveAttachment,
  type Attachment,
} from "../media-ai-core";
import {
  REFINE_SYSTEM,
  STEPS_SYSTEM,
  appendDraft,
  buildRefinePrompt,
  buildStepsPrompt,
  clip,
  draftFromTranscript,
  formatClock,
  normalizeRefineReply,
  normalizeStepsReply,
  untimedSegments,
  windowSegments,
  type Draft,
  type RefineEntry,
  type Segment,
} from "./extract";
import { extractAudio, ffmpegAvailable, grabFrame, probe } from "./ffmpeg";
import {
  GUIDE_OWNER,
  KEYFRAME_STAGE,
  equipmentLine,
  getGuideRow,
  getItemRef,
  getUnitRef,
  listPartRows,
  listStepRows,
  writeDraft,
  type JobNote,
} from "./guides";

/**
 * The processing job for one guide: pull the sound track out with ffmpeg,
 * transcribe it with timestamps, have the language model turn it into steps
 * and parts, grab a still per step, and let the vision model name parts from
 * those stills. Every stage stores what it produced before the next begins, so
 * a job interrupted by a restart picks up where it stopped rather than paying
 * for the same transcription twice, and every stage has a way through when
 * its tool or provider is missing.
 */

/** Seconds of audio per transcription request: small uploads, short waits, fine-grained resume. */
export const CHUNK_SEC = 600;
/** Largest video sent for transcription whole when there is no ffmpeg to take the audio out. */
export const DIRECT_MAX_BYTES = 24 * 1024 * 1024;
const REFINE_BATCH = 8;

export class LeaseLost extends Error {
  constructor() {
    super("The job was stopped or taken over.");
    this.name = "LeaseLost";
  }
}

/** A failure with a message meant for the person looking at the guide. */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

export type StoredTranscript = Transcript & {
  complete: boolean;
  chunksDone: number;
  chunksTotal: number;
  /** The provider sent text without timestamps; steps then carry none. */
  untimed?: boolean;
  /** Steps have been read from this transcript (applied, or held for review). */
  stepsRead?: boolean;
};

export type JobContext = {
  guideId: string;
  token: string;
  notes: JobNote[];
  note: (code: string, message: string) => void;
  /** Record the stage shown to people, and prove the job is still held. */
  stage: (name: string, progress?: { done: number; total: number } | null) => Promise<void>;
  /** Write fields on the guide, only while still holding the job. */
  save: (set: Partial<TeardownGuideRow>) => Promise<void>;
};

export function jobContext(guideId: string, token: string, notes: JobNote[]): JobContext {
  const ctx: JobContext = {
    guideId,
    token,
    notes: [...notes],
    note(code, message) {
      const i = ctx.notes.findIndex((n) => n.code === code);
      if (i >= 0) ctx.notes[i] = { code, message };
      else ctx.notes.push({ code, message });
    },
    async save(set) {
      const { rowCount } = await pool.query(
        // Built by hand so jsonb columns are passed as JSON text.
        ...updateSql(guideId, token, { ...set, jobNotes: ctx.notes }),
      );
      if (!rowCount) throw new LeaseLost();
    },
    async stage(name, progress = null) {
      await ctx.save({ jobStage: name, jobProgress: progress });
    },
  };
  return ctx;
}

const COLUMNS: Partial<Record<keyof TeardownGuideRow, string>> = {
  jobStage: "job_stage",
  jobProgress: "job_progress",
  jobNotes: "job_notes",
  jobStatus: "job_status",
  jobError: "job_error",
  jobFinishedAt: "job_finished_at",
  jobToken: "job_token",
  transcript: "transcript",
  draft: "draft",
  durationSec: "duration_sec",
  refinedAt: "refined_at",
};
const JSON_COLUMNS = new Set(["job_progress", "job_notes", "transcript", "draft"]);

function updateSql(guideId: string, token: string, set: Partial<TeardownGuideRow>): [string, unknown[]] {
  const values: unknown[] = [guideId, token];
  const parts = ["job_heartbeat_at = now()", "updated_at = now()"];
  for (const [key, value] of Object.entries(set)) {
    const column = COLUMNS[key as keyof TeardownGuideRow];
    if (!column) throw new Error(`teardown job cannot write ${key}`);
    values.push(JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value);
    parts.push(`${column} = $${values.length}`);
  }
  return [`UPDATE teardown_guides SET ${parts.join(", ")} WHERE id = $1 AND job_token = $2`, values];
}

// ---- Working files --------------------------------------------------------------

/** Scratch space under DATA_DIR, which is sized for video; /tmp in a container often is not. */
export const workRoot = () => path.join(env.dataDir, "teardown-work");

class WorkDir {
  readonly dir: string;
  private sourcePath: string | null = null;

  constructor(guideId: string) {
    this.dir = path.join(workRoot(), guideId);
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  /**
   * A local copy of the video for ffmpeg, which needs to seek (phones write
   * the index at the end of the file, so a pipe will not do). Reused across a
   * resumed job when it is already complete.
   */
  async source(video: Attachment): Promise<string> {
    if (this.sourcePath) return this.sourcePath;
    await fsp.mkdir(this.dir, { recursive: true });
    const file = this.file(`source-${video.id}`);
    const existing = await fsp.stat(file).catch(() => null);
    if (existing?.size !== video.sizeBytes) {
      const opened = await getAttachmentStream(video.id);
      if (opened.status === 416) throw new JobFailure("The video file is empty. Upload it again.");
      await pipe(opened.stream, fs.createWriteStream(file));
    }
    this.sourcePath = file;
    return file;
  }

  async cleanup(): Promise<void> {
    await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- Stages --------------------------------------------------------------------------

function storedTranscript(raw: Record<string, unknown> | null): StoredTranscript | null {
  if (!raw || typeof raw.text !== "string" || !Array.isArray(raw.segments)) return null;
  return raw as unknown as StoredTranscript;
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

async function transcribeStage(
  ctx: JobContext,
  video: Attachment,
  work: WorkDir,
  hasFfmpeg: boolean,
  equipment: string | null,
  previous: StoredTranscript | null,
): Promise<StoredTranscript | null> {
  if (!aiAvailability().transcription) {
    ctx.note(
      "no_transcription",
      "Speech to text is not configured, so the narration was not read. The video is attached: write the steps by hand, or see docs/teardown.md to set up transcription.",
    );
    return null;
  }
  const hint = equipment ? clip(`Taking apart ${equipment}.`, 200) : undefined;

  if (!hasFfmpeg) {
    if (video.sizeBytes > DIRECT_MAX_BYTES) {
      ctx.note(
        "no_ffmpeg_large",
        `ffmpeg is not installed, and at ${mb(video.sizeBytes)} the video is too large to send for transcription as it is. Install ffmpeg (see docs/teardown.md) and read the narration again, or write the steps by hand.`,
      );
      return null;
    }
    await ctx.stage("transcribe", { done: 0, total: 1 });
    const opened = await getAttachmentStream(video.id);
    if (opened.status === 416) throw new JobFailure("The video file is empty. Upload it again.");
    const ext = video.mime.split("/")[1]?.replace("quicktime", "mov").replace(/[^a-z0-9]/g, "") || "mp4";
    const result = await transcribe({ stream: opened.stream, mime: video.mime, filename: `narration.${ext}`, prompt: hint });
    if (!result) {
      throw new JobFailure(
        "The transcription service did not return a transcript. Without ffmpeg the whole video is sent, which some providers refuse: install ffmpeg (see docs/teardown.md), or check the server log for ai.transcribe and try again.",
      );
    }
    const t: StoredTranscript = { ...result, complete: true, chunksDone: 1, chunksTotal: 1, untimed: !result.segments.length };
    await ctx.save({
      transcript: t as unknown as Record<string, unknown>,
      durationSec: result.durationSec ?? (video.durationMs ? video.durationMs / 1000 : null),
    });
    return t;
  }

  await ctx.stage("audio");
  const src = await work.source(video);
  const info = await probe(src).catch((err: Error) => {
    throw new JobFailure(`${err.message} Check that the upload is a complete video.`);
  });
  const duration = info.durationSec ?? (video.durationMs ? video.durationMs / 1000 : null);
  if (duration) await ctx.save({ durationSec: duration });
  if (!info.hasAudio) {
    ctx.note("no_audio", "The video has no sound track, so there is no narration to read. Write the steps by hand.");
    const t: StoredTranscript = { text: "", segments: [], complete: true, chunksDone: 0, chunksTotal: 0 };
    await ctx.save({ transcript: t as unknown as Record<string, unknown> });
    return t;
  }

  const total = duration ? Math.max(1, Math.ceil(duration / CHUNK_SEC)) : 1;
  const t: StoredTranscript =
    previous && !previous.complete && previous.chunksTotal === total
      ? previous
      : { text: "", segments: [], complete: false, chunksDone: 0, chunksTotal: total };
  for (let i = t.chunksDone; i < total; i++) {
    await ctx.stage("transcribe", { done: i, total });
    const out = work.file(`audio-${i}.m4a`);
    await extractAudio(src, out, total > 1 ? { startSec: i * CHUNK_SEC, durationSec: CHUNK_SEC } : {}).catch(
      (err: Error) => {
        throw new JobFailure(`${err.message} The video may be damaged; try uploading it again.`);
      },
    );
    const piece = await transcribe({ path: out, mime: "audio/mp4", filename: "narration.m4a", prompt: hint });
    await fsp.rm(out, { force: true });
    if (!piece) {
      throw new JobFailure(
        "The transcription service did not return a transcript. Check the server log for ai.transcribe, then try again: what was already transcribed is kept.",
      );
    }
    const offset = total > 1 ? i * CHUNK_SEC : 0;
    t.segments.push(...piece.segments.map((s) => ({ start: s.start + offset, end: s.end + offset, text: s.text })));
    if (!piece.segments.length && piece.text) t.untimed = true;
    t.text = `${t.text} ${piece.text}`.trim();
    t.language ??= piece.language;
    t.chunksDone = i + 1;
    await ctx.save({ transcript: t as unknown as Record<string, unknown> });
  }
  t.complete = true;
  if (duration) t.durationSec = duration;
  await ctx.save({ transcript: t as unknown as Record<string, unknown> });
  return t;
}

async function stepsStage(ctx: JobContext, t: StoredTranscript, equipment: string | null): Promise<void> {
  const row = await getGuideRow(ctx.guideId);
  if (!row) throw new LeaseLost();
  const timed = !t.untimed && t.segments.length > 0;
  const segments: Segment[] = timed ? t.segments : untimedSegments(t.text);
  if (!segments.length) {
    ctx.note("no_speech", "No speech was found in the narration, so no steps were written from it.");
    await ctx.save({ transcript: { ...t, stepsRead: true } as unknown as Record<string, unknown> });
    return;
  }

  const windows = windowSegments(segments);
  const stored = row.draft as { complete?: boolean; windowsDone?: number; windowsTotal?: number; steps?: Draft["steps"]; parts?: Draft["parts"] } | null;
  let draft: Draft = { steps: [], parts: [] };
  let from = 0;
  if (stored && !stored.complete && stored.windowsTotal === windows.length && Array.isArray(stored.steps)) {
    draft = { steps: stored.steps, parts: Array.isArray(stored.parts) ? stored.parts : [] };
    from = stored.windowsDone ?? 0;
  }

  if (!aiAvailability().languageModel) {
    draft = draftFromTranscript(segments, { timed });
    ctx.note(
      "no_language_model",
      "No language model is configured, so steps were drafted straight from the transcript, one per pause or \"next\". Check them over.",
    );
  } else {
    const missed: string[] = [];
    for (let i = from; i < windows.length; i++) {
      const w = windows[i]!;
      await ctx.stage("steps", { done: i, total: windows.length });
      const reply = await chatJson({
        event: "teardown.steps",
        system: STEPS_SYSTEM,
        user: buildStepsPrompt({
          window: w,
          windowCount: windows.length,
          stepsBefore: draft.steps.length,
          lastStepTitle: draft.steps[draft.steps.length - 1]?.title,
          partsSoFar: draft.parts.map((p) => p.name),
          equipment,
          timed,
        }),
        maxTokens: 2000,
        context: { guideId: ctx.guideId, window: i },
      });
      let piece = normalizeStepsReply(reply, timed ? { start: w.start, end: w.end } : null);
      if (!piece) {
        piece = draftFromTranscript(w.segments, { timed });
        missed.push(timed ? `${formatClock(w.start)}–${formatClock(w.end)}` : `part ${i + 1}`);
      }
      draft = appendDraft(draft, piece);
      await ctx.save({
        draft: { complete: false, windowsDone: i + 1, windowsTotal: windows.length, steps: draft.steps, parts: draft.parts },
      });
    }
    if (missed.length) {
      ctx.note(
        "model_partial",
        `The language model did not answer for ${missed.join(", ")}; the steps there were drafted straight from the transcript.`,
      );
    }
  }

  const [steps, parts] = await Promise.all([listStepRows(ctx.guideId), listPartRows(ctx.guideId)]);
  if (!steps.length && !parts.length) {
    if (!(await writeDraft(ctx.guideId, draft, ctx.token))) throw new LeaseLost();
  } else {
    await ctx.save({ draft: { complete: true, steps: draft.steps, parts: draft.parts } });
    ctx.note(
      "draft_pending",
      `The narration gave ${draft.steps.length} steps and ${draft.parts.length} parts. This guide already had steps, so they are waiting for you to use them in place of the current ones, or discard them.`,
    );
  }
  await ctx.save({ transcript: { ...t, stepsRead: true } as unknown as Record<string, unknown> });
}

async function keyframesStage(ctx: JobContext, video: Attachment, work: WorkDir, durationSec: number | null): Promise<void> {
  const steps = await listStepRows(ctx.guideId);
  const targets = steps
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => s.startSec !== null && !s.keyframeAttachmentId);
  if (!targets.length) return;
  const src = await work.source(video);
  let done = 0;
  for (const { s, n } of targets) {
    await ctx.stage("keyframes", { done: done++, total: targets.length });
    const start = s.startSec!;
    // The middle of the step shows the action better than its first words do.
    let at = s.endSec !== null && s.endSec > start ? (start + s.endSec) / 2 : start + 1;
    if (durationSec) at = Math.min(at, Math.max(0, durationSec - 0.25));
    const out = work.file(`frame-${s.id}.jpg`);
    const ok = (await grabFrame(src, out, at)) || (await grabFrame(src, out, start));
    if (!ok) continue;
    const bytes = await fsp.readFile(out);
    await fsp.rm(out, { force: true });
    const saved = await saveAttachment({
      ownerType: GUIDE_OWNER,
      ownerId: ctx.guideId,
      kind: "photo",
      stage: KEYFRAME_STAGE,
      mime: "image/jpeg",
      bytes,
      caption: clip(`Step ${n}: ${s.title}`, 500),
      meta: { stepId: s.id, atSec: Math.round(at * 100) / 100, source: "ffmpeg" },
      createdBy: null,
    });
    // Only where nobody picked a picture in the meantime, and only while the
    // job is still ours.
    const { rowCount } = await pool.query(
      `UPDATE teardown_steps s SET keyframe_attachment_id = $1, updated_at = now()
        WHERE s.id = $2 AND s.keyframe_attachment_id IS NULL
          AND EXISTS (SELECT 1 FROM teardown_guides g WHERE g.id = s.guide_id AND g.job_token = $3)`,
      [saved.id, s.id, ctx.token],
    );
    if (!rowCount) await deleteAttachment(saved.id).catch(() => undefined);
  }
}

async function refineStage(ctx: JobContext, equipment: string | null): Promise<void> {
  if (!aiAvailability().vision) return;
  const row = await getGuideRow(ctx.guideId);
  if (!row || row.refinedAt) return;
  const [steps, parts] = await Promise.all([listStepRows(ctx.guideId), listPartRows(ctx.guideId)]);
  const entries: (RefineEntry & { keyframeId: string })[] = [];
  const idOf = new Map<string, string>();
  const asked = new Map<string, { name: string; kind: (typeof parts)[number]["kind"] }>();
  steps.forEach((s, i) => {
    if (!s.keyframeAttachmentId) return;
    const mine = parts.filter((p) => p.stepId === s.id && p.source === "narration" && !p.edited);
    if (!mine.length) return;
    entries.push({
      stepN: i + 1,
      stepTitle: s.title,
      keyframeId: s.keyframeAttachmentId,
      parts: mine.map((p) => {
        const short = `p${idOf.size + 1}`;
        idOf.set(short, p.id);
        asked.set(short, { name: p.name, kind: p.kind });
        return { id: short, name: p.name, kind: p.kind, qty: p.qty };
      }),
    });
  });
  if (!entries.length) {
    await ctx.save({ refinedAt: new Date() });
    return;
  }

  const batches = Math.ceil(entries.length / REFINE_BATCH);
  let answered = 0;
  let renamed = 0;
  for (let b = 0; b < batches; b++) {
    await ctx.stage("refine", { done: b, total: batches });
    const batch = entries.slice(b * REFINE_BATCH, (b + 1) * REFINE_BATCH);
    const images = [];
    const usable: typeof batch = [];
    for (const e of batch) {
      try {
        const { attachment, bytes } = await readAttachmentBytes(e.keyframeId, 16 * 1024 * 1024);
        images.push({ mime: attachment.mime, bytes });
        usable.push(e);
      } catch {
        // A picture deleted meanwhile: leave that step's parts as heard.
      }
    }
    if (!usable.length) continue;
    const reply = await visionJson({
      event: "teardown.refine",
      system: REFINE_SYSTEM,
      prompt: buildRefinePrompt(usable, equipment),
      images,
      maxTokens: 1200,
      context: { guideId: ctx.guideId, batch: b },
    });
    if (!reply) continue;
    answered++;
    const batchAsked = new Map(usable.flatMap((e) => e.parts.map((p) => [p.id, asked.get(p.id)!] as const)));
    for (const [short, change] of normalizeRefineReply(reply, batchAsked)) {
      const { rowCount } = await pool.query(
        `UPDATE teardown_parts SET name = $1, kind = $2, heard_as = COALESCE(heard_as, name), updated_at = now()
          WHERE id = $3 AND edited = false`,
        [change.name, change.kind, idOf.get(short)],
      );
      renamed += rowCount ?? 0;
    }
  }
  if (answered) {
    await ctx.save({ refinedAt: new Date() });
    if (renamed) {
      ctx.note("refined", `${renamed} part name${renamed === 1 ? " was" : "s were"} made more specific from the step pictures.`);
    }
  } else {
    ctx.note("refine_unanswered", "The vision model did not answer, so part names are as heard in the narration.");
  }
}

// ---- The whole job ------------------------------------------------------------------

export type JobOutcome = { transcribed: boolean; steps: number; parts: number; notes: JobNote[] };

export async function processGuide(ctx: JobContext): Promise<JobOutcome> {
  const row = await getGuideRow(ctx.guideId);
  if (!row) throw new LeaseLost();
  const [item, unit] = await Promise.all([getItemRef(row.itemId), getUnitRef(row.unitId)]);
  const equipment = equipmentLine(item, unit);
  const video = row.videoAttachmentId ? await getAttachment(row.videoAttachmentId) : null;
  if (!video) {
    ctx.note("no_video", "The video is no longer attached, so there is nothing to read. Attach one, or write the steps by hand.");
    return { transcribed: false, steps: 0, parts: 0, notes: ctx.notes };
  }
  const hasFfmpeg = await ffmpegAvailable();
  const work = new WorkDir(ctx.guideId);
  let transcribed = false;
  try {
    let t = storedTranscript(row.transcript);
    if (!t?.complete) t = await transcribeStage(ctx, video, work, hasFfmpeg, equipment, t);
    transcribed = !!t?.complete;
    if (t?.complete && !t.stepsRead) await stepsStage(ctx, t, equipment);

    if (video.kind === "video") {
      if (hasFfmpeg) {
        const fresh = await getGuideRow(ctx.guideId);
        await keyframesStage(ctx, video, work, fresh?.durationSec ?? t?.durationSec ?? null);
      } else {
        ctx.note(
          "no_ffmpeg_frames",
          "ffmpeg is not installed, so steps have no pictures from the video. Use \"Use this frame\" on a step to take one while watching.",
        );
      }
    }
    await refineStage(ctx, equipment);
  } finally {
    await work.cleanup();
  }

  const [steps, parts] = await Promise.all([listStepRows(ctx.guideId), listPartRows(ctx.guideId)]);
  logger.info("teardown.job.processed", {
    guideId: ctx.guideId,
    transcribed,
    steps: steps.length,
    parts: parts.length,
    notes: ctx.notes.map((n) => n.code),
  });
  return { transcribed, steps: steps.length, parts: parts.length, notes: ctx.notes };
}
