import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { SAMPLE_DATA_PLATE, SAMPLE_TRANSCRIPTION, chatReply } from "./media-ai-core-stub";

// These modules read the environment when they load.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Magic = typeof import("../src/services/media-ai-core/magic");
type Range = typeof import("../src/services/media-ai-core/range");
type Canonical = typeof import("../src/services/media-ai-core/canonical");
type Reply = typeof import("../src/services/ai/reply");
type Plate = typeof import("../src/services/media-ai-core/dataPlate");
let magic: Magic;
let range: Range;
let canonical: Canonical;
let reply: Reply;
let plate: Plate;

before(async () => {
  magic = await import("../src/services/media-ai-core/magic");
  range = await import("../src/services/media-ai-core/range");
  canonical = await import("../src/services/media-ai-core/canonical");
  reply = await import("../src/services/ai/reply");
  plate = await import("../src/services/media-ai-core/dataPlate");
});

const bytes = (...values: (number | string)[]) =>
  Buffer.concat(values.map((v) => (typeof v === "string" ? Buffer.from(v, "latin1") : Buffer.from([v]))));

/** An ISO base media file header: size, "ftyp", major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  return bytes(0, 0, 0, size, "ftyp", major, 0, 0, 0, 0, ...compatible, "moov");
};

describe("detectMime", () => {
  it("recognises images by their signature", () => {
    assert.equal(magic.detectMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, "JFIF")), "image/jpeg");
    assert.equal(magic.detectMime(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, "IHDR")), "image/png");
    assert.equal(magic.detectMime(bytes("GIF89a", 1, 0, 1, 0)), "image/gif");
    assert.equal(magic.detectMime(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")), "image/webp");
    assert.equal(magic.detectMime(ftyp("heic", "mif1", "heic")), "image/heic");
    assert.equal(magic.detectMime(ftyp("mif1", "mif1", "heic")), "image/heic");
    assert.equal(magic.detectMime(ftyp("mif1", "mif1")), "image/heif");
    assert.equal(magic.detectMime(ftyp("avif", "mif1", "avif")), "image/avif");
  });

  it("recognises video and audio containers", () => {
    assert.equal(magic.detectMime(ftyp("isom", "isom", "iso2", "avc1", "mp41")), "video/mp4");
    assert.equal(magic.detectMime(ftyp("mp42", "mp42", "isom")), "video/mp4");
    assert.equal(magic.detectMime(ftyp("qt  ", "qt  ")), "video/quicktime");
    assert.equal(magic.detectMime(ftyp("M4A ", "M4A ", "mp42")), "audio/mp4");
    assert.equal(magic.detectMime(ftyp("3gp4", "3gp4")), "video/3gpp");
    assert.equal(magic.detectMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, "webm")), "video/webm");
    assert.equal(magic.detectMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, "matroska")), "video/x-matroska");
    assert.equal(magic.detectMime(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")), "audio/wav");
    assert.equal(magic.detectMime(bytes("OggS", 0, 2)), "audio/ogg");
    assert.equal(magic.detectMime(bytes("fLaC", 0)), "audio/flac");
    assert.equal(magic.detectMime(bytes("ID3", 4, 0)), "audio/mpeg");
    assert.equal(magic.detectMime(bytes(0xff, 0xfb, 0x90, 0x64)), "audio/mpeg");
    assert.equal(magic.detectMime(bytes(0xff, 0xf1, 0x50, 0x80)), "audio/aac");
  });

  it("uses the declared type only to break ties the bytes cannot", () => {
    // A recorder's audio-only WebM and MP4 look like video from the header.
    assert.equal(magic.detectMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, "webm"), "audio/webm;codecs=opus"), "audio/webm");
    assert.equal(magic.detectMime(ftyp("iso5", "iso5", "mp41"), "audio/mp4"), "audio/mp4");
    assert.equal(magic.detectMime(bytes("OggS", 0, 2), "video/ogg"), "video/ogg");
    // Office files are zips; the claim names which kind.
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    assert.equal(magic.detectMime(bytes("PK", 3, 4, 20, 0), docx), docx);
    assert.equal(magic.detectMime(bytes("PK", 3, 4, 20, 0), "application/octet-stream"), "application/zip");
  });

  it("believes the bytes over the claim", () => {
    const png = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a);
    assert.equal(magic.detectMime(png, "image/jpeg"), "image/png");
    assert.equal(magic.detectMime(bytes("not really a photo"), "image/jpeg"), null);
    assert.equal(magic.detectMime(bytes("%PDF-1.7\n"), "image/png"), "application/pdf");
  });

  it("refuses types that would run script from our origin", () => {
    assert.equal(magic.detectMime(bytes('<svg xmlns="http://www.w3.org/2000/svg">'), "image/svg+xml"), null);
    assert.equal(magic.detectMime(bytes("<!doctype html><script>"), "text/html"), null);
  });

  it("accepts plain text only when it is declared and looks like text", () => {
    assert.equal(magic.detectMime(bytes("serial,model\n123,A\n"), "text/csv"), "text/csv");
    assert.equal(magic.detectMime(bytes('{"a":1}'), "application/json"), "application/json");
    assert.equal(magic.detectMime(bytes("abc", 0, "def"), "text/plain"), null);
    assert.equal(magic.detectMime(bytes("just words"), "application/octet-stream"), null);
    assert.equal(magic.detectMime(Buffer.alloc(0), "text/plain"), null);
  });
});

describe("kindAccepts and inferKind", () => {
  it("matches kinds to types", () => {
    assert.equal(magic.kindAccepts("photo", "image/heic"), true);
    assert.equal(magic.kindAccepts("photo", "video/mp4"), false);
    assert.equal(magic.kindAccepts("video", "video/quicktime"), true);
    assert.equal(magic.kindAccepts("audio", "audio/webm"), true);
    assert.equal(magic.kindAccepts("document", "application/pdf"), true);
    assert.equal(magic.kindAccepts("document", "image/jpeg"), true);
    assert.equal(magic.kindAccepts("document", "video/mp4"), false);
    assert.equal(magic.kindAccepts("signature", "image/png"), true);
    assert.equal(magic.kindAccepts("signature", "image/heic"), false);
    assert.equal(magic.inferKind("image/png"), "photo");
    assert.equal(magic.inferKind("video/webm"), "video");
    assert.equal(magic.inferKind("audio/mpeg"), "audio");
    assert.equal(magic.inferKind("application/pdf"), "document");
  });
});

/** Insert an EXIF APP1 segment carrying `orientation` into a JPEG. */
function withOrientation(jpeg: Buffer, orientation: number, little = false): Buffer {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const tiff = Buffer.from([
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0),
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = payload.length + 2;
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload, jpeg.subarray(2)]);
}

