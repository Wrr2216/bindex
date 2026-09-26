import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * Delivery and placement against a real Postgres, through the services the
 * routes call. Opt-in, because CI has no database:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_placement_test \
 *     pnpm --filter bindex-server test
 *
 * Use a database of its own: the last step restores a backup over it, and the
 * reader worker's cursor is shared by everything in the database.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Placement = typeof import("../src/services/placement");
type Jobs = typeof import("../src/services/jobs-core");
type Tracking = typeof import("../src/services/tracking");

describe("placement against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let placement: Placement;
  let jobs: Jobs;
  let tracking: Tracking;
  let pool: typeof import("../src/db/client").pool;
  let createLocation: typeof import("../src/services/locations").createLocation;
  let createItem: typeof import("../src/services/items").createItem;
  let resetIngestState: () => void;
  const tag = `p${Date.now().toString(36)}`;
  const actor = { userOid: "test:placement", name: "Placement test" };
  const who = { userOid: actor.userOid, name: actor.name };

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    placement = await import("../src/services/placement");
    jobs = await import("../src/services/jobs-core");
    tracking = await import("../src/services/tracking");
    ({ pool } = await import("../src/db/client"));
    ({ createLocation } = await import("../src/services/locations"));
    ({ createItem } = await import("../src/services/items"));
    ({ resetIngestState } = await import("../src/services/tracking/ingest"));
    const { updateConfig } = await import("../src/services/config");
    await updateConfig({ features: { jobs: true, tracking: true, placement: true } });
  });

  after(async () => {
    await pool?.end();
  });

  it("guides a delivery from the truck to each room", async () => {
    const loc = (name: string, parentId: string | null = null) => createLocation({ name, parentId }).then((l) => l.id);
    const oldHq = await loc(`Old HQ ${tag}`);
    const floor3 = await loc("Floor 3", oldHq);
    const finance = await loc("Finance", floor3);
    const newHq = await loc(`New HQ ${tag}`);
    const level5 = await loc("Level 5", newHq);
    const r512 = await loc("5.12", level5);
    const r514 = await loc("5.14", level5);
    const dock = await loc("Dock", newHq);
    placement.forgetTree();

    const item = (name: string, locationId: string) => createItem({ name, locationId }, null);
    const chair = await item("Chair", finance);
    const desk = await item("Desk", finance);
    const lamp = await item("Lamp", finance);
    const bin = await item("Bin", finance);
    const stranger = await item("Stranger", dock);

    const job = await jobs.createJob({ name: `Move ${tag}`, originLocationId: oldHq, destinationLocationId: newHq }, actor);
    const other = await jobs.createJob({ name: `Other ${tag}` }, actor);
    await jobs.addItemsByCodes(other.id, [stranger.assetCode], {}, actor);
    assert.equal((await jobs.addItemsFromLocation(job.id, finance, {}, actor)).added, 4);

    // Destination rules: nothing matches "Finance" at the new site until the
    // room map says the old Finance area goes to 5.14.
    const before = await placement.proposals(job.id);
    assert.equal(before.proposals.length, 0);
    assert.deepEqual(before.unmatchedOrigins.map((o) => [o.origin.id, o.lines]), [[finance, 4]]);
    await placement.setRoomMap(job.id, [{ originLocationId: finance, destinationLocationId: r514 }]);
    const proposed = await placement.proposals(job.id);
    assert.equal(proposed.proposals.length, 4);
    assert.ok(proposed.proposals.every((p) => p.destination.id === r514 && p.reason === "room_map" && p.floor === "Level 5"));
    assert.deepEqual(await placement.applyProposals(job.id, {}), { updated: 4 });
    assert.equal((await placement.proposals(job.id)).proposals.length, 0);

    const { lines } = await jobs.listJobItems(job.id);
    const lineOf = (itemId: string) => lines.find((l) => l.itemId === itemId)!;
    assert.ok(lines.every((l) => l.destinationLocationId === r514 && l.floor === "Level 5"));
    await jobs.updateJobItems(job.id, [lineOf(desk.id).id], { destinationLocationId: r512 });

    const truck1 = await jobs.createShipment({ jobId: job.id, name: "Truck 1" }, actor);
    const truck2 = await jobs.createShipment({ jobId: job.id, name: "Truck 2" }, actor);
    await jobs.advanceStage(job.id, [chair.assetCode, desk.assetCode, bin.assetCode], "loaded", {
      via: "scan",
      shipmentId: truck1.id,
      ...actor,
    });
    await jobs.advanceStage(job.id, [lamp.assetCode], "loaded", { via: "scan", shipmentId: truck2.id, ...actor });

    // The card: where it goes, and the wrong truck caught once.
    const card = await placement.lookup(job.id, chair.assetCode, { shipmentId: truck1.id, who });
    assert.equal(card.outcome, "ok");
    assert.equal(card.line!.destination!.id, r514);
    assert.equal(card.line!.floor, "Level 5");
    assert.match(card.line!.floorColor, /^#[0-9a-f]{6}$/);
    assert.deepEqual(card.handlingNotes, []);

    const wrong = await placement.lookup(job.id, lamp.assetCode, { shipmentId: truck1.id, who });
    assert.equal(wrong.outcome, "wrong_shipment");
    assert.equal(wrong.recorded, true);
    assert.equal(wrong.line!.stage, "wrong_shipment");
    const again = await placement.lookup(job.id, lamp.assetCode, { shipmentId: truck1.id, who });
    assert.equal(again.recorded, false);

    const notMine = await placement.lookup(job.id, stranger.assetCode, { shipmentId: truck1.id, who });
    assert.equal(notMine.outcome, "not_on_job");
    assert.deepEqual(notMine.otherJobs.map((j) => j.code), [other.code]);
    const unknown = await placement.lookup(job.id, `NOPE-${tag}`, { who });
    assert.equal(unknown.outcome, "unknown");

    // A card that only looks changes nothing.
    const peek = await placement.lookup(job.id, stranger.assetCode, { record: false, who });
    assert.equal(peek.outcome, "not_on_job");

    // Handling notes come from whoever registers them.
    const unregister = placement.registerHandlingNotes(`test-${tag}`, (refs) =>
      new Map(refs.filter((r) => r.itemId === chair.id).map((r) => [placement.handlingKey(r), ["Fragile"]])),
    );
    assert.deepEqual((await placement.lookup(job.id, chair.assetCode, { who })).handlingNotes, ["Fragile"]);
    unregister();

    // Placed here.
    const placedHere = await placement.placeLines(job.id, [card.line!.id], { code: chair.assetCode, who });
    assert.equal(placedHere.placed.length, 1);
    assert.equal(placedHere.placed[0]!.stage, "placed");

    // Sweep 5.12: the desk belongs, the lamp does not.
    const sweep = await placement.sweep(job.id, { locationId: r512, codes: [desk.assetCode, lamp.assetCode, stranger.assetCode], who });
    assert.deepEqual(
      sweep.entries.map((e) => [e.item?.id, e.outcome]),
      [
        [desk.id, "placed"],
        [lamp.id, "misplaced"],
        [stranger.id, "not_on_job"],
      ],
    );
    assert.deepEqual(sweep.status.belongs, { total: 1, placed: 1 });
    assert.deepEqual(sweep.status.extras.map((l) => l.itemId), [lamp.id]);
    assert.equal(sweep.status.extrasByDestination[0]!.destination!.id, r514);
    const lampNow = sweep.entries[1]!.line!;
    assert.equal(lampNow.stage, "misplaced");
    assert.equal(lampNow.lastActual!.id, r512);

    // Readers: the worker's first run only sets its starting point.
    await placement.processNewSightings({ settleSeconds: 0 });
    resetIngestState();
    const reader514 = (await tracking.createDevice({ kind: "rfid_reader", name: `5.14 ${tag}`, locationId: r514 }, {}))
      .device;
    const reader512 = (await tracking.createDevice({ kind: "rfid_reader", name: `5.12 ${tag}`, locationId: r512 }, {}))
      .device;
    const dockReader = (await tracking.createDevice({ kind: "rfid_reader", name: `Dock ${tag}`, locationId: dock }, {}))
      .device;
    const row = (id: string) => tracking.getDeviceRow(id);

    // The lamp turns up in its room; the bin is read in the wrong room, and at the dock.
    await tracking.recordSightings(await row(reader514.id), [{ code: lamp.assetCode }]);
    await tracking.recordSightings(await row(reader512.id), [{ code: bin.assetCode }]);
    await tracking.recordSightings(await row(dockReader.id), [{ code: bin.assetCode }]);
    // Reads a moment old wait, so a batch still committing is not skipped.
    const early = await placement.processNewSightings({ settleSeconds: 60 });
    assert.equal(early!.reads, 0);
    const run = await placement.processNewSightings({ settleSeconds: 0 });
    assert.ok(run);
    assert.equal(run.placed, 1);
    assert.equal(run.misplaced, 1);
    const progress = await placement.jobProgress(job.id);
    const stageOf = (itemId: string) => progress.remaining.concat().find((l) => l.itemId === itemId)?.stage ?? "placed";
    assert.equal(stageOf(lamp.id), "placed");
    assert.equal(stageOf(bin.id), "misplaced");
    assert.equal(progress.misplaced[0]!.lastActual!.id, r512);

    // Reading the bin again in the same room changes nothing; a reader that
    // is switched off for placement is ignored.
    resetIngestState();
    await tracking.recordSightings(await row(reader512.id), [{ code: bin.assetCode }]);
    assert.equal((await placement.processNewSightings({ settleSeconds: 0 }))!.misplaced, 0);
    await placement.setReaderPlacement(reader514.id, { confirm: false });
    resetIngestState();
    await tracking.recordSightings(await row(reader514.id), [{ code: bin.assetCode }]);
    assert.equal((await placement.processNewSightings({ settleSeconds: 0 }))!.placed, 0);
    await placement.setReaderPlacement(reader514.id, { confirm: true });
    const status = await placement.readersStatus();
    const r = status.readers.find((d) => d.id === reader514.id)!;
    assert.equal(r.confirm, true);
    assert.equal(r.zone!.id, r514);
    assert.equal((await tracking.getDeviceRow(reader514.id)).locationId, r514, "device settings merge, not replace");

    resetIngestState();
    await tracking.recordSightings(await row(reader514.id), [{ code: bin.assetCode }]);
    assert.equal((await placement.processNewSightings({ settleSeconds: 0 }))!.placed, 1);

    // Stage history: every outcome is recorded through the jobs core.
    const history = await jobs.stageHistory(job.id, 100);
    const vias = new Set(history.map((h) => `${h.toStage}:${h.via}`));
    for (const v of ["wrong_shipment:scan", "placed:scan", "placed:sweep", "misplaced:sweep", "placed:reader", "misplaced:reader"]) {
      assert.ok(vias.has(v), `history has ${v}`);
    }
    assert.ok(history.some((h) => h.via === "reader" && h.deviceId === reader514.id));

    // Bluetooth room presence is only used when that feature is installed.
    assert.equal(await placement.bleAvailable(), false);

    // Progress and what is left once the truck is delivered.
    const done = await placement.jobProgress(job.id);
    assert.equal(done.overall.total, 4);
    assert.equal(done.overall.placed, 4);
    assert.equal(done.byFloor[0]!.floor, "Level 5");
    assert.deepEqual(
      done.byRoom.map((g) => [g.destination!.id, g.tally.placed, g.tally.total]),
      [
        [r512, 1, 1],
        [r514, 3, 3],
      ],
    );

    const late = await item("Late box", finance);
    await jobs.addItemsByCodes(job.id, [late.assetCode], { destinationLocationId: r514, shipmentId: truck2.id }, actor);
    await jobs.setShipmentStatus(truck2.id, "delivered", { force: true, reason: "Test" }, actor);
    const risk = await placement.jobProgress(job.id);
    assert.deepEqual(risk.afterDelivery.map((l) => [l.itemId, l.reason]), [[late.id, "not_unloaded"]]);
    const missing = await placement.markMissing(job.id, [risk.afterDelivery[0]!.id], who);
    assert.equal(missing.missing, 1);

    // The kiosk at the Level 5 entrance: what just came through, and whether
    // it belongs on this floor.
    const plant = await item("Plant", finance);
    const crate = await item("Crate", finance);
    await jobs.addItemsByCodes(job.id, [plant.assetCode], { destinationLocationId: r512 }, actor);
    await jobs.addItemsByCodes(job.id, [crate.assetCode], { destinationLocationId: dock }, actor);
    const entrance = (
      await tracking.createDevice({ kind: "rfid_reader", name: `Level 5 door ${tag}`, locationId: level5 }, {})
    ).device;
    await tracking.recordSightings(await row(entrance.id), [
      { code: plant.assetCode },
      { code: crate.assetCode },
      { code: stranger.assetCode },
      { code: `E200${Date.now().toString(16)}` },
    ]);
    const kiosk = await placement.kioskFeed(job.id, { deviceId: entrance.id });
    assert.equal(kiosk.zone!.id, level5);
    assert.deepEqual(
      kiosk.entries.map((e) => [e.itemId, e.outcome]),
      [
        [plant.id, "this_way"],
        [crate.id, "elsewhere"],
        [stranger.id, "not_on_job"],
      ],
    );
    assert.equal(kiosk.entries[2]!.otherJobs[0]!.code, other.code);
    assert.equal(kiosk.unknown, 1);
    const more = await placement.kioskFeed(job.id, { deviceId: entrance.id, since: kiosk.cursor });
    assert.equal(more.entries.length, 0);
    // A reader on the right floor, but not in the room, places nothing.
    assert.equal((await placement.processNewSightings({ settleSeconds: 0 }))!.placed, 0);

    // Floor colours per job.
    await placement.setFloorColors(job.id, { "Level 5": "#123456" });
    assert.equal((await placement.jobProgress(job.id)).byFloor[0]!.color, "#123456");

    const log = await placement.listObservations(job.id, await placement.loadTree(), 100);
    assert.ok(log.some((o) => o.outcome === "wrong_job" && o.otherJob?.code === other.code));
    assert.ok(log.some((o) => o.outcome === "misplaced" && o.actual?.id === r512));

    // A backup round-trips placement, and new observations still insert after it.
    const { buildBackup, restoreBackup } = await import("../src/services/backup");
    const backup = JSON.parse(JSON.stringify(await buildBackup()));
    assert.ok(backup.counts.placement_observations >= log.length);
    assert.equal(backup.counts.placement_room_map >= 1, true);
    const restored = await restoreBackup(backup);
    assert.equal(restored.restored.placement_observations, backup.counts.placement_observations);
    assert.deepEqual((await placement.getRoomMap(job.id)).map((m) => m.destination.id), [r514]);
    placement.forgetTree();
    const after = await placement.lookup(job.id, stranger.assetCode, { who });
    assert.equal(after.outcome, "not_on_job");
  });
});
