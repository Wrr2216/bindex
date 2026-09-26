import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { MANIFEST_PAGE_1, MANIFEST_PAGE_1_AGAIN } from "./bulk-capture-fixtures";

// Paper manifest rows: parsing what a model transcribed, decoding condition
// codes and lot stickers, and keeping a line read twice only once.

type Manifest = typeof import("../src/services/bulk-capture/manifest");
type Merge = typeof import("../src/services/bulk-capture/merge");
let m: Manifest;
let merge: Merge;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  m = await import("../src/services/bulk-capture/manifest");
  merge = await import("../src/services/bulk-capture/merge");
});

type Draft = import("../src/services/bulk-capture/merge").MergeDraft;

function fold(pages: Record<string, unknown>[]): Draft[] {
  let drafts: Draft[] = [];
  let next = 0;
  pages.forEach((raw, i) => {
    const reading = m.normalizeManifest(raw)!;
    const result = merge.mergeManifestRows(drafts, reading.rows, { sourceId: `p${i + 1}`, attachmentId: `a${i + 1}`, area: null });
    const byId = new Map(result.updated.map((d) => [d.id, d]));
    drafts = drafts.map((d) => byId.get(d.id) ?? d);
    for (const c of result.created) drafts.push({ ...c, id: `d${++next}` });
  });
  return drafts;
}

describe("condition codes", () => {
  it("decodes codes and the locations after them", () => {
    assert.deepEqual(m.parseConditionCodes(["SC-3,7", "SO"]), { codes: ["SC-3,7", "SO"], words: "scratched (corner, rear); soiled" });
    assert.deepEqual(m.parseConditionCodes("BR 6 sc3"), { codes: ["BR-6", "SC-3"], words: "broken (leg); scratched (corner)" });
    assert.deepEqual(m.parseConditionCodes("BR/SC; D-4"), { codes: ["BR", "SC", "D-4"], words: "broken; scratched; dented (front)" });
    assert.deepEqual(m.parseConditionCodes("SC 3 7"), { codes: ["SC-3,7"], words: "scratched (corner, rear)" });
  });

  it("keeps unknown codes as printed and written-out words as words", () => {
    assert.deepEqual(m.parseConditionCodes(["XX", "scratched"]), { codes: ["XX"], words: "XX; scratched" });
    assert.deepEqual(m.parseConditionCodes([]), { codes: [], words: null });
    assert.deepEqual(m.parseConditionCodes(null), { codes: [], words: null });
  });
});

describe("stickers and line numbers", () => {
  it("reads lot stickers from objects and text", () => {
    assert.deepEqual(m.parseSticker({ color: "Red", lot: "Lot 2231", number: "#045" }), { color: "red", lot: "2231", number: "045" });
    assert.deepEqual(m.parseSticker("Red 2231-045"), { color: "red", lot: "2231", number: "045" });
    assert.deepEqual(m.parseSticker("RED/2231/45"), { color: "red", lot: "2231", number: "45" });
    assert.deepEqual(m.parseSticker("#045"), { color: null, lot: null, number: "045" });
    assert.deepEqual(m.parseSticker("Blue"), { color: "blue", lot: null, number: null });
    assert.equal(m.parseSticker(""), null);
    assert.equal(m.parseSticker({}), null);
    assert.equal(m.parseSticker(null), null);
  });

  it("reads line numbers as written", () => {
    assert.equal(m.parseLineNo("12"), 12);
    assert.equal(m.parseLineNo("12."), 12);
    assert.equal(m.parseLineNo("#12"), 12);
    assert.equal(m.parseLineNo("No. 12"), 12);
    assert.equal(m.parseLineNo(12), 12);
    assert.equal(m.parseLineNo("12a"), null);
    assert.equal(m.parseLineNo(0), null);
    assert.equal(m.parseLineNo(null), null);
  });
});

