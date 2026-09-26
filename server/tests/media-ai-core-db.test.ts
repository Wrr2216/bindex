import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

// Attachments, signatures, the orphan sweep and data-plate saving against a
// real Postgres. CI has no database, so this runs only when TEST_DATABASE_URL
// names a scratch database (it is migrated and written to):
//
//   createdb bindex_media_ai_core_test
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_media_ai_core_test \
//     pnpm --filter bindex-server exec tsx --test tests/media-ai-core-db.test.ts

const url = process.env.TEST_DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-db-data-"));

type Media = typeof import("../src/services/media-ai-core");
type Plate = typeof import("../src/services/media-ai-core/dataPlate");
type Items = typeof import("../src/services/items");
type Client = typeof import("../src/db/client");
let media: Media;
let plate: Plate;
let items: Items;
let pool: Client["pool"];

// Unique per run, so the suite can run again against the same scratch database.
const RUN = Date.now().toString(16).slice(-6).toUpperCase();
const SERIAL = `SN${RUN}`;
const MAC_RAW = `a4bb6d${RUN.toLowerCase()}`;
const MAC = MAC_RAW.toUpperCase().match(/.{2}/g)!.join(":");
const TAG = `IT-${RUN}`;
const UNIT_SERIAL = `UNIT-${RUN}`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

function jpegOf(bytes: number): Buffer {
  const c = createCanvas(320, 240);
  c.getContext("2d").fillRect(0, 0, 50, 50);
  const jpeg = c.toBuffer("image/jpeg");
  // Decoders ignore data after the end-of-image marker; it pads to size.
  return Buffer.concat([jpeg, Buffer.alloc(Math.max(0, bytes - jpeg.length), 7)]);
}

function mp4Of(bytes: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom\0\0\0\0isom", "latin1")]);
  const body = Buffer.alloc(bytes - head.length);
  for (let i = 0; i < body.length; i += 4096) body.writeUInt32BE(i, i);
  return Buffer.concat([head, body]);
}

const chunked = (buf: Buffer, size = 256 * 1024) =>
  Readable.from((function* () {
    for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
  })());

