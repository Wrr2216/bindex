import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

// Inspections' pure logic: pairing post findings with pre findings, reading
// AI replies, share tokens, the signed content and the two renderers. No
// database and no network.

type Insp = typeof import("../src/services/inspections");
type Pairing = typeof import("../src/services/inspections/pairing");
type Canonical = typeof import("../src/services/media-ai-core/canonical");
let insp: Insp;
let pairing: Pairing;
let canonical: Canonical;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  process.env.LOG_LEVEL ??= "error";
  insp = await import("../src/services/inspections");
  pairing = await import("../src/services/inspections/pairing");
  canonical = await import("../src/services/media-ai-core/canonical");
});

type F = import("../src/services/inspections/pairing").PairingFinding;
let seq = 0;
function f(
  id: string,
  room: string,
  spot: string,
  description: string,
  severity: F["severity"] = "minor",
  extra: Partial<F> = {},
): F {
  return {
    id,
    sequence: ++seq,
    room,
    locationId: null,
    spot,
    spotDetail: null,
    description,
    severity,
    preExisting: false,
    pairedWithId: null,
    pairSource: null,
    ...extra,
  };
}

const summary = (c: import("../src/services/inspections/pairing").Comparison) =>
  c.entries.map((e) => `${e.change}:${e.pre?.id ?? "-"}>${e.post?.id ?? "-"}`);

describe("room matching", () => {
  it("ignores case, punctuation and filler words, but not numbers", () => {
    assert.equal(pairing.normalizeRoom("Room 3.12"), "3 12");
    assert.equal(pairing.normalizeRoom("  the KITCHEN "), "kitchen");
    assert.equal(pairing.normalizeRoom("Café"), "cafe");
    assert.ok(pairing.sameRoom({ room: "Room 3.12", locationId: null }, { room: "3.12", locationId: null }));
    assert.ok(!pairing.sameRoom({ room: "Room 101", locationId: null }, { room: "Room 102", locationId: null }));
    assert.ok(!pairing.sameRoom({ room: "Room", locationId: null }, { room: "Area", locationId: null }), "nothing left to compare");
  });

  it("trusts location records over names", () => {
    assert.ok(pairing.sameRoom({ room: "Kitchen", locationId: "a" }, { room: "Break room", locationId: "a" }));
    assert.ok(!pairing.sameRoom({ room: "Kitchen", locationId: "a" }, { room: "Kitchen", locationId: "b" }));
    // A location path against free text compares the last level too.
    assert.ok(pairing.sameRoom({ room: "Floor 3 / Kitchen", locationId: "a" }, { room: "kitchen", locationId: null }));
    assert.ok(!pairing.sameRoom({ room: "Floor 3 / Kitchen", locationId: null }, { room: "Kitchen", locationId: null }));
  });
});

