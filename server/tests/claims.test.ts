import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The modules read the environment when they load, so the minimum required
// configuration has to exist first.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Totals = typeof import("../src/services/claims/totals");
type Workflow = typeof import("../src/services/claims/workflow");
type Shared = typeof import("../src/services/claims/shared");
type Trip = typeof import("../src/services/claims/trip");
type Normalize = typeof import("../src/services/claims/normalize");
let totals: Totals;
let wf: Workflow;
let shared: Shared;
let trip: Trip;
let norm: Normalize;

before(async () => {
  totals = await import("../src/services/claims/totals");
  wf = await import("../src/services/claims/workflow");
  shared = await import("../src/services/claims/shared");
  trip = await import("../src/services/claims/trip");
  norm = await import("../src/services/claims/normalize");
});

type Line = { estimatedCents: number | null; approvedCents: number | null; resolution: "repair" | "replace" | "cash" | "deny" | null };
const line = (estimatedCents: number | null, approvedCents: number | null = null, resolution: Line["resolution"] = null): Line => ({
  estimatedCents,
  approvedCents,
  resolution,
});
const noManual = { estimatedTotalCents: null, approvedTotalCents: null };

describe("claim totals", () => {
  it("sums the lines' estimates and approvals", () => {
    const t = totals.claimTotals([line(12_000, 10_000, "repair"), line(50_050, 50_050, "replace")], noManual);
    assert.equal(t.fromLines, true);
    assert.equal(t.estimatedTotalCents, 62_050);
    assert.equal(t.approvedTotalCents, 60_050);
    assert.equal(t.decidedLines, 2);
    assert.equal(t.undecidedLines, 0);
    assert.deepEqual(t.approvedByResolution, { repair: 10_000, replace: 50_050, cash: 0 });
  });

  it("pays nothing for a denied line, whatever amount was typed against it", () => {
    const t = totals.claimTotals([line(10_000, 9_000, "deny"), line(5_000, 4_000, "cash")], noManual);
    assert.equal(t.approvedTotalCents, 4_000);
    assert.equal(t.deniedLines, 1);
    assert.equal(t.decidedLines, 2);
    assert.equal(totals.lineApprovedCents(line(10_000, 9_000, "deny")), 0);
  });

  it("counts a line as decided only with a resolution and, unless denied, an amount", () => {
    assert.equal(totals.isLineDecided(line(100)), false);
    assert.equal(totals.isLineDecided(line(100, 100)), false);
    assert.equal(totals.isLineDecided(line(100, null, "repair")), false);
    assert.equal(totals.isLineDecided(line(100, 80, "repair")), true);
    assert.equal(totals.isLineDecided(line(100, null, "deny")), true);
    const t = totals.claimTotals([line(100, 80, "repair"), line(100, null, "repair"), line(100)], noManual);
    assert.equal(t.undecidedLines, 2);
  });

  it("has no approved total until something is decided", () => {
    const t = totals.claimTotals([line(100), line(200)], noManual);
    assert.equal(t.approvedTotalCents, null);
    assert.equal(t.estimatedTotalCents, 300);
  });

  it("keeps an unpriced claim unpriced rather than calling it zero", () => {
    const t = totals.claimTotals([line(null), line(null)], noManual);
    assert.equal(t.estimatedTotalCents, null);
    assert.equal(t.unestimatedLines, 2);
    const partly = totals.claimTotals([line(null), line(700)], noManual);
    assert.equal(partly.estimatedTotalCents, 700);
    assert.equal(partly.unestimatedLines, 1);
  });

  it("uses the amounts entered on the claim when it has no lines", () => {
    const t = totals.claimTotals([], { estimatedTotalCents: 90_000, approvedTotalCents: 45_000 });
    assert.equal(t.fromLines, false);
    assert.equal(t.estimatedTotalCents, 90_000);
    assert.equal(t.approvedTotalCents, 45_000);
    assert.equal(t.lineCount, 0);
  });

  it("stays exact in cents over many lines", () => {
    const many = Array.from({ length: 1000 }, () => line(1, 1, "cash"));
    const t = totals.claimTotals(many, noManual);
    assert.equal(t.estimatedTotalCents, 1000);
    assert.equal(t.approvedTotalCents, 1000);
  });

  it("zeroes the approved amount when a line is denied", () => {
    assert.deepEqual(totals.normalizeLineDecision(line(100, 90, "deny")), line(100, 0, "deny"));
    assert.deepEqual(totals.normalizeLineDecision(line(100, 90, "repair")), line(100, 90, "repair"));
  });
});

