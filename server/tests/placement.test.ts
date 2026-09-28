import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Some modules read the environment when they load, so the minimum required
// configuration has to exist before the dynamic imports below.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Tree = typeof import("../src/services/placement/tree");
type Colors = typeof import("../src/services/placement/colors");
type Propose = typeof import("../src/services/placement/propose");
type Match = typeof import("../src/services/placement/match");
type Progress = typeof import("../src/services/placement/progress");
type Kiosk = typeof import("../src/services/placement/kiosk");
type JobsModel = typeof import("../src/services/jobs-core/model");

let tree: Tree;
let colors: Colors;
let propose: Propose;
let match: Match;
let progress: Progress;
let kiosk: Kiosk;
let jobsModel: JobsModel;

before(async () => {
  tree = await import("../src/services/placement/tree");
  colors = await import("../src/services/placement/colors");
  propose = await import("../src/services/placement/propose");
  match = await import("../src/services/placement/match");
  progress = await import("../src/services/placement/progress");
  kiosk = await import("../src/services/placement/kiosk");
  jobsModel = await import("../src/services/jobs-core/model");
});

/**
 * A small campus to move between:
 *
 *   Old HQ / Floor 3 / Finance / Desk 12
 *                    / Legal
 *          / Floor 3 / 3.14
 *   New HQ / Level 5 / Finance / Desk 12
 *                    / 5.12
 *                    / 5.14 / North wall
 *          / Level 4 / 4.02
 *          / Dock
 *          / Level 5 / Kitchen   (two kitchens: one per floor)
 *          / Level 4 / Kitchen
 */
const P = {
  old: "00000000-0000-4000-8000-000000000001",
  old3: "00000000-0000-4000-8000-000000000002",
  oldFinance: "00000000-0000-4000-8000-000000000003",
  oldDesk12: "00000000-0000-4000-8000-000000000004",
  oldLegal: "00000000-0000-4000-8000-000000000005",
  old314: "00000000-0000-4000-8000-000000000006",
  hq: "00000000-0000-4000-8000-000000000010",
  l5: "00000000-0000-4000-8000-000000000011",
  finance: "00000000-0000-4000-8000-000000000012",
  desk12: "00000000-0000-4000-8000-000000000013",
  r512: "00000000-0000-4000-8000-000000000014",
  r514: "00000000-0000-4000-8000-000000000015",
  north: "00000000-0000-4000-8000-000000000016",
  l4: "00000000-0000-4000-8000-000000000017",
  r402: "00000000-0000-4000-8000-000000000018",
  dock: "00000000-0000-4000-8000-000000000019",
  kitchen5: "00000000-0000-4000-8000-000000000020",
  kitchen4: "00000000-0000-4000-8000-000000000021",
  oldKitchen: "00000000-0000-4000-8000-000000000022",
};

function campus() {
  return tree.buildTree([
    { id: P.old, name: "Old HQ", parentId: null },
    { id: P.old3, name: "Floor 3", parentId: P.old },
    { id: P.oldFinance, name: "Finance", parentId: P.old3 },
    { id: P.oldDesk12, name: "Desk 12", parentId: P.oldFinance },
    { id: P.oldLegal, name: "Legal", parentId: P.old3 },
    { id: P.old314, name: "3.14", parentId: P.old3 },
    { id: P.oldKitchen, name: "Kitchen", parentId: P.old3 },
    { id: P.hq, name: "New HQ", parentId: null },
    { id: P.l5, name: "Level 5", parentId: P.hq },
    { id: P.finance, name: "Finance", parentId: P.l5 },
    { id: P.desk12, name: "Desk 12", parentId: P.finance },
    { id: P.r512, name: "5.12", parentId: P.l5 },
    { id: P.r514, name: "5.14", parentId: P.l5 },
    { id: P.north, name: "North wall", parentId: P.r514 },
    { id: P.l4, name: "Level 4", parentId: P.hq },
    { id: P.r402, name: "4.02", parentId: P.l4 },
    { id: P.dock, name: "Dock", parentId: P.hq },
    { id: P.kitchen5, name: "Kitchen", parentId: P.l5 },
    { id: P.kitchen4, name: "Kitchen", parentId: P.l4 },
  ]);
}