describe("compareFindings", () => {
  it("sorts findings into new, worsened, resolved and unchanged, new first", () => {
    const pre = [
      f("b1", "Kitchen", "wall", "Scuff marks by the fridge"),
      f("b2", "Main corridor", "floor", "Light scratches in the vinyl", "minor"),
      f("b3", "Lobby", "door", "Small dent at handle height"),
    ];
    const post = [
      f("a1", "kitchen", "wall", "Scuff marks by fridge"),
      f("a2", "Main Corridor", "floor", "Deep gouge through the vinyl", "major"),
      f("a3", "Office 4", "window", "Cracked pane", "major"),
    ];
    const c = pairing.compareFindings(pre, post);
    assert.deepEqual(c.counts, { new: 1, worsened: 1, resolved: 1, unchanged: 1 });
    assert.deepEqual(summary(c), ["new:->a3", "worsened:b2>a2", "resolved:b3>-", "unchanged:b1>a1"]);
    assert.equal(c.entries.find((e) => e.post?.id === "a2")!.source, "room_spot");
  });

  it("needs the same spot as well as the same room", () => {
    const c = pairing.compareFindings([f("b1", "Kitchen", "wall", "Scuff")], [f("a1", "Kitchen", "baseboard", "Scuff")]);
    assert.deepEqual(summary(c), ["new:->a1", "resolved:b1>-"]);
  });

  it("pairs several findings on one spot by the closest description", () => {
    const pre = [
      f("b1", "Boardroom", "wall", "Scuff marks near the door"),
      f("b2", "Boardroom", "wall", "Dent below the window", "minor"),
    ];
    const post = [
      f("a1", "Boardroom", "wall", "Dent below the window, larger now", "moderate"),
      f("a2", "Boardroom", "wall", "Scuff marks near the door"),
    ];
    const c = pairing.compareFindings(pre, post);
    assert.deepEqual(summary(c), ["worsened:b2>a1", "unchanged:b1>a2"]);
  });

  it("gives the same answer whatever order the findings arrive in", () => {
    const pre = [f("b1", "Dock", "dock", "Bumper torn"), f("b2", "Dock", "dock", "Leveler lip bent"), f("b3", "Dock", "floor", "Oil stain")];
    const post = [f("a1", "Dock", "dock", "Leveler lip bent further", "major"), f("a2", "Dock", "dock", "Bumper torn")];
    const one = summary(pairing.compareFindings(pre, post));
    const two = summary(pairing.compareFindings([...pre].reverse(), [...post].reverse()));
    assert.deepEqual(one, two);
    assert.deepEqual(one, ["worsened:b2>a1", "resolved:b3>-", "unchanged:b1>a2"]);
  });

  it("puts a person's decision before the AI's, and the AI's before the rule", () => {
    const pre = [f("b1", "Kitchen", "wall", "Scuff"), f("b2", "Boardroom", "trim", "Chipped paint")];
    const post = [
      // Same room and spot as b1, but a person says it is new damage.
      f("a1", "Kitchen", "wall", "Scuff", "minor", { pairSource: "manual", pairedWithId: null }),
      // Named differently; the AI matched it.
      f("a2", "Conference room", "baseboard", "Paint chipped", "moderate", { pairSource: "ai", pairedWithId: "b2" }),
      // A person paired it across rooms.
      f("a3", "Hall", "wall", "Scuff", "minor", { pairSource: "manual", pairedWithId: "b1" }),
    ];
    const c = pairing.compareFindings(pre, post);
    assert.deepEqual(summary(c), ["new:->a1", "worsened:b2>a2", "unchanged:b1>a3"]);
    assert.equal(c.entries.find((e) => e.post?.id === "a3")!.source, "manual");
    assert.equal(c.entries.find((e) => e.post?.id === "a2")!.source, "ai");
  });

  it("ignores an AI pair whose pre finding a person already claimed, or that no longer exists", () => {
    const pre = [f("b1", "Kitchen", "wall", "Scuff")];
    const post = [
      f("a1", "Kitchen", "wall", "Scuff", "minor", { pairSource: "manual", pairedWithId: "b1" }),
      f("a2", "Kitchen", "wall", "Scuff too", "minor", { pairSource: "ai", pairedWithId: "b1" }),
      f("a3", "Hall", "floor", "Scratch", "minor", { pairSource: "ai", pairedWithId: "gone" }),
    ];
    assert.deepEqual(summary(pairing.compareFindings(pre, post)), ["new:->a2", "new:->a3", "unchanged:b1>a1"]);
  });

  it("counts damage marked pre-existing as unchanged rather than new", () => {
    const c = pairing.compareFindings([], [f("a1", "Stairwell B", "stairs", "Nosing cracked", "moderate", { preExisting: true })]);
    assert.deepEqual(c.counts, { new: 0, worsened: 0, resolved: 0, unchanged: 1 });
    assert.equal(c.entries[0]!.notedPreExisting, true);
  });

  it("treats an improvement as unchanged", () => {
    const c = pairing.compareFindings([f("b1", "Lobby", "floor", "Stain", "moderate")], [f("a1", "Lobby", "floor", "Stain", "minor")]);
    assert.deepEqual(summary(c), ["unchanged:b1>a1"]);
  });

  it("offers the AI only what is still unmatched, and never what a person ruled out", () => {
    const pre = [f("b1", "Kitchen", "wall", "Scuff"), f("b2", "Boardroom", "trim", "Chip"), f("b3", "Hall", "door", "Dent")];
    const post = [
      f("a1", "Kitchen", "wall", "Scuff"),
      f("a2", "Conference room", "trim", "Chip", "minor", { pairSource: "ai", pairedWithId: "b2" }),
      f("a3", "Hallway", "door", "Dent", "minor", { pairSource: "manual", pairedWithId: null }),
      f("a4", "Reception", "floor", "Scratch"),
    ];
    const open = pairing.unmatched(pre, post);
    assert.deepEqual(open.pre.map((x) => x.id), ["b2", "b3"]);
    assert.deepEqual(open.post.map((x) => x.id), ["a2", "a4"]);
  });
});