describe("claim transitions", () => {
  const decided = (n: number, ...lines: Line[]) => (lines.length ? totals.claimTotals(lines, noManual) : totals.claimTotals([], { estimatedTotalCents: n, approvedTotalCents: null }));
  const input = (over: Partial<Parameters<Workflow["checkTransition"]>[0]>) => ({
    type: "damage" as const,
    status: "draft" as const,
    to: "submitted" as const,
    note: null,
    totals: decided(0, line(100)),
    ...over,
  });

  it("submits a draft that lists what was damaged", () => {
    const r = wf.checkTransition(input({}));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.transition.action, "Submit");
  });

  it("refuses to submit a loss or damage claim with no items", () => {
    const r = wf.checkTransition(input({ totals: totals.claimTotals([], noManual) }));
    assert.deepEqual(r.ok ? null : r.code, "lines_required");
    // A delay is about a date, not items.
    assert.equal(wf.checkTransition(input({ type: "delay", totals: totals.claimTotals([], noManual) })).ok, true);
  });

  it("refuses moves that are not on the map, and says what is", () => {
    const r = wf.checkTransition(input({ status: "draft", to: "approved", note: "x" }));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "not_allowed");
    assert.match(!r.ok ? r.message : "", /submitted/);
    const same = wf.checkTransition(input({ status: "submitted", to: "submitted" }));
    assert.equal(!same.ok && same.code, "same_status");
  });

  it("wants a written reason for a decision, a return or a reopening", () => {
    for (const [status, to] of [
      ["under_review", "approved"],
      ["under_review", "denied"],
      ["submitted", "draft"],
      ["closed", "under_review"],
      ["approved", "paid"],
      ["draft", "closed"],
    ] as const) {
      const lines = [line(100, 100, "repair")];
      const r = wf.checkTransition(input({ status, to, note: "  ", totals: totals.claimTotals(lines, noManual) }));
      assert.equal(!r.ok && r.code, "note_required", `${status} -> ${to}`);
    }
    for (const [status, to] of [
      ["draft", "submitted"],
      ["submitted", "under_review"],
      ["paid", "closed"],
      ["denied", "closed"],
    ] as const) {
      const r = wf.checkTransition(input({ status, to, note: null }));
      assert.notEqual(!r.ok && r.code, "note_required", `${status} -> ${to}`);
    }
  });

  it("approves only when every line is decided", () => {
    const undecided = wf.checkTransition(
      input({ status: "under_review", to: "approved", note: "ok", totals: totals.claimTotals([line(100, 90, "repair"), line(50)], noManual) }),
    );
    assert.equal(!undecided.ok && undecided.code, "lines_undecided");
    assert.match(!undecided.ok ? undecided.message : "", /1 line has/);
    const ready = wf.checkTransition(
      input({ status: "under_review", to: "approved", note: "ok", totals: totals.claimTotals([line(100, 90, "repair"), line(50, null, "deny")], noManual) }),
    );
    assert.equal(ready.ok, true);
    assert.equal(ready.ok && ready.transition.decision, true);
  });

  it("approves a claim without lines only once an amount is entered", () => {
    const none = wf.checkTransition(
      input({ type: "delay", status: "under_review", to: "approved", note: "ok", totals: totals.claimTotals([], noManual) }),
    );
    assert.equal(!none.ok && none.code, "amount_required");
    const some = wf.checkTransition(
      input({
        type: "delay",
        status: "under_review",
        to: "approved",
        note: "ok",
        totals: totals.claimTotals([], { estimatedTotalCents: 500, approvedTotalCents: 300 }),
      }),
    );
    assert.equal(some.ok, true);
  });

  it("pays only what was approved", () => {
    const zero = wf.checkTransition(
      input({ status: "approved", to: "paid", note: "cheque", totals: totals.claimTotals([line(100, null, "deny")], noManual) }),
    );
    assert.equal(!zero.ok && zero.code, "nothing_to_pay");
    const paid = wf.checkTransition(
      input({ status: "approved", to: "paid", note: "cheque", totals: totals.claimTotals([line(100, 80, "cash")], noManual) }),
    );
    assert.equal(paid.ok, true);
  });

  it("keeps money out of incident reports", () => {
    const r = wf.checkTransition(input({ type: "incident", status: "under_review", to: "approved", note: "x" }));
    assert.equal(!r.ok && r.code, "incident_no_money");
    const moves = wf.transitionsFrom("incident", "under_review").map((t) => t.to);
    assert.deepEqual(moves.sort(), ["closed", "draft"]);
    assert.ok(wf.transitionsFrom("damage", "under_review").some((t) => t.to === "approved"));
    const close = wf.checkTransition(input({ type: "incident", status: "under_review", to: "closed", note: "Fixed the dock plate" }));
    assert.equal(close.ok, true);
  });

  it("offers every status a way forward except none from nowhere", () => {
    for (const s of ["draft", "submitted", "under_review", "approved", "denied", "paid", "closed"] as const) {
      assert.ok(wf.transitionsFrom("damage", s).length > 0, s);
    }
  });
});

