import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  SAMPLE_DATA_PLATE,
  SAMPLE_TRANSCRIPTION,
  chatReply,
  startAiStub,
  type AiStub,
  type CapturedChat,
  type CapturedTranscription,
  type StubResponse,
} from "./media-ai-core-stub";

// The AI helpers against a local provider stand-in: the request shapes they
// send and what they make of good, bad and broken replies.

let stub: AiStub;
let onChat: (c: CapturedChat) => StubResponse;
let onTranscription: (t: CapturedTranscription) => StubResponse;

type Ai = typeof import("../src/services/ai");
type Plate = typeof import("../src/services/media-ai-core/dataPlate");
type Magic = typeof import("../src/services/media-ai-core/magic");
let ai: Ai;
let plate: Plate;
let magic: Magic;

before(async () => {
  stub = await startAiStub({ chat: (c) => onChat(c), transcription: (t) => onTranscription(t) });
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  // The failure cases below log warnings by design.
  process.env.LOG_LEVEL ??= "error";
  process.env.LLM_BASE_URL = stub.url;
  process.env.LLM_API_KEY = "stub-key";
  process.env.LLM_MODEL = "text-model";
  process.env.LLM_VISION_MODEL = "vision-model";
  process.env.STT_BASE_URL = stub.url;
  process.env.STT_API_KEY = "stt-key";
  process.env.STT_MODEL = "whisper-test";
  ai = await import("../src/services/ai");
  plate = await import("../src/services/media-ai-core/dataPlate");
  magic = await import("../src/services/media-ai-core/magic");
});

after(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.chats.length = 0;
  stub.transcriptions.length = 0;
  onChat = () => chatReply(JSON.stringify(SAMPLE_DATA_PLATE));
  onTranscription = () => ({ json: SAMPLE_TRANSCRIPTION });
});

function photo(width: number, height: number, type: "image/png" | "image/jpeg" = "image/png"): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#336";
  ctx.fillRect(0, 0, width, height);
  return type === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg");
}

const ask = (images: { mime: string; bytes: Buffer }[]) =>
  ai.visionJson({ event: "test.vision", system: "You read labels.", prompt: "Read it.", images });

describe("visionJson", () => {
  it("sends an OpenAI-compatible request with the photo as a data URL", async () => {
    const result = await ask([{ mime: "image/png", bytes: photo(200, 100) }]);
    assert.deepEqual(result, SAMPLE_DATA_PLATE);
    assert.equal(stub.chats.length, 1);
    const { headers, body } = stub.chats[0]!;
    assert.equal(headers.authorization, "Bearer stub-key");
    assert.equal(body.model, "vision-model");
    assert.equal(body.temperature, 0);
    const messages = body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages[0], { role: "system", content: "You read labels." });
    const parts = messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
    assert.equal(messages[1]!.role, "user");
    assert.deepEqual(parts[0], { type: "text", text: "Read it." });
    assert.equal(parts[1]!.type, "image_url");
    assert.match(parts[1]!.image_url!.url, /^data:image\/jpeg;base64,/);
  });

  it("scales a large photo down to 1600 px on its longest side", async () => {
    await ask([{ mime: "image/png", bytes: photo(4000, 1000) }]);
    const parts = (stub.chats[0]!.body.messages as { content: { image_url?: { url: string } }[] }[])[1]!.content;
    const sent = Buffer.from(parts[1]!.image_url!.url.split(",")[1]!, "base64");
    assert.deepEqual(magic.imageSize(sent), { width: 1600, height: 400, orientation: 1 });
  });

  it("sends every image, up to the cap", async () => {
    const images = Array.from({ length: 12 }, () => ({ mime: "image/jpeg", bytes: photo(20, 20, "image/jpeg") }));
    await ask(images);
    const parts = (stub.chats[0]!.body.messages as { content: unknown[] }[])[1]!.content;
    assert.equal(parts.length, 1 + 10);
  });

  it("does not call the provider when no image can be read", async () => {
    const result = await ask([{ mime: "image/heic", bytes: Buffer.from("definitely not an image") }]);
    assert.equal(result, null);
    assert.equal(stub.chats.length, 0);
  });

  it("returns null, never throwing, for malformed and failed replies", async () => {
    const replies: StubResponse[] = [
      chatReply("Sorry, I can't make out the label."),
      chatReply('{"brand": "Dell", "model": '),
      chatReply(null),
      { json: { choices: [] } },
      { text: "<html>Bad gateway</html>", status: 200 },
      { status: 400, json: { error: { message: "This model does not support image input" } } },
      { status: 500, text: "upstream exploded" },
      { status: 429, json: { error: { message: "rate limited" } } },
    ];
    for (const r of replies) {
      onChat = () => r;
      assert.equal(await ask([{ mime: "image/png", bytes: photo(10, 10) }]), null, JSON.stringify(r).slice(0, 80));
    }
  });
});

