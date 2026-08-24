import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The module reads the environment when it loads, so the minimum required
// configuration has to exist first.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Codes = typeof import("../src/lib/codes");
let codes: Codes;

before(async () => {
  codes = await import("../src/lib/codes");
});

describe("normalizeCodePrefix", () => {
  it("uppercases and strips anything that is not a letter or digit", () => {
    assert.equal(codes.normalizeCodePrefix("acme", "INV"), "ACME");
    assert.equal(codes.normalizeCodePrefix("a-c m.e", "INV"), "ACME");
  });

  it("caps the length, so a code stays readable on a label", () => {
    assert.equal(codes.normalizeCodePrefix("ABCDEFGHIJKL", "INV"), "ABCDEFGH");
  });

  it("falls back when nothing usable is left", () => {
    assert.equal(codes.normalizeCodePrefix("", "INV"), "INV");
    assert.equal(codes.normalizeCodePrefix("---", "INV"), "INV");
  });
});

describe("genAssetCode", () => {
  it("uses the configured prefix", () => {
    codes.applyCodePrefixes("ACME", "SITE");
    assert.match(codes.genAssetCode(), /^ACME-[0-9A-Z]{6}$/);
    assert.equal(codes.assetCodePrefix(), "ACME");
  });

  it("avoids the letters that get misread off a label", () => {
    codes.applyCodePrefixes("INV", "LOC");
    // Crockford base32 drops I, L, O and U so a code cannot be mistyped into a
    // different one.
    const random = Array.from({ length: 200 }, () => codes.genAssetCode().split("-")[1]).join("");
    assert.equal(random.length, 200 * 6);
    assert.equal(/[ILOU]/.test(random), false);
  });

  it("does not repeat itself", () => {
    codes.applyCodePrefixes("INV", "LOC");
    const generated = new Set(Array.from({ length: 500 }, () => codes.genAssetCode()));
    assert.equal(generated.size, 500);
  });
});

describe("locationCode", () => {
  it("is stable, so reprinting a shelf label gives the same code", () => {
    codes.applyCodePrefixes("INV", "LOC");
    const id = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";
    assert.equal(codes.locationCode(id), codes.locationCode(id));
    assert.match(codes.locationCode(id), /^LOC-[0-9A-F]{6}$/);
  });

  it("uses the configured prefix", () => {
    codes.applyCodePrefixes("INV", "SHELF");
    assert.match(codes.locationCode("3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071"), /^SHELF-/);
  });
});