describe("the claim clock", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const H = 3600_000;
  const clock = (over: Partial<Parameters<Workflow["transitionStamps"]>[0]> = {}) => ({
    status: "draft" as const,
    submittedAt: null,
    decidedAt: null,
    paidAt: null,
    closedAt: null,
    slaDueAt: null,
    slaBreachedAt: null,
    ...over,
  });

  it("starts on submission with the type's window", () => {
    const s = wf.transitionStamps(clock(), "submitted", now, 72);
    assert.equal(s.submittedAt?.getTime(), now.getTime());
    assert.equal(s.slaDueAt?.getTime(), now.getTime() + 72 * H);
    assert.equal(s.slaBreachedAt, null);
  });

  it("stops on a decision, and on closing a claim nobody decided", () => {
    assert.equal(wf.transitionStamps(clock({ status: "under_review" }), "approved", now, 72).decidedAt, now);
    assert.equal(wf.transitionStamps(clock({ status: "under_review" }), "closed", now, 72).decidedAt, now);
    const earlier = new Date(now.getTime() - H);
    assert.equal(wf.transitionStamps(clock({ status: "paid", decidedAt: earlier }), "closed", now, 72).decidedAt, earlier);
  });

  it("gives a reopened claim a fresh window, and clears it when returned to the reporter", () => {
    const reopened = wf.transitionStamps(clock({ status: "denied", decidedAt: now, submittedAt: now }), "under_review", now, 10);
    assert.equal(reopened.decidedAt, null);
    assert.equal(reopened.slaDueAt?.getTime(), now.getTime() + 10 * H);
    assert.deepEqual(wf.transitionStamps(clock({ status: "submitted", submittedAt: now }), "under_review", now, 10), {});
    const returned = wf.transitionStamps(clock({ status: "submitted", submittedAt: now, slaDueAt: now }), "draft", now, 10);
    assert.equal(returned.submittedAt, null);
    assert.equal(returned.slaDueAt, null);
  });

  it("reads running, due soon, overdue, met and missed", () => {
    const due = (h: number) => new Date(now.getTime() + h * H);
    assert.equal(wf.computeSla({ status: "draft", decidedAt: null, slaDueAt: null }, now).state, "none");
    assert.equal(wf.computeSla({ status: "submitted", decidedAt: null, slaDueAt: due(48) }, now).state, "running");
    assert.equal(wf.computeSla({ status: "under_review", decidedAt: null, slaDueAt: due(5) }, now).state, "due_soon");
    const late = wf.computeSla({ status: "under_review", decidedAt: null, slaDueAt: due(-2) }, now);
    assert.equal(late.state, "overdue");
    assert.equal(late.remainingMs, -2 * H);
    assert.equal(wf.computeSla({ status: "approved", decidedAt: due(-10), slaDueAt: due(-2) }, now).state, "met");
    assert.equal(wf.computeSla({ status: "denied", decidedAt: due(-1), slaDueAt: due(-2) }, now).state, "missed");
  });
});

