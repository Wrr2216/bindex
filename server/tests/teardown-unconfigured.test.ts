import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { haveFfmpeg, makeSampleVideo } from "./teardown-fixtures";

// With no transcription or language model configured, a teardown guide still
// holds its video, processing finishes with a note rather than an error, and
// steps and parts are written by hand. Needs Postgres (see
// teardown-pipeline.test.ts); ffmpeg is used when installed.

const url = process.env.TEST_DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-teardown-plain-"));

type Teardown = typeof import("../src/services/teardown");
type Media = typeof import("../src/services/media-ai-core");
type Client = typeof import("../src/db/client");
let td: Teardown;
let media: Media;
let pool: Client["pool"];

async function waitForJob(guideId: string) {
  const until = Date.now() + 60_000;
  for (;;) {
    const g = await td.getGuide(guideId);
    if (g.job.status !== "queued" && g.job.status !== "running") return g;
    if (Date.now() > until) throw new Error(`job still ${g.job.status}`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

describe("teardown guides with no AI provider", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "error";
    process.env.LLM_API_KEY = "";
    process.env.STT_API_KEY = "";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    td = await import("../src/services/teardown");
    media = await import("../src/services/media-ai-core");
    pool = (await import("../src/db/client")).pool;
  });

  after(async () => {
    await pool?.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps the video, notes why nothing was read, and takes steps by hand", async () => {
    const { aiAvailability } = await import("../src/services/ai");
    assert.deepEqual(aiAvailability(), { languageModel: false, vision: false, transcription: false });

    const { createItem } = await import("../src/services/items");
    const item = await createItem({ name: "Pallet racking bay 4" }, null);
    let bytes: Buffer;
    if (haveFfmpeg()) {
      const file = path.join(dataDir, "bay.mp4");
      makeSampleVideo(file, { seconds: 6 });
      bytes = fs.readFileSync(file);
    } else {
      // Enough of an MP4 header for the type check; ffmpeg is not there to read it.
      bytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom\0\0\0\0isom", "latin1"), Buffer.alloc(4096)]);
    }
    const video = await media.saveAttachment({ ownerType: "item", ownerId: item.id, kind: "video", stage: "teardown", mime: "video/mp4", bytes, createdBy: null });

    const row = await td.createGuide({ itemId: item.id, videoAttachmentId: video.id, title: "Bay 4 teardown" }, null);
    await td.enqueueGuide(row.id);
    let g = await waitForJob(row.id);
    assert.equal(g.job.status, "done");
    assert.equal(g.job.error, null);
    assert.ok(g.job.notes.some((n) => n.code === "no_transcription"), JSON.stringify(g.job.notes));
    assert.equal(g.transcript, null);
    assert.equal(g.steps.length, 0);

    // The video is the item's, in its gallery, and the guide's.
    assert.equal(g.video?.id, video.id);
    const gallery = await media.listAttachments("item", item.id, { kind: "video" });
    assert.deepEqual(gallery.map((a) => a.id), [video.id]);

    await td.addStep(row.id, { title: "Unload the shelves", instruction: "Top shelf first.", start: 1, end: 2.5 });
    await td.addStep(row.id, { title: "Remove the beams", callout: "Keep the safety pins", start: 3, end: 5 });
    g = await td.getGuide(row.id);
    await td.addPart(row.id, { name: "Beam safety pin", qty: 8, stepId: g.steps[1]!.id });
    await td.addPart(row.id, { name: "Beam", qty: 4, kind: "component", stepId: g.steps[1]!.id });
    g = await td.getGuide(row.id);
    assert.deepEqual(g.steps.map((s) => [s.n, s.title, s.source]), [
      [1, "Unload the shelves", "manual"],
      [2, "Remove the beams", "manual"],
    ]);
    assert.deepEqual(g.parts.map((p) => [p.name, p.kind, p.qty, p.stepN]), [
      ["Beam safety pin", "hardware", 8, 2],
      ["Beam", "component", 4, 2],
    ]);

    // Processing again still reads nothing, but grabs pictures for the
    // hand-written steps when ffmpeg is there.
    await td.enqueueGuide(row.id);
    g = await waitForJob(row.id);
    assert.equal(g.job.status, "done");
    if (haveFfmpeg()) assert.ok(g.steps.every((s) => s.keyframe));
    else assert.ok(g.job.notes.some((n) => n.code === "no_ffmpeg_frames"));

    const labels = await td.guideBagLabels(row.id);
    assert.deepEqual(labels.map((l) => l.name), ["Step 2: 8 × Beam safety pin"]);
  });

  it("makes a guide with no video, which cannot be processed", async () => {
    const { createItem } = await import("../src/services/items");
    const item = await createItem({ name: "Workstation" }, null);
    const row = await td.createGuide({ itemId: item.id }, null);
    assert.equal(row.title, "Workstation teardown");
    await assert.rejects(td.enqueueGuide(row.id), /Attach a video/);
    const listed = await td.listGuides({ itemId: item.id });
    assert.deepEqual(listed.map((l) => [l.title, l.stepCount, l.job.status]), [["Workstation teardown", 0, "idle"]]);
  });
});
