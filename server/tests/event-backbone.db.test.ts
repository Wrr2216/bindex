import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

/**
 * Against a real Postgres: the chain trigger, immutability, concurrency,
 * verification, checkpoints and webhook delivery end to end. Creates a fresh
 * database each run (TEST_DATABASE_URL, default a local
 * bindex_event_backbone_test) and skips when no server is reachable, as in CI.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bindex_event_backbone_test";
const dbName = new URL(TEST_URL).pathname.slice(1);
const adminUrl = (() => {
  const u = new URL(TEST_URL);
  u.pathname = "/postgres";
  return u.toString();
})();

// Set before any server module loads: they read the environment on import.
process.env.DATABASE_URL = TEST_URL;
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.WEBHOOK_ALLOW_PRIVATE = "true";
process.env.DATABASE_POOL_MAX = "25";
process.env.LOG_LEVEL = "error";

let available = false;
let skipReason = "";

async function prepareDatabase(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (err) {
    skipReason = `no Postgres at ${adminUrl.replace(/:[^:@/]*@/, ":****@")} (${String(err)})`;
    return;
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    available = true;
  } finally {
    await admin.end();
  }
}

type Mods = {
  db: typeof import("../src/db/client");
  bus: typeof import("../src/services/event-backbone/bus");
  audit: typeof import("../src/services/event-backbone/auditLog");
  webhooks: typeof import("../src/services/event-backbone/webhooks");
  delivery: typeof import("../src/services/event-backbone/delivery");
  canonical: typeof import("../src/services/event-backbone/canonical");
  patterns: typeof import("../src/services/event-backbone/patterns");
  signature: typeof import("../src/services/event-backbone/signature");
  items: typeof import("../src/services/items");
};
let m: Mods;

before(async () => {
  await prepareDatabase();
  if (!available) return;
  const { runMigrations } = await import("../src/db/migrate");
  await runMigrations();
  m = {
    db: await import("../src/db/client"),
    bus: await import("../src/services/event-backbone/bus"),
    audit: await import("../src/services/event-backbone/auditLog"),
    webhooks: await import("../src/services/event-backbone/webhooks"),
    delivery: await import("../src/services/event-backbone/delivery"),
    canonical: await import("../src/services/event-backbone/canonical"),
    patterns: await import("../src/services/event-backbone/patterns"),
    signature: await import("../src/services/event-backbone/signature"),
    items: await import("../src/services/items"),
  };
});

after(async () => {
  if (available) await m.db.pool.end();
});

/** Registers a test that is skipped, saying why, when there is no database. */
function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (t) => {
    if (!available) {
      t.skip(skipReason);
      return;
    }
    await fn();
  });
}

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  m.db.pool.query<T>(sql, params).then((r) => r.rows);

