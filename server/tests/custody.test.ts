import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The modules read the environment when they load, so the minimum required
// configuration has to exist first.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Model = typeof import("../src/services/custody/model");
type Rules = typeof import("../src/services/custody/rules");
type Content = typeof import("../src/services/custody/content");
type Pdf = typeof import("../src/services/custody/pdf");
type Page = typeof import("../src/services/custody/publicPage");
let model: Model;
let rules: Rules;
let content: Content;
let pdf: Pdf;
let page: Page;

before(async () => {
  model = await import("../src/services/custody/model");
  rules = await import("../src/services/custody/rules");
  content = await import("../src/services/custody/content");
  pdf = await import("../src/services/custody/pdf");
  page = await import("../src/services/custody/publicPage");
});

const line = (over: Partial<Parameters<Content["contentLine"]>[0]> = {}) => ({
  itemId: "11111111-1111-4111-8111-111111111111",
  unitId: null,
  assetCode: "INV-AAAAAA",
  unitCode: null,
  name: "Archive box",
  via: "scan" as const,
  parentItemId: null,
  outcome: "accepted" as const,
  note: null,
  ...over,
});

const header = {
  code: "CUS-7F3K2A",
  purpose: "handoff",
  fromKind: "external" as const,
  fromName: "Records office",
  fromOrg: null,
  toKind: "external" as const,
  toName: "Crew 3",
  toOrg: "Acme",
  locationName: "HQ / Basement",
  lat: null,
  lng: null,
  jobCode: "JOB-1",
  shipmentCode: null,
  sealNumbers: ["S1"],
  conditionNote: null,
};

