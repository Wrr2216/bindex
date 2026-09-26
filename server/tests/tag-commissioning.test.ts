import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Modules read the environment when they load, so the minimum required
// configuration has to exist first.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Normalize = typeof import("../src/services/tag-commissioning/normalize");
type Epc = typeof import("../src/services/tag-commissioning/epc");
type Zpl = typeof import("../src/services/tag-commissioning/zpl");
type BulkBind = typeof import("../src/services/tag-commissioning/bulkBind");
type Tiers = typeof import("../src/services/tag-commissioning/tiers");
type Palette = typeof import("../src/services/tag-commissioning/palette");

let n: Normalize;
let epc: Epc;
let zpl: Zpl;
let bb: BulkBind;
let tiers: Tiers;
let palette: Palette;

before(async () => {
  n = await import("../src/services/tag-commissioning/normalize");
  epc = await import("../src/services/tag-commissioning/epc");
  zpl = await import("../src/services/tag-commissioning/zpl");
  bb = await import("../src/services/tag-commissioning/bulkBind");
  tiers = await import("../src/services/tag-commissioning/tiers");
  palette = await import("../src/services/tag-commissioning/palette");
});

describe("legacy sticker normalization", () => {
  it("stores colour, lot and number as COLOR-LOT-NUMBER", () => {
    assert.equal(n.legacyTagKey("RED 1234 056"), "RED-1234-56");
    assert.equal(n.legacyTagKey("red-1234-56"), "RED-1234-56");
  });

  it("ignores case", () => {
    for (const typed of ["red 1234 56", "Red 1234 56", "rEd 1234 56", "RED 1234 56"]) {
      assert.equal(n.legacyTagKey(typed), "RED-1234-56", typed);
    }
    assert.equal(n.legacyTagKey("blue a7 3"), "BLUE-A7-3");
  });

  it("ignores spacing and the kind of separator", () => {
    for (const typed of [
      "RED 1234 56",
      "  RED   1234   56  ",
      "RED\t1234\t56",
      "RED-1234-56",
      "RED--1234--56",
      "RED_1234_56",
      "RED/1234/56",
      "RED.1234.56",
      "RED, 1234, 56",
      "RED #1234 #56",
      "RED - 1234 - 56",
    ]) {
      assert.equal(n.legacyTagKey(typed), "RED-1234-56", JSON.stringify(typed));
    }
  });

  it("ignores zero padding on the number and on a numeric lot", () => {
    assert.equal(n.legacyTagKey("RED 1234 056"), "RED-1234-56");
    assert.equal(n.legacyTagKey("RED 1234 0056"), "RED-1234-56");
    assert.equal(n.legacyTagKey("RED 01234 56"), "RED-1234-56");
    assert.equal(n.legacyTagKey("RED 0 000"), "RED-0-0");
    assert.equal(n.legacyTagKey("RED 1234 0"), "RED-1234-0");
  });

  it("keeps a lettered lot as a label, only uppercased", () => {
    assert.equal(n.legacyTagKey("green 0a7 12"), "GREEN-0A7-12");
  });

  it("reads a colour typed straight into the lot", () => {
    assert.equal(n.legacyTagKey("RED1234 056"), "RED-1234-56");
    assert.equal(n.legacyTagKey("red1234-56"), "RED-1234-56");
  });

  it("allows a sticker with no lot", () => {
    assert.equal(n.legacyTagKey("yellow 0042"), "YELLOW-42");
    assert.deepEqual(n.parseLegacyTag("yellow 0042"), { color: "YELLOW", lot: null, number: 42 });
  });

  it("returns the parts", () => {
    assert.deepEqual(n.parseLegacyTag("red 1234 056"), { color: "RED", lot: "1234", number: 56 });
  });

  it("rejects what is not a sticker", () => {
    for (const typed of [
      "",
      "RED",
      "1234 56",
      "RED 1234 56 7",
      "RED 1234 5x",
      "INV-7F3K2A",
      "R3D 1 2",
      "RED 12 34 56",
      "RED 1234 1234567890123456",
    ]) {
      assert.equal(n.parseLegacyTag(typed), null, JSON.stringify(typed));
    }
  });

  it("formats round-trip", () => {
    const tag = { color: "PURPLE", lot: "77", number: 9 };
    assert.deepEqual(n.parseLegacyTag(n.formatLegacyTag(tag)), tag);
    assert.equal(n.formatLegacyTag({ color: "WHITE", lot: null, number: 1 }), "WHITE-1");
  });
});

