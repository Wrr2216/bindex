import assert from "node:assert/strict";
import net from "node:net";
import { before, describe, it } from "node:test";

// A configured provider that cannot be reached: the helpers log and answer
// null rather than failing whatever request asked them.

type Ai = typeof import("../src/services/ai");
let ai: Ai;

/** A port nothing is listening on. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

before(async () => {
  const port = await deadPort();
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL = "error";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_API_KEY = "key";
  process.env.STT_API_KEY = "key";
  ai = await import("../src/services/ai");
});

describe("with the provider unreachable", () => {
  it("returns null from visionJson and transcribe", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const png = createCanvas(8, 8).toBuffer("image/png");
    assert.equal(await ai.visionJson({ event: "test", system: "s", prompt: "p", images: [{ mime: "image/png", bytes: png }] }), null);
    assert.equal(await ai.transcribe({ bytes: Buffer.from("audio"), mime: "audio/wav" }), null);
  });
});