describe("normalizeDamageReading", () => {
  const known = [
    { name: "Floor 3 / Kitchen", locationId: "loc-k3" },
    { name: "Floor 3 / Boardroom", locationId: "loc-b3" },
    { name: "Loading dock", locationId: null },
  ];

  it("keeps a well-formed reply and snaps the room to a known one", () => {
    const s = insp.normalizeDamageReading(
      {
        damage: true,
        area: "inside",
        room: "kitchen",
        spot: "baseboard",
        spotDetail: "left of the sink",
        description: "Paint chipped along 20 cm of the baseboard.",
        severity: "moderate",
        confidence: 0.8,
      },
      known,
    )!;
    assert.deepEqual(s, {
      damage: true,
      area: "inside",
      room: "Floor 3 / Kitchen",
      locationId: "loc-k3",
      spot: "baseboard",
      spotDetail: "left of the sink",
      description: "Paint chipped along 20 cm of the baseboard.",
      severity: "moderate",
      confidence: 0.8,
    });
  });

  it("reads what models actually send: wrappers, synonyms, strings and percentages", () => {
    const s = insp.normalizeDamageReading({
      result: {
        has_damage: "yes",
        inside_outside: "Exterior",
        location: "  Loading   Dock ",
        surface: "Dock leveler",
        position: "north bay",
        summary: "Leveler lip bent upward",
        severity: "Severe",
        confidence: "85%",
      },
    }, known)!;
    assert.equal(s.area, "outside");
    assert.equal(s.room, "Loading dock");
    assert.equal(s.locationId, null);
    assert.equal(s.spot, "dock");
    assert.equal(s.spotDetail, "north bay");
    assert.equal(s.severity, "major");
    assert.equal(s.confidence, 0.85);
    assert.equal(s.damage, true);
  });

  it("maps spot words and falls back to other", () => {
    assert.equal(insp.normalizeSpot("Skirting board"), "baseboard");
    assert.equal(insp.normalizeSpot("door frame"), "frame");
    assert.equal(insp.normalizeSpot("ceiling tiles"), "ceiling");
    assert.equal(insp.normalizeSpot("carpet"), "floor");
    assert.equal(insp.normalizeSpot("wall socket"), "fixture");
    assert.equal(insp.normalizeSpot("lift car"), "elevator");
    assert.equal(insp.normalizeSpot("light scratches on wall"), "wall");
    assert.equal(insp.normalizeSpot("gazebo"), "other");
    assert.equal(insp.normalizeSpot(null), "other");
    assert.equal(insp.normalizeSeverity(3), "major");
    assert.equal(insp.normalizeSeverity("cosmetic"), "minor");
    assert.equal(insp.normalizeSeverity("whatever"), null);
  });

  it("drops placeholders and keeps a clear 'no damage'", () => {
    const s = insp.normalizeDamageReading({ damage: false, room: "n/a", description: "none", spot: "unknown", severity: null })!;
    assert.equal(s.damage, false);
    assert.equal(s.room, null);
    assert.equal(s.description, null);
    assert.equal(s.spot, "other");
  });

  it("does not snap to a room when two known rooms share the name", () => {
    const twoKitchens = [
      { name: "Floor 2 / Kitchen", locationId: "k2" },
      { name: "Floor 3 / Kitchen", locationId: "k3" },
    ];
    const s = insp.normalizeDamageReading({ room: "Kitchen", description: "Stain" }, twoKitchens)!;
    assert.equal(s.room, "Kitchen");
    assert.equal(s.locationId, null);
  });

  it("returns null for replies that are not a finding", () => {
    assert.equal(insp.normalizeDamageReading(null), null);
    assert.equal(insp.normalizeDamageReading("Scuff on the wall"), null);
    assert.equal(insp.normalizeDamageReading([{ description: "x" }]), null);
    assert.equal(insp.normalizeDamageReading({}), null);
    assert.equal(insp.normalizeDamageReading({ foo: "bar", confidence: 0.2 }), null);
  });
});

