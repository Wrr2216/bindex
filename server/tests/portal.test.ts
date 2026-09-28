import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The modules read the environment when they load.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Tokens = typeof import("../src/services/portal/tokens");
type Policy = typeof import("../src/services/portal/policy");
type Milestones = typeof import("../src/services/portal/milestones");
type Position = typeof import("../src/services/portal/position");
type Handoff = typeof import("../src/services/portal/handoff");
type Scope = typeof import("../src/services/portal/scope");

let tokens: Tokens;
let policy: Policy;
let ms: Milestones;
let position: Position;
let handoff: Handoff;
let scope: Scope;

before(async () => {
  tokens = await import("../src/services/portal/tokens");
  policy = await import("../src/services/portal/policy");
  ms = await import("../src/services/portal/milestones");
  position = await import("../src/services/portal/position");
  handoff = await import("../src/services/portal/handoff");
  scope = await import("../src/services/portal/scope");
});

const SHIP = "5b1e3c9a-0f0e-4f5f-8a31-1f2b3c4d5e6f";
const JOB = "7d0c2a11-9b8e-4c3d-a2f1-0e9d8c7b6a50";
const ITEM = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("link secrets", () => {
  it("makes long random tokens with a recognisable prefix, stored only as a hash", () => {
    const a = tokens.generateToken();
    const b = tokens.generateToken();
    assert.match(a, /^bdxp_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.ok(tokens.looksLikeToken(a));
    assert.equal(tokens.hashSecret(a), tokens.hashSecret(a));
    assert.match(tokens.hashSecret(a), /^[0-9a-f]{64}$/);
    assert.ok(!tokens.hashSecret(a).includes(a.slice(5, 15)));
  });

  it("rejects anything that is not a token before touching the database", () => {
    for (const bad of [null, undefined, 42, "", "bdxp_", "bdxp_short", `bdxs_${"A".repeat(43)}`, `bdxp_${"A".repeat(42)}!`, ` bdxp_${"A".repeat(43)}`]) {
      assert.equal(tokens.looksLikeToken(bad), false, String(bad));
    }
    assert.ok(tokens.looksLikePass(tokens.generatePass()));
    assert.equal(tokens.looksLikePass(tokens.generateToken()), false);
  });

  it("makes six-digit codes, bound to one grant, compared in constant time", () => {
    for (let i = 0; i < 50; i++) assert.match(tokens.generateCode(), /^\d{6}$/);
    const h = tokens.hashCode("g1", "123456");
    assert.notEqual(h, tokens.hashCode("g2", "123456"));
    assert.ok(tokens.codeMatches(h, "g1", "123456"));
    assert.equal(tokens.codeMatches(h, "g2", "123456"), false);
    assert.equal(tokens.codeMatches(h, "g1", "123457"), false);
    assert.equal(tokens.codeMatches("abc", "g1", "123456"), false);
  });

  it("reads a code the way people type it from an email", () => {
    assert.equal(tokens.normalizeCode("123 456"), "123456");
    assert.equal(tokens.normalizeCode("123-456"), "123456");
    assert.equal(tokens.normalizeCode("12345"), null);
    assert.equal(tokens.normalizeCode("12345a"), null);
    assert.equal(tokens.normalizeCode(123456), null);
  });
});

describe("grant policy", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const g = (over: Partial<{ revokedAt: Date | null; expiresAt: Date | null; tokenHash: string | null }>) => ({
    revokedAt: null,
    expiresAt: new Date("2026-10-01T00:00:00Z"),
    tokenHash: "h",
    ...over,
  });

  it("fails closed: revoked, expired, tokenless or malformed grants open nothing", () => {
    assert.equal(policy.grantState(g({}), now), "active");
    assert.equal(policy.grantState(g({ revokedAt: new Date("2026-09-01") }), now), "revoked");
    // Revoked wins even over a missing token or a past expiry.
    assert.equal(policy.grantState(g({ revokedAt: now, tokenHash: null, expiresAt: new Date(0) }), now), "revoked");
    assert.equal(policy.grantState(g({ tokenHash: null }), now), "no_link");
    assert.equal(policy.grantState(g({ expiresAt: now }), now), "expired", "expiry is exclusive");
    assert.equal(policy.grantState(g({ expiresAt: new Date(now.getTime() - 1) }), now), "expired");
    assert.equal(policy.grantState(g({ expiresAt: null }), now), "expired");
    assert.equal(policy.grantState(g({ expiresAt: new Date("nonsense") }), now), "expired");
  });

  it("lets crews work a job or a shipment, never a whole project", () => {
    assert.ok(policy.roleAllowedForScope("viewer", "project"));
    assert.ok(policy.roleAllowedForScope("contributor", "job"));
    assert.ok(policy.roleAllowedForScope("contributor", "shipment"));
    assert.equal(policy.roleAllowedForScope("contributor", "project"), false);
  });

  it("gives contributors a stage list without pending, trimmed to stages that exist", () => {
    const known = new Set(["pending", "packed", "loaded", "delivered", "placed", "damaged", "missing", "wrong_shipment"]);
    const isStage = (s: string) => known.has(s);
    assert.deepEqual(policy.contributorStages("viewer", null, isStage), []);
    assert.deepEqual(policy.contributorStages("contributor", null, isStage), [...policy.DEFAULT_CONTRIBUTOR_STAGES]);
    assert.deepEqual(policy.contributorStages("contributor", [], isStage), [...policy.DEFAULT_CONTRIBUTOR_STAGES]);
    assert.deepEqual(policy.contributorStages("contributor", ["delivered", "pending", "bogus", "delivered"], isStage), ["delivered"]);
  });

  it("refuses combinations that cannot work, with a message that says what to do", () => {
    const base = { scope: "shipment" as const, role: "viewer" as const, granteeEmail: null, requireCode: false, notify: false };
    assert.equal(policy.grantShapeProblem(base, false), null);
    assert.match(policy.grantShapeProblem({ ...base, scope: "project", role: "contributor" }, true)!, /one job or one shipment/);
    assert.match(policy.grantShapeProblem({ ...base, requireCode: true }, true)!, /email address/);
    assert.match(policy.grantShapeProblem({ ...base, requireCode: true, granteeEmail: "a@b.c" }, false)!, /SMTP_URL/);
    assert.equal(policy.grantShapeProblem({ ...base, requireCode: true, granteeEmail: "a@b.c" }, true), null);
    assert.match(policy.grantShapeProblem({ ...base, notify: true }, true)!, /email address/);
  });

  it("keeps expiries in the future and within the maximum", () => {
    const day = 86_400_000;
    assert.equal(policy.expiryProblem(new Date(now.getTime() + day), now), null);
    assert.match(policy.expiryProblem(now, now)!, /future/);
    assert.match(policy.expiryProblem(new Date(now.getTime() + (policy.MAX_EXPIRY_DAYS + 1) * day), now)!, /at most/);
    assert.match(policy.expiryProblem(new Date("x"), now)!, /expiry/);
  });

  it("never lets a pass outlive its link", () => {
    const soon = new Date(now.getTime() + 3_600_000);
    assert.equal(policy.passExpiry(soon, now).getTime(), soon.getTime());
    const far = new Date(now.getTime() + 365 * 86_400_000);
    assert.equal(policy.passExpiry(far, now).getTime(), now.getTime() + policy.PASS_DAYS * 86_400_000);
  });

  it("masks email addresses and names the grant as the actor", () => {
    assert.equal(policy.maskEmail("dana@example.com"), "d***@example.com");
    assert.equal(policy.maskEmail(null), null);
    assert.equal(policy.maskEmail("nonsense"), "***");
    assert.equal(policy.portalActorName({ granteeName: "Dana", granteeOrg: "Fast Movers" }), "Dana, Fast Movers (portal)");
    assert.deepEqual(policy.portalActor({ id: "g1", granteeName: "Dana", granteeOrg: null }), {
      kind: "system",
      id: "portal:g1",
      name: "Dana (portal)",
    });
  });

  it("flags high value from the threshold, and never with a threshold of zero", () => {
    assert.equal(policy.highValueCents(1000), 100_000);
    assert.ok(policy.isHighValue(100_000, 100_000));
    assert.equal(policy.isHighValue(99_999, 100_000), false);
    assert.equal(policy.isHighValue(null, 100_000), false);
    assert.equal(policy.isHighValue(10_000_000, 0), false);
  });

  it("shows only condition-type photo stages, never labels", () => {
    assert.ok(policy.isPhotoStage("condition"));
    assert.ok(policy.isPhotoStage("damage"));
    assert.equal(policy.isPhotoStage("label"), false);
    assert.equal(policy.isPhotoStage(""), false);
  });
});