describe("purposes and signatures", () => {
  it("needs both parties for a handoff and only the receiver for a delivery", () => {
    assert.deepEqual(model.missingSignatures("handoff", { from: null, to: null }), ["from", "to"]);
    assert.deepEqual(model.missingSignatures("handoff", { from: "a", to: null }), ["to"]);
    assert.deepEqual(model.missingSignatures("delivery", { from: null, to: null }), ["to"]);
    assert.deepEqual(model.missingSignatures("delivery", { from: null, to: "b" }), []);
  });

  it("maps delivery outcomes onto job stages and custody", () => {
    assert.equal(model.stageForOutcome("accepted"), "delivered");
    assert.equal(model.stageForOutcome("refused"), "refused");
    assert.equal(model.outcomePasses("damaged"), true);
    assert.equal(model.outcomePasses("missing"), false);
    assert.equal(model.outcomePasses("refused"), false);
  });

  it("words the statement for each party", () => {
    const t = { code: "CUS-1", fromName: "A", toName: "B", count: 1 };
    assert.match(model.statementFor("handoff", "from", t), /released the 1 item listed on custody transfer CUS-1 to B/);
    assert.match(model.statementFor("delivery", "to", t), /missing, damaged or refused/);
  });

  it("normalizes parties and says what is missing", () => {
    assert.equal(model.normalizeParty({ kind: "external", name: "  " }, null, "receiving"), "Enter the receiving party's name.");
    assert.equal(model.normalizeParty({ kind: "entity", entityId: "x" }, null, "releasing"), "The releasing holder does not exist. Pick another.");
    assert.deepEqual(model.normalizeParty({ kind: "external", name: " Jo   Park ", org: "" }, null, "receiving"), {
      kind: "external",
      entityId: null,
      userOid: null,
      name: "Jo Park",
      org: null,
    });
    const holder = model.normalizeParty({ kind: "entity", entityId: "e1" }, "Crew 3", "receiving");
    assert.equal(typeof holder === "object" && holder.name, "Crew 3");
  });

  it("cleans seals, keeping their order", () => {
    assert.deepEqual(model.cleanSeals([" B2 ", "A1", "B2", ""]), ["B2", "A1"]);
  });

  it("makes CUS- codes from the unambiguous alphabet", () => {
    const code = model.genTransferCode((n) => new Uint8Array(n).fill(18));
    assert.equal(code, "CUS-JJJJJJ");
    assert.match(model.genTransferCode((n) => crypto.getRandomValues(new Uint8Array(n))), /^CUS-[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});

describe("signed content", () => {
  it("hashes the same list the same way, and differently when anything changes", () => {
    const a = content.contentLines([{ ...line(), position: 2 }, { ...line({ itemId: "2", assetCode: "INV-B" }), position: 1 }]);
    assert.deepEqual(a.map((l) => l.assetCode), ["INV-B", "INV-AAAAAA"]);
    const signed = content.transferContent(header, a);
    const again = content.transferContent({ ...header }, content.contentLines([{ ...line({ itemId: "2", assetCode: "INV-B" }), position: 1 }, { ...line(), position: 2 }]));
    assert.equal(signed.itemsHash, again.itemsHash);
    const moved = content.transferContent(header, [...a].reverse());
    assert.notEqual(moved.itemsHash, signed.itemsHash);
    const resealed = content.transferContent({ ...header, sealNumbers: ["S2"] }, a);
    assert.equal(resealed.itemsHash, signed.itemsHash);
    assert.deepEqual(content.diffHeader(signed, resealed), ["seals"]);
  });

  it("leaves out links the database may clear later", () => {
    const c = content.transferContent(header, []) as Record<string, unknown>;
    for (const key of ["jobId", "shipmentId", "locationId"]) assert.equal(key in c, false);
    assert.equal(c.count, 0);
  });

  it("says which lines changed after signing", () => {
    const signed = [content.contentLine(line()), content.contentLine(line({ itemId: "2", assetCode: "INV-B" }))];
    const now = [
      content.contentLine(line({ outcome: "damaged", note: "Dented" })),
      content.contentLine(line({ itemId: "3", assetCode: "INV-C" })),
    ];
    const diff = content.diffLines(signed, now);
    assert.deepEqual(diff.map((d) => [d.key, d.fields]), [
      ["11111111-1111-4111-8111-111111111111:", ["note", "outcome"]],
      ["2:", []],
      ["3:", []],
    ]);
    assert.equal(diff[1]!.after, null);
    assert.equal(diff[2]!.before, null);
    assert.deepEqual(content.diffLines(signed, [...signed].reverse()).map((d) => d.key), ["order"]);
    assert.deepEqual(content.diffLines(signed, signed), []);
  });
});

describe("the custody guard", () => {
  const jobId = "job-1";
  const added = new Date("2026-09-01T00:00:00Z");
  const boxLine = { jobItemId: "L1", itemId: "box", unitId: null, addedAt: added };
  const controls = new Map([["box", { assetCode: "INV-BOX", container: null }]]);
  const delivery = (over: Partial<Parameters<Rules["covers"]>[0]> = {}) => ({
    itemId: "box",
    unitId: null,
    outcome: "accepted",
    jobId,
    completedAt: new Date("2026-09-02T00:00:00Z"),
    ...over,
  });

  it("only guards delivered and placed", () => {
    assert.deepEqual(rules.custodyVetoes("loaded", jobId, [boxLine], controls, []), []);
    assert.equal(rules.custodyVetoes("delivered", jobId, [boxLine], controls, []).length, 1);
    assert.equal(rules.custodyVetoes("placed", jobId, [boxLine], controls, []).length, 1);
  });

  it("lets uncontrolled lines through", () => {
    assert.deepEqual(rules.custodyVetoes("delivered", jobId, [{ ...boxLine, itemId: "chair" }], controls, []), []);
  });

  it("accepts a delivery on this job, or on no job after the line was added", () => {
    assert.equal(rules.covers(delivery(), boxLine, jobId), true);
    assert.equal(rules.covers(delivery({ jobId: "other" }), boxLine, jobId), false);
    assert.equal(rules.covers(delivery({ jobId: null }), boxLine, jobId), true);
    assert.equal(rules.covers(delivery({ jobId: null, completedAt: new Date("2026-08-01") }), boxLine, jobId), false);
  });

  it("does not count a refused or missing line, and matches units properly", () => {
    assert.equal(rules.covers(delivery({ outcome: "refused" }), boxLine, jobId), false);
    assert.equal(rules.covers(delivery({ outcome: "missing" }), boxLine, jobId), false);
    assert.equal(rules.covers(delivery({ outcome: "damaged" }), boxLine, jobId), true);
    assert.equal(rules.covers(delivery(), { ...boxLine, unitId: "u1" }, jobId), true);
    assert.equal(rules.covers(delivery({ unitId: "u1" }), boxLine, jobId), false);
    assert.equal(rules.covers(delivery({ unitId: "u1" }), { ...boxLine, unitId: "u2" }, jobId), false);
  });

  it("names the container a controlled item travels in", () => {
    const [veto] = rules.custodyVetoes(
      "delivered",
      jobId,
      [{ ...boxLine, itemId: "folder" }],
      new Map([["folder", { assetCode: "INV-F", container: "INV-BOX" }]]),
      [],
    );
    assert.match(veto!.reason, /^INV-F is custody-controlled \(it travels in INV-BOX\)\..*mark it delivered\.$/);
  });
});

describe("current custodian", () => {
  const p = (name: string) => ({ kind: "external", name, org: null });
  const hop = (at: string, from: string, to: string, outcome = "accepted") => ({
    transferId: at,
    at: new Date(at),
    from: p(from),
    to: p(to),
    outcome,
  });

  it("is the receiver of the latest handoff", () => {
    assert.equal(rules.currentCustodian([]), null);
    assert.equal(rules.currentCustodian([hop("2026-09-02", "B", "C"), hop("2026-09-01", "A", "B")])?.name, "C");
  });

  it("stays with the carrier when the receiver refuses", () => {
    assert.equal(rules.currentCustodian([hop("2026-09-01", "A", "B"), hop("2026-09-02", "B", "C", "refused")])?.name, "B");
  });

  it("falls back to the last known holder when the item went missing", () => {
    assert.equal(rules.currentCustodian([hop("2026-09-01", "A", "B"), hop("2026-09-02", "B", "C", "missing")])?.name, "B");
    assert.equal(rules.currentCustodian([hop("2026-09-02", "B", "C", "missing")]), null);
  });
});

describe("signing links", () => {
  it("stores only a hash, and recognises the token's shape", () => {
    const { token, hash } = rules.newLinkToken();
    assert.equal(rules.looksLikeToken(token), true);
    assert.equal(rules.hashLinkToken(token), hash);
    assert.notEqual(hash, token);
    assert.equal(rules.looksLikeToken("short"), false);
    assert.equal(rules.looksLikeToken(`${token.slice(0, 31)}/`), false);
  });

  it("knows when a link is active, used or expired", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const later = new Date("2026-09-27T12:00:00Z");
    assert.equal(rules.linkState({ linkTokenHash: null, linkExpiresAt: null, linkUsedAt: null }, now), "none");
    assert.equal(rules.linkState({ linkTokenHash: "h", linkExpiresAt: later, linkUsedAt: null }, now), "active");
    assert.equal(rules.linkState({ linkTokenHash: "h", linkExpiresAt: now, linkUsedAt: null }, now), "expired");
    assert.equal(rules.linkState({ linkTokenHash: null, linkExpiresAt: later, linkUsedAt: now }, now), "used");
  });
});

describe("the receipt and the signing page", () => {
  it("renders a PDF with every line, however awkward the text", async () => {
    const lines = Array.from({ length: 70 }, (_, i) => ({
      index: i + 1,
      name: i === 3 ? "Box 📦 with a very long name that has to wrap across more than one line of the table" : `Folder ${i}`,
      code: `INV-${String(i).padStart(6, "0")}`,
      inside: i > 0 ? "INV-000000" : null,
      outcome: i === 5 ? "Damaged" : "Accepted",
      exception: i === 5,
      note: i === 5 ? "Corner crushed" : null,
    }));
    const bytes = await pdf.renderReceiptPdf(
      {
        kicker: "CHAIN OF CUSTODY RECEIPT",
        title: "Records office to Crew 3",
        code: "CUS-7F3K2A",
        facts: [["Purpose", "Handoff"], ["Seals", "S1, S2"]],
        parties: [
          { label: "Released by", name: "Records office", org: null, kind: "External party" },
          { label: "Received by", name: "Crew 3", org: "Acme", kind: "Holder" },
        ],
        lines,
        summary: "70 items handed over. No exceptions.",
        signatures: [
          {
            label: "Released by",
            signerName: "Dana Ruiz",
            signerRole: "Records manager",
            signerEmail: null,
            signedAt: "2026-09-26 12:00:00 UTC",
            statement: "I released the items listed.",
            contentHash: "a".repeat(64),
            via: "device",
            image: { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
          },
        ],
        itemsHash: "b".repeat(64),
        url: "https://inventory.example.com/custody/transfers/1",
      },
      "2026-09-26 12:00:00 UTC",
      "Bindex",
    );
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 2);
  });

  it("writes nothing from the transfer into the page shell", () => {
    const html = page.signPageHtml(`<script>alert(1)</script>`, "red; } body { display:none");
    assert.equal(html.includes("<script>alert"), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /--accent: #0284c7/);
    assert.match(html, /<script src="\/custody-sign\/assets\/sign.js" defer><\/script>/);
    assert.equal(page.SIGN_PAGE_SCRIPT.includes("innerHTML"), false);
  });
});