describe("imageSize", () => {
  const canvas = createCanvas(64, 32);
  canvas.getContext("2d").fillRect(0, 0, 10, 10);

  it("reads PNG and JPEG dimensions without decoding", () => {
    assert.deepEqual(magic.imageSize(canvas.toBuffer("image/png")), { width: 64, height: 32, orientation: 1 });
    assert.deepEqual(magic.imageSize(canvas.toBuffer("image/jpeg")), { width: 64, height: 32, orientation: 1 });
  });

  it("reports EXIF orientation from either byte order", () => {
    const jpeg = canvas.toBuffer("image/jpeg");
    assert.equal(magic.imageSize(withOrientation(jpeg, 6))?.orientation, 6);
    assert.equal(magic.imageSize(withOrientation(jpeg, 8, true))?.orientation, 8);
    assert.equal(magic.imageSize(withOrientation(jpeg, 42))?.orientation, 1);
  });

  it("reads GIF and WebP headers", () => {
    assert.deepEqual(magic.imageSize(bytes("GIF89a", 0x20, 0x03, 0x58, 0x02, 0)), { width: 800, height: 600, orientation: 1 });
    // VP8X: 24-bit width-1 and height-1 at offsets 24 and 27.
    const vp8x = bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8X", 10, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x07, 0, 0x37, 0x04, 0);
    assert.deepEqual(magic.imageSize(vp8x), { width: 1920, height: 1080, orientation: 1 });
  });

  it("returns null for anything else or a truncated header", () => {
    assert.equal(magic.imageSize(bytes("%PDF-1.7")), null);
    assert.equal(magic.imageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00)), null);
  });
});

