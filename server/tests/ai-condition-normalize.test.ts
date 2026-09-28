import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Parsing and normalizing what vision models send back for container capture,
// condition assessment and comparison, from fixture replies, including the
// malformed ones real providers produce. Pure: no database, no network.

type Vocab = typeof import("../src/services/ai-condition/vocab");
type Normalize = typeof import("../src/services/ai-condition/normalize");
type Handling = typeof import("../src/services/ai-condition/handling");
type Containers = typeof import("../src/services/ai-condition/containers");
type Prompts = typeof import("../src/services/ai-condition/prompts");
let vocab: Vocab;
let norm: Normalize;
let handling: Handling;
let containers: Containers;
let prompts: Prompts;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  vocab = await import("../src/services/ai-condition/vocab");
  norm = await import("../src/services/ai-condition/normalize");
  handling = await import("../src/services/ai-condition/handling");
  containers = await import("../src/services/ai-condition/containers");
  prompts = await import("../src/services/ai-condition/prompts");
});

const LISTS = () => ({ sizeClasses: [...vocab.DEFAULT_SIZE_CLASSES], categories: [...vocab.DEFAULT_CATEGORIES] });

/** A dish pack as a well-behaved model describes it. */
const DISH_PACK = {
  sizeClass: "Dish pack",
  handwrittenText: "KITCHEN\nplates + bowls\n  FRAGILE  ",
  room: "Kitchen",
  contentsSummary: "Dinner plates and bowls",
  contents: [
    { name: "Dinner plates", category: "Dishes and glassware", qty: 12, condition: "good", fragile: true, description: "White porcelain" },
    { name: "Cereal bowls", category: "dishes", qty: "6", condition: "Like new", fragile: "yes" },
    { name: "Tea towels", category: "Linens", qty: 3, condition: null, fragile: false },
  ],
  flags: ["Fragile", "this way up"],
  confidence: { sizeClass: 0.9, handwrittenText: "85%", room: "high", contents: 0.7 },
};