describe("normalizeAiMatches", () => {
  it("maps P/Q references to indexes and keeps each finding in one pair", () => {
    const out = insp.normalizeAiMatches(
      {
        matches: [
          { pre: "P1", post: "Q2", confidence: 0.7 },
          { pre: "P1", post: "Q1", confidence: 0.95 },
          { pre: 2, post: "q3" },
          { pre: "P9", post: "Q1", confidence: 0.99 },
          { pre: "P3", post: "Q2", confidence: 0.4 },
          { pre: "P3", post: "Q2", confidence: "high" },
          "nonsense",
        ],
      },
      3,
      3,
    );
    assert.deepEqual(out, [
      { pre: 0, post: 0, confidence: 0.95 },
      { pre: 2, post: 1, confidence: 0.9 },
      { pre: 1, post: 2, confidence: null },
    ]);
  });

  it("returns nothing for replies without a list", () => {
    assert.deepEqual(insp.normalizeAiMatches(null, 2, 2), []);
    assert.deepEqual(insp.normalizeAiMatches({ matches: "P1=Q1" }, 2, 2), []);
    assert.deepEqual(insp.normalizeAiMatches({ pairs: [{ before: "P1", after: "Q1" }] }, 1, 1), [{ pre: 0, post: 0, confidence: null }]);
  });
});

describe("share tokens", () => {
  const id = "0f8b3c2e-5d4a-4c1b-9e7f-123456789abc";
  const key = () => insp.shareKey("another-secret-0123456789");

  it("round-trips the share id and expiry", () => {
    const expires = new Date(Date.now() + 3 * 86_400_000);
    const token = insp.signShareToken(id, expires, key());
    const read = insp.readShareToken(token, key());
    assert.ok(read.ok);
    assert.equal(read.shareId, id);
    assert.equal(read.expiresAt.getTime(), Math.floor(expires.getTime() / 1000) * 1000);
    assert.match(token, /^[0-9a-f]{32}\.[0-9a-z]+\.[A-Za-z0-9_-]{24}$/);
  });

  it("refuses a changed id, a changed expiry, another key and a late arrival", () => {
    const expires = new Date(Date.now() + 86_400_000);
    const token = insp.signShareToken(id, expires, key());
    const [hexId, exp, mac] = token.split(".") as [string, string, string];
    const flip = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
    assert.deepEqual(insp.readShareToken(`${flip(hexId)}.${exp}.${mac}`, key()), { ok: false, reason: "bad_signature" });
    const later = (parseInt(exp, 36) + 86_400).toString(36);
    assert.deepEqual(insp.readShareToken(`${hexId}.${later}.${mac}`, key()), { ok: false, reason: "bad_signature" });
    assert.deepEqual(insp.readShareToken(token, insp.shareKey("some-other-secret-000")), { ok: false, reason: "bad_signature" });
    assert.deepEqual(insp.readShareToken(token, key(), new Date(expires.getTime() + 1000)), { ok: false, reason: "expired" });
    assert.deepEqual(insp.readShareToken("../../etc/passwd", key()), { ok: false, reason: "malformed" });
    assert.deepEqual(insp.readShareToken(`${token}x`, key()), { ok: false, reason: "malformed" });
  });
});

describe("signed content", () => {
  const inspection = {
    id: "i1",
    code: "INS-ABC123",
    kind: "post" as const,
    siteName: "New HQ / Level 5",
    locationId: "l1",
    jobId: "j1",
    preInspectionId: "p1",
    inspectors: ["Dana Ruiz"],
    notes: null,
  };
  const withPhotos = (x: F, photos: (string | null)[]) => ({ ...x, area: "inside", photos });

  it("is the same JSON however it is assembled, and changes when a finding or photo does", () => {
    const pre = [withPhotos(f("b1", "Kitchen", "wall", "Scuff"), ["aa"])];
    const post = [withPhotos(f("a1", "Kitchen", "wall", "Scuff"), ["bb"]), withPhotos(f("a2", "Lobby", "door", "Dent", "moderate"), [])];
    const build = (p: typeof post) =>
      insp.buildSignContent({ inspection, findings: p, comparison: insp.compareFindings(pre, p) });
    const one = canonical.contentHash(build(post));
    assert.equal(canonical.contentHash(build([...post].reverse())), one);
    assert.notEqual(canonical.contentHash(build([{ ...post[0]!, description: "Scuffs" }, post[1]!])), one);
    assert.notEqual(canonical.contentHash(build([{ ...post[0]!, photos: [null] }, post[1]!])), one);
    const content = build(post);
    assert.equal(content.comparison!.counts.new, 1);
    assert.equal(content.format, "bindex.inspection/1");
    assert.ok(!JSON.stringify(content).includes("completedAt"), "timestamps are not signed");
  });
});