describe("who decides", () => {
  const claim = { assigneeUserOid: "local:reviewer", reporterUserOid: "local:reporter" };
  it("lets the assigned reviewer and administrators decide", () => {
    assert.equal(shared.decisionRefusal(claim, { userOid: "local:reviewer", name: "R", role: "member" }), null);
    assert.equal(shared.decisionRefusal(claim, { userOid: "local:boss", name: "B", role: "admin" }), null);
  });
  it("refuses everyone else, the reporter included, and portal users", () => {
    assert.match(shared.decisionRefusal(claim, { userOid: "local:other", name: "O", role: "member" }) ?? "", /assigned reviewer/);
    assert.match(
      shared.decisionRefusal({ ...claim, assigneeUserOid: "local:reporter" }, { userOid: "local:reporter", name: "P", role: "member" }) ?? "",
      /you reported/i,
    );
    assert.match(shared.decisionRefusal({ ...claim, assigneeUserOid: null }, { userOid: "local:x", name: "X", role: "member" }) ?? "", /Assign a reviewer/);
    assert.ok(shared.decisionRefusal(claim, { userOid: null, name: "Portal", grantId: "0b5c9f1e-0000-4000-8000-000000000001" }));
  });
  it("codes claims CLM- and incidents INC-", () => {
    assert.match(shared.genClaimCode("damage"), /^CLM-[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.match(shared.genClaimCode("incident"), /^INC-[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});

describe("a line's trip", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h)).toISOString();
  const history = [
    { toStage: "packed", createdAt: at(9) },
    { toStage: "delivered", createdAt: at(15) },
    { toStage: "damaged", createdAt: at(16) },
  ];

  it("takes the first time each rung was reached, counting skipped rungs", () => {
    const t = trip.tripFromHistory(history);
    assert.equal(t.packedAt, at(9));
    // Scanned straight to delivered: loaded is implied at the same moment.
    assert.equal(t.loadedAt, at(15));
    assert.equal(t.deliveredAt, at(15));
    assert.equal(t.placedAt, null);
    assert.deepEqual(t.exceptions, [{ stage: "damaged", at: at(16) }]);
    assert.equal(t.currentStage, "damaged");
  });

  it("orders history it is given out of order", () => {
    const t = trip.tripFromHistory([...history].reverse());
    assert.equal(t.packedAt, at(9));
    assert.equal(t.currentStage, "damaged");
  });

  it("places photos by their stage first, then by when they were taken", () => {
    const t = trip.tripFromHistory([
      { toStage: "packed", createdAt: at(9) },
      { toStage: "loaded", createdAt: at(11) },
      { toStage: "delivered", createdAt: at(15) },
    ]);
    assert.equal(trip.attachmentPhase({ stage: "pack", createdAt: at(20) }, t), "before");
    assert.equal(trip.attachmentPhase({ stage: "Delivery", createdAt: at(1) }, t), "after");
    assert.equal(trip.attachmentPhase({ stage: "in transit", createdAt: at(1) }, t), "during");
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(8) }, t), "before");
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(10) }, t), "before");
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(12) }, t), "during");
    assert.equal(trip.attachmentPhase({ stage: "custom", createdAt: at(15) }, t), "after");
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(12) }, null), "unknown");
  });

  it("treats a photo after a line was flagged damaged as the after picture", () => {
    const t = trip.tripFromHistory([
      { toStage: "packed", createdAt: at(9) },
      { toStage: "damaged", createdAt: at(12) },
    ]);
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(13) }, t), "after");
    assert.equal(trip.attachmentPhase({ stage: null, createdAt: at(10) }, t), "before");
  });

  it("sorts undated notes first, then by time", () => {
    const n = (at: string | null, text: string) => ({ source: "stage" as const, at, stage: null, text, by: null, ref: null });
    assert.deepEqual(
      trip.sortNotes([n(at(12), "b"), n(null, "a"), n(at(9), "c")]).map((x) => x.text),
      ["a", "c", "b"],
    );
  });
});

