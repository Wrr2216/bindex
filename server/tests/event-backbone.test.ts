import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Modules below read the environment when they load.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Patterns = typeof import("../src/services/event-backbone/patterns");
type Signature = typeof import("../src/services/event-backbone/signature");
type Policy = typeof import("../src/services/event-backbone/policy");
type Canonical = typeof import("../src/services/event-backbone/canonical");
type Bus = typeof import("../src/services/event-backbone/bus");
type Transport = typeof import("../src/services/event-backbone/transport");

let patterns: Patterns;
let signature: Signature;
let policy: Policy;
let canonical: Canonical;
let bus: Bus;
let transport: Transport;

before(async () => {
  patterns = await import("../src/services/event-backbone/patterns");
  signature = await import("../src/services/event-backbone/signature");
  policy = await import("../src/services/event-backbone/policy");
  canonical = await import("../src/services/event-backbone/canonical");
  bus = await import("../src/services/event-backbone/bus");
  transport = await import("../src/services/event-backbone/transport");
});

after(async () => {
  // bus.ts imports the pool; it never connected, but end it so the process exits.
  const { pool } = await import("../src/db/client");
  await pool.end();
});

/** A fenced block in docs/event-backbone.md, marked with <!-- snippet: name -->. */
function docSnippet(name: string): string {
  const doc = readFileSync(path.resolve(__dirname, "../../docs/event-backbone.md"), "utf8");
  const marker = `<!-- snippet: ${name} -->`;
  const at = doc.indexOf(marker);
  assert.ok(at >= 0, `snippet ${name} is missing from docs/event-backbone.md`);
  const block = /```[a-z]*\n([\s\S]*?)```/.exec(doc.slice(at));
  assert.ok(block, `snippet ${name} has no code block`);
  return block[1]!;
}

