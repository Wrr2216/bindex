import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

// The modules read the environment when they load, so the minimum required
// configuration has to exist first. Nothing here touches the database.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Merge = typeof import("../src/services/documents/merge");
type Conditions = typeof import("../src/services/documents/conditions");
type ValuesMod = typeof import("../src/services/documents/values");
type Model = typeof import("../src/services/documents/model");
type Layout = typeof import("../src/services/documents/layout");
type Content = typeof import("../src/services/documents/content");
type Pdf = typeof import("../src/services/documents/pdf");
type Block = import("../src/services/documents/model").Block;
type PacketJob = import("../src/services/documents/conditions").PacketJob;

let merge: Merge;
let cond: Conditions;
let vals: ValuesMod;
let model: Model;
let layout: Layout;
let content: Content;
let pdf: Pdf;

before(async () => {
  merge = await import("../src/services/documents/merge");
  cond = await import("../src/services/documents/conditions");
  vals = await import("../src/services/documents/values");
  model = await import("../src/services/documents/model");
  layout = await import("../src/services/documents/layout");
  content = await import("../src/services/documents/content");
  pdf = await import("../src/services/documents/pdf");
});

const UTC = { timeZone: "UTC", locale: "en-US" };

const ctx = {
  job: {
    name: "Floor 3 move",
    code: "JOB-7F3K2A",
    notes: null,
    scheduledStart: "2026-10-02T13:00:00.000Z",
    metadata: { ticket: "CHG-1", rush: true },
  },
  project: { name: "Consolidation", startsOn: "2026-09-28" },
  manifest: { count: 1234, floors: ["3", "5"] },
};

describe("merge fields", () => {
  it("lists placeholders once each, in order, tolerating spaces inside the braces", () => {
    assert.deepEqual(merge.mergeKeys("{{job.name}} and {{ job.code }} then {{job.name}}"), ["job.name", "job.code"]);
  });

  it("resolves nested paths and formats what it finds", () => {
    const r = merge.resolveMerge("{{ job.name }} ({{job.code}}) starts {{job.scheduledStart}}", ctx, UTC);
    assert.equal(r.text, "Floor 3 move (JOB-7F3K2A) starts Oct 2, 2026, 1:00 PM UTC");
    assert.deepEqual(r.unknown, []);
  });

  it("shows a date-only value as the calendar day, whatever the time zone", () => {
    const west = { timeZone: "America/Los_Angeles", locale: "en-US" };
    assert.equal(merge.resolveMerge("{{project.startsOn}}", ctx, west).text, "Sep 28, 2026");
  });

  it("prints numbers, booleans and lists for people", () => {
    assert.equal(merge.resolveMerge("{{manifest.count}}", ctx, UTC).text, "1,234");
    assert.equal(merge.resolveMerge("{{job.metadata.rush}}", ctx, UTC).text, "Yes");
    assert.equal(merge.resolveMerge("{{manifest.floors}}", ctx, UTC).text, "3, 5");
  });

  it("treats an existing but empty value as empty, not unknown", () => {
    const r = merge.resolveMerge("Notes: {{job.notes}}.", ctx, UTC);
    assert.equal(r.text, "Notes: .");
    assert.deepEqual(r.unknown, []);
  });

  it("reports paths that match nothing, and prints nothing for them", () => {
    const r = merge.resolveMerge("{{job.nmae}} / {{job.metadata.missing}} / {{nope}}", ctx, UTC);
    assert.equal(r.text, " /  / ");
    assert.deepEqual(r.unknown, ["job.nmae", "job.metadata.missing", "nope"]);
  });

  it("only follows the context's own properties", () => {
    const r = merge.resolveMerge("{{job.constructor}}{{job.toString}}{{__proto__}}", ctx, UTC);
    assert.equal(r.text, "");
    assert.equal(r.unknown.length, 3);
  });

  it("leaves text that only looks like a placeholder alone", () => {
    assert.equal(merge.resolveMerge("{{ }} {{1abc}} {job.name}", ctx, UTC).text, "{{ }} {{1abc}} {job.name}");
  });

  it("falls back rather than failing on an unknown time zone", () => {
    const r = merge.resolveMerge("{{job.scheduledStart}}", ctx, { timeZone: "Mars/Olympus", locale: "en-US" });
    assert.match(r.text, /Oct 2, 2026/);
  });

  it("prints who signed for a signature value", () => {
    assert.equal(merge.formatValue({ signatureId: "x", signerName: "Dana Ruiz", signedAt: "2026-10-02T13:00:00Z" }), "Dana Ruiz");
  });
});