describe("scope conditions", () => {
  it("selects lines by shipment, job or the project's jobs", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const d = new PgDialect();
    const s = d.sqlToQuery(scope.lineScope("shipment", SHIP));
    assert.match(s.sql, /"job_items"\."shipment_id" = \$1/);
    assert.deepEqual(s.params, [SHIP]);
    const j = d.sqlToQuery(scope.lineScope("job", JOB));
    assert.match(j.sql, /"job_items"\."job_id" = \$1/);
    const p = d.sqlToQuery(scope.lineScope("project", JOB));
    assert.match(p.sql, /"job_items"\."job_id" IN \(SELECT "jobs"\."id" FROM "jobs" WHERE "jobs"\."project_id" = \$1\)/);
    assert.deepEqual(p.params, [JOB]);
  });

  it("finds the granted record's id", () => {
    const base = { projectId: null, jobId: null, shipmentId: null };
    assert.equal(scope.grantTarget({ ...base, scope: "shipment", shipmentId: SHIP }), SHIP);
    assert.equal(scope.grantTarget({ ...base, scope: "job", jobId: JOB }), JOB);
    // A mismatched row points at nothing, so it opens nothing.
    assert.equal(scope.grantTarget({ ...base, scope: "project", jobId: JOB }), null);
  });
});