describe("event type patterns", () => {
  it("accepts dotted lowercase types and rejects the rest", () => {
    for (const t of ["item.created", "job.stage_changed", "device.offline", "item.unit.moved", "t04.x"]) {
      assert.ok(patterns.isValidEventType(t), t);
    }
    for (const t of ["item", "Item.created", "item.", ".created", "item..created", "item.created!", "item-x.y", "1item.x", ""]) {
      assert.ok(!patterns.isValidEventType(t), t);
    }
  });

  it("matches * across any run of characters, dots included", () => {
    const cases: [string, string, boolean][] = [
      ["item.created", "*", true],
      ["item.created", "item.*", true],
      ["item.unit.moved", "item.*", true],
      ["items.created", "item.*", false],
      ["item", "item.*", false],
      ["item.created", "item.created", true],
      ["item.created2", "item.created", false],
      ["job.created", "*.created", true],
      ["item.unit.moved", "item.*.moved", true],
      ["item.moved", "item.*.moved", false],
      ["job.stage_changed", "job.stage_changed", true],
      // `_` is literal, not SQL's single-character wildcard.
      ["job.stagexchanged", "job.stage_changed", false],
      // `.` is literal, not a regular expression's any-character.
      ["itemxcreated", "item.created", false],
    ];
    for (const [type, pattern, expected] of cases) {
      assert.equal(patterns.matchesPattern(type, pattern), expected, `${type} ~ ${pattern}`);
    }
    assert.ok(patterns.matchesAny("job.created", ["item.*", "job.*"]));
    assert.ok(!patterns.matchesAny("device.offline", ["item.*", "job.*"]));
    assert.ok(!patterns.matchesAny("device.offline", []));
  });

  it("converts patterns to escaped LIKE patterns", () => {
    assert.equal(patterns.patternToLike("item.*"), "item.%");
    assert.equal(patterns.patternToLike("*"), "%");
    assert.equal(patterns.patternToLike("job.stage_changed"), "job.stage\\_changed");
    assert.equal(patterns.patternToLike("a%b\\c"), "a\\%b\\\\c");
  });

  it("parses a comma-separated list, lowercased and deduplicated, reporting bad entries", () => {
    const { patterns: p, invalid } = patterns.parsePatternList(" item.* ,JOB.*,, item.*, bad pattern!,");
    assert.deepEqual(p, ["item.*", "job.*"]);
    assert.deepEqual(invalid, ["bad pattern!"]);
    assert.deepEqual(patterns.parsePatternList(undefined), { patterns: [], invalid: [] });
  });

  it("turns a filter prefix into a pattern", () => {
    assert.equal(patterns.prefixToPattern("item."), "item.*");
    assert.equal(patterns.prefixToPattern("Item.Mo"), "item.mo*");
    assert.equal(patterns.prefixToPattern("*.deleted"), "*.deleted");
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: 7, type: "item.created", data: { name: "Pallet jack é" } });
  const t = 1_790_000_000;

  it("signs <t>.<body> with HMAC-SHA256 of the secret", () => {
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    assert.equal(signature.signatureHeader(secret, body, t), `t=${t},v1=${expected}`);
  });

  it("verifies a good signature and rejects tampering, wrong keys and stale timestamps", () => {
    const header = signature.signatureHeader(secret, body, t);
    const at = { now: t + 10 };
    assert.deepEqual(signature.verifySignatureHeader(header, body, secret, at), { valid: true, reason: null });
    assert.equal(signature.verifySignatureHeader(header, `${body} `, secret, at).valid, false);
    assert.equal(signature.verifySignatureHeader(header, body, "whsec_other", at).valid, false);
    assert.equal(signature.verifySignatureHeader(header, body, secret, { now: t + 301 }).reason, "timestamp outside tolerance");
    assert.equal(signature.verifySignatureHeader(undefined, body, secret, at).valid, false);
    assert.equal(signature.verifySignatureHeader(`t=${t}`, body, secret, at).reason, "no v1 signature in header");
    assert.equal(signature.verifySignatureHeader("v1=abc", body, secret, at).reason, "no timestamp in signature header");
  });

  it("accepts any of several v1 values, for secret rotation", () => {
    const good = signature.signatureDigest(secret, t, body);
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    assert.equal(signature.verifySignatureHeader(header, body, secret, { now: t }).valid, true);
  });

  it("generates distinct, recognisable secrets", () => {
    const a = signature.generateWebhookSecret();
    const b = signature.generateWebhookSecret();
    assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });

  it("agrees with the documented Node.js snippet", () => {
    const verify = new Function("require", `${docSnippet("verify-node")}\nreturn verifyBindexSignature;`)(
      require,
    ) as (raw: string | Buffer, header: string, secret: string) => boolean;
    const now = Math.floor(Date.now() / 1000);
    const header = signature.signatureHeader(secret, body, now);
    assert.equal(verify(body, header, secret), true);
    assert.equal(verify(Buffer.from(body), header, secret), true);
    assert.equal(verify(`${body}x`, header, secret), false);
    assert.equal(verify(body, header, "whsec_wrong"), false);
    assert.equal(verify(body, signature.signatureHeader(secret, body, now - 3600), secret), false);
  });

  it("agrees with the documented Python snippet", (t) => {
    const python = "python3";
    try {
      execFileSync(python, ["--version"], { stdio: "ignore" });
    } catch {
      t.skip("python3 is not installed");
      return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "bindex-sig-"));
    const script = path.join(dir, "check.py");
    writeFileSync(
      script,
      `${docSnippet("verify-python")}\n\nimport sys\nraw = open(sys.argv[1], "rb").read()\nprint(verify_bindex_signature(raw, sys.argv[2], sys.argv[3]))\n`,
    );
    const bodyFile = path.join(dir, "body.json");
    writeFileSync(bodyFile, body);
    const header = signature.signatureHeader(secret, body, Math.floor(Date.now() / 1000));
    const run = (h: string, s: string) => execFileSync(python, [script, bodyFile, h, s], { encoding: "utf8" }).trim();
    assert.equal(run(header, secret), "True");
    assert.equal(run(header, "whsec_wrong"), "False");
  });
});