describe("vocabulary", () => {
  it("reads ratings from words, phrases and 1-5 scores", () => {
    const cases: [unknown, string | null][] = [
      ["good", "good"],
      ["Excellent", "excellent"],
      ["like new", "excellent"],
      ["In fair condition", "fair"],
      ["Overall condition: poor", "poor"],
      ["very poor", "poor"],
      ["Broken", "damaged"],
      ["slightly damaged", "fair"],
      [5, "excellent"],
      [1, "damaged"],
      ["3", "fair"],
      [7, null],
      ["not damaged", null],
      ["", null],
      [null, null],
      [{ rating: "good" }, null],
    ];
    for (const [input, want] of cases) assert.equal(vocab.normalizeRating(input), want, JSON.stringify(input));
  });

  it("maps defect words onto the fixed types", () => {
    const cases: [unknown, string][] = [
      ["scratch", "scratch"],
      ["Scuffs", "scratch"],
      ["scuff marks", "scratch"],
      ["water marks", "stain"],
      ["DENT", "dent"],
      ["dinged", "dent"],
      ["chipped edge", "gouge"],
      ["hairline crack", "crack"],
      ["missing part", "missing_part"],
      ["missing_part", "missing_part"],
      ["Missing knob", "missing_part"],
      ["wobbly leg", "loose"],
      ["burn", "other"],
      [42, "other"],
    ];
    for (const [input, want] of cases) assert.equal(vocab.normalizeDefectType(input), want, String(input));
  });

  it("reads severities, defaulting to moderate", () => {
    assert.equal(vocab.normalizeSeverity("Minor"), "minor");
    assert.equal(vocab.normalizeSeverity("cosmetic"), "minor");
    assert.equal(vocab.normalizeSeverity("severe"), "major");
    assert.equal(vocab.normalizeSeverity("deep gouge"), "major");
    assert.equal(vocab.normalizeSeverity("medium"), "moderate");
    assert.equal(vocab.normalizeSeverity(1), "minor");
    assert.equal(vocab.normalizeSeverity("2"), "moderate");
    assert.equal(vocab.normalizeSeverity(3), "major");
    assert.equal(vocab.normalizeSeverity(undefined), "moderate");
  });

  it("recognises handling marks and drops the rest", () => {
    assert.deepEqual(vocab.normalizeFlags(["Handle with care", "UP ARROWS", "valuables", "team lift", "keep dry", "misc"]), [
      "fragile",
      "this_side_up",
      "high_value",
      "heavy",
      "keep_dry",
    ]);
    assert.deepEqual(vocab.normalizeFlags("fragile, fragile, this_side_up"), ["fragile", "this_side_up"]);
    assert.deepEqual(vocab.normalizeFlags(null), []);
    assert.deepEqual(vocab.normalizeFlags({ fragile: true }), []);
  });

  it("matches free text to a configured list entry by whole words", () => {
    const sizes = [...vocab.DEFAULT_SIZE_CLASSES];
    assert.equal(vocab.matchListEntry("Medium box", sizes), "medium");
    assert.equal(vocab.matchListEntry("DISH-PACK", sizes), "dish pack");
    assert.equal(vocab.matchListEntry("dishpack", sizes), "dish pack");
    assert.equal(vocab.matchListEntry("wooden pallets", sizes), "pallet");
    assert.equal(vocab.matchListEntry("banana box", sizes), null);
    assert.equal(vocab.matchListEntry("palette", sizes), null);
    const cats = [...vocab.DEFAULT_CATEGORIES];
    assert.equal(vocab.matchListEntry("books", cats), "Books and paper");
    assert.equal(vocab.matchListEntry("Electronics", cats), "Electronics");
    assert.equal(vocab.matchListEntry("", cats), null);
  });

  it("normalizes one defect from any reasonable shape", () => {
    assert.deepEqual(vocab.normalizeDefect({ area: " Lid, top-left ", type: "Scratch", severity: "light", description: "Two fine lines" }), {
      area: "Lid, top-left",
      type: "scratch",
      severity: "minor",
      description: "Two fine lines",
    });
    // Only a description: the type and severity are read from it.
    assert.deepEqual(vocab.normalizeDefect({ description: "deep gouge on the rear leg" }), {
      area: "general",
      type: "gouge",
      severity: "major",
      description: "deep gouge on the rear leg",
    });
    assert.deepEqual(vocab.normalizeDefect("small dent near handle"), {
      area: "general",
      type: "dent",
      severity: "minor",
      description: "small dent near handle",
    });
    assert.equal(vocab.normalizeDefect({}), null);
    assert.equal(vocab.normalizeDefect(null), null);
    assert.equal(vocab.normalizeDefect(["scratch"]), null);
  });

  it("drops empty and repeated defects and caps the list", () => {
    const d = { area: "lid", type: "scratch", severity: "minor", description: "fine" };
    assert.equal(vocab.normalizeDefects([d, d, {}, null, "n/a"]).length, 1);
    assert.equal(vocab.normalizeDefects(Array.from({ length: 80 }, (_, i) => ({ area: `spot ${i}`, type: "dent" }))).length, 50);
    assert.deepEqual(vocab.normalizeDefects("scratched"), []);
  });

  it("reads quantities and confidences in the forms models use", () => {
    assert.equal(vocab.normalizeQty("12"), 12);
    assert.equal(vocab.normalizeQty("approx. 4"), 4);
    assert.equal(vocab.normalizeQty("a few"), 1);
    assert.equal(vocab.normalizeQty(0), 1);
    assert.equal(vocab.normalizeQty(2.6), 3);
    assert.equal(vocab.normalizeQty(1e9), 9999);
    assert.equal(vocab.confidenceValue("85%"), 0.85);
    assert.equal(vocab.confidenceValue(90), 0.9);
    assert.equal(vocab.confidenceValue("low"), 0.3);
    assert.equal(vocab.confidenceValue(-1), null);
    assert.equal(vocab.confidenceValue("sure"), null);
  });
});

