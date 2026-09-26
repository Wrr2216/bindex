import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { startAiStub, type AiStub } from "./media-ai-core-stub";

// With no vision model configured, the AI drafts answer { available: false }
// without reaching out to anything, and manual condition reports and captures
// still work. Needs Postgres, like ai-condition-db.test.ts:
//
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_ai_condition_test \
//     pnpm --filter bindex-server exec tsx --test tests/ai-condition-unconfigured.test.ts

const url = process.env.TEST_DATABASE_URL;

describe("ai-condition without a vision model", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let stub: AiStub;
  let svc: typeof import("../src/services/ai-condition");
  let pool: typeof import("../src/db/client")["pool"];
  let itemId: string;
  let photoId: string;

  before(async () => {
    stub = await startAiStub();
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
    process.env.LOG_LEVEL = "error";
    process.env.LLM_BASE_URL = stub.url;
    process.env.LLM_API_KEY = "";
    process.env.LLM_VISION_MODEL = "";
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    svc = await import("../src/services/ai-condition");
    pool = (await import("../src/db/client")).pool;
    const items = await import("../src/services/items");
    const media = await import("../src/services/media-ai-core");
    itemId = (await items.createItem({ name: "Cabinet" }, null)).id;
    const c = createCanvas(64, 64);
    c.getContext("2d").fillRect(0, 0, 10, 10);
    photoId = (await media.saveAttachment({ ownerType: "item", ownerId: itemId, mime: "image/jpeg", bytes: c.toBuffer("image/jpeg"), createdBy: null })).id;
  });

  after(async () => {
    await stub?.close();
    await pool?.end();
  });

  it("reports the AI drafts unavailable and makes no request", async () => {
    assert.deepEqual(await svc.assessCondition({ itemId, attachmentIds: [photoId] }), { available: false, draft: null });
    assert.deepEqual(await svc.assessCondition({ itemId, attachmentIds: [] }), { available: false, draft: null });
    assert.deepEqual(await svc.readContainer(itemId, [photoId]), { available: false, draft: null });
    const a = await svc.createReport({ itemId, stage: "before", attachmentIds: [photoId] }, null);
    const b = await svc.createReport({ itemId, stage: "after", attachmentIds: [photoId] }, null);
    const cmp = await svc.compareReportsWithAi(a.id, b.id);
    assert.equal(cmp.available, false);
    assert.equal(stub.chats.length, 0);
  });

  it("still records condition and captures by hand", async () => {
    const report = await svc.createReport(
      {
        itemId,
        stage: "inspection",
        rating: "poor",
        notes: "Door hinge loose",
        defects: [{ area: "door hinge", type: "loose", severity: "moderate", description: null }],
        handlingNote: "Tape the door shut",
      },
      "local:someone",
    );
    assert.equal(report.aiAssisted, false);
    assert.equal((await svc.handlingNoteFor([itemId])).get(itemId)!.note, "Tape the door shut");
    const saved = await svc.saveCapture(itemId, { sizeClass: "crate", contents: [{ name: "Hinges", qty: 4 }] }, null);
    assert.equal(saved.createdItemIds.length, 1);
    assert.equal(saved.capture.aiAssisted, false);
  });
});
