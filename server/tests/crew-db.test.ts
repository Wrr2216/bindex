import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/**
 * Crew check-in against a real Postgres, through the service functions the
 * routes call, with a scripted external verifier. Opt-in, because CI has no
 * database:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_crew \
 *     pnpm --filter bindex-server test
 *
 * It makes its own uniquely named records and removes them at the end; the
 * seeded credential types are used as they are.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL = "error";

type Crew = typeof import("../src/services/crew");
type Jobs = typeof import("../src/services/jobs-core");

describe("crew check-in against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let crew: Crew;
  let jobs: Jobs;
  let pool: typeof import("../src/db/client").pool;
  let server: http.Server;
  let verifierReply: (body: Record<string, unknown>) => { status: number; json?: unknown } = () => ({ status: 404 });
  const tag = `t${Date.now().toString(36)}`;
  const member = { userOid: "test:crew-member", name: "Crew Tester", isAdmin: false };
  const admin = { userOid: "test:crew-admin", name: "Crew Admin", isAdmin: true };
  const cleanup: (() => Promise<unknown>)[] = [];
  let today = "";

  before(async () => {
    server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        const answer = verifierReply(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.json ?? {}));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.CREDENTIAL_VERIFY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/verify`;

    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    crew = await import("../src/services/crew");
    jobs = await import("../src/services/jobs-core");
    ({ pool } = await import("../src/db/client"));
    today = crew.localDate(new Date(), "UTC");
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch((err) => console.error("cleanup", err));
    server?.closeAllConnections();
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
    await pool?.end();
  });

  const newJobType = async (name: string, policy: Parameters<Crew["setJobTypePolicy"]>[1]) => {
    const type = await jobs.createJobType({ name: `${name} ${tag}` });
    cleanup.push(() => jobs.deleteJobType(type.id));
    await crew.setJobTypePolicy(type.id, policy, admin);
    return type;
  };
  const newJob = async (name: string, jobTypeId: string | null = null) => {
    const job = await jobs.createJob({ name: `${name} ${tag}`, jobTypeId }, member);
    cleanup.push(() => jobs.deleteJob(job.id));
    return job;
  };
  const newWorker = async (name: string, extra: Partial<Parameters<Crew["createWorker"]>[0]> = {}) => {
    const w = await crew.createWorker({ name: `${name} ${tag}`, company: "Acme Movers", ...extra }, member);
    // Hours hold a worker in place, so their check-ins go first.
    cleanup.push(async () => {
      await pool.query("DELETE FROM crew_checkins WHERE worker_id = $1", [w.id]);
      await pool.query("DELETE FROM crew_workers WHERE id = $1", [w.id]);
    });
    return w;
  };
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return err as { status: number; code: string; message: string; details: Record<string, unknown> };
    }
    assert.fail("expected the call to be refused");
  };

  it("blocks a badge with an expired required credential, and records who overrode it and why", async () => {
    const type = await newJobType("Crew gate", { required: ["forklift", "site_induction"], policy: "block" });
    const job = await newJob("Warehouse racking", type.id);
    await jobs.addTask(job.id, { title: "Check the crew in", kind: crew.CREW_TASK_KIND }, member);
    const dana = await newWorker("Dana Ruiz");
    await crew.addCredential(dana.id, { typeKey: "forklift", issuedOn: "2023-01-10", expiresOn: crew.addDays(today, -3) }, member);
    const induction = await crew.addCredential(dana.id, { typeKey: "site_induction", issuedOn: today }, member);
    assert.equal(induction.expiresOn, crew.addMonths(today, 12), "expiry filled in from the type's validity");

    const scan = `https://inventory.example.com/crew/badge/${dana.badgeCode}`;
    const refused = await refusal(crew.checkIn(job.id, { code: scan, via: "scan" }, member));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "credentials_blocked");
    const compliance = refused.details.compliance as { light: string; checks: { typeKey: string; light: string; reason: string }[] };
    assert.equal(compliance.light, "red");
    assert.deepEqual(
      compliance.checks.map((c) => [c.typeKey, c.light, c.reason]),
      [
        ["forklift", "red", "expired"],
        ["site_induction", "green", "valid"],
      ],
    );
    assert.match(refused.message, /Forklift licence expired 3 days ago/);

    const outcome = await crew.checkIn(job.id, { code: scan, via: "scan", overrideReason: "Not operating the forklift today" }, member);
    assert.equal(outcome.status, "checked_in");
    assert.equal(outcome.overridden, true);
    assert.equal(outcome.checkin.compliance, "red");
    assert.equal(outcome.checkin.overrideReason, "Not operating the forklift today");
    assert.equal(outcome.checkin.overriddenBy, member.userOid);
    assert.equal(outcome.checkin.overriddenByName, member.name);
    assert.equal(outcome.checkin.policy, "block");
    assert.equal(outcome.checkin.via, "scan");

    const { rows: events } = await pool.query(
      `SELECT type, actor_id, data FROM audit_log WHERE subject_type = 'job' AND subject_id = $1 AND type LIKE 'crew.%' ORDER BY id`,
      [job.id],
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["crew.check_in_refused", "crew.checked_in", "crew.check_in_overridden"],
    );
    assert.equal(events[2].data.reason, "Not operating the forklift today");
    assert.equal(events[2].actor_id, member.userOid);

    const tasks = await jobs.listTasks(job.id);
    assert.equal(tasks.find((t) => t.kind === crew.CREW_TASK_KIND)?.status, "done");

    const again = await crew.checkIn(job.id, { code: dana.badgeCode.toLowerCase() }, member);
    assert.equal(again.status, "already", "a second scan is not a second shift");

    const roster = await crew.roster(job.id, "UTC");
    assert.equal(roster.onSite.length, 1);
    assert.equal(roster.onSite[0]!.current.light, "red");
    assert.deepEqual(
      roster.required.map((r) => r.key),
      ["forklift", "site_induction"],
    );
  });

  it("only lets an administrator override when the job type says so", async () => {
    const type = await newJobType("Crew strict", { required: ["dot_medical"], policy: "block", overrideAdminOnly: true });
    const job = await newJob("Linehaul", type.id);
    const ari = await newWorker("Ari Chen");
    const refused = await refusal(crew.checkIn(job.id, { workerId: ari.id, overrideReason: "Please" }, member));
    assert.equal(refused.code, "credentials_blocked");
    assert.equal(refused.details.reason, "override_admin_only");
    const ok = await crew.checkIn(job.id, { workerId: ari.id, overrideReason: "Medical booked for Monday" }, admin);
    assert.equal(ok.overridden, true);
    assert.equal(ok.checkin.overriddenBy, admin.userOid);
  });

  it("warns without blocking under a warning policy", async () => {
    const type = await newJobType("Crew warn", { required: ["osha_10"], policy: "warn" });
    const job = await newJob("Office fit-out", type.id);
    const sam = await newWorker("Sam Patel");
    const outcome = await crew.checkIn(job.id, { workerId: sam.id }, member);
    assert.equal(outcome.status, "checked_in");
    assert.equal(outcome.warned, true);
    assert.equal(outcome.overridden, false);
    assert.equal(outcome.checkin.compliance, "red");
    assert.equal(outcome.checkin.overrideReason, null);
  });

  it("keeps a worker on one job at a time, and adds up their hours", async () => {
    const first = await newJob("Floor 3");
    const second = await newJob("Floor 4");
    const lee = await newWorker("Lee Novak");
    await crew.checkIn(first.id, { workerId: lee.id }, member);
    const elsewhere = await refusal(crew.checkIn(second.id, { workerId: lee.id }, member));
    assert.equal(elsewhere.code, "checked_in_elsewhere");
    assert.equal(elsewhere.details.jobId, first.id);

    const moved = await crew.checkIn(second.id, { workerId: lee.id, switchJob: true }, member);
    assert.equal(moved.movedFrom?.jobId, first.id);
    const firstRoster = await crew.roster(first.id, "UTC");
    assert.equal(firstRoster.onSite.length, 0);
    assert.ok(firstRoster.shifts[0]!.checkedOutAt, "the first job's shift was closed");

    const out = await crew.checkOutByCode(second.id, { code: lee.badgeCode }, member);
    assert.ok(out.checkin.checkedOutAt);
    const notIn = await refusal(crew.checkOutByCode(second.id, { code: lee.badgeCode }, member));
    assert.equal(notIn.code, "not_checked_in");

    const yesterday = crew.addDays(today, -1);
    await crew.updateCheckin(
      out.checkin.id,
      { checkedInAt: `${yesterday}T07:00:00Z`, checkedOutAt: `${yesterday}T15:30:00Z`, breakMinutes: 30 },
      member,
    );
    const rows = await crew.timesheetRows({ jobId: second.id, from: yesterday, to: yesterday, tz: "UTC" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.minutes, 480);
    const none = await crew.timesheetRows({ jobId: second.id, from: today, tz: "UTC" });
    assert.equal(none.length, 0);
    const xlsx = await crew.timesheetXlsx({ jobId: second.id, tz: "UTC" }, "Test timesheet");
    assert.equal(xlsx.subarray(0, 2).toString(), "PK");

    const backwards = await refusal(crew.updateCheckin(out.checkin.id, { checkedOutAt: `${yesterday}T06:00:00Z` }, member));
    assert.equal(backwards.status, 400);
    const busy = await refusal(crew.deleteWorker(lee.id, member));
    assert.equal(busy.status, 409);
  });

  it("merges the verifier's answer, and lets its revocation outvote a paper record", async () => {
    const type = await newJobType("Crew screened", { required: ["background_check"], policy: "block" });
    const job = await newJob("Data centre", type.id);
    const kim = await newWorker("Kim Olsen");
    await crew.addCredential(kim.id, { typeKey: "background_check", issuedOn: today }, member);

    let asked: Record<string, unknown> = {};
    verifierReply = (body) => {
      asked = body;
      return { status: 200, json: { credentials: [{ type: "background_check", status: "revoked" }, { type: "unheard_of", status: "ok" }] } };
    };
    const refused = await refusal(crew.checkIn(job.id, { code: kim.badgeCode }, member));
    assert.equal(asked.badgeCode, kim.badgeCode);
    assert.equal(refused.code, "credentials_blocked");
    const v = refused.details.verifier as { ok: boolean; merged: number; unmatched: string[] };
    assert.deepEqual([v.ok, v.merged, v.unmatched], [true, 1, ["unheard_of"]]);

    verifierReply = () => ({ status: 200, json: { credentials: [{ type: "background_check", status: "clear", expiresOn: crew.addDays(today, 365) }] } });
    const ok = await crew.checkIn(job.id, { code: kim.badgeCode }, member);
    assert.equal(ok.compliance.light, "green");
    const detail = await crew.getWorker(kim.id, today);
    const fromVerifier = detail.credentials.filter((c) => c.source === "verifier");
    assert.equal(fromVerifier.length, 1, "one verifier row per worker and type, refreshed in place");
    assert.equal(fromVerifier[0]!.status, "valid");

    const edit = await refusal(crew.updateCredential(fromVerifier[0]!.id, { status: "revoked" }, member));
    assert.equal(edit.status, 400);

    verifierReply = () => ({ status: 500 });
    await crew.checkOut(ok.checkin.id, {}, member);
    const degraded = await crew.checkIn(job.id, { code: kim.badgeCode }, member);
    assert.equal(degraded.status, "checked_in", "a verifier that is down does not stop the door");
    assert.equal(degraded.verifier?.ok, false);
    verifierReply = () => ({ status: 404 });
  });

  it("refuses unknown badges and inactive workers", async () => {
    const job = await newJob("Gate");
    const unknown = await refusal(crew.checkIn(job.id, { code: `NOPE-${tag}` }, member));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.code, "unknown_badge");
    const gone = await newWorker("Former Hand", { active: false });
    const inactive = await refusal(crew.checkIn(job.id, { workerId: gone.id }, member));
    assert.equal(inactive.code, "worker_inactive");

    const taken = await refusal(crew.createWorker({ name: "Copycat", badgeCode: gone.badgeCode.toLowerCase() }, member));
    assert.equal(taken.status, 409, "badge codes are unique without regard to case");
    const reissued = await crew.reissueBadge(gone.id, member);
    assert.notEqual(reissued.badgeCode, gone.badgeCode);
    assert.equal(await crew.findWorkerByBadge(gone.badgeCode), null, "the old badge stops working");
  });

  it("lists workers by standing and gathers credentials that need renewing", async () => {
    const pat = await newWorker("Pat Expiring");
    await crew.addCredential(pat.id, { typeKey: "dot_medical", issuedOn: crew.addDays(today, -700), expiresOn: crew.addDays(today, 10) }, member);
    const { workers } = await crew.listWorkers({ q: tag, light: "amber" }, today);
    assert.ok(workers.some((w) => w.id === pat.id));
    assert.equal(workers.find((w) => w.id === pat.id)?.nextExpiry?.daysLeft, 10);
    const { workers: expiring } = await crew.listWorkers({ q: tag, expiringWithin: 14 }, today);
    assert.ok(expiring.some((w) => w.id === pat.id));
    const { workers: none } = await crew.listWorkers({ q: tag, light: "none" }, today);
    assert.ok(none.every((w) => w.light === null));

    const due = await crew.expiringCredentials(30, today);
    const mine = due.filter((d) => d.workerName.endsWith(tag));
    assert.ok(mine.some((d) => d.workerId === pat.id && d.daysLeft === 10));
    assert.ok(mine.some((d) => d.typeKey === "forklift" && d.daysLeft === -3), "expired ones are in the digest too");
    assert.match(crew.describeExpiring(mine.find((d) => d.workerId === pat.id)!), /DOT medical card expires in 10d/);

    const tables = await crew.exportCrewTables();
    assert.ok(tables.crew_workers.some((w) => w.id === pat.id));
    assert.ok(tables.crew_credential_types.length >= 5);
  });

  it("will not delete a credential type someone holds", async () => {
    const t = await crew.createCredentialType({ name: `Confined space ${tag}` });
    assert.match(t.key, /^confined_space_t/);
    const w = await newWorker("Holder");
    await crew.addCredential(w.id, { typeId: t.id }, member);
    const refused = await refusal(crew.deleteCredentialType(t.id));
    assert.equal(refused.status, 409);
    cleanup.push(async () => {
      await pool.query("DELETE FROM crew_credentials WHERE type_id = $1", [t.id]);
      await crew.deleteCredentialType(t.id);
    });
  });
});