describe("retry policy", () => {
  it("backs off 1m, 5m, 30m, 2h, 12h, then gives up", () => {
    const min = 60_000;
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => policy.nextRetryDelayMs(n)),
      [1 * min, 5 * min, 30 * min, 120 * min, 720 * min],
    );
    assert.equal(policy.nextRetryDelayMs(6), null);
    assert.equal(policy.nextRetryDelayMs(60), null);
    assert.equal(policy.MAX_ATTEMPTS, 6);
  });

  it("treats a nonsense attempt count as the first failure", () => {
    assert.equal(policy.nextRetryDelayMs(0), 60_000);
    assert.equal(policy.nextRetryDelayMs(-1), 60_000);
  });

  it("counts only 2xx as delivered", () => {
    assert.ok(policy.isSuccessStatus(200));
    assert.ok(policy.isSuccessStatus(204));
    assert.ok(!policy.isSuccessStatus(301));
    assert.ok(!policy.isSuccessStatus(404));
    assert.ok(!policy.isSuccessStatus(500));
    assert.ok(!policy.isSuccessStatus(null));
  });

  it("switches an endpoint off after 50 failures in a row", () => {
    assert.equal(policy.AUTO_DISABLE_AFTER, 50);
    assert.equal(policy.DELIVERY_TIMEOUT_MS, 10_000);
  });
});

describe("canonical text", () => {
  it("prints numbers the way Postgres numeric does", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [42, "42"],
      [-5, "-5"],
      [0.1, "0.1"],
      [123.456, "123.456"],
      [1.5e-7, "0.00000015"],
      [1e-7, "0.0000001"],
      [-2.5e-10, "-0.00000000025"],
      [1e21, "1000000000000000000000"],
      [1.2345e21, "1234500000000000000000"],
      [-2.5e25, "-25000000000000000000000000"],
      [Number.MAX_SAFE_INTEGER, "9007199254740991"],
      [NaN, "null"],
    ];
    for (const [n, text] of cases) assert.equal(canonical.pgNumber(n), text, String(n));
  });

  it("renders like jsonb: keys by byte length then bytes, spaced separators", () => {
    // Expected output taken from Postgres 16: '<same json>'::jsonb::text
    const value = {
      b: 1,
      aa: 2,
      a: [1.5e-7, 1e21, -0, 0.1, {}, [], 'x"y\\z\n\t\u0001\u007f/é😀'],
      ab: { é: 1, z: 2, ä: 3 },
    };
    assert.equal(
      canonical.pgJsonbText(value),
      '{"a": [0.00000015, 1000000000000000000000, 0, 0.1, {}, [], "x\\"y\\\\z\\n\\t\\u0001\u007f/é😀"], "b": 1, "aa": 2, "ab": {"z": 2, "ä": 3, "é": 1}}',
    );
    assert.equal(canonical.pgJsonbText([123, "x", null, { k: true }]), '[123, "x", null, {"k": true}]');
    assert.equal(canonical.pgJsonbText({ gone: undefined, kept: false }), '{"kept": false}');
  });

  it("reproduces a hash the database computed", () => {
    // Written by the trigger in a scratch database: INSERT INTO audit_log
    // (type, data) VALUES ('test.one', '{"a":1}') as the first row.
    const row = {
      id: 1,
      occurredAt: "2026-09-26T14:17:46.481Z",
      actor: { kind: "system", id: null, name: null },
      type: "test.one",
      subject: null,
      data: { a: 1 },
      prevHash: canonical.GENESIS_HASH,
    };
    assert.equal(
      canonical.canonicalText(row),
      '[1, "2026-09-26T14:17:46.481Z", "system", null, null, "test.one", null, null, {"a": 1}]',
    );
    assert.equal(canonical.computeRowHash(row), "1b269e288a14f91722d0b2710dcb82f81e26a82451e9d1bb39e5d790f3667b26");
  });

  function chain(n: number) {
    const rows: import("../src/services/event-backbone/canonical").ChainRow[] = [];
    let prev = canonical.GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const row = {
        id: i,
        occurredAt: new Date(Date.UTC(2026, 8, 26, 12, 0, i)).toISOString(),
        actor: { kind: "user", id: "local:1", name: "Dana" },
        type: "item.updated",
        subject: { type: "item", id: `item-${i}` },
        data: { n: i },
        prevHash: prev,
      };
      const hash = canonical.computeRowHash(row);
      rows.push({ ...row, hash });
      prev = hash;
    }
    return rows;
  }

  it("accepts an intact export and proves every link", () => {
    const r = canonical.checkExportedRows(chain(5));
    assert.equal(r.ok, true);
    assert.equal(r.rows, 5);
    assert.equal(r.links, 4);
    assert.equal(r.gaps, 0);
    assert.equal(r.startsAtGenesis, true);
  });

  it("finds an edited row", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, data: { n: 999 } };
    const r = canonical.checkExportedRows(rows);
    assert.equal(r.ok, false);
    assert.equal(r.firstBadId, 3);
  });

  it("finds a removed row when the ids are consecutive, and reports gaps otherwise", () => {
    const rows = chain(5);
    const relinked = rows.slice();
    // Row 3 removed and row 4 renumbered and rehashed to hide it: the link breaks.
    const four = { ...rows[3]!, id: 3 };
    relinked.splice(2, 2, { ...four, hash: canonical.computeRowHash(four) });
    assert.equal(canonical.checkExportedRows(relinked).firstBadId, 3);

    // A filtered export simply skips ids.
    const filtered = [rows[0]!, rows[2]!, rows[4]!];
    const r = canonical.checkExportedRows(filtered);
    assert.equal(r.ok, true);
    assert.equal(r.gaps, 2);
    assert.equal(r.links, 0);
  });
});