describe("report renderers", () => {
  function jpeg(): Buffer {
    const c = createCanvas(640, 480);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#a33";
    ctx.fillRect(0, 0, 640, 480);
    return c.toBuffer("image/jpeg");
  }

  function report(): import("../src/services/inspections").InspectionReport {
    const finding = (id: string, n: number, room: string, severity: F["severity"], description: string) => ({
      id,
      number: n,
      area: "inside" as const,
      areaLabel: "Inside",
      room,
      spot: "wall",
      spotLabel: "Wall",
      spotDetail: null,
      description,
      severity,
      severityLabel: severity[0]!.toUpperCase() + severity.slice(1),
      preExisting: false,
      aiGenerated: n === 1,
      photos: [{ id: `photo-${id}`, mime: "image/jpeg", caption: null, width: 640, height: 480 }],
    });
    const post = Array.from({ length: 14 }, (_, i) =>
      finding(`a${i}`, i + 1, i % 2 ? "Kitchen ☕" : "Boardroom <b>", i % 3 ? "minor" : "major", `Damage number ${i} ${"word ".repeat(30)}`),
    );
    const pre = [finding("b0", 1, "Kitchen ☕", "minor", "Old scuff")];
    return {
      id: "i1",
      code: "INS-ABC123",
      kind: "post",
      kindLabel: "Post-move inspection",
      status: "signed",
      statusLabel: "Signed",
      siteName: "New HQ / Level 5 <script>alert(1)</script>",
      siteAddress: "1 Main St",
      job: { code: "JOB-XYZ789", name: "Floor 5 move" },
      startedAt: new Date("2026-09-20T14:00:00Z"),
      completedAt: new Date("2026-09-20T16:00:00Z"),
      signedAt: new Date("2026-09-20T16:10:00Z"),
      inspectors: ["Dana Ruiz"],
      notes: "Checked with the building manager.",
      findings: post,
      rooms: insp.groupByRoom(post),
      severityCounts: { minor: 9, moderate: 0, major: 5 },
      pre: { id: "p1", code: "INS-PRE001", status: "signed", startedAt: new Date(), completedAt: new Date(), findings: pre },
      comparison: {
        counts: { new: 13, worsened: 1, resolved: 0, unchanged: 0 },
        entries: [
          { change: "worsened", pre: pre[0]!, post: post[1]!, source: "room_spot", notedPreExisting: false },
          ...post.filter((_, i) => i !== 1).map((p) => ({ change: "new" as const, pre: null, post: p, source: null, notedPreExisting: false })),
        ],
      },
      signoffs: [
        {
          role: "facility_contact",
          label: "Facility contact",
          signature: {
            id: "s1",
            role: "facility_contact",
            signerName: "Pat Lee",
            signerRole: "Facility manager",
            signerEmail: null,
            signedAt: new Date(),
            statement: "I agree.",
            imageId: null,
            valid: true,
            reason: "ok",
            contentHash: "abc",
          },
        },
        { role: "crew_lead", label: "Crew lead", signature: null },
      ],
      otherSignatures: [],
      contentHash: "f".repeat(64),
      generatedAt: new Date(),
    };
  }

  it("renders a multi-page PDF with photos, odd characters and missing images", async () => {
    const photo = jpeg();
    let asked = 0;
    const pdf = await insp.renderInspectionPdf(
      report(),
      async (id) => {
        asked++;
        return id === "photo-a3" ? null : { kind: "jpg", bytes: photo };
      },
      "America/Chicago",
    );
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(asked >= 15, "every photo is asked for once");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf);
    assert.ok(doc.getPageCount() >= 3);
  });

  it("escapes everything on the share page and points files at the share link", () => {
    const html = insp.renderShareHtml(report(), {
      base: "/api/share/inspections/tok",
      appName: "Bindex",
      expiresAt: new Date("2026-10-10T00:00:00Z"),
    });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("Boardroom &lt;b&gt;"));
    assert.ok(html.includes('src="/api/share/inspections/tok/files/photo-a0?w=480"'));
    assert.ok(html.includes('href="/api/share/inspections/tok/report.pdf"'));
    assert.match(html, /New damage \(13\)/);
    assert.ok(!/<script/i.test(html.replace(/&lt;script/g, "")), "no script tags at all");
  });
});