describe("milestones", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 8, 26, h));
  const reached = (packed: number, loaded: number, delivered: number, placed: number) => ({ packed, loaded, delivered, placed });

  it("runs created, packed, loaded, in transit, arrived, delivered, placed", () => {
    const m = ms.buildMilestones({
      createdAt: t(1),
      progress: { total: 4, exceptions: 0, reached: reached(4, 2, 0, 0) },
      stepTimes: { packed: { first: t(2), last: t(3) }, loaded: { first: t(4), last: t(5) } },
      shipments: [{ departedAt: null, arrivedAt: null }],
    });
    assert.deepEqual(
      m.map((x) => [x.key, x.state]),
      [
        ["created", "done"],
        ["packed", "done"],
        ["loaded", "current"],
        ["in_transit", "upcoming"],
        ["arrived", "upcoming"],
        ["delivered", "upcoming"],
        ["placed", "upcoming"],
      ],
    );
    assert.equal(m[1]!.at, t(3).toISOString(), "a done step shows when the last line got there");
    assert.equal(m[2]!.at, t(4).toISOString(), "a step in progress shows when it started");
    assert.equal(m[2]!.detail, "2 of 4");
  });

  it("does not let missing or damaged lines hold a milestone back", () => {
    const m = ms.buildMilestones({
      createdAt: t(1),
      progress: { total: 3, exceptions: 1, reached: reached(2, 2, 2, 2) },
      stepTimes: {},
      shipments: [],
    });
    assert.deepEqual(m.map((x) => x.key), ["created", "packed", "loaded", "delivered", "placed"], "no transport leg without shipments");
    assert.ok(m.every((x) => x.state === "done"));
  });

  it("counts shipments for the transport steps, and a skipped step as done", () => {
    const m = ms.buildMilestones({
      createdAt: t(1),
      progress: { total: 2, exceptions: 0, reached: reached(2, 2, 2, 0) },
      stepTimes: {},
      shipments: [
        { departedAt: t(6), arrivedAt: null },
        { departedAt: null, arrivedAt: null },
      ],
    });
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    // Everything delivered, so the trucks must have gone: done, with no time claimed.
    assert.equal(byKey.in_transit!.state, "done");
    assert.equal(byKey.in_transit!.detail, "1 of 2 shipments");
    assert.equal(byKey.arrived!.state, "done");
    assert.equal(byKey.placed!.state, "upcoming");
  });

  it("shows the latest arrival at a key location while a shipment is on its way", () => {
    const m = ms.buildMilestones({
      createdAt: t(1),
      progress: { total: 1, exceptions: 0, reached: reached(1, 1, 0, 0) },
      stepTimes: {},
      shipments: [{ departedAt: t(2), arrivedAt: null }],
      lastArrival: { at: t(3), label: "Depot North" },
    });
    const arrived = m.find((x) => x.key === "arrived")!;
    assert.deepEqual([arrived.state, arrived.detail, arrived.at], ["current", "At Depot North", t(3).toISOString()]);
  });

  const ev = (type: string, subject: { type: string; id: string } | null, data: Record<string, unknown>) => ({
    id: 1,
    type,
    occurredAt: t(5),
    subject,
    data,
  });

  it("announces departures, deliveries and completed jobs, and nothing else", () => {
    const dep = ms.noticeFromEvent(ev("shipment.status_changed", { type: "shipment", id: SHIP }, { to: "in_transit", jobId: JOB, code: "SHP-7F3K2A", name: "Truck 1" }))!;
    assert.deepEqual(dep, { key: `shipment:${SHIP}:departed`, title: "Truck 1 (SHP-7F3K2A) is on its way", shipmentId: SHIP, jobId: JOB, itemId: null });
    assert.equal(ms.noticeFromEvent(ev("shipment.status_changed", { type: "shipment", id: SHIP }, { to: "delivered" }))!.key, `shipment:${SHIP}:delivered`);
    assert.equal(ms.noticeFromEvent(ev("shipment.status_changed", { type: "shipment", id: SHIP }, { to: "loaded" })), null);
    assert.equal(ms.noticeFromEvent(ev("shipment.status_changed", null, { to: "in_transit" })), null);
    const done = ms.noticeFromEvent(ev("job.updated", { type: "job", id: JOB }, { status: "completed", previousStatus: "in_progress", code: "JOB-1", name: "Move" }))!;
    assert.equal(done.title, "Move (JOB-1) is complete");
    assert.equal(ms.noticeFromEvent(ev("job.updated", { type: "job", id: JOB }, { status: "completed", previousStatus: "completed" })), null);
    assert.equal(ms.noticeFromEvent(ev("job.stage_changed", { type: "job", id: JOB }, {})), null);
    assert.equal(ms.noticeFromEvent(ev("item.updated", { type: "item", id: ITEM }, {})), null);
  });

  it("reads geofence events loosely, from a GPS feature it does not import", () => {
    const a = ms.noticeFromEvent(ev("geofence.entered", null, { shipmentId: SHIP, geofenceName: "Depot North", code: "SHP-1", name: "Truck 1" }))!;
    assert.equal(a.title, "Truck 1 (SHP-1) arrived at Depot North");
    assert.equal(a.key, `geofence:depot north:${SHIP}:arrived`);
    const b = ms.noticeFromEvent(ev("geofence.exited", { type: "shipment", id: SHIP.toUpperCase() }, { geofence: { id: JOB, name: "Origin" } }))!;
    assert.equal(b.key, `geofence:${JOB}:${SHIP}:left`);
    assert.equal(b.title, "Your shipment left Origin");
    const c = ms.noticeFromEvent(ev("geofence.arrived", { type: "item", id: ITEM }, { locationName: "Site B" }))!;
    assert.deepEqual([c.itemId, c.shipmentId, c.jobId], [ITEM, null, null]);
    assert.equal(ms.noticeFromEvent(ev("geofence.dwell", null, { shipmentId: SHIP })), null);
    assert.equal(ms.noticeFromEvent(ev("geofence.entered", null, { shipmentId: "not-a-uuid" })), null);
  });

  it("throttles by the interval since the last email", () => {
    const now = t(10);
    assert.ok(ms.dueToSend(null, now, 15));
    assert.equal(ms.dueToSend(new Date(now.getTime() - 14 * 60_000), now, 15), false);
    assert.ok(ms.dueToSend(new Date(now.getTime() - 15 * 60_000), now, 15));
    assert.ok(ms.dueToSend(now, now, 0));
  });

  it("writes plain emails without line breaks in the subject and without a link", () => {
    const one = ms.composeMilestoneEmail({
      appName: "Bindex",
      orgName: "Acme",
      granteeName: "Dana\r\nBcc: x@y.z",
      scopeLabel: "Truck 1 (SHP-1)",
      milestones: [{ title: "Truck 1\nis on its way", occurredAt: t(5) }],
    });
    assert.equal(one.subject, "Acme: Truck 1 is on its way");
    assert.ok(!one.text.includes("\r"));
    assert.ok(one.text.includes("Hello Dana Bcc: x@y.z,"));
    assert.ok(one.text.includes("2026-09-26 05:00 UTC"));
    const two = ms.composeMilestoneEmail({
      appName: "Bindex",
      orgName: "",
      granteeName: "Dana",
      scopeLabel: "Truck 1 (SHP-1)",
      milestones: [
        { title: "Later", occurredAt: t(6) },
        { title: "Earlier", occurredAt: t(5) },
      ],
    });
    assert.equal(two.subject, "Bindex: 2 updates on Truck 1 (SHP-1)");
    assert.ok(two.text.indexOf("Earlier") < two.text.indexOf("Later"));
    const code = ms.composeCodeEmail({ appName: "Bindex", orgName: "", code: "012345" });
    assert.match(code.text, /Your code is 012345\./);
  });
});

