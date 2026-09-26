import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { chatReply, startAiStub, type AiStub, type CapturedChat, type CapturedTranscription, type StubResponse } from "./media-ai-core-stub";
import { createCanvas } from "@napi-rs/canvas";
import { STEPS_REPLY, TEARDOWN_TRANSCRIPTION, haveFfmpeg, makeSampleVideo } from "./teardown-fixtures";

// The whole teardown pipeline against a real Postgres, a generated sample
// video and a stand-in AI provider: transcription, steps and parts, step
// pictures, part names from the pictures, resuming, review of a second
// reading, the report and bag labels, backups and the orphan sweep.
//
// CI has no database, so this runs only when TEST_DATABASE_URL names a
// scratch database (it is migrated and written to, and restored from a
// backup, which replaces its items):
//
//   createdb bindex_teardown_test
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_teardown_test \
//     pnpm --filter bindex-server exec tsx --test tests/teardown-pipeline.test.ts

const url = process.env.TEST_DATABASE_URL;
const ffmpeg = haveFfmpeg();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-teardown-data-"));

type Teardown = typeof import("../src/services/teardown");
type Worker = typeof import("../src/services/teardown/worker");
type Pipeline = typeof import("../src/services/teardown/pipeline");
type Media = typeof import("../src/services/media-ai-core");
type Items = typeof import("../src/services/items");
type Client = typeof import("../src/db/client");
type Ffmpeg = typeof import("../src/services/teardown/ffmpeg");
type EnvModule = typeof import("../src/env");

let td: Teardown;
let worker: Worker;
let pipeline: Pipeline;
let media: Media;
let items: Items;
let pool: Client["pool"];
let ff: Ffmpeg;
let envModule: EnvModule;
let stub: AiStub;
let onChat: (c: CapturedChat) => StubResponse;
let onTranscription: (t: CapturedTranscription) => StubResponse;
let video: Buffer;

const isVision = (c: CapturedChat) => c.body.model === "vision-model";
const userText = (c: CapturedChat): string => {
  const messages = c.body.messages as { role: string; content: unknown }[];
  const content = messages.find((m) => m.role === "user")?.content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).find((p) => p.type === "text")?.text ?? "";
};
const imageCount = (c: CapturedChat): number => {
  const messages = c.body.messages as { role: string; content: unknown }[];
  const content = messages.find((m) => m.role === "user")?.content;
  return Array.isArray(content) ? content.filter((p: { type: string }) => p.type === "image_url").length : 0;
};

/** A vision model that recognises the M4 screws in their step's picture, and nothing else. */
function refineReply(c: CapturedChat): StubResponse {
  const id = userText(c).match(/(p\d+): M4 screw /)?.[1];
  return chatReply(JSON.stringify({ parts: id ? [{ id, name: "M4 x 6 mm pan head screw", kind: "hardware" }] : [] }));
}

