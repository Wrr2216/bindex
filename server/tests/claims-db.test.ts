import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

/**
 * Claims against a real Postgres, through the service functions the routes
 * call. Opt-in, because CI has no database; it migrates and writes to the
 * database named, so use a scratch one:
 *
 *   createdb bindex_claims_test
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_claims_test \
 *     pnpm --filter bindex-server exec tsx --test tests/claims-db.test.ts
 *
 * The condition, custody and portal features are not part of this branch.
 * Their absence is tested as it is; their presence by creating minimal
 * stand-in tables here, in the test database only, and dropping them after.
 * Where the real tables already exist, the stand-in test is skipped.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-claims-"));

type Claims = typeof import("../src/services/claims");
type Core = typeof import("../src/services/jobs-core");
type Media = typeof import("../src/services/media-ai-core");

const tag = `t${Date.now().toString(36)}`;
const jpeg = (shade: string) => {
  const c = createCanvas(320, 240);
  const ctx = c.getContext("2d");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 320, 240);
  return c.toBuffer("image/jpeg");
};

const statusOf = (code: string | number) => (err: { status?: number; code?: string }) =>
  typeof code === "number" ? err.status === code : err.code === code;

describe("claims against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let claims: Claims;
  let core: Core;
  let media: Media;
  let pool: typeof import("../src/db/client").pool;
  const cleanup: (() => Promise<unknown>)[] = [];

  const reviewerOid = `local:${randomUUID()}`;
  const reporter = { userOid: `local:${randomUUID()}`, name: "Riley Reporter", role: "member" as const };
  const reviewer = { userOid: reviewerOid, name: "Robin Reviewer", role: "member" as const };
  const admin = { userOid: "trusted:owner", name: "Owner", role: "admin" as const };
  const bystander = { userOid: `local:${randomUUID()}`, name: "Bo Bystander", role: "member" as const };
  const crew = { userOid: "test:crew", name: "Crew 3" };

  // Built by the first test, used by the rest.
  let jobId = "";
  let shipmentId = "";
  let vase: { id: string; assetCode: string };
  let lamp: { id: string; assetCode: string };
  let vaseLine = "";
  let lampLine = "";
  let packPhotoId = "";
  let claimId = "";

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    claims = await import("../src/services/claims");
    core = await import("../src/services/jobs-core");
    media = await import("../src/services/media-ai-core");
    ({ pool } = await import("../src/db/client"));
    const { wireJobEvents } = await import("../src/services/integration/jobEvents");
    wireJobEvents();
    await pool.query("INSERT INTO users (oid, email, name, role) VALUES ($1, $2, $3, 'member')", [
      reviewerOid,
      `reviewer-${tag}@example.test`,
      reviewer.name,
    ]);
    cleanup.push(() => pool.query("DELETE FROM users WHERE oid = $1", [reviewerOid]));
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await pool?.end();
  });

  it("shows a damaged line's pack-day photos and condition notes with nothing attached by hand", async () => {
    const { createLocation } = await import("../src/services/locations");
    const { createItem } = await import("../src/services/items");
    const origin = await createLocation({ name: `Origin ${tag}` });
    vase = await createItem({ name: `Vase ${tag}`, locationId: origin.id, valueCents: 25_000 }, null);
    lamp = await createItem({ name: `Lamp ${tag}`, locationId: origin.id, valueCents: 8_000 }, null);

    const job = await core.createJob({ name: `Delivery ${tag}` }, crew);
    jobId = job.id;
    cleanup.push(() => core.deleteJob(job.id));
    const truck = await core.createShipment({ jobId, name: "Truck 1" }, crew);
    shipmentId = truck.id;
    await core.addItemsByCodes(jobId, [vase.assetCode], { shipmentId }, crew);
    await core.addItemsByCodes(jobId, [lamp.assetCode], {}, crew);
    const { lines } = await core.listJobItems(jobId);
    vaseLine = lines.find((l) => l.itemId === vase.id)!.id;
    lampLine = lines.find((l) => l.itemId === lamp.id)!.id;

    // Pack day: a photo on the item, and a note with the pack scan.
    const packPhoto = await media.saveAttachment({
      ownerType: "item",
      ownerId: vase.id,
      stage: "pack",
      caption: "Double-wall carton, corners padded",
      bytes: jpeg("#88aacc"),
      mime: "image/jpeg",
      createdBy: crew.userOid,
    });
    packPhotoId = packPhoto.id;
    await core.advanceStage(jobId, [vase.assetCode, lamp.assetCode], "packed", {
      via: "scan",
      note: "Small chip on the base, noted at pack",
      ...crew,
    });
    await core.advanceStage(jobId, [vase.assetCode], "loaded", { via: "rfid", deviceId: "dock-1", shipmentId, ...crew });
    await core.advanceStage(jobId, [vase.assetCode], "delivered", { via: "scan", ...crew });
    await core.setLineStage(jobId, [vaseLine], "damaged", { via: "manual", note: "Crushed corner on arrival, vase broken", ...crew });
    // Taken at delivery with no stage: placed "after" by its time.
    const arrival = await media.saveAttachment({
      ownerType: "item",
      ownerId: vase.id,
      caption: "As unpacked",
      bytes: jpeg("#cc8844"),
      mime: "image/jpeg",
      createdBy: crew.userOid,
    });

    const candidates = await claims.claimCandidates(jobId);
    assert.equal(candidates[0]!.jobItemId, vaseLine, "the damaged line comes first");
    assert.equal(candidates[0]!.flagged, true);
    assert.equal(candidates[0]!.stageNote, "Crushed corner on arrival, vase broken");
    assert.equal(candidates.find((c) => c.jobItemId === lampLine)!.flagged, false);

    const claim = await claims.createClaim(
      { type: "damage", title: "Vase broken in transit", lines: [{ jobItemId: vaseLine, damageDescription: "Shattered" }] },
      reporter,
    );
    claimId = claim.id;
    cleanup.push(() => pool.query("DELETE FROM claims WHERE id = $1", [claimId]));
    assert.match(claim.code, /^CLM-/);
    assert.equal(claim.status, "draft");
    assert.equal(claim.jobId, jobId, "the job is taken from the line");
    assert.equal(claim.shipmentId, shipmentId, "and so is the shipment");
    assert.equal(claim.lines[0]!.declaredValueCents, 25_000);
    assert.equal(claim.lines[0]!.stage, "damaged");
    assert.equal(claim.lines[0]!.photoCount, 2);
    assert.equal(claim.reporterName, "Riley Reporter");

    const pack = await claims.getEvidence(claimId);
    const line = pack.lines[0]!;
    const shapes = claims.availability(await claims.detectShapes());
    if (!shapes.conditionReports) assert.equal(pack.sources.conditionReports, false);
    if (!shapes.custody) assert.equal(pack.sources.custody, false);
    assert.deepEqual(line.conditionReports, shapes.conditionReports ? line.conditionReports : []);
    assert.deepEqual(line.custody, shapes.custody ? line.custody : []);

    const byId = new Map(line.attachments.map((a) => [a.id, a]));
    assert.equal(byId.get(packPhotoId)?.phase, "before");
    assert.equal(byId.get(arrival.id)?.phase, "after");
    const notes = line.conditionNotes.map((n) => n.text);
    assert.ok(notes.includes("Small chip on the base, noted at pack"));
    assert.ok(notes.includes("Crushed corner on arrival, vase broken"));
    assert.ok(notes.includes("Double-wall carton, corners padded"), "photo captions count as notes");
    assert.deepEqual(
      line.stageHistory.map((h) => h.toStage),
      ["packed", "loaded", "delivered", "damaged"],
    );
    assert.ok(line.stageHistory.every((h) => !Number.isNaN(Date.parse(h.at))));
    assert.equal(line.stageHistory[1]!.deviceId, "dock-1");
    assert.ok(line.trip?.packedAt && line.trip.deliveredAt);
    assert.ok(line.audit.some((a) => a.type === "job.stage_changed"), "audit-log ids of the stage changes");
    assert.ok(line.audit.every((a) => /^[0-9a-f]{64}$/.test(a.hash)));
    assert.equal(pack.claim.shipment?.id, shipmentId);
    assert.ok(pack.timeline.some((t) => t.kind === "stage" && t.label.endsWith("Damaged")));
    assert.match(pack.hash, /^[0-9a-f]{64}$/);

    const { pdf } = await claims.claimPdf(claimId, "America/Chicago");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 5_000, "photos are embedded");
    const { xlsx } = await claims.claimXlsx(claimId, "UTC");
    assert.equal(xlsx.subarray(0, 2).toString(), "PK");
  });

  it("runs the workflow: totals, reviewer rules, SLA and an activity trail linked to the audit log", async () => {
    assert.ok(claimId, "needs the claim from the first test");
    let claim = await claims.getClaim(claimId, reporter);
    await claims.updateLine(claimId, claim.lines[0]!.id, { estimatedCents: 25_000 }, reporter);
    const added = await claims.addLines(claimId, [{ code: lamp.assetCode, estimatedCents: 5_050 }, { code: `NOPE-${tag}` }], reporter);
    assert.equal(added.added, 1);
    assert.deepEqual(added.problems.map((p) => p.input), [`NOPE-${tag}`]);
    claim = added.claim;
    assert.equal(claim.lines[1]!.jobItemId, lampLine, "a scanned item on the claim's job is matched to its manifest line");
    assert.equal(claim.totals.estimatedTotalCents, 30_050);
    assert.equal(claim.estimatedTotalCents, 30_050, "stored on the claim too");
    const again = await claims.addLines(claimId, [{ itemId: lamp.id }], reporter);
    assert.equal(again.alreadyOnClaim, 1);

    await assert.rejects(claims.updateClaim(claimId, { estimatedTotalCents: 1 }, reporter), statusOf(400));

    const before = Date.now();
    claim = await claims.setStatus(claimId, { status: "submitted" }, reporter);
    assert.equal(claim.status, "submitted");
    assert.match(claim.evidenceHash ?? "", /^[0-9a-f]{64}$/);
    const due = claim.slaDueAt!.getTime() - before;
    assert.ok(Math.abs(due - claims.slaHoursFor("damage") * 3600_000) < 60_000);
    assert.equal(claim.sla.state, "running");
    assert.equal((await claims.getEvidence(claimId)).unchangedSinceSubmission, true);

    await assert.rejects(claims.setStatus(claimId, { status: "approved", note: "x" }, admin), statusOf("not_allowed"));
    claim = await claims.setStatus(claimId, { status: "under_review" }, bystander);

    // Nobody assigned: only an administrator decides.
    await assert.rejects(claims.updateLine(claimId, claim.lines[0]!.id, { resolution: "repair" }, bystander), statusOf(403));
    // Members may take an unassigned claim, not hand one to someone else.
    await assert.rejects(claims.assignClaim(claimId, { userOid: reviewerOid }, bystander), statusOf(403));
    await assert.rejects(claims.assignClaim(claimId, { userOid: `local:${randomUUID()}` }, admin), statusOf(400));
    claim = await claims.assignClaim(claimId, { userOid: reviewerOid }, admin);
    assert.equal(claim.assigneeName, reviewer.name);
    assert.equal(claim.viewer.canDecide, true, "an administrator may decide");
    assert.equal((await claims.getClaim(claimId, bystander)).viewer.canDecide, false);
    assert.equal((await claims.getClaim(claimId, reviewer)).viewer.canDecide, true);
    await assert.rejects(claims.assignClaim(claimId, { userOid: bystander.userOid }, bystander), statusOf(403));

    await assert.rejects(
      claims.updateLine(claimId, claim.lines[0]!.id, { resolution: "repair", approvedCents: 1 }, bystander),
      statusOf(403),
    );
    await claims.updateLine(claimId, claim.lines[0]!.id, { resolution: "repair", approvedCents: 20_000 }, reviewer);
    await assert.rejects(claims.setStatus(claimId, { status: "approved", note: "Repair covered" }, reviewer), statusOf("lines_undecided"));
    claim = await claims.updateLine(claimId, claim.lines[1]!.id, { resolution: "deny", approvedCents: 5_050 }, reviewer);
    assert.equal(claim.lines[1]!.approvedCents, 0, "a denied line approves nothing");
    assert.equal(claim.totals.approvedTotalCents, 20_000);

    await assert.rejects(claims.setStatus(claimId, { status: "approved" }, reviewer), statusOf("note_required"));
    claim = await claims.setStatus(claimId, { status: "approved", note: "Repair covered; lamp was fine" }, reviewer);
    assert.equal(claim.status, "approved");
    assert.ok(claim.decidedAt);
    assert.equal(claim.sla.state, "met");
    await assert.rejects(claims.updateLine(claimId, claim.lines[0]!.id, { estimatedCents: 1 }, reviewer), statusOf(400));

    await assert.rejects(claims.setStatus(claimId, { status: "paid", note: "Cheque 1042" }, reporter), statusOf(403));
    claim = await claims.setStatus(claimId, { status: "paid", note: "Cheque 1042", paymentReference: "CHQ-1042" }, reviewer);
    assert.equal(claim.paidTotalCents, 20_000);
    assert.equal(claim.paymentReference, "CHQ-1042");
    claim = await claims.setStatus(claimId, { status: "closed" }, bystander);
    assert.equal(claim.status, "closed");
    await assert.rejects(claims.deleteClaim(claimId, admin), statusOf(400));

    await claims.addComment(claimId, "Customer happy with the repair.", reporter);
    claim = await claims.getClaim(claimId, reporter);
    const kinds = claim.activity.map((a) => a.kind);
    assert.deepEqual(kinds.slice(0, 1), ["created"]);
    assert.ok(kinds.includes("assignment") && kinds.includes("comment") && kinds.includes("lines"));
    assert.deepEqual(
      claim.activity.filter((a) => a.kind === "status").map((a) => a.toStatus),
      ["submitted", "under_review", "approved", "paid", "closed"],
    );
    assert.ok(claim.activity.every((a) => a.auditLogId !== null), "every step points at its audit-log entry");
    const { rows } = await pool.query("SELECT type FROM audit_log WHERE subject_type = 'claim' AND subject_id = $1 ORDER BY id", [claimId]);
    assert.ok(rows.some((r: { type: string }) => r.type === "claim.status_changed"));
  });

  it("keeps incident reports free of money", async () => {
    await assert.rejects(
      claims.createClaim({ type: "incident", title: "Dock plate gave way", estimatedTotalCents: 100 }, reporter),
      statusOf(400),
    );
    await assert.rejects(
      claims.createClaim({ type: "damage", title: "x", category: "near_miss" }, reporter),
      statusOf(400),
    );
    const inc = await claims.createClaim(
      { type: "incident", category: "equipment_failure", title: "Dock plate gave way", description: "No one hurt.", jobId },
      reporter,
    );
    cleanup.push(() => pool.query("DELETE FROM claims WHERE id = $1", [inc.id]));
    assert.match(inc.code, /^INC-/);
    await assert.rejects(claims.updateClaim(inc.id, { type: "damage" }, reporter), statusOf(400));
    await claims.setStatus(inc.id, { status: "submitted" }, reporter);
    const submitted = await claims.getClaim(inc.id);
    const hours = (submitted.slaDueAt!.getTime() - submitted.submittedAt!.getTime()) / 3600_000;
    assert.equal(hours, claims.slaHoursFor("incident"));
    await claims.setStatus(inc.id, { status: "under_review" }, reporter);
    await assert.rejects(claims.setStatus(inc.id, { status: "approved", note: "x" }, admin), statusOf("incident_no_money"));
    const closed = await claims.setStatus(inc.id, { status: "closed", note: "Plate replaced, crews briefed" }, bystander);
    assert.equal(closed.status, "closed");
    assert.equal(closed.sla.state, "met");
    const { pdf } = await claims.claimPdf(inc.id, "UTC");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });

  it("announces a missed deadline once", async () => {
    const late = await claims.createClaim({ type: "delay", title: `Late ${tag}`, estimatedTotalCents: 10_000 }, reporter);
    cleanup.push(() => pool.query("DELETE FROM claims WHERE id = $1", [late.id]));
    await claims.setStatus(late.id, { status: "submitted" }, reporter);
    await pool.query("UPDATE claims SET sla_due_at = now() - interval '1 hour' WHERE id = $1", [late.id]);
    assert.equal((await claims.getClaim(late.id)).sla.state, "overdue");
    const listed = await claims.listClaims({ overdue: true });
    assert.ok(listed.claims.some((c) => c.id === late.id));
    await claims.checkSlaBreaches();
    await claims.checkSlaBreaches();
    const after = await claims.getClaim(late.id);
    assert.ok(after.slaBreachedAt);
    assert.equal(after.activity.filter((a) => a.kind === "sla").length, 1);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE type = 'claim.sla_breached' AND subject_id = $1",
      [late.id],
    );
    assert.equal(rows[0].n, 1);
  });

  it("keeps a line's trip when its job is deleted, from the audit log", async () => {
    const { createItem } = await import("../src/services/items");
    const crate = await createItem({ name: `Crate ${tag}`, valueCents: 1_000 }, null);
    const job = await core.createJob({ name: `Short-lived ${tag}` }, crew);
    await core.addItemsByCodes(job.id, [crate.assetCode], {}, crew);
    await core.advanceStage(job.id, [crate.assetCode], "packed", { via: "scan", note: "Lid split at pack", ...crew });
    await core.advanceStage(job.id, [crate.assetCode], "missing", { via: "manual", ...crew });
    const line = (await core.listJobItems(job.id)).lines[0]!;
    const claim = await claims.createClaim({ type: "loss", title: "Crate lost", lines: [{ jobItemId: line.id }] }, reporter);
    cleanup.push(() => pool.query("DELETE FROM claims WHERE id = $1", [claim.id]));

    await core.deleteJob(job.id);
    const after = await claims.getClaim(claim.id);
    assert.equal(after.jobId, job.id, "the claim still names the job");
    assert.equal(after.lines[0]!.jobItemId, line.id);
    const pack = await claims.getEvidence(claim.id);
    const e = pack.lines[0]!;
    assert.deepEqual(
      e.stageHistory.map((h) => h.toStage),
      ["packed", "missing"],
      "rebuilt from the job.stage_changed events",
    );
    assert.ok(e.trip?.packedAt);
    assert.ok(e.conditionNotes.some((n) => n.text === "Lid split at pack"));
    const { pdf } = await claims.claimPdf(claim.id, "UTC");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });

  it("puts claims in the instance backup", async () => {
    const { buildBackup } = await import("../src/services/backup");
    const backup = await buildBackup();
    assert.ok(backup.counts.claims >= 1);
    assert.ok(backup.data.claim_lines.some((l) => l.claimId === claimId));
  });

  it("reports which optional features it found, and works without them", async () => {
    const exists = async (table: string) =>
      (await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [table])).rows[0].ok as boolean;
    const pack = await claims.getEvidence(claimId);
    assert.equal(pack.sources.conditionReports, await exists("condition_reports"));
    assert.equal(pack.sources.packLists, await exists("container_captures"));
    assert.equal(pack.sources.custody, await exists("custody_transfers"));
    assert.equal(pack.sources.portal, await exists("portal_grants"));
    if (!pack.sources.portal) await assert.rejects(claims.portalView("anything"), statusOf(404));
    if (!pack.sources.custody) assert.ok(pack.lines.every((l) => l.custody.length === 0));
  });

  it("gathers condition reports, pack lists and custody hops from those features' tables", async () => {
    const exists = async (table: string) =>
      (await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [table])).rows[0].ok as boolean;
    // These belong to features that may or may not be merged: their own
    // tables are used when their migrations have run, and stand-ins with the
    // same columns (the ones this feature reads) when they have not.
    const standIns: string[] = [];
    const standIn = async (table: string, ddl: string) => {
      if (await exists(table)) return;
      standIns.unshift(table);
      await pool.query(ddl);
    };
    await standIn(
      "condition_reports",
      `CREATE TABLE condition_reports (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL, unit_id uuid,
         stage text NOT NULL, stage_label text, rating text, notes text, ai_notes text, defects jsonb NOT NULL DEFAULT '[]',
         handling_note text, attachment_ids uuid[] NOT NULL DEFAULT '{}', created_by text,
         created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await standIn(
      "container_captures",
      `CREATE TABLE container_captures (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL, size_class text, handwritten_text text,
         room text, contents_summary text, contents jsonb NOT NULL DEFAULT '[]', flags text[] NOT NULL DEFAULT '{}',
         attachment_ids uuid[] NOT NULL DEFAULT '{}', created_by text, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await standIn(
      "custody_transfers",
      `CREATE TABLE custody_transfers (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, purpose text NOT NULL DEFAULT 'handoff',
         status text NOT NULL DEFAULT 'draft', from_kind text NOT NULL, from_name text NOT NULL, from_org text,
         to_kind text NOT NULL, to_name text NOT NULL, to_org text, at timestamptz, location_name text,
         seal_numbers text[] NOT NULL DEFAULT '{}', condition_note text, content_hash text,
         from_signature_id uuid, to_signature_id uuid, audit_entry_id bigint, completed_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await standIn(
      "custody_transfer_items",
      `CREATE TABLE custody_transfer_items (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transfer_id uuid NOT NULL REFERENCES custody_transfers(id) ON DELETE CASCADE,
         position integer NOT NULL, item_id uuid NOT NULL, unit_id uuid, asset_code text NOT NULL, name text NOT NULL,
         outcome text NOT NULL DEFAULT 'accepted', note text, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    const inserted: [string, string][] = [];
    try {
      const report = await pool.query(
        `INSERT INTO condition_reports (item_id, stage, rating, notes, defects, handling_note, attachment_ids, created_by, created_at)
         VALUES ($1, 'before', 'good', 'Base has a small chip', '[{"area":"base","type":"crack","severity":"minor"}]',
                 'Wrap twice', ARRAY[$2]::uuid[], 'test:crew', now() - interval '2 hours') RETURNING id`,
        [vase.id, packPhotoId],
      );
      inserted.push(["condition_reports", report.rows[0].id]);
      const capture = await pool.query(
        `INSERT INTO container_captures (item_id, size_class, handwritten_text, room, contents, flags, created_by)
         VALUES ($1, 'medium', 'FRAGILE living room', 'Living room',
                 '[{"name":"Vase","qty":1,"condition":"good","fragile":true},{"name":"Candles","qty":4}]', '{fragile}', 'test:crew')
         RETURNING id`,
        [vase.id],
      );
      inserted.push(["container_captures", capture.rows[0].id]);
      const transfer = async (status: string, outcome: string, note: string | null) => {
        const { rows } = await pool.query(
          `INSERT INTO custody_transfers (code, purpose, status, from_kind, from_name, from_org, to_kind, to_name,
                                          at, completed_at, location_name, seal_numbers, condition_note)
           VALUES ($1, 'delivery', $2, 'external', 'Crew 3', 'Acme Movers', 'external', 'Consignee dock',
                   CASE WHEN $2 = 'completed' THEN now() END, CASE WHEN $2 = 'completed' THEN now() END,
                   'Dock 2', '{S-77}', 'Carton dented on hand-off') RETURNING id`,
          [`CUS-${randomBytes(4).toString("hex").toUpperCase()}`, status],
        );
        await pool.query(
          `INSERT INTO custody_transfer_items (transfer_id, position, item_id, asset_code, name, outcome, note)
           VALUES ($1, 1, $2, $3, 'Vase', $4, $5)`,
          [rows[0].id, vase.id, vase.assetCode, outcome, note],
        );
        inserted.push(["custody_transfers", rows[0].id]);
      };
      await transfer("completed", "damaged", "Glass door cracked");
      // Still being scanned: not a hand-over yet, so not evidence.
      await transfer("draft", "accepted", null);

      const pack = await claims.getEvidence(claimId);
      assert.equal(pack.sources.conditionReports, true);
      assert.equal(pack.sources.packLists, true);
      assert.equal(pack.sources.custody, true);
      const line = pack.lines.find((l) => l.itemId === vase.id)!;
      assert.equal(line.conditionReports.length, 1);
      assert.equal(line.conditionReports[0]!.rating, "good");
      assert.equal(line.packLists.length, 1);
      assert.deepEqual(line.packLists[0]!.flags, ["fragile"]);
      assert.equal(line.custody.length, 1, "the draft transfer is left out");
      const hop = line.custody[0]!;
      assert.equal(hop.from, "Crew 3 (Acme Movers)");
      assert.equal(hop.to, "Consignee dock");
      assert.equal(hop.place, "Dock 2");
      assert.deepEqual(hop.sealNumbers, ["S-77"]);
      assert.equal(hop.outcome, "damaged");
      assert.ok(line.conditionNotes.some((n) => n.source === "condition_report" && n.text.includes("Base has a small chip")));
      assert.ok(line.conditionNotes.some((n) => n.source === "pack_list" && n.text.includes('marked "FRAGILE living room"')));
      assert.ok(line.conditionNotes.some((n) => n.source === "custody" && n.text === "Carton dented on hand-off"));
      assert.ok(line.conditionNotes.some((n) => n.source === "custody" && n.text === "Received damaged: Glass door cracked"));
      assert.equal(line.attachments.find((a) => a.id === packPhotoId)?.phase, "before");
      assert.equal(pack.lines.find((l) => l.itemId === lamp.id)!.custody.length, 0, "the lamp was not on that transfer");
      assert.equal(pack.unchangedSinceSubmission, false, "new records since submission change the fingerprint");
      const { pdf } = await claims.claimPdf(claimId, "UTC");
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    } finally {
      for (const [table, id] of inserted) {
        if (!standIns.includes(table)) await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      }
      for (const table of standIns) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it("takes claims through a portal link, limited to what the link was given", async (t) => {
    if ((await pool.query("SELECT to_regclass('portal_grants') IS NOT NULL AS ok")).rows[0].ok) {
      t.skip("the real portal is installed here; its grants are made through its own code");
      return;
    }
    await pool.query(`
      CREATE TABLE portal_grants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, scope_id uuid NOT NULL, role text NOT NULL,
        grantee_name text, grantee_email text, grantee_org text, token_hash text NOT NULL,
        expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz, created_by text)`);
    try {
      const grant = async (over: { scope?: string; scopeId?: string; expires?: string | null; revoked?: boolean } = {}) => {
        const token = randomBytes(24).toString("base64url");
        await pool.query(
          `INSERT INTO portal_grants (scope, scope_id, role, grantee_name, grantee_email, token_hash, expires_at, revoked_at)
           VALUES ($1, $2, 'viewer', 'Pat Consignee', 'pat@example.test', $3, $4, $5)`,
          [
            over.scope ?? "shipment",
            over.scopeId ?? shipmentId,
            claims.hashPortalToken(token),
            over.expires === undefined ? new Date(Date.now() + 3600_000) : over.expires,
            over.revoked ? new Date() : null,
          ],
        );
        return token;
      };
      const token = await grant();
      const view = await claims.portalView(token);
      assert.deepEqual(
        view.lines.map((l) => l.jobItemId),
        [vaseLine],
        "only the granted shipment's lines, not the rest of the job",
      );
      assert.deepEqual(view.claims, []);
      assert.ok(view.types.every((ty) => ty.type !== "incident"));

      await assert.rejects(
        claims.portalFileClaim(token, { type: "damage", description: "Lamp too", lines: [{ jobItemId: lampLine }] }),
        statusOf(400),
      );
      await assert.rejects(claims.portalFileClaim(token, { type: "damage", description: "Nothing picked", lines: [] }), statusOf(400));
      const filed = await claims.portalFileClaim(token, {
        type: "damage",
        description: "The vase arrived in pieces.",
        contactEmail: "pat@example.test",
        lines: [{ jobItemId: vaseLine, damageDescription: "Broken", estimatedCents: 30_000 }],
      });
      assert.equal(filed.status, "submitted");
      assert.equal(filed.estimatedTotalCents, 30_000);
      const listedForGrant = await claims.portalView(token);
      assert.deepEqual(listedForGrant.claims.map((c) => c.code), [filed.code]);
      const { rows } = await pool.query("SELECT id, reporter_grant_id, reporter_name, shipment_id FROM claims WHERE code = $1", [filed.code]);
      cleanup.push(() => pool.query("DELETE FROM claims WHERE id = $1", [rows[0].id]));
      assert.ok(rows[0].reporter_grant_id);
      assert.equal(rows[0].reporter_name, "Pat Consignee");
      assert.equal(rows[0].shipment_id, shipmentId);
      const audit = await pool.query(
        "SELECT actor_kind, actor_id FROM audit_log WHERE type = 'claim.created' AND subject_id = $1",
        [rows[0].id],
      );
      assert.equal(audit.rows[0].actor_kind, "system");
      assert.match(audit.rows[0].actor_id, /^portal-grant:/);

      // A job link sees the whole job; a project link, an expired or a revoked one cannot file.
      const jobView = await claims.portalView(await grant({ scope: "job", scopeId: jobId }));
      assert.deepEqual(jobView.lines.map((l) => l.jobItemId).sort(), [vaseLine, lampLine].sort());
      await assert.rejects(claims.portalView(await grant({ scope: "project", scopeId: randomUUID() })), statusOf(403));
      await assert.rejects(claims.portalView(await grant({ expires: new Date(Date.now() - 1000).toISOString() })), statusOf(410));
      await assert.rejects(claims.portalView(await grant({ revoked: true })), statusOf(410));
      await assert.rejects(claims.portalView("not-a-real-token"), statusOf(404));
    } finally {
      await pool.query("DROP TABLE IF EXISTS portal_grants");
    }
  });
});
