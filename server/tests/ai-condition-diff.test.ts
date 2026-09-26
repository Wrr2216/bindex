import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Defect } from "../src/db/tables/ai-condition";

// The deterministic before/after comparison of defect lists.

type Diff = typeof import("../src/services/ai-condition/diff");
let diff: Diff;

before(async () => {
  diff = await import("../src/services/ai-condition/diff");
});

const d = (area: string, type: Defect["type"], severity: Defect["severity"] = "minor", description: string | null = null): Defect => ({
  area,
  type,
  severity,
  description,
});

describe("area matching", () => {
  it("reduces an area to the words that locate it", () => {
    assert.deepEqual(diff.areaTokens("Top-left corner of the lid"), ["corner", "left", "lid", "top"]);
    assert.deepEqual(diff.areaTokens("lid, top left corner"), ["corner", "left", "lid", "top"]);
    assert.deepEqual(diff.areaTokens("Rear panel, LHS"), ["back", "left"]);
    assert.deepEqual(diff.areaTokens("upper surface"), ["top"]);
    assert.deepEqual(diff.areaTokens("front legs"), ["front", "leg"]);
    assert.deepEqual(diff.areaTokens("glass"), ["glass"]);
    assert.deepEqual(diff.areaTokens("general"), []);
  });

  it("scores the same place as 1, a more specific one as 0.75, others lower", () => {
    assert.equal(diff.areaSimilarity("left side", "Left"), 1);
    assert.equal(diff.areaSimilarity("lid", "lid, top left corner"), 0.75);
    assert.equal(diff.areaSimilarity("front left leg", "front right leg"), 0.5);
    assert.ok(diff.areaSimilarity("top", "bottom") < 0.5);
    assert.equal(diff.areaSimilarity("general", ""), 1);
    assert.equal(diff.areaSimilarity("general", "lid"), 0);
  });
});

describe("diffDefects", () => {
  it("finds new, resolved, worse, better and unchanged defects", () => {
    const beforeList = [
      d("top left corner of the lid", "scratch", "minor"),
      d("front edge", "dent", "moderate"),
      d("rear leg", "loose", "major"),
      d("seat", "stain", "minor"),
    ];
    const afterList = [
      d("Lid, top-left corner", "scratch", "minor"),
      d("front edge", "dent", "major"),
      d("back leg", "loose", "minor"),
      d("right door", "crack", "moderate"),
    ];
    const r = diff.diffDefects(beforeList, afterList);
    assert.deepEqual(r.added, [afterList[3]]);
    assert.deepEqual(r.resolved, [beforeList[3]]);
    assert.deepEqual(r.worsened, [{ before: beforeList[1], after: afterList[1] }]);
    assert.deepEqual(r.improved, [{ before: beforeList[2], after: afterList[2] }]);
    assert.deepEqual(r.unchanged, [{ before: beforeList[0], after: afterList[0] }]);
    assert.deepEqual(r.afterStatus, ["same", "worse", "better", "new"]);
    assert.deepEqual(r.beforeStatus, ["matched", "matched", "matched", "gone"]);
  });

  it("does not pair defects of different types in the same place", () => {
    const r = diff.diffDefects([d("lid", "scratch")], [d("lid", "dent")]);
    assert.equal(r.added.length, 1);
    assert.equal(r.resolved.length, 1);
    assert.equal(r.unchanged.length, 0);
  });

  it("pairs each defect at most once, preferring the closest area", () => {
    const beforeList = [d("front left leg", "scratch"), d("front right leg", "scratch")];
    const afterList = [d("front right leg", "scratch"), d("front left leg", "scratch"), d("front leg", "scratch")];
    const r = diff.diffDefects(beforeList, afterList);
    assert.deepEqual(
      r.unchanged.map((p) => [p.before.area, p.after.area]),
      [
        ["front right leg", "front right leg"],
        ["front left leg", "front left leg"],
      ],
    );
    assert.deepEqual(r.added, [afterList[2]]);
    assert.deepEqual(r.resolved, []);
  });

  it("treats two new scratches as new even when one was already there", () => {
    const r = diff.diffDefects([d("lid", "scratch")], [d("lid", "scratch"), d("lid", "scratch", "moderate")]);
    assert.equal(r.unchanged.length, 1);
    assert.deepEqual(r.added, [d("lid", "scratch", "moderate")]);
    assert.deepEqual(r.afterStatus, ["same", "new"]);
  });

  it("gives the same answer whichever order ties are listed in", () => {
    const beforeList = [d("door", "dent", "minor"), d("door", "dent", "major")];
    const afterList = [d("door", "dent", "major")];
    const r = diff.diffDefects(beforeList, afterList);
    // The closer severity wins the pairing, so nothing is reported as worse.
    assert.deepEqual(r.unchanged, [{ before: beforeList[1], after: afterList[0] }]);
    assert.deepEqual(r.resolved, [beforeList[0]]);
    const flipped = diff.diffDefects([...beforeList].reverse(), afterList);
    assert.deepEqual(flipped.unchanged, r.unchanged);
  });

  it("handles empty lists", () => {
    assert.deepEqual(diff.diffDefects([], []), {
      added: [],
      resolved: [],
      worsened: [],
      improved: [],
      unchanged: [],
      afterStatus: [],
      beforeStatus: [],
    });
    assert.equal(diff.diffDefects([], [d("lid", "crack")]).added.length, 1);
    assert.equal(diff.diffDefects([d("lid", "crack")], []).resolved.length, 1);
  });
});

describe("ratingChange", () => {
  it("compares ratings, and says nothing when one is missing", () => {
    assert.equal(diff.ratingChange("good", "damaged"), "worse");
    assert.equal(diff.ratingChange("poor", "fair"), "better");
    assert.equal(diff.ratingChange("fair", "fair"), "same");
    assert.equal(diff.ratingChange(null, "fair"), null);
  });
});
