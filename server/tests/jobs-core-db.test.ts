import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * The relocation acceptance flow against a real Postgres, through the service
 * functions later features call. Opt-in, because CI has no database:
 *
 *   JOBS_CORE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_jobs_core \
 *     pnpm --filter bindex-server test
 *
 * It creates its own uniquely named records and removes its jobs and project
 * at the end; the locations and items it made are left behind.
 */

const url = process.env.JOBS_CORE_TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Core = typeof import("../src/services/jobs-core");

describe("jobs core against Postgres", { skip: url ? false : "set JOBS_CORE_TEST_DATABASE_URL to run" }, () => {
  let core: Core;
  let pool: typeof import("../src/db/client").pool;
  let createLocation: typeof import("../src/services/locations").createLocation;
  let createItem: typeof import("../src/services/items").createItem;
  const tag = `t${Date.now().toString(36)}`;
  const actor = { userOid: "test:jobs-core", name: "Jobs core test" };
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    core = await import("../src/services/jobs-core");
    ({ pool } = await import("../src/db/client"));
    ({ createLocation } = await import("../src/services/locations"));
    ({ createItem } = await import("../src/services/items"));
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await pool?.end();
  });

  it("runs a relocation from plan to placed", async () => {
    // Places: a floor with two departments, and a destination level.
    const loc = (name: string, parentId: string | null = null) => createLocation({ name, parentId }).then((l) => l.id);
    const oldHq = await loc(`Old HQ ${tag}`);
    const floor3 = await loc("Floor 3", oldHq);
    const finance = await loc("Finance", floor3);
    const legal = await loc("Legal", floor3);
    const newHq = await loc(`New HQ ${tag}`);
    const level5 = await loc("Level 5", newHq);
    await loc("5.12", level5);
    await loc("5.14", level5);

    const item = (name: string, locationId: string, metadata: Record<string, unknown> = {}) =>
      createItem({ name, locationId, metadata }, null);
    const chair = await item("Chair", finance);
    const desk = await item("Desk", finance);
    const cabinet = await item("Cabinet", legal, { sealedForTest: tag });
    const outsider = await item("Outsider", newHq);

    // Extension points: a guard that holds back one item unless forced, and a
    // listener that sees every change.
    const seen: string[] = [];
    const unguard = core.registerStageGuard(`test-${tag}`, (ctx) =>
      ctx.force
        ? []
        : ctx.lines.filter((l) => l.itemId === cabinet.id && ctx.stage === "loaded").map((l) => ({
            jobItemId: l.jobItemId,
            reason: "Needs a custody transfer first.",
          })),
    );
    const unlisten = core.onStageChanged((changes) => {
      for (const c of changes) seen.push(`${c.itemId}:${c.to}`);
    });
    cleanup.push(async () => {
      unguard();
      unlisten();
    });

    const project = await core.createProject({ name: `Consolidation ${tag}` }, actor);
    const phase1 = await core.addPhase(project.id, { name: "Floor 3" });
    await core.addPhase(project.id, { name: "Floors 4 and 5" });
    const types = await core.listJobTypes();
    const relocation = types.find((t) => t.name === "Relocation")!;
    assert.ok(relocation, "the Relocation job type is seeded");

    const job = await core.createJob(
      { name: "Floor 3 move", projectId: project.id, phaseId: phase1.id, jobTypeId: relocation.id },
      actor,
    );
    cleanup.push(() => core.deleteProject(project.id));
    cleanup.push(() => core.deleteJob(job.id));
    assert.match(job.code, /^JOB-/);
    assert.equal((await core.listTasks(job.id)).length, relocation.taskTemplate.length);

    const added = await core.addItemsFromLocation(job.id, floor3, {}, actor);
    assert.deepEqual(added, { added: 3, alreadyOnJob: 0, found: 3 });

    const csv = await core.importManifestCsv(
      job.id,
      `code,destination,floor,department,desk\n,New HQ ${tag} / Level 5 / 5.12,5,Finance,\n,New HQ ${tag} / Level 5 / 5.14,5,Legal,\n${chair.assetCode},,,,Window desk\n`,
      {},
      actor,
    );
    assert.deepEqual(csv.departments, [
      { department: "Finance", lines: 2 },
      { department: "Legal", lines: 1 },
    ]);
    assert.equal(csv.errors.length + csv.unmatchedDestinations.length, 0);
    const { lines } = await core.listJobItems(job.id);
    assert.ok(lines.every((l) => l.floor === "5" && l.destinationName));
    assert.equal(lines.find((l) => l.itemId === chair.id)!.destinationLabel, "Window desk");

    const pdf = await core.jobManifestPdf(job.id, { groupBy: "floor", floor: "5" }, "UTC");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

    const truck1 = await core.createShipment({ jobId: job.id, name: "Truck 1", sealNumbers: ["S1"] }, actor);
    const truck2 = await core.createShipment({ jobId: job.id, name: "Truck 2" }, actor);
    const codes = [chair.assetCode, desk.assetCode, cabinet.assetCode];

    const packed = await core.advanceStage(job.id, codes, "packed", { via: "scan", ...actor });
    assert.equal(packed.advanced.length, 3);

    const loaded = await core.advanceStage(job.id, codes, "loaded", {
      via: "rfid",
      deviceId: "dock-1",
      shipmentId: truck1.id,
      ...actor,
    });
    assert.equal(loaded.advanced.length, 2);
    assert.deepEqual(
      loaded.blocked.map((b) => [b.itemId, b.reason]),
      [[cabinet.id, "Needs a custody transfer first."]],
    );
    const forced = await core.advanceStage(job.id, [cabinet.assetCode], "loaded", {
      via: "manual",
      shipmentId: truck1.id,
      force: true,
      ...actor,
    });
    assert.equal(forced.advanced.length, 1);

    const mixed = await core.advanceStage(job.id, [chair.assetCode, outsider.assetCode, `NOPE-${tag}`], "loaded", {
      via: "scan",
      shipmentId: truck2.id,
      ...actor,
    });
    assert.deepEqual(mixed.wrongShipment.map((l) => l.shipmentCode), [truck1.code]);
    assert.deepEqual(mixed.notOnJob.map((n) => n.itemId), [outsider.id]);
    assert.deepEqual(mixed.unknown, [`NOPE-${tag}`]);
    assert.equal(mixed.advanced.length, 0);

    await assert.rejects(
      core.setShipmentStatus(truck1.id, "closed", {}, actor),
      (err: { code?: string }) => err.code === "lines_not_ready",
    );
    await core.setShipmentStatus(truck1.id, "in_transit", {}, actor);
    await core.setShipmentStatus(truck1.id, "delivered", {}, actor);

    await core.advanceStage(job.id, codes, "delivered", { via: "scan", ...actor });
    const placed = await core.advanceStage(job.id, codes, "placed", { via: "scan", ...actor });
    assert.equal(placed.advanced.length, 3);
    await core.setShipmentStatus(truck1.id, "closed", {}, actor);

    const progress = await core.getJobProgress(job.id);
    assert.equal(progress.overall.overall, 100);
    assert.equal(progress.overall.complete, true);
    assert.deepEqual(
      progress.byDepartment.map((g) => [g.label, g.progress.total]),
      [
        ["Finance", 2],
        ["Legal", 1],
      ],
    );

    const detail = await core.getJob(job.id);
    assert.equal(detail.status, "in_progress");
    const byKind = Object.fromEntries(detail.tasks.map((t) => [t.kind, t.status]));
    assert.equal(byKind.pack, "done");
    assert.equal(byKind.load, "done");
    assert.equal(byKind.place, "done");
    assert.equal(byKind.pre_inspection, "todo");

    // Every change reached the listener and the history, once per line.
    assert.equal(seen.length, 3 * 4);
    const history = await core.stageHistory(job.id, 100);
    assert.equal(history.length, 12);
    assert.ok(history.some((h) => h.via === "rfid" && h.deviceId === "dock-1"));
  });

  /** An item with two units, and an RFID tag commissioned onto the second. */
  async function radios(name: string) {
    const { addUnit } = await import("../src/services/units");
    const store = await createLocation({ name: `${name} ${tag}`, parentId: null });
    const item = await createItem({ name: "Radio", locationId: store.id }, null);
    const u1 = await addUnit(item.id, { label: "Radio 1" });
    const u2 = await addUnit(item.id, { label: "Radio 2" });
    const epc = `E2${Date.now().toString(16).toUpperCase()}${Math.floor(Math.random() * 1e6)}`;
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO item_identifiers (item_id, type, value) VALUES ($1, 'rfid', $2) RETURNING id",
      [item.id, epc],
    );
    await pool.query("INSERT INTO tag_identifier_units (identifier_id, unit_id) VALUES ($1, $2)", [rows[0]!.id, u2.id]);
    return { store: store.id, item, u1, u2, epc };
  }

  async function newJob(name: string) {
    const job = await core.createJob({ name: `${name} ${tag}` }, actor);
    cleanup.push(() => core.deleteJob(job.id));
    return job;
  }

  it("resolves a tag commissioned onto a unit to that unit", async () => {
    const r = await radios("Tag store");
    assert.deepEqual((await core.resolveScanCodes([r.epc])).get(r.epc), [{ itemId: r.item.id, unitId: r.u2.id }]);

    const job = await newJob("Radio move");
    await core.addItemsByCodes(job.id, [r.u1.assetCode, r.u2.assetCode], {}, actor);
    const packed = await core.advanceStage(job.id, [r.epc], "packed", { via: "rfid", ...actor });
    assert.deepEqual(packed.advanced.map((l) => l.unitId), [r.u2.id]);
  });

  it("never puts a whole item and its units on a job side by side", async () => {
    const r = await radios("Mixed store");
    const lines = async (jobId: string) =>
      (await core.listJobItems(jobId)).lines.map((l) => l.unitId ?? "whole").sort();

    // Both in one call: the whole item comes first and covers the unit.
    const job = await newJob("Whole then unit");
    const byCode = await core.addItemsByCodes(job.id, [r.item.assetCode, r.u1.assetCode], {}, actor);
    assert.equal(byCode.added, 1);
    assert.deepEqual(byCode.alreadyOnJob, [r.u1.assetCode]);
    // Then everything at the location, one line per unit: covered too.
    const fromLocation = await core.addItemsFromLocation(job.id, r.store, {}, actor);
    assert.deepEqual(fromLocation, { added: 0, alreadyOnJob: 2, found: 2 });
    assert.deepEqual(await lines(job.id), ["whole"]);

    // The other way round: units on the job cover the whole item.
    const other = await newJob("Unit then whole");
    await core.addItemsByCodes(other.id, [r.u1.assetCode], {}, actor);
    assert.equal((await core.addItemsFromLocation(other.id, r.store, { perUnit: false }, actor)).added, 0);
    assert.deepEqual(await lines(other.id), [r.u1.id]);

    // A move plan listing a unit and then its item adds the unit once and
    // updates it for the item row.
    const planned = await newJob("Plan");
    const csv = await core.importManifestCsv(
      planned.id,
      `code,destination,floor,department,desk\n${r.u2.assetCode},,4,,\n${r.item.assetCode},,5,,\n`,
      {},
      actor,
    );
    assert.equal(csv.added, 1);
    assert.equal(csv.updated, 1);
    assert.deepEqual(await lines(planned.id), [r.u2.id]);
  });

  it("puts no line on a closed shipment, and changes no line on a finished job", async () => {
    const r = await radios("Closed store");
    const job = await newJob("Closed shipment");
    await core.addItemsByCodes(job.id, [r.item.assetCode], {}, actor);
    const [line] = (await core.listJobItems(job.id)).lines;
    const truck = await core.createShipment({ jobId: job.id, name: "Truck" }, actor);
    await core.setShipmentStatus(truck.id, "closed", {}, actor);

    const closed = (err: Error) => /is closed/.test(err.message);
    await assert.rejects(core.updateJobItems(job.id, [line!.id], { shipmentId: truck.id }), closed);
    await assert.rejects(core.addItemsByCodes(job.id, [r.u1.assetCode], { shipmentId: truck.id }, actor), closed);
    assert.equal((await core.listJobItems(job.id)).lines[0]!.shipmentId, null);

    await core.updateJob(job.id, { status: "completed" }, actor);
    await assert.rejects(core.updateJobItems(job.id, [line!.id], { notes: "Late edit" }), /Reopen it/);
  });

  it("does not load a shipment that is closing while the scan waits", async () => {
    const r = await radios("Race store");
    const job = await newJob("Race");
    await core.addItemsByCodes(job.id, [r.item.assetCode], {}, actor);
    const truck = await core.createShipment({ jobId: job.id, name: "Truck" }, actor);

    // Stands in for setShipmentStatus closing the shipment: it holds the row
    // locked until it commits.
    const closer = await pool.connect();
    try {
      await closer.query("BEGIN");
      await closer.query("SELECT 1 FROM shipments WHERE id = $1 FOR UPDATE", [truck.id]);
      await closer.query("UPDATE shipments SET status = 'closed' WHERE id = $1", [truck.id]);
      const scan = core.advanceStage(job.id, [r.item.assetCode], "loaded", {
        via: "scan",
        shipmentId: truck.id,
        ...actor,
      });
      const settled = scan.then(
        () => "loaded",
        (err: Error) => err.message,
      );
      await new Promise((ok) => setTimeout(ok, 300));
      await closer.query("COMMIT");
      assert.match(await settled, /is closed/);
    } finally {
      closer.release();
    }
    assert.equal((await core.listJobItems(job.id)).lines[0]!.shipmentId, null);
  });
});
