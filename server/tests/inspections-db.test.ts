import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

/**
 * A full pre/post inspection cycle on a job against a real Postgres, through
 * the service functions the routes call: tasks closing, signatures, the
 * comparison, the PDF, share links and the backup round trip. CI has no
 * database, so this runs only when TEST_DATABASE_URL names a scratch database
 * (it is migrated and written to):
 *
 *   createdb bindex_inspections_test
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_inspections_test \
 *     pnpm --filter bindex-server exec tsx --test tests/inspections-db.test.ts
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "error";

type Insp = typeof import("../src/services/inspections");
type Media = typeof import("../src/services/media-ai-core");
type Jobs = typeof import("../src/services/jobs-core");

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function image(kind: "jpeg" | "png", color: string): Buffer {
  const c = createCanvas(kind === "png" ? 300 : 800, kind === "png" ? 100 : 600);
  const ctx = c.getContext("2d");
  if (kind === "png") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(10, 80);
    ctx.bezierCurveTo(80, 0, 160, 100, 290, 20);
    ctx.stroke();
    return c.toBuffer("image/png");
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 800, 600);
  return c.toBuffer("image/jpeg");
}

describe("inspections against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let insp: Insp;
  let media: Media;
  let jobsCore: Jobs;
  let pool: typeof import("../src/db/client").pool;
  let db: typeof import("../src/db/client").db;
  const tag = `t${Date.now().toString(36)}`;
  const actor = { userOid: "test:inspections", name: "Dana Ruiz" };
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    insp = await import("../src/services/inspections");
    media = await import("../src/services/media-ai-core");
    jobsCore = await import("../src/services/jobs-core");
    ({ pool, db } = await import("../src/db/client"));
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await pool?.end();
  });

  async function signAs(inspectionId: string, role: "facility_contact" | "crew_lead", name: string) {
    const request = await insp.signRequest(inspectionId, role);
    const signature = await media.sign({
      ownerType: "inspection",
      ownerId: inspectionId,
      signerName: name,
      signerRole: role === "facility_contact" ? "Facility contact" : "Crew lead",
      statement: request.statement,
      content: request.content,
      image: image("png", "#111"),
      signedByUser: null,
    });
    return insp.recordSignoff(inspectionId, role, signature.id, actor);
  }

  async function photo(inspectionId: string, color: string) {
    return media.saveAttachment({
      ownerType: "inspection",
      ownerId: inspectionId,
      stage: "finding",
      bytes: image("jpeg", color),
      mime: "image/jpeg",
      createdBy: actor.userOid,
    });
  }

  it("runs a pre/post cycle on a job to a signed report with the comparison", async () => {
    const { createLocation } = await import("../src/services/locations");
    const site = await createLocation({ name: `Old HQ ${tag}`, parentId: null });
    const floor = await createLocation({ name: "Floor 3", parentId: site.id });
    const kitchen = await createLocation({ name: "Kitchen", parentId: floor.id });
    await createLocation({ name: "Boardroom", parentId: floor.id });
    const type = await jobsCore.createJobType({
      name: `Inspected move ${tag}`,
      taskTemplate: [
        { kind: "pre_inspection", title: "Pre-move inspection" },
        { kind: "pack", title: "Pack" },
        { kind: "post_inspection", title: "Post-move inspection" },
      ],
    });
    cleanup.push(() => jobsCore.deleteJobType(type.id));
    const job = await jobsCore.createJob({ name: `Floor 3 move ${tag}`, jobTypeId: type.id, originLocationId: site.id }, actor);
    cleanup.push(() => jobsCore.deleteJob(job.id));
    const taskOf = async (kind: string) => (await jobsCore.listTasks(job.id)).find((t) => t.kind === kind)!;

    // ---- Pre-inspection
    const pre = await insp.createInspection({ kind: "pre", jobId: job.id }, actor);
    cleanup.push(() => insp.deleteInspection(pre.id, { ...actor, isAdmin: true }));
    assert.equal(pre.locationId, site.id, "the job's origin is the site before the move");
    assert.equal(pre.siteName, `Old HQ ${tag}`);
    assert.equal(pre.jobTaskId, (await taskOf("pre_inspection")).id);
    assert.equal((await taskOf("pre_inspection")).status, "doing");
    assert.deepEqual(pre.inspectors, ["Dana Ruiz"]);
    assert.match(pre.code, /^INS-[0-9A-HJKMNP-TV-Z]{6}$/);

    const rooms = await insp.knownRooms(pre);
    assert.ok(rooms.some((r) => r.name === "Floor 3 / Kitchen" && r.locationId === kitchen.id));

    const p1 = await photo(pre.id, "#933");
    const scuff = await insp.addFinding(
      pre.id,
      { area: "inside", locationId: kitchen.id, spot: "wall", description: "Scuff marks by the fridge", severity: "minor", attachmentIds: [p1.id] },
      actor,
    );
    assert.equal(scuff.room, "Floor 3 / Kitchen", "a location's path below the site names the room");
    assert.equal(scuff.preExisting, true);
    await insp.addFinding(pre.id, { room: "Boardroom", spot: "trim", description: "Chipped paint on the door trim" }, actor);
    await assert.rejects(
      insp.addFinding(pre.id, { room: "Hall", spot: "wall", description: "x", attachmentIds: ["00000000-0000-4000-8000-000000000000"] }, actor),
      /not one of this inspection's files/,
    );

    await assert.rejects(insp.signRequest(pre.id, "crew_lead"), /Complete the inspection/);
    const completedPre = await insp.completeInspection(pre.id, actor);
    assert.equal(completedPre.status, "completed");
    assert.equal((await taskOf("pre_inspection")).status, "done");
    assert.equal((await taskOf("post_inspection")).status, "todo", "only the matching task closes");
    await assert.rejects(insp.addFinding(pre.id, { room: "Hall", spot: "wall", description: "Late" }, actor), /Reopen it/);

    await signAs(pre.id, "facility_contact", "Pat Lee");
    const { inspection: signedPre } = await signAs(pre.id, "crew_lead", "Sam Cho");
    assert.equal(signedPre.status, "signed");
    assert.ok(signedPre.signedAt);

    // ---- Post-inspection, compared with the pre-inspection automatically
    const post = await insp.createInspection({ kind: "post", jobId: job.id, locationId: site.id }, actor);
    cleanup.push(() => insp.deleteInspection(post.id, { ...actor, isAdmin: true }));
    assert.equal(post.preInspectionId, pre.id);
    assert.equal(post.jobTaskId, (await taskOf("post_inspection")).id);

    const p2 = await photo(post.id, "#339");
    const worse = await insp.addFinding(
      post.id,
      { locationId: kitchen.id, spot: "wall", description: "Scuff marks by the fridge, now a gouge", severity: "moderate", attachmentIds: [p2.id] },
      actor,
    );
    const p3 = await photo(post.id, "#393");
    const dock = await insp.addFinding(
      post.id,
      { area: "outside", room: "Loading dock", spot: "dock", description: "Dock door panel dented", severity: "major", attachmentIds: [p3.id] },
      actor,
    );
    assert.equal(dock.preExisting, false);

    let { comparison } = await insp.getComparison(post.id);
    assert.deepEqual(comparison!.counts, { new: 1, worsened: 1, resolved: 1, unchanged: 0 });
    assert.equal(comparison!.entries[0]!.post!.id, dock.id, "new damage comes first");

    // A person says the kitchen gouge is new damage after all, then changes their mind.
    await insp.setPairing(post.id, worse.id, { preFindingId: null }, actor);
    ({ comparison } = await insp.getComparison(post.id));
    assert.deepEqual(comparison!.counts, { new: 2, worsened: 0, resolved: 2, unchanged: 0 });
    await insp.setPairing(post.id, worse.id, { auto: true }, actor);
    await assert.rejects(insp.setPairing(post.id, worse.id, { preFindingId: dock.id }, actor), /not on the pre-inspection/);

    const completedPost = await insp.completeInspection(post.id, actor);
    assert.equal(completedPost.status, "completed");
    assert.equal((await taskOf("post_inspection")).status, "done");
    await signAs(post.id, "crew_lead", "Sam Cho");
    const { inspection: signedPost, signatures } = await signAs(post.id, "facility_contact", "Pat Lee");
    assert.equal(signedPost.status, "signed");
    assert.ok(signatures.every((s) => s.verification.valid));

    // ---- The report
    const report = await insp.buildReport(post.id);
    assert.deepEqual(report.comparison!.counts, { new: 1, worsened: 1, resolved: 1, unchanged: 0 });
    assert.ok(report.signoffs.every((s) => s.signature?.valid), "both sign-offs verify");
    assert.equal(report.pre!.code, pre.code);
    const files = insp.reportFileIds(report);
    assert.deepEqual(await insp.reportFileIdsFor(post.id), files, "the cheap lookup agrees with the report");
    assert.ok(files.has(p1.id) && files.has(p2.id) && files.has(p3.id));
    const { pdf } = await insp.inspectionPdf(post.id, "UTC");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    assert.ok((await PDFDocument.load(pdf)).getPageCount() >= 2);

    // ---- Editing after signing is visible
    await insp.reopenInspection(post.id, actor);
    assert.equal((await taskOf("post_inspection")).status, "doing", "reopening reopens the task");
    await insp.updateFinding(post.id, dock.id, { description: "Dock door panel dented and scraped" }, actor);
    const recompleted = await insp.completeInspection(post.id, actor);
    assert.equal(recompleted.status, "completed", "changed since signing, so not signed");
    const stale = await insp.signaturesOf(recompleted);
    assert.ok(stale.every((s) => !s.verification.valid && s.verification.reason === "content_changed"));
    // Putting it back makes the same signatures count again.
    await insp.reopenInspection(post.id, actor);
    await insp.updateFinding(post.id, dock.id, { description: "Dock door panel dented" }, actor);
    assert.equal((await insp.completeInspection(post.id, actor)).status, "signed");

    // ---- Events reached the audit log
    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM audit_log WHERE subject_type = 'inspection' AND subject_id = $1 ORDER BY id`,
      [post.id],
    );
    const types = rows.map((r) => r.type);
    for (const t of ["inspection.created", "inspection.finding_added", "inspection.completed", "inspection.signed", "inspection.reopened"]) {
      assert.ok(types.includes(t), `${t} was published`);
    }

    // ---- Share links
    const share = await insp.createShare(signedPost, 7, actor.userOid);
    assert.ok(share.active && share.token && share.path!.startsWith("/api/share/inspections/"));
    const opened = await insp.openShare(share.token!, { count: true });
    assert.ok(opened.ok);
    assert.equal((await insp.listShares(post.id))[0]!.openCount, 1);
    await insp.revokeShare(post.id, share.id);
    assert.deepEqual(await insp.openShare(share.token!), { ok: false, reason: "revoked" });
    const short = await insp.createShare(signedPost, 1.5 / 86_400, actor.userOid);
    assert.ok((await insp.openShare(short.token!)).ok);
    await sleep(2100);
    assert.deepEqual(await insp.openShare(short.token!), { ok: false, reason: "expired" });

    // ---- Backup round trip of these tables, rolled back
    const { exportInspectionTables, restoreInspectionTables } = await import("../src/services/inspections/backup");
    const exported = JSON.parse(JSON.stringify(await exportInspectionTables())) as Awaited<ReturnType<typeof exportInspectionTables>>;
    for (const row of exported.inspections) {
      for (const k of ["startedAt", "completedAt", "signedAt", "createdAt", "updatedAt"]) if (row[k]) row[k] = new Date(row[k] as string);
    }
    for (const row of exported.inspection_findings) {
      for (const k of ["createdAt", "updatedAt"]) if (row[k]) row[k] = new Date(row[k] as string);
    }
    const ROLLBACK = new Error("rollback");
    await assert.rejects(
      db.transaction(async (tx) => {
        await restoreInspectionTables(tx, exported);
        const back = await tx.execute<{ pre: string | null; shares: number }>(
          `SELECT pre_inspection_id AS pre, (SELECT count(*)::int FROM inspection_shares s WHERE s.inspection_id = i.id) AS shares
             FROM inspections i WHERE id = '${post.id}'` as never,
        );
        assert.equal(back.rows[0]!.pre, pre.id, "the link to the pre-inspection survives");
        assert.equal(back.rows[0]!.shares, 2, "share links are kept");
        throw ROLLBACK;
      }),
      (err) => err === ROLLBACK,
    );

    // ---- Deleting
    await assert.rejects(insp.deleteInspection(post.id, actor), /Only an administrator/);
  });
});
