import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * The custody acceptance flow against a real Postgres, through the service
 * functions the routes call. Opt-in, because CI has no database:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_custody \
 *     pnpm --filter bindex-server test
 *
 * It switches the custody and jobs features on in that database, creates its
 * own uniquely named records, and removes its jobs at the end.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

// A 1x1 transparent PNG, standing in for a drawn signature.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("custody against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let custody: typeof import("../src/services/custody");
  let core: typeof import("../src/services/jobs-core");
  let pool: typeof import("../src/db/client").pool;
  let createItem: typeof import("../src/services/items").createItem;
  let createLocation: typeof import("../src/services/locations").createLocation;
  const tag = `c${Date.now().toString(36)}`;
  const actor = { userOid: "test:custody", name: "Custody test" };
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    custody = await import("../src/services/custody");
    core = await import("../src/services/jobs-core");
    ({ pool } = await import("../src/db/client"));
    ({ createItem } = await import("../src/services/items"));
    ({ createLocation } = await import("../src/services/locations"));
    const { updateConfig } = await import("../src/services/config");
    await updateConfig({ features: { custody: true, jobs: true } });
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await pool?.end();
  });

  const sign = (id: string, party: "from" | "to", name: string, extra: { expectedCount?: number } = {}) =>
    custody.signTransfer(id, party, { signerName: name, image: PNG }, { via: "device", capturedBy: actor.userOid, ...extra });

  it("blocks delivering a controlled container until a delivery is signed, then verifies the receipt", async () => {
    const site = await createLocation({ name: `Records ${tag}` });
    const box = await createItem({ name: `Archive box ${tag}`, locationId: site.id }, null);
    const folder = await createItem({ name: "HR files 2019", parentItemId: box.id }, null);
    await createItem({ name: "Payroll 2019", parentItemId: box.id }, null);
    const chair = await createItem({ name: `Chair ${tag}`, locationId: site.id }, null);

    await custody.setControl(box.id, true, "Personnel records", actor);
    const controls = await custody.controlsFor([box.id, folder.id, chair.id]);
    assert.deepEqual(controls.get(box.id), { assetCode: box.assetCode, container: null });
    assert.deepEqual(controls.get(folder.id), { assetCode: folder.assetCode, container: box.assetCode });
    assert.equal(controls.has(chair.id), false);

    const job = await core.createJob({ name: `Records move ${tag}` }, actor);
    cleanup.push(() => core.deleteJob(job.id));
    const truck = await core.createShipment({ jobId: job.id, name: "Truck 7", carrier: "Acme Haulage", sealNumbers: ["SEAL-1"] }, actor);
    await core.addItemsByCodes(job.id, [box.assetCode, folder.assetCode, chair.assetCode], { shipmentId: truck.id }, actor);
    const codes = [box.assetCode, folder.assetCode, chair.assetCode];
    await core.advanceStage(job.id, codes, "loaded", { via: "scan", shipmentId: truck.id, ...actor });

    // Delivering without a transfer: the container and the folder in it are refused, the chair is not.
    const early = await core.advanceStage(job.id, codes, "delivered", { via: "scan", ...actor });
    assert.deepEqual(early.advanced.map((l) => l.itemId), [chair.id]);
    assert.deepEqual(new Set(early.blocked.map((l) => l.itemId)), new Set([box.id, folder.id]));
    assert.match(early.blocked.find((b) => b.itemId === folder.id)!.reason, new RegExp(`travels in ${box.assetCode}`));
    // Overriding does not lift custody.
    const forced = await core.advanceStage(job.id, [box.assetCode], "placed", { via: "manual", force: true, ...actor });
    assert.equal(forced.blocked.length, 1);

    // A pickup handoff: scan the box (its contents come with it), confirm the count, both sign.
    const pickup = await custody.createTransfer(
      {
        purpose: "pickup",
        from: { kind: "external", name: "Dana Ruiz", org: "Records office" },
        to: { kind: "external", name: "Crew 3", org: "Acme Haulage" },
        locationId: site.id,
        jobId: job.id,
        sealNumbers: [" SEAL-1 ", "SEAL-1", "SEAL-2"],
      },
      actor,
    );
    assert.deepEqual(pickup.sealNumbers, ["SEAL-1", "SEAL-2"]);
    const scanned = await custody.scanIntoTransfer(pickup.id, [box.assetCode, box.assetCode, `NOPE-${tag}`]);
    assert.equal(scanned.added.length, 1);
    assert.equal(scanned.added[0]!.contents, 2);
    assert.deepEqual(scanned.unknown, [`NOPE-${tag}`]);
    assert.equal(scanned.total, 3);
    const again = await custody.scanIntoTransfer(pickup.id, [box.assetCode]);
    assert.equal(again.already.length, 1);

    await assert.rejects(custody.lockTransfer(pickup.id, { expectedCount: 3 }), (e: { code?: string }) => e.code === "count_mismatch");
    await assert.rejects(sign(pickup.id, "from", "Dana Ruiz"), (e: { code?: string }) => e.code === "not_locked");
    await custody.lockTransfer(pickup.id, { expectedCount: 1 });
    await assert.rejects(custody.scanIntoTransfer(pickup.id, [chair.assetCode]), (e: { code?: string }) => e.code === "transfer_locked");
    const first = await sign(pickup.id, "from", "Dana Ruiz");
    assert.equal(first.completed, false);
    await assert.rejects(sign(pickup.id, "from", "Dana Ruiz"), (e: { status?: number }) => e.status === 409);
    const second = await sign(pickup.id, "to", "Sam Lee");
    assert.equal(second.completed, true);
    const done = await custody.finalizeTransfer(pickup.id, actor);
    assert.ok(done.receiptAttachmentId);
    assert.ok(done.auditEntryId);

    // Still refused: a pickup is not a delivery.
    const stillBlocked = await core.advanceStage(job.id, [box.assetCode], "delivered", { via: "scan", ...actor });
    assert.equal(stillBlocked.blocked.length, 1);

    // The delivery sign-off for the shipment: every line, preset from its stage; the receiver marks the chair damaged.
    const signOff = await custody.startSignOff(truck.id, { to: { kind: "external", name: "Jo Park", org: "New HQ" } }, actor);
    assert.equal(signOff.purpose, "delivery");
    assert.equal(signOff.fromName, "Acme Haulage");
    assert.deepEqual(signOff.sealNumbers, ["SEAL-1"]);
    assert.equal(signOff.lines.length, 3);
    const resumed = await custody.startSignOff(truck.id, { to: { kind: "external", name: "Someone else" } }, actor);
    assert.equal(resumed.id, signOff.id);
    const chairLine = signOff.lines.find((l) => l.itemId === chair.id)!;
    const delivered = await custody.signTransfer(
      signOff.id,
      "to",
      { signerName: "Jo Park", image: PNG },
      { via: "device", capturedBy: actor.userOid, outcomes: [{ lineId: chairLine.id, outcome: "damaged", note: "Leg cracked" }] },
    );
    assert.equal(delivered.completed, true);
    const fin = await custody.finalizeTransfer(signOff.id, actor);
    assert.ok(fin.auditEntryId);

    const { lines } = await core.listJobItems(job.id);
    const stageOf = (id: string) => lines.find((l) => l.itemId === id)!.stage;
    assert.equal(stageOf(box.id), "delivered");
    assert.equal(stageOf(folder.id), "delivered");
    assert.equal(stageOf(chair.id), "damaged");
    const shipment = await core.getShipment(truck.id);
    assert.equal(shipment.status, "delivered");

    // Placing is allowed now that the delivery covers the box.
    const placed = await core.advanceStage(job.id, [box.assetCode], "placed", { via: "scan", ...actor });
    assert.equal(placed.advanced.length, 1);

    // The folder's chain: pickup then delivery, custody with the receiver.
    const chain = await custody.itemChain(folder.id);
    assert.equal(chain.controlled, true);
    assert.equal(chain.controlledBy, box.assetCode);
    assert.deepEqual(chain.hops.map((h) => h.code), [pickup.code, signOff.code]);
    assert.equal(chain.hops[0]!.inside, box.assetCode);
    assert.equal(chain.hops[0]!.signatures.length, 2);
    assert.equal(chain.custodian?.name, "Jo Park");
    const chairChain = await custody.itemChain(chair.id);
    assert.equal(chairChain.custodian?.name, "Jo Park");
    assert.equal(chairChain.hops[0]!.outcome, "damaged");

    // The receipt verifies, and the PDF someone holds is recognised.
    const report = await custody.verifyTransfer(signOff.id);
    assert.equal(report.valid, true, report.problems.join("; "));
    assert.equal(report.audit.entryId, fin.auditEntryId);
    const pdf = await custody.renderReceipt(await custody.loadTransfer(signOff.id));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const { rows } = await pool.query<{ bytes: Buffer }>(`SELECT bytes FROM attachments WHERE id = $1`, [fin.receiptAttachmentId]);
    const held = await custody.verifyReceiptBytes(rows[0]!.bytes);
    assert.equal(held.found, true);
    assert.equal(held.report?.transferId, signOff.id);
    assert.equal((await custody.verifyReceiptBytes(Buffer.from("%PDF-1.7 not ours"))).found, false);

    // Changing the list after signing fails verification, and says which line.
    await pool.query(`UPDATE custody_transfer_items SET outcome = 'accepted', note = NULL WHERE id = $1`, [chairLine.id]);
    const tampered = await custody.verifyTransfer(signOff.id);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.items.matches, false);
    assert.equal(tampered.signatures[0]!.reason, "content_changed");
    assert.deepEqual(tampered.changes?.lines.map((c) => c.fields), [["note", "outcome"]]);
    await pool.query(`UPDATE custody_transfer_items SET outcome = 'damaged', note = 'Leg cracked' WHERE id = $1`, [chairLine.id]);
    assert.equal((await custody.verifyTransfer(signOff.id)).valid, true);

    await assert.rejects(custody.voidTransfer(signOff.id, "oops", actor), (e: { status?: number }) => e.status === 409);
  });

  it("lets the receiving party sign once through a link", async () => {
    const crate = await createItem({ name: `Crate ${tag}` }, null);
    const t = await custody.createTransfer(
      { purpose: "handoff", from: { kind: "user", userOid: actor.userOid }, to: { kind: "external", name: "Lee Chan" } },
      actor,
    );
    assert.equal(t.fromName, actor.name);
    await custody.scanIntoTransfer(t.id, [crate.assetCode], "manual");
    await assert.rejects(custody.issueLink(t.id, "to", 24, actor), (e: { code?: string }) => e.code === "not_locked");
    await sign(t.id, "from", "Custody test", { expectedCount: 1 });
    const { token } = await custody.issueLink(t.id, "to", 24, actor);
    const view = await custody.publicView(token);
    assert.equal(view.party, "to");
    assert.equal(view.editable, false);
    assert.equal(view.signerName, "Lee Chan");
    assert.equal(view.lines.length, 1);

    const tf = await custody.transferForToken(token);
    const result = await custody.signByLink(tf.linkTokenHash!, { signerName: "Lee Chan", image: PNG }, {});
    assert.equal(result.completed, true);
    await assert.rejects(custody.publicView(token), (e: { status?: number }) => e.status === 410);
    const detail = await custody.getTransfer(t.id);
    assert.equal(detail.signing.to?.via, "link");
    assert.equal(detail.link.state, "used");
    assert.equal("linkTokenHash" in detail, false);
    await custody.finalizeTransfer(t.id, null);
    assert.equal((await custody.verifyTransfer(t.id)).valid, true);
  });

  it("voids an unfinished transfer and keeps it out of the chain", async () => {
    const thing = await createItem({ name: `Thing ${tag}` }, null);
    const t = await custody.createTransfer(
      { purpose: "handoff", from: { kind: "external", name: "A" }, to: { kind: "external", name: "B" } },
      actor,
    );
    await custody.scanIntoTransfer(t.id, [thing.assetCode]);
    await custody.voidTransfer(t.id, "Wrong truck", actor);
    const chain = await custody.itemChain(thing.id);
    assert.equal(chain.hops.length + chain.pending.length, 0);
    await assert.rejects(custody.scanIntoTransfer(t.id, [thing.assetCode]), (e: { code?: string }) => e.code === "transfer_locked");
  });
});
