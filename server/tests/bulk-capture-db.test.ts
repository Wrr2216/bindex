import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  DESK_PHOTO,
  MANIFEST_PAGE_1,
  MANIFEST_PAGE_1_AGAIN,
  ROOM_PHOTO_1,
  ROOM_PHOTO_2,
  ROOM_PHOTO_3,
} from "./bulk-capture-fixtures";
import { chatReply, startAiStub, type AiStub, type StubResponse } from "./media-ai-core-stub";

// Capture sessions against a real Postgres and a stand-in vision provider:
// fixture replies for three overlapping photos become a merged, editable
// draft, and nothing is created until the draft is committed. CI has no
// database, so this runs only when TEST_DATABASE_URL names a scratch database
// (it is migrated and written to):
//
//   createdb bindex_bulk_capture_test
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_bulk_capture_test \
//     pnpm --filter bindex-server exec tsx --test tests/bulk-capture-db.test.ts

const url = process.env.TEST_DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-capture-db-"));
const RUN = Date.now().toString(36);
const USER = `local:bulk-capture-test-${RUN}`;

type Capture = typeof import("../src/services/bulk-capture");
type Media = typeof import("../src/services/media-ai-core");
type Client = typeof import("../src/db/client");
let capture: Capture;
let media: Media;
let pool: Client["pool"];
let stub: AiStub;
let replies: StubResponse[] = [];

const onPath = (name: string) =>
  (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));

function photo(colour: string): Buffer {
  const c = createCanvas(640, 480);
  const ctx = c.getContext("2d");
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 640, 480);
  return c.toBuffer("image/jpeg");
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return Number(rows[0]!.n);
}

const itemCount = () => count("SELECT count(*)::int AS n FROM items");

async function upload(sessionId: string, bytes: Buffer, mime: string) {
  return media.saveAttachment({ ownerType: "capture_session", ownerId: sessionId, bytes, mime, stage: "source", createdBy: USER });
}

async function addPhotos(sessionId: string, n: number, area: string | null = null) {
  const colours = ["#336699", "#996633", "#669933", "#aa3366", "#33aa66"];
  for (let i = 0; i < n; i++) {
    const a = await upload(sessionId, photo(colours[i % colours.length]!), "image/jpeg");
    await capture.addSource(sessionId, { attachmentId: a.id, area }, USER);
  }
}

const queue = (...bodies: unknown[]) => {
  replies = bodies.map((b) => (typeof b === "string" ? chatReply(b) : chatReply(JSON.stringify(b))));
};

