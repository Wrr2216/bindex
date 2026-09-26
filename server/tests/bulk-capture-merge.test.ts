import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { ROOM_PHOTOS, ROOM_PHOTO_1, ROOM_PHOTO_2, ROOM_PHOTO_3 } from "./bulk-capture-fixtures";

// Names, photo readings and the merge rules for walkthroughs. Pure: no
// database and no provider, so these run everywhere.

type Names = typeof import("../src/services/bulk-capture/names");
type Detections = typeof import("../src/services/bulk-capture/detections");
type Merge = typeof import("../src/services/bulk-capture/merge");
let names: Names;
let det: Detections;
let merge: Merge;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  names = await import("../src/services/bulk-capture/names");
  det = await import("../src/services/bulk-capture/detections");
  merge = await import("../src/services/bulk-capture/merge");
});

type Draft = import("../src/services/bulk-capture/merge").MergeDraft;

/** Run readings through the merge the way the service does, giving new drafts ids. */
function simulate(
  readings: Record<string, unknown>[],
  opts: { rule?: "max" | "sum"; areas?: (string | null)[]; start?: Draft[] } = {},
): Draft[] {
  let drafts: Draft[] = opts.start ?? [];
  let next = drafts.length;
  // Photos already folded into `start` keep their numbers; these follow on.
  const seen = new Set(drafts.flatMap((d) => d.sources.map((s) => s.sourceId))).size;
  readings.forEach((raw, i) => {
    const reading = det.normalizePhotoReading(raw);
    assert.ok(reading, `reading ${i + 1} normalizes`);
    const n = seen + i + 1;
    const result = merge.mergePhotoDetections(
      drafts,
      reading.items,
      { sourceId: `s${n}`, attachmentId: `a${n}`, area: opts.areas?.[i] ?? null },
      opts.rule ?? "max",
    );
    const byId = new Map(result.updated.map((d) => [d.id, d]));
    drafts = drafts.map((d) => byId.get(d.id) ?? d);
    for (const c of result.created) drafts.push({ ...c, id: `d${++next}` });
  });
  return drafts;
}

const labelFor = (id: string) => `photo ${id.slice(1)}`;
const find = (drafts: Draft[], name: string) => {
  const d = drafts.find((x) => x.name === name);
  assert.ok(d, `a draft named "${name}" (have: ${drafts.map((x) => x.name).join(", ")})`);
  return d;
};

describe("names", () => {
  it("makes plurals singular and drops counts and filler", () => {
    assert.deepEqual(names.nameTokens("2x Black Office Chairs"), ["black", "office", "chair"]);
    assert.deepEqual(names.nameTokens("Boxes of the books"), ["box", "book"]);
    assert.deepEqual(names.nameTokens("Shelves"), ["shelf"]);
    assert.equal(names.singular("glass"), "glass");
    assert.equal(names.singular("batteries"), "battery");
  });

  it("treats names as the same kind only when the head noun and most words agree", () => {
    assert.equal(names.compareNames("chair", "black office chair").same, true);
    assert.equal(names.compareNames("office chairs", "office chair").same, true);
    assert.equal(names.compareNames("black office chair", "red office chair").same, false);
    assert.equal(names.compareNames("monitor", "monitor arm").same, false);
    assert.equal(names.compareNames("TV", "television").same, false);
    assert.equal(names.compareNames("ergonomic office chair", "black office chair").same, false);
    assert.equal(names.compareNames("large oak conference table", "oak conference table").same, true);
    assert.equal(names.compareNames("", "chair").same, false);
  });

  it("maps free-text categories and names onto one vocabulary", () => {
    assert.equal(names.categoryKey("seating"), "seating");
    assert.equal(names.categoryKey("Chairs"), "seating");
    assert.equal(names.categoryKey(null, "desk lamp"), "lighting");
    assert.equal(names.categoryKey(null, "standing desk"), "desk");
    assert.equal(names.categoryKey(null, "docking station"), "peripheral");
    assert.equal(names.categoryKey("Audio-visual"), "av");
    assert.equal(names.categoryKey("gizmo", "widget"), "other");
    assert.equal(names.displayCategory("seating"), "Seating");
    assert.equal(names.displayCategory("Kitchenware", "spoon"), "Kitchenware");
  });

  it("only calls brands a conflict when both are given and differ", () => {
    assert.equal(names.conflicts("Herman-Miller", "herman miller"), false);
    assert.equal(names.conflicts("Dell", null), false);
    assert.equal(names.conflicts("Dell", "HP"), true);
  });
});