describe("event data sanitising", () => {
  it("keeps plain JSON unchanged", () => {
    const data = { a: 1, b: "x", c: [true, null, { d: 2.5 }] };
    assert.deepEqual(bus.sanitizeEventData(data), data);
  });

  it("makes what jsonb would reject or change safe", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const out = bus.sanitizeEventData({
      nul: "a\u0000b",
      lone: "x\uD800y",
      pair: "😀",
      when: new Date("2026-09-26T12:00:00.000Z"),
      big: 12345678901234567890n,
      nan: Number.NaN,
      inf: Infinity,
      gone: undefined,
      fn: () => 1,
      list: [undefined, 1],
      circular,
      ["k\u0000ey"]: 1,
    });
    assert.deepEqual(out, {
      nul: "ab",
      lone: "x�y",
      pair: "😀",
      when: "2026-09-26T12:00:00.000Z",
      big: "12345678901234567890",
      nan: null,
      inf: null,
      list: [null, 1],
      circular: { name: "loop", self: "[circular]" },
      key: 1,
    });
  });

  it("wraps a non-object and replaces an oversized payload with a note", () => {
    assert.deepEqual(bus.sanitizeEventData([1, 2] as unknown), { value: [1, 2] });
    assert.deepEqual(bus.sanitizeEventData(null as unknown), { value: null });
    const huge = bus.sanitizeEventData({ blob: "x".repeat(bus.MAX_DATA_BYTES + 10), other: 1 });
    assert.equal(huge.truncated, true);
    assert.deepEqual(huge.keys, ["blob", "other"]);
  });
});

describe("actors", () => {
  it("maps the stored user ids to actor kinds", () => {
    assert.deepEqual(bus.actorFromOid(null), { kind: "system", id: null, name: null });
    assert.deepEqual(bus.actorFromOid("api-key:1234"), { kind: "api_key", id: "1234", name: null });
    assert.deepEqual(bus.actorFromOid("local:abc", "Dana"), { kind: "user", id: "local:abc", name: "Dana" });
    assert.equal(bus.actorFromOid("trusted:owner").name, "Owner");
    assert.deepEqual(bus.actorFromUser({ oid: "sso.example.com:42", name: "Sam" }), {
      kind: "user",
      id: "sso.example.com:42",
      name: "Sam",
    });
  });
});