describe("bulk capture with Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let roomId: string;

  before(async () => {
    stub = await startAiStub({
      chat: () => replies.shift() ?? { status: 500, json: { error: { message: "no reply queued" } } },
    });
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "error";
    process.env.LLM_BASE_URL = stub.url;
    process.env.LLM_API_KEY = "stub-key";
    process.env.LLM_VISION_MODEL = "vision-model";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    capture = await import("../src/services/bulk-capture");
    media = await import("../src/services/media-ai-core");
    pool = (await import("../src/db/client")).pool;
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO locations (name) VALUES ($1) RETURNING id",
      [`Conference Room B ${RUN}`],
    );
    roomId = rows[0]!.id;
  });

  after(async () => {
    await stub?.close();
    await pool?.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    replies = [];
  });

  it("merges three overlapping photos into an editable draft, and creates nothing until committed", async () => {
    const before = await itemCount();
    let s = await capture.createSession({ mode: "walkthrough", locationId: roomId, imageCap: 5 }, USER);
    assert.equal(s.title.startsWith(`Walkthrough of Conference Room B ${RUN}`), true);
    await addPhotos(s.id, 3);

    queue(ROOM_PHOTO_1, ROOM_PHOTO_2, ROOM_PHOTO_3);
    for (let i = 0; i < 3; i++) {
      const r = await capture.analyse(s.id, { limit: 1 });
      assert.equal(r.analysed, 1);
      s = r.session;
    }
    assert.equal(stub.chats.length >= 3, true);
    assert.equal(s.toAnalyse, 0);
    assert.deepEqual(s.cap, { imageCap: 5, used: 3, remaining: 2, instanceMax: 40 });
    assert.deepEqual(s.sources.map((x) => [x.label, x.status, x.found]), [
      ["photo 1", "analysed", 4],
      ["photo 2", "analysed", 4],
      ["photo 3", "analysed", 5],
    ]);
    assert.equal(s.drafts.length, 9);
    const chairs = s.drafts.find((d) => d.name === "black office chair")!;
    assert.equal(chairs.qty, 6);
    assert.equal(chairs.sources.length, 3);
    assert.match(chairs.explanation!, /^Seen in photo 1 \(4\), photo 2 \(6\) and photo 3 \(3\)\. Overlapping photos/);
    assert.equal(await itemCount(), before, "analysis creates no items");

    // Review: merge the two names for the screen, delete the whiteboard,
    // correct the chair count, split the table's sightings and put them back.
    const byName = (n: string) => s.drafts.find((d) => d.name === n)!;
    s = await capture.mergeDrafts(s.id, [byName("TV").id, byName("television").id]);
    s = await capture.updateDraft(s.id, byName("whiteboard").id, { status: "discarded" });
    s = await capture.updateDraft(s.id, byName("black office chair").id, { qty: 7, name: "Black office chair" });
    s = await capture.splitDraft(s.id, byName("conference table").id, { by: "source" });
    const tables = s.drafts.filter((d) => d.name === "conference table");
    assert.equal(tables.length, 2);
    s = await capture.mergeDrafts(s.id, tables.map((t) => t.id));
    s = await capture.addDraft(s.id, { name: "Projector screen", qty: 1, category: "av" });
    assert.deepEqual(s.counts, { pending: 8, discarded: 1, created: 0 });
    assert.equal(await itemCount(), before, "reviewing creates no items");

    // Photo 3 again (a retry) replaces its own contribution rather than doubling it.
    const tv = byName("TV");
    assert.match(s.drafts.find((d) => d.id === tv.id)!.note!, /Merged by hand/);

    const result = await capture.commitSession(s.id, {}, USER);
    assert.equal(result.itemCount, 8);
    assert.equal(await itemCount(), before + 8);
    assert.equal(result.session.status, "committed");
    assert.deepEqual(result.session.counts, { pending: 0, discarded: 1, created: 8 });

    const chairItem = result.created.find((c) => c.name === "Black office chair")!;
    const { rows: [item] } = await pool.query(
      "SELECT quantity, location_id, category, metadata, primary_image_url, enrichment_source FROM items WHERE id = $1",
      [chairItem.itemIds[0]],
    );
    assert.equal(item.quantity, 7);
    assert.equal(item.location_id, roomId);
    assert.equal(item.category, "Seating");
    assert.equal(item.enrichment_source, "bulk-capture");
    assert.equal(item.metadata.capture.sessionId, s.id);
    assert.equal(item.metadata.capture.sourceAttachmentIds.length, 3);
    assert.match(item.primary_image_url, /^\/api\/photos\//, "a boxed sighting becomes the main photo");

    // Every created item links back to its source photo with its own copy.
    const evidence = await pool.query(
      `SELECT a.owner_id, a.meta FROM attachments a
        WHERE a.owner_type = 'item' AND a.stage = 'capture' AND a.owner_id = ANY($1::uuid[])`,
      [result.created.flatMap((c) => c.itemIds)],
    );
    const sourceAttachments = new Set(result.session.sources.map((x) => x.attachmentId));
    // The hand-added entry has no photo to link to.
    assert.equal(evidence.rowCount, 7);
    assert.equal(result.photos.saved, 7);
    for (const row of evidence.rows) assert.ok(sourceAttachments.has(row.meta.sourceAttachmentId));
    assert.equal(
      await count("SELECT count(*)::int AS n FROM item_events WHERE item_id = ANY($1::uuid[]) AND action = 'created'", [
        result.created.flatMap((c) => c.itemIds),
      ]),
      8,
    );
    assert.equal(
      await count("SELECT count(*)::int AS n FROM audit_log WHERE type = 'capture_session.committed' AND subject_id = $1", [s.id]),
      1,
    );

    await assert.rejects(capture.analyse(s.id, { limit: 1 }), /already been turned into items/);
    await assert.rejects(capture.commitSession(s.id, {}, USER), /already been turned into items/);

    // Deleting the session afterwards leaves the items and their evidence.
    await capture.deleteSession(s.id);
    assert.equal(await count("SELECT count(*)::int AS n FROM attachments WHERE owner_type = 'capture_session' AND owner_id = $1", [s.id]), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM capture_drafts WHERE session_id = $1", [s.id]), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM attachments WHERE owner_type = 'item' AND owner_id = $1", [chairItem.itemIds[0]]), 1);
  });

  it("enforces the image cap before any call is made", async () => {
    let s = await capture.createSession({ mode: "walkthrough", imageCap: 2 }, USER);
    await addPhotos(s.id, 2);
    const extra = await upload(s.id, photo("#000000"), "image/jpeg");
    await assert.rejects(capture.addSource(s.id, { attachmentId: extra.id }, USER), /capped at 2 images/);

    s = await capture.updateSession(s.id, { imageCap: 1 });
    queue(ROOM_PHOTO_1, ROOM_PHOTO_2);
    const r = await capture.analyse(s.id, { limit: 4 });
    assert.equal(r.analysed, 1);
    assert.equal(stub.chats.length > 0, true);
    await assert.rejects(capture.analyse(s.id, { limit: 4 }), /used all 1 of its image analyses/);
    await assert.rejects(capture.updateSession(s.id, { imageCap: 41 }), /at most 40 images per session/);
    await capture.deleteSession(s.id);
  });

  it("records a failed reading, and a retry replaces rather than doubles", async () => {
    let s = await capture.createSession({ mode: "walkthrough" }, USER);
    await addPhotos(s.id, 1);
    queue("I'm sorry, I can't help with that.");
    let r = await capture.analyse(s.id, { limit: 1 });
    assert.deepEqual([r.analysed, r.failed], [0, 1]);
    assert.equal(r.session.sources[0]!.status, "failed");
    assert.match(r.session.sources[0]!.error!, /could not be read/);

    s = await capture.retrySource(s.id, r.session.sources[0]!.id);
    queue(ROOM_PHOTO_1);
    r = await capture.analyse(s.id, { limit: 1 });
    assert.equal(r.session.drafts.length, 4);

    // Moving the photo to another room re-merges its stored reading there, with no new call.
    const calls = stub.chats.length;
    s = await capture.updateSource(s.id, r.session.sources[0]!.id, { area: "Room 7" });
    assert.equal(stub.chats.length, calls);
    assert.deepEqual([...new Set(s.drafts.map((d) => d.area))], ["Room 7"]);
    assert.equal(s.drafts.length, 4);

    // Taking the photo out takes its entries with it.
    s = await capture.removeSource(s.id, s.sources[0]!.id);
    assert.equal(s.drafts.length, 0);
    assert.equal(s.sources.length, 0);
    await capture.deleteSession(s.id);
  });

  it("converts a PDF manifest, filing rows into rooms and keeping sticker details", { skip: onPath("pdftoppm") ? false : "pdftoppm is not installed" }, async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 2; i++) doc.addPage([595, 842]).drawText(`Inventory page ${i}`, { x: 50, y: 780, size: 18, font });
    const pdf = Buffer.from(await doc.save());

    const before = await itemCount();
    let s = await capture.createSession({ mode: "manifest", locationId: roomId }, USER);
    const a = await upload(s.id, pdf, "application/pdf");
    const added = await capture.addSource(s.id, { attachmentId: a.id }, USER);
    assert.deepEqual(added.added.map((x) => [x.kind, x.label]), [
      ["pdf_page", "page 1"],
      ["pdf_page", "page 2"],
    ]);
    assert.equal(added.message, "Rendered 2 pages.");

    queue(MANIFEST_PAGE_1, MANIFEST_PAGE_1_AGAIN);
    s = (await capture.analyse(s.id, { limit: 1 })).session;
    s = (await capture.analyse(s.id, { limit: 1 })).session;
    assert.deepEqual(s.drafts.map((d) => [d.lineNo, d.qty, d.area]), [
      [1, 1, "Lobby"],
      [2, 4, "Office 2"],
      [3, 1, "Office 2"],
      [4, 2, "Office 3"],
      [5, 1, "Office 3"],
    ]);
    assert.equal(await itemCount(), before);

    const result = await capture.commitSession(s.id, { areaLocations: true }, USER);
    assert.equal(result.itemCount, 5);
    const { rows } = await pool.query(
      `SELECT i.name, i.quantity, i.metadata, l.name AS loc, l.parent_id
         FROM items i JOIN locations l ON l.id = i.location_id
        WHERE i.id = ANY($1::uuid[]) ORDER BY (i.metadata->'manifest'->>'lineNo')::int`,
      [result.created.flatMap((c) => c.itemIds)],
    );
    assert.deepEqual(rows.map((r) => [r.name, r.quantity, r.loc]), [
      ["Sofa, 3 seat", 1, "Lobby"],
      ["Carton, books", 4, "Office 2"],
      ["Desk, oak", 1, "Office 2"],
      ["Carton, books", 2, "Office 3"],
      ["Filing cabinet, 4 drawer", 1, "Office 3"],
    ]);
    assert.ok(rows.every((r) => r.parent_id === roomId), "room locations are created under the session's location");
    assert.deepEqual(rows[0].metadata.sticker, { color: "red", lot: "2231", number: "001" });
    assert.deepEqual(rows[0].metadata.manifest, {
      lineNo: 1,
      conditionCodes: ["SC-3,7", "SO"],
      condition: "scratched (corner, rear); soiled",
      room: "Lobby",
    });
    // A page is evidence, not a picture of the thing: no main photo.
    const { rows: photos } = await pool.query("SELECT primary_image_url FROM items WHERE id = ANY($1::uuid[])", [
      result.created.flatMap((c) => c.itemIds),
    ]);
    assert.ok(photos.every((p) => p.primary_image_url === null));
    assert.equal(result.photos.saved, 5);
    await capture.deleteSession(s.id);
  });

  it("surveys a desk against its template and creates one record per piece", async () => {
    let s = await capture.createSession({ mode: "desk", locationId: roomId }, USER);
    assert.equal(s.deskTemplate?.id, "standard");
    await addPhotos(s.id, 1);
    queue(DESK_PHOTO);
    s = (await capture.analyse(s.id, { limit: 1 })).session;
    // The desk number read off the photo names the unlabelled desk.
    assert.equal(s.sources[0]!.area, "4B-12");
    const [check] = s.deskCheck!;
    assert.equal(check!.desk, "4B-12");
    assert.deepEqual(check!.lines.filter((l) => l.missing).map((l) => l.key), ["monitor", "dock"]);

    s = await capture.updateDraft(s.id, s.drafts.find((d) => d.name === "monitor")!.id, { qty: 2 });
    const result = await capture.commitSession(s.id, { individual: true, areaLocations: true }, USER);
    assert.equal(result.itemCount, 6);
    const monitors = result.created.find((c) => c.name === "monitor")!;
    assert.equal(monitors.itemIds.length, 2);
    const { rows } = await pool.query(
      `SELECT i.quantity, i.metadata, l.name AS loc FROM items i JOIN locations l ON l.id = i.location_id WHERE i.id = ANY($1::uuid[])`,
      [monitors.itemIds],
    );
    assert.deepEqual(rows.map((r) => [r.quantity, r.loc, r.metadata.desk]).sort(), [
      [1, "4B-12", "4B-12"],
      [1, "4B-12", "4B-12"],
    ]);
    assert.deepEqual(rows.map((r) => r.metadata.capture.piece).sort(), ["1 of 2", "2 of 2"]);
    await capture.deleteSession(s.id);
  });

  it("samples a video into frames", { skip: onPath("ffmpeg") && onPath("ffprobe") ? false : "ffmpeg is not installed" }, async () => {
    const file = path.join(dataDir, `walk-${RUN}.mp4`);
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=7:size=320x240:rate=10",
      "-pix_fmt", "yuv420p", file,
    ]);
    const s = await capture.createSession({ mode: "walkthrough", imageCap: 2 }, USER);
    const a = await upload(s.id, fs.readFileSync(file), "video/mp4");
    const added = await capture.addSource(s.id, { attachmentId: a.id, area: "Hall" }, USER);
    assert.deepEqual(added.added.map((x) => [x.kind, x.area, x.frameMs]), [
      ["video_frame", "Hall", 1750],
      ["video_frame", "Hall", 5250],
    ]);
    assert.equal(added.message, "Took 2 frames from 0:07 of video; the session's image cap allowed no more.");
    assert.equal(added.added[0]!.label, "frame 1 (0:02)");
    await capture.deleteSession(s.id);
  });

  it("refuses files it cannot read, and files from another session", async () => {
    const s = await capture.createSession({ mode: "walkthrough" }, USER);
    const other = await capture.createSession({ mode: "walkthrough" }, USER);
    const a = await upload(other.id, photo("#123456"), "image/jpeg");
    await assert.rejects(capture.addSource(s.id, { attachmentId: a.id }, USER), /Upload the file to this session first/);
    const audio = await media.saveAttachment({
      ownerType: "capture_session",
      ownerId: s.id,
      bytes: Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000" + "x".repeat(64), "latin1"),
      mime: "audio/mpeg",
      createdBy: USER,
    });
    await assert.rejects(capture.addSource(s.id, { attachmentId: audio.id }, USER), /cannot be read here/);
    assert.equal(await media.getAttachment(audio.id), null, "a refused upload is not left behind");
    await capture.deleteSession(s.id);
    await capture.deleteSession(other.id);
  });
});