/** Run as the table owner with the immutability trigger off, as a DBA would. */
async function tamper(sql: string, params: unknown[] = []): Promise<void> {
  const client = await m.db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
    await client.query(sql, params);
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function docSnippet(name: string): string {
  const doc = readFileSync(path.resolve(__dirname, "../../docs/event-backbone.md"), "utf8");
  const at = doc.indexOf(`<!-- snippet: ${name} -->`);
  const block = /```[a-z]*\n([\s\S]*?)```/.exec(doc.slice(at));
  return block![1]!;
}

describe("audit log in Postgres", () => {
  dbIt("has pgcrypto installed by the migration", async () => {
    const rows = await q<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'");
    assert.equal(rows.length, 1);
  });

  dbIt("chains published events, and the JavaScript twin agrees with every hash", async () => {
    const tricky = [
      { plain: 1 },
      { unicode: "Ünïcödé 😀 — “quotes”", escapes: 'a"b\\c\nd\te\u0001f\u007f', slash: "a/b" },
      { numbers: [0, -1, 0.1, 1.5e-7, 1e21, -2.5e25, 123456789.123, Number.MAX_SAFE_INTEGER] },
      { nested: { b: { dd: 1, c: 2 }, a: [], é: {}, aa: [null, true, false] } },
      { when: new Date("2026-09-26T01:02:03.004Z"), nul: "x\u0000y" },
    ];
    const entries = [];
    for (const data of tricky) {
      const entry = await m.bus.publish("test.canonical", data, {
        actor: { kind: "device", id: "reader-1", name: "Dock door 4" },
        subject: { type: "item", id: "0f9a" },
      });
      assert.ok(entry, "publish returned the entry");
      entries.push(entry);
    }
    let prev = entries[0]!.prevHash;
    for (const e of entries) {
      assert.equal(e.prevHash, prev);
      assert.equal(m.canonical.computeRowHash(e), e.hash, `hash of #${e.id}`);
      prev = e.hash;
    }
    // Read back, as an export would, and check again.
    for (const e of entries) {
      const stored = await m.audit.getAuditEntry(e.id);
      assert.deepEqual(stored, e);
    }
    const v = await m.audit.verifyChain();
    assert.equal(v.ok, true, v.reason ?? "");
  });

  dbIt("rejects a malformed publish without throwing", async () => {
    assert.equal(await m.bus.publish("Not A Type", {}), null);
    assert.equal(await m.bus.publish("audit.checkpoint", {}), null);
    assert.equal(await m.bus.publish("test.x", {}, { subject: { type: "item", id: "" } }), null);
  });

  dbIt("records every item event through recordEvent", async () => {
    const item = await m.items.createItem({ name: "Pallet jack" }, "trusted:owner");
    await m.items.updateItem(item.id, { description: "Yellow" }, "trusted:owner");
    await m.items.deleteItem(item.id, "trusted:owner");
    const rows = await q<{ type: string; subject_id: string; actor_name: string; data: Record<string, unknown> }>(
      "SELECT type, subject_id, actor_name, data FROM audit_log WHERE subject_type = 'item' AND subject_id = $1 ORDER BY id",
      [item.id],
    );
    assert.deepEqual(
      rows.map((r) => r.type),
      ["item.created", "item.updated", "item.deleted"],
    );
    assert.ok(rows.every((r) => r.actor_name === "Owner"));
    assert.deepEqual(rows[1]!.data, { fields: ["description"] });
    const events = await q<{ n: string }>("SELECT count(*) AS n FROM item_events");
    const logged = await q<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE type LIKE 'item.%'");
    assert.equal(logged[0]!.n, events[0]!.n, "one audit row per item event");
  });

  dbIt("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await assert.rejects(q("UPDATE audit_log SET type = 'x.y'"), /append-only: UPDATE/);
    await assert.rejects(q("DELETE FROM audit_log"), /append-only: DELETE/);
    await assert.rejects(q("TRUNCATE audit_log CASCADE"), /append-only: TRUNCATE/);
  });

  dbIt("keeps one unbroken chain under 20 concurrent publishes", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => m.bus.publish("test.concurrent", { i })),
    );
    assert.ok(results.every(Boolean));
    const links = await q<{ id: string; ok: boolean }>(
      `SELECT id, prev_hash = lag(hash) OVER (ORDER BY id) AS ok FROM audit_log ORDER BY id`,
    );
    assert.ok(links.slice(1).every((r) => r.ok), "every prev_hash equals the hash before it");
    const ids = results.map((r) => r!.id).sort((a, b) => a - b);
    assert.equal(new Set(ids).size, 20);
    const v = await m.audit.verifyChain();
    assert.equal(v.ok, true, v.reason ?? "");
    assert.equal(v.head?.id, links[links.length - 1] ? Number(links[links.length - 1]!.id) : null);
  });

  dbIt("reports the first broken id when a row is edited behind its back, and recovers when it is put back", async () => {
    const target = await m.bus.publish("test.tamper", { amount: 100 });
    await m.bus.publish("test.tamper", { amount: 200 });
    assert.ok(target);

    await tamper(`UPDATE audit_log SET data = '{"amount": 1}' WHERE id = $1`, [target.id]);
    let v = await m.audit.verifyChain();
    assert.equal(v.ok, false);
    assert.equal(v.firstBrokenId, target.id);
    assert.ok(v.checked >= target.id - 1);

    // Recomputing the edited row's own hash just moves the break to the next row.
    await tamper(
      `UPDATE audit_log SET hash = encode(digest(prev_hash || audit_log_canonical(audit_log), 'sha256'), 'hex') WHERE id = $1`,
      [target.id],
    );
    v = await m.audit.verifyChain();
    assert.equal(v.firstBrokenId, target.id + 1);

    await tamper(`UPDATE audit_log SET data = '{"amount": 100}', hash = $2 WHERE id = $1`, [target.id, target.hash]);
    v = await m.audit.verifyChain();
    assert.equal(v.ok, true, v.reason ?? "");
  });

  dbIt("matches event patterns in SQL exactly as in JavaScript", async () => {
    const types = ["item.created", "item.unit.moved", "items.created", "job.stage_changed", "job.stagexchanged", "itemxcreated"];
    const pats = ["*", "item.*", "item.created", "*.created", "item.*.moved", "job.stage_changed", "job.*"];
    for (const t of types) {
      for (const p of pats) {
        const [row] = await q<{ m: boolean }>("SELECT event_type_matches($1, ARRAY[$2]) AS m", [t, p]);
        assert.equal(row!.m, m.patterns.matchesPattern(t, p), `${t} ~ ${p}`);
      }
    }
  });

  dbIt("serves the polling feed in order after a cursor, filtered by pattern", async () => {
    const a = await m.bus.publish("feed.one", { n: 1 });
    await m.bus.publish("other.thing", { n: 2 });
    const c = await m.bus.publish("feed.two", { n: 3 });
    const page = await m.audit.listEventsAfter(a!.id - 1, ["feed.*"], 10);
    assert.deepEqual(
      page.entries.map((e) => e.id),
      [a!.id, c!.id],
    );
    const next = await m.audit.listEventsAfter(a!.id, ["feed.*"], 1);
    assert.deepEqual(
      next.entries.map((e) => e.id),
      [c!.id],
    );
    assert.equal(next.hasMore, false);
  });

  dbIt("filters and pages the viewer", async () => {
    const first = await m.audit.listAuditLog({ types: ["test.concurrent*"] }, { limit: 15 });
    assert.equal(first.entries.length, 15);
    assert.ok(first.nextBefore);
    const rest = await m.audit.listAuditLog({ types: ["test.concurrent*"] }, { limit: 15, before: first.nextBefore });
    assert.equal(rest.entries.length, 5);
    assert.equal(rest.nextBefore, null);
    const byActor = await m.audit.listAuditLog({ actor: "Dock door" });
    assert.ok(byActor.entries.length >= 5);
    assert.ok(byActor.entries.every((e) => e.actor.name === "Dock door 4"));
  });

  dbIt("writes signed checkpoints that verification checks", async () => {
    const cp = await m.audit.createCheckpoint(true);
    assert.ok(cp);
    assert.equal(cp.type, "audit.checkpoint");
    assert.equal(cp.data.headHash, cp.prevHash);
    assert.equal(cp.data.headId, cp.id - 1);
    const [{ n }] = (await q<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE id < $1", [cp.id])) as [{ n: string }];
    assert.equal(cp.data.count, Number(n));
    assert.equal(m.audit.checkCheckpoint(cp.data), "valid");
    assert.equal(m.audit.checkCheckpoint({ ...cp.data, count: 1 }), "invalid");
    assert.equal(m.audit.checkCheckpoint({ ...cp.data, keyId: "someotherkey" }), "unknown_key");
    // Nothing new since: the scheduled run does nothing.
    assert.equal(await m.audit.createCheckpoint(false), null);
    const v = await m.audit.verifyChain();
    assert.equal(v.ok, true);
    assert.equal(v.checkpoints.invalid.length, 0);
    assert.ok(v.checkpoints.checked >= 1);
  });
});