const job = (over: Partial<PacketJob> = {}): PacketJob => ({
  jobTypeId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  phaseId: null,
  originSites: ["aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000001"],
  destinationSites: ["bbbbbbbb-0000-4000-8000-000000000005", "bbbbbbbb-0000-4000-8000-000000000001"],
  fields: {
    status: "planned",
    name: "Floor 3 move",
    code: "JOB-7F3K2A",
    type: "IT relocation",
    project: "Consolidation",
    phase: null,
    origin: "Floor 3",
    destination: "Level 5",
    scheduledStart: "2026-10-02T13:00:00.000Z",
    scheduledEnd: null,
    notes: "Freight lift booked",
    metadata: { crates: 40, priority: "High", tags: ["secure", "weekend"] },
  },
  ...over,
});

describe("packet conditions", () => {
  const IT = "11111111-1111-4111-8111-111111111111";
  const OTHER = "33333333-3333-4333-8333-333333333333";

  it("applies to every job when nothing is set", () => {
    assert.equal(cond.evaluateConditions({}, job()).matches, true);
    assert.equal(cond.isUnconditional({}), true);
    assert.equal(cond.isUnconditional({ jobTypeIds: [IT] }), false);
  });

  it("matches the job type against the list", () => {
    assert.equal(cond.evaluateConditions({ jobTypeIds: [OTHER, IT] }, job()).matches, true);
    assert.equal(cond.evaluateConditions({ jobTypeIds: [OTHER] }, job()).matches, false);
    assert.equal(cond.evaluateConditions({ jobTypeIds: [IT] }, job({ jobTypeId: null })).matches, false);
  });

  it("needs every kind that is set to hold", () => {
    const c = { jobTypeIds: [IT], projectIds: ["44444444-4444-4444-8444-444444444444"] };
    const r = cond.evaluateConditions(c, job());
    assert.equal(r.matches, false);
    assert.deepEqual(
      r.checks.map((ch) => [ch.kind, ch.ok]),
      [
        ["jobType", true],
        ["project", false],
      ],
    );
  });

  it("matches a phase only when the job has one", () => {
    const phase = "55555555-5555-4555-8555-555555555555";
    assert.equal(cond.evaluateConditions({ phaseIds: [phase] }, job()).matches, false);
    assert.equal(cond.evaluateConditions({ phaseIds: [phase] }, job({ phaseId: phase })).matches, true);
  });

  it("matches a site anywhere above the origin or destination, on the side asked for", () => {
    const originBuilding = "aaaaaaaa-0000-4000-8000-000000000001";
    const destBuilding = "bbbbbbbb-0000-4000-8000-000000000001";
    assert.equal(cond.evaluateConditions({ siteLocationIds: [originBuilding] }, job()).matches, true);
    assert.equal(cond.evaluateConditions({ siteLocationIds: [originBuilding], siteSide: "destination" }, job()).matches, false);
    assert.equal(cond.evaluateConditions({ siteLocationIds: [destBuilding], siteSide: "destination" }, job()).matches, true);
    assert.equal(cond.evaluateConditions({ siteLocationIds: [destBuilding], siteSide: "origin" }, job()).matches, false);
  });

  const rule = (field: string, op: (typeof cond.RULE_OPS)[number], value?: unknown) =>
    cond.evaluateRule({ field, op, value: value as never }, job());

  it("compares text without regard to case or surrounding space", () => {
    assert.equal(rule("type", "equals", " it RELOCATION "), true);
    assert.equal(rule("type", "not_equals", "Delivery"), true);
    assert.equal(rule("name", "contains", "floor 3"), true);
    assert.equal(rule("name", "not_contains", "floor 4"), true);
    assert.equal(rule("code", "starts_with", "job-"), true);
  });

  it("tests membership from a list or a comma-separated string", () => {
    assert.equal(rule("status", "in", ["planned", "in_progress"]), true);
    assert.equal(rule("status", "in", "completed, cancelled"), false);
    assert.equal(rule("status", "not_in", "completed, cancelled"), true);
  });

  it("reaches values stored on the job, including lists", () => {
    assert.equal(rule("metadata.priority", "equals", "high"), true);
    assert.equal(rule("metadata.tags", "contains", "secure"), true);
    assert.equal(rule("metadata.tags", "equals", "weekend"), true);
    assert.equal(rule("metadata.nothing", "exists"), false);
    assert.equal(rule("metadata.nothing", "not_exists"), true);
  });

  it("orders numbers as numbers and ISO dates as dates", () => {
    assert.equal(rule("metadata.crates", "gt", 9), true);
    assert.equal(rule("metadata.crates", "gte", "40"), true);
    assert.equal(rule("metadata.crates", "lt", 100), true);
    assert.equal(rule("scheduledStart", "lt", "2026-10-03"), true);
    assert.equal(rule("scheduledStart", "gte", "2026-10-03"), false);
    // Not comparable: no match rather than a guess.
    assert.equal(rule("name", "gt", 3), false);
    assert.equal(rule("scheduledEnd", "lt", "2030-01-01"), false);
  });

  it("treats an empty value as matching nothing but the negatives", () => {
    assert.equal(rule("phase", "equals", ""), false);
    assert.equal(rule("phase", "not_equals", "Phase 1"), true);
    assert.equal(rule("phase", "exists"), false);
  });

  it("combines rules with all or any", () => {
    const rules = [
      { field: "status", op: "equals" as const, value: "planned" },
      { field: "metadata.priority", op: "equals" as const, value: "Low" },
    ];
    assert.equal(cond.evaluateConditions({ rules }, job()).matches, false);
    assert.equal(cond.evaluateConditions({ rules, ruleMatch: "any" }, job()).matches, true);
  });

  it("keeps what parses from stored conditions and drops the rest", () => {
    assert.deepEqual(cond.readConditions({ jobTypeIds: [IT] }), { jobTypeIds: [IT] });
    assert.deepEqual(cond.readConditions({ jobTypeIds: ["not-a-uuid"] }), {});
    assert.deepEqual(cond.readConditions(null), {});
  });

  it("refuses rules on fields a job does not have", () => {
    assert.equal(cond.ruleSchema.safeParse({ field: "password", op: "exists" }).success, false);
    assert.equal(cond.ruleSchema.safeParse({ field: "metadata.cost_centre", op: "exists" }).success, true);
  });
});

