import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/**
 * Register imports against a real Postgres: what the planner lets through has
 * to get past the database's own identity index, and the routes treat an id
 * that is not a uuid as not found. Skipped unless TEST_DATABASE_URL points at
 * a database this test may write to:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_test pnpm --filter bindex-server test
 *
 * Everything it creates carries a random tag and is removed at the end.
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "warn";

describe("register import against Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let pool: typeof import("../src/db/client").pool;
  let store: typeof import("../src/services/register-reconcile/store");
  let importNew: typeof import("../src/services/register-reconcile/importNew");
  let server: Server;
  let base = "";
  const tag = randomBytes(4).toString("hex").toUpperCase();
  const itemIds: string[] = [];
  const importIds: string[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows as T[];

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();
    ({ pool } = await import("../src/db/client"));
    store = await import("../src/services/register-reconcile/store");
    importNew = await import("../src/services/register-reconcile/importNew");

    const express = (await import("express")).default;
    const { registerReconcileRouter } = await import("../src/routes/register-reconcile");
    const { HttpError } = await import("../src/lib/errors");
    const app = express();
    app.use("/api/register-reconcile", registerReconcileRouter);
    app.use(((err, _req, res, _next) => {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message, code: err.code });
      else res.status(500).json({ error: String(err) });
    }) as import("express").ErrorRequestHandler);
    server = app.listen(0);
    await new Promise((ok) => server.once("listening", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (pool) {
      await q("DELETE FROM register_imports WHERE id = ANY($1::uuid[])", [importIds]).catch(() => undefined);
      await q("DELETE FROM items WHERE id = ANY($1::uuid[])", [itemIds]).catch(() => undefined);
    }
    server?.close();
    await pool?.end();
  });

  it("imports a row whose tag is also its serial, and skips a tag another item has as its MAC", async () => {
    const [router] = await q<{ id: string; asset_code: string }>(
      "INSERT INTO items (name) VALUES ($1) RETURNING id, asset_code",
      [`Router ${tag}`],
    );
    itemIds.push(router!.id);
    await q("INSERT INTO item_identifiers (item_id, type, value) VALUES ($1, 'mac', $2)", [router!.id, `MAC-${tag}`]);

    const csv = `Name,Asset Tag,Serial\nMacBook,C02-${tag},C02-${tag}\nSwitch,MAC-${tag},\n`;
    const imp = await store.createImport({ bytes: Buffer.from(csv), name: `Register ${tag}`, userOid: null });
    importIds.push(imp.id);

    const plan = await importNew.previewImport(imp.id, {});
    const { created, skipped } = await importNew.commitImport(imp.id, {}, plan.hash, null);
    itemIds.push(...created.map((c) => c.itemId));
    assert.equal(created.length, 1);
    assert.deepEqual(
      await q("SELECT type, value FROM item_identifiers WHERE item_id = $1", [created[0]!.itemId]),
      [{ type: "asset_tag", value: `C02-${tag}` }],
    );
    assert.deepEqual(skipped.map((s) => s.reason), [`Asset tag MAC-${tag} is already on ${router!.asset_code}.`]);
  });

  it("answers 404, not a database error, for ids that are not ids", async () => {
    for (const path of ["/imports/abc", "/imports/abc/rows", "/runs/abc", "/runs/abc/results", `/runs/${randomUUID()}/compare/abc`]) {
      const res = await fetch(`${base}/api/register-reconcile${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});