describe("parseRange", () => {
  it("ignores a missing or unusable header, which means the whole file", () => {
    assert.equal(range.parseRange(undefined, 1000), null);
    assert.equal(range.parseRange("", 1000), null);
    assert.equal(range.parseRange("items=0-10", 1000), null);
    assert.equal(range.parseRange("bytes=abc", 1000), null);
    assert.equal(range.parseRange("bytes=-", 1000), null);
    assert.equal(range.parseRange("bytes=500-100", 1000), null);
    // Several ranges at once are allowed to be answered with the whole file.
    assert.equal(range.parseRange("bytes=0-10,20-30", 1000), null);
  });

  it("reads the ranges a video element sends", () => {
    assert.deepEqual(range.parseRange("bytes=0-", 1000), { start: 0, end: 999 });
    assert.deepEqual(range.parseRange("bytes=0-1", 1000), { start: 0, end: 1 });
    assert.deepEqual(range.parseRange("bytes=500-999", 1000), { start: 500, end: 999 });
    assert.deepEqual(range.parseRange(" bytes = 10 - 19 ", 1000), { start: 10, end: 19 });
  });

  it("clamps an end past the file and reads suffix ranges", () => {
    assert.deepEqual(range.parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
    assert.deepEqual(range.parseRange("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(range.parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
  });

  it("marks ranges outside the file unsatisfiable", () => {
    assert.equal(range.parseRange("bytes=1000-", 1000), "unsatisfiable");
    assert.equal(range.parseRange("bytes=2000-3000", 1000), "unsatisfiable");
    assert.equal(range.parseRange("bytes=-0", 1000), "unsatisfiable");
    assert.equal(range.parseRange("bytes=0-", 0), "unsatisfiable");
  });

  it("handles offsets beyond 4 GB", () => {
    const size = 6 * 1024 ** 3;
    assert.deepEqual(range.parseRange(`bytes=${5 * 1024 ** 3}-`, size), { start: 5 * 1024 ** 3, end: size - 1 });
  });

  it("formats Content-Range", () => {
    assert.equal(range.contentRange({ start: 0, end: 99 }, 1000), "bytes 0-99/1000");
  });
});

describe("canonicalJson and contentHash", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    assert.equal(
      canonical.canonicalJson({ b: 1, a: [true, null, "x", { d: 2, c: 1 }] }),
      '{"a":[true,null,"x",{"c":1,"d":2}],"b":1}',
    );
  });

  it("hashes the same content the same way whatever the key order", () => {
    const a = { items: [{ id: "1", qty: 2 }], signer: "Pat" };
    const b = { signer: "Pat", items: [{ qty: 2, id: "1" }] };
    assert.equal(canonical.contentHash(a), canonical.contentHash(b));
    assert.match(canonical.contentHash(a), /^[0-9a-f]{64}$/);
  });

  it("changes the hash when anything signed changes", () => {
    const signed = { items: [{ id: "1", qty: 2 }, { id: "2", qty: 1 }] };
    const base = canonical.contentHash(signed);
    assert.notEqual(canonical.contentHash({ items: [{ id: "1", qty: 3 }, { id: "2", qty: 1 }] }), base);
    assert.notEqual(canonical.contentHash({ items: [{ id: "2", qty: 1 }, { id: "1", qty: 2 }] }), base, "array order matters");
    assert.notEqual(canonical.contentHash({ items: [{ id: "1", qty: 2 }] }), base);
  });

  it("follows JSON.stringify for values JSON cannot carry", () => {
    const when = new Date("2026-09-26T12:00:00.000Z");
    assert.equal(
      canonical.canonicalJson({ at: when, gone: undefined, nan: NaN, inf: -Infinity, list: [undefined, 1] }),
      '{"at":"2026-09-26T12:00:00.000Z","inf":null,"list":[null,1],"nan":null}',
    );
    // So content that has been through the API hashes like the original.
    const original = { at: when, n: 1.5, s: "café ✓" };
    assert.equal(canonical.contentHash(original), canonical.contentHash(JSON.parse(JSON.stringify(original))));
  });

  it("writes numbers and strings the way the JSON canonicalization scheme does", () => {
    assert.equal(canonical.canonicalJson([1e21, 0.1, -0, 100, " ", "\n"]), '[1e+21,0.1,0,100," ","\\n"]');
  });

  it("refuses what it cannot represent", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assert.throws(() => canonical.canonicalJson(loop), /circular/);
    assert.throws(() => canonical.canonicalJson({ n: BigInt(1) }), /bigint/);
    // The same object twice is not a cycle.
    const shared = { a: 1 };
    assert.equal(canonical.canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
  });
});