describe("normalizeManifest", () => {
  it("turns a page into rows, with the page's lot and colour on every sticker", () => {
    const r = m.normalizeManifest(MANIFEST_PAGE_1)!;
    assert.deepEqual(r.header, { title: "Descriptive inventory", date: "09/22/2026", lot: "2231", stickerColor: "red", reference: "Job 4471" });
    // The blank row is dropped.
    assert.equal(r.rows.length, 4);
    const [sofa, books, desk] = r.rows as [typeof r.rows[0], typeof r.rows[0], typeof r.rows[0]];
    assert.deepEqual(
      { ...sofa },
      {
        lineNo: 1,
        description: "Sofa, 3 seat",
        qty: 1,
        conditionCodes: ["SC-3,7", "SO"],
        condition: "scratched (corner, rear); soiled",
        sticker: { color: "red", lot: "2231", number: "001" },
        room: "Lobby",
        notes: null,
        confidence: 0.8,
      },
    );
    assert.equal(books.qty, 4);
    assert.deepEqual(books.sticker, { color: "red", lot: "2231", number: "002" });
    assert.equal(books.condition, "carrier packed");
    assert.equal(desk.lineNo, 3);
    assert.equal(desk.condition, "broken (leg); scratched");
  });

  it("finds rows under other names and survives junk", () => {
    const r = m.normalizeManifest({ lines: [{ item: "Lamp", quantity: "2" }, { description: 7 }, null, "x"] })!;
    assert.deepEqual(r.rows.map((x) => [x.description, x.qty, x.lineNo, x.sticker]), [["Lamp", 2, null, null]]);
    assert.equal(m.normalizeManifest(null), null);
    assert.equal(m.normalizeManifest([] as unknown as Record<string, unknown>), null);
    assert.deepEqual(m.normalizeManifest({ rows: [] })!.rows, []);
  });
});

describe("merging manifest pages", () => {
  it("keeps a line photographed twice once, and never adds lines together", () => {
    const drafts = fold([MANIFEST_PAGE_1, MANIFEST_PAGE_1_AGAIN]);
    assert.deepEqual(
      drafts.map((d) => [d.lineNo, d.name, d.qty, d.sources.map((s) => s.sourceId).join("+")]),
      [
        [1, "Sofa, 3 seat", 1, "p1"],
        [2, "Carton, books", 4, "p1"],
        [3, "Desk, oak", 1, "p1+p2"],
        [4, "Carton, books", 2, "p1+p2"],
        [5, "Filing cabinet, 4 drawer", 1, "p2"],
      ],
    );
    const desk = drafts[2]!;
    assert.equal(desk.area, "Office 2");
    assert.equal(desk.stickerNumber, "003");
    assert.equal(desk.category, "Desk");
    assert.equal(
      merge.explainDraft(desk, (id) => `page ${id.slice(1)}`, { rule: "max", manifest: true }),
      "Read from page 1 (1) and page 2 (1): the same line, kept once at the larger count.",
    );
    const cabinet = drafts[4]!;
    assert.deepEqual([cabinet.stickerColor, cabinet.stickerLot, cabinet.stickerNumber], ["blue", "2231", "005"]);
    assert.equal(cabinet.category, "Storage");
    assert.equal(cabinet.condition, "dented (front)");
  });

  it("matches on the sticker when the line number was misread", () => {
    const drafts = fold([
      { rows: [{ lineNo: 7, description: "Chair", sticker: "Red 2231-007" }] },
      { rows: [{ lineNo: 1, description: "Chair, dining", sticker: "Red 2231-007" }] },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.sources.length, 2);
  });

  it("keeps lines with the same number but a different sticker lot apart", () => {
    const drafts = fold([
      { rows: [{ lineNo: 7, description: "Chair", sticker: { lot: "1", number: "7" } }] },
      { rows: [{ lineNo: 8, description: "Chair", sticker: { lot: "2", number: "7" } }] },
    ]);
    assert.equal(drafts.length, 2);
  });

  it("does not guess when a line has neither a number nor a sticker", () => {
    const drafts = fold([{ rows: [{ description: "Box" }] }, { rows: [{ description: "Box" }] }]);
    assert.equal(drafts.length, 2);
  });
});
