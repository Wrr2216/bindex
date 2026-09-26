import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { chatReply, startAiStub, type AiStub, type CapturedChat, type StubResponse } from "./media-ai-core-stub";

// Condition reports, container capture, sweeps, handling notes, the backup
// round trip, and the AI drafts against a local provider stand-in, on a real
// Postgres. CI has no database, so this runs only when TEST_DATABASE_URL names
// a scratch database (it is migrated and written to, and a backup is restored
// over it):
//
//   createdb bindex_ai_condition_test
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_ai_condition_test \
//     pnpm --filter bindex-server exec tsx --test tests/ai-condition-db.test.ts

const url = process.env.TEST_DATABASE_URL;

type Svc = typeof import("../src/services/ai-condition");
type Media = typeof import("../src/services/media-ai-core");
type Items = typeof import("../src/services/items");
type Units = typeof import("../src/services/units");
type Backup = typeof import("../src/services/backup");
type Client = typeof import("../src/db/client");
let svc: Svc;
let media: Media;
let items: Items;
let units: Units;
let backup: Backup;
let pool: Client["pool"];
let stub: AiStub;
let onChat: (c: CapturedChat) => StubResponse;

function jpeg(shade = "#446"): Buffer {
  const c = createCanvas(320, 240);
  const ctx = c.getContext("2d");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 320, 240);
  return c.toBuffer("image/jpeg");
}

const photo = (ownerType: string, ownerId: string, stage = "before") =>
  media.saveAttachment({ ownerType, ownerId, stage, mime: "image/jpeg", bytes: jpeg(), createdBy: "tester" });

const systemOf = (c: CapturedChat) => String((c.body.messages as { content: unknown }[])[0]!.content);
const imagesOf = (c: CapturedChat) =>
  ((c.body.messages as { content: unknown }[])[1]!.content as { type: string }[]).filter((p) => p.type === "image_url").length;
const textOf = (c: CapturedChat) =>
  ((c.body.messages as { content: unknown }[])[1]!.content as { type: string; text?: string }[]).find((p) => p.type === "text")!.text!;

const ASSESS_REPLY = {
  rating: "Fair",
  summary: "Scratches on the top and a dent on the front edge.",
  defects: [
    { area: "top, left side", type: "scratch", severity: "minor", description: "Fine scratches" },
    { area: "front edge", type: "dent", severity: "moderate", description: "Small dent" },
  ],
  handlingNote: "Handle with care to prevent further scratching.",
  confidence: 0.8,
};

const CONTAINER_REPLY = {
  sizeClass: "Medium box",
  handwrittenText: "OFFICE 3.14\nbooks + mugs",
  room: "Office 3.14",
  contentsSummary: "Books and mugs",
  contents: [
    { name: "Paperback books", category: "books", qty: 14, condition: "good", fragile: false },
    { name: "Mugs", category: "Kitchenware", qty: 4, condition: "like new", fragile: true },
  ],
  flags: ["this way up"],
  confidence: { sizeClass: 0.9, handwrittenText: 0.8, room: 0.85, contents: 0.6 },
};

const COMPARE_REPLY = {
  summary: "A new crack on the right door.",
  newDefects: [{ area: "right door", type: "crack", severity: "major", description: "Cracked panel" }],
  resolvedDefects: [],
  ratingAfter: "damaged",
  changed: true,
};

async function auditTypes(subjectId: string): Promise<string[]> {
  const { rows } = await pool.query<{ type: string }>("SELECT type FROM audit_log WHERE subject_id = $1 ORDER BY id", [subjectId]);
  return rows.map((r) => r.type);
}

