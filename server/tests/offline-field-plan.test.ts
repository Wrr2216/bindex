import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  orderForSync,
  planSync,
  referencedIds,
  type PlanAction,
  type PlanResult,
  type World,
  type WorldItem,
} from "../src/services/offline-field/plan";

// Fixed ids so failures read clearly.
const ITEM = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CRATE = "00000000-0000-4000-8000-000000000003";
const UNIT = "00000000-0000-4000-8000-0000000000f1";
const SHELF_A = "00000000-0000-4000-8000-0000000000a1";
const SHELF_B = "00000000-0000-4000-8000-0000000000b1";
const SHELF_C = "00000000-0000-4000-8000-0000000000c1";
const ALICE = "00000000-0000-4000-8000-00000000e001";
const BOB = "00000000-0000-4000-8000-00000000e002";

function item(over: Partial<WorldItem> = {}): WorldItem {
  return {
    name: "Drill",
    locationId: SHELF_A,
    parentItemId: null,
    holderId: null,
    holderName: null,
    ...over,
  };
}

function world(over: { items?: [string, WorldItem][]; units?: World["units"] } = {}): World {
  return {
    items: new Map(over.items ?? [[ITEM, item()], [OTHER, item({ name: "Saw" })], [CRATE, item({ name: "Crate" })]]),
    units: over.units ?? new Map(),
    locations: new Map([
      [SHELF_A, { name: "Shelf A" }],
      [SHELF_B, { name: "Shelf B" }],
      [SHELF_C, { name: "Shelf C" }],
    ]),
    entities: new Map([
      [ALICE, { name: "Alice" }],
      [BOB, { name: "Bob" }],
    ]),
  };
}

let nextSeq = 1;
function action(type: PlanAction["type"], over: Partial<PlanAction> = {}): PlanAction {
  const seq = over.seq ?? nextSeq++;
  return { id: `a${seq}`, seq, type, itemId: ITEM, ...over };
}

const move = (to: string | null, base: string | null, over: Partial<PlanAction> = {}) =>
  action("move", { to: { locationId: to }, base: { locationId: base }, ...over });

const verdicts = (results: PlanResult[]) => results.map((r) => `${r.id}:${r.verdict}`);

describe("queue ordering", () => {
  it("plans the oldest change first, whatever order the device sent them in", () => {
    const a = action("spot_check", { id: "late", seq: 30 });
    const b = action("spot_check", { id: "early", seq: 10 });
    const c = action("spot_check", { id: "middle", seq: 20 });
    assert.deepEqual(
      orderForSync([a, b, c]).map((x) => x.id),
      ["early", "middle", "late"],
    );
    assert.deepEqual(
      planSync([a, b, c], world()).map((r) => r.id),
      ["early", "middle", "late"],
    );
  });

  it("keeps the sent order when two changes share a sequence number", () => {
    const a = action("note", { id: "first", seq: 5 });
    const b = action("note", { id: "second", seq: 5 });
    assert.deepEqual(orderForSync([a, b]).map((x) => x.id), ["first", "second"]);
  });

  it("evaluates each change against the state earlier changes leave behind", () => {
    // Offline: A -> B, then B -> C. The second change's base is B, which is
    // only true once the first has gone through.
    const first = move(SHELF_B, SHELF_A, { id: "first", seq: 1 });
    const second = move(SHELF_C, SHELF_B, { id: "second", seq: 2 });
    assert.deepEqual(verdicts(planSync([second, first], world())), ["first:send", "second:send"]);
  });

  it("holds back later changes to the same item behind one that needs a person", () => {
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })], [OTHER, item()]] });
    const moved = move(SHELF_B, SHELF_A, { id: "move", seq: 1 });
    const checkout = action("checkout", { id: "out", seq: 2, entityId: ALICE, base: { holderId: null } });
    const elsewhere = action("spot_check", { id: "other", seq: 3, itemId: OTHER });
    const results = planSync([moved, checkout, elsewhere], w);
    assert.deepEqual(verdicts(results), ["move:conflict", "out:blocked", "other:send"]);
    const blocked = results[1] as Extract<PlanResult, { verdict: "blocked" }>;
    assert.equal(blocked.blockedBy, "move");
  });

  it("treats a change already waiting on a person as held, and blocks what follows it", () => {
    const held = action("checkin", { id: "held", seq: 1, held: true });
    const next = action("spot_check", { id: "next", seq: 2 });
    assert.deepEqual(verdicts(planSync([held, next], world())), ["held:held", "next:blocked"]);
  });

  it("orders a unit's changes separately from its item's", () => {
    const units = new Map([
      [UNIT, { itemId: ITEM, name: "Unit 1", locationId: SHELF_C, holderId: null, holderName: null }],
    ]);
    const w = world({ units });
    const unitMove = move(SHELF_B, SHELF_A, { id: "unit", seq: 1, unitId: UNIT });
    const itemCheck = action("spot_check", { id: "item", seq: 2 });
    assert.deepEqual(verdicts(planSync([unitMove, itemCheck], w)), ["unit:conflict", "item:send"]);
  });

  it("never lets a bulk check wait on, or hold up, a single item", () => {
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })], [OTHER, item()]] });
    const conflicted = move(SHELF_B, SHELF_A, { id: "move", seq: 1 });
    const audit = action("audit_apply", { id: "audit", seq: 2, itemId: null, itemIds: [ITEM, OTHER] });
    const after = action("note", { id: "note", seq: 3, itemId: OTHER });
    assert.deepEqual(verdicts(planSync([conflicted, audit, after], w)), [
      "move:conflict",
      "audit:send",
      "note:send",
    ]);
  });

  it("does not change the world it was given", () => {
    const w = world();
    planSync([move(SHELF_B, SHELF_A)], w);
    assert.equal(w.items.get(ITEM)!.locationId, SHELF_A);
  });
});