describe("container capture replies", () => {
  it("normalizes a well-formed reply", () => {
    const d = norm.normalizeContainerCapture(DISH_PACK, LISTS())!;
    assert.equal(d.sizeClass, "dish pack");
    assert.equal(d.sizeClassRaw, null);
    assert.equal(d.handwrittenText, "KITCHEN\nplates + bowls\nFRAGILE");
    assert.equal(d.room, "Kitchen");
    assert.equal(d.contentsSummary, "Dinner plates and bowls");
    assert.deepEqual(d.flags, ["fragile", "this_side_up"]);
    assert.deepEqual(d.contents, [
      { name: "Dinner plates", category: "Dishes and glassware", qty: 12, condition: "good", fragile: true, description: "White porcelain" },
      { name: "Cereal bowls", category: "Dishes and glassware", qty: 6, condition: "excellent", fragile: true, description: null },
      { name: "Tea towels", category: "Clothing and linens", qty: 3, condition: null, fragile: false, description: null },
    ]);
    assert.deepEqual(d.confidence, { sizeClass: 0.9, handwrittenText: 0.85, room: 0.9, contents: 0.7 });
  });

  it("keeps a size the list does not have as a hint, with low confidence", () => {
    const d = norm.normalizeContainerCapture({ sizeClass: "banana box", confidence: 0.95 }, LISTS())!;
    assert.equal(d.sizeClass, null);
    assert.equal(d.sizeClassRaw, "banana box");
    assert.ok(d.confidence.sizeClass <= 0.3);
  });

  it("spreads one overall confidence over the fields that were read", () => {
    const d = norm.normalizeContainerCapture({ room: "Office 3.14", contents: ["Books"], confidence: "70%" }, LISTS())!;
    assert.deepEqual(d.confidence, { sizeClass: 0, handwrittenText: 0, room: 0.7, contents: 0.7 });
  });

  it("reads contents written as plain strings, with counts", () => {
    const d = norm.normalizeContainerCapture({ items: ["3 x Dinner plates", "Books (12)", "Lamp", "", null] }, LISTS())!;
    assert.deepEqual(
      d.contents.map((c) => [c.name, c.qty]),
      [
        ["Dinner plates", 3],
        ["Books", 12],
        ["Lamp", 1],
      ],
    );
  });

  it("marks a box fragile when a line inside is fragile", () => {
    const d = norm.normalizeContainerCapture({ contents: [{ name: "Wine glasses", fragile: true }] }, LISTS())!;
    assert.deepEqual(d.flags, ["fragile"]);
  });

  it("sorts unknown categories into Other, and never into the domain category", () => {
    const lists = { sizeClasses: ["small"], categories: ["Tools", "Domain", "Other"] };
    const d = norm.normalizeContainerCapture({ contents: [{ name: "x", category: "Garden" }, { name: "y", category: "domain" }, { name: "z" }] }, lists)!;
    assert.deepEqual(d.contents.map((c) => c.category), ["Other", null, null]);
    const noOther = norm.normalizeContainerCapture({ contents: [{ name: "x", category: "Garden" }] }, { sizeClasses: [], categories: ["Tools"] })!;
    assert.equal(noOther.contents[0]!.category, null);
  });

  it("returns null for replies with nothing usable", () => {
    for (const reply of [null, {}, { sizeClass: null, contents: [], flags: [] }, { contents: "none" }, { handwrittenText: "N/A" }]) {
      assert.equal(norm.normalizeContainerCapture(reply as Record<string, unknown> | null, LISTS()), null, JSON.stringify(reply));
    }
    assert.equal(norm.normalizeContainerCapture([DISH_PACK] as unknown as Record<string, unknown>, LISTS()), null);
  });

  it("caps the contents list", () => {
    const d = norm.normalizeContainerCapture({ contents: Array.from({ length: 150 }, (_, i) => ({ name: `Thing ${i}` })) }, LISTS())!;
    assert.equal(d.contents.length, norm.MAX_CONTENT_LINES);
  });
});

describe("condition assessment replies", () => {
  it("normalizes a well-formed reply", () => {
    const d = norm.normalizeAssessment({
      rating: "Fair",
      summary: "Solid oak desk with wear on the top and one loose drawer handle.",
      defects: [
        { area: "desk top, front edge", type: "scratch", severity: "minor", description: "Light surface scratches" },
        { area: "left drawer", type: "Loose", severity: "moderate", description: "Handle wobbles" },
      ],
      handlingNote: "Handle with care to prevent further scratching of the top.",
      confidence: 0.8,
    })!;
    assert.equal(d.rating, "fair");
    assert.equal(d.defects.length, 2);
    assert.equal(d.defects[1]!.type, "loose");
    assert.equal(d.handlingNote, "Handle with care to prevent further scratching of the top.");
    assert.equal(d.confidence, 0.8);
  });

  it("accepts snake_case and synonyms", () => {
    const d = norm.normalizeAssessment({ condition: 4, notes: "Fine", damage: ["scuffed corner"], handling_note: "Keep upright" })!;
    assert.equal(d.rating, "good");
    assert.equal(d.summary, "Fine");
    assert.equal(d.defects[0]!.type, "scratch");
    assert.equal(d.handlingNote, "Keep upright");
  });

  it("drops an unknown rating but keeps the rest", () => {
    const d = norm.normalizeAssessment({ rating: "B+", defects: [{ area: "lid", type: "dent" }] })!;
    assert.equal(d.rating, null);
    assert.equal(d.defects.length, 1);
  });

  it("returns null for replies with nothing usable", () => {
    for (const reply of [null, {}, { rating: "unknown", defects: "none", summary: "" }, { confidence: 0.9 }]) {
      assert.equal(norm.normalizeAssessment(reply as Record<string, unknown> | null), null, JSON.stringify(reply));
    }
  });
});