const field = (over: Partial<import("../src/services/documents/model").FieldDef> & { key: string; type: string }) =>
  ({ label: over.key, ...over }) as import("../src/services/documents/model").FieldDef;

describe("values", () => {
  it("accepts loose input a browser sends and stores it strictly", () => {
    assert.deepEqual(vals.normalizeValue(field({ key: "n", type: "number" }), "1,250.5"), { value: 1250.5 });
    assert.deepEqual(vals.normalizeValue(field({ key: "c", type: "checkbox" }), "true"), { value: true });
    assert.deepEqual(vals.normalizeValue(field({ key: "s", type: "select", options: ["Yes", "No"] }), "yes"), { value: "Yes" });
    assert.deepEqual(vals.normalizeValue(field({ key: "d", type: "date" }), " 2026-10-01 "), { value: "2026-10-01" });
    assert.deepEqual(vals.normalizeValue(field({ key: "t", type: "text" }), "a\nb"), { value: "a b" });
    assert.deepEqual(vals.normalizeValue(field({ key: "t", type: "text", multiline: true }), "a\nb"), { value: "a\nb" });
  });

  it("clears on empty input", () => {
    assert.deepEqual(vals.normalizeValue(field({ key: "t", type: "text" }), "   "), { value: undefined });
    assert.deepEqual(vals.normalizeValue(field({ key: "n", type: "number" }), ""), { value: undefined });
    assert.deepEqual(vals.normalizeValue(field({ key: "n", type: "number" }), null), { value: undefined });
  });

  it("says what is wrong", () => {
    const problem = (f: Parameters<typeof vals.normalizeValue>[0], raw: unknown) =>
      (vals.normalizeValue(f, raw) as { problem?: string }).problem;
    assert.match(problem(field({ key: "n", type: "number", min: 1 }), 0)!, /1 or more/);
    assert.match(problem(field({ key: "n", type: "number", max: 5 }), 6)!, /5 or less/);
    assert.match(problem(field({ key: "d", type: "date" }), "2026-02-30")!, /date/);
    assert.match(problem(field({ key: "s", type: "select", options: ["A"] }), "B")!, /Pick one of: A/);
    assert.match(problem(field({ key: "x", type: "signature" }), "Dana")!, /signing/);
  });

  it("autosaves only the keys sent, and refuses unknown keys and signatures", () => {
    const fields = [field({ key: "a", type: "text" }), field({ key: "b", type: "number" }), field({ key: "sig", type: "signature" })];
    const r = vals.applyValuesPatch(fields, { a: "kept", b: 1 }, { b: "2", c: "x", sig: "forged" });
    assert.deepEqual(r.values, { a: "kept", b: 2 });
    assert.deepEqual(r.problems.map((p) => p.key), ["c", "sig"]);
    assert.deepEqual(vals.applyValuesPatch(fields, { a: "x" }, { a: null }).values, {});
  });

  it("requires a required checkbox to be ticked, and leaves signatures for later", () => {
    const fields = [
      field({ key: "agree", type: "checkbox", required: true }),
      field({ key: "name", type: "text", required: true }),
      field({ key: "opt", type: "text" }),
      field({ key: "sig", type: "signature", required: true }),
    ];
    const missing = (values: Record<string, unknown>, signing: boolean) =>
      vals.missingRequired(fields, values, { signing }).map((f) => f.key);
    assert.deepEqual(missing({ agree: false }, false), ["agree", "name"]);
    assert.deepEqual(missing({ agree: true, name: "Dana" }, false), []);
    assert.deepEqual(missing({ agree: true, name: "Dana" }, true), ["sig"]);
    assert.deepEqual(
      missing({ agree: true, name: "Dana", sig: { signatureId: "s", signerName: "Dana", signedAt: "2026-10-02T00:00:00Z" } }, true),
      [],
    );
  });

  it("copies matching fields from another document, never signatures, keeping what is already filled", () => {
    const target = [
      field({ key: "customer", type: "text" }),
      field({ key: "crates", type: "number" }),
      field({ key: "choice", type: "select", options: ["A", "B"] }),
      field({ key: "sig", type: "signature" }),
    ];
    const source = { customer: "Northwind", crates: 40, choice: "C", sig: { signatureId: "s", signerName: "X", signedAt: "" }, other: 1 };
    const r = vals.copyValues(target, { crates: 12 }, source);
    assert.deepEqual(r.values, { crates: 12, customer: "Northwind" });
    assert.deepEqual(r.copied, ["customer"]);
    assert.deepEqual(r.skipped.map((s) => s.key).sort(), ["choice", "crates", "sig"]);
    assert.deepEqual(vals.copyValues(target, { crates: 12 }, source, { overwrite: true }).values.crates, 40);
  });

  it("leaves signatures and unknown keys out of the hashed content", () => {
    const fields = [field({ key: "b", type: "text" }), field({ key: "a", type: "text" }), field({ key: "sig", type: "initials" })];
    assert.deepEqual(Object.keys(vals.contentValues(fields, { b: "1", a: "2", sig: {}, stray: 3 })), ["a", "b"]);
  });
});