describe("media-ai-core with Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let itemId: string;
  let otherItemId: string;
  let unitId: string;

  before(async () => {
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "error";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    media = await import("../src/services/media-ai-core");
    plate = await import("../src/services/media-ai-core/dataPlate");
    items = await import("../src/services/items");
    pool = (await import("../src/db/client")).pool;
    const units = await import("../src/services/units");
    itemId = (await items.createItem({ name: "Test laptop" }, null)).id;
    otherItemId = (await items.createItem({ name: "Other laptop" }, null)).id;
    unitId = (await units.addUnit(itemId, { label: "Unit 1" })).id;
  });

  after(async () => {
    await pool?.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a 2 MB photo in Postgres and reads its size from the header", async () => {
    const bytes = jpegOf(2 * 1024 * 1024);
    const a = await media.saveAttachment({ ownerType: "item", ownerId: itemId, stage: " Before ", mime: "image/jpeg", bytes, createdBy: "tester" });
    assert.equal(a.storage, "db");
    assert.equal(a.kind, "photo");
    assert.equal(a.stage, "before");
    assert.equal(a.sizeBytes, bytes.length);
    assert.equal(a.sha256, sha(bytes));
    assert.deepEqual([a.width, a.height], [320, 240]);
    assert.equal(a.thumbUrl, `/api/attachments/${a.id}/thumb`);

    const opened = await media.getAttachmentStream(a.id, "bytes=100-199");
    assert.equal(opened.status, 206);
    assert.deepEqual(await readAll((opened as { stream: Readable }).stream), bytes.subarray(100, 200));
    const whole = await media.getAttachmentStream(a.id);
    assert.equal(sha(await readAll((whole as { stream: Readable }).stream)), a.sha256);
    assert.equal((await media.getAttachmentStream(a.id, `bytes=${bytes.length}-`)).status, 416);
  });

  it("streams a large video to disk and serves byte ranges from it", async () => {
    const bytes = mp4Of(9 * 1024 * 1024 + 123);
    const a = await media.saveAttachment({ ownerType: "unit", ownerId: unitId, stage: "teardown", mime: "application/octet-stream", stream: chunked(bytes), durationMs: 4200, createdBy: null });
    assert.equal(a.storage, "disk");
    assert.equal(a.kind, "video");
    assert.equal(a.mime, "video/mp4");
    assert.equal(a.durationMs, 4200);
    assert.equal(a.sha256, sha(bytes));
    const onDisk = path.join(dataDir, "attachments", a.id.slice(0, 2), a.id);
    assert.equal(fs.statSync(onDisk).size, bytes.length);

    const tail = await media.getAttachmentStream(a.id, "bytes=-1000");
    assert.equal(tail.status, 206);
    assert.deepEqual(await readAll((tail as { stream: Readable }).stream), bytes.subarray(bytes.length - 1000));

    const listed = await media.listAttachments("unit", unitId, { kind: "video" });
    assert.deepEqual(listed.map((x) => x.id), [a.id]);
    assert.equal(listed[0]!.thumbUrl, null);

    await media.deleteAttachment(a.id);
    assert.equal(fs.existsSync(onDisk), false);
    await assert.rejects(media.getAttachmentStream(a.id), /not found/i);
  });

  it("filters by kind and stage and keeps upload order", async () => {
    const after = await media.saveAttachment({ ownerType: "item", ownerId: itemId, stage: "after", mime: "image/jpeg", bytes: jpegOf(1000), createdBy: null });
    const all = await media.listAttachments("item", itemId);
    assert.equal(all.at(-1)!.id, after.id);
    assert.deepEqual((await media.listAttachments("item", itemId, { stage: "AFTER" })).map((x) => x.id), [after.id]);
    assert.equal((await media.listAttachments("item", itemId, { kind: ["video", "audio"] })).length, 0);
    const updated = await media.updateAttachment(after.id, { caption: "Scuff on lid", meta: { angle: "top" } });
    assert.equal(updated.caption, "Scuff on lid");
    assert.deepEqual(updated.meta, { angle: "top" });
  });

  it("rejects bad owners, types and kinds with messages a person can act on", async () => {
    const png = createCanvas(4, 4).toBuffer("image/png");
    await assert.rejects(media.saveAttachment({ ownerType: "spaceship", ownerId: itemId, bytes: png, createdBy: null }), (e: { status: number }) => e.status === 400);
    await assert.rejects(media.saveAttachment({ ownerType: "item", ownerId: "00000000-0000-4000-8000-000000000000", bytes: png, createdBy: null }), (e: { status: number }) => e.status === 404);
    await assert.rejects(media.saveAttachment({ ownerType: "item", ownerId: itemId, kind: "video", bytes: png, createdBy: null }), /video cannot be a image\/png/);
    await assert.rejects(media.saveAttachment({ ownerType: "item", ownerId: itemId, mime: "text/html", bytes: Buffer.from("<script>alert(1)</script>"), createdBy: null }), (e: { status: number }) => e.status === 415);
    await assert.rejects(media.saveAttachment({ ownerType: "item", ownerId: itemId, bytes: Buffer.alloc(0), createdBy: null }), /empty/);
  });

  it("verifies a signature, and fails once the signed content changes", async () => {
    const pad = createCanvas(300, 100);
    pad.getContext("2d").fillRect(10, 40, 200, 4);
    const content = { item: itemId, lines: [{ name: "Test laptop", qty: 1 }], note: "No damage" };
    const sig = await media.sign({
      ownerType: "item",
      ownerId: itemId,
      signerName: "Pat Doe",
      signerRole: "Receiving",
      signerEmail: "pat@example.com",
      statement: "I received the items listed in good condition.",
      content,
      image: pad.toBuffer("image/png"),
      ip: "127.0.0.1",
      userAgent: "test",
      signedByUser: null,
    });
    assert.ok(sig.attachmentId);
    assert.equal(sig.imageUrl, `/api/attachments/${sig.attachmentId}`);

    const reordered = { note: "No damage", lines: [{ qty: 1, name: "Test laptop" }], item: itemId };
    assert.deepEqual((await media.verifySignature(sig.id, reordered)).reason, "ok");
    const changed = await media.verifySignature(sig.id, { ...content, lines: [{ name: "Test laptop", qty: 2 }] });
    assert.equal(changed.valid, false);
    assert.equal(changed.reason, "content_changed");
    assert.deepEqual(await media.getSignedContent(sig.id), content);
    assert.equal((await media.listSignatures("item", itemId)).length, 1);

    // The image belongs to the signature.
    await assert.rejects(media.deleteAttachment(sig.attachmentId!), (e: { status: number }) => e.status === 409);
    // And editing it breaks verification.
    await pool.query(`UPDATE attachments SET bytes = bytes || '\\x00'::bytea WHERE id = $1`, [sig.attachmentId]);
    assert.equal((await media.verifySignature(sig.id, content)).reason, "image_altered");
    // Signed items do not list their signature image among photos.
    assert.ok(!(await media.listAttachments("item", itemId, { kind: ["photo", "video", "audio", "document"] })).some((a) => a.id === sig.attachmentId));
  });

  it("makes a photo attachment the item's main photo", async () => {
    const a = await media.saveAttachment({ ownerType: "item", ownerId: itemId, mime: "image/jpeg", bytes: jpegOf(5000), createdBy: null });
    const detail = await media.setAsPrimaryPhoto(a.id);
    assert.match(detail.primaryImageUrl ?? "", /^\/api\/photos\//);
    const thumb = await media.thumbnail(a.id, 100);
    assert.ok(thumb && thumb.bytes[0] === 0xff && thumb.bytes[1] === 0xd8);
  });

  it("saves an accepted data-plate reading under the uniqueness rules", async () => {
    const detail = await plate.applyDataPlate(
      { ownerType: "item", ownerId: itemId, brand: "Dell", model: "Latitude 5440", serial: SERIAL, mac: MAC_RAW, assetTag: TAG, partNumber: "0R9KW3" },
      "tester",
    );
    assert.equal(detail.brand, "Dell");
    assert.equal(detail.model, "Latitude 5440");
    const ids = detail.identifiers.map((i) => `${i.type}:${i.value}`).sort();
    assert.deepEqual(ids, [`asset_tag:${TAG}`, `mac:${MAC}`, `serial:${SERIAL}`, "sku:0R9KW3"]);
    assert.ok(detail.events.some((e) => e.detail.source === "data-plate"));

    // Reading the same label again changes nothing and is not an error.
    const again = await plate.applyDataPlate({ ownerType: "item", ownerId: itemId, serial: SERIAL }, null);
    assert.equal(again.identifiers.length, 4);

    // The same serial on another item is refused, naming where it is.
    await assert.rejects(
      plate.applyDataPlate({ ownerType: "item", ownerId: otherItemId, serial: SERIAL }, null),
      (e: { status: number; message: string }) => e.status === 409 && e.message.includes("Test laptop"),
    );
    const taken = await plate.findTaken({ serial: SERIAL, mac: MAC, assetTag: `FREE-${RUN}` }, { itemId: otherItemId });
    assert.equal(taken.serial?.itemId, itemId);
    assert.equal(taken.mac?.itemName, "Test laptop");
    assert.equal(taken.assetTag, null);
    // A part number is a product code and may repeat.
    await plate.applyDataPlate({ ownerType: "item", ownerId: otherItemId, partNumber: "0R9KW3" }, null);
  });

  it("puts a unit's serial on the unit", async () => {
    const detail = await plate.applyDataPlate({ ownerType: "unit", ownerId: unitId, serial: UNIT_SERIAL }, null);
    assert.equal(detail.units.find((u) => u.id === unitId)?.serial, UNIT_SERIAL);
    assert.ok(!detail.identifiers.some((i) => i.value === UNIT_SERIAL));
    await assert.rejects(
      plate.applyDataPlate({ ownerType: "item", ownerId: otherItemId, serial: UNIT_SERIAL }, null),
      (e: { status: number }) => e.status === 409,
    );
    await assert.rejects(plate.applyDataPlate({ ownerType: "unit", ownerId: unitId, mac: "12:34" }, null), /MAC address/);
  });

  it("sweeps attachments whose owner is gone, including registered types", async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS test_widgets (id uuid PRIMARY KEY)`);
    const widgetId = "11111111-1111-4111-8111-111111111111";
    await pool.query(`INSERT INTO test_widgets (id) VALUES ($1) ON CONFLICT DO NOTHING`, [widgetId]);
    media.registerOwnerType(
      "widget",
      async (id) => ((await pool.query(`SELECT 1 FROM test_widgets WHERE id = $1`, [id])).rowCount ?? 0) > 0,
      { table: "test_widgets" },
    );
    const w = await media.saveAttachment({ ownerType: "widget", ownerId: widgetId, stream: chunked(mp4Of(9 * 1024 * 1024)), createdBy: null });
    const onDisk = path.join(dataDir, "attachments", w.id.slice(0, 2), w.id);
    assert.ok(fs.existsSync(onDisk));

    const doomed = (await items.createItem({ name: "Doomed" }, null)).id;
    const photo = await media.saveAttachment({ ownerType: "item", ownerId: doomed, bytes: jpegOf(2000), createdBy: null });
    const kept = await media.saveAttachment({ ownerType: "item", ownerId: itemId, bytes: jpegOf(2000), createdBy: null });

    await pool.query(`DELETE FROM test_widgets WHERE id = $1`, [widgetId]);
    await items.deleteItem(doomed, null);
    // Fresh attachments are left alone for a grace period.
    await media.sweepOrphans();
    assert.ok(await media.getAttachment(photo.id));
    await pool.query(`UPDATE attachments SET created_at = now() - interval '1 hour'`);
    await media.sweepOrphans();

    assert.equal(await media.getAttachment(w.id), null);
    assert.equal(fs.existsSync(onDisk), false);
    assert.equal(await media.getAttachment(photo.id), null);
    assert.ok(await media.getAttachment(kept.id), "attachments of records that still exist stay");
    await pool.query(`DROP TABLE test_widgets`);
  });
});