describe("tag UID normalization", () => {
  it("stores hex UIDs as bare uppercase hex however they were grouped", () => {
    assert.equal(n.normalizeTagUid("04:a2:3b:4c:5d:6e:80"), "04A23B4C5D6E80");
    assert.equal(n.normalizeTagUid("04 A2 3B 4C"), "04A23B4C");
    assert.equal(n.normalizeTagUid("e200-3412-0123"), "E20034120123");
    assert.equal(n.normalizeTagUid(" 3074257bf7194e4000001a85 "), "3074257BF7194E4000001A85");
  });

  it("keeps anything that is not hex as typed", () => {
    assert.equal(n.normalizeTagUid("  CARD#00123 "), "CARD#00123");
  });

  it("gives one key for every spelling of a UID", () => {
    assert.equal(n.tagKey("04:a2:3b"), n.tagKey("04A23B"));
    assert.equal(n.tagKey("04-A2-3B"), "04A23B");
    assert.equal(n.tagKey("--"), "");
  });

  it("normalizes identifiers by type and leaves other types alone", () => {
    assert.equal(n.normalizeIdentifierValue("nfc", "04:a2:3b"), "04A23B");
    assert.equal(n.normalizeIdentifierValue("rfid", "e2 00 34"), "E20034");
    assert.equal(n.normalizeIdentifierValue("legacy", "red 1234 056"), "RED-1234-56");
    assert.equal(n.normalizeIdentifierValue("serial", "  abc-123 "), "abc-123");
    assert.equal(n.normalizeIdentifierValue("upc", " 012345678905 "), "012345678905");
  });

  it("refuses a legacy value that is not a sticker, with a 400", () => {
    assert.throws(
      () => n.normalizeIdentifierValue("legacy", "not a sticker at all"),
      (err: unknown) => (err as { status?: number }).status === 400,
    );
  });
});