describe("readDataPlate", () => {
  it("turns the model's reply into a normalized reading", async () => {
    const reading = await plate.readDataPlate({ mime: "image/png", bytes: photo(300, 200) });
    assert.equal(reading?.serial, "7XK2P93");
    assert.equal(reading?.mac, "A4:BB:6D:12:34:56");
    const body = stub.chats[0]!.body;
    assert.equal((body.messages as { content: unknown }[])[0]!.content, plate.DATA_PLATE_SYSTEM);
  });

  it("returns null when the model says nothing useful", async () => {
    onChat = () => chatReply("no label here");
    assert.equal(await plate.readDataPlate({ mime: "image/png", bytes: photo(30, 20) }), null);
  });
});

describe("transcribe", () => {
  const audio = Buffer.from("fake audio bytes, the stub does not decode them");

  it("posts multipart form data asking for verbose_json", async () => {
    const t = await ai.transcribe({ bytes: audio, mime: "audio/mp4", language: "en", prompt: "torx, bezel" });
    assert.deepEqual(t?.segments[0], { start: 0, end: 4.2, text: "Remove the four screws on the back panel." });
    const req = stub.transcriptions[0]!;
    assert.equal(req.headers.authorization, "Bearer stt-key");
    assert.equal(req.fields.model, "whisper-test");
    assert.equal(req.fields.response_format, "verbose_json");
    assert.equal(req.fields.language, "en");
    assert.equal(req.fields.prompt, "torx, bezel");
    assert.deepEqual(req.file, { name: "audio.m4a", type: "audio/mp4", size: audio.length });
  });

  it("accepts a stream or a path as well as bytes", async () => {
    const fromStream = await ai.transcribe({ stream: Readable.from([audio.subarray(0, 5), audio.subarray(5)]), mime: "audio/webm", filename: "note.webm" });
    assert.equal(fromStream?.text, SAMPLE_TRANSCRIPTION.text);
    assert.deepEqual(stub.transcriptions[0]!.file, { name: "note.webm", type: "audio/webm", size: audio.length });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bindex-stt-"));
    const file = path.join(dir, "a.mp3");
    fs.writeFileSync(file, audio);
    try {
      const fromPath = await ai.transcribe({ path: file, mime: "audio/mpeg" });
      assert.equal(fromPath?.segments.length, 2);
      assert.equal(stub.transcriptions[1]!.file?.size, audio.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copes with a server that answers in plain text", async () => {
    onTranscription = () => ({ text: "  just the words  " });
    assert.deepEqual(await ai.transcribe({ bytes: audio, mime: "audio/wav" }), { text: "just the words", segments: [] });
  });

  it("returns null, never throwing, on failure", async () => {
    for (const r of [{ status: 500, text: "boom" }, { status: 413, json: { error: "too big" } }, { json: { segments: [] } }] as StubResponse[]) {
      onTranscription = () => r;
      assert.equal(await ai.transcribe({ bytes: audio, mime: "audio/wav" }), null);
    }
  });
});

describe("aiAvailability", () => {
  it("reports what is configured", () => {
    assert.deepEqual(ai.aiAvailability(), { languageModel: true, vision: true, transcription: true });
  });
});
