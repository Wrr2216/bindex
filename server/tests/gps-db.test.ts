import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DELIVERY_RUN_GPX, DEPOT, SITE, WAREHOUSE, parseGpx } from "./gps-fixtures";

/**
 * The acceptance run against a real Postgres: a recorded trip replayed through
 * the OsmAnd endpoint over HTTP, exactly as Traccar Client would send it.
 * Skipped unless TEST_DATABASE_URL points at a database this test may write
 * to, for example:
 *
 *   createdb bindex_gps
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_gps pnpm --filter bindex-server test
 *
 * Migrations are applied first. It switches tracking, GPS and jobs on in that
 * database, names everything it creates with a random tag, and removes its
 * job, fences and trackers at the end.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "warn";

type Gps = typeof import("../src/services/gps");
type Tracking = typeof import("../src/services/tracking");
type Jobs = typeof import("../src/services/jobs-core");

describe("GPS against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let gps: Gps;
  let tracking: Tracking;
  let jobs: Jobs;
  let pool: typeof import("../src/db/client").pool;
  let server: Server;
  let base = "";
  const tag = randomBytes(3).toString("hex");
  const actor = { userOid: "test:gps", name: "GPS test" };
  // The recorded trip is replayed at a random longitude, at its own latitude
  // so distances are unchanged, clear of fences anything else left behind.
  const shiftLng = 20 + Math.random() * 140;
  const away = <T extends { lat: number; lng: number }>(p: T): T => ({ ...p, lng: p.lng + shiftLng });
  const cleanup: (() => Promise<unknown>)[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows as T[];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    ({ pool } = await import("../src/db/client"));
    gps = await import("../src/services/gps");
    tracking = await import("../src/services/tracking");
    jobs = await import("../src/services/jobs-core");
    const { updateConfig } = await import("../src/services/config");
    await updateConfig({ features: { tracking: true, gps: true, jobs: true } });
    const { wireJobEvents } = await import("../src/services/integration/jobEvents");
    wireJobEvents();

    const express = (await import("express")).default;
    const { deviceRouter } = await import("../src/routes/device");
    const { gpsDeviceRouter } = await import("../src/routes/gps");
    const { HttpError } = await import("../src/lib/errors");
    const app = express();
    app.use("/api/device", deviceRouter);
    app.use("/api/device/gps", gpsDeviceRouter);
    app.use(((err, _req, res, _next) => {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message, code: err.code });
      else res.status(500).json({ error: String(err) });
    }) as import("express").ErrorRequestHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    server?.close();
    await pool?.end();
  });

  const circle = async (name: string, at: { lat: number; lng: number }, radiusM: number, locationId: string | null, dwellSeconds: number) => {
    const f = await gps.createGeofence(
      { name: `${name} ${tag}`, kind: "circle", geometry: { type: "Point", coordinates: [at.lng, at.lat] }, radiusM, locationId, dwellSeconds },
      actor,
    );
    cleanup.push(() => gps.deleteGeofence(f.id, actor));
    return f;
  };

  const tracker = async (name: string, input: Partial<Parameters<Tracking["createDevice"]>[0]> = {}) => {
    const { device, token } = await tracking.createDevice({ kind: "gps_tracker", name: `${name} ${tag}`, ...input });
    cleanup.push(() => tracking.deleteDevice(device.id));
    return { device, token: token! };
  };

  it("replays a recorded trip through the OsmAnd endpoint", async () => {
    // Places, fences and the thing being moved.
    const { createLocation } = await import("../src/services/locations");
    const { createItem } = await import("../src/services/items");
    const warehouse = await createLocation({ name: `Warehouse ${tag}` });
    const site = await createLocation({ name: `Site ${tag}` });
    const siteFloor = await createLocation({ name: "Level 2", parentId: site.id });
    const pallet = await createItem({ name: `Pallet ${tag}`, locationId: warehouse.id }, null);
    const origin = await circle("Warehouse yard", away(WAREHOUSE), 300, warehouse.id, 30);
    const destination = await circle("Site gate", away(SITE), 300, site.id, 30);
    const depot = await circle("Depot", away(DEPOT), 150, null, 0);

    const imei = `35693803${randomBytes(4).toString("hex")}`;
    const { device, token } = await tracker("Pallet tracker", { externalId: imei, itemId: pallet.id, updatesLocation: true });
    await gps.updateTrackerSettings(device.id, { singleUse: true });

    // A job from the warehouse to a floor of the site: the site's fence stands for it.
    const job = await jobs.createJob(
      { name: `Delivery ${tag}`, originLocationId: warehouse.id, destinationLocationId: siteFloor.id },
      actor,
    );
    cleanup.push(() => jobs.deleteJob(job.id));
    const truck = await jobs.createShipment({ jobId: job.id, name: "Truck 1" }, actor);
    await jobs.addItemsByCodes(job.id, [pallet.assetCode], {}, actor);
    const loaded = await jobs.advanceStage(job.id, [pallet.assetCode], "loaded", {
      via: "scan",
      shipmentId: truck.id,
      userOid: actor.userOid,
      actor: actor.name,
    });
    assert.equal(loaded.advanced.length, 1);
    const link = await gps.createLink({ deviceId: device.id, shipmentId: truck.id }, actor);
    assert.equal(link.shipmentCode, truck.code);
    assert.equal((await gps.getTracker(device.id)).status, "assigned");

    const auditStart = (await q<{ id: string }>("SELECT COALESCE(max(id), 0) AS id FROM audit_log"))[0]!.id;

    // Replay, shifted so the trip ended an hour ago, one request per fix as
    // Traccar Client sends them. Battery runs down to below the warning level.
    const points = parseGpx(DELIVERY_RUN_GPX);
    assert.equal(points.length, 24);
    const lastTime = Math.max(...points.map((p) => p.time.getTime()));
    // Whole seconds, because the protocol sends epoch seconds.
    const shift = Math.round((Date.now() - 60 * 60_000 - lastTime) / 1000) * 1000;
    const replay = async () => {
      const results = [];
      for (const [i, p] of points.entries()) {
        const qs = new URLSearchParams({
          id: imei,
          lat: String(p.lat),
          lon: String(away(p).lng),
          timestamp: String(Math.round((p.time.getTime() + shift) / 1000)),
          altitude: String(p.ele),
          accuracy: "5",
          speed: "23.2",
          batt: String(40 - i),
        });
        const res = await fetch(`${base}/api/device/gps/osmand?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 200, JSON.stringify(body));
        results.push(body);
      }
      return results;
    };
    const results = await replay();
    const sum = (k: string) => results.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    assert.equal(sum("fixes"), 24);
    assert.equal(sum("accepted"), 22);
    assert.equal(sum("rejected"), 1, "the glitch");
    assert.equal(sum("outOfOrder"), 1, "the late fix");

    // A trail: every believed fix, the late one in its place; the glitch only on request.
    const trail = await gps.trackerTrail(device.id, { from: new Date(Date.now() - 3 * 3600_000) });
    assert.equal(trail.points.length, 23);
    const times = trail.points.map((p) => new Date(p.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(trail.points.filter((p) => p.outOfOrder).length, 1);
    const withRejected = await gps.trackerTrail(device.id, { from: new Date(Date.now() - 3 * 3600_000), includeRejected: true });
    assert.equal(withRejected.points.filter((p) => p.rejected === "jump").length, 1);
    const itemTrail = await gps.itemTrail(pallet.id, { from: new Date(Date.now() - 3 * 3600_000) });
    assert.equal(itemTrail.points.length, 23, "the glitch is attached to no item");

    // One exit from the origin, one entry to the destination, and the depot on the way.
    const crossings = await q<{ geofence_id: string; kind: string; occurred_at: Date; shipment_ids: string[] }>(
      "SELECT geofence_id, kind, occurred_at, shipment_ids FROM geofence_events WHERE device_id = $1 ORDER BY occurred_at",
      [device.id],
    );
    const seen = crossings.map((c) => [c.geofence_id, c.kind]);
    assert.deepEqual(seen, [
      [origin.id, "exited"],
      [depot.id, "entered"],
      [depot.id, "exited"],
      [destination.id, "entered"],
    ]);
    // Dated when the truck crossed, not when the dwell confirmed it.
    assert.equal(crossings[0]!.occurred_at.getTime(), Date.parse("2026-09-26T08:02:00Z") + shift);
    assert.equal(crossings[3]!.occurred_at.getTime(), Date.parse("2026-09-26T08:08:30Z") + shift);
    assert.deepEqual(crossings[0]!.shipment_ids, [truck.id]);

    // The shipment went in transit on leaving, and delivery waits to be confirmed.
    const map = await gps.shipmentMap(truck.id);
    assert.equal(map.shipment.status, "in_transit");
    assert.deepEqual(
      map.history.map((h) => h.toStatus),
      ["planned", "in_transit"],
    );
    assert.equal(map.history[1]!.actor, `GPS: ${device.name}`);
    assert.equal(map.origin?.id, origin.id);
    assert.equal(map.destination?.id, destination.id);
    assert.equal(map.gps.prompt?.status, "delivered");
    assert.equal(map.gps.departedAt, new Date(Date.parse("2026-09-26T08:02:00Z") + shift).toISOString());
    assert.ok(map.gps.travelledM > 4400 && map.gps.travelledM < 5000, `travelled ${map.gps.travelledM} m`);
    assert.equal(map.gps.remainingM, 0);
    assert.deepEqual(map.gps.waypoints.map((w) => w.geofenceId), [depot.id]);
    // The shipment's trail starts when it left: 18 fixes on the road and at the site, and the late one.
    assert.equal(map.trails[0]!.points.length, 19);

    // The pallet arrived where the site's fence says, and its record moved with it.
    const [position] = await q<{ location_id: string }>(
      "SELECT location_id FROM asset_positions WHERE item_id = $1 AND unit_id IS NULL",
      [pallet.id],
    );
    assert.equal(position!.location_id, site.id);
    const [onFile] = await q<{ location_id: string }>("SELECT location_id FROM items WHERE id = $1", [pallet.id]);
    assert.equal(onFile!.location_id, site.id);
    const moves = await q<{ detail: { to: string; applied: boolean } }>(
      "SELECT detail FROM item_events WHERE item_id = $1 AND action = 'moved'",
      [pallet.id],
    );
    assert.deepEqual(
      moves.map((m) => [m.detail.to, m.detail.applied]),
      [[site.id, true]],
    );

    // Events, for webhooks and the portal.
    const events = await q<{ type: string; subject_id: string }>(
      "SELECT type, subject_id FROM audit_log WHERE id > $1 ORDER BY id",
      [auditStart],
    );
    const types = events.map((e) => e.type);
    for (const t of [
      "geofence.exited",
      "geofence.entered",
      "shipment.departed",
      "shipment.status_changed",
      "shipment.waypoint_reached",
      "shipment.arrived",
      "tracker.battery_low",
    ]) {
      assert.ok(types.includes(t), `${t} published`);
    }
    assert.equal(types.filter((t) => t === "tracker.battery_low").length, 1, "warned once");
    assert.equal(types.filter((t) => t === "shipment.departed").length, 1);
    assert.equal(types.filter((t) => t === "shipment.arrived").length, 1);

    // Replaying the same upload again changes nothing: every fix is old news.
    const again = await replay();
    assert.equal(again.reduce((n, r) => n + Number(r.accepted), 0), 0);
    const count = await q<{ n: string }>("SELECT count(*) AS n FROM geofence_events WHERE device_id = $1", [device.id]);
    assert.equal(Number(count[0]!.n), 4);

    // Confirming delivery takes the single-use tracker off, to be returned.
    await jobs.setShipmentStatus(truck.id, "delivered", {}, actor);
    const after = await gps.getTracker(device.id);
    assert.equal(after.status, "awaiting_return");
    assert.equal(after.links[0]!.endReason, "delivered");
    assert.equal((await gps.shipmentMap(truck.id)).gps.prompt, null);
    await assert.rejects(gps.createLink({ deviceId: device.id, shipmentId: truck.id }, actor), /returned/);
    assert.equal((await gps.setTrackerStatus(device.id, "available", actor)).status, "available");
  });

  it("takes positions for many trackers from a Traccar server, and only from a relay", async () => {
    const relay = await tracker("Traccar server", { settings: { gps: { relay: true } } });
    const lone = await tracker("Lone tracker", { externalId: `lone-${tag}` });
    const now = new Date(Date.now() - 60_000).toISOString();
    const message = (uniqueId: string, lat: number) => ({
      position: { latitude: lat, longitude: -0.1, fixTime: now, speed: 0, course: 0, valid: true, attributes: { batteryLevel: 90 } },
      device: { uniqueId, name: `Forwarded ${uniqueId}` },
    });
    const post = (token: string, body: unknown) =>
      fetch(`${base}/api/device/gps/traccar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const ids = [`fwd-a-${tag}`, `fwd-b-${tag}`];
    const res = await post(relay.token, [message(ids[0]!, 51.5), message(ids[1]!, 51.6)]);
    const body = (await res.json()) as Record<string, number>;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.trackers, 2);
    assert.equal(body.accepted, 2);
    const registered = await q<{ id: string; name: string; battery_pct: number }>(
      "SELECT id, name, battery_pct FROM tracking_devices WHERE kind = 'gps_tracker' AND external_id = ANY($1) ORDER BY external_id",
      [ids],
    );
    for (const r of registered) cleanup.push(() => tracking.deleteDevice(r.id));
    assert.deepEqual(
      registered.map((r) => [r.name, r.battery_pct]),
      [
        [`Forwarded ${ids[0]}`, 90],
        [`Forwarded ${ids[1]}`, 90],
      ],
    );

    // A single tracker's token cannot write another tracker's history.
    const refused = await post(lone.token, message(ids[0]!, 51.7));
    assert.equal(refused.status, 403);
    const own = await post(lone.token, message(`lone-${tag}`, 51.7));
    assert.equal(own.status, 200);
  });

  it("keeps an asset in its room when a site's fence says it is on the site", async () => {
    const { createLocation } = await import("../src/services/locations");
    const { createItem } = await import("../src/services/items");
    const depot = await createLocation({ name: `Depot ${tag}` });
    const bay = await createLocation({ name: "Bay 4", parentId: depot.id });
    const forklift = await createItem({ name: `Forklift ${tag}`, locationId: bay.id }, null);
    const at = away({ lat: -33.86, lng: 0 });
    await circle("Depot yard", at, 400, depot.id, 0);
    const { device, token } = await tracker("Forklift tracker", { itemId: forklift.id, updatesLocation: true });
    const t = Math.round(Date.now() / 1000) - 120;
    for (const [i, lat] of [at.lat, at.lat + 0.0001].entries()) {
      const res = await fetch(
        `${base}/api/device/gps/osmand?token=${token}&lat=${lat}&lon=${at.lng}&timestamp=${t + i * 60}&accuracy=5`,
      );
      assert.equal(res.status, 200);
    }
    const [position] = await q<{ location_id: string }>(
      "SELECT location_id FROM asset_positions WHERE item_id = $1",
      [forklift.id],
    );
    assert.equal(position!.location_id, bay.id);
    const [onFile] = await q<{ location_id: string }>("SELECT location_id FROM items WHERE id = $1", [forklift.id]);
    assert.equal(onFile!.location_id, bay.id);
    const moves = await q("SELECT 1 FROM item_events WHERE item_id = $1 AND action = 'moved'", [forklift.id]);
    assert.equal(moves.length, 0);
    assert.equal((await gps.getTracker(device.id)).lastFixLat, at.lat + 0.0001);
  });

  it("answers 503 while GPS is switched off", async () => {
    const { updateConfig } = await import("../src/services/config");
    await updateConfig({ features: { gps: false } });
    try {
      const res = await fetch(`${base}/api/device/gps/osmand?id=x&lat=1&lon=2`);
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "gps_disabled");
    } finally {
      await updateConfig({ features: { gps: true } });
    }
  });
});