describe("GIAI-96", () => {
  // Expected hex for each tag URI. The company prefix 0614141 and the asset
  // reference 12345400 are the GIAI example in the GS1 EPC Tag Data Standard
  // (urn:epc:id:giai:0614141.12345400). The hex values were cross-checked
  // against an independent implementation (the epc-tds package), which itself
  // reproduces the Standard's published SGTIN-96 example below.
  const vectors: [string, string][] = [
    ["urn:epc:tag:giai-96:3.0614141.12345400", "3474257BF400000000BC6038"],
    ["urn:epc:tag:giai-96:0.0614141.12345400", "3414257BF400000000BC6038"],
    ["urn:epc:tag:giai-96:1.0614141.5678", "3434257BF40000000000162E"],
    ["urn:epc:tag:giai-96:0.061414112345.1", "3400393243F1640000000001"],
    ["urn:epc:tag:giai-96:2.95012345.987654321", "3452D4E2FC8000003ADE68B1"],
    ["urn:epc:tag:giai-96:3.061414.4611686018427387903", "34783BF9BFFFFFFFFFFFFFFF"],
    ["urn:epc:tag:giai-96:3.0614141.0", "3474257BF400000000000000"],
  ];

  const fromUri = (uri: string) => {
    const [filter, companyPrefix, assetReference] = uri.split(":")[4]!.split(".");
    return { filter: Number(filter), companyPrefix: companyPrefix!, assetReference: assetReference! };
  };

  it("encodes the published examples", () => {
    for (const [uri, hex] of vectors) assert.equal(epc.encodeGiai96(fromUri(uri)), hex, uri);
  });

  it("decodes them back to the same tag URI", () => {
    for (const [uri, hex] of vectors) {
      const decoded = epc.decodeGiai96(hex);
      assert.ok(decoded, hex);
      assert.equal(decoded.tagUri, uri);
    }
    assert.equal(
      epc.decodeGiai96("3474257BF400000000BC6038")?.pureIdentityUri,
      "urn:epc:id:giai:0614141.12345400",
    );
  });

  it("round-trips every partition", () => {
    for (let digits = 6; digits <= 12; digits++) {
      const companyPrefix = "0614141234567".slice(0, digits);
      const max = epc.giai96MaxReference(companyPrefix);
      for (const ref of ["0", "1", "987654", max.toString()]) {
        const hex = epc.encodeGiai96({ filter: 5, companyPrefix, assetReference: ref });
        const back = epc.decodeGiai96(hex);
        assert.equal(back?.companyPrefix, companyPrefix);
        assert.equal(back?.assetReference, ref);
        assert.equal(back?.partition, 12 - digits);
        assert.equal(back?.filter, 5);
      }
    }
  });

  it("puts filter, partition and company prefix exactly where SGTIN-96 does", () => {
    // Published in the Tag Data Standard: urn:epc:tag:sgtin-96:3.0614141.812345.6789.
    // Both schemes place filter, partition and a 7-digit company prefix in the
    // 30 bits after the header, so those bits must match.
    const sgtin = BigInt("0x3074257BF7194E4000001A85");
    const giai = BigInt(`0x${epc.encodeGiai96({ filter: 3, companyPrefix: "0614141", assetReference: "1" })}`);
    const field = (v: bigint) => (v >> 58n) & ((1n << 30n) - 1n);
    assert.equal(field(giai), field(sgtin));
  });

  it("refuses what GIAI-96 cannot carry", () => {
    assert.throws(() => epc.encodeGiai96({ filter: 0, companyPrefix: "12345", assetReference: "1" }));
    assert.throws(() => epc.encodeGiai96({ filter: 0, companyPrefix: "1234567890123", assetReference: "1" }));
    assert.throws(() => epc.encodeGiai96({ filter: 8, companyPrefix: "0614141", assetReference: "1" }));
    assert.throws(() => epc.encodeGiai96({ filter: 0, companyPrefix: "0614141", assetReference: "007" }));
    assert.throws(() => epc.encodeGiai96({ filter: 0, companyPrefix: "0614141", assetReference: "12A" }));
    const tooBig = (epc.giai96MaxReference("061414112345") + 1n).toString();
    assert.throws(() => epc.encodeGiai96({ filter: 0, companyPrefix: "061414112345", assetReference: tooBig }));
  });

  it("does not decode other schemes or malformed input", () => {
    assert.equal(epc.decodeGiai96("3074257BF7194E4000001A85"), null); // SGTIN-96
    assert.equal(epc.decodeGiai96("34"), null);
    assert.equal(epc.decodeGiai96("ZZ74257BF400000000BC6038"), null);
    // Partition 7 does not exist.
    assert.equal(epc.decodeGiai96("341C00000000000000000000"), null);
  });

  it("accepts EPCs as readers print them", () => {
    assert.equal(epc.normalizeEpcHex("34 74 25 7b f4 00 00 00 00 bc 60 38"), "3474257BF400000000BC6038");
    assert.equal(epc.normalizeEpcHex("3474-257B"), null);
  });
});

