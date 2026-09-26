import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * Operations insights against a real Postgres: jobs, shipments and reads are
 * made through their own services, then a run of the rules has to find each
 * problem, keep a dismissed one quiet, reopen one marked fixed that was not,
 * and clear the ones that were fixed. Also the load planner and storage
 * analytics over the same data, and the SQL twins of the pure helpers.
 *
 * Opt-in, because CI has no database:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_ops_intel_test \
 *     pnpm --filter bindex-server test
 *
 * Records are uniquely named; jobs, devices and profiles are removed at the
 * end, the locations and items are left behind.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Ops = typeof import("../src/services/ops-intel");
type Jobs = typeof import("../src/services/jobs-core");
type Tracking = typeof import("../src/services/tracking");

describe("operations insights against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let ops: Ops;
  let core: Jobs;
  let tracking: Tracking;
  let pool: typeof import("../src/db/client").pool;
  let createLocation: typeof import("../src/services/locations").createLocation;
  let createItem: typeof import("../src/services/items").createItem;
  let updateItem: typeof import("../src/services/items").updateItem;
  const tag = `ops${Date.now().toString(36)}`;
  const actor = { userOid: "test:ops-intel", name: "Ops insights test" };
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    ops = await import("../src/services/ops-intel");
    core = await import("../src/services/jobs-core");
    tracking = await import("../src/services/tracking");
    ({ pool } = await import("../src/db/client"));
    ({ createLocation } = await import("../src/services/locations"));
    ({ createItem, updateItem } = await import("../src/services/items"));
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await pool?.end();
  });

  const loc = (name: string, parentId: string | null = null) => createLocation({ name, parentId });

  it("finds each problem, respects resolutions, and clears what was fixed", async () => {
    // Places: a London warehouse with an aisle and a dock, a site in Birmingham, a truck.
    const wh = await loc(`Warehouse ${tag}`);
    const aisle = await loc("Aisle 1", wh.id);
    const dock = await loc("Dock", wh.id);
    const siteB = await loc(`Site B ${tag}`);
    const truck = await loc(`Truck ${tag}`);
    for (const id of [wh.id, siteB.id, truck.id, dock.id, aisle.id]) cleanup.push(() => ops.deleteProfile(id));
    await ops.saveProfile(wh.id, { lat: 51.5072, lng: -0.1276 }, actor.userOid);
    await ops.saveProfile(siteB.id, { lat: 52.4862, lng: -1.8904 }, actor.userOid);
    await ops.saveProfile(truck.id, { role: "vehicle", maxKg: 100, maxM3: 2 }, actor.userOid);
    await ops.saveProfile(dock.id, { role: "dock", distanceToDockM: 0 }, actor.userOid);
    await ops.saveProfile(aisle.id, { role: "storage", distanceToDockM: 60 }, actor.userOid);

    const mk = (name: string, locationId: string, extra: Record<string, unknown> = {}) =>
      createItem({ name: `${name} ${tag}`, locationId, ...extra }, null);
    const packed = await mk("Left behind", aisle.id);
    const onTruck = await mk("Still on the truck", aisle.id);
    const notPlaced = await mk("Not placed", aisle.id);
    const twoShip = await mk("On two shipments", aisle.id);
    const dupA = await mk("Serial A", aisle.id, { identifiers: [{ type: "serial", value: `SN-${tag}-01` }] });
    const dupB = await mk("Serial B", dock.id, { identifiers: [{ type: "serial", value: `sn ${tag} 01` }] });
    const twinA = await mk("Twin", aisle.id, { brand: "Dell", model: "Latitude 5440" });
    const twinB = await mk("Twin", aisle.id, { brand: "Dell", model: "Latitude 5440" });
    const wanderer = await mk("Wanderer", aisle.id);
    const quiet = await mk("Quiet", aisle.id);
    const teleport = await mk("Teleport", aisle.id);
    const ids = [packed, onTruck, notPlaced, twoShip, dupA, dupB, twinA, twinB, wanderer, quiet, teleport].map((i) => i.id);

    // A job whose first run was forced to delivered with a line left packed
    // and one never unloaded, and a line delivered a day and a half ago.
    const job = await core.createJob({ name: `Move ${tag}`, destinationLocationId: siteB.id }, actor);
    cleanup.push(() => core.deleteJob(job.id));
    await core.addTask(job.id, { title: "Place", kind: "place" }, actor);
    const run1 = await core.createShipment({ jobId: job.id, name: "Run 1", vehicleLocationId: truck.id }, actor);
    const run2 = await core.createShipment({ jobId: job.id, name: "Run 2", vehicleLocationId: truck.id }, actor);
    await core.addItemsByCodes(job.id, [packed.assetCode, onTruck.assetCode, notPlaced.assetCode], { shipmentId: run1.id }, actor);
    await core.addItemsByCodes(job.id, [twoShip.assetCode], { shipmentId: run2.id }, actor);
    const adv = { via: "manual", userOid: actor.userOid, actor: actor.name };
    await core.advanceStage(job.id, [packed.assetCode], "packed", adv);
    await core.advanceStage(job.id, [onTruck.assetCode], "loaded", { ...adv, shipmentId: run1.id });
    await core.advanceStage(job.id, [notPlaced.assetCode], "delivered", adv);
    await core.setShipmentStatus(run1.id, "delivered", { force: true, reason: "test" }, actor);
    await pool.query("UPDATE shipments SET arrived_at = now() - interval '5 hours' WHERE id = $1", [run1.id]);
    await pool.query(
      "UPDATE job_items SET stage_at = now() - interval '30 hours' WHERE job_id = $1 AND item_id = $2",
      [job.id, notPlaced.id],
    );

    // The same asset on another job's open shipment.
    const other = await core.createJob({ name: `Other ${tag}` }, actor);
    cleanup.push(() => core.deleteJob(other.id));
    const otherRun = await core.createShipment({ jobId: other.id, name: "Other run" }, actor);
    await core.addItemsByCodes(other.id, [twoShip.assetCode], { shipmentId: otherRun.id }, actor);

    // Reads: one asset parked at the dock for hours while on file in the aisle,
    // one not read for weeks, one read in London then Birmingham two minutes apart.
    const { device } = await tracking.createDevice(
      { kind: "rfid_reader", name: `Reader ${tag}`, locationId: dock.id },
      { issueToken: false },
    );
    cleanup.push(() => tracking.deleteDevice(device.id));
    const reader = await tracking.getDeviceRow(device.id);
    const at = (msAgo: number) => new Date(Date.now() - msAgo);
    await tracking.recordSightings(
      reader,
      [
        { asset: { itemId: wanderer.id, unitId: null }, observedAt: at(60_000) },
        { asset: { itemId: quiet.id, unitId: null }, locationId: aisle.id, observedAt: at(60_000) },
        { asset: { itemId: teleport.id, unitId: null }, locationId: aisle.id, observedAt: at(180_000) },
        { asset: { itemId: teleport.id, unitId: null }, locationId: siteB.id, observedAt: at(60_000) },
      ],
      { keepDuplicates: true },
    );
    await pool.query("UPDATE asset_positions SET entered_at = now() - interval '6 hours' WHERE item_id = $1", [wanderer.id]);
    await pool.query("UPDATE items SET updated_at = now() - interval '10 hours' WHERE id = $1", [wanderer.id]);
    await pool.query("UPDATE asset_positions SET observed_at = now() - interval '20 days' WHERE item_id = $1", [quiet.id]);

    const run = await ops.runAnomalyRules({ trigger: "manual", userOid: actor.userOid });
    assert.ok(run, "the run took the lock");
    for (const [rule, stat] of Object.entries(run.byRule)) assert.equal(stat?.error, undefined, `${rule} failed`);

    const openRows = async () =>
      (
        await pool.query(
          `SELECT * FROM ops_anomalies
            WHERE resolved_at IS NULL AND (item_id = ANY($1::uuid[]) OR job_id = ANY($2::uuid[]))`,
          [ids, [job.id, other.id]],
        )
      ).rows;
    const byRule = (rows: Record<string, unknown>[]) => {
      const m = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) m.set(r.rule as string, [...(m.get(r.rule as string) ?? []), r]);
      return m;
    };
    let found = byRule(await openRows());
    const expect: [string, string][] = [
      ["packed_not_loaded", packed.id],
      ["loaded_not_delivered", onTruck.id],
      ["delivered_not_placed", notPlaced.id],
      ["multi_shipment", twoShip.id],
      ["zone_mismatch", wanderer.id],
      ["not_seen", quiet.id],
      ["impossible_travel", teleport.id],
    ];
    for (const [rule, itemId] of expect) {
      const rows = found.get(rule) ?? [];
      assert.equal(rows.length, 1, `${rule}: one open anomaly`);
      assert.equal(rows[0]!.item_id, itemId, `${rule}: about the right record`);
      assert.ok(String(rows[0]!.link).startsWith("/"), `${rule}: links to its fix screen`);
    }
    const dupId = found.get("duplicate_identifier") ?? [];
    assert.equal(dupId.length, 1);
    assert.deepEqual(
      ((dupId[0]!.detail as { records: { itemId: string }[] }).records.map((r) => r.itemId)).sort(),
      [dupA.id, dupB.id].sort(),
    );
    const dupRec = found.get("duplicate_record") ?? [];
    assert.equal(dupRec.length, 1);
    assert.equal(dupRec[0]!.location_id, aisle.id);
    assert.equal(found.get("packed_not_loaded")![0]!.severity, "high");
    assert.equal(found.get("impossible_travel")![0]!.sticky, true);

    // A second run changes nothing about them.
    await ops.runAnomalyRules({ trigger: "manual" });
    const again = await openRows();
    assert.deepEqual(
      again.map((r) => r.id).sort(),
      [...found.values()].flat().map((r) => r.id).sort(),
    );

    // The events reached the audit log.
    const firstId = found.get("not_seen")![0]!.id as string;
    const events = await pool.query("SELECT type FROM audit_log WHERE subject_type = 'ops_anomaly' AND subject_id = $1", [firstId]);
    assert.deepEqual(
      events.rows.map((r) => r.type),
      ["ops.anomaly_detected"],
    );

    // Resolutions: dismissed stays quiet, "fixed" when it is not reopens.
    const who = { oid: actor.userOid, name: actor.name };
    const dismissed = await ops.resolveAnomaly(firstId, { resolution: "dismissed", note: "Out for repair" }, who);
    assert.equal(dismissed.resolution, "dismissed");
    assert.equal(dismissed.resolvedByName, actor.name);
    await assert.rejects(ops.resolveAnomaly(firstId, { resolution: "fixed", note: "again" }, who), /already resolved/);
    const twinRow = dupRec[0]!.id as string;
    await ops.resolveAnomaly(twinRow, { resolution: "fixed", note: "Merged them" }, who);

    // Fix three problems for real.
    const line = (itemId: string) =>
      pool.query("SELECT id FROM job_items WHERE job_id = $1 AND item_id = $2", [job.id, itemId]).then((r) => r.rows[0].id as string);
    await core.setLineStage(job.id, [await line(packed.id)], "missing", adv);
    await core.advanceStage(job.id, [onTruck.assetCode], "delivered", adv);
    await updateItem(wanderer.id, { locationId: dock.id }, null);

    const third = await ops.runAnomalyRules({ trigger: "manual" });
    assert.ok(third);
    found = byRule(await openRows());
    assert.equal(found.get("not_seen"), undefined, "dismissed stays quiet while the condition lasts");
    assert.equal(found.get("packed_not_loaded"), undefined);
    assert.equal(found.get("loaded_not_delivered"), undefined);
    assert.equal(found.get("zone_mismatch"), undefined);
    assert.equal(found.get("duplicate_record")?.[0]?.reopened_from, twinRow, "reopened: it was not fixed");
    assert.ok(found.get("impossible_travel"), "an event stays open until someone resolves it");

    const cleared = await pool.query(
      `SELECT rule, resolution, resolution_note FROM ops_anomalies
        WHERE item_id = ANY($1::uuid[]) AND resolution = 'cleared' ORDER BY rule`,
      [[packed.id, onTruck.id, wanderer.id]],
    );
    assert.deepEqual(
      cleared.rows.map((r) => r.rule),
      ["loaded_not_delivered", "packed_not_loaded", "zone_mismatch"],
    );
    assert.equal(cleared.rows[0]!.resolution_note, "No longer found by a run.");
    const quietRow = await pool.query("SELECT last_seen_at, cleared_at FROM ops_anomalies WHERE id = $1", [firstId]);
    assert.equal(quietRow.rows[0].cleared_at, null);

    // The listing and summary see them.
    const list = await ops.listAnomalies({ status: "open", itemId: teleport.id });
    assert.equal(list.total, 1);
    assert.equal(list.anomalies[0]!.ruleTitle, "Impossible travel");
    const history = await ops.getAnomaly(found.get("duplicate_record")![0]!.id as string);
    assert.equal(history.history[0]?.resolution, "fixed");
    const sum = await ops.summary(7);
    assert.ok(sum.open.total >= 1);
    assert.equal(sum.trend.length, 7);
    assert.ok(sum.lastRun);

    // Without a language model the explanation is simply unavailable.
    const explained = await ops.explainAnomaly(firstId);
    assert.equal(explained.available, process.env.LLM_API_KEY ? true : false);

    // Switching a rule off clears its open anomalies on the next run.
    await ops.updateSettings({ rules: { impossible_travel: { enabled: false } } });
    try {
      await ops.runAnomalyRules({ trigger: "manual" });
      const off = await pool.query(
        "SELECT resolution, resolution_note FROM ops_anomalies WHERE rule = 'impossible_travel' AND item_id = $1",
        [teleport.id],
      );
      assert.deepEqual(off.rows[0], { resolution: "cleared", resolution_note: "The rule was switched off." });
    } finally {
      await ops.updateSettings({ rules: { impossible_travel: { enabled: true } } });
    }

    // Storage analytics see the aisle and its profile.
    const { report, items } = await ops.storageAnalysis(true);
    const zone = report.zones.find((z) => z.locationId === aisle.id);
    assert.ok(zone, "the aisle has a row");
    assert.equal(zone.distanceToDockM, 60);
    assert.ok(items.some((i) => i.itemId === quiet.id && i.source === "tracking"));
    const wandererRow = items.find((i) => i.itemId === wanderer.id);
    assert.ok(wandererRow && wandererRow.movements >= 1, "a move on file counts as a movement");
  });

  it("plans a load within each vehicle's capacity, in stop order, and prints it", async () => {
    const siteC = await loc(`Site C ${tag}`);
    const floor1 = await loc("Floor 1", siteC.id);
    const floor2 = await loc("Floor 2", siteC.id);
    const van = await loc(`Van ${tag}`);
    const lorry = await loc(`Lorry ${tag}`);
    for (const id of [van.id, lorry.id]) cleanup.push(() => ops.deleteProfile(id));
    await ops.saveProfile(van.id, { role: "vehicle", maxKg: 60, maxM3: 1 }, null);
    await ops.saveProfile(lorry.id, { role: "vehicle", maxKg: 100, interiorLengthM: 4, interiorWidthM: 2, interiorHeightM: 2 }, null);
    const weights = [40, 30, 30, 20, 20, 10, 500];
    const things = [];
    for (const [i, kg] of weights.entries()) {
      things.push(await createItem({ name: `Crate ${i} ${tag}`, metadata: { weightKg: kg, lengthCm: 50, widthCm: 40, heightCm: 30 } }, null));
    }
    const job = await core.createJob({ name: `Delivery ${tag}` }, actor);
    cleanup.push(() => core.deleteJob(job.id));
    const a = await core.createShipment({ jobId: job.id, name: "Lorry run", vehicleLocationId: lorry.id }, actor);
    const b = await core.createShipment({ jobId: job.id, name: "Van run", vehicleLocationId: van.id }, actor);
    await core.addItemsByCodes(job.id, things.slice(0, 4).map((t) => t.assetCode), { destinationLocationId: floor1.id }, actor);
    await core.addItemsByCodes(job.id, things.slice(4).map((t) => t.assetCode), { destinationLocationId: floor2.id }, actor);

    const { plan } = await ops.jobLoadPlan(job.id, { stops: [`loc:${floor1.id}`, `loc:${floor2.id}`] });
    assert.deepEqual(
      plan.stops.map((s) => s.label),
      [`Site C ${tag} / Floor 1`, `Site C ${tag} / Floor 2`],
    );
    for (const v of plan.vehicles) {
      assert.ok(v.capacity);
      assert.ok(v.totals.weightKg <= v.capacity.maxKg! + 1e-9, `${v.name} within weight`);
      for (let i = 1; i < v.lines.length; i++) assert.ok(v.lines[i - 1]!.stopIndex >= v.lines[i]!.stopIndex);
    }
    const lorryPlan = plan.vehicles.find((v) => v.shipmentId === a.id)!;
    const vanPlan = plan.vehicles.find((v) => v.shipmentId === b.id)!;
    assert.equal(lorryPlan.totals.weightKg, 100);
    assert.equal(vanPlan.totals.weightKg, 50);
    assert.equal(plan.unassigned.length, 1);
    assert.equal(plan.unassigned[0]!.reason, "Heavier than any vehicle can carry.");

    const withExtra = await ops.jobLoadPlan(job.id, { vehicleLocationIds: [van.id], repack: true });
    assert.equal(withExtra.plan.vehicles.length, 3);
    await assert.rejects(ops.jobLoadPlan(job.id, { vehicleLocationIds: ["00000000-0000-4000-8000-000000000000"] }), /No such vehicle/);

    const pdf = await ops.loadPlanPdf({ jobCode: "JOB-TEST", jobName: "Delivery", generatedAt: new Date().toISOString(), plan });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

    const caps = await ops.shipmentCapacities(job.id);
    assert.equal(caps.length, 2);
    assert.ok(caps.every((c) => c.capacity));
  });

  it("keeps the SQL twins in step with the pure helpers, and backs up profiles", async () => {
    const { identityKey } = await import("../src/services/ops-intel/text");
    const { haversineM } = await import("../src/services/ops-intel/geo");
    const { rows } = await pool.query(
      "SELECT ops_identity_key($1) AS k, ops_haversine_m(51.5072, -0.1276, 52.4862, -1.8904) AS d",
      [" sn-0042 a:ß "],
    );
    assert.equal(rows[0].k, identityKey(" sn-0042 a:ß "));
    assert.ok(Math.abs(Number(rows[0].d) - haversineM(51.5072, -0.1276, 52.4862, -1.8904)) < 1e-6);

    const place = await loc(`Backed up ${tag}`);
    cleanup.push(() => ops.deleteProfile(place.id));
    await ops.saveProfile(place.id, { distanceToDockM: 12 }, null);
    const exported = await ops.exportOpsIntelTables();
    assert.ok(exported.ops_location_profiles.some((p) => p.locationId === place.id));
    // Clearing every field removes the profile.
    assert.equal(await ops.saveProfile(place.id, { distanceToDockM: null }, null), null);
    assert.equal(await ops.getProfile(place.id), null);
  });
});