describe("last known position", () => {
  it("reads a fix from shipment metadata in the shapes a GPS feature might use", () => {
    const at = "2026-09-26T10:00:00.000Z";
    assert.deepEqual(position.positionFromMetadata({ gps: { lat: 51.5, lng: -0.12, at } }), {
      lat: 51.5,
      lng: -0.12,
      place: null,
      at,
      source: "gps",
    });
    assert.equal(position.positionFromMetadata({ gps: { last: { latitude: 1, longitude: 2, observedAt: at, label: "M4" } } })!.place, "M4");
    assert.equal(position.positionFromMetadata({ gps: { position: { lat: 1, lon: 2, updatedAt: at } } })!.lng, 2);
  });

  it("ignores fixes that are missing, out of range or undated", () => {
    assert.equal(position.positionFromMetadata(null), null);
    assert.equal(position.positionFromMetadata({}), null);
    assert.equal(position.positionFromMetadata({ gps: "x" }), null);
    assert.equal(position.positionFromMetadata({ gps: { lat: 91, lng: 0, at: "2026-09-26" } }), null);
    assert.equal(position.positionFromMetadata({ gps: { lat: 1, lng: 2 } }), null);
    assert.equal(position.positionFromMetadata({ gps: { lat: "1", lng: 2, at: "2026-09-26" } }), null);
  });

  it("prefers the newer of two positions", () => {
    const a = { lat: 1, lng: 1, place: null, at: "2026-09-26T10:00:00Z", source: "gps" as const };
    const b = { lat: null, lng: null, place: "Dock 3", at: "2026-09-26T11:00:00Z", source: "tracking" as const };
    assert.equal(position.newestPosition(a, b), b);
    assert.equal(position.newestPosition(a, null), a);
    assert.equal(position.newestPosition(null, null), null);
  });
});

