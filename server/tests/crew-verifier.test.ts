import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/**
 * The external credential verifier against a scripted stand-in, with no
 * database: every reply here either fails or names no credential type this
 * instance has, so nothing is written. The merge itself is covered by
 * crew-db.test.ts.
 */

type Verifier = typeof import("../src/services/crew/verifier");
type Env = typeof import("../src/env");

let verifier: Verifier;
let envModule: Env;
let server: http.Server;
let url = "";

type Seen = { method?: string; auth?: string; contentType?: string; body?: Record<string, unknown> };
let seen: Seen = {};
let reply: (res: http.ServerResponse) => void = (res) => res.end();

before(async () => {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      seen = {
        method: req.method,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"),
      };
      reply(res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/verify`;
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL = "error";
  process.env.CREDENTIAL_VERIFY_URL = url;
  process.env.CREDENTIAL_VERIFY_TOKEN = "s3cret";
  process.env.CREDENTIAL_VERIFY_TIMEOUT_MS = "5000";
  verifier = await import("../src/services/crew/verifier");
  envModule = await import("../src/env");
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
  const { pool } = await import("../src/db/client");
  await pool.end();
});

const worker = {
  id: "5b1e7a4c-0d3f-4a55-9e3c-1f2a3b4c5d6e",
  name: "Dana Ruiz",
  company: "Acme Movers",
  role: "Driver",
  badgeCode: "CRW-7F3K2A",
  phone: "555-0100",
  photoAttachmentId: null,
  active: true,
  notes: null,
  metadata: {},
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const type = (key: string, active = true) =>
  [
    key,
    {
      id: `00000000-0000-4000-8000-${key.length.toString().padStart(12, "0")}`,
      key,
      name: key,
      description: null,
      validityMonths: null,
      warnDays: 30,
      active,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ] as const;
const types = new Map([type("forklift"), type("old_card", false)]);

const json = (status: number, body: unknown) => (res: http.ServerResponse) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("credential verifier", () => {
  it("is available when the URL is set", () => {
    assert.equal(verifier.verifierAvailable(), true);
  });

  it("posts the badge code with the bearer token, and reports types it does not know", async () => {
    reply = json(200, { credentials: [{ type: "drug_screen", status: "passed" }] });
    const r = await verifier.verifyWorker(worker, types);
    assert.equal(seen.method, "POST");
    assert.equal(seen.auth, "Bearer s3cret");
    assert.equal(seen.contentType, "application/json");
    assert.deepEqual(seen.body, {
      badgeCode: "CRW-7F3K2A",
      worker: { id: worker.id, name: "Dana Ruiz", company: "Acme Movers" },
      credentialTypes: ["forklift"],
    });
    assert.equal(r.available, true);
    assert.equal(r.ok, true);
    assert.equal(r.found, true);
    assert.equal(r.merged, 0);
    assert.deepEqual(r.unmatched, ["drug_screen"]);
    assert.equal(r.error, null);
  });

  it("treats a 404 as a badge the verifier does not know", async () => {
    reply = json(404, { error: "unknown" });
    const r = await verifier.verifyWorker(worker, types);
    assert.deepEqual({ ok: r.ok, found: r.found, error: r.error }, { ok: true, found: false, error: null });
  });

  it("carries on quietly when the verifier fails, answers nonsense or is slow", async () => {
    reply = json(503, { error: "down" });
    let r = await verifier.verifyWorker(worker, types);
    assert.deepEqual({ available: r.available, ok: r.ok, error: r.error }, { available: true, ok: false, error: "The verifier answered 503." });

    reply = (res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>maintenance</html>");
    };
    r = await verifier.verifyWorker(worker, types);
    assert.equal(r.ok, false);
    assert.equal(r.error, "The verifier's answer was not JSON.");

    // A short timeout for this one only: under a busy test run a first request
    // can take longer than 300 ms on its own.
    const env = envModule.env as { CREDENTIAL_VERIFY_TIMEOUT_MS: number };
    env.CREDENTIAL_VERIFY_TIMEOUT_MS = 300;
    try {
      reply = (res) => setTimeout(() => json(200, { credentials: [] })(res), 1500);
      const started = Date.now();
      r = await verifier.verifyWorker(worker, types);
      assert.equal(r.ok, false);
      assert.equal(r.error, "The verifier did not answer in time.");
      assert.ok(Date.now() - started < 1400, "gave up at the timeout");
    } finally {
      env.CREDENTIAL_VERIFY_TIMEOUT_MS = 5000;
    }

    reply = (res) => {
      res.writeHead(302, { Location: "http://example.com/" });
      res.end();
    };
    r = await verifier.verifyWorker(worker, types);
    assert.equal(r.ok, false, "redirects are not followed");
  });

  it("is off when the URL is blank or not http", async () => {
    const env = envModule.env as { CREDENTIAL_VERIFY_URL: string };
    const saved = env.CREDENTIAL_VERIFY_URL;
    try {
      env.CREDENTIAL_VERIFY_URL = "";
      assert.equal(verifier.verifierAvailable(), false);
      const r = await verifier.verifyWorker(worker, types);
      assert.deepEqual({ available: r.available, ok: r.ok, error: r.error }, { available: false, ok: false, error: null });
      env.CREDENTIAL_VERIFY_URL = "ftp://files.example.com/verify";
      assert.equal(verifier.verifierAvailable(), false);
    } finally {
      env.CREDENTIAL_VERIFY_URL = saved;
    }
  });
});