describe("ai-condition with Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  const RUN = Date.now().toString(36);
  let locationId: string;
  let roomId: string;
  let deskId: string;
  let unitId: string;
  let otherId: string;
  let boxId: string;

  before(async () => {
    stub = await startAiStub({ chat: (c) => onChat(c) });
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.LOG_LEVEL = "error";
    process.env.LLM_BASE_URL = stub.url;
    process.env.LLM_API_KEY = "stub-key";
    process.env.LLM_VISION_MODEL = "vision-model";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    svc = await import("../src/services/ai-condition");
    media = await import("../src/services/media-ai-core");
    items = await import("../src/services/items");
    units = await import("../src/services/units");
    backup = await import("../src/services/backup");
    pool = (await import("../src/db/client")).pool;
    const locations = await import("../src/services/locations");
    locationId = (await locations.createLocation({ name: `Floor ${RUN}` })).id;
    roomId = (await locations.createLocation({ name: `Room ${RUN}`, parentId: locationId })).id;
    deskId = (await items.createItem({ name: "Oak desk", locationId: roomId }, null)).id;
    unitId = (await units.addUnit(deskId, { label: "Desk 2" })).id;
    otherId = (await items.createItem({ name: "Chair", locationId }, null)).id;
    boxId = (await items.createItem({ name: "Box", locationId: roomId }, null)).id;
  });

  beforeEach(() => {
    stub.chats.length = 0;
    onChat = (c) => {
      const system = systemOf(c);
      if (system.includes("catalogue packed containers")) return chatReply(JSON.stringify(CONTAINER_REPLY));
      if (system.includes("compare photos")) return chatReply(JSON.stringify(COMPARE_REPLY));
      return chatReply("```json\n" + JSON.stringify(ASSESS_REPLY) + "\n```");
    };
  });

  after(async () => {
    await stub?.close();
    await pool?.end();
  });

  let beforeReportId: string;

  it("drafts an assessment from the item's photos, and saves only what a person confirms", async () => {
    const p1 = await photo("item", deskId);
    const p2 = await photo("unit", unitId);
    const res = await svc.assessCondition({ itemId: deskId, attachmentIds: [p1.id, p2.id] });
    assert.equal(res.available, true);
    assert.equal(res.draft!.rating, "fair");
    assert.equal(res.draft!.defects.length, 2);
    assert.equal(stub.chats.length, 1);
    assert.equal(imagesOf(stub.chats[0]!), 2);
    assert.match(textOf(stub.chats[0]!), /Oak desk/);
    const { rows } = await pool.query("SELECT 1 FROM condition_reports WHERE item_id = $1", [deskId]);
    assert.equal(rows.length, 0, "assessing saves nothing");

    const report = await svc.createReport(
      {
        itemId: deskId,
        stage: "before",
        rating: res.draft!.rating,
        aiNotes: res.draft!.summary,
        notes: "Checked at pack-out",
        defects: res.draft!.defects,
        handlingNote: res.draft!.handlingNote,
        attachmentIds: [p1.id, p2.id, p1.id],
        aiAssisted: true,
      },
      "local:tester",
    );
    beforeReportId = report.id;
    assert.equal(report.itemName, "Oak desk");
    assert.deepEqual(report.attachmentIds, [p1.id, p2.id]);
    assert.deepEqual(report.photos.map((p) => p.id), [p1.id, p2.id]);
    assert.equal(report.photos[0]!.thumbUrl, `/api/attachments/${p1.id}/thumb`);
    assert.deepEqual(await auditTypes(report.id), ["condition_report.created"]);
  });

  it("refuses photos of another record, and non-photos", async () => {
    const theirs = await photo("item", otherId);
    await assert.rejects(svc.assessCondition({ itemId: deskId, attachmentIds: [theirs.id] }), /belongs to a different record/);
    await assert.rejects(
      svc.createReport({ itemId: deskId, stage: "after", attachmentIds: [theirs.id] }, null),
      /belongs to a different record/,
    );
    const pdf = await media.saveAttachment({
      ownerType: "item",
      ownerId: deskId,
      mime: "application/pdf",
      bytes: Buffer.from("%PDF-1.4\n%%EOF\n"),
      createdBy: null,
    });
    await assert.rejects(svc.createReport({ itemId: deskId, stage: "after", attachmentIds: [pdf.id] }, null), /Only photos/);
  });

  it("validates stages, units and ratings", async () => {
    await assert.rejects(svc.createReport({ itemId: deskId, stage: "custom" }, null), /Name the custom stage/);
    await assert.rejects(svc.createReport({ itemId: otherId, unitId, stage: "before" }, null), /belongs to a different item/);
    await assert.rejects(
      svc.createReport({ itemId: deskId, stage: "before", rating: "superb" as "good" }, null),
      /rating must be one of/,
    );
    const custom = await svc.createReport({ itemId: deskId, stage: "custom", stageLabel: " Return ", rating: null, notes: "Note only" }, null);
    assert.equal(custom.stageLabel, "Return");
    assert.equal(custom.rating, null);
    await svc.deleteReport(custom.id, { oid: "someone", role: "admin" });
  });

  let afterReportId: string;

  it("compares two reports: defect diff, and an AI read of both sets of photos", async () => {
    const a1 = await photo("item", deskId, "after");
    const after = await svc.createReport(
      {
        itemId: deskId,
        stage: "after",
        rating: "damaged",
        defects: [
          { area: "Top-left", type: "scratch", severity: "minor", description: null },
          { area: "front edge", type: "dent", severity: "major", description: null },
          { area: "right door", type: "crack", severity: "major", description: null },
        ],
        attachmentIds: [a1.id],
      },
      "local:tester",
    );
    afterReportId = after.id;
    const cmp = await svc.compareReports(beforeReportId, after.id);
    assert.equal(cmp.rating, "worse");
    assert.deepEqual(cmp.diff.added.map((d) => d.area), ["right door"]);
    assert.deepEqual(cmp.diff.worsened.map((p) => p.after.area), ["front edge"]);
    assert.equal(cmp.diff.unchanged.length, 1);

    const ai = await svc.compareReportsWithAi(beforeReportId, after.id);
    assert.equal(ai.available, true);
    assert.equal(ai.draft!.changed, true);
    assert.equal(ai.draft!.newDefects[0]!.type, "crack");
    assert.equal(imagesOf(stub.chats[0]!), 3, "two before photos then one after");
    assert.match(textOf(stub.chats[0]!), /first 2 photo\(s\)/);

    const chairReport = await svc.createReport({ itemId: otherId, stage: "before" }, null);
    await assert.rejects(svc.compareReports(beforeReportId, chairReport.id), /same item/);
  });

  it("corrects a report and logs each change, and limits who may delete one", async () => {
    const same = await svc.updateReport(afterReportId, { rating: "damaged" }, "local:other");
    assert.equal(same.updatedAt.getTime(), same.updatedAt.getTime());
    assert.deepEqual(await auditTypes(afterReportId), ["condition_report.created"], "a no-op patch logs nothing");

    const updated = await svc.updateReport(afterReportId, { rating: "poor", handlingNote: "Two person lift" }, "local:other");
    assert.equal(updated.rating, "poor");
    const { rows } = await pool.query<{ data: { changes: Record<string, { from: unknown; to: unknown }> } }>(
      "SELECT data FROM audit_log WHERE subject_id = $1 AND type = 'condition_report.updated'",
      [afterReportId],
    );
    assert.deepEqual(rows[0]!.data.changes.rating, { from: "damaged", to: "poor" });

    await assert.rejects(svc.deleteReport(afterReportId, { oid: "local:other", role: "member" }), /Only the person who recorded/);
  });

  it("gives the latest handling note, per unit with a fallback to the item", async () => {
    const notes = await svc.handlingNoteFor([deskId, otherId, boxId]);
    assert.equal(notes.get(deskId)!.note, "Two person lift");
    assert.equal(notes.get(deskId)!.text, "Poor condition. Two person lift.");
    assert.equal(notes.has(boxId), false, "nothing recorded, nothing returned");

    await svc.createReport({ itemId: deskId, unitId, stage: "inspection", rating: "good", handlingNote: "Wrap the legs" }, null);
    const [unit, item, unknownUnit] = await svc.handlingNotesForRefs([
      { itemId: deskId, unitId },
      { itemId: deskId },
      { itemId: deskId, unitId: "00000000-0000-4000-8000-000000000000" },
    ]);
    assert.equal(unit!.note, "Wrap the legs");
    assert.equal(item!.note, "Two person lift");
    assert.equal(unknownUnit!.note, "Two person lift");
  });

  it("reads a container and creates its contents inside it in one step", async () => {
    const outside = await photo("item", boxId, "pack");
    const top = await photo("item", boxId, "pack");
    const read = await svc.readContainer(boxId, [outside.id, top.id]);
    assert.equal(read.draft!.sizeClass, "medium");
    assert.equal(read.draft!.room, "Office 3.14");
    assert.deepEqual(read.draft!.flags, ["fragile", "this_side_up"]);
    assert.match(textOf(stub.chats[0]!), /"dish pack"/);

    const draft = read.draft!;
    const result = await svc.saveCapture(
      boxId,
      {
        ...draft,
        containerName: "Office 3.14 books",
        contents: [...draft.contents, { name: "Desk lamp", qty: 1, create: false }],
        attachmentIds: [outside.id, top.id],
        aiAssisted: true,
        confidence: draft.confidence,
      },
      "local:packer",
    );
    assert.equal(result.createdItemIds.length, 2);
    const box = await items.getItemDetail(boxId);
    assert.equal(box.name, "Office 3.14 books");
    const kids = box.children.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(kids.map((k) => [k.name, k.quantity, k.category, k.locationId]), [
      ["Mugs", 4, "Kitchenware", roomId],
      ["Paperback books", 14, "Books and paper", roomId],
    ]);
    assert.match(kids[0]!.assetCode, /^[A-Z0-9]+-[0-9A-F]{6}$/);
    const mugs = await svc.listReports({ itemId: kids[0]!.id });
    assert.equal(mugs.reports[0]!.stage, "before");
    assert.equal(mugs.reports[0]!.rating, "excellent");
    assert.equal(mugs.reports[0]!.handlingNote, "Fragile. Handle with care.");
    const events = await pool.query<{ action: string; detail: { source?: string } }>(
      "SELECT action, detail FROM item_events WHERE item_id = $1",
      [kids[0]!.id],
    );
    assert.deepEqual(events.rows.map((e) => [e.action, e.detail.source]), [["created", "container-capture"]]);

    const [capture] = await svc.listCaptures(boxId);
    assert.equal(capture!.sizeClass, "medium");
    assert.deepEqual(capture!.flags, ["fragile", "this_side_up"]);
    assert.equal(capture!.contents.length, 3);
    assert.equal(capture!.contents[2]!.itemId, null);
    assert.deepEqual(capture!.photos.map((p) => p.id), [outside.id, top.id]);
    // Created, renamed by the capture, captured.
    assert.deepEqual(await auditTypes(boxId), ["item.created", "item.updated", "container.captured"]);

    // The box's own handling marks come from the capture.
    assert.equal((await svc.handlingNoteFor([boxId])).get(boxId)!.text, "Fragile · This side up.");
  });

  it("creates nothing when any part of a capture fails", async () => {
    const before = (await items.getItemDetail(boxId)).children.length;
    await assert.rejects(
      svc.saveCapture(boxId, { contents: [{ name: "Plates" }, { name: "Glasses", condition: "superb" as "good" }] }, null),
      /rating must be one of/,
    );
    assert.equal((await items.getItemDetail(boxId)).children.length, before);
    const domain = (await items.createItem({ name: `example-${RUN}.com`, category: "Domain" }, null)).id;
    await assert.rejects(svc.saveCapture(domain, { contents: [{ name: "x" }] }, null), /domain cannot hold/);
  });

  it("sweeps a location: expected items, scans without history noise, progress, closing", async () => {
    const sweep = await svc.startSweep({ locationId, stage: "inspection" }, "local:sweeper");
    // Desk, box and chair plus the two packed items inherit the room.
    assert.equal(sweep.expected, 5);
    assert.equal(sweep.checked, 0);

    const desk = await items.getItemDetail(deskId);
    const scanned = await svc.resolveSweepScan(sweep.id, desk.assetCode);
    assert.equal(scanned.itemId, deskId);
    assert.equal(scanned.expected, true);
    assert.equal(scanned.report, null);
    const byLink = await svc.resolveSweepScan(sweep.id, `https://inv.example.com/items/${otherId}`);
    assert.equal(byLink.itemId, otherId);
    const unitScan = await svc.resolveSweepScan(sweep.id, (await units.listUnits(deskId))[0]!.assetCode);
    assert.equal(unitScan.unitId, unitId);
    await assert.rejects(svc.resolveSweepScan(sweep.id, "NOPE-000000"), /Nothing is recorded with the code/);
    const scannedEvents = await pool.query("SELECT 1 FROM item_events WHERE item_id = $1 AND action = 'scanned'", [deskId]);
    assert.equal(scannedEvents.rows.length, 0);

    const r = await svc.createReport({ itemId: deskId, stage: "after", rating: "good", sweepId: sweep.id }, "local:sweeper");
    assert.equal(r.stage, "inspection", "a sweep's reports take its stage");
    const outsider = (await items.createItem({ name: "Stray" }, null)).id;
    await svc.createReport({ itemId: outsider, stage: "inspection", sweepId: sweep.id }, null);

    const detail = await svc.getSweepDetail(sweep.id);
    assert.equal(detail.checked, 2);
    assert.equal(detail.items.find((i) => i.itemId === deskId)!.report!.rating, "good");
    assert.deepEqual(detail.extra.map((i) => i.itemId), [outsider]);
    assert.ok(detail.items.every((i) => i.itemId !== outsider));

    const closed = await svc.closeSweep(sweep.id, "local:sweeper");
    assert.equal(closed.status, "closed");
    await assert.rejects(svc.createReport({ itemId: otherId, stage: "inspection", sweepId: sweep.id }, null), /sweep is closed/);
    assert.deepEqual(await auditTypes(sweep.id), ["condition_sweep.started", "condition_sweep.closed"]);
    assert.ok((await svc.listSweeps({ status: "closed" })).some((s) => s.id === sweep.id));
  });

  it("round-trips through the JSON backup, and keeps records an older file never had", async () => {
    const count = async () => {
      const { rows } = await pool.query<{ r: number; c: number; s: number }>(
        `SELECT (SELECT count(*)::int FROM condition_reports) AS r, (SELECT count(*)::int FROM container_captures) AS c,
                (SELECT count(*)::int FROM condition_sweeps) AS s`,
      );
      return rows[0]!;
    };
    const was = await count();
    assert.ok(was.r > 0 && was.c > 0 && was.s > 0);
    const file = JSON.parse(JSON.stringify(await backup.buildBackup()));
    assert.equal(file.counts.condition_reports, was.r);
    await backup.restoreBackup(file);
    assert.deepEqual(await count(), was);
    const report = await svc.getReport(beforeReportId);
    assert.equal(report!.defects.length, 2);
    assert.equal(report!.photos.length, 2, "attachment ids survive as a uuid array");
    const sweeps = await pool.query("SELECT location_id FROM condition_sweeps WHERE location_id IS NULL");
    assert.equal(sweeps.rows.length, 0, "sweeps keep their location");

    const older = JSON.parse(JSON.stringify(file));
    delete older.data.condition_reports;
    delete older.data.container_captures;
    delete older.data.condition_sweeps;
    await backup.restoreBackup(older);
    assert.deepEqual(await count(), was);
  });

  it("cascades with the item", async () => {
    await items.deleteItem(otherId, null);
    const { rows } = await pool.query("SELECT 1 FROM condition_reports WHERE item_id = $1", [otherId]);
    assert.equal(rows.length, 0);
  });
});