const SAMPLE_BODY: Block[] = [
  { id: "h1", type: "heading", level: 1, text: "Relocation sign-off: {{job.name}}" },
  { id: "p1", type: "paragraph", text: "Customer {{field.customer}} confirms {{manifest.count}} lines.\nSecond line {{job.nope}}." },
  { id: "f1", type: "field", field: { key: "customer", label: "Customer", type: "text", required: true } },
  { id: "f2", type: "field", field: { key: "agree", label: "I agree", type: "checkbox", required: true } },
  { id: "f3", type: "field", field: { key: "moved_on", label: "Moved on", type: "date" } },
  { id: "t1", type: "table", source: "manifest", columns: ["code", "item", "stage"], title: "Manifest for {{job.code}}" },
  { id: "d1", type: "divider" },
  { id: "s1", type: "field", field: { key: "customer_sig", label: "Customer signature", type: "signature", required: true } },
  { id: "s2", type: "field", field: { key: "crew_initials", label: "Crew lead initials", type: "initials" } },
];

describe("template bodies", () => {
  it("accepts a well-formed body", () => {
    assert.equal(model.bodySchema.safeParse(SAMPLE_BODY).success, true);
    assert.deepEqual(model.checkBody(SAMPLE_BODY, { publishing: true }), []);
  });

  it("rejects bad keys and unknown block types by shape", () => {
    const bad = [{ id: "x", type: "field", field: { key: "Customer Name", label: "C", type: "text" } }];
    assert.equal(model.bodySchema.safeParse(bad).success, false);
    assert.equal(model.bodySchema.safeParse([{ id: "x", type: "script", text: "" }]).success, false);
  });

  it("finds repeated ids and keys, empty lists and unknown table columns", () => {
    const body: Block[] = [
      { id: "a", type: "field", field: { key: "k", label: "First", type: "text" } },
      { id: "a", type: "field", field: { key: "k", label: "Second", type: "select", options: [] } },
      { id: "t", type: "table", source: "manifest", columns: ["code", "colour"] },
      { id: "u", type: "table", source: "invoices", columns: ["x"] },
    ];
    const messages = model.checkBody(body).map((p) => p.message).join("\n");
    assert.match(messages, /share the id "a"/);
    assert.match(messages, /already uses/);
    assert.match(messages, /no choices/);
    assert.match(messages, /no column "colour"/);
    assert.match(messages, /no table source called "invoices"/);
    assert.match(model.checkBody([], { publishing: true })[0]!.message, /at least one block/);
  });

  it("turns a library entry into a field definition that remembers where it came from", () => {
    const def = model.libraryFieldDef({
      id: "66666666-6666-4666-8666-666666666666",
      key: "site_contact",
      label: "Site contact",
      type: "select",
      required: true,
      config: { options: ["A", "B"], help: " Who let us in ", junk: 1 },
    });
    assert.deepEqual(def, {
      key: "site_contact",
      label: "Site contact",
      type: "select",
      required: true,
      libraryId: "66666666-6666-4666-8666-666666666666",
      options: ["A", "B"],
      help: "Who let us in",
    });
  });
});