describe("conflict rules: moves", () => {
  it("sends a move when nothing changed on the server", () => {
    assert.deepEqual(verdicts(planSync([move(SHELF_B, SHELF_A, { id: "m" })], world())), ["m:send"]);
  });

  it("flags an item someone else moved since the device cached it", () => {
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })]] });
    const [r] = planSync([move(SHELF_B, SHELF_A)], w);
    assert.equal(r!.verdict, "conflict");
    const c = r as Extract<PlanResult, { verdict: "conflict" }>;
    assert.equal(c.code, "moved");
    assert.equal(c.canKeepMine, true);
    assert.match(c.reason, /Shelf C/);
  });

  it("sends a move the server already reflects, since replaying it is harmless", () => {
    // The first attempt reached the server but its answer was lost.
    const w = world({ items: [[ITEM, item({ locationId: SHELF_B })]] });
    assert.deepEqual(verdicts(planSync([move(SHELF_B, SHELF_A, { id: "m" })], w)), ["m:send"]);
  });

  it("sends anyway once the person chose keep-mine", () => {
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })]] });
    assert.deepEqual(verdicts(planSync([move(SHELF_B, SHELF_A, { id: "m", force: true })], w)), [
      "m:send",
    ]);
  });

  it("sends without checking when the device did not know where the item was", () => {
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })]] });
    assert.deepEqual(verdicts(planSync([move(SHELF_B, null, { id: "m", base: null })], w)), ["m:send"]);
  });

  it("cannot keep a move to a deleted location or a deleted item", () => {
    const gone = "00000000-0000-4000-8000-00000000dead";
    const [toGone] = planSync([move(gone, SHELF_A)], world());
    assert.equal((toGone as { code?: string }).code, "destination_deleted");
    assert.equal((toGone as { canKeepMine?: boolean }).canKeepMine, false);

    const [itemGone] = planSync([move(SHELF_B, SHELF_A)], world({ items: [] }));
    assert.equal((itemGone as { code?: string }).code, "deleted");
    assert.equal((itemGone as { canKeepMine?: boolean }).canKeepMine, false);
  });

  it("flags a container move when the item was put in another container", () => {
    const w = world({
      items: [
        [ITEM, item({ parentItemId: OTHER })],
        [OTHER, item({ name: "Toolbox" })],
        [CRATE, item({ name: "Crate" })],
      ],
    });
    const intoCrate = action("move", { to: { parentItemId: CRATE }, base: { parentItemId: null } });
    const [r] = planSync([intoCrate], w);
    assert.equal(r!.verdict, "conflict");
    assert.match((r as { reason: string }).reason, /Toolbox/);
  });

  it("only compares the fields a move changes", () => {
    // Someone moved it to another shelf; this change only puts it in a crate.
    const w = world({ items: [[ITEM, item({ locationId: SHELF_C })], [CRATE, item()]] });
    const intoCrate = action("move", {
      id: "m",
      to: { parentItemId: CRATE },
      base: { locationId: SHELF_A, parentItemId: null },
    });
    assert.deepEqual(verdicts(planSync([intoCrate], w)), ["m:send"]);
  });
});