describe("normalizePhotoReading", () => {
  it("cleans a messy reply", () => {
    const r = det.normalizePhotoReading(ROOM_PHOTO_2)!;
    assert.equal(r.room, "Conference room with a wall-mounted screen");
    const chairs = r.items.find((i) => i.name === "black office chair")!;
    assert.equal(chairs.qty, 6);
    assert.equal(chairs.category, "Seating");
    assert.deepEqual(chairs.bbox, { x: 0.1, y: 0.42, w: 0.8, h: 0.5 });
    const table = r.items.find((i) => i.name === "conference table")!;
    assert.equal(table.confidence, 0.93);
    const tv = r.items.find((i) => i.name === "TV")!;
    assert.equal(tv.brand, "Samsung");
    assert.equal(tv.category, "Audio-visual");
  });

  it("reads word confidences and string counts", () => {
    const r = det.normalizePhotoReading(ROOM_PHOTO_3)!;
    assert.equal(r.items.find((i) => i.name === "office chair")!.qty, 3);
    assert.equal(r.items.find((i) => i.name === "Poly Trio conference phone")!.confidence, 0.6);
    assert.equal(det.normalizePhotoReading(ROOM_PHOTO_1)!.items.find((i) => i.name === "whiteboard")!.confidence, 0.9);
  });

  it("adds up identical names within one photo and drops nameless entries", () => {
    const r = det.normalizePhotoReading({
      detected: [
        { name: "Chair", qty: 2 },
        { name: "chairs", qty: 1, brand: "Steelcase" },
        { name: "  ", qty: 5 },
        { qty: 3 },
        "not an object",
      ],
    })!;
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.qty, 3);
    assert.equal(r.items[0]!.brand, "Steelcase");
  });

  it("returns null for replies that are not an object, and an empty list for no items", () => {
    assert.equal(det.normalizePhotoReading(null), null);
    assert.equal(det.normalizePhotoReading([] as unknown as Record<string, unknown>), null);
    assert.deepEqual(det.normalizePhotoReading({ items: [] })!.items, []);
  });

  it("parses counts the way people write them", () => {
    assert.equal(det.parseQty(3), 3);
    assert.equal(det.parseQty("3 ea"), 3);
    assert.equal(det.parseQty("x2"), 2);
    assert.equal(det.parseQty("Qty: 12"), 12);
    assert.equal(det.parseQty("two"), 2);
    assert.equal(det.parseQty("a pair"), 1);
    assert.equal(det.parseQty("0"), null);
    assert.equal(det.parseQty(""), null);
    assert.equal(det.parseQty("n/a"), null);
    assert.equal(det.parseQty(2.6), 3);
  });

  it("reads boxes in every common shape and rejects nonsense", () => {
    assert.deepEqual(det.normalizeBbox([0.1, 0.2, 0.3, 0.4]), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(det.normalizeBbox([100, 200, 300, 400]), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(det.normalizeBbox({ x: 0.5, y: 0.5, width: 0.2, height: 0.1 }), { x: 0.5, y: 0.5, w: 0.2, h: 0.1 });
    assert.deepEqual(det.normalizeBbox({ left: 0.1, top: 0.1, right: 0.4, bottom: 0.3 }), { x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
    // Corners that only fit read as corners.
    assert.deepEqual(det.normalizeBbox([0.6, 0.5, 0.9, 0.8]), { x: 0.6, y: 0.5, w: 0.3, h: 0.3 });
    // Pixels of a 1600 x 1200 image.
    assert.deepEqual(det.normalizeBbox([1200, 600, 400, 300], { width: 1600, height: 1200 }), { x: 0.75, y: 0.5, w: 0.25, h: 0.25 });
    assert.equal(det.normalizeBbox([1200, 600, 400, 300]), null);
    assert.equal(det.normalizeBbox([0.1, 0.1, 0, 0.5]), null);
    assert.equal(det.normalizeBbox([-1, 0, 1, 1]), null);
    assert.equal(det.normalizeBbox("0,0,1,1"), null);
  });
});

describe("merging three overlapping photos", () => {
  it("yields one entry per real thing, with the largest count and the reasons", () => {
    const drafts = simulate(ROOM_PHOTOS);
    assert.deepEqual(
      drafts.map((d) => [d.name, d.qty]),
      [
        ["black office chair", 6],
        ["conference table", 1],
        ["whiteboard", 1],
        ["monitor", 1],
        ["TV", 1],
        ["Poly Trio conference phone", 1],
        ["red office chair", 1],
        ["television", 1],
        ["floor lamp", 1],
      ],
    );

    const chairs = find(drafts, "black office chair");
    assert.deepEqual(
      chairs.sources.map((s) => [s.sourceId, s.qty, s.name]),
      [
        ["s1", 4, "office chair"],
        ["s2", 6, "black office chair"],
        ["s3", 3, "office chair"],
      ],
    );
    assert.equal(
      merge.explainDraft(chairs, labelFor, { rule: "max" }),
      "Seen in photo 1 (4), photo 2 (6) and photo 3 (3). Overlapping photos usually show the same things, so the largest count is used. Called “office chair” and “black office chair”.",
    );
    assert.equal(find(drafts, "conference table").sources.length, 2);
    assert.equal(find(drafts, "Poly Trio conference phone").brand, "Poly");
    // Seen once, nothing to explain.
    assert.equal(merge.explainDraft(find(drafts, "floor lamp"), labelFor, { rule: "max" }), null);
  });

  it("adds counts instead when the photos do not overlap", () => {
    const drafts = simulate(ROOM_PHOTOS, { rule: "sum" });
    const chairs = find(drafts, "black office chair");
    assert.equal(chairs.qty, 13);
    assert.match(merge.explainDraft(chairs, labelFor, { rule: "sum" })!, /counts are added/);
  });

  it("never merges across rooms", () => {
    const drafts = simulate([ROOM_PHOTO_1, ROOM_PHOTO_1], { areas: ["Room 101", "Room 102"] });
    assert.equal(drafts.length, 8);
    assert.equal(drafts.filter((d) => d.area === "Room 102").length, 4);
  });

  it("lets one photo add to an entry only once", () => {
    const drafts = simulate([
      { items: [{ name: "chair", category: "seating", qty: 2 }] },
      { items: [{ name: "chair", category: "seating", qty: 1 }, { name: "office chair", category: "seating", qty: 1 }] },
    ]);
    // Two lines in one photo are two different things; the second becomes its own entry.
    assert.deepEqual(drafts.map((d) => [d.name, d.qty, d.sources.length]), [
      ["chair", 2, 2],
      ["office chair", 1, 1],
    ]);
  });

  it("keeps conflicting brands apart", () => {
    const drafts = simulate([
      { items: [{ name: "monitor", category: "monitor", brand: "Dell" }] },
      { items: [{ name: "monitor", category: "monitor", brand: "HP" }] },
    ]);
    assert.equal(drafts.length, 2);
  });

  it("does not overwrite what a person edited, and keeps a typed quantity", () => {
    const first = simulate([ROOM_PHOTO_1]);
    const chairs = find(first, "office chair");
    chairs.name = "Visitor chair";
    chairs.edited = true;
    chairs.qty = 5;
    chairs.qtyLocked = true;
    const drafts = simulate([ROOM_PHOTO_2].map((r) => r), { start: first });
    const after = drafts.find((d) => d.id === chairs.id)!;
    assert.equal(after.name, "Visitor chair");
    assert.equal(after.qty, 5);
    assert.equal(after.sources.length, 2);
    assert.match(merge.explainDraft(after, labelFor, { rule: "max" })!, /set by hand/);
  });

  it("lets a deleted entry absorb later sightings instead of coming back", () => {
    const first = simulate([ROOM_PHOTO_1]);
    find(first, "whiteboard").status = "discarded";
    const drafts = simulate([{ items: [{ name: "whiteboard", category: "fixture", qty: 1 }] }], { start: first });
    const boards = drafts.filter((d) => d.name === "whiteboard");
    assert.equal(boards.length, 1);
    assert.equal(boards[0]!.status, "discarded");
    assert.equal(boards[0]!.sources.length, 2);
  });
});

describe("taking a photo back out", () => {
  it("drops its contributions and entries only it supported", () => {
    const drafts = simulate(ROOM_PHOTOS);
    const out = merge.withoutSource(drafts, "s2", "max");
    const removed = out.removed.map((d) => d.name).sort();
    assert.deepEqual(removed, ["TV"]);
    const chairs = out.updated.find((d) => d.name === "black office chair")!;
    assert.equal(chairs.qty, 4);
    assert.deepEqual(chairs.sources.map((s) => s.sourceId), ["s1", "s3"]);
  });

  it("keeps an entry a person edited even when its last photo goes", () => {
    const drafts = simulate([ROOM_PHOTO_1]);
    find(drafts, "whiteboard").edited = true;
    const out = merge.withoutSource(drafts, "s1", "max");
    assert.ok(out.updated.some((d) => d.name === "whiteboard" && d.sources.length === 0));
    assert.ok(!out.removed.some((d) => d.name === "whiteboard"));
  });

  it("moves a photo to another room, keeping what a person edited or deleted", () => {
    const drafts = simulate([ROOM_PHOTO_1, ROOM_PHOTO_2], { areas: ["Room 1", "Room 1"] });
    const monitor = find(drafts, "monitor");
    monitor.edited = true;
    monitor.name = "Dell P2422H";
    find(drafts, "whiteboard").status = "discarded";
    const reading = det.normalizePhotoReading(ROOM_PHOTO_1)!;
    const out = merge.moveSource(drafts, { sourceId: "s1", attachmentId: "a1", area: "Room 2" }, { kind: "photo", items: reading.items }, "max");

    // Edited and deleted entries only photo 1 supported move as they are.
    const moved = out.updated.find((d) => d.id === monitor.id)!;
    assert.deepEqual([moved.name, moved.area, moved.edited], ["Dell P2422H", "Room 2", true]);
    const board = out.updated.find((d) => d.name === "whiteboard")!;
    assert.deepEqual([board.status, board.area], ["discarded", "Room 2"]);
    // Shared entries lose photo 1; its chairs and table start again in Room 2.
    const chairs = out.updated.find((d) => d.name === "black office chair")!;
    assert.deepEqual([chairs.qty, chairs.sources.map((s) => s.sourceId)], [6, ["s2"]]);
    assert.deepEqual(
      out.created.map((d) => [d.name, d.qty, d.area]),
      [
        ["office chair", 4, "Room 2"],
        ["conference table", 1, "Room 2"],
      ],
    );
    assert.deepEqual(out.removed, []);
  });

  it("is a plain merge for an image read for the first time", () => {
    const reading = det.normalizePhotoReading(ROOM_PHOTO_1)!;
    const out = merge.moveSource([], { sourceId: "s1", attachmentId: "a1", area: null }, { kind: "photo", items: reading.items }, "max");
    assert.equal(out.created.length, 4);
    assert.deepEqual([out.updated, out.removed], [[], []]);
  });

  it("recounts every unlocked entry when the rule changes", () => {
    const drafts = simulate(ROOM_PHOTOS);
    const changed = merge.recountAll(drafts, "sum");
    assert.deepEqual(changed.map((d) => [d.name, d.qty]), [
      ["black office chair", 13],
      ["conference table", 2],
      ["Poly Trio conference phone", 2],
    ]);
  });
});

describe("merging and splitting by hand", () => {
  it("merges two names for one thing and explains it", () => {
    const drafts = simulate(ROOM_PHOTOS);
    const merged = merge.mergeByHand(find(drafts, "TV"), [find(drafts, "television")], "max");
    assert.equal(merged.name, "TV");
    assert.equal(merged.qty, 1);
    assert.equal(merged.edited, true);
    assert.deepEqual(merged.sources.map((s) => s.sourceId), ["s2", "s3"]);
    assert.equal(merged.note, "Merged by hand from “TV” and “television”.");
    assert.match(merge.explainDraft(merged, labelFor, { rule: "max" })!, /^Seen in photo 2 \(1\) and photo 3 \(1\)\..*Merged by hand/);
  });

  it("adds counts from the same photo, and adds typed counts", () => {
    const drafts = simulate([{ items: [{ name: "chair", category: "seating", qty: 2 }, { name: "stool", category: "seating", qty: 1 }] }]);
    const merged = merge.mergeByHand(drafts[0]!, [drafts[1]!], "max");
    assert.equal(merged.qty, 3);
    const typed = merge.mergeByHand({ ...drafts[0]!, qty: 4, qtyLocked: true }, [drafts[1]!], "max");
    assert.equal(typed.qty, 5);
    assert.equal(typed.qtyLocked, true);
  });

  it("splits a merged entry back into one per photo", () => {
    const drafts = simulate(ROOM_PHOTOS);
    const parts = merge.splitBySource(find(drafts, "black office chair"))!;
    assert.deepEqual(parts.map((p) => [p.id !== null, p.name, p.qty]), [
      [true, "office chair", 4],
      [false, "black office chair", 6],
      [false, "office chair", 3],
    ]);
    assert.equal(merge.splitBySource(find(drafts, "floor lamp")), null);
  });

  it("splits a quantity off", () => {
    const drafts = simulate(ROOM_PHOTOS);
    const [rest, off] = merge.splitByQty(find(drafts, "black office chair"), 2)!;
    assert.equal(rest.qty, 4);
    assert.equal(off.qty, 2);
    assert.equal(off.id, null);
    assert.equal(rest.qtyLocked && off.qtyLocked, true);
    assert.equal(merge.splitByQty(find(drafts, "floor lamp"), 1), null);
    assert.equal(merge.splitByQty(find(drafts, "black office chair"), 6), null);
  });
});