describe("parseChatReply", () => {
  const json = (r: ReturnType<typeof chatReply>) => r.json;

  it("reads a bare, fenced or chatty JSON object", () => {
    assert.deepEqual(reply.parseChatReply(json(chatReply('{"brand":"Dell"}'))), { brand: "Dell" });
    assert.deepEqual(reply.parseChatReply(json(chatReply('```json\n{"brand":"Dell"}\n```'))), { brand: "Dell" });
    assert.deepEqual(reply.parseChatReply(json(chatReply('Here you go:\n{"brand":"Dell"}\nAnything else?'))), { brand: "Dell" });
  });

  it("unwraps a single object a model put in a list", () => {
    assert.deepEqual(reply.parseChatReply(json(chatReply('[{"brand":"Dell"}]'))), { brand: "Dell" });
  });

  it("reads content sent as parts", () => {
    const parts = [{ type: "text", text: '{"serial":' }, { type: "text", text: '"ABC"}' }];
    assert.deepEqual(reply.parseChatReply(json(chatReply(parts))), { serial: "ABC" });
  });

  it("returns null for anything that is not one JSON object", () => {
    assert.equal(reply.parseChatReply(json(chatReply("I cannot read this label."))), null);
    assert.equal(reply.parseChatReply(json(chatReply('{"brand": "Dell", "model": '))), null, "cut off by max_tokens");
    assert.equal(reply.parseChatReply(json(chatReply('[{"brand":"Dell"},{"brand":"HP"}]'))), null);
    assert.equal(reply.parseChatReply(json(chatReply(null))), null, "a refusal carries no content");
    assert.equal(reply.parseChatReply({ choices: [] }), null);
    assert.equal(reply.parseChatReply({ error: { message: "model does not support images" } }), null);
    assert.equal(reply.parseChatReply(null), null);
    assert.equal(reply.parseChatReply("not an object"), null);
  });
});

describe("parseTranscription", () => {
  it("reads verbose_json with timestamps", () => {
    const t = reply.parseTranscription(SAMPLE_TRANSCRIPTION)!;
    assert.equal(t.text, SAMPLE_TRANSCRIPTION.text);
    assert.deepEqual(t.segments, [
      { start: 0, end: 4.2, text: "Remove the four screws on the back panel." },
      { start: 4.2, end: 9.5, text: "Then lift the cover." },
    ]);
    assert.equal(t.language, "english");
    assert.equal(t.durationSec, 9.5);
  });

  it("accepts plain json without segments", () => {
    assert.deepEqual(reply.parseTranscription({ text: " Hello. " }), { text: "Hello.", segments: [] });
  });

  it("drops segments with missing or backwards times", () => {
    const t = reply.parseTranscription({
      text: "",
      segments: [
        { start: 0, end: 1, text: "ok" },
        { start: 3, end: 2, text: "backwards" },
        { start: "x", end: 4, text: "bad start" },
        { start: 4, end: 5, text: "   " },
        { start: "5", end: "6.5", text: "strings are fine" },
      ],
    })!;
    assert.deepEqual(t.segments.map((s) => s.text), ["ok", "strings are fine"]);
    assert.equal(t.text, "ok strings are fine");
  });

  it("returns null when there is no text at all", () => {
    assert.equal(reply.parseTranscription({ segments: [] }), null);
    assert.equal(reply.parseTranscription([]), null);
    assert.equal(reply.parseTranscription(null), null);
  });
});

