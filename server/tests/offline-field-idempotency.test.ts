import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The module reaches the database client, which reads the environment when it
// loads, so the minimum configuration has to exist first. No connection is made.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Idem = typeof import("../src/services/offline-field/idempotency");
type Sw = typeof import("../src/services/offline-field/serviceWorker");
let idem: Idem;
let sw: Sw;

before(async () => {
  idem = await import("../src/services/offline-field/idempotency");
  sw = await import("../src/services/offline-field/serviceWorker");
});

describe("parseIdempotencyKey", () => {
  it("is absent when there is no header", () => {
    assert.equal(idem.parseIdempotencyKey(undefined), null);
  });

  it("accepts a bare key and a structured-field quoted one", () => {
    const k = "8e03978e-40d5-43e8-bc93-6894a57f9324";
    assert.equal(idem.parseIdempotencyKey(k), k);
    assert.equal(idem.parseIdempotencyKey(`"${k}"`), k);
    assert.equal(idem.parseIdempotencyKey(`  ${k} `), k);
  });

  it("rejects empty, oversized and non-printable keys", () => {
    assert.equal(idem.parseIdempotencyKey(""), "invalid");
    assert.equal(idem.parseIdempotencyKey('""'), "invalid");
    assert.equal(idem.parseIdempotencyKey("x".repeat(256)), "invalid");
    assert.equal(idem.parseIdempotencyKey("has space"), "invalid");
    assert.equal(idem.parseIdempotencyKey("tab\there"), "invalid");
  });
});

describe("requestFingerprint", () => {
  const base = { method: "PATCH", path: "/api/items/1", body: { locationId: "a" } };

  it("is stable for the same request", () => {
    assert.equal(idem.requestFingerprint(base), idem.requestFingerprint({ ...base }));
    assert.equal(
      idem.requestFingerprint(base),
      idem.requestFingerprint({ ...base, method: "patch" }),
    );
  });

  it("changes with the method, the path or the body", () => {
    const fp = idem.requestFingerprint(base);
    assert.notEqual(fp, idem.requestFingerprint({ ...base, method: "POST" }));
    assert.notEqual(fp, idem.requestFingerprint({ ...base, path: "/api/items/2" }));
    assert.notEqual(fp, idem.requestFingerprint({ ...base, body: { locationId: "b" } }));
  });

  it("identifies an unread upload by its type and size", () => {
    const photo = { method: "POST", path: "/api/items/1/photo", body: undefined };
    const a = idem.requestFingerprint({ ...photo, contentType: "image/jpeg", contentLength: "100" });
    const b = idem.requestFingerprint({ ...photo, contentType: "image/jpeg", contentLength: "100" });
    const c = idem.requestFingerprint({ ...photo, contentType: "image/jpeg", contentLength: "101" });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("decideExisting", () => {
  const done = {
    fingerprint: "fp",
    state: "done" as const,
    status: 200,
    contentType: "application/json",
    body: Buffer.from('{"ok":true}'),
  };

  it("replays the stored answer to the same request", () => {
    const out = idem.decideExisting(done, "fp");
    assert.equal(out.kind, "replay");
    if (out.kind !== "replay") return;
    assert.equal(out.status, 200);
    assert.equal(out.body.toString(), '{"ok":true}');
  });

  it("refuses the key on a different request", () => {
    assert.equal(idem.decideExisting(done, "other").kind, "mismatch");
  });

  it("asks the caller to wait while the first request is still running", () => {
    const pending = { ...done, state: "pending" as const, status: null, body: null };
    assert.equal(idem.decideExisting(pending, "fp").kind, "in_progress");
  });

  it("replays an empty body as empty", () => {
    const out = idem.decideExisting({ ...done, status: 204, body: null }, "fp");
    assert.equal(out.kind, "replay");
    if (out.kind === "replay") assert.equal(out.body.length, 0);
  });
});

describe("answerToKeep", () => {
  it("keeps a success with its body", () => {
    assert.equal(idem.answerToKeep(200, false, 1000), "body");
    assert.equal(idem.answerToKeep(201, false, 0), "body");
    assert.equal(idem.answerToKeep(204, false, 0), "body");
  });

  it("still remembers a success it cannot hold the body of, so it never runs twice", () => {
    assert.equal(idem.answerToKeep(200, true, 10), "empty");
    assert.equal(idem.answerToKeep(200, false, 50 * 1024 * 1024), "empty");
  });

  it("releases anything that did not succeed, so a retry runs for real", () => {
    assert.equal(idem.answerToKeep(400, false, 10), "release");
    assert.equal(idem.answerToKeep(404, false, 10), "release");
    assert.equal(idem.answerToKeep(409, false, 10), "release");
    assert.equal(idem.answerToKeep(500, false, 10), "release");
  });
});

describe("service worker stamping", () => {
  const template = 'const BUILD_ID = "__BINDEX_BUILD_ID__";\nconst PRECACHE = "__BINDEX_PRECACHE__";\n';

  it("writes the build id and the file list into the worker", () => {
    const out = sw.renderServiceWorker(template, "abc123", ["/assets/index-1.js", "/assets/index-1.css"]);
    assert.match(out, /const BUILD_ID = "abc123";/);
    assert.match(out, /const PRECACHE = \["\/assets\/index-1\.js","\/assets\/index-1\.css"\];/);
    assert.doesNotMatch(out, /__BINDEX_/);
  });

  it("gives a new build a new id, and the same build the same one", () => {
    const a = sw.buildIdFor("<html>1</html>", ["/assets/a.js", "/assets/b.css"]);
    assert.equal(a, sw.buildIdFor("<html>1</html>", ["/assets/b.css", "/assets/a.js"]));
    assert.notEqual(a, sw.buildIdFor("<html>2</html>", ["/assets/a.js", "/assets/b.css"]));
    assert.notEqual(a, sw.buildIdFor("<html>1</html>", ["/assets/a2.js", "/assets/b.css"]));
  });
});
