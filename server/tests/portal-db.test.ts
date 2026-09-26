import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

/**
 * The portal against a real Postgres, through HTTP: every portal route is
 * called with links scoped to one shipment, one job and nothing at all, and
 * each answer is checked for what must not be in it. Opt-in, because CI has
 * no database:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_portal \
 *     pnpm --filter bindex-server test
 *
 * It switches the portal on in that database, makes its own uniquely named
 * records and deletes its jobs at the end.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
// No SMTP_URL: mail goes through the capture transport set below, or nowhere.
delete process.env.SMTP_URL;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

type Json = Record<string, unknown> & { code?: string };

describe("portal against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let server: Server;
  let base = "";
  let portal: typeof import("../src/services/portal");
  let core: typeof import("../src/services/jobs-core");
  let media: typeof import("../src/services/media-ai-core");
  let pool: typeof import("../src/db/client").pool;
  let db: typeof import("../src/db/client").db;
  let updateConfig: typeof import("../src/services/config").updateConfig;
  const tag = `p${Date.now().toString(36)}`;
  const actor = { userOid: "test:portal", name: "Portal test" };
  const cleanup: (() => Promise<unknown>)[] = [];
  const mail: { to: string; subject: string; text: string }[] = [];
  let ipSeq = 1;
  const nextIp = () => `10.99.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

  // The world: one job with shipments A and B and a line on neither, and a
  // second job with shipment C. Links are made for A, for the first job, and
  // for nothing in particular.
  const w = {} as {
    job1: { id: string; code: string };
    job2: { id: string; code: string };
    shipA: { id: string; code: string };
    shipB: { id: string; code: string };
    shipC: { id: string; code: string };
    a1: { id: string; assetCode: string; name: string };
    a2: { id: string; assetCode: string; name: string };
    hv: { id: string; assetCode: string; name: string };
    b1: { id: string; assetCode: string; name: string };
    u1: { id: string; assetCode: string; name: string };
    o1: { id: string; assetCode: string; name: string };
    line: Record<"a1" | "a2" | "hv" | "b1" | "u1" | "o1", string>;
    photoA1: string;
    labelA1: string;
    photoB1: string;
    docA: string;
    docB: string;
    docJob1: string;
    viewerA: string;
    crewA: string;
    crewJob: string;
    viewerAId: string;
    crewAId: string;
  };

  async function call(
    method: string,
    path: string,
    opts: { token?: string | null; pass?: string; body?: unknown; raw?: Buffer; ip?: string; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp(), ...(opts.headers ?? {}) };
    if (opts.token) headers["x-portal-token"] = opts.token;
    if (opts.pass) headers["x-portal-pass"] = opts.pass;
    let body: Buffer | string | undefined;
    if (opts.raw) {
      headers["content-type"] = "application/octet-stream";
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    const json = type.includes("json") ? (JSON.parse(buf.toString("utf8")) as Json) : null;
    assert.equal(res.headers.get("set-cookie"), null, `${method} ${path} must not set a cookie`);
    return { status: res.status, json, buf, headers: res.headers, text: buf.toString("utf8") };
  }

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    const express = (await import("express")).default;
    const { HttpError } = await import("../src/lib/errors");
    const routes = await import("../src/routes/portal");
    portal = await import("../src/services/portal");
    core = await import("../src/services/jobs-core");
    media = await import("../src/services/media-ai-core");
    ({ pool, db } = await import("../src/db/client"));
    ({ updateConfig } = await import("../src/services/config"));
    const { createLocation } = await import("../src/services/locations");
    const { createItem } = await import("../src/services/items");

    await updateConfig({ features: { portal: true, jobs: true } });
    // The real server joins jobs to the event bus at boot; milestones need it.
    (await import("../src/services/integration/jobEvents")).wireJobEvents();
    portal.setMailTransport({
      sendMail: async (m) => {
        mail.push({ to: m.to, subject: m.subject, text: m.text });
      },
    });

    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/portal", routes.portalRouter);
    // Administrators come through the session in the real server; here a
    // stand-in session carries an admin.
    app.use(
      "/api/portal-grants",
      (req, _res, next) => {
        (req as unknown as { session: unknown }).session = {
          user: { oid: "local:portal-test-admin", role: "admin", name: "Admin", email: "admin@example.com" },
        };
        next();
      },
      routes.portalAdminRouter,
    );
    app.use(((err, _req, res, _next) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(err);
      res.status(500).json({ error: "Internal server error", code: "internal" });
    }) as import("express").ErrorRequestHandler);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const site = await createLocation({ name: `Portal site ${tag}` });
    const room101 = await createLocation({ name: `Room 101 ${tag}`, parentId: site.id });
    const item = async (name: string, valueCents?: number) => {
      const it = await createItem({ name: `${name} ${tag}`, locationId: site.id, valueCents }, null);
      return { id: it.id, assetCode: it.assetCode, name: it.name };
    };
    w.a1 = await item("Chair");
    w.a2 = await item("Desk");
    w.hv = await item("Server rack", 2_500_000);
    w.b1 = await item("Bravo cabinet");
    w.u1 = await item("Unassigned lamp");
    w.o1 = await item("Other job printer");

    const job1 = await core.createJob({ name: `Portal job ${tag}` }, actor);
    const job2 = await core.createJob({ name: `Other job ${tag}` }, actor);
    cleanup.push(() => core.deleteJob(job1.id), () => core.deleteJob(job2.id));
    w.job1 = { id: job1.id, code: job1.code };
    w.job2 = { id: job2.id, code: job2.code };
    const shipA = await core.createShipment({ jobId: job1.id, name: "Alpha truck", sealNumbers: ["SEAL-A"], weightKg: 1200, eta: new Date(Date.now() + 86_400_000).toISOString() }, actor);
    const shipB = await core.createShipment({ jobId: job1.id, name: "Bravo truck", sealNumbers: ["SEAL-B"] }, actor);
    const shipC = await core.createShipment({ jobId: job2.id, name: "Charlie truck" }, actor);
    w.shipA = { id: shipA.id, code: shipA.code };
    w.shipB = { id: shipB.id, code: shipB.code };
    w.shipC = { id: shipC.id, code: shipC.code };

    await core.addItemsByCodes(job1.id, [w.a1.assetCode, w.a2.assetCode], { shipmentId: shipA.id, destinationLocationId: room101.id, floor: "1" }, actor);
    await core.addItemsByCodes(job1.id, [w.hv.assetCode], { shipmentId: shipA.id, destinationLabel: "Comms room", notes: "Two people to lift" }, actor);
    await core.addItemsByCodes(job1.id, [w.b1.assetCode], { shipmentId: shipB.id, destinationLabel: `Bravo room ${tag}` }, actor);
    await core.addItemsByCodes(job1.id, [w.u1.assetCode], {}, actor);
    await core.addItemsByCodes(job2.id, [w.o1.assetCode], { shipmentId: shipC.id }, actor);
    const lines1 = (await core.listJobItems(job1.id)).lines;
    const lines2 = (await core.listJobItems(job2.id)).lines;
    const lineOf = (itemId: string) => [...lines1, ...lines2].find((l) => l.itemId === itemId)!.id;
    w.line = {
      a1: lineOf(w.a1.id),
      a2: lineOf(w.a2.id),
      hv: lineOf(w.hv.id),
      b1: lineOf(w.b1.id),
      u1: lineOf(w.u1.id),
      o1: lineOf(w.o1.id),
    };

    const save = (ownerType: string, ownerId: string, bytes: Buffer, stage: string | null, kind?: "photo" | "document") =>
      media
        .saveAttachment({ ownerType, ownerId, bytes, stage, kind, mime: kind === "document" ? "application/pdf" : "image/png", createdBy: "test:portal" })
        .then((a) => a.id);
    w.photoA1 = await save("item", w.a1.id, PNG, "condition");
    w.labelA1 = await save("item", w.a1.id, PNG, "label");
    w.photoB1 = await save("item", w.b1.id, PNG, "condition");
    w.docA = await save("shipment", shipA.id, PDF, null, "document");
    w.docB = await save("shipment", shipB.id, PDF, null, "document");
    w.docJob1 = await save("job", job1.id, PDF, null, "document");

    const expires = new Date(Date.now() + 7 * 86_400_000);
    const issue = (input: Partial<import("../src/services/portal").GrantInput> & Pick<import("../src/services/portal").GrantInput, "scope" | "targetId">) =>
      portal.createGrant({ role: "viewer", granteeName: "Test grantee", expiresAt: expires, ...input }, "local:portal-test-admin");
    const viewerA = await issue({ scope: "shipment", targetId: shipA.id, granteeName: "Acme Facilities", granteeEmail: "fm@example.com" });
    const crewA = await issue({ scope: "shipment", targetId: shipA.id, role: "contributor", granteeName: "Dana Driver", granteeOrg: "Fast Movers" });
    const crewJob = await issue({ scope: "job", targetId: job1.id, role: "contributor", granteeName: "Job crew" });
    w.viewerA = viewerA.token;
    w.viewerAId = viewerA.grant.id;
    w.crewA = crewA.token;
    w.crewAId = crewA.grant.id;
    w.crewJob = crewJob.token;
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    server?.close();
    await pool?.end();
  });

  /** Everything that belongs to shipment B, job 2 or the unassigned line. */
  const outsideA = () => [
    w.shipB.id,
    w.shipB.code,
    w.shipC.id,
    w.shipC.code,
    w.job2.id,
    w.job2.code,
    w.b1.id,
    w.b1.assetCode,
    w.b1.name,
    w.u1.id,
    w.u1.assetCode,
    w.o1.id,
    w.o1.assetCode,
    w.line.b1,
    w.line.u1,
    w.line.o1,
    w.photoB1,
    w.labelA1,
    w.docB,
    w.docJob1,
    "SEAL-B",
    "Bravo",
  ];

  function assertNothingOutsideA(text: string, where: string) {
    for (const s of outsideA()) assert.ok(!text.includes(s), `${where} leaked ${s}`);
  }

  it("a viewer link shows exactly one shipment and nothing else, on every read route", async () => {
    const reads = [
      "/api/portal/session",
      "/api/portal/overview",
      "/api/portal/items",
      "/api/portal/items?q=truck",
      `/api/portal/items?q=${encodeURIComponent(w.b1.assetCode)}`,
      "/api/portal/items?flag=flagged",
      `/api/portal/items/${w.line.a1}`,
      "/api/portal/flagged",
      "/api/portal/documents",
    ];
    for (const path of reads) {
      const r = await call("GET", path, { token: w.viewerA });
      assert.equal(r.status, 200, `${path}: ${r.text}`);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assertNothingOutsideA(r.text, path);
      // The link may not see values, so none are sent.
      assert.ok(!r.text.includes("valueCents"), `${path} sent a value`);
      assert.ok(!r.text.includes("2500000"), `${path} sent the amount`);
    }

    const session = (await call("GET", "/api/portal/session", { token: w.viewerA })).json!;
    assert.equal(session.role, "viewer");
    assert.deepEqual((session.scope as Json).code, w.shipA.code);
    assert.equal(session.email, "f***@example.com");

    const overview = (await call("GET", "/api/portal/overview", { token: w.viewerA })).json!;
    const ships = overview.shipments as Json[];
    assert.deepEqual(ships.map((s) => s.code), [w.shipA.code]);
    assert.deepEqual(ships[0]!.sealNumbers, ["SEAL-A"]);
    assert.equal((overview.progress as Json).total, 3);
    const keys = (overview.milestones as Json[]).map((m) => m.key);
    assert.deepEqual(keys, ["created", "packed", "loaded", "in_transit", "arrived", "delivered", "placed"]);

    const items = (await call("GET", "/api/portal/items", { token: w.viewerA })).json!;
    assert.equal(items.total, 3);
    const names = (items.lines as Json[]).map((l) => l.itemName).sort();
    assert.deepEqual(names, [w.a1.name, w.a2.name, w.hv.name].sort());
    const rooms = ((items.facets as Json).rooms as Json[]).map((r) => r.room);
    assert.ok(rooms.includes("Comms room"));

    const flagged = (await call("GET", "/api/portal/flagged", { token: w.viewerA })).json!;
    const hv = (flagged.lines as Json[]).find((l) => l.itemName === w.hv.name)!;
    assert.deepEqual(hv.flags, { highValue: true, exception: false, conditionNoted: false, handling: true });

    const detail = (await call("GET", `/api/portal/items/${w.line.a1}`, { token: w.viewerA })).json!;
    assert.deepEqual((detail.photos as Json[]).map((p) => p.id), [w.photoA1]);

    const docs = (await call("GET", "/api/portal/documents", { token: w.viewerA })).json!;
    assert.deepEqual((docs.documents as Json[]).map((d) => d.id), [w.docA]);
  });

  it("refuses ids from outside the scope on every route that takes one", async () => {
    for (const id of [w.line.b1, w.line.u1, w.line.o1, "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      const r = await call("GET", `/api/portal/items/${id}`, { token: w.viewerA });
      assert.equal(r.status, 404, id);
      assertNothingOutsideA(r.text, `items/${id}`);
    }
    for (const id of [w.photoB1, w.labelA1, w.docB, w.docJob1, "nope"]) {
      const r = await call("GET", `/api/portal/files/${id}`, { token: w.viewerA });
      assert.equal(r.status, 404, `file ${id}`);
    }
    for (const id of [w.photoA1, w.docA]) {
      const r = await call("GET", `/api/portal/files/${id}`, { token: w.viewerA });
      assert.equal(r.status, 200, `file ${id}`);
    }
    const thumb = await call("GET", `/api/portal/files/${w.photoA1}?thumb=128`, { token: w.viewerA });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");

    assert.equal((await call("GET", `/api/portal/items?shipmentId=${w.shipB.id}`, { token: w.viewerA })).status, 404);
    // Crew links on A cannot write to B's lines either.
    assert.equal((await call("POST", `/api/portal/items/${w.line.b1}/notes`, { token: w.crewA, body: { body: "x" } })).status, 404);
    assert.equal((await call("POST", `/api/portal/items/${w.line.b1}/photos?type=image/png`, { token: w.crewA, raw: PNG })).status, 404);
    assert.equal(
      (await call("POST", "/api/portal/scan", { token: w.crewA, body: { codes: [w.a1.assetCode], stage: "packed", shipmentId: w.shipB.id } })).status,
      404,
    );
    assert.equal((await call("POST", "/api/portal/handoff", { token: w.crewA, body: { signerName: "D", image: `data:image/png;base64,${PNG.toString("base64")}`, shipmentId: w.shipB.id } })).status, 404);
    // Unknown portal paths end in the portal, not the main API.
    const stray = await call("GET", "/api/portal/nothing-here", { token: w.viewerA });
    assert.deepEqual([stray.status, stray.json!.code], [404, "not_found"]);
  });

  it("a viewer link cannot change anything", async () => {
    const writes: [string, string, { body?: unknown; raw?: Buffer }][] = [
      ["POST", "/api/portal/scan", { body: { codes: [w.a1.assetCode], stage: "packed" } }],
      ["POST", `/api/portal/items/${w.line.a1}/notes`, { body: { body: "Scratched" } }],
      ["POST", `/api/portal/items/${w.line.a1}/photos?type=image/png`, { raw: PNG }],
      ["POST", "/api/portal/handoff", { body: { signerName: "V", image: `data:image/png;base64,${PNG.toString("base64")}` } }],
    ];
    for (const [method, path, opts] of writes) {
      const r = await call(method, path, { token: w.viewerA, ...opts });
      assert.equal(r.status, 403, `${path}: ${r.text}`);
    }
    const [line] = await db.execute<{ stage: string }>(
      (await import("drizzle-orm")).sql`SELECT stage FROM job_items WHERE id = ${w.line.a1}`,
    ).then((r) => r.rows);
    assert.equal(line!.stage, "pending");
  });

  it("a contributor link advances only its own shipment's lines", async () => {
    const r = await call("POST", "/api/portal/scan", {
      token: w.crewA,
      body: { codes: [w.a1.assetCode, w.b1.assetCode, w.u1.assetCode, w.o1.assetCode, `NOPE-${tag}`], stage: "packed" },
    });
    assert.equal(r.status, 200, r.text);
    const res = r.json!;
    assert.deepEqual((res.advanced as Json[]).map((l) => l.id), [w.line.a1]);
    assert.deepEqual([...(res.notInScope as string[])].sort(), [w.b1.assetCode, w.u1.assetCode, w.o1.assetCode].sort());
    assert.deepEqual(res.unknown, [`NOPE-${tag}`]);
    // Nothing about where the others are: no shipment, job or line of theirs.
    for (const s of [w.shipB.code, w.shipC.code, w.job2.code, w.job2.id, w.line.b1, w.line.u1, w.line.o1, "otherJobs"]) {
      assert.ok(!r.text.includes(s), `scan result leaked ${s}`);
    }

    const { rows } = await pool.query<{ id: string; stage: string; shipment_id: string | null }>(
      "SELECT id, stage, shipment_id FROM job_items WHERE id = ANY($1::uuid[])",
      [[w.line.a1, w.line.b1, w.line.u1, w.line.o1]],
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    assert.equal(byId.get(w.line.a1)!.stage, "packed");
    assert.equal(byId.get(w.line.b1)!.stage, "pending");
    assert.equal(byId.get(w.line.u1)!.stage, "pending");
    assert.equal(byId.get(w.line.u1)!.shipment_id, null, "an unassigned line must not be pulled onto the crew's shipment");
    assert.equal(byId.get(w.line.o1)!.stage, "pending");

    // Attributed to the grant, not a user.
    const hist = await pool.query<{ via: string; user_oid: string | null; actor: string }>(
      "SELECT via, user_oid, actor FROM job_item_stage_history WHERE job_item_id = $1 ORDER BY created_at DESC LIMIT 1",
      [w.line.a1],
    );
    assert.deepEqual(hist.rows[0], { via: "portal", user_oid: null, actor: "Dana Driver, Fast Movers (portal)" });
    const audit = await pool.query<{ actor_id: string; actor_kind: string }>(
      "SELECT actor_id, actor_kind FROM audit_log WHERE type = 'portal.scanned' AND subject_id = $1 ORDER BY id DESC LIMIT 1",
      [w.crewAId],
    );
    assert.deepEqual(audit.rows[0], { actor_id: `portal:${w.crewAId}`, actor_kind: "system" });

    // Stages outside the grant's list, and pending, are refused.
    assert.equal((await call("POST", "/api/portal/scan", { token: w.crewA, body: { codes: [w.a1.assetCode], stage: "pending" } })).status, 400);
    assert.equal((await call("POST", "/api/portal/scan", { token: w.crewA, body: { codes: [w.a1.assetCode], stage: "wrong_shipment" } })).status, 400);
    // Scanning back down the ladder needs force, which a portal never has.
    await call("POST", "/api/portal/scan", { token: w.crewA, body: { codes: [w.a1.assetCode], stage: "loaded" } });
    const back = (await call("POST", "/api/portal/scan", { token: w.crewA, body: { codes: [w.a1.assetCode], stage: "packed" } })).json!;
    assert.equal((back.advanced as Json[]).length, 0);
    assert.equal((back.alreadyAt as Json[]).length, 1);
  });

  it("a job crew link works across its job's shipments, but not other jobs", async () => {
    const r = (await call("POST", "/api/portal/scan", {
      token: w.crewJob,
      body: { codes: [w.u1.assetCode, w.b1.assetCode, w.o1.assetCode], stage: "loaded", shipmentId: w.shipA.id },
    })).json!;
    assert.deepEqual((r.advanced as Json[]).map((l) => l.id), [w.line.u1]);
    assert.deepEqual((r.wrongShipment as Json[]).map((l) => l.shipmentCode), [w.shipB.code]);
    assert.deepEqual(r.notInScope, [w.o1.assetCode]);
    const { rows } = await pool.query<{ shipment_id: string }>("SELECT shipment_id FROM job_items WHERE id = $1", [w.line.u1]);
    assert.equal(rows[0]!.shipment_id, w.shipA.id);
    // Put it back so the shipment links still see three lines.
    await core.updateJobItems(w.job1.id, [w.line.u1], { shipmentId: null });
    assert.equal((await call("POST", "/api/portal/scan", { token: w.crewJob, body: { codes: [w.o1.assetCode], stage: "loaded", shipmentId: w.shipC.id } })).status, 404);
  });

  it("a contributor adds notes, photos and a signed handoff, all attributed to the grant", async () => {
    const note = await call("POST", `/api/portal/items/${w.line.a2}/notes`, {
      token: w.crewA,
      body: { body: "Corner dented", condition: "damaged" },
    });
    assert.equal(note.status, 201, note.text);
    const photo = await call("POST", `/api/portal/items/${w.line.a2}/photos?type=image/png&stage=damage&caption=Dent`, {
      token: w.crewA,
      raw: PNG,
    });
    assert.equal(photo.status, 201, photo.text);
    const saved = await media.getAttachment(photo.json!.id as string);
    assert.equal(saved!.createdBy, `portal:${w.crewAId}`);
    assert.equal(saved!.ownerId, w.a2.id);
    assert.equal((await call("POST", `/api/portal/items/${w.line.a2}/photos?type=image/png&stage=label`, { token: w.crewA, raw: PNG })).status, 400);
    assert.equal((await call("POST", `/api/portal/items/${w.line.a2}/photos?type=application/pdf`, { token: w.crewA, raw: PDF })).status, 400);

    // The viewer now sees the note and the damage photo, and the line is flagged.
    const flagged = (await call("GET", "/api/portal/flagged", { token: w.viewerA })).json!;
    const a2 = (flagged.lines as Json[]).find((l) => l.id === w.line.a2)!;
    assert.equal((a2.flags as Json).conditionNoted, true);
    assert.deepEqual(a2.photoIds, [photo.json!.id]);
    const detail = (await call("GET", `/api/portal/items/${w.line.a2}`, { token: w.viewerA })).json!;
    assert.equal((detail.notes as Json[])[0]!.body, "Corner dented");
    assert.equal((detail.notes as Json[])[0]!.mine, false);

    const signed = await call("POST", "/api/portal/handoff", {
      token: w.crewA,
      body: { signerName: "Dana Driver", signerRole: "Driver", image: `data:image/png;base64,${PNG.toString("base64")}` },
    });
    assert.equal(signed.status, 201, signed.text);
    const sigs = await media.listSignatures("shipment", w.shipA.id);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0]!.signedByUser, null);
    const content = (await media.getSignedContent(sigs[0]!.id)) as { grant: { id: string }; count: number };
    assert.equal(content.grant.id, w.crewAId);
    assert.equal(content.count, 3);
    // The receipt is shared with the shipment's viewer, and its image fetches.
    const docs = (await call("GET", "/api/portal/documents", { token: w.viewerA })).json!;
    const receipt = (docs.receipts as Json[])[0]!;
    assert.equal(receipt.signerName, "Dana Driver");
    assert.ok(!JSON.stringify(receipt).includes("userAgent"));
    assert.equal((await call("GET", `/api/portal/files/${receipt.imageId}`, { token: w.viewerA })).status, 200);
  });

  it("fails closed for missing, malformed, unknown, expired and revoked links", async () => {
    const expired = await portal.createGrant(
      { scope: "shipment", targetId: w.shipA.id, role: "viewer", granteeName: "Late", expiresAt: new Date(Date.now() + 60_000) },
      "local:portal-test-admin",
    );
    await pool.query("UPDATE portal_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.grant.id]);
    // A new token for an expired link would be a link that never works.
    await assert.rejects(portal.reissueGrant(expired.grant.id, "local:portal-test-admin"), /expired/);
    const revoked = await portal.createGrant(
      { scope: "shipment", targetId: w.shipA.id, role: "contributor", granteeName: "Gone", expiresAt: new Date(Date.now() + 60_000) },
      "local:portal-test-admin",
    );
    await portal.revokeGrant(revoked.grant.id, "local:portal-test-admin");

    const cases: [string | null, number, string][] = [
      [null, 401, "link_invalid"],
      ["bdxp_short", 401, "link_invalid"],
      [`bdxp_${"A".repeat(43)}`, 401, "link_invalid"],
      [expired.token, 401, "link_expired"],
      [revoked.token, 401, "link_revoked"],
    ];
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/portal/session"],
      ["GET", "/api/portal/overview"],
      ["GET", "/api/portal/items"],
      ["GET", `/api/portal/items/${w.line.a1}`],
      ["GET", "/api/portal/flagged"],
      ["GET", "/api/portal/documents"],
      ["GET", `/api/portal/files/${w.photoA1}`],
      ["POST", "/api/portal/scan", { codes: [w.a1.assetCode], stage: "delivered" }],
      ["POST", `/api/portal/items/${w.line.a1}/notes`, { body: "x" }],
      ["POST", "/api/portal/handoff", { signerName: "x", image: "data:image/png;base64,AA==" }],
      ["POST", "/api/portal/notifications", { enabled: true }],
      ["POST", "/api/portal/code", {}],
    ];
    for (const [token, status, code] of cases) {
      const ip = nextIp();
      for (const [method, path, body] of routes) {
        const r = await call(method, path, { token, body, ip });
        assert.equal(r.status, status, `${token?.slice(0, 12)} ${method} ${path}: ${r.text}`);
        assert.equal(r.json!.code, code);
      }
    }
    const { rows } = await pool.query<{ stage: string }>("SELECT stage FROM job_items WHERE id = $1", [w.line.a1]);
    assert.notEqual(rows[0]!.stage, "delivered");

    // Refusals from one address are rate limited.
    const ip = nextIp();
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await call("GET", "/api/portal/session", { token: `bdxp_${"B".repeat(43)}`, ip })).status;
    assert.equal(last, 429);
  });

  it("asks for an emailed code before the first use when the grant requires it", async () => {
    const coded = await portal.createGrant(
      {
        scope: "shipment",
        targetId: w.shipA.id,
        role: "viewer",
        granteeName: "Coded",
        granteeEmail: "coded@example.com",
        requireCode: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      "local:portal-test-admin",
    );
    const ip = nextIp();
    const before = await call("GET", "/api/portal/session", { token: coded.token, ip });
    assert.equal(before.status, 200);
    assert.deepEqual([before.json!.codeRequired, before.json!.verified, before.json!.scope], [true, false, null]);
    assert.equal((await call("GET", "/api/portal/overview", { token: coded.token, ip })).json!.code, "code_required");

    mail.length = 0;
    assert.equal((await call("POST", "/api/portal/code", { token: coded.token, ip })).status, 200);
    const code = /code is (\d{6})/.exec(mail[0]!.text)![1]!;
    assert.equal(mail[0]!.to, "coded@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal((await call("POST", "/api/portal/code/verify", { token: coded.token, body: { code: wrong }, ip })).json!.code, "code_wrong");
    const ok = await call("POST", "/api/portal/code/verify", { token: coded.token, body: { code }, ip });
    assert.equal(ok.status, 200, ok.text);
    const pass = ok.json!.pass as string;
    assert.match(pass, /^bdxs_/);
    // The code is spent.
    assert.equal((await call("POST", "/api/portal/code/verify", { token: coded.token, body: { code }, ip })).status, 401);

    assert.equal((await call("GET", "/api/portal/overview", { token: coded.token, pass, ip })).status, 200);
    // A pass belongs to its own link only.
    assert.equal((await call("GET", "/api/portal/overview", { token: w.viewerA, pass, ip })).status, 200);
    const other = await portal.createGrant(
      { scope: "shipment", targetId: w.shipA.id, role: "viewer", granteeName: "Other", granteeEmail: "o@example.com", requireCode: true, expiresAt: new Date(Date.now() + 86_400_000) },
      "local:portal-test-admin",
    );
    assert.equal((await call("GET", "/api/portal/overview", { token: other.token, pass, ip })).json!.code, "code_required");
    // Reissuing the link drops every verified browser.
    const again = await portal.reissueGrant(coded.grant.id, "local:portal-test-admin");
    assert.equal((await call("GET", "/api/portal/overview", { token: again.token, pass, ip })).json!.code, "code_required");
    assert.equal((await call("GET", "/api/portal/overview", { token: coded.token, pass, ip })).json!.code, "link_invalid");
  });

  it("the stage guard vetoes lines a portal call did not choose", async () => {
    const { withPortalScope, NOT_IN_SCOPE } = await import("../src/services/portal/guard");
    const res = await withPortalScope({ grantId: w.crewAId, jobId: w.job1.id, allowed: new Set([w.line.a2]) }, () =>
      core.setLineStage(w.job1.id, [w.line.a2, w.line.b1], "packed", { via: "portal", actor: "guard test" }),
    );
    assert.deepEqual(res.advanced.map((l) => l.jobItemId), [w.line.a2]);
    assert.deepEqual(res.blocked.map((l) => [l.jobItemId, l.reason]), [[w.line.b1, NOT_IN_SCOPE]]);
    // Outside a portal call the guard stays out of the way.
    const staff = await core.setLineStage(w.job1.id, [w.line.b1], "packed", { via: "manual", ...actor });
    assert.equal(staff.advanced.length, 1);
  });

  it("administrators create, list, change, reissue and revoke links", async () => {
    const base = "/api/portal-grants";
    const created = await call("POST", base, {
      body: {
        scope: "job",
        targetId: w.job1.id,
        role: "contributor",
        granteeName: "Night crew",
        granteeEmail: "",
        expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        allowedStages: ["delivered", "placed"],
        baseUrl: "https://portal.example.com/anything",
      },
    });
    assert.equal(created.status, 201, created.text);
    const id = (created.json!.grant as Json).id as string;
    assert.match(created.json!.url as string, /^https:\/\/portal\.example\.com\/p\/bdxp_/);
    assert.match(created.json!.qr as string, /^data:image\/png;base64,/);
    assert.ok(!created.text.includes("tokenHash"));

    const bad = await call("POST", base, {
      body: { scope: "project", targetId: w.job1.id, role: "contributor", granteeName: "X", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(bad.status, 400);
    const tooLong = await call("POST", base, {
      body: { scope: "job", targetId: w.job1.id, granteeName: "X", expiresAt: new Date(Date.now() + 500 * 86_400_000).toISOString() },
    });
    assert.equal(tooLong.status, 400);
    const codeNoMail = await call("POST", base, {
      body: { scope: "job", targetId: w.job1.id, granteeName: "X", requireCode: true, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(codeNoMail.status, 400);

    const list = (await call("GET", `${base}?targetId=${w.job1.id}&state=active`)).json as unknown as Json[];
    assert.ok(list.some((g) => g.id === id));
    assert.ok(list.every((g) => !("tokenHash" in g)));

    const token = created.json!.token as string;
    const session = (await call("GET", "/api/portal/session", { token })).json!;
    assert.deepEqual(((session.contributor as Json).stages as Json[]).map((s) => s.name), ["delivered", "placed"]);
    assert.equal((await call("POST", "/api/portal/scan", { token, body: { codes: [w.a1.assetCode], stage: "packed" } })).status, 400);

    const patched = await call("PATCH", `${base}/${id}`, { body: { role: "viewer" } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal((patched.json as Json).allowedStages, null);
    assert.equal((await call("POST", "/api/portal/scan", { token, body: { codes: [w.a1.assetCode], stage: "delivered" } })).status, 403);

    const reissued = await call("POST", `${base}/${id}/reissue`, { body: {} });
    assert.equal(reissued.status, 200);
    assert.equal((await call("GET", "/api/portal/session", { token })).json!.code, "link_invalid");
    const fresh = reissued.json!.token as string;
    assert.equal((await call("GET", "/api/portal/session", { token: fresh })).status, 200);

    assert.equal((await call("POST", `${base}/${id}/revoke`)).status, 200);
    assert.equal((await call("GET", "/api/portal/session", { token: fresh })).json!.code, "link_revoked");
    assert.equal((await call("POST", `${base}/${id}/revoke`)).status, 400);

    // Visits and refusals are published without holding up the request.
    await new Promise((r) => setTimeout(r, 300));
    const activity = (await call("GET", `${base}/${id}/activity`)).json!;
    const types = (activity.entries as Json[]).map((e) => e.type);
    for (const t of ["portal.grant_created", "portal.grant_updated", "portal.grant_reissued", "portal.grant_revoked", "portal.accessed", "portal.access_denied"]) {
      assert.ok(types.includes(t), `activity is missing ${t}`);
    }
    const targets = (await call("GET", `${base}/targets?q=${encodeURIComponent(tag)}`)).json as unknown as Json[];
    assert.ok(targets.some((t) => t.id === w.shipA.id && t.jobCode === w.job1.code));
    assert.equal((await call("GET", `${base}/not-a-uuid`)).status, 404);
  });

  it("emails opted-in viewers each milestone once, throttled, and never after revocation", async () => {
    await pool.query("UPDATE portal_grants SET notify = true WHERE id = $1", [w.viewerAId]);
    const t0 = new Date();
    await portal.runNotifierOnce(t0); // first run sets the cursor
    mail.length = 0;
    // Only this run's mail: a database shared with earlier runs may have more.
    const mine = () => mail.filter((m) => m.text.includes(w.shipA.code));

    await core.setShipmentStatus(w.shipA.id, "in_transit", { force: true, reason: "portal test" }, actor);
    await portal.runNotifierOnce(new Date());
    assert.equal(mine().length, 1, JSON.stringify(mail));
    assert.equal(mine()[0]!.to, "fm@example.com");
    assert.match(mine()[0]!.subject, /is on its way/);
    assert.ok(!mine()[0]!.text.includes("bdxp_"), "no link token in a milestone email");

    // Back to loaded and out again: the same milestone, not emailed twice.
    await core.setShipmentStatus(w.shipA.id, "loaded", { force: true, reason: "portal test" }, actor);
    await core.setShipmentStatus(w.shipA.id, "in_transit", { force: true, reason: "portal test" }, actor);
    const { publish } = await import("../src/services/event-backbone");
    // A GPS feature's geofence event, by type name only.
    await publish("geofence.entered", { shipmentId: w.shipA.id, geofenceName: "Depot North" }, { subject: { type: "shipment", id: w.shipA.id } });
    await portal.runNotifierOnce(new Date());
    assert.equal(mine().length, 1, "inside the throttle window nothing more is sent");
    const later = new Date(Date.now() + 16 * 60_000);
    await portal.runNotifierOnce(later);
    assert.equal(mine().length, 2);
    assert.match(mine()[1]!.subject, /arrived at Depot North/);

    // The overview shows the arrival as a location update.
    const overview = (await call("GET", "/api/portal/overview", { token: w.viewerA })).json!;
    assert.ok((overview.updates as Json[]).some((u) => String(u.title).includes("Depot North")));

    // A milestone queued before a revocation is never sent after it.
    await core.setShipmentStatus(w.shipA.id, "delivered", { force: true, reason: "portal test" }, actor);
    await portal.runNotifierOnce(new Date(Date.now() + 17 * 60_000));
    const tmp = await portal.createGrant(
      { scope: "shipment", targetId: w.shipA.id, role: "viewer", granteeName: "Temp", granteeEmail: "t@example.com", notify: true, expiresAt: new Date(Date.now() + 86_400_000) },
      "local:portal-test-admin",
    );
    await core.setShipmentStatus(w.shipA.id, "loaded", { force: true, reason: "portal test" }, actor);
    await core.setShipmentStatus(w.shipA.id, "in_transit", { force: true, reason: "portal test" }, actor);
    const queuedAt = new Date(Date.now() + 40 * 60_000);
    await pool.query("UPDATE portal_notifications SET status = 'pending' WHERE grant_id = $1", [tmp.grant.id]);
    await portal.revokeGrant(tmp.grant.id, "local:portal-test-admin");
    const before = mail.length;
    await portal.runNotifierOnce(queuedAt);
    assert.ok(mail.slice(before).every((m) => m.to !== "t@example.com"));
  });

  it("backs up grants without their tokens and never restores a revoked link", async () => {
    const { sql } = await import("drizzle-orm");
    const exported = await portal.exportPortalTables();
    assert.ok(exported.portal_grants.length > 0);
    assert.ok(exported.portal_grants.every((g) => !("tokenHash" in g)));
    // Revoked after the backup was taken.
    await portal.revokeGrant(w.viewerAId, "local:portal-test-admin");
    const rollback = new Error("rollback");
    await assert.rejects(
      db.transaction(async (tx) => {
        await portal.keepPortalSecrets(tx);
        await portal.restorePortalTables(tx, exported);
        const { rows } = await tx.execute<{ id: string; token_hash: string | null; revoked_at: Date | null }>(
          sql`SELECT id, token_hash, revoked_at FROM portal_grants WHERE id IN (${w.viewerAId}, ${w.crewAId})`,
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        assert.ok(byId.get(w.viewerAId)!.token_hash, "a surviving grant keeps its token");
        assert.ok(byId.get(w.viewerAId)!.revoked_at, "and stays revoked");
        assert.equal(byId.get(w.crewAId)!.revoked_at, null);
        const notes = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM portal_notes WHERE grant_id = ${w.crewAId}`);
        assert.equal(notes.rows[0]!.n, 1);
        throw rollback;
      }),
      (err) => err === rollback,
    );
    // The revoked viewer link fails closed.
    assert.equal((await call("GET", "/api/portal/session", { token: w.viewerA })).json!.code, "link_revoked");
  });

  it("a project link covers its jobs' lines and shipments, and no other job's", async () => {
    const project = await core.createProject({ name: `Portal project ${tag}` }, actor);
    // Cleanup runs last-in first: take the job out, then delete the project.
    cleanup.push(() => core.deleteProject(project.id));
    await core.updateJob(w.job1.id, { projectId: project.id }, actor);
    cleanup.push(() => core.updateJob(w.job1.id, { projectId: null }, actor));
    const link = await portal.createGrant(
      { scope: "project", targetId: project.id, role: "viewer", granteeName: "Programme office", expiresAt: new Date(Date.now() + 86_400_000) },
      "local:portal-test-admin",
    );
    const items = await call("GET", "/api/portal/items?limit=200", { token: link.token });
    assert.equal(items.status, 200, items.text);
    const ids = (items.json!.lines as Json[]).map((l) => l.id).sort();
    assert.deepEqual(ids, [w.line.a1, w.line.a2, w.line.hv, w.line.b1, w.line.u1].sort());
    const overview = await call("GET", "/api/portal/overview", { token: link.token });
    assert.deepEqual(((overview.json!.shipments as Json[]).map((s) => s.code)).sort(), [w.shipA.code, w.shipB.code].sort());
    for (const r of [items, overview]) {
      for (const s of [w.job2.id, w.job2.code, w.shipC.code, w.o1.assetCode, w.line.o1]) assert.ok(!r.text.includes(s), `leaked ${s}`);
    }
    assert.equal((await call("GET", `/api/portal/items/${w.line.o1}`, { token: link.token })).status, 404);
    assert.equal((await call("GET", `/api/portal/items/${w.line.b1}`, { token: link.token })).status, 200);
    // The job's own documents are shared with a project link; the other job's are not.
    assert.equal((await call("GET", `/api/portal/files/${w.docJob1}`, { token: link.token })).status, 200);
  });

  it("answers 404 for everything while the portal is switched off", async () => {
    await updateConfig({ features: { portal: false } });
    try {
      const r = await call("GET", "/api/portal/session", { token: w.crewA });
      assert.equal(r.status, 404);
      assert.equal(r.json!.code, "portal_unavailable");
      assert.equal((await call("GET", "/api/portal-grants")).json!.code, "feature_disabled");
    } finally {
      await updateConfig({ features: { portal: true } });
    }
  });
});
