import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { chatReply, startAiStub, type AiStub, type CapturedChat, type StubResponse } from "./media-ai-core-stub";

// Reading damage from a photo and matching findings, against the local
// OpenAI-compatible stand-in: what is sent, and what comes of good, broken and
// failed replies.

let stub: AiStub;
let onChat: (c: CapturedChat) => StubResponse;

type Ai = typeof import("../src/services/inspections/ai");
let ai: Ai;

before(async () => {
  stub = await startAiStub({ chat: (c) => onChat(c) });
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL ??= "error";
  process.env.LLM_BASE_URL = stub.url;
  process.env.LLM_API_KEY = "stub-key";
  process.env.LLM_MODEL = "text-model";
  process.env.LLM_VISION_MODEL = "vision-model";
  ai = await import("../src/services/inspections/ai");
});

after(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.chats.length = 0;
});

function photo(): Buffer {
  const canvas = createCanvas(300, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ccc";
  ctx.fillRect(0, 0, 300, 200);
  return canvas.toBuffer("image/png");
}

const rooms = [
  { name: "Level 5 / Boardroom", locationId: "loc-board" },
  { name: "Level 5 / Kitchen", locationId: "loc-kitchen" },
];

type Part = { type: string; text?: string; image_url?: { url: string } };

describe("readDamage", () => {
  it("sends the photo with the site's rooms and returns an editable suggestion", async () => {
    onChat = () =>
      chatReply(
        "```json\n" +
          JSON.stringify({
            damage: true,
            area: "Interior",
            room: "boardroom",
            spot: "Skirting",
            spotDetail: "under the window",
            description: "Chipped paint on the skirting, about 10 cm long.",
            severity: "Moderate",
            confidence: 0.82,
          }) +
          "\n```",
      );
    const s = await ai.readDamage({ mime: "image/png", bytes: photo() }, { kind: "post", siteName: "New HQ", knownRooms: rooms });
    assert.deepEqual(s, {
      damage: true,
      area: "inside",
      room: "Level 5 / Boardroom",
      locationId: "loc-board",
      spot: "baseboard",
      spotDetail: "under the window",
      description: "Chipped paint on the skirting, about 10 cm long.",
      severity: "moderate",
      confidence: 0.82,
    });
    assert.equal(stub.chats.length, 1);
    const body = stub.chats[0]!.body as { model: string; messages: { role: string; content: string | Part[] }[] };
    assert.equal(body.model, "vision-model");
    const parts = body.messages[1]!.content as Part[];
    assert.match(parts[0]!.text!, /"Level 5 \/ Kitchen"/);
    assert.match(parts[0]!.text!, /New HQ after a move/);
    assert.match(parts[1]!.image_url!.url, /^data:image\/jpeg;base64,/);
  });

  it("returns null when the provider fails or talks nonsense, so the form opens empty", async () => {
    onChat = () => ({ status: 500, json: { error: { message: "down" } } });
    assert.equal(await ai.readDamage({ mime: "image/png", bytes: photo() }, { kind: "pre", siteName: "Old HQ", knownRooms: [] }), null);
    onChat = () => chatReply("I think there is a scuff on the wall.");
    assert.equal(await ai.readDamage({ mime: "image/png", bytes: photo() }, { kind: "pre", siteName: "Old HQ", knownRooms: [] }), null);
    onChat = () => chatReply(JSON.stringify({ confidence: 0.1 }));
    assert.equal(await ai.readDamage({ mime: "image/png", bytes: photo() }, { kind: "pre", siteName: "Old HQ", knownRooms: [] }), null);
  });
});

describe("matchWithAi", () => {
  const finding = (id: string, room: string, spot: string, description: string) => ({
    id,
    sequence: 1,
    room,
    locationId: null,
    spot,
    spotDetail: null,
    description,
    severity: "minor" as const,
    preExisting: false,
  });
  const pre = [finding("pre-1", "Boardroom", "trim", "Chipped paint"), finding("pre-2", "Hall", "door", "Dent")];
  const post = [finding("post-1", "Conference room", "baseboard", "Paint chipped"), finding("post-2", "Lobby", "floor", "Scratch")];

  it("asks the text model and maps its answer back to finding ids", async () => {
    onChat = () => chatReply(JSON.stringify({ matches: [{ pre: "P1", post: "Q1", confidence: 0.9 }, { pre: "P2", post: "Q2", confidence: 0.3 }] }));
    const pairs = await ai.matchWithAi(pre, post);
    assert.deepEqual(pairs, [{ preId: "pre-1", postId: "post-1", confidence: 0.9 }]);
    const body = stub.chats[0]!.body as { model: string; messages: { content: string }[] };
    assert.equal(body.model, "text-model");
    assert.match(body.messages[1]!.content, /P1\. room: Boardroom; spot: trim; severity: minor; "Chipped paint"/);
    assert.match(body.messages[1]!.content, /Q2\. room: Lobby/);
  });

  it("does not call the model when one side is empty, and reports failure as null", async () => {
    assert.deepEqual(await ai.matchWithAi([], post), []);
    assert.equal(stub.chats.length, 0);
    onChat = () => ({ status: 429, json: { error: { message: "slow down" } } });
    assert.equal(await ai.matchWithAi(pre, post), null);
  });
});