async function waitForJob(guideId: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = await td.getGuide(guideId);
    if (g.job.status !== "queued" && g.job.status !== "running") return g;
    if (Date.now() > until) throw new Error(`job still ${g.job.status} (${g.job.stage})`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

async function newItemWithVideo(name: string) {
  // A description keeps item creation from asking the stub to enrich it.
  const item = await items.createItem({ name, brand: "Dell", model: "Precision 3660", description: "test" }, null);
  const a = await media.saveAttachment({
    ownerType: "item",
    ownerId: item.id,
    kind: "video",
    stage: "teardown",
    mime: "video/mp4",
    bytes: video,
    createdBy: null,
  });
  return { itemId: item.id, videoId: a.id };
}

describe("teardown pipeline with Postgres", { skip: url ? (ffmpeg ? false : "ffmpeg is not installed") : "set TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    stub = await startAiStub({ chat: (c) => onChat(c), transcription: (t) => onTranscription(t) });
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "error";
    process.env.LLM_BASE_URL = stub.url;
    process.env.LLM_API_KEY = "stub-key";
    process.env.LLM_MODEL = "text-model";
    process.env.LLM_VISION_MODEL = "vision-model";
    process.env.STT_BASE_URL = stub.url;
    process.env.STT_API_KEY = "stt-key";
    process.env.STT_MODEL = "whisper-test";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    td = await import("../src/services/teardown");
    worker = await import("../src/services/teardown/worker");
    pipeline = await import("../src/services/teardown/pipeline");
    media = await import("../src/services/media-ai-core");
    items = await import("../src/services/items");
    ff = await import("../src/services/teardown/ffmpeg");
    envModule = await import("../src/env");
    pool = (await import("../src/db/client")).pool;
    // The narration's timestamps run to 58 s, so the video does too.
    const file = path.join(dataDir, "sample.mp4");
    makeSampleVideo(file, { seconds: 60 });
    video = fs.readFileSync(file);
  });

  after(async () => {
    await stub?.close();
    await pool?.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    stub.chats.length = 0;
    stub.transcriptions.length = 0;
    onTranscription = () => ({ json: TEARDOWN_TRANSCRIPTION });
    onChat = (c) => (isVision(c) ? refineReply(c) : chatReply(JSON.stringify(STEPS_REPLY)));
  });

  let mainGuide: string;

  it("turns a narrated video into numbered steps, parts and step pictures", async () => {
    const { itemId, videoId } = await newItemWithVideo("Lab workstation");
    const created = await td.createGuide({ itemId, videoAttachmentId: videoId }, "tester");
    assert.equal(created.title, "Lab workstation teardown");
    await td.enqueueGuide(created.id);
    const g = await waitForJob(created.id);
    mainGuide = g.id;

    assert.equal(g.job.status, "done", g.job.error ?? "");
    assert.equal(g.job.error, null);
    assert.equal(g.video?.id, videoId);
    assert.ok(Math.abs(g.durationSec! - 60) < 0.5);

    // Transcribed once, as small audio, with a vocabulary hint.
    assert.equal(stub.transcriptions.length, 1);
    const t = stub.transcriptions[0]!;
    assert.equal(t.file?.name, "narration.m4a");
    assert.equal(t.file?.type, "audio/mp4");
    assert.ok(t.file!.size < 400 * 1024, String(t.file?.size));
    assert.equal(t.fields.model, "whisper-test");
    assert.equal(t.fields.response_format, "verbose_json");
    assert.match(t.fields.prompt ?? "", /Lab workstation \(Dell Precision 3660\)/);
    assert.equal(g.transcript?.complete, true);
    assert.equal(g.transcript?.segments.length, 7);

    // One language-model call for this short narration, with timestamps.
    const textCalls = stub.chats.filter((c) => !isVision(c));
    assert.equal(textCalls.length, 1);
    assert.match(userText(textCalls[0]!), /\[12\.8-21\.5\] Next, remove the four M4 screws/);

    assert.deepEqual(
      g.steps.map((s) => [s.n, s.title, s.start, s.end, s.source]),
      STEPS_REPLY.steps.map((s) => [s.n, s.title, s.start, s.end, "narration"]),
    );
    assert.equal(g.steps[1]!.callout, "The fan cable is still attached to the cover");

    // Every step has a picture grabbed from the video, owned by the guide.
    assert.ok(g.steps.every((s) => s.keyframe), JSON.stringify(g.steps.map((s) => s.keyframe)));
    const pictures = await media.listAttachments("teardown_guide", g.id);
    assert.equal(pictures.length, 5);
    assert.ok(pictures.every((p) => p.stage === "keyframe" && p.mime === "image/jpeg"));

    // The vision model saw one picture per step that lost parts, and named
    // the first part better; the name as heard is kept.
    const visionCalls = stub.chats.filter(isVision);
    assert.equal(visionCalls.length, 1);
    assert.equal(imageCount(visionCalls[0]!), 4);
    assert.match(userText(visionCalls[0]!), /p1: Power cord \(cable, qty 1\)/);
    assert.equal(g.parts.length, 7);
    const renamed = g.parts.find((p) => p.heardAs);
    assert.deepEqual([renamed?.name, renamed?.heardAs, renamed?.stepN], ["M4 x 6 mm pan head screw", "M4 screw", 2]);
    assert.equal(g.parts.filter((p) => p.heardAs).length, 1);
    assert.deepEqual(
      g.parts.map((p) => p.stepN),
      [1, 1, 2, 2, 4, 5, 5],
    );
    assert.ok(g.job.notes.some((n) => n.code === "refined"));

    // The finished job is on the audit log for webhooks.
    const { rows } = await pool.query(
      `SELECT data FROM audit_log WHERE type = 'teardown.guide_processed' AND subject_id = $1`,
      [g.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.steps, 5);
    assert.equal(rows[0].data.parts, 7);
  });

  it("prints the report and bag labels", async () => {
    const { pdf } = await td.guideReport(mainGuide, { appName: "Bindex", timeZone: "UTC" });
    const doc = await PDFDocument.load(pdf);
    assert.ok(doc.getPageCount() >= 1);
    const labels = await td.guideBagLabels(mainGuide);
    assert.deepEqual(
      labels.map((l) => l.name),
      ["Step 2: 4 × M4 x 6 mm pan head screw", "Step 5: 6 × Standoff screw"],
    );
    assert.ok(labels.every((l) => /^INV-/.test(l.code) && l.url?.includes(`/teardown/${mainGuide}?step=`)));
  });

  it("edits steps and parts, ticks parts off and resets", async () => {
    let g = await td.getGuide(mainGuide);
    const [s1, s2] = g.steps;
    await td.addStep(mainGuide, { title: "Photograph the cabling", afterN: 0, start: 1, end: 4 });
    g = await td.getGuide(mainGuide);
    assert.deepEqual(g.steps.slice(0, 3).map((s) => s.title), ["Photograph the cabling", s1!.title, s2!.title]);
    assert.equal(g.steps[0]!.source, "manual");

    await td.updateStep(g.steps[0]!.id, { n: 3, callout: "Before touching anything" });
    g = await td.getGuide(mainGuide);
    assert.deepEqual(g.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.equal(g.steps[2]!.title, "Photograph the cabling");
    await assert.rejects(td.updateStep(g.steps[2]!.id, { start: 10, end: 5 }), /cannot end before it starts/);

    await td.deleteStep(g.steps[2]!.id);
    g = await td.getGuide(mainGuide);
    assert.equal(g.steps.length, 5);
    assert.deepEqual(g.steps.map((s) => s.n), [1, 2, 3, 4, 5]);

    await td.addPart(mainGuide, { name: "Rubber foot", qty: 4, stepId: g.steps[4]!.id });
    g = await td.getGuide(mainGuide);
    const foot = g.parts.find((p) => p.name === "Rubber foot")!;
    assert.deepEqual([foot.kind, foot.qty, foot.stepN, foot.source], ["component", 4, 5, "manual"]);

    const screw = g.parts.find((p) => p.name === "Standoff screw")!;
    await td.updatePart(screw.id, { qty: 5 }, "tester");
    await td.updatePart(screw.id, { reassembled: true }, "tester");
    g = await td.getGuide(mainGuide);
    const edited = g.parts.find((p) => p.id === screw.id)!;
    assert.equal(edited.edited, true);
    assert.equal(edited.reassembledBy, "tester");
    assert.ok(edited.reassembledAt);
    assert.deepEqual(await td.reassemblyProgress(mainGuide), { total: 8, done: 1 });
    await td.resetReassembly(mainGuide);
    assert.deepEqual(await td.reassemblyProgress(mainGuide), { total: 8, done: 0 });

    // A step's picture must be the guide's own.
    const { itemId } = g;
    const stray = await media.saveAttachment({
      ownerType: "item",
      ownerId: itemId,
      kind: "photo",
      mime: "image/jpeg",
      bytes: createCanvas(64, 48).toBuffer("image/jpeg"),
      createdBy: null,
    });
    await assert.rejects(td.updateStep(g.steps[0]!.id, { keyframeAttachmentId: stray.id }), /Upload the picture to this guide/);
    // One uploaded to the guide replaces the grabbed one, which is then removed.
    const mine = await media.saveAttachment({
      ownerType: "teardown_guide",
      ownerId: mainGuide,
      kind: "photo",
      stage: "keyframe",
      mime: "image/jpeg",
      bytes: createCanvas(64, 48).toBuffer("image/jpeg"),
      createdBy: null,
    });
    const replaced = g.steps[0]!.keyframe!.id;
    await td.updateStep(g.steps[0]!.id, { keyframeAttachmentId: mine.id });
    assert.equal((await td.getGuide(mainGuide)).steps[0]!.keyframe?.id, mine.id);
    assert.equal(await media.getAttachment(replaced), null);

    // Deleting a part's step leaves the part on the list.
    await td.deleteStep(g.steps[4]!.id);
    g = await td.getGuide(mainGuide);
    assert.equal(g.parts.find((p) => p.name === "Rubber foot")!.stepN, null);
  });

  it("holds a second reading for review when a person already wrote steps", async () => {
    const { itemId, videoId } = await newItemWithVideo("Rack shelf");
    const row = await td.createGuide({ itemId, videoAttachmentId: videoId, title: "Shelf" }, null);
    await td.addStep(row.id, { title: "Written by hand" });
    await td.enqueueGuide(row.id);
    let g = await waitForJob(row.id);
    assert.equal(g.job.status, "done", g.job.error ?? "");
    assert.deepEqual(g.steps.map((s) => s.title), ["Written by hand"]);
    assert.equal(g.draft?.complete, true);
    assert.equal(g.draft?.complete && g.draft.steps.length, 5);
    assert.ok(g.job.notes.some((n) => n.code === "draft_pending"));

    // Continuing does not read the steps again.
    stub.chats.length = 0;
    stub.transcriptions.length = 0;
    await td.enqueueGuide(row.id);
    g = await waitForJob(row.id);
    assert.equal(stub.chats.filter((c) => !isVision(c)).length, 0);
    assert.equal(stub.transcriptions.length, 0);

    await td.applyDraft(row.id);
    g = await td.getGuide(row.id);
    assert.equal(g.draft, null);
    assert.equal(g.steps.length, 5);
    assert.equal(g.parts.length, 7);
    await assert.rejects(td.applyDraft(row.id), /nothing read from the narration/);

    // The new steps get their pictures on the next pass.
    await td.enqueueGuide(row.id);
    g = await waitForJob(row.id);
    assert.ok(g.steps.every((s) => s.keyframe));

    // Reading the steps again keeps the transcript and asks the model again.
    stub.chats.length = 0;
    await td.enqueueGuide(row.id, "steps");
    g = await waitForJob(row.id);
    assert.equal(stub.transcriptions.length, 0);
    assert.equal(stub.chats.filter((c) => !isVision(c)).length, 1);
    assert.equal(g.draft?.complete, true);
    await td.discardDraft(row.id);
    assert.equal((await td.getGuide(row.id)).draft, null);
  });

  it("drafts steps from the transcript when the model gives nothing usable", async () => {
    onChat = (c) => (isVision(c) ? chatReply("{}") : chatReply("I'm sorry, I can't help with that."));
    const { itemId, videoId } = await newItemWithVideo("Workbench");
    const row = await td.createGuide({ itemId, videoAttachmentId: videoId }, null);
    await td.enqueueGuide(row.id);
    const g = await waitForJob(row.id);
    assert.equal(g.job.status, "done");
    assert.equal(g.steps.length, 5);
    assert.equal(g.steps[1]!.title, "Unplug the power cord and the two network cables from the back");
    assert.ok(g.parts.some((p) => p.name === "M4 screw" && p.qty === 4));
    assert.ok(g.job.notes.some((n) => n.code === "model_partial"));
  });

  it("fails clearly when transcription fails, and continues later", async () => {
    onTranscription = () => ({ status: 503, json: { error: { message: "overloaded" } } });
    const { itemId, videoId } = await newItemWithVideo("Server");
    const row = await td.createGuide({ itemId, videoAttachmentId: videoId }, null);
    await td.enqueueGuide(row.id);
    let g = await waitForJob(row.id);
    assert.equal(g.job.status, "failed");
    assert.match(g.job.error ?? "", /did not return a transcript/);
    assert.equal(g.steps.length, 0);
    assert.equal(g.video?.id, videoId);

    onTranscription = () => ({ json: TEARDOWN_TRANSCRIPTION });
    await td.enqueueGuide(row.id);
    g = await waitForJob(row.id);
    assert.equal(g.job.status, "done");
    assert.equal(g.steps.length, 5);
  });

  it("reads a video with no sound track as nothing to transcribe", async () => {
    const file = path.join(dataDir, "silent.mp4");
    makeSampleVideo(file, { seconds: 3, audio: false });
    const item = await items.createItem({ name: "Silent", description: "test" }, null);
    const a = await media.saveAttachment({ ownerType: "item", ownerId: item.id, kind: "video", mime: "video/mp4", bytes: fs.readFileSync(file), createdBy: null });
    const row = await td.createGuide({ itemId: item.id, videoAttachmentId: a.id }, null);
    await td.enqueueGuide(row.id);
    const g = await waitForJob(row.id);
    assert.equal(g.job.status, "done");
    assert.ok(g.job.notes.some((n) => n.code === "no_audio"));
    assert.equal(stub.transcriptions.length, 0);
  });

  it("sends a small video whole when ffmpeg is missing", async () => {
    const saved = envModule.env.FFMPEG_PATH;
    envModule.env.FFMPEG_PATH = path.join(dataDir, "no-ffmpeg-here");
    ff.resetFfmpegDetection();
    try {
      const { itemId, videoId } = await newItemWithVideo("No ffmpeg");
      const row = await td.createGuide({ itemId, videoAttachmentId: videoId }, null);
      await td.enqueueGuide(row.id);
      const g = await waitForJob(row.id);
      assert.equal(g.job.status, "done", g.job.error ?? "");
      assert.equal(stub.transcriptions[0]?.file?.name, "narration.mp4");
      assert.equal(stub.transcriptions[0]?.file?.type, "video/mp4");
      assert.equal(g.steps.length, 5);
      assert.ok(g.steps.every((s) => !s.keyframe));
      assert.ok(g.job.notes.some((n) => n.code === "no_ffmpeg_frames"));
    } finally {
      envModule.env.FFMPEG_PATH = saved;
      ff.resetFfmpegDetection();
    }
  });

  it("guards the job with a lease: stop, take over, give up", async () => {
    const { itemId, videoId } = await newItemWithVideo("Lease");
    const row = await td.createGuide({ itemId, videoAttachmentId: videoId }, null);
    // Queue without waking the worker, then claim by hand.
    await pool.query(`UPDATE teardown_guides SET job_status = 'queued', job_queued_at = now() WHERE id = $1`, [row.id]);
    const claimed = await worker.claimNext();
    assert.equal(claimed?.id, row.id);
    assert.equal(claimed?.attempts, 1);
    await assert.rejects(td.enqueueGuide(row.id), /being processed now/);

    // Stopping it makes the holder's next write fail.
    await td.cancelGuideJob(row.id);
    const ctx = pipeline.jobContext(row.id, claimed!.token, []);
    await assert.rejects(ctx.stage("transcribe"), pipeline.LeaseLost);
    let g = await td.getGuide(row.id);
    assert.equal(g.job.status, "idle");
    assert.ok(g.job.notes.some((n) => n.code === "stopped"));

    // A holder that stops beating is taken over; after three tries it gives up.
    await pool.query(
      `UPDATE teardown_guides SET job_status = 'running', job_attempts = 3, job_token = gen_random_uuid(),
              job_heartbeat_at = now() - interval '1 hour' WHERE id = $1`,
      [row.id],
    );
    const again = await worker.claimNext();
    assert.equal(again?.id, row.id);
    assert.equal(again?.attempts, 4);
    await worker.runJob(again!);
    g = await td.getGuide(row.id);
    assert.equal(g.job.status, "failed");
    assert.match(g.job.error ?? "", /stopped 3 times/);
  });

  it("keeps guides through a JSON backup and restore", async () => {
    const { buildBackup, restoreBackup } = await import("../src/services/backup");
    const before = await td.getGuide(mainGuide);
    const backup = JSON.parse(JSON.stringify(await buildBackup()));
    assert.ok(backup.data.teardown_guides.some((g: { id: string }) => g.id === mainGuide));
    await restoreBackup(backup);
    const afterRestore = await td.getGuide(mainGuide);
    assert.deepEqual(afterRestore.steps.map((s) => [s.title, s.keyframe?.id]), before.steps.map((s) => [s.title, s.keyframe?.id]));
    assert.deepEqual(afterRestore.parts.map((p) => p.name), before.parts.map((p) => p.name));

    // An older file without guides leaves them alone.
    delete backup.data.teardown_guides;
    delete backup.data.teardown_steps;
    delete backup.data.teardown_parts;
    await restoreBackup(backup);
    assert.equal((await td.getGuide(mainGuide)).steps.length, before.steps.length);
  });

  it("removes a deleted item's guides and their pictures", async () => {
    const g = await td.getGuide(mainGuide);
    await items.deleteItem(g.itemId, null);
    // Guides younger than the grace period are left alone.
    assert.equal(await td.sweepOrphanGuides(), 0);
    await pool.query(`UPDATE teardown_guides SET created_at = now() - interval '1 hour' WHERE id = $1`, [mainGuide]);
    assert.ok((await td.sweepOrphanGuides()) >= 1);
    await assert.rejects(td.getGuide(mainGuide), /does not exist/);
    await pool.query(`UPDATE attachments SET created_at = now() - interval '1 hour' WHERE owner_type = 'teardown_guide' AND owner_id = $1`, [mainGuide]);
    await media.sweepOrphans();
    assert.equal((await media.listAttachments("teardown_guide", mainGuide)).length, 0);
  });

  it("deletes a guide with its pictures but not the video", async () => {
    const { itemId, videoId } = await newItemWithVideo("Delete me");
    const row = await td.createGuide({ itemId, videoAttachmentId: videoId }, null);
    await td.enqueueGuide(row.id);
    await waitForJob(row.id);
    assert.ok((await media.listAttachments("teardown_guide", row.id)).length > 0);
    await td.deleteGuide(row.id);
    assert.equal((await media.listAttachments("teardown_guide", row.id)).length, 0);
    assert.ok(await media.getAttachment(videoId));
    assert.deepEqual(await td.listGuides({ itemId }), []);
  });

  it("refuses a video that belongs to another record, or is not a video", async () => {
    const { itemId } = await newItemWithVideo("Mine");
    const { videoId: othersVideo } = await newItemWithVideo("Theirs");
    await assert.rejects(td.createGuide({ itemId, videoAttachmentId: othersVideo }, null), /belongs to a different record/);
    const photo = await media.saveAttachment({
      ownerType: "item",
      ownerId: itemId,
      mime: "application/pdf",
      bytes: Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "latin1"),
      createdBy: null,
    });
    await assert.rejects(td.createGuide({ itemId, videoAttachmentId: photo.id }, null), /made from a video/);
    const listed = await td.listGuides({ q: "Lab workstation" });
    assert.ok(Array.isArray(listed));
  });
});