describe("bindex-96", () => {
  it("round-trips every shape of asset code Bindex prints", () => {
    for (const code of ["INV-7F3K2A", "ACME-9QX3TR", "ABCDEFGH-ZZZZZZ", "INV-A1B2C3", "X-1", "NODASH", "LOC-000000"]) {
      const hex = epc.encodeBindex96(code);
      assert.ok(hex, code);
      assert.match(hex, /^42[0-9A-F]{22}$/);
      assert.deepEqual(epc.decodeBindex96(hex), { assetCode: code, opaque: false });
    }
  });

  it("matches the worked example in the docs", () => {
    assert.equal(epc.encodeBindex96("INV-7F3K2A"), "4234D88084045432C0000000");
  });

  it("is case-insensitive on the way in", () => {
    assert.equal(epc.encodeBindex96("inv-7f3k2a"), epc.encodeBindex96("INV-7F3K2A"));
  });

  it("gives distinct EPCs to distinct codes", () => {
    const codes = ["INV-7F3K2A", "INV-7F3K2B", "INV7-F3K2A", "INV-7F3K2", "INV7F3K2A"];
    assert.equal(new Set(codes.map((c) => epc.encodeBindex96(c))).size, codes.length);
  });

  it("will not pack codes it cannot represent", () => {
    assert.equal(epc.encodeBindex96("ABCDEFGHI-ZZZZZZ"), null); // 15 characters
    assert.equal(epc.encodeBindex96("INV_7F3K2A"), null);
    assert.equal(epc.encodeBindex96("A-B-C"), null);
    assert.equal(epc.encodeBindex96(""), null);
  });

  it("falls back to an opaque EPC from the record id", () => {
    const hex = epc.encodeBindex96Opaque("3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071");
    assert.equal(hex, "42F3F2A1B4C5D6E7F809A1B2");
    assert.deepEqual(epc.decodeBindex96(hex), { assetCode: null, opaque: true });
  });

  it("does not decode GIAI-96 or padding in the middle", () => {
    assert.equal(epc.decodeBindex96("3474257BF400000000BC6038"), null);
    const hex = epc.encodeBindex96("INV-7F3K2A")!;
    // Knock out one character in the middle: a gap before more characters.
    const v = BigInt(`0x${hex}`) & ~(63n << BigInt(6 * 10));
    assert.equal(epc.decodeBindex96(v.toString(16).toUpperCase().padStart(24, "0")), null);
  });

  it("tells the two schemes apart", () => {
    assert.equal(epc.describeEpc("3474257BF400000000BC6038").scheme, "giai-96");
    assert.deepEqual(epc.describeEpc(epc.encodeBindex96("INV-7F3K2A")!), {
      scheme: "bindex-96",
      uri: null,
      assetCode: "INV-7F3K2A",
    });
    assert.equal(epc.describeEpc("E2801160600002093BAF7A51").scheme, null);
  });
});

