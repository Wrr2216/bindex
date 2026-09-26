import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startAiStub, type AiStub } from "./media-ai-core-stub";

// With no key set, the AI helpers must answer null at once, and never throw or
// reach out to anything, even though a base URL is configured.

let stub: AiStub;
type Ai = typeof import("../src/services/ai");
let ai: Ai;

before(async () => {
  stub = await startAiStub();
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LLM_BASE_URL = stub.url;
  process.env.LLM_API_KEY = "";
  process.env.LLM_VISION_MODEL = "";
  process.env.STT_BASE_URL = stub.url;
  process.env.STT_API_KEY = "";
  ai = await import("../src/services/ai");
});

after(async () => {
  await stub.close();
});

describe("with no provider configured", () => {
  it("reports everything unavailable", () => {
    assert.deepEqual(ai.aiAvailability(), { languageModel: false, vision: false, transcription: false });
  });

  it("returns null from visionJson and transcribe without making a request", async () => {
    const image = { mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    assert.equal(await ai.visionJson({ event: "test", system: "s", prompt: "p", images: [image] }), null);
    assert.equal(await ai.transcribe({ bytes: Buffer.from("audio"), mime: "audio/wav" }), null);
    assert.equal(await ai.chatJson({ event: "test", system: "s", user: "u" }), null);
    assert.equal(stub.chats.length + stub.transcriptions.length, 0);
  });
});