describe("comparison replies", () => {
  it("normalizes a well-formed reply", () => {
    const d = norm.normalizeComparison({
      summary: "A new dent on the right door.",
      newDefects: [{ area: "right door", type: "dent", severity: "moderate", description: "Fist-sized dent" }],
      resolvedDefects: [],
      ratingAfter: "poor",
      changed: true,
    })!;
    assert.equal(d.changed, true);
    assert.equal(d.newDefects[0]!.type, "dent");
    assert.equal(d.ratingAfter, "poor");
  });

  it("trusts the list of new defects over the changed flag", () => {
    assert.equal(norm.normalizeComparison({ newDefects: [{ area: "lid", type: "crack" }], changed: false })!.changed, true);
    assert.equal(norm.normalizeComparison({ summary: "No change.", changed: "yes" })!.changed, false);
    assert.equal(norm.normalizeComparison({ changed: false })!.changed, false);
  });

  it("returns null for replies with nothing usable", () => {
    for (const reply of [null, {}, { newDefects: "none" }]) {
      assert.equal(norm.normalizeComparison(reply as Record<string, unknown> | null), null);
    }
  });
});

describe("handling text", () => {
  it("puts marks, a poor rating and the note on one line", () => {
    assert.equal(
      handling.handlingText({ flags: ["fragile", "this_side_up"], rating: "damaged", note: "Handle with care to prevent further scratching." }),
      "Fragile · This side up. Damaged. Handle with care to prevent further scratching.",
    );
    assert.equal(handling.handlingText({ flags: [], rating: "good", note: "Two person lift" }), "Two person lift.");
    assert.equal(handling.handlingText({ flags: ["heavy"], rating: null, note: null }), "Heavy.");
    assert.equal(handling.handlingText({ flags: [], rating: "excellent", note: "  " }), "");
  });
});

describe("confirmed container captures", () => {
  it("tidies lines, keeps typed categories and sizes, and refuses a nameless line", () => {
    const c = containers.cleanCaptureInput(
      {
        sizeClass: "MEDIUM",
        flags: ["fragile", "nonsense", "fragile"],
        handwrittenText: " Office \n\n 3.14 ",
        contents: [
          { name: " Monitor ", category: "it equipment", qty: 2, fragile: true },
          { name: "Plant", category: "Garden", create: false },
          { name: "Mug", category: "Domain" },
        ],
      },
      LISTS(),
    );
    assert.equal(c.sizeClass, "medium");
    assert.deepEqual(c.flags, ["fragile"]);
    assert.equal(c.handwrittenText, "Office\n3.14");
    assert.deepEqual(
      c.lines.map((l) => [l.name, l.category, l.qty, l.create]),
      [
        ["Monitor", "IT equipment", 2, true],
        ["Plant", "Garden", 1, false],
        ["Mug", null, 1, true],
      ],
    );
    assert.equal(containers.cleanCaptureInput({ sizeClass: "banana box" }, LISTS()).sizeClass, "banana box");
    assert.throws(() => containers.cleanCaptureInput({ contents: [{ name: "  " }] }, LISTS()), /Line 1 has no name/);
  });
});

describe("prompts", () => {
  it("name the configured lists, the fixed vocabularies and the organisation's note", () => {
    const p = prompts.containerPrompt({ sizeClasses: ["tote", "cage"], categories: ["Spares"], hint: "Totes are grey, 60 litre." });
    assert.match(p, /"tote", "cage"/);
    assert.match(p, /"Spares"/);
    assert.match(p, /"this_side_up"/);
    assert.match(p, /Totes are grey, 60 litre\.$/);
    assert.doesNotMatch(prompts.assessPrompt({ itemName: 'Desk "A"', hint: "" }), /Notes from the organisation/);
    assert.match(prompts.assessPrompt({ itemName: 'Desk "A"', hint: "" }), /\("Desk 'A'"\)/);
    const c = prompts.comparePrompt({
      beforeCount: 2,
      afterCount: 1,
      beforeLabel: "before, 2026-09-01",
      afterLabel: "after, 2026-09-20",
      beforeDefects: [{ area: "lid", type: "scratch", severity: "minor", description: "x" }],
      beforeRating: "good",
      hint: "",
    });
    assert.match(c, /first 2 photo\(s\)/);
    assert.match(c, /next 1 were taken AFTER/);
    assert.match(c, /\[\{"area":"lid","type":"scratch","severity":"minor"\}\]/);
  });
});