describe("location tree", () => {
  it("relates where something was seen to where it should be", () => {
    const t = campus();
    assert.equal(tree.relation(P.r514, P.r514, t), "same");
    assert.equal(tree.relation(P.north, P.r514, t), "inside");
    assert.equal(tree.relation(P.l5, P.r514, t), "contains");
    assert.equal(tree.relation(P.r512, P.r514, t), "apart");
    assert.equal(tree.relation(P.dock, P.r514, t), "apart");
  });

  it("stops on a cycle instead of looping", () => {
    const t = tree.buildTree([
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
    ]);
    assert.deepEqual(tree.ancestry("a", t), ["a", "b"]);
    assert.equal(tree.within("a", "c", t), false);
  });

  it("names floors the way buildings do", () => {
    for (const name of ["Level 5", "Floor 3", "L5", "B1", "3rd floor", "Ground", "Mezzanine", "fl. 2", "Etage 4"]) {
      assert.equal(tree.isFloorName(name), true, name);
    }
    for (const name of ["5.14", "Finance", "Desk 12", "Dock", "Kitchen", "Level five hundred rooms"]) {
      assert.equal(tree.isFloorName(name), false, name);
    }
    const t = campus();
    assert.equal(tree.floorOf(P.north, t), "Level 5");
    assert.equal(tree.floorOf(P.dock, t), null);
  });

  it("follows names down, refusing to guess between two", () => {
    const t = campus();
    assert.equal(tree.descend(P.hq, ["Level 5", "Finance", "Desk 12"], t), P.desk12);
    assert.equal(tree.descend(P.hq, ["level 5", "  finance "], t), P.finance);
    assert.equal(tree.descend(P.hq, ["Level 6"], t), null);
    assert.deepEqual(tree.relativeNames(P.oldDesk12, P.old, t), ["Floor 3", "Finance", "Desk 12"]);
    assert.equal(tree.relativeNames(P.desk12, P.old, t), null);
  });
});