describe("normalizeDataPlate", () => {
  it("cleans a typical reading", () => {
    const r = plate.normalizeDataPlate(structuredClone(SAMPLE_DATA_PLATE))!;
    assert.equal(r.brand, "Dell");
    assert.equal(r.model, "Latitude 5440");
    assert.equal(r.serial, "7XK2P93");
    assert.equal(r.partNumber, "0R9KW3");
    assert.equal(r.mac, "A4:BB:6D:12:34:56");
    assert.equal(r.manufactureDate, "2024-03");
    assert.deepEqual(r.ratings, { voltage: "19.5V", amperage: "3.34A", wattage: "65W", frequency: null });
    assert.deepEqual(r.otherIdentifiers, [
      { label: "Service Tag", value: "7XK2P93" },
      { label: "FCC ID", value: "E2K-AX211NG" },
    ]);
    assert.equal(r.confidence.brand, 0.98);
    assert.equal(r.confidence.mac, 0.9, "words become numbers");
    assert.equal(r.confidence.partNumber, 0.4);
    assert.equal(r.confidence.voltage, 0.5, "an unstated confidence lands under the line");
    assert.equal(r.confidence.assetTag, 0);
    assert.equal(r.confidence.frequency, 0);
    assert.ok(r.confidence.partNumber < plate.LOW_CONFIDENCE);
  });

  it("distrusts an identifier that is not in the label text", () => {
    const r = plate.normalizeDataPlate({
      serial: "ZZ999",
      model: "X1",
      confidence: { serial: 0.99, model: 0.99 },
      rawText: "MODEL X1\nSN AB123",
    })!;
    assert.equal(r.confidence.model, 0.99);
    assert.equal(r.confidence.serial, 0.5);
  });

  it("strips printed labels but not a serial that starts like one", () => {
    const read = (serial: string) => plate.normalizeDataPlate({ serial })!.serial;
    assert.equal(read("S/N: 12345"), "12345");
    assert.equal(read("S/N12345"), "12345");
    assert.equal(read("Serial No. 12345"), "12345");
    assert.equal(read("SN: 12345"), "12345");
    assert.equal(read("SNX12345"), "SNX12345");
    assert.equal(read("SERV1234"), "SERV1234");
  });

  it("treats placeholders as not read and numbers as text", () => {
    const r = plate.normalizeDataPlate({ brand: "N/A", model: "  ", serial: 123456, assetTag: "unknown", confidence: { serial: 95 } })!;
    assert.equal(r.brand, null);
    assert.equal(r.model, null);
    assert.equal(r.serial, "123456");
    assert.equal(r.assetTag, null);
    assert.equal(r.confidence.serial, 0.95);
    assert.equal(plate.readingFound(r), true);
  });

  it("keeps an unreadable MAC as another identifier rather than inventing one", () => {
    const r = plate.normalizeDataPlate({ mac: "A4:BB:6D:12:34" })!;
    assert.equal(r.mac, null);
    assert.deepEqual(r.otherIdentifiers, [{ label: "MAC (unrecognised)", value: "A4:BB:6D:12:34" }]);
  });

  it("accepts ratings flat or nested and confidence keyed either way", () => {
    const r = plate.normalizeDataPlate({
      voltage: "120V",
      ratings: { current: "10A", power: "1200W", frequency: "60Hz" },
      confidence: { "ratings.voltage": 0.8, ratings: { frequency: 0.3 } },
    })!;
    assert.deepEqual(r.ratings, { voltage: "120V", amperage: "10A", wattage: "1200W", frequency: "60Hz" });
    assert.equal(r.confidence.voltage, 0.8);
    assert.equal(r.confidence.frequency, 0.3);
  });

  it("returns null or an empty reading for replies with nothing in them", () => {
    assert.equal(plate.normalizeDataPlate(null), null);
    assert.equal(plate.normalizeDataPlate([] as unknown as Record<string, unknown>), null);
    const empty = plate.normalizeDataPlate({ brand: null, serial: null, rawText: "" })!;
    assert.equal(plate.readingFound(empty), false);
    assert.equal(plate.readingFound(null), false);
  });
});

describe("data plate value helpers", () => {
  it("normalizes MAC addresses", () => {
    assert.equal(plate.normalizeMac("a4-bb-6d-12-34-56"), "A4:BB:6D:12:34:56");
    assert.equal(plate.normalizeMac("A4BB.6D12.3456"), "A4:BB:6D:12:34:56");
    assert.equal(plate.normalizeMac("MAC: a4bb6d123456"), "A4:BB:6D:12:34:56");
    assert.equal(plate.normalizeMac("a4bb6d12345"), null);
    assert.equal(plate.normalizeMac("G4BB6D123456"), null);
    assert.equal(plate.normalizeMac(null), null);
  });

  it("normalizes printed dates only when unambiguous", () => {
    assert.equal(plate.normalizeDate("2021-3"), "2021-03");
    assert.equal(plate.normalizeDate("2021/03/15"), "2021-03-15");
    assert.equal(plate.normalizeDate("MFG: 03.2021"), "2021-03");
    assert.equal(plate.normalizeDate("MAR 2021"), "2021-03");
    assert.equal(plate.normalizeDate("September, 2019"), "2019-09");
    assert.equal(plate.normalizeDate("2021-13"), "2021-13");
    assert.equal(plate.normalizeDate("Week 12 2021"), "Week 12 2021");
    assert.equal(plate.normalizeDate(null), null);
  });

  it("reads confidence however the model wrote it", () => {
    assert.equal(plate.confidenceValue(0.7), 0.7);
    assert.equal(plate.confidenceValue(70), 0.7);
    assert.equal(plate.confidenceValue("70%"), 0.7);
    assert.equal(plate.confidenceValue("0.7"), 0.7);
    assert.equal(plate.confidenceValue("High"), 0.9);
    assert.equal(plate.confidenceValue("low"), 0.3);
    assert.equal(plate.confidenceValue(-1), null);
    assert.equal(plate.confidenceValue(250), null);
    assert.equal(plate.confidenceValue("sure"), null);
    assert.equal(plate.confidenceValue(undefined), null);
  });
});
