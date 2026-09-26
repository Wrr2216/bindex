import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

/**
 * The documents acceptance flow against a real Postgres, through the service
 * functions the routes call. CI has no database, so this runs only when
 * TEST_DATABASE_URL names a scratch database (it is migrated and written to):
 *
 *   createdb bindex_documents_test
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_documents_test \
 *     pnpm --filter bindex-server exec tsx --test tests/documents-db.test.ts
 *
 * It switches jobs and documents on in that database and makes its own
 * uniquely named records; the jobs, templates and packets are removed at the
 * end.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Docs = typeof import("../src/services/documents");
type Jobs = typeof import("../src/services/jobs-core");
type Media = typeof import("../src/services/media-ai-core");
type Block = import("../src/services/documents").Block;

function signaturePng(): Buffer {
  const canvas = createCanvas(280, 80);
  const g = canvas.getContext("2d");
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(8, 50);
  g.bezierCurveTo(60, 0, 120, 80, 270, 20);
  g.stroke();
  return canvas.toBuffer("image/png");
}

describe("documents against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let docs: Docs;
  let jobs: Jobs;
  let media: Media;
  let pool: typeof import("../src/db/client").pool;
  const tag = `t${Date.now().toString(36)}`;
  const actor = { userOid: "test:documents", name: "Documents test" };
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    docs = await import("../src/services/documents");
    jobs = await import("../src/services/jobs-core");
    media = await import("../src/services/media-ai-core");
    ({ pool } = await import("../src/db/client"));
    const { updateConfig } = await import("../src/services/config");
    await updateConfig({ features: { jobs: true, documents: true } });
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch((err) => console.error("cleanup", err));
    await pool?.end();
  });

  it("attaches the IT relocation packet, fills, signs, exports and verifies", async () => {
    const { createLocation } = await import("../src/services/locations");
    const { createItem } = await import("../src/services/items");
    const oldHq = await createLocation({ name: `Old HQ ${tag}` });
    const floor3 = await createLocation({ name: "Floor 3", parentId: oldHq.id });
    const newHq = await createLocation({ name: `New HQ ${tag}` });
    const laptop = await createItem({ name: "Laptop", brand: "Dell", model: "Latitude 5440", locationId: floor3.id }, null);
    const monitor = await createItem({ name: "Monitor", locationId: floor3.id }, null);

    const it = await jobs.createJobType({ name: `IT relocation ${tag}` });
    const delivery = await jobs.createJobType({ name: `Delivery ${tag}` });
    cleanup.push(() => jobs.deleteJobType(it.id), () => jobs.deleteJobType(delivery.id));

    // A library field, dropped into the template the way the editor does.
    const contact = await docs.createCustomField({ key: `site_contact_${tag}`, label: "Site contact", type: "text", required: true });
    cleanup.push(() => docs.deleteCustomField(contact.id));

    const body: Block[] = [
      { id: "h", type: "heading", level: 1, text: "IT relocation sign-off" },
      { id: "p", type: "paragraph", text: "Job {{job.code}} ({{job.name}}) moves {{manifest.count}} items from {{job.originPath}}." },
      { id: "c", type: "field", field: contact.definition },
      { id: "n", type: "field", field: { key: "crates", label: "Crates used", type: "number", min: 0 } },
      { id: "a", type: "field", field: { key: "agree", label: "Everything listed arrived", type: "checkbox", required: true } },
      { id: "t", type: "table", source: "manifest", columns: ["code", "item", "description", "stage"] },
      { id: "s", type: "field", field: { key: "customer_sig", label: "Customer signature", type: "signature", required: true } },
    ];
    const created = await docs.createTemplate({ name: `Relocation sign-off ${tag}`, title: "Sign-off: {{job.name}}", body }, actor.userOid);
    const templateId = created.id;
    cleanup.push(() => docs.deleteTemplate(templateId));
    await assert.rejects(docs.createDocument({ templateId }, actor), /has not been published/);
    const published = await docs.publishTemplate(templateId, actor.userOid);
    assert.equal(published.version.version, 1);
    assert.equal(published.template.draft, null);
    const listed = (await docs.listTemplates()).find((t) => t.id === templateId);
    assert.deepEqual([listed?.latestVersion, listed?.publishedVersion, listed?.hasDraft], [1, 1, false]);

    const packet = await docs.createPacket(
      { name: `IT move packet ${tag}`, templateIds: [templateId], conditions: { jobTypeIds: [it.id] } },
      actor,
    );
    cleanup.push(() => docs.deletePacket(packet.id));
    assert.equal((await docs.getPacket(packet.id)).templates[0]?.publishedVersion, 1);

    // A delivery job gets nothing; an IT relocation job gets the packet.
    const other = await jobs.createJob({ name: `Parts drop ${tag}`, jobTypeId: delivery.id }, actor);
    cleanup.push(() => jobs.deleteJob(other.id));
    assert.equal((await docs.jobDocuments(other.id)).documents.length, 0);

    const job = await jobs.createJob(
      { name: `Floor 3 move ${tag}`, jobTypeId: it.id, originLocationId: floor3.id, destinationLocationId: newHq.id },
      actor,
    );
    cleanup.push(() => jobs.deleteJob(job.id));
    await jobs.addItemsByCodes(job.id, [laptop.assetCode, monitor.assetCode], {}, actor);
    const onJob = await docs.jobDocuments(job.id);
    assert.deepEqual(onJob.packets.map((p) => [p.packetId, p.auto, p.applies]), [[packet.id, true, true]]);
    assert.equal(onJob.documents.length, 1);
    const docId = onJob.documents[0]!.id;
    assert.equal(onJob.documents[0]!.title, `Sign-off: Floor 3 move ${tag}`);

    // Changing the type withdraws the untouched document; changing it back attaches again.
    await jobs.updateJob(job.id, { jobTypeId: delivery.id }, actor);
    assert.equal((await docs.jobDocuments(job.id)).documents.length, 0);
    assert.equal((await docs.jobDocuments(job.id)).packets.length, 0);
    await jobs.updateJob(job.id, { jobTypeId: it.id }, actor);
    const again = await docs.jobDocuments(job.id);
    assert.equal(again.documents.length, 1);
    const id = again.documents[0]!.id;
    assert.notEqual(id, docId);

    // Autosave, with the required-field rule enforced at completion.
    await assert.rejects(docs.saveValues(id, { values: { crates: -1 } }, actor), /0 or more/);
    await docs.saveValues(id, { values: { crates: "12" } }, actor);
    await assert.rejects(docs.completeDocument(id, actor, "UTC"), /Fill in "Site contact", "Everything listed arrived"/);
    await docs.saveValues(id, { values: { [contact.key]: "Dana Ruiz", agree: true } }, actor);

    // A filled document is kept when the job stops matching.
    await jobs.updateJob(job.id, { jobTypeId: delivery.id }, actor);
    const kept = await docs.jobDocuments(job.id);
    assert.equal(kept.documents.length, 1);
    assert.deepEqual(kept.packets.map((p) => p.applies), [false]);
    await jobs.updateJob(job.id, { jobTypeId: it.id }, actor);
    assert.deepEqual((await docs.jobDocuments(job.id)).packets.map((p) => p.applies), [true]);
    assert.equal((await docs.jobDocuments(job.id)).documents.length, 1);

    const completed = await docs.completeDocument(id, actor, "UTC");
    assert.equal(completed.status, "completed");
    assert.match(completed.contentHash!, /^[0-9a-f]{64}$/);
    await assert.rejects(docs.saveValues(id, { values: { crates: 13 } }, actor), /completed/);
    const snapshot = completed.snapshot as { context: { manifest: { count: number } }; tables: Record<string, { total: number }> };
    assert.equal(snapshot.context.manifest.count, 2);
    assert.equal(snapshot.tables.t!.total, 2);

    // Sign exactly what the server says this field signs.
    const detail = await docs.getDocumentDetail(id, "UTC");
    const expected = detail.signing!.customer_sig!;
    const wrong = await media.sign({
      ownerType: "document",
      ownerId: id,
      signerName: "Mallory",
      statement: expected.statement,
      content: { ...expected.content, field: "other" },
    });
    await assert.rejects(docs.attachSignature(id, { fieldKey: "customer_sig", signatureId: wrong.id }, actor), /does not match/);
    const signature = await media.sign({
      ownerType: "document",
      ownerId: id,
      signerName: "Dana Ruiz",
      signerRole: "Facility contact",
      statement: expected.statement,
      content: expected.content,
      image: signaturePng(),
    });
    const signed = await docs.attachSignature(id, { fieldKey: "customer_sig", signatureId: signature.id }, actor);
    assert.equal(signed.status, "signed");
    await assert.rejects(docs.reopenDocument(id, actor), /signed/);
    await assert.rejects(docs.attachSignature(id, { fieldKey: "customer_sig", signatureId: signature.id }, actor), /already signed/);

    const report = await docs.verifyDocument(id);
    assert.equal(report.valid, true);
    assert.deepEqual(report.signatures.map((s) => [s.field, s.valid]), [["customer_sig", true]]);

    // Export: recorded by hash, the same bytes every time, and checkable later.
    const first = await docs.documentPdf(id, { timeZone: "UTC", actor });
    assert.equal(first.recorded, true);
    const second = await docs.documentPdf(id, { timeZone: "UTC", actor });
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.exportId, first.exportId);
    const check = await docs.verifyPdf(first.bytes);
    assert.equal(check.found, true);
    assert.equal(check.document?.valid, true);
    assert.equal(check.document?.exportedContentStillCurrent, true);
    assert.equal((await docs.verifyPdf(Buffer.concat([first.bytes, Buffer.from(" ")]))).found, false);
    const stored = await media.listAttachments("document", id, { kind: "document" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.sha256, first.sha256);

    // Anyone rewriting the stored values is caught.
    await pool.query(`UPDATE documents SET field_values = jsonb_set(field_values, '{crates}', '99') WHERE id = $1`, [id]);
    const tampered = await docs.verifyDocument(id);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.content.matches, false);
    assert.equal(tampered.signatures[0]!.valid, false);
    assert.equal((await docs.verifyPdf(first.bytes)).document?.exportedContentStillCurrent, false);
    await pool.query(`UPDATE documents SET field_values = jsonb_set(field_values, '{crates}', '12') WHERE id = $1`, [id]);
    assert.equal((await docs.verifyDocument(id)).valid, true);

    // Copying: a duplicate carries values, never signatures.
    const copy = await docs.duplicateDocument(id, {}, actor);
    assert.equal(copy.status, "draft");
    assert.equal(copy.values.crates, 12);
    assert.equal(copy.values.customer_sig, undefined);
    assert.equal(copy.copiedFrom, id);
    const blank = await docs.createDocument({ templateId, jobId: job.id }, actor);
    const sources = await docs.copySources(blank.id);
    assert.ok(sources.some((s) => s.id === id));
    const filled = await docs.copyFrom(blank.id, id, {});
    assert.deepEqual(filled.copied.sort(), ["agree", contact.key, "crates"].sort());

    // Versioning: editing a published template starts version 2; documents keep version 1.
    const edited = await docs.updateTemplate(templateId, { body: [...body, { id: "d", type: "divider" }] });
    assert.equal(edited.draft?.version, 2);
    assert.equal(edited.published?.version, 1);
    const again2 = await docs.updateTemplate(templateId, { title: "Sign-off v2: {{job.name}}" });
    assert.equal(again2.draft?.version, 2, "further edits go into the same draft");
    await docs.publishTemplate(templateId, actor.userOid);
    const v2doc = await docs.createDocument({ templateId, jobId: job.id }, actor);
    assert.equal((await docs.getDocumentDetail(v2doc.id)).version.version, 2);
    assert.equal((await docs.getDocumentDetail(id)).version.version, 1);
    assert.equal((await docs.verifyDocument(id)).valid, true);
    const history = (await docs.getTemplate(templateId)).versions.map((v) => [v.version, v.status, v.documentCount]);
    assert.deepEqual(history, [
      [2, "published", 1],
      [1, "published", 3],
    ]);
    assert.equal((await docs.listTemplates()).find((t) => t.id === templateId)?.documentCount, 4);
    await assert.rejects(docs.deleteTemplate(templateId), /use this template/);

    // A backup round trip keeps every document table intact.
    const { buildBackup, restoreBackup } = await import("../src/services/backup");
    const backup = await buildBackup();
    assert.ok(backup.data.documents.some((d) => d.id === id));
    await restoreBackup(JSON.parse(JSON.stringify(backup)));
    assert.equal((await docs.verifyDocument(id)).valid, true);
    assert.equal((await docs.jobDocuments(job.id)).documents.length, 4);

    // Clean-up order: documents hold their templates.
    cleanup.push(async () => {
      await pool.query(`DELETE FROM documents WHERE template_id = $1`, [templateId]);
    });
  });

  it("attaches by hand, detaches, and evaluates conditions on demand", async () => {
    const type = await jobs.createJobType({ name: `Survey ${tag}` });
    cleanup.push(() => jobs.deleteJobType(type.id));
    const t = await docs.createTemplate(
      { name: `Survey form ${tag}`, body: [{ id: "f", type: "field", field: { key: "notes", label: "Notes", type: "text", multiline: true } }] },
      actor.userOid,
    );
    await docs.publishTemplate(t.id, actor.userOid);
    const packet = await docs.createPacket(
      { name: `Survey packet ${tag}`, templateIds: [t.id], autoAttach: false, conditions: { rules: [{ field: "metadata.survey", op: "equals", value: "yes" }] } },
      actor,
    );
    const job = await jobs.createJob({ name: `Survey ${tag}`, jobTypeId: type.id }, actor);
    cleanup.push(
      async () => {
        await pool.query(`DELETE FROM documents WHERE template_id = $1`, [t.id]);
        await docs.deleteTemplate(t.id);
      },
      () => docs.deletePacket(packet.id),
      () => jobs.deleteJob(job.id),
    );
    assert.equal((await docs.jobDocuments(job.id)).documents.length, 0, "manual-only packets never attach themselves");
    assert.equal((await docs.testConditions(docs.readConditions(packet.conditions), job.id)).matches, false);
    await jobs.setJobMetadata(job.id, "survey", "yes");
    assert.equal((await docs.testConditions(docs.readConditions(packet.conditions), job.id)).matches, true);

    const attached = await docs.attachPacket(job.id, packet.id, actor);
    assert.equal(attached.documents, 1);
    await assert.rejects(docs.attachPacket(job.id, packet.id, actor), /already on this job/);
    const [doc] = (await docs.jobDocuments(job.id)).documents;
    await docs.saveValues(doc!.id, { values: { notes: "Loading dock is narrow" } }, actor);
    const detached = await docs.detachPacket(job.id, packet.id, actor);
    assert.deepEqual([detached.removed, detached.kept], [0, 1]);

    const applied = await docs.applyPacketToOpenJobs(packet.id, actor);
    assert.ok(applied.jobIds.includes(job.id));
    // Its template already has a document from this packet on the job, so none is added.
    assert.equal((await docs.jobDocuments(job.id)).documents.length, 1);
  });
});