describe("ZPL", () => {
  const label = {
    name: "Pallet jack",
    code: "INV-7F3K2A",
    sub: "Dock 4",
    url: "https://inventory.example.com/items/3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071",
    epc: "3474257BF400000000BC6038",
  };
  const options = { widthMm: 62, heightMm: 25.4, dpi: 203 };

  it("sets up Gen 2 encoding and writes the EPC", () => {
    const out = zpl.zplLabel(label, options);
    assert.match(out, /^\^XA\n/);
    assert.match(out, /\n\^XZ$/);
    assert.ok(out.includes("^RS8"));
    assert.ok(out.includes("^RFW,H,,,A^FD3474257BF400000000BC6038^FS"));
    // Encoding comes before any printing field.
    assert.ok(out.indexOf("^RFW") < out.indexOf("^FO"));
  });

  it("sizes the label from the configured millimetres and resolution", () => {
    assert.ok(zpl.zplLabel(label, options).includes("^PW496\n^LL203"));
    assert.ok(zpl.zplLabel(label, { ...options, dpi: 300 }).includes("^PW732\n^LL300"));
    assert.ok(zpl.zplLabel(label, { widthMm: 101.6, heightMm: 50.8, dpi: 203 }).includes("^PW812\n^LL406"));
  });

  it("prints the QR link, the barcode and the code", () => {
    const out = zpl.zplLabel(label, options);
    assert.match(out, /\^BQN,2,\d+\^FH_\^FDMA,https:\/\/inventory\.example\.com\/items\//);
    assert.match(out, /\^BCN,\d+,N,N,N\^FH_\^FDINV-7F3K2A\^FS/);
    assert.ok(out.includes("^FDPallet jack^FS"));
    assert.ok(out.includes("^FDDock 4^FS"));
  });

  it("keeps everything inside the label", () => {
    for (const dpi of [203, 300, 600]) {
      const out = zpl.zplLabel(label, { ...options, dpi });
      const height = Math.round((25.4 / 25.4) * dpi);
      for (const m of out.matchAll(/\^FO(\d+),(\d+)/g)) {
        assert.ok(Number(m[2]) < height, `field at y=${m[2]} on a ${height}-dot label`);
      }
    }
  });

  it("escapes characters that would end a field or start a command", () => {
    const out = zpl.zplLabel({ ...label, name: "A^B~C_D\nE" }, options);
    assert.ok(out.includes("^FDA_5EB_7EC_5FD E^FS"));
    assert.ok(!out.includes("A^B"));
  });

  it("leaves out the RFID commands when there is nothing to encode", () => {
    const out = zpl.zplLabel({ ...label, epc: null }, options);
    assert.ok(!out.includes("^RS8"));
    assert.ok(!out.includes("^RFW"));
  });

  it("puts one label after another", () => {
    const doc = zpl.zplDocument([label, { ...label, code: "INV-2222AA" }], options);
    assert.equal(doc.match(/\^XA/g)?.length, 2);
    assert.equal(doc.match(/\^XZ/g)?.length, 2);
  });

  it("estimates QR and Code 128 sizes", () => {
    assert.equal(zpl.qrModules("x".repeat(14)), 21);
    assert.equal(zpl.qrModules("x".repeat(15)), 25);
    assert.equal(zpl.qrModules(label.url), 37);
    assert.equal(zpl.code128Modules("INV-7F3K2A"), 145);
  });

  it("writes a code,EPC spreadsheet with quoting", () => {
    const csv = zpl.encodeCsv([
      { code: "INV-7F3K2A", epc: label.epc, scheme: "giai-96", name: 'Jack, "big"', url: label.url },
    ]);
    const [header, row] = csv.trim().split("\r\n");
    assert.equal(header, "code,epc,scheme,name,url");
    assert.equal(row, `INV-7F3K2A,${label.epc},giai-96,"Jack, ""big""",${label.url}`);
  });
});

describe("bulk binding", () => {
  const queue = (size: number) =>
    Array.from({ length: size }, (_, i) => ({ itemId: `item-${i}`, unitId: null }));
  const start = (size: number): import("../src/services/tag-commissioning/bulkBind").BindState => ({
    queue: queue(size),
    position: 0,
    history: [],
  });

  /** Feed reads through the session the way the service does. */
  function run(size: number, reads: string[], inUse: Set<string> = new Set()) {
    let state: import("../src/services/tag-commissioning/bulkBind").BindState = start(size);
    const bound: { value: string; itemId: string }[] = [];
    const ignored: string[] = [];
    for (const [i, read] of reads.entries()) {
      const d = bb.decideRead(state, read, inUse.has(n.tagKey(read)));
      if (d.kind === "bind") {
        bound.push({ value: read, itemId: d.entry.itemId });
        state = bb.applyBind(state, read, `id-${i}`, "2026-01-01T00:00:00Z");
      } else {
        ignored.push(d.reason);
      }
    }
    return { state, bound, ignored };
  }

  it("binds N distinct tags to N items in order", () => {
    const reads = ["E200A1", "E200A2", "E200A3", "E200A4", "E200A5"];
    const { bound, state } = run(5, reads);
    assert.deepEqual(
      bound.map((b) => b.itemId),
      ["item-0", "item-1", "item-2", "item-3", "item-4"],
    );
    assert.deepEqual(bound.map((b) => b.value), reads);
    assert.deepEqual(bb.sessionCounts(state), { bound: 5, skipped: 0, remaining: 0 });
  });

  it("ignores the same tag read again, however the reader spells it", () => {
    const { bound, ignored } = run(3, ["E200A1", "E200A1", "e2:00:a1", "E200A2"]);
    assert.deepEqual(bound.map((b) => b.itemId), ["item-0", "item-1"]);
    assert.deepEqual(ignored, ["repeat", "repeat"]);
  });

  it("never rebinds a tag already in use elsewhere", () => {
    const { bound, ignored } = run(3, ["AAAA01", "BBBB02", "CCCC03"], new Set(["BBBB02"]));
    assert.deepEqual(bound, [
      { value: "AAAA01", itemId: "item-0" },
      { value: "CCCC03", itemId: "item-1" },
    ]);
    assert.deepEqual(ignored, ["in_use"]);
  });

  it("stops at the end of the list", () => {
    const { bound, ignored } = run(2, ["A1", "A2", "A3"]);
    assert.equal(bound.length, 2);
    assert.deepEqual(ignored, ["finished"]);
  });

  it("ignores empty reads", () => {
    assert.deepEqual(bb.decideRead(start(1), " :: ", false), { kind: "ignore", reason: "empty" });
  });

  it("skips an entry and binds the next read to the one after", () => {
    let state = bb.applySkip(start(3), "t");
    const d = bb.decideRead(state, "A1", false);
    assert.equal(d.kind === "bind" && d.entry.itemId, "item-1");
    state = bb.applyBind(state, "A1", "id-1", "t");
    assert.deepEqual(bb.sessionCounts(state), { bound: 1, skipped: 1, remaining: 1 });
    // Skipping past the end changes nothing.
    const done = bb.applySkip(bb.applySkip(state, "t"), "t");
    assert.equal(done.position, 3);
  });

  it("undoes the last bind so the next read binds that item again", () => {
    const { state } = run(3, ["A1", "A2"]);
    const { state: back, undone } = bb.applyUndo(state);
    assert.equal(undone?.kind, "bind");
    assert.equal(undone?.kind === "bind" && undone.identifierId, "id-1");
    assert.equal(back.position, 1);
    // The undone tag is free again, so reading it rebinds the same item.
    const d = bb.decideRead(back, "A2", false);
    assert.equal(d.kind === "bind" && d.entry.itemId, "item-1");
    // Still no double binding of the tag that was kept.
    assert.deepEqual(bb.decideRead(back, "A1", true), { kind: "ignore", reason: "repeat" });
  });

  it("undoes a skip", () => {
    const skipped = bb.applySkip(start(2), "t");
    const { state, undone } = bb.applyUndo(skipped);
    assert.equal(undone?.kind, "skip");
    assert.equal(state.position, 0);
    assert.deepEqual(bb.applyUndo(state), { state, undone: null });
  });
});

describe("tag tiers", () => {
  const facts = { hasRfid: false, hasNfc: false, hasLegacy: false, hasCode: false, scanned: false };

  it("ranks from none to RFID + NFC", () => {
    assert.equal(tiers.classifyTier(facts), "none");
    assert.equal(tiers.classifyTier({ ...facts, scanned: true }), "barcode");
    assert.equal(tiers.classifyTier({ ...facts, hasCode: true }), "barcode");
    assert.equal(tiers.classifyTier({ ...facts, hasNfc: true }), "barcode");
    assert.equal(tiers.classifyTier({ ...facts, hasCode: true, hasLegacy: true }), "legacy");
    assert.equal(tiers.classifyTier({ ...facts, hasLegacy: true, hasRfid: true }), "rfid");
    assert.equal(tiers.classifyTier({ ...facts, hasRfid: true, hasNfc: true }), "rfid_nfc");
  });
});

describe("sticker palette", () => {
  it("defaults to the eight standard colours", () => {
    assert.deepEqual(
      palette.cleanPalette(null).map((c) => c.name),
      ["RED", "ORANGE", "YELLOW", "GREEN", "BLUE", "PURPLE", "WHITE", "BLACK"],
    );
  });

  it("uppercases names, drops bad and repeated entries", () => {
    assert.deepEqual(
      palette.cleanPalette([
        { name: "teal", hex: "#14B8A6" },
        { name: "TEAL", hex: "#000000" },
        { name: "two words", hex: "#111111" },
        { name: "pink", hex: "pink" },
      ]),
      [{ name: "TEAL", hex: "#14b8a6" }],
    );
  });

  it("never ends up empty", () => {
    assert.equal(palette.cleanPalette([]).length, 8);
  });
});
