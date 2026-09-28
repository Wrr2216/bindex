import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

// The streaming receiver behind every upload: small files stay in memory for
// the database, large ones spill to disk as they arrive, and the hash and the
// sniffed header are taken in the same pass.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-data-"));
type Storage = typeof import("../src/services/media-ai-core/storage");
let storage: Storage;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.DATA_DIR = dataDir;
  storage = await import("../src/services/media-ai-core/storage");
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const payload = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
function chunks(buf: Buffer, size: number): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}
const tmpFiles = () => (fs.existsSync(storage.tmpRoot()) ? fs.readdirSync(storage.tmpRoot()) : []);

describe("receive", () => {
  it("keeps a small stream in memory", async () => {
    const data = payload(5000);
    const got = await storage.receive(chunks(data, 700), { spillOver: 10_000, max: 20_000 });
    assert.equal(got.size, 5000);
    assert.equal(got.sha256, sha(data));
    assert.deepEqual(got.bytes, data);
    assert.equal(got.tmpPath, null);
    assert.deepEqual(got.head, data.subarray(0, 4100));
  });

  it("spills a large stream to disk once it passes the threshold", async () => {
    const data = payload(50_000);
    const got = await storage.receive(chunks(data, 3000), { spillOver: 10_000, max: 100_000 });
    assert.equal(got.bytes, null);
    assert.ok(got.tmpPath?.startsWith(storage.tmpRoot()));
    assert.deepEqual(fs.readFileSync(got.tmpPath!), data);
    assert.equal(got.sha256, sha(data));
    assert.equal(got.head.length, 4100);

    const rel = await storage.commitTmp(got.tmpPath!, "0123abcd-0000-4000-8000-000000000000");
    assert.equal(rel, "attachments/01/0123abcd-0000-4000-8000-000000000000");
    assert.deepEqual(fs.readFileSync(storage.absolutePath(rel)), data);
    assert.equal(fs.existsSync(got.tmpPath!), false);
  });

  it("spills a large buffer to disk too", async () => {
    const data = payload(30_000);
    const got = await storage.receive(data, { spillOver: 10_000, max: 100_000 });
    assert.equal(got.bytes, null);
    assert.deepEqual(fs.readFileSync(got.tmpPath!), data);
    fs.rmSync(got.tmpPath!);
  });

  it("refuses an oversized upload part way through and leaves nothing behind", async () => {
    const before = tmpFiles().length;
    await assert.rejects(
      storage.receive(chunks(payload(80_000), 4000), { spillOver: 10_000, max: 50_000 }),
      (err: { status?: number }) => err.status === 413,
    );
    assert.equal(tmpFiles().length, before);
    await assert.rejects(
      storage.receive(payload(60_000), { spillOver: 10_000, max: 50_000 }),
      (err: { status?: number; message: string }) => err.status === 413 && /49 KB/.test(err.message),
    );
  });

  it("cleans up when the client hangs up mid-upload", async () => {
    const before = tmpFiles().length;
    async function* dropped() {
      yield payload(20_000);
      yield payload(20_000);
      throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    }
    await assert.rejects(storage.receive(Readable.from(dropped()), { spillOver: 10_000, max: 1_000_000 }), /aborted/);
    assert.equal(tmpFiles().length, before);
  });
});

describe("absolutePath", () => {
  it("never resolves outside DATA_DIR", () => {
    assert.ok(storage.absolutePath("attachments/ab/x").startsWith(fs.realpathSync(dataDir)) || storage.absolutePath("attachments/ab/x").startsWith(dataDir));
    assert.throws(() => storage.absolutePath("../etc/passwd"), /escapes/);
    assert.throws(() => storage.absolutePath("/etc/passwd"), /escapes/);
  });
});
