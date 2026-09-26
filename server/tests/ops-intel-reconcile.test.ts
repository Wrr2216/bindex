import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/** The anomaly lifecycle: what a run does with rows already in the table. Pure. */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Reconcile = typeof import("../src/services/ops-intel/reconcile");
type Finding = import("../src/services/ops-intel/rules").Finding;
type Existing = import("../src/services/ops-intel/reconcile").ExistingAnomaly;

let reconcile: Reconcile["reconcile"];

before(async () => {
  ({ reconcile } = await import("../src/services/ops-intel/reconcile"));
});

const T = (m: number) => new Date(Date.UTC(2026, 8, 26, 12, m));

const finding = (key: string, over: Partial<Finding> = {}): Finding => ({
  rule: "not_seen",
  key,
  severity: "medium",
  subjectType: "item",
  subjectId: key,
  itemId: null,
  unitId: null,
  jobId: null,
  shipmentId: null,
  locationId: null,
  title: `Problem ${key}`,
  detail: {},
  link: null,
  sticky: false,
  occurredAt: null,
  ...over,
});

const row = (id: string, key: string, over: Partial<Existing> = {}): Existing => ({
  id,
  rule: "not_seen",
  key,
  sticky: false,
  occurrences: 1,
  occurredAt: null,
  resolvedAt: null,
  resolution: null,
  clearedAt: null,
  ...over,
});

const run = (findings: Finding[], existing: Existing[], rulesRun = ["not_seen"], rulesDisabled: string[] = []) =>
  reconcile({
    findings,
    existing,
    rulesRun: rulesRun as never,
    rulesDisabled: rulesDisabled as never,
  });

describe("reconcile", () => {
  it("opens new problems and refreshes open ones", () => {
    const ops = run([finding("a"), finding("b")], [row("1", "a")]);
    assert.deepEqual(
      ops.insert.map((i) => i.finding.key),
      ["b"],
    );
    assert.deepEqual(
      ops.refresh.map((r) => r.id),
      ["1"],
    );
    assert.equal(ops.clear.length, 0);
  });

  it("clears an open condition that is no longer found", () => {
    const ops = run([], [row("1", "a")]);
    assert.deepEqual(ops.clear, [{ id: "1", rule: "not_seen", reason: "not_found" }]);
  });

  it("keeps a dismissed condition quiet while it lasts, then reports it afresh after it went away", () => {
    const dismissed = row("1", "a", { resolvedAt: T(1), resolution: "dismissed" });
    const still = run([finding("a")], [dismissed]);
    assert.equal(still.insert.length, 0);
    assert.deepEqual(still.touch, ["1"]);

    const gone = run([], [dismissed]);
    assert.deepEqual(gone.markCleared, ["1"]);

    const back = run([finding("a")], [{ ...dismissed, clearedAt: T(2) }]);
    assert.equal(back.insert.length, 1);
    assert.equal(back.insert[0]!.reopenedFrom, "1");
  });

  it("reopens a condition marked fixed that is still there", () => {
    const ops = run([finding("a")], [row("1", "a", { resolvedAt: T(1), resolution: "fixed" })]);
    assert.equal(ops.insert.length, 1);
    assert.equal(ops.insert[0]!.reopenedFrom, "1");
  });

  it("prefers the open row when older resolved rows share its key", () => {
    const ops = run(
      [finding("a")],
      [row("old", "a", { resolvedAt: T(1), resolution: "fixed" }), row("new", "a")],
    );
    assert.equal(ops.insert.length, 0);
    assert.deepEqual(
      ops.refresh.map((r) => r.id),
      ["new"],
    );
  });

  it("closes the open rows of a rule that was switched off, and leaves a failed rule's rows alone", () => {
    const rows = [row("1", "a"), row("2", "b", { rule: "zone_mismatch" })];
    const off = run([], rows, ["not_seen"], ["zone_mismatch"]);
    assert.deepEqual(
      off.clear.map((c) => [c.id, c.reason]).sort(),
      [
        ["1", "not_found"],
        ["2", "rule_disabled"],
      ],
    );

    // zone_mismatch neither ran nor was switched off: its gather failed.
    const failed = run([], rows, ["not_seen"], []);
    assert.deepEqual(
      failed.clear.map((c) => c.id),
      ["1"],
    );
  });

  it("ignores findings of a rule that did not run", () => {
    const ops = run([finding("x", { rule: "zone_mismatch" })], [], ["not_seen"]);
    assert.equal(ops.insert.length, 0);
  });

  describe("sticky events", () => {
    const sticky = (key: string, at: number) =>
      finding(key, { rule: "impossible_travel", sticky: true, occurredAt: T(at) });
    const stickyRow = (id: string, key: string, at: number, over: Partial<Existing> = {}) =>
      row(id, key, { rule: "impossible_travel", sticky: true, occurredAt: T(at), ...over });
    const runSticky = (findings: Finding[], existing: Existing[]) => run(findings, existing, ["impossible_travel"]);

    it("stay open when no longer found", () => {
      assert.equal(runSticky([], [stickyRow("1", "a", 5)]).clear.length, 0);
    });

    it("count a newer occurrence while open, and only move last-seen for the same one", () => {
      const newer = runSticky([sticky("a", 9)], [stickyRow("1", "a", 5)]);
      assert.equal(newer.refresh[0]!.occurrences, 2);
      assert.equal(newer.refresh[0]!.occurredAt?.getTime(), T(9).getTime());
      const same = runSticky([sticky("a", 5)], [stickyRow("1", "a", 5)]);
      assert.deepEqual(same.touch, ["1"]);
      assert.equal(same.refresh.length, 0);
    });

    it("are reported again only for an occurrence after the resolved one", () => {
      const resolved = stickyRow("1", "a", 5, { resolvedAt: T(6), resolution: "dismissed", clearedAt: T(6) });
      assert.equal(runSticky([sticky("a", 5)], [resolved]).insert.length, 0);
      const again = runSticky([sticky("a", 7)], [resolved]);
      assert.equal(again.insert.length, 1);
      assert.equal(again.insert[0]!.reopenedFrom, "1");
    });

    it("keep the latest of several findings for one key in a run", () => {
      const ops = runSticky([sticky("a", 3), sticky("a", 8), sticky("a", 6)], []);
      assert.equal(ops.insert.length, 1);
      assert.equal(ops.insert[0]!.finding.occurredAt?.getTime(), T(8).getTime());
    });
  });
});