describe("reading other features' rows", () => {
  const ITEM = "11111111-1111-4111-8111-111111111111";
  const UNIT = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const ID = "44444444-4444-4444-8444-444444444444";
  const ATT = "55555555-5555-4555-8555-555555555555";

  it("normalizes a condition report as its migration would store it", () => {
    const r = norm.normalizeConditionReport({
      id: ID,
      item_id: ITEM,
      unit_id: null,
      stage: "before",
      rating: "good",
      notes: "Light scuff, left door",
      ai_notes: "Minor scratch visible",
      defects: [{ area: "left door", type: "scratch", severity: "minor", description: "2 cm" }, { junk: true }],
      handling_note: "Handle with care",
      attachment_ids: [ATT, ATT, "not-an-id"],
      created_by: "local:crew",
      created_at: "2026-09-20T09:00:00Z",
    });
    assert.ok(r);
    assert.equal(r.itemId, ITEM);
    assert.equal(r.rating, "good");
    assert.equal(r.defects.length, 1);
    assert.deepEqual(r.attachmentIds, [ATT]);
    assert.equal(r.createdAt, "2026-09-20T09:00:00.000Z");
  });

  it("accepts camelCase, JSON strings and attachment objects", () => {
    const r = norm.normalizeConditionReport({
      id: ID.toUpperCase(),
      itemId: ITEM,
      unitId: UNIT,
      defects: JSON.stringify([{ kind: "dent", location: "top" }]),
      attachments: [{ id: ATT }],
      createdAt: "2026-09-20T09:00:00Z",
    });
    assert.ok(r);
    assert.equal(r.id, ID);
    assert.equal(r.unitId, UNIT);
    assert.deepEqual(r.defects, [{ area: "top", type: "dent", severity: null, description: null }]);
    assert.deepEqual(r.attachmentIds, [ATT]);
  });

  it("leaves out a report it cannot identify", () => {
    assert.equal(norm.normalizeConditionReport({ item_id: ITEM }), null);
    assert.equal(norm.normalizeConditionReport({ id: "7" }), null);
  });

  it("reads custody transfers with items as objects, ids or rows of their own", () => {
    const a = norm.normalizeCustodyTransfer({
      id: ID,
      at: "2026-09-20T10:00:00Z",
      from_party: { kind: "user", name: "Dana", org: "Acme Movers" },
      to_party: "Warehouse B",
      items: [{ itemId: ITEM, unitId: UNIT }, { item_id: OTHER }],
      seal_numbers: ["S-1", "S-2"],
      from_signature_id: ATT,
      audit_log_id: "42",
    });
    assert.ok(a);
    assert.equal(a.from, "Dana (Acme Movers)");
    assert.equal(a.to, "Warehouse B");
    assert.deepEqual(a.items, [
      { itemId: ITEM, unitId: UNIT },
      { itemId: OTHER, unitId: null },
    ]);
    assert.deepEqual(a.sealNumbers, ["S-1", "S-2"]);
    assert.deepEqual(a.signatureIds, [ATT]);
    assert.equal(a.auditLogId, 42);

    const b = norm.normalizeCustodyTransfer({ id: ID, item_ids: [ITEM], from_name: "Dock", to_name: "Truck 4" }, [
      { itemId: OTHER, unitId: null },
    ]);
    assert.ok(b);
    assert.equal(b.from, "Dock");
    assert.deepEqual(b.items.map((i) => i.itemId), [ITEM, OTHER]);
    assert.equal(norm.partyLabel('{"name":"Sam"}'), "Sam");
  });

  it("matches a transfer to a line by item, with units covering each other", () => {
    const hop = norm.normalizeCustodyTransfer({ id: ID, items: [{ itemId: ITEM, unitId: UNIT }] })!;
    assert.equal(norm.hopCovers(hop, { itemId: ITEM, unitId: UNIT }), true);
    assert.equal(norm.hopCovers(hop, { itemId: ITEM, unitId: null }), true);
    assert.equal(norm.hopCovers(hop, { itemId: ITEM, unitId: OTHER }), false);
    assert.equal(norm.hopCovers(hop, { itemId: OTHER, unitId: null }), false);
    const whole = norm.normalizeCustodyTransfer({ id: ID, items: [ITEM] })!;
    assert.equal(norm.hopCovers(whole, { itemId: ITEM, unitId: UNIT }), true);
  });

  it("reads portal grants with a scope column or an id column per scope", () => {
    const g = norm.normalizePortalGrant({ id: ID, scope: "shipment", scope_id: OTHER, role: "Viewer", grantee_name: "Pat" })!;
    assert.deepEqual([g.scope, g.scopeId, g.role, g.name], ["shipment", OTHER, "viewer", "Pat"]);
    const perColumn = norm.normalizePortalGrant({ id: ID, scope: "job", job_id: ITEM, project_id: OTHER })!;
    assert.deepEqual([perColumn.scope, perColumn.scopeId], ["job", ITEM]);
    // Without a scope column the narrowest id wins.
    const narrow = norm.normalizePortalGrant({ id: ID, project_id: OTHER, shipment_id: UNIT })!;
    assert.deepEqual([narrow.scope, narrow.scopeId], ["shipment", UNIT]);
  });

  it("refuses revoked, expired and project-wide grants", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const base = norm.normalizePortalGrant({ id: ID, scope: "shipment", scope_id: OTHER })!;
    assert.deepEqual(norm.grantUsable(base, now), { ok: true });
    assert.deepEqual(norm.grantUsable({ ...base, revokedAt: "2026-09-01T00:00:00Z" }, now), { ok: false, reason: "revoked" });
    assert.deepEqual(norm.grantUsable({ ...base, expiresAt: "2026-09-26T11:59:59Z" }, now), { ok: false, reason: "expired" });
    assert.deepEqual(norm.grantUsable({ ...base, expiresAt: "2026-09-27T00:00:00Z" }, now), { ok: true });
    assert.deepEqual(norm.grantUsable({ ...base, scope: "project" }, now), { ok: false, reason: "scope" });
  });
});