describe("webhook transport", () => {
  let server: http.Server;
  let base: string;
  const seen: string[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://example.com/" }).end();
      } else if (req.url === "/huge") {
        // Starts a body it never finishes; the client keeps the start and leaves.
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.write("e".repeat(64 * 1024));
      } else if (req.url === "/slow") {
        // Never answers; the client's timeout has to end it.
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("blocks private and local addresses, however they are written", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fe80::1",
      "fd12:3456::1",
      "localhost",
      "printer.local",
      "db.internal",
    ]) {
      assert.ok(transport.isBlockedAddress(a), a);
    }
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "example.com", "fdx.example.com", "10.example.com"]) {
      assert.ok(!transport.isBlockedAddress(a), a);
    }
  });

  it("vets URLs before they are saved", () => {
    assert.equal(transport.checkTargetUrl("https://hooks.example.com/x", false).ok, true);
    assert.equal(transport.checkTargetUrl("ftp://example.com/", false).ok, false);
    assert.equal(transport.checkTargetUrl("https://user:pw@example.com/", false).ok, false);
    assert.equal(transport.checkTargetUrl("http://192.168.1.5/hook", false).ok, false);
    assert.equal(transport.checkTargetUrl("http://192.168.1.5/hook", true).ok, true);
    assert.equal(transport.checkTargetUrl("not a url", true).ok, false);
  });

  it("refuses to connect to a private address unless allowed", async () => {
    const before = seen.length;
    const blocked = await transport.postJson(new URL(`${base}/hook`), "{}", {}, { timeoutMs: 2000, allowPrivate: false });
    assert.equal(blocked.status, null);
    assert.match(blocked.error ?? "", /private/);
    const viaName = await transport.postJson(
      new URL(`${base.replace("127.0.0.1", "localhost")}/hook`),
      "{}",
      {},
      { timeoutMs: 2000, allowPrivate: false },
    );
    assert.equal(viaName.status, null);
    assert.equal(seen.length, before, "nothing reached the server");

    const allowed = await transport.postJson(new URL(`${base}/hook`), "{}", {}, { timeoutMs: 2000, allowPrivate: true });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "ok");
    assert.equal(allowed.error, null);
  });

  it("checks the addresses a name resolves to, at connect time", async () => {
    type Lookup = (host: string, opts: object, cb: (err: Error | null, addr?: unknown, family?: number) => void) => void;
    const resolve = (allowPrivate: boolean, all: boolean) =>
      new Promise<{ err: Error | null; addr: unknown }>((done) =>
        (transport.guardedLookup(allowPrivate) as unknown as Lookup)("localhost", { all }, (err, addr) =>
          done({ err, addr }),
        ),
      );
    const blocked = await resolve(false, false);
    assert.match(blocked.err?.message ?? "", /localhost resolves to a private address/);
    const single = await resolve(true, false);
    assert.equal(single.err, null);
    assert.equal(typeof single.addr, "string");
    const all = await resolve(true, true);
    assert.ok(Array.isArray(all.addr) && all.addr.length > 0);

    // And the socket really uses it: a name, not a literal, reaches the server.
    const viaName = await transport.postJson(
      new URL(`${base.replace("127.0.0.1", "localhost")}/hook`),
      "{}",
      {},
      { timeoutMs: 2000, allowPrivate: true },
    );
    assert.equal(viaName.status, 200);
  });

  it("keeps only the start of a long response", async () => {
    const r = await transport.postJson(new URL(`${base}/huge`), "{}", {}, { timeoutMs: 5000, allowPrivate: true });
    assert.equal(r.status, 500);
    assert.equal(r.body.length, 2048);
    assert.ok(r.ms < 2000, `took ${r.ms}ms; should not wait for the rest`);
  });

  it("does not follow redirects", async () => {
    const r = await transport.postJson(new URL(`${base}/redirect`), "{}", {}, { timeoutMs: 2000, allowPrivate: true });
    assert.equal(r.status, 302);
    assert.match(r.error ?? "", /Redirect to http:\/\/example.com\/ not followed/);
  });

  it("gives up after the timeout", async () => {
    const r = await transport.postJson(new URL(`${base}/slow`), "{}", {}, { timeoutMs: 300, allowPrivate: true });
    assert.equal(r.status, null);
    assert.match(r.error ?? "", /No response within/);
    assert.ok(r.ms >= 250 && r.ms < 2000, `took ${r.ms}ms`);
  });
});