describe("floor colours", () => {
  it("gives neighbouring floors different colours, and the same floor the same one", () => {
    const four = colors.floorColor("Level 4");
    const five = colors.floorColor("Level 5");
    assert.notEqual(four, five);
    assert.equal(colors.floorColor("5"), five);
    assert.equal(colors.floorColor("L5"), five);
    assert.equal(colors.floorColor("5th floor"), five);
    assert.equal(colors.floorColor(null), colors.NO_FLOOR_COLOR);
    assert.match(colors.floorColor("Mezzanine"), /^#[0-9a-f]{6}$/);
  });

  it("reads ground and basements", () => {
    assert.equal(colors.floorNumber("Ground"), 0);
    assert.equal(colors.floorNumber("B2"), -2);
    assert.equal(colors.floorNumber("Basement"), -1);
    assert.equal(colors.floorNumber("Level 12"), 12);
    assert.equal(colors.floorNumber("Mezzanine"), null);
    assert.match(colors.floorColor("B2"), /^#[0-9a-f]{6}$/);
  });

  it("lets a job override a floor, matching its name loosely", () => {
    assert.equal(colors.floorColor("Level 5", { "level  5": "#ABCDEF" }), "#abcdef");
    assert.deepEqual(colors.readFloorColors({ "Level 5": "#123456", bad: "red", "": "#000000" }), {
      "Level 5": "#123456",
    });
    assert.deepEqual(colors.readFloorColors(null), {});
  });
});

describe("destination proposals", () => {
  const line = (id: string, originLocationId: string | null, extra: Partial<{ destinationLocationId: string; department: string; floor: string }> = {}) => ({
    id,
    originLocationId,
    destinationLocationId: extra.destinationLocationId ?? null,
    department: extra.department ?? null,
    floor: extra.floor ?? null,
  });

  it("maps through the room map, following the path below the mapped room", () => {
    const t = campus();
    const roomMap = new Map([[P.oldFinance, P.finance]]);
    const r = propose.proposeDestinations([line("a", P.oldDesk12), line("b", P.oldFinance)], t, { roomMap });
    assert.deepEqual(
      r.proposals.map((p) => [p.jobItemId, p.destinationLocationId, p.reason, p.floor]),
      [
        ["a", P.desk12, "room_map", "Level 5"],
        ["b", P.finance, "room_map", "Level 5"],
      ],
    );
  });

  it("falls back to the mapped room when the path below it is not there", () => {
    const t = campus();
    const r = propose.proposeDestinations([line("a", P.oldLegal)], t, { roomMap: new Map([[P.old3, P.l4]]) });
    assert.equal(r.proposals[0]!.destinationLocationId, P.l4);
  });

  it("uses the same path under the destination root, then the same unique name", () => {
    const t = campus();
    // With roots: Old HQ / Floor 3 / Finance has no twin path under New HQ
    // (Level 5, not Floor 3), so it falls back to the unique name "Finance".
    const r = propose.proposeDestinations([line("a", P.oldFinance), line("b", P.old314)], t, {
      originRootId: P.old,
      destinationRootId: P.hq,
    });
    assert.equal(r.proposals[0]!.destinationLocationId, P.finance);
    assert.equal(r.proposals[0]!.reason, "same_name");
    // 3.14 exists only at the old site.
    assert.equal(r.unmatched[0]!.jobItemId, "b");
    assert.equal(r.unmatched[0]!.reason, "no_match");

    const samePath = tree.buildTree([
      { id: "o", name: "Old", parentId: null },
      { id: "o1", name: "L1", parentId: "o" },
      { id: "o1a", name: "Room A", parentId: "o1" },
      { id: "n", name: "New", parentId: null },
      { id: "n1", name: "L1", parentId: "n" },
      { id: "n1a", name: "Room A", parentId: "n1" },
      { id: "n2", name: "L2", parentId: "n" },
      { id: "n2a", name: "Room A", parentId: "n2" },
    ]);
    const s = propose.proposeDestinations([line("x", "o1a")], samePath, { originRootId: "o", destinationRootId: "n" });
    assert.equal(s.proposals[0]!.destinationLocationId, "n1a");
    assert.equal(s.proposals[0]!.reason, "same_path");
  });

  it("does not propose a room at the origin, or guess between two", () => {
    const t = campus();
    // Without a destination root, "Kitchen" matches both new kitchens; the
    // origin's own kitchen is never a candidate.
    const r = propose.proposeDestinations([line("a", P.oldKitchen)], t, {});
    assert.equal(r.proposals.length, 0);
    assert.equal(r.unmatched[0]!.reason, "ambiguous");
    assert.deepEqual(new Set(r.unmatched[0]!.candidates), new Set([P.kitchen4, P.kitchen5]));
  });

  it("uses the department when the origin says nothing", () => {
    const t = campus();
    const r = propose.proposeDestinations([line("a", null, { department: "finance" })], t, {
      originRootId: P.old,
      destinationRootId: P.hq,
    });
    assert.equal(r.proposals[0]!.destinationLocationId, P.finance);
    assert.equal(r.proposals[0]!.reason, "department");
    const none = propose.proposeDestinations([line("b", null)], t, {});
    assert.equal(none.unmatched[0]!.reason, "no_origin");
  });

  it("leaves lines with a destination alone unless overwriting, and keeps the plan's floor", () => {
    const t = campus();
    const lines = [line("a", P.oldFinance, { destinationLocationId: P.r512, floor: "Level 5" })];
    const roomMap = new Map([[P.oldFinance, P.r402]]);
    assert.equal(propose.proposeDestinations(lines, t, { roomMap }).skipped, 1);
    const over = propose.proposeDestinations(lines, t, { roomMap, overwrite: true });
    // The floor only echoed the old destination's, so it follows the new one.
    assert.equal(over.proposals[0]!.floor, "Level 4");
    assert.equal(over.proposals[0]!.replaces, P.r512);
    const chosen = [line("b", P.oldFinance, { destinationLocationId: P.r512, floor: "5 (temporary)" })];
    assert.equal(propose.proposeDestinations(chosen, t, { roomMap, overwrite: true }).proposals[0]!.floor, null);
  });
});

describe("matching room reads", () => {
  const job = "job-1";
  const L = (id: string, stage: string, dest: string | null, extra: Partial<import("../src/services/placement/match").PlacementLine> = {}) => ({
    id,
    jobId: job,
    itemId: `item-${id}`,
    unitId: null,
    stage,
    shipmentId: null,
    destinationLocationId: dest,
    lastActualId: null,
    ...extra,
  });
  const read = (itemId: string, zoneId: string, at = 0, extra: Partial<{ unitId: string; nested: boolean }> = {}) => ({
    deviceId: "dev",
    itemId,
    unitId: extra.unitId ?? null,
    zoneId,
    observedAt: at,
    nested: extra.nested,
  });
  const areas = new Map([[job, [P.r512, P.r514, P.finance]]]);

  it("places a line read in its destination, or inside it", () => {
    const t = campus();
    const lines = [L("a", "delivered", P.r514), L("b", "loaded", P.r514)];
    const d = match.planReaderReads([read("item-a", P.r514), read("item-b", P.north)], lines, t, areas);
    assert.deepEqual(
      d.map((x) => [x.line.id, x.outcome]),
      [
        ["a", "placed"],
        ["b", "placed"],
      ],
    );
  });

  it("flags a line read in another room the job delivers to, with that room", () => {
    const t = campus();
    const d = match.planReaderReads([read("item-a", P.r512)], [L("a", "delivered", P.r514)], t, areas);
    assert.equal(d[0]!.outcome, "misplaced");
    assert.equal(d[0]!.read.zoneId, P.r512);
  });

  it("says nothing about reads at the dock, on the right floor, or still at the origin", () => {
    const t = campus();
    const lines = [L("a", "delivered", P.r514), L("b", "packed", P.r514), L("c", "delivered", P.r514)];
    const d = match.planReaderReads(
      [read("item-a", P.dock), read("item-b", P.r512), read("item-c", P.l5)],
      lines,
      t,
      areas,
    );
    assert.deepEqual(d, []);
  });

  it("places a line already sitting in its room, whatever its stage, but never a damaged or placed one", () => {
    const t = campus();
    const lines = [L("a", "pending", P.r514), L("b", "damaged", P.r514), L("c", "placed", P.r514)];
    const d = match.planReaderReads(
      [read("item-a", P.r514), read("item-b", P.r514), read("item-c", P.r512)],
      lines,
      t,
      areas,
    );
    assert.deepEqual(
      d.map((x) => [x.line.id, x.outcome]),
      [["a", "placed"]],
    );
  });

  it("lets a placing read win over misplacing ones, and the latest misplacing room decide", () => {
    const t = campus();
    const lines = [L("a", "delivered", P.r514), L("b", "delivered", P.r514)];
    const d = match.planReaderReads(
      [read("item-a", P.r512, 1), read("item-a", P.r514, 2), read("item-a", P.finance, 3), read("item-b", P.r512, 1), read("item-b", P.finance, 5)],
      lines,
      t,
      areas,
    );
    const by = new Map(d.map((x) => [x.line.id, x]));
    assert.equal(by.get("a")!.outcome, "placed");
    assert.equal(by.get("b")!.outcome, "misplaced");
    assert.equal(by.get("b")!.read.zoneId, P.finance);
  });

  it("does not repeat a misplaced flag for the same room", () => {
    const t = campus();
    const lines = [L("a", "misplaced", P.r514, { lastActualId: P.r512 }), L("b", "misplaced", P.r514, { lastActualId: P.r512 })];
    const d = match.planReaderReads([read("item-a", P.r512), read("item-b", P.finance)], lines, t, areas);
    assert.deepEqual(
      d.map((x) => [x.line.id, x.read.zoneId]),
      [["b", P.finance]],
    );
  });

  it("matches tags to their own lines, never an item tag to one of several units", () => {
    const t = campus();
    const lines = [
      L("u1", "delivered", P.r514, { itemId: "chairs", unitId: "u1" }),
      L("u2", "delivered", P.r512, { itemId: "chairs", unitId: "u2" }),
      L("whole", "delivered", P.r514, { itemId: "desk" }),
    ];
    const d = match.planReaderReads(
      [read("chairs", P.r514), read("chairs", P.r512, 0, { unitId: "u2" }), read("desk", P.r514, 0, { unitId: "desk-leg" })],
      lines,
      t,
      areas,
    );
    assert.deepEqual(d.map((x) => x.line.id).sort(), ["u2", "whole"]);
  });

  it("counts places inside a reader's zone only when the reader says so", () => {
    const t = campus();
    const lines = [L("a", "delivered", P.desk12)];
    assert.deepEqual(match.planReaderReads([read("item-a", P.finance)], lines, t, areas), []);
    const d = match.planReaderReads([read("item-a", P.finance, 0, { nested: true })], lines, t, areas);
    assert.equal(d[0]!.outcome, "placed");
  });
});

describe("room sweeps", () => {
  const L = (id: string, stage: string, dest: string | null, extra: Partial<import("../src/services/placement/match").PlacementLine> = {}) => ({
    id,
    jobId: "job",
    itemId: `item-${id}`,
    unitId: null,
    stage,
    shipmentId: null,
    destinationLocationId: dest,
    lastActualId: null,
    ...extra,
  });
  const resolved = (map: Record<string, { itemId: string; unitId: string | null }[]>) => new Map(Object.entries(map));

  it("sorts each code into one outcome", () => {
    const t = campus();
    const lines = [
      L("a", "delivered", P.r514),
      L("b", "placed", P.r514),
      L("c", "delivered", P.r512),
      L("d", "placed", P.r402),
      L("e", "damaged", P.r514),
      L("f", "delivered", null),
    ];
    const entries = match.planSweep(
      P.r514,
      ["A", "B", "C", "D", "E", "F", "STRANGER", "NOPE", "A"],
      resolved({
        A: [{ itemId: "item-a", unitId: null }],
        B: [{ itemId: "item-b", unitId: null }],
        C: [{ itemId: "item-c", unitId: null }],
        D: [{ itemId: "item-d", unitId: null }],
        E: [{ itemId: "item-e", unitId: null }],
        F: [{ itemId: "item-f", unitId: null }],
        STRANGER: [{ itemId: "someone-else", unitId: null }],
      }),
      lines,
      t,
    );
    assert.deepEqual(
      entries.map((e) => [e.code, e.outcome]),
      [
        ["A", "placed"],
        ["B", "already"],
        ["C", "misplaced"],
        // A person sweeping the room outranks an earlier placement elsewhere.
        ["D", "misplaced"],
        ["E", "held"],
        ["F", "no_destination"],
        ["STRANGER", "not_on_job"],
        ["NOPE", "unknown"],
      ],
    );
  });

  it("lets an item label stand in for the next of its units that belongs here", () => {
    const t = campus();
    const lines = [
      L("u1", "delivered", P.r512, { itemId: "chairs", unitId: "u1" }),
      L("u2", "delivered", P.r514, { itemId: "chairs", unitId: "u2" }),
      L("u3", "delivered", P.r514, { itemId: "chairs", unitId: "u3" }),
    ];
    const entries = match.planSweep(
      P.r514,
      ["CHAIR-1", "CHAIR-2", "CHAIR-3", "CHAIR-4"],
      resolved({
        "CHAIR-1": [{ itemId: "chairs", unitId: null }],
        "CHAIR-2": [{ itemId: "chairs", unitId: null }],
        "CHAIR-3": [{ itemId: "chairs", unitId: null }],
        "CHAIR-4": [{ itemId: "chairs", unitId: null }],
      }),
      lines,
      t,
    );
    assert.deepEqual(
      entries.map((e) => [e.outcome, e.line?.id]),
      [
        ["placed", "u2"],
        ["placed", "u3"],
        ["misplaced", "u1"],
        ["already", "u1"],
      ],
    );
  });

  it("reports a floor sweep as nearby, unless nested", () => {
    const t = campus();
    const lines = [L("a", "delivered", P.r514)];
    const codes = resolved({ A: [{ itemId: "item-a", unitId: null }] });
    assert.equal(match.planSweep(P.l5, ["A"], codes, lines, t)[0]!.outcome, "nearby");
    assert.equal(match.planSweep(P.l5, ["A"], codes, lines, t, { nested: true })[0]!.outcome, "placed");
  });
});

describe("the placement card", () => {
  const L = (id: string, stage: string, shipmentId: string | null, dest: string | null = P.r514) => ({
    id,
    jobId: "job",
    itemId: "item",
    unitId: id.startsWith("u") ? id : null,
    stage,
    shipmentId,
    destinationLocationId: dest,
    lastActualId: null,
  });
  const ref = [{ itemId: "item", unitId: null }];

  it("says where it goes, and catches the wrong truck", () => {
    assert.equal(match.decideCard(ref, [L("a", "delivered", "s1")], "s1").outcome, "ok");
    assert.equal(match.decideCard(ref, [L("a", "delivered", null)], "s1").outcome, "ok");
    assert.equal(match.decideCard(ref, [L("a", "loaded", "s2")], "s1").outcome, "wrong_shipment");
    assert.equal(match.decideCard(ref, [L("a", "loaded", "s2")], null).outcome, "ok");
    assert.equal(match.decideCard(ref, [L("a", "placed", "s1")], "s1").outcome, "already_placed");
    assert.equal(match.decideCard(ref, [L("a", "delivered", "s1", null)], "s1").outcome, "no_destination");
    assert.equal(match.decideCard(ref, [], "s1").outcome, "not_on_job");
    assert.equal(match.decideCard([], [L("a", "delivered", "s1")], "s1").outcome, "unknown");
  });

  it("prefers a unit still to place, on the truck being unloaded", () => {
    const lines = [L("u1", "placed", "s1"), L("u2", "loaded", "s2"), L("u3", "loaded", "s1")];
    const d = match.decideCard(ref, lines, "s1");
    assert.equal(d.outcome, "ok");
    assert.equal(d.line!.id, "u3");
  });
});

describe("placement progress", () => {
  it("counts placed lines and exceptions", () => {
    const t = progress.tally([
      { stage: "placed" },
      { stage: "placed" },
      { stage: "delivered" },
      { stage: "misplaced" },
      { stage: "missing" },
    ]);
    assert.deepEqual(t, { total: 5, placed: 2, remaining: 3, exceptions: { misplaced: 1, missing: 1 }, percent: 40 });
    assert.deepEqual(progress.tally([]), { total: 0, placed: 0, remaining: 0, exceptions: {}, percent: 0 });
    assert.deepEqual(progress.tallyCounts({ placed: 3, pending: 1, misplaced: 0 }), progress.tally([
      { stage: "placed" },
      { stage: "placed" },
      { stage: "placed" },
      { stage: "pending" },
    ]));
  });

  it("groups by floor with the unnamed group last, in building order", () => {
    const groups = progress.tallyBy(
      [
        { stage: "placed", floor: "Level 10" },
        { stage: "pending", floor: null },
        { stage: "placed", floor: "Level 2" },
        { stage: "pending", floor: "Level 2" },
      ],
      (l) => l.floor,
    );
    assert.deepEqual(
      groups.map((g) => [g.key, g.tally.placed, g.tally.total]),
      [
        ["Level 2", 1, 2],
        ["Level 10", 1, 1],
        [null, 0, 1],
      ],
    );
  });

  it("lists what is at risk once its truck is delivered", () => {
    const r = (stage: string, shipmentStatus: string | null) => progress.afterDeliveryReason({ stage, shipmentStatus });
    assert.equal(r("loaded", "delivered"), "not_unloaded");
    assert.equal(r("pending", "closed"), "not_unloaded");
    assert.equal(r("missing", "delivered"), "flagged_missing");
    assert.equal(r("delivered", "delivered"), "not_placed");
    assert.equal(r("placed", "delivered"), null);
    assert.equal(r("damaged", "delivered"), null);
    assert.equal(r("misplaced", "delivered"), null);
    assert.equal(r("loaded", "in_transit"), null);
    assert.equal(r("loaded", null), null);
  });
});

describe("the misplaced stage", () => {
  it("is registered with the jobs core as an exception", () => {
    assert.equal(jobsModel.isExceptionStage("misplaced"), true);
    assert.ok(jobsModel.stageList().some((s) => s.name === "misplaced" && s.kind === "exception"));
  });
});

describe("the kiosk", () => {
  it("says whether each thing goes through this entrance", () => {
    const t = campus();
    const line = (stage: string, dest: string | null) =>
      ({ stage, destinationLocationId: dest }) as unknown as import("../src/services/placement/data").LineView;
    assert.equal(kiosk.kioskOutcome(line("delivered", P.r514), P.l5, t), "this_way");
    assert.equal(kiosk.kioskOutcome(line("delivered", P.r402), P.l5, t), "elsewhere");
    assert.equal(kiosk.kioskOutcome(line("delivered", P.r402), null, t), "info");
    assert.equal(kiosk.kioskOutcome(line("placed", P.r402), P.l5, t), "placed");
    assert.equal(kiosk.kioskOutcome(line("delivered", null), P.l5, t), "no_destination");
    assert.equal(kiosk.kioskOutcome(null, P.l5, t), "not_on_job");
  });
});
