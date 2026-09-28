import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The modules read the environment when they load, so the minimum required
// configuration has to exist first.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Model = typeof import("../src/services/crew/model");
type Timesheet = typeof import("../src/services/crew/timesheet");
let m: Model;
let ts: Timesheet;

before(async () => {
  m = await import("../src/services/crew/model");
  ts = await import("../src/services/crew/timesheet");
});

const TODAY = "2026-09-26";
const forklift = { key: "forklift", name: "Forklift licence", warnDays: 60 };
const induction = { key: "site_induction", name: "Site induction", warnDays: 14 };
const background = { key: "background_check", name: "Background check", warnDays: 30 };

describe("dates", () => {
  it("rejects dates that do not exist", () => {
    assert.equal(m.isDateOnly("2026-02-29"), false);
    assert.equal(m.isDateOnly("2028-02-29"), true);
    assert.equal(m.isDateOnly("2026-13-01"), false);
    assert.equal(m.isDateOnly("26-09-2026"), false);
  });

  it("counts days across months and years", () => {
    assert.equal(m.daysBetween("2026-09-26", "2026-09-26"), 0);
    assert.equal(m.daysBetween("2026-09-26", "2026-10-01"), 5);
    assert.equal(m.daysBetween("2026-12-31", "2027-01-01"), 1);
    assert.equal(m.daysBetween("2026-09-26", "2026-09-20"), -6);
  });

  it("adds months without rolling a short month over", () => {
    assert.equal(m.addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(m.addMonths("2028-01-31", 1), "2028-02-29");
    assert.equal(m.addMonths("2026-09-26", 12), "2027-09-26");
    assert.equal(m.addMonths("2026-11-15", 3), "2027-02-15");
    assert.equal(m.addMonths("2026-09-26", 36), "2029-09-26");
  });

  it("finds the calendar date in the viewer's time zone", () => {
    const at = new Date("2026-09-27T02:30:00Z");
    assert.equal(m.localDate(at, "UTC"), "2026-09-27");
    assert.equal(m.localDate(at, "America/Chicago"), "2026-09-26");
    assert.equal(m.localDate(at, "Pacific/Auckland"), "2026-09-27");
    // An unknown zone falls back to UTC rather than throwing.
    assert.equal(m.localDate(at, "Mars/Olympus"), "2026-09-27");
  });

  it("finds midnight in a zone, including across daylight saving", () => {
    assert.equal(m.zonedMidnight("2026-09-26", "UTC").toISOString(), "2026-09-26T00:00:00.000Z");
    assert.equal(m.zonedMidnight("2026-07-01", "America/New_York").toISOString(), "2026-07-01T04:00:00.000Z");
    assert.equal(m.zonedMidnight("2026-01-15", "America/New_York").toISOString(), "2026-01-15T05:00:00.000Z");
    // The day clocks go forward still starts at local midnight (EST, -05:00).
    assert.equal(m.zonedMidnight("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(m.zonedMidnight("2026-09-26", "Pacific/Auckland").toISOString(), "2026-09-25T12:00:00.000Z");
  });
});

describe("assessCredential", () => {
  const cred = (over: Partial<import("../src/services/crew/model").CredentialFacts>) => ({
    typeKey: "forklift",
    status: "valid" as const,
    expiresOn: null,
    ...over,
  });

  it("is green when valid with no expiry", () => {
    assert.deepEqual(m.assessCredential(cred({}), 30, TODAY), { light: "green", reason: "valid", daysLeft: null });
  });

  it("is green well before expiry and amber inside the warning window", () => {
    assert.equal(m.assessCredential(cred({ expiresOn: "2027-01-01" }), 30, TODAY).light, "green");
    const soon = m.assessCredential(cred({ expiresOn: "2026-10-06" }), 30, TODAY);
    assert.deepEqual(soon, { light: "amber", reason: "expiring", daysLeft: 10 });
    assert.equal(m.describeAssessment(soon, "2026-10-06"), "Expires in 10 days");
  });

  it("is still valid (amber) on the day it expires, and red the day after", () => {
    const onTheDay = m.assessCredential(cred({ expiresOn: TODAY }), 30, TODAY);
    assert.equal(onTheDay.light, "amber");
    assert.equal(m.describeAssessment(onTheDay, TODAY), "Expires today");
    const dayAfter = m.assessCredential(cred({ expiresOn: "2026-09-25" }), 30, TODAY);
    assert.deepEqual(dayAfter, { light: "red", reason: "expired", daysLeft: -1 });
    assert.equal(m.describeAssessment(dayAfter, "2026-09-25"), "Expired yesterday");
  });

  it("treats a zero warning window as no amber at all, except on the last day", () => {
    assert.equal(m.assessCredential(cred({ expiresOn: "2026-09-27" }), 0, TODAY).light, "green");
    assert.equal(m.assessCredential(cred({ expiresOn: TODAY }), 0, TODAY).light, "amber");
  });

  it("is red for anything but valid, whatever the dates say", () => {
    for (const status of ["pending", "expired", "failed", "suspended", "revoked"] as const) {
      const a = m.assessCredential(cred({ status, expiresOn: "2030-01-01" }), 30, TODAY);
      assert.equal(a.light, "red", status);
      assert.equal(a.reason, status);
    }
  });
});

describe("decidingCredential", () => {
  it("prefers a renewal over the expired card it replaced", () => {
    const d = m.decidingCredential(
      [
        { id: "old", typeKey: "forklift", status: "valid", expiresOn: "2026-08-01", issuedOn: "2023-08-01" },
        { id: "new", typeKey: "forklift", status: "valid", expiresOn: "2029-08-01", issuedOn: "2026-08-01" },
      ],
      60,
      TODAY,
    );
    assert.equal(d?.credential.id, "new");
    assert.equal(d?.assessment.light, "green");
  });

  it("prefers the one that lasts longest among equals, and no expiry over any expiry", () => {
    const d = m.decidingCredential(
      [
        { id: "a", typeKey: "osha_10", status: "valid", expiresOn: "2030-01-01" },
        { id: "b", typeKey: "osha_10", status: "valid", expiresOn: null },
      ],
      30,
      TODAY,
    );
    assert.equal(d?.credential.id, "b");
  });

  it("lets a verifier's revocation outvote a paper record", () => {
    const d = m.decidingCredential(
      [
        { id: "paper", typeKey: "background_check", status: "valid", expiresOn: "2027-06-01", source: "manual" },
        { id: "service", typeKey: "background_check", status: "revoked", expiresOn: null, source: "verifier" },
      ],
      30,
      TODAY,
    );
    assert.equal(d?.credential.id, "service");
    assert.equal(d?.assessment.light, "red");
  });

  it("does not let a verifier's pending check hide a valid one", () => {
    const d = m.decidingCredential(
      [
        { id: "paper", typeKey: "background_check", status: "valid", expiresOn: "2027-06-01", source: "manual" },
        { id: "service", typeKey: "background_check", status: "pending", expiresOn: null, source: "verifier" },
      ],
      30,
      TODAY,
    );
    assert.equal(d?.credential.id, "paper");
  });

  it("returns null when there is nothing to choose from", () => {
    assert.equal(m.decidingCredential([], 30, TODAY), null);
  });
});

describe("evaluateCompliance", () => {
  it("is green with a friendly summary when nothing is required", () => {
    const c = m.evaluateCompliance({ required: [], credentials: [], today: TODAY });
    assert.equal(c.light, "green");
    assert.deepEqual(c.checks, []);
    assert.equal(c.summary, "No credentials required");
  });

  it("marks a required credential the worker does not hold as missing and red", () => {
    const c = m.evaluateCompliance({ required: [forklift], credentials: [], today: TODAY });
    assert.equal(c.light, "red");
    assert.equal(c.checks[0]!.reason, "missing");
    assert.equal(c.summary, "Forklift licence missing");
  });

  it("is red when a required credential has expired, and names it", () => {
    const c = m.evaluateCompliance({
      required: [forklift, induction],
      credentials: [
        { id: "f", typeKey: "forklift", status: "valid", expiresOn: "2026-09-23" },
        { id: "i", typeKey: "site_induction", status: "valid", expiresOn: "2027-09-01" },
      ],
      today: TODAY,
    });
    assert.equal(c.light, "red");
    assert.deepEqual(
      c.checks.map((k) => [k.typeKey, k.light, k.reason, k.credentialId]),
      [
        ["forklift", "red", "expired", "f"],
        ["site_induction", "green", "valid", "i"],
      ],
    );
    assert.equal(c.summary, "Forklift licence expired 3 days ago");
  });

  it("takes the worst light: amber when the only problem is an expiry coming up", () => {
    const c = m.evaluateCompliance({
      required: [forklift, induction],
      credentials: [
        { typeKey: "forklift", status: "valid", expiresOn: "2026-11-01" },
        { typeKey: "site_induction", status: "valid", expiresOn: "2027-09-01" },
      ],
      today: TODAY,
    });
    assert.equal(c.light, "amber");
    assert.equal(c.summary, "Forklift licence expires in 36 days");
  });

  it("ignores credentials the job does not ask for", () => {
    const c = m.evaluateCompliance({
      required: [induction],
      credentials: [
        { typeKey: "site_induction", status: "valid", expiresOn: null },
        { typeKey: "forklift", status: "revoked", expiresOn: null },
      ],
      today: TODAY,
    });
    assert.equal(c.light, "green");
    assert.equal(c.checks.length, 1);
  });

  it("judges the same card differently depending on the viewer's day", () => {
    const credentials = [{ typeKey: "forklift", status: "valid" as const, expiresOn: "2026-09-26" }];
    const at = new Date("2026-09-27T02:30:00Z");
    // Still the 26th in Chicago: last valid day. Already the 27th in UTC.
    assert.equal(m.evaluateCompliance({ required: [forklift], credentials, today: m.localDate(at, "America/Chicago") }).light, "amber");
    assert.equal(m.evaluateCompliance({ required: [forklift], credentials, today: m.localDate(at, "UTC") }).light, "red");
  });
});

describe("standing", () => {
  const types = new Map([
    ["forklift", { name: "Forklift licence", warnDays: 60 }],
    ["background_check", { name: "Background check", warnDays: 30 }],
  ]);

  it("is null for someone with nothing on file", () => {
    assert.deepEqual(m.standing([], types, TODAY), { light: null, checks: [] });
  });

  it("is the worst of what they hold, one check per type", () => {
    const s = m.standing(
      [
        { typeKey: "forklift", status: "valid", expiresOn: "2026-10-10" },
        { typeKey: "forklift", status: "valid", expiresOn: "2025-10-10" },
        { typeKey: "background_check", status: "valid", expiresOn: null },
        { typeKey: "retired_type", status: "revoked", expiresOn: null },
      ],
      types,
      TODAY,
    );
    assert.equal(s.light, "amber");
    assert.deepEqual(
      s.checks.map((c) => c.typeKey),
      ["forklift", "background_check"],
    );
  });
});

describe("decideGate", () => {
  const block = { policy: "block" as const, overrideAdminOnly: false };
  const warn = { policy: "warn" as const, overrideAdminOnly: false };
  const member = { isAdmin: false };

  it("lets green and amber through under any policy", () => {
    for (const policy of [block, warn]) {
      assert.deepEqual(m.decideGate({ light: "green" }, policy, member), { allowed: true, overridden: false, warned: false });
      assert.deepEqual(m.decideGate({ light: "amber" }, policy, member), { allowed: true, overridden: false, warned: true });
    }
  });

  it("warns but lets red through under a warning policy", () => {
    assert.deepEqual(m.decideGate({ light: "red" }, warn, member), { allowed: true, overridden: false, warned: true });
  });

  it("blocks red under a blocking policy until someone gives a reason", () => {
    assert.deepEqual(m.decideGate({ light: "red" }, block, member), { allowed: false, reason: "override_required" });
    assert.deepEqual(m.decideGate({ light: "red" }, block, { ...member, reason: "   " }), {
      allowed: false,
      reason: "override_required",
    });
    assert.deepEqual(m.decideGate({ light: "red" }, block, { ...member, reason: "Renewal booked, supervised" }), {
      allowed: true,
      overridden: true,
      warned: true,
    });
  });

  it("keeps the override to administrators when the policy says so", () => {
    const strict = { policy: "block" as const, overrideAdminOnly: true };
    assert.deepEqual(m.decideGate({ light: "red" }, strict, { isAdmin: false, reason: "Please" }), {
      allowed: false,
      reason: "override_admin_only",
    });
    assert.equal(m.decideGate({ light: "red" }, strict, { isAdmin: true, reason: "Site manager approved" }).allowed, true);
  });

  it("blocks and then lets through a badge with an expired required credential (acceptance)", () => {
    const compliance = m.evaluateCompliance({
      required: [background, forklift],
      credentials: [
        { typeKey: "background_check", status: "valid", expiresOn: "2027-05-01" },
        { typeKey: "forklift", status: "valid", expiresOn: "2026-09-01" },
      ],
      today: TODAY,
    });
    assert.equal(compliance.light, "red");
    assert.equal(m.decideGate(compliance, block, member).allowed, false);
    assert.equal(m.decideGate(compliance, warn, member).allowed, true);
    const overridden = m.decideGate(compliance, block, { isAdmin: false, reason: "Not driving today" });
    assert.deepEqual(overridden, { allowed: true, overridden: true, warned: true });
  });
});

describe("normalizePolicy", () => {
  it("falls back to require nothing and warn", () => {
    for (const raw of [undefined, null, "block", 42, []]) {
      assert.deepEqual(m.normalizePolicy(raw), { required: [], policy: "warn", overrideAdminOnly: false });
    }
  });

  it("keeps valid keys once each and only the known policies", () => {
    assert.deepEqual(
      m.normalizePolicy({ required: ["forklift", "forklift", "Bad Key", 7, "site_induction"], policy: "block", overrideAdminOnly: true }),
      { required: ["forklift", "site_induction"], policy: "block", overrideAdminOnly: true },
    );
    assert.equal(m.normalizePolicy({ policy: "deny" }).policy, "warn");
    assert.equal(m.normalizePolicy({ overrideAdminOnly: "yes" }).overrideAdminOnly, false);
  });
});

describe("badgeCodeFromScan", () => {
  it("reads the code out of the link a badge QR carries", () => {
    assert.equal(m.badgeCodeFromScan("https://inv.example.com/crew/badge/CRW-7F3K2A"), "CRW-7F3K2A");
    assert.equal(m.badgeCodeFromScan("https://inv.example.com/crew/badge/CRW-7F3K2A?x=1#y"), "CRW-7F3K2A");
    assert.equal(m.badgeCodeFromScan("http://localhost:3000/crew/badge/HID%2D00412"), "HID-00412");
  });

  it("takes a bare code as it is, trimmed", () => {
    assert.equal(m.badgeCodeFromScan("  004123987 \n"), "004123987");
  });

  it("refuses empty or absurd input", () => {
    assert.equal(m.badgeCodeFromScan("   "), null);
    assert.equal(m.badgeCodeFromScan("x".repeat(201)), null);
  });
});

describe("shiftMinutes", () => {
  const t = (s: string) => new Date(`2026-09-26T${s}:00Z`);

  it("takes the break off a closed shift", () => {
    assert.equal(m.shiftMinutes(t("07:00"), t("15:30"), 30, t("20:00")), 480);
    assert.equal(m.toHours(480), 8);
    assert.equal(m.toHours(125), 2.08);
  });

  it("counts an open shift up to now", () => {
    assert.equal(m.shiftMinutes(t("07:00"), null, 0, t("09:15")), 135);
  });

  it("never goes negative", () => {
    assert.equal(m.shiftMinutes(t("07:00"), t("07:10"), 30, t("09:00")), 0);
  });
});

describe("normalizeVerifierReply", () => {
  const known = new Set(["background_check", "forklift", "dot_medical"]);

  it("reads the documented shape and the common words for a status", () => {
    const r = m.normalizeVerifierReply(
      {
        credentials: [
          { type: "background_check", status: "Clear", expiresOn: "2027-01-31T00:00:00Z", number: 88123 },
          { key: "Forklift", status: "REVOKED", issuer: "  Acme Training  " },
          { credential: "DOT medical", status: "in progress" },
        ],
      },
      known,
    );
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(r.credentials, [
      { typeKey: "background_check", status: "valid", expiresOn: "2027-01-31", issuedOn: null, number: "88123", issuer: null },
      { typeKey: "forklift", status: "revoked", expiresOn: null, issuedOn: null, number: null, issuer: "Acme Training" },
      { typeKey: "dot_medical", status: "pending", expiresOn: null, issuedOn: null, number: null, issuer: null },
    ]);
  });

  it("accepts a bare array and reports types it does not know", () => {
    const r = m.normalizeVerifierReply(
      [
        { type: "forklift", status: "active", expires: "2028-02-02", issued: "2025-02-02" },
        { type: "drug_screen", status: "passed" },
      ],
      known,
    );
    assert.equal(r.credentials.length, 1);
    assert.equal(r.credentials[0]!.issuedOn, "2025-02-02");
    assert.deepEqual(r.unmatched, ["drug_screen"]);
  });

  it("drops entries it cannot read, and keeps the first answer per type", () => {
    const r = m.normalizeVerifierReply(
      {
        credentials: [
          null,
          "forklift",
          { type: "forklift" },
          { type: "forklift", status: "maybe" },
          { type: "forklift", status: "failed", expiresOn: "not a date" },
          { type: "forklift", status: "valid" },
        ],
      },
      known,
    );
    assert.deepEqual(r.credentials, [
      { typeKey: "forklift", status: "failed", expiresOn: null, issuedOn: null, number: null, issuer: null },
    ]);
  });

  it("returns nothing for replies that are not lists at all", () => {
    for (const body of [null, 42, "ok", { ok: true }, { credentials: "none" }]) {
      assert.deepEqual(m.normalizeVerifierReply(body, known), { credentials: [], unmatched: [] });
    }
  });
});

describe("timesheet rollups", () => {
  const row = (over: Partial<import("../src/services/crew/timesheet").TimesheetRow>) => ({
    checkinId: "c",
    day: "2026-09-26",
    jobId: "j1",
    jobCode: "JOB-AAAAAA",
    jobName: "Floor 3",
    workerId: "w1",
    workerName: "Dana Ruiz",
    company: "Acme Movers",
    role: null,
    badgeCode: "CRW-1",
    checkedInAt: new Date("2026-09-26T07:00:00Z"),
    checkedOutAt: new Date("2026-09-26T15:00:00Z") as Date | null,
    breakMinutes: 0,
    minutes: 480,
    open: false,
    compliance: "green" as const,
    overrideReason: null as string | null,
    overriddenByName: null,
    checkedInByName: null,
    checkedOutByName: null,
    via: "scan",
    notes: null,
    ...over,
  });

  it("rolls shifts up to one roster line per worker per job", () => {
    const roster = ts.rosterFromRows([
      row({}),
      row({
        checkinId: "c2",
        day: "2026-09-27",
        checkedInAt: new Date("2026-09-27T07:00:00Z"),
        checkedOutAt: null,
        minutes: 120,
        open: true,
        compliance: "red",
        overrideReason: "Supervised",
      }),
      row({ checkinId: "c3", workerId: "w2", workerName: "Ari Chen", minutes: 60 }),
    ]);
    assert.equal(roster.length, 2);
    const dana = roster.find((r) => r.workerId === "w1")!;
    assert.equal(dana.shifts, 2);
    assert.equal(dana.minutes, 600);
    assert.equal(dana.onSite, true);
    assert.equal(dana.compliance, "red");
    assert.equal(dana.overrides, 1);
    assert.equal(dana.firstIn.toISOString(), "2026-09-26T07:00:00.000Z");
    assert.equal(dana.lastOut?.toISOString(), "2026-09-26T15:00:00.000Z");
    assert.equal(roster[0]!.workerName, "Ari Chen");
  });

  it("adds hours up per worker per day", () => {
    const { days, workers } = ts.hoursByDay([
      row({}),
      row({ checkinId: "c2", minutes: 30 }),
      row({ checkinId: "c3", day: "2026-09-28", minutes: 60 }),
    ]);
    assert.deepEqual(days, ["2026-09-26", "2026-09-28"]);
    assert.equal(workers[0]!.byDay.get("2026-09-26"), 510);
    assert.equal(workers[0]!.minutes, 570);
  });
});