function renderSample(values: Record<string, unknown> = {}, rows = 3) {
  return layout.buildRenderModel({
    title: "Sign-off {{job.code}}",
    body: SAMPLE_BODY,
    values,
    context: { job: { name: "Floor 3 move", code: "JOB-1" }, manifest: { count: rows } },
    tables: {
      t1: {
        rows: Array.from({ length: rows }, (_, i) => ({ code: `INV-${i}`, item: i === 1 ? "Chair 🪑 椅子" : `Item ${i}`, stage: "packed" })),
        total: rows,
      },
    },
    today: "2026-10-02",
    document: { id: "doc-1", title: "Sign-off" },
    fmt: UTC,
  });
}

describe("render model", () => {
  it("resolves merges in headings, paragraphs, table titles and the title", () => {
    const m = renderSample({ customer: "Northwind" });
    assert.equal(m.title, "Sign-off JOB-1");
    const [h, p, , , , t] = m.blocks;
    assert.equal(h?.type === "heading" && h.text, "Relocation sign-off: Floor 3 move");
    assert.equal(p?.type === "paragraph" && p.text, "Customer Northwind confirms 3 lines.\nSecond line .");
    assert.equal(t?.type === "table" && t.title, "Manifest for JOB-1");
    assert.deepEqual(m.unknown, ["job.nope"]);
  });

  it("formats field values and marks what is filled", () => {
    const m = renderSample({ customer: "Northwind", agree: true, moved_on: "2026-10-03" });
    const byKey = new Map(m.blocks.flatMap((b) => (b.type === "field" ? [[b.field.key, b] as const] : [])));
    assert.equal(byKey.get("moved_on")?.display, "Oct 3, 2026");
    assert.equal(byKey.get("agree")?.filled, true);
    assert.equal(byKey.get("customer_sig")?.filled, false);
    assert.equal(byKey.get("customer_sig")?.signature, null);
  });

  it("lays table rows out in the block's column order", () => {
    const t = renderSample().blocks[5]!;
    assert.equal(t.type, "table");
    if (t.type !== "table") return;
    assert.deepEqual(t.columns.map((c) => c.label), ["Code", "Item", "Stage"]);
    assert.deepEqual(t.rows[0], ["INV-0", "Item 0", "packed"]);
    assert.equal(t.truncated, false);
  });
});

