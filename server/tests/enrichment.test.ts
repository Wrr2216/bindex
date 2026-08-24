import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJson, str } from "../src/services/enrichment/extract";
import { isEnrichable, isUpcLike } from "../src/services/enrichment/types";

describe("extractJson", () => {
  it("reads a fenced block", () => {
    const reply = 'Sure!\n```json\n{"name": "Widget"}\n```\nHope that helps.';
    assert.deepEqual(extractJson(reply), { name: "Widget" });
  });

  it("reads a bare object", () => {
    assert.deepEqual(extractJson('{"name": "Widget"}'), { name: "Widget" });
  });

  it("returns null rather than throwing on anything unparseable", () => {
    assert.equal(extractJson(""), null);
    assert.equal(extractJson("I could not identify that product."), null);
    assert.equal(extractJson("```json\n{not json}\n```"), null);
  });
});

describe("str", () => {
  it("trims, and treats blank or non-string values as absent", () => {
    assert.equal(str("  Widget  "), "Widget");
    assert.equal(str("   "), undefined);
    assert.equal(str(null), undefined);
    assert.equal(str(42), undefined);
  });
});

describe("isUpcLike", () => {
  it("matches the barcode lengths a product database indexes", () => {
    for (const code of ["12345678", "012345678905", "0123456789012", "01234567890123"]) {
      assert.equal(isUpcLike(code), true, code);
    }
  });

  it("rejects anything else", () => {
    for (const code of ["1234567", "0123456789", "ABC123456789", ""]) {
      assert.equal(isUpcLike(code), false, code);
    }
  });
});

describe("isEnrichable", () => {
  it("is worth a lookup for barcodes and model numbers", () => {
    assert.equal(isEnrichable("012345678905"), true);
    assert.equal(isEnrichable("U6-Pro"), true);
    assert.equal(isEnrichable("DS2278-SR"), true);
  });

  it("skips tag reads, which never name a product", () => {
    // An EPC is a long even-length run of hex; looking it up wastes a request
    // and delays the create form.
    assert.equal(isEnrichable("E28011606000020C1A2B3C4D"), false);
    assert.equal(isEnrichable("DEADBEEF"), false);
  });

  it("skips codes too short to identify anything", () => {
    assert.equal(isEnrichable("A1"), false);
    assert.equal(isEnrichable(""), false);
  });
});