describe("handoff content", () => {
  const input = {
    grant: { id: "g1", granteeName: "Dana", granteeOrg: "Fast Movers" },
    owner: { kind: "shipment" as const, id: SHIP, code: "SHP-1", name: "Truck 1" },
    lines: [
      { id: "b", code: "INV-2", name: "Desk", stage: "delivered" },
      { id: "a", code: "INV-1", name: "Chair", stage: "damaged" },
    ],
  };

  it("is the same whatever order the lines come in, so it can be verified", () => {
    const one = handoff.handoffContent(input);
    const two = handoff.handoffContent({ ...input, lines: [...input.lines].reverse() });
    assert.deepEqual(one, two);
    assert.deepEqual(one.lines.map((l) => l.id), ["a", "b"]);
    assert.deepEqual(one.byStage, { damaged: 1, delivered: 1 });
    assert.equal(one.count, 2);
    assert.equal(one.grant.id, "g1");
  });

  it("accepts only an image data URL as the drawn signature", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    assert.ok(handoff.signatureImage(png)!.length > 0);
    assert.equal(handoff.signatureImage("data:image/svg+xml;base64,PHN2Zz4="), null);
    assert.equal(handoff.signatureImage("data:text/html;base64,PGh0bWw+"), null);
    assert.equal(handoff.signatureImage(""), null);
    assert.equal(handoff.signatureImage(null), null);
  });
});