describe("conflict rules: check-out and check-in", () => {
  it("sends a check-out when the item was on the shelf and still is", () => {
    const out = action("checkout", { id: "o", entityId: ALICE, base: { holderId: null } });
    assert.deepEqual(verdicts(planSync([out], world())), ["o:send"]);
  });

  it("skips a check-out the server already has, instead of duplicating history", () => {
    const w = world({ items: [[ITEM, item({ holderId: ALICE, holderName: "Alice" })]] });
    const [r] = planSync([action("checkout", { entityId: ALICE, base: { holderId: null } })], w);
    assert.equal(r!.verdict, "skip");
    assert.match((r as { reason: string }).reason, /Alice/);
  });

  it("flags a check-out when someone else took it meanwhile", () => {
    const w = world({ items: [[ITEM, item({ holderId: BOB, holderName: "Bob" })]] });
    const [r] = planSync([action("checkout", { entityId: ALICE, base: { holderId: null } })], w);
    assert.equal(r!.verdict, "conflict");
    assert.equal((r as { code: string }).code, "holder_changed");
    assert.match((r as { reason: string }).reason, /Bob/);
  });

  it("cannot check out to a holder that was deleted", () => {
    const gone = "00000000-0000-4000-8000-00000000dead";
    const [r] = planSync([action("checkout", { entityId: gone, base: { holderId: null } })], world());
    assert.equal((r as { code: string }).code, "holder_deleted");
    assert.equal((r as { canKeepMine: boolean }).canKeepMine, false);
  });

  it("skips a check-in the server already has", () => {
    const [r] = planSync([action("checkin", { base: { holderId: ALICE } })], world());
    assert.equal(r!.verdict, "skip");
  });

  it("flags a check-in when it went out to someone else meanwhile", () => {
    const w = world({ items: [[ITEM, item({ holderId: BOB, holderName: "Bob" })]] });
    const [r] = planSync([action("checkin", { base: { holderId: ALICE } })], w);
    assert.equal(r!.verdict, "conflict");
    assert.equal((r as { canKeepMine: boolean }).canKeepMine, true);
  });

  it("follows a check-out with a check-in made later on the same device", () => {
    const out = action("checkout", { id: "out", seq: 1, entityId: ALICE, base: { holderId: null } });
    const back = action("checkin", { id: "in", seq: 2, base: { holderId: ALICE } });
    assert.deepEqual(verdicts(planSync([back, out], world())), ["out:send", "in:send"]);
  });

  it("checks a unit's own holder, not its item's", () => {
    const units = new Map([
      [UNIT, { itemId: ITEM, name: "Unit 1", locationId: SHELF_A, holderId: null, holderName: null }],
    ]);
    const w = world({ units, items: [[ITEM, item({ holderId: BOB, holderName: "Bob" })]] });
    const out = action("checkout", { id: "o", unitId: UNIT, entityId: ALICE, base: { holderId: null } });
    assert.deepEqual(verdicts(planSync([out], w)), ["o:send"]);
  });

  it("treats a deleted unit as deleted", () => {
    const out = action("checkout", { unitId: UNIT, entityId: ALICE, base: { holderId: null } });
    const [r] = planSync([out], world());
    assert.equal((r as { code: string }).code, "deleted");
  });
});

describe("conflict rules: observations", () => {
  it("sends spot checks, notes and photos unless the item is gone", () => {
    const ok = [
      action("spot_check", { id: "s" }),
      action("note", { id: "n" }),
      action("photo", { id: "p" }),
    ];
    assert.deepEqual(verdicts(planSync(ok, world())), ["s:send", "n:send", "p:send"]);
    for (const a of ok) {
      const [r] = planSync([a], world({ items: [] }));
      assert.equal(r!.verdict, "conflict");
      assert.equal((r as { canKeepMine: boolean }).canKeepMine, false);
    }
    // Together, the first one holds up the rest for the same item.
    assert.deepEqual(verdicts(planSync(ok, world({ items: [] }))), [
      "s:conflict",
      "n:blocked",
      "p:blocked",
    ]);
  });

  it("names deleted items in an audit so they can be left out", () => {
    const gone = "00000000-0000-4000-8000-00000000dead";
    const audit = action("audit_apply", { itemId: null, itemIds: [ITEM, gone] });
    const [r] = planSync([audit], world());
    assert.equal(r!.verdict, "conflict");
    assert.deepEqual((r as { missingItemIds: string[] }).missingItemIds, [gone]);
    assert.equal((r as { canKeepMine: boolean }).canKeepMine, true);
  });

  it("cannot apply a verification of a deleted location", () => {
    const gone = "00000000-0000-4000-8000-00000000dead";
    const verify = action("verify_apply", { itemId: null, locationId: gone, itemIds: [ITEM] });
    const [r] = planSync([verify], world());
    assert.equal((r as { code: string }).code, "deleted");
  });

  it("uses the instance's own words in reasons", () => {
    const terms = { item: "asset", items: "assets", location: "bay", holder: "crew" };
    const [r] = planSync([action("note")], world({ items: [] }), terms);
    assert.match((r as { reason: string }).reason, /asset/);
    const gone = "00000000-0000-4000-8000-00000000dead";
    const [h] = planSync([action("checkout", { entityId: gone, base: { holderId: null } })], world(), terms);
    assert.match((h as { reason: string }).reason, /The crew it was being checked out to/);
  });
});

describe("referencedIds", () => {
  it("collects every record the planner looks up", () => {
    const ids = referencedIds([
      action("move", { to: { locationId: SHELF_B, parentItemId: CRATE } }),
      action("checkout", { unitId: UNIT, entityId: ALICE }),
      action("verify_apply", { itemId: null, locationId: SHELF_C, itemIds: [OTHER] }),
    ]);
    assert.deepEqual(new Set(ids.items), new Set([ITEM, CRATE, OTHER]));
    assert.deepEqual(ids.units, [UNIT]);
    assert.deepEqual(new Set(ids.locations), new Set([SHELF_B, SHELF_C]));
    assert.deepEqual(ids.entities, [ALICE]);
  });
});