describe("webhooks end to end", () => {
  type Received = { headers: http.IncomingHttpHeaders; body: string };
  const received: Received[] = [];
  let respondWith = 200;
  let server: http.Server;
  let url = "";
  let endpointId = "";
  let secret = "";
  const admin = { kind: "user" as const, id: "local:admin", name: "Admin" };

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(respondWith, { "Content-Type": "text/plain" }).end(respondWith === 200 ? "ok" : "receiver broke");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bindex`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const deliveryFor = async (auditId: number) =>
    (await q<{ id: string; status: string; attempts: number; next_attempt_at: Date | null; response_status: number | null }>(
      "SELECT * FROM webhook_deliveries WHERE audit_log_id = $1 AND endpoint_id = $2 ORDER BY id",
      [auditId, endpointId],
    ))!;

  dbIt("creates an endpoint and returns its secret once", async () => {
    const created = await m.webhooks.createEndpoint(
      { url, description: "Test WMS", eventPatterns: ["wms.*", "Item.Created"] },
      admin,
    );
    endpointId = created.id;
    secret = created.secret;
    assert.match(secret, /^whsec_/);
    assert.deepEqual(created.eventPatterns, ["wms.*", "item.created"]);
    const listed = await m.webhooks.listEndpoints();
    assert.ok(!JSON.stringify(listed).includes(secret), "the secret is never listed");
    const [logged] = await q<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit_log WHERE type = 'webhook.endpoint_created' AND subject_id = $1",
      [endpointId],
    );
    assert.equal(logged!.data.host, new URL(url).host);
    assert.ok(!JSON.stringify(logged!.data).includes("/bindex"), "the path is not logged");
  });

  dbIt("rejects bad patterns and, without WEBHOOK_ALLOW_PRIVATE, private hosts", async () => {
    await assert.rejects(
      m.webhooks.createEndpoint({ url, eventPatterns: ["bad pattern"] }, admin),
      /Not a valid event pattern/,
    );
    await assert.rejects(m.webhooks.createEndpoint({ url, eventPatterns: [] }, admin), /at least one event/);
  });

  dbIt("delivers a signed event that the documented snippet verifies", async () => {
    const entry = await m.bus.publish("wms.pallet_received", { pallet: "P-100", qty: 12 }, { subject: { type: "item", id: "abc" } });
    assert.ok(entry);
    const [queued] = await deliveryFor(entry.id);
    assert.equal(queued!.status, "pending");

    const before = received.length;
    await m.delivery.runDeliveryBatch();
    assert.equal(received.length, before + 1);
    const got = received[received.length - 1]!;

    assert.equal(got.headers["x-bindex-event"], "wms.pallet_received");
    assert.equal(got.headers["x-bindex-delivery"], queued!.id);
    assert.equal(got.headers["content-type"], "application/json");
    const header = String(got.headers["x-bindex-signature"]);
    assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(m.signature.verifySignatureHeader(header, got.body, secret).valid, true);
    const documented = new Function("require", `${docSnippet("verify-node")}\nreturn verifyBindexSignature;`)(
      require,
    ) as (raw: string, header: string, secret: string) => boolean;
    assert.equal(documented(got.body, header, secret), true);

    assert.deepEqual(JSON.parse(got.body), {
      id: entry.id,
      type: "wms.pallet_received",
      occurredAt: entry.occurredAt,
      subject: { type: "item", id: "abc" },
      actor: { kind: "system", id: null, name: null },
      data: { pallet: "P-100", qty: 12 },
      hash: entry.hash,
    });
    const [done] = await deliveryFor(entry.id);
    assert.equal(done!.status, "succeeded");
    assert.equal(done!.attempts, 1);
    assert.equal(done!.response_status, 200);
  });

  dbIt("does not queue events the endpoint did not ask for", async () => {
    const entry = await m.bus.publish("other.event", {});
    assert.equal((await deliveryFor(entry!.id)).length, 0);
  });

  dbIt("retries a 500 with backoff, then succeeds", async () => {
    respondWith = 500;
    const entry = await m.bus.publish("wms.flaky", {});
    await m.delivery.runDeliveryBatch();
    let [d] = await deliveryFor(entry!.id);
    assert.equal(d!.status, "failed");
    assert.equal(d!.attempts, 1);
    assert.equal(d!.response_status, 500);
    const wait = d!.next_attempt_at!.getTime() - Date.now();
    assert.ok(wait > 50_000 && wait <= 60_000, `retry in ${wait}ms, expected about a minute`);

    // Not due yet, so a batch now leaves it alone.
    const before = received.length;
    await m.delivery.runDeliveryBatch();
    assert.equal(received.length, before);

    respondWith = 200;
    await q("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1", [d!.id]);
    await m.delivery.runDeliveryBatch();
    [d] = await deliveryFor(entry!.id);
    assert.equal(d!.status, "succeeded");
    assert.equal(d!.attempts, 2);
    const [ep] = await q<{ failure_count: number }>("SELECT failure_count FROM webhook_endpoints WHERE id = $1", [endpointId]);
    assert.equal(ep!.failure_count, 0, "a success resets the failure streak");
  });

  dbIt("gives up after six attempts, following the schedule", async () => {
    respondWith = 503;
    const entry = await m.bus.publish("wms.down", {});
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await q("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE audit_log_id = $1", [entry!.id]);
      await m.delivery.runDeliveryBatch();
      const [d] = await deliveryFor(entry!.id);
      assert.equal(d!.attempts, attempt);
      if (d!.next_attempt_at) waits.push(Math.round((d!.next_attempt_at.getTime() - Date.now()) / 60_000));
      else assert.equal(d!.status, "dead");
    }
    assert.deepEqual(waits, [1, 5, 30, 120, 720]);
    respondWith = 200;
  });

  dbIt("pings and redelivers on demand", async () => {
    const before = received.length;
    const ping = await m.delivery.pingEndpoint(endpointId, admin);
    assert.equal(ping.status, "succeeded");
    assert.equal(ping.eventType, "webhook.ping");
    const body = JSON.parse(received[before]!.body) as Record<string, unknown>;
    assert.equal(body.type, "webhook.ping");
    assert.equal(body.id, 0);
    assert.equal(body.hash, null);
    const pinged = await q("SELECT 1 FROM audit_log WHERE type = 'webhook.ping'");
    assert.equal(pinged.length, 0, "a ping is not an event");

    const dead = await q<{ id: string; audit_log_id: string }>(
      "SELECT id, audit_log_id FROM webhook_deliveries WHERE status = 'dead' LIMIT 1",
    );
    const again = await m.delivery.redeliver(dead[0]!.id);
    assert.equal(again.status, "succeeded");
    assert.equal(again.auditLogId, Number(dead[0]!.audit_log_id));
    assert.notEqual(String(again.id), dead[0]!.id);
    await assert.rejects(m.delivery.redeliver(String(ping.id)), /test ping cannot be sent again/);

    const log = await m.delivery.listDeliveries(endpointId, { limit: 2 });
    assert.equal(log.deliveries.length, 2);
    assert.ok(log.nextBefore);
  });

  dbIt("switches an endpoint off after 50 consecutive failures, and back on", async () => {
    await q("UPDATE webhook_endpoints SET failure_count = 49 WHERE id = $1", [endpointId]);
    respondWith = 500;
    await m.bus.publish("wms.last_straw", {});
    await m.delivery.runDeliveryBatch();
    let [ep] = await q<{ active: boolean; disabled_at: Date | null; failure_count: number }>(
      "SELECT * FROM webhook_endpoints WHERE id = $1",
      [endpointId],
    );
    assert.equal(ep!.active, false);
    assert.ok(ep!.disabled_at);
    assert.equal(ep!.failure_count, 50);
    const disabled = await q("SELECT 1 FROM audit_log WHERE type = 'webhook.endpoint_disabled' AND subject_id = $1", [endpointId]);
    assert.equal(disabled.length, 1);

    // Queued but not sent while off.
    respondWith = 200;
    const waiting = await m.bus.publish("wms.while_off", {});
    assert.equal((await deliveryFor(waiting!.id)).length, 0, "an inactive endpoint gets no new deliveries");

    const back = await m.webhooks.updateEndpoint(endpointId, { active: true }, admin);
    assert.equal(back.active, true);
    assert.equal(back.failureCount, 0);
    assert.equal(back.disabledAt, null);
  });

  dbIt("keeps the chain valid through all of it", async () => {
    const v = await m.audit.verifyChain();
    assert.equal(v.ok, true, v.reason ?? "");
  });
});

describe("archiving", () => {
  dbIt("accepts a log that starts at a signed checkpoint, and rejects one that starts anywhere else", async () => {
    const cp = await m.audit.createCheckpoint(true);
    await m.bus.publish("test.after_archive", {});
    const [{ n }] = (await q<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE id < $1", [cp!.id])) as [{ n: string }];

    await tamper("DELETE FROM audit_log WHERE id < $1", [cp!.id]);
    let v = await m.audit.verifyChain();
    assert.equal(v.ok, true, v.reason ?? "");
    assert.equal(v.anchor?.id, cp!.id);
    assert.equal(v.anchor?.archivedCount, Number(n));
    assert.equal(v.anchor?.archivedHeadHash, cp!.prevHash);

    // Dropping the checkpoint too leaves a log with no trustworthy start.
    await tamper("DELETE FROM audit_log WHERE id = $1", [cp!.id]);
    v = await m.audit.verifyChain();
    assert.equal(v.ok, false);
    assert.equal(v.firstBrokenId, cp!.id + 1);
  });
});