describe("content hash", () => {
  const base = {
    documentId: "doc-1",
    templateId: "tpl",
    templateVersionId: "ver",
    version: 1,
    title: "Sign-off",
    fields: SAMPLE_BODY.flatMap((b) => (b.type === "field" ? [b.field] : [])),
    values: { customer: "Northwind", agree: true },
    snapshot: { context: { job: { name: "A" } }, tables: {}, today: "2026-10-02", capturedAt: "2026-10-02T12:00:00.000Z" },
  };

  it("is stable whatever the key order", () => {
    const reordered = { ...base, values: { agree: true, customer: "Northwind" } };
    assert.equal(content.documentContentHash(base), content.documentContentHash(reordered));
    assert.match(content.documentContentHash(base), /^[0-9a-f]{64}$/);
  });

  it("changes with any value, the title or the snapshot, but not with a signature", () => {
    const h = content.documentContentHash(base);
    assert.notEqual(content.documentContentHash({ ...base, values: { ...base.values, customer: "Contoso" } }), h);
    assert.notEqual(content.documentContentHash({ ...base, title: "Other" }), h);
    assert.notEqual(content.documentContentHash({ ...base, snapshot: { ...base.snapshot, today: "2026-10-03" } }), h);
    const signed = { ...base.values, customer_sig: { signatureId: "s", signerName: "Dana", signedAt: "2026-10-02T13:00:00Z" } };
    assert.equal(content.documentContentHash({ ...base, values: signed }), h);
  });

  it("gives each field its own signing statement", () => {
    const a = content.signingContent("doc", "ver", "hash", "customer_sig");
    const b = content.signingContent("doc", "ver", "hash", "crew_initials");
    assert.notDeepEqual(a, b);
    assert.equal(a.contentHash, "hash");
  });
});

function signaturePng(): Buffer {
  const canvas = createCanvas(300, 90);
  const g = canvas.getContext("2d");
  g.strokeStyle = "#000";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(10, 60);
  g.bezierCurveTo(60, 0, 120, 90, 290, 30);
  g.stroke();
  return canvas.toBuffer("image/png");
}

/** Every text-showing string in the PDF's content streams, decoded from hex. */
async function pdfText(bytes: Buffer): Promise<string> {
  const raw = bytes.toString("latin1");
  let out = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const data = Buffer.from(m[1]!, "latin1");
    let text: string;
    try {
      text = inflateSync(data).toString("latin1");
    } catch {
      text = data.toString("latin1");
    }
    for (const h of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += `${Buffer.from(h[1]!, "hex").toString("latin1")}\n`;
  }
  return out;
}

describe("PDF", () => {
  const input = (over: Partial<import("../src/services/documents/pdf").PdfInput> = {}) => ({
    model: renderSample(
      {
        customer: "Northwind",
        agree: true,
        customer_sig: { signatureId: "sig-1", signerName: "Dana Ruiz", signerRole: "Facility contact", signedAt: "2026-10-02T15:00:00.000Z" },
      },
      80,
    ),
    documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    status: "signed" as const,
    contentHash: "a".repeat(64),
    kicker: "Northwind",
    details: ["Job JOB-1 - Floor 3 move", "Relocation sign-off, version 3"],
    record: [
      ["Status", "Signed"],
      ["Content sha256", "a".repeat(64)],
    ] as [string, string][],
    signatureImages: new Map([["sig-1", signaturePng()]]),
    at: new Date("2026-10-02T15:00:00.000Z"),
    fmt: UTC,
    ...over,
  });

  it("renders a valid PDF that flows across pages, with the audit footer on each", async () => {
    const bytes = await pdf.renderDocumentPdf(input());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 2, `expected several pages, got ${doc.getPageCount()}`);
    assert.equal(doc.getTitle(), "Sign-off JOB-1");
    const text = await pdfText(bytes);
    const pages = doc.getPageCount();
    assert.equal(text.match(/Document 0f8fad5b-d9cb-469f-a165-70867728950e - Signed/g)?.length, pages);
    assert.equal(text.match(new RegExp(`Content sha256 ${"a".repeat(64)}`, "g"))?.length, pages);
    assert.match(text, new RegExp(`Page ${pages} of ${pages}`));
    assert.match(text, /Relocation sign-off: Floor 3 move/);
    assert.match(text, /Dana Ruiz, Facility contact - signed Oct 2, 2026/);
    // Characters the standard fonts cannot encode print as "?" instead of failing.
    assert.match(text, /Chair \? \?\?/);
  });

  it("gives the same bytes for the same document and state", async () => {
    const a = await pdf.renderDocumentPdf(input());
    const b = await pdf.renderDocumentPdf(input());
    assert.ok(a.equals(b));
  });

  it("marks a draft and prints no hash for it", async () => {
    const bytes = await pdf.renderDocumentPdf(input({ status: "draft", contentHash: null, record: [] }));
    const text = await pdfText(bytes);
    assert.match(text, /DRAFT - not completed/);
    assert.match(text, /Not completed: the content is not fixed and has no hash\./);
  });

  it("prints the signer's name when a signature image cannot be read", async () => {
    const bytes = await pdf.renderDocumentPdf(input({ signatureImages: new Map([["sig-1", Buffer.from("not an image")]]) }));
    assert.match(await pdfText(bytes), /Dana Ruiz/);
  });
});
