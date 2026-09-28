import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { MESSY_STEPS_REPLY, REFINE_REPLY, STEPS_REPLY, TEARDOWN_TRANSCRIPTION } from "./teardown-fixtures";

// Step and part extraction from narration: windowing, prompts, and turning
// model replies (good, messy and useless) into a clean draft.

type Extract = typeof import("../src/services/teardown/extract");
let x: Extract;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  x = await import("../src/services/teardown/extract");
});

const segments = () =>
  TEARDOWN_TRANSCRIPTION.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));

describe("small parsers", () => {
  it("reads timestamps in the forms models write them", () => {
    assert.equal(x.parseTimestamp(83.2), 83.2);
    assert.equal(x.parseTimestamp("83.2"), 83.2);
    assert.equal(x.parseTimestamp("83.2s"), 83.2);
    assert.equal(x.parseTimestamp("1:23"), 83);
    assert.equal(x.parseTimestamp("1:23.5"), 83.5);
    assert.equal(x.parseTimestamp("01:02:03"), 3723);
    for (const bad of [-1, "soon", "1:75", "", null, undefined, Number.NaN, {}]) assert.equal(x.parseTimestamp(bad), null);
  });

  it("formats clock times", () => {
    assert.equal(x.formatClock(0), "0:00");
    assert.equal(x.formatClock(83.9), "1:23");
    assert.equal(x.formatClock(3723), "1:02:03");
    assert.equal(x.formatClock(null), "");
  });

  it("reads quantities as digits, words or with an x", () => {
    assert.equal(x.parseQty(4), 4);
    assert.equal(x.parseQty("14"), 14);
    assert.equal(x.parseQty("14x"), 14);
    assert.equal(x.parseQty("x6"), 6);
    assert.equal(x.parseQty("four"), 4);
    assert.equal(x.parseQty("a dozen"), 12);
    assert.equal(x.parseQty(2.6), 3);
    for (const fallback of [0, -3, "some", null, undefined]) assert.equal(x.parseQty(fallback), 1);
    assert.equal(x.parseQty(10 ** 9), 100_000);
  });

  it("maps kinds and synonyms, and infers a kind from the name", () => {
    assert.equal(x.normalizeKind("Hardware", "anything"), "hardware");
    assert.equal(x.normalizeKind("fastener", "M4 screw"), "hardware");
    assert.equal(x.normalizeKind("Furniture", "Side panel"), "component");
    assert.equal(x.normalizeKind("wiring", "power cord"), "cable");
    assert.equal(x.normalizeKind(null, "Network cable"), "cable");
    assert.equal(x.normalizeKind(undefined, "Cam lock"), "hardware");
    assert.equal(x.normalizeKind(undefined, "Shelf"), "component");
    assert.equal(x.normalizeKind("bananas", "Gizmo"), "other");
  });

  it("clips at a word boundary", () => {
    assert.equal(x.clip("short", 10), "short");
    const clipped = x.clip("Remove the four M4 screws holding the top cover", 20);
    assert.ok(clipped.length <= 20, clipped);
    assert.ok(clipped.endsWith("…"));
    assert.ok(!clipped.includes("  "));
  });
});

describe("windows and prompts", () => {
  it("keeps a short narration in one window", () => {
    const windows = x.windowSegments(segments());
    assert.equal(windows.length, 1);
    assert.equal(windows[0]!.start, 0);
    assert.equal(windows[0]!.end, 58);
    assert.equal(windows[0]!.segments.length, 7);
  });

  it("splits by length and by duration, and skips empty segments", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `Step ${i} ${"words ".repeat(20)}` }));
    long.splice(3, 0, { start: 30, end: 30, text: "   " });
    const byChars = x.windowSegments(long, { maxChars: 1000, maxSeconds: 10_000 });
    assert.ok(byChars.length > 1);
    assert.ok(byChars.every((w) => w.segments.map((s) => s.text).join(" ").length <= 1000));
    assert.equal(byChars.reduce((n, w) => n + w.segments.length, 0), 40);
    const bySeconds = x.windowSegments(long, { maxChars: 1e6, maxSeconds: 100 });
    assert.ok(bySeconds.every((w) => w.end - w.start <= 100));
    assert.deepEqual(bySeconds.map((w) => w.index), bySeconds.map((_, i) => i));
  });

  it("puts timestamps, context and earlier parts in the prompt", () => {
    const [w] = x.windowSegments(segments());
    const prompt = x.buildStepsPrompt({
      window: { ...w!, index: 1 },
      windowCount: 3,
      stepsBefore: 4,
      lastStepTitle: "Remove the side panels",
      partsSoFar: ["M6 bolt", "Side panel", "M6 bolt"],
      equipment: "Lab workstation (Dell Precision 3660)",
      timed: true,
    });
    assert.match(prompt, /Equipment: Lab workstation \(Dell Precision 3660\)/);
    assert.match(prompt, /part 2 of 3/);
    assert.match(prompt, /produced 4 steps, the last being "Remove the side panels"/);
    assert.match(prompt, /Parts already listed \(reuse these names for the same parts\): M6 bolt, Side panel\n/);
    assert.match(prompt, /\[12\.8-21\.5\] Next, remove the four M4 screws/);
  });

  it("asks for null times when the transcript has none", () => {
    const prompt = x.buildStepsPrompt({
      window: { index: 0, start: 0, end: 0, segments: x.untimedSegments("Remove the cover. Then the fan.") },
      windowCount: 1,
      stepsBefore: 0,
      timed: false,
    });
    assert.match(prompt, /no timestamps/);
    assert.match(prompt, /Remove the cover\. Then the fan\./);
    assert.doesNotMatch(prompt, /\[0\.0/);
  });

  it("describes the reply shape in the system prompt", () => {
    assert.match(x.STEPS_SYSTEM, /"steps":\[\{"n":1/);
    assert.match(x.STEPS_SYSTEM, /hardware .* component .* cable/);
  });
});

describe("normalizeStepsReply", () => {
  it("takes a well-formed reply as it is", () => {
    const draft = x.normalizeStepsReply(STEPS_REPLY, { start: 0, end: 58 })!;
    assert.equal(draft.steps.length, 5);
    assert.deepEqual(draft.steps[1], {
      title: "Remove the top cover",
      instruction: "Remove the four M4 screws holding the top cover, then slide the cover off.",
      start: 12.8,
      end: 28,
      callout: "The fan cable is still attached to the cover",
    });
    assert.equal(draft.parts.length, 7);
    assert.deepEqual(draft.parts[2], { name: "M4 screw", kind: "hardware", qty: 4, step: 2 });
    assert.deepEqual(
      draft.parts.map((p) => p.step),
      [1, 1, 2, 2, 4, 5, 5],
    );
  });

  it("cleans up a messy reply", () => {
    const draft = x.normalizeStepsReply(MESSY_STEPS_REPLY, { start: 0, end: 58 })!;
    // The empty step is dropped; the bare string becomes a step with no times,
    // so the others stay in the model's order rather than being time-sorted.
    assert.deepEqual(
      draft.steps.map((s) => [s.title, s.start, s.end, s.callout]),
      [
        ["Take the four M4 screws out of the top cover", 12.8, 28, "Fan cable still attached"],
        ["Unplug everything", 5.2, 12.8, null],
        ["Pull the motherboard", 47.5, null, null],
        ["Lift out the drive caddies", null, null, null],
      ],
    );
    assert.equal(draft.steps[2]!.instruction, "Pull the motherboard");
    assert.deepEqual(draft.parts, [
      { name: "Power cord", kind: "cable", qty: 1, step: 2 },
      { name: "Network cable", kind: "cable", qty: 1, step: 2 },
      { name: "M4 screw", kind: "hardware", qty: 4, step: 1 },
      { name: "Top cover", kind: "component", qty: 1, step: 1 },
      { name: "Standoff", kind: "hardware", qty: 6, step: 3 },
      { name: "Drive caddy", kind: "component", qty: 1, step: null },
      { name: "SATA cable", kind: "cable", qty: 1, step: null },
    ]);
  });

  it("puts steps in time order when every step has a time, keeping part links", () => {
    const reply = {
      steps: [
        { n: 1, title: "Second", start: 30, end: 40 },
        { n: 2, title: "First", start: 10, end: 20 },
      ],
      parts: [{ name: "Bolt", qty: 2, stepN: 1 }],
    };
    const draft = x.normalizeStepsReply(reply, { start: 0, end: 60 })!;
    assert.deepEqual(draft.steps.map((s) => s.title), ["First", "Second"]);
    assert.equal(draft.parts[0]!.step, 2);
  });

  it("keeps times inside the window and drops ones far outside it", () => {
    const draft = x.normalizeStepsReply(
      {
        steps: [
          { title: "A", start: 598, end: 603 },
          { title: "B", start: 5, end: 700 },
          { title: "C", start: 650, end: 640 },
        ],
      },
      { start: 600, end: 660 },
    )!;
    assert.deepEqual(draft.steps.map((s) => [s.start, s.end]), [
      [600, 603],
      [null, null],
      [650, null],
    ]);
  });

  it("drops every time when the transcript had none", () => {
    const draft = x.normalizeStepsReply(STEPS_REPLY, null)!;
    assert.ok(draft.steps.every((s) => s.start === null && s.end === null));
  });

  it("returns null for replies with nothing usable", () => {
    for (const raw of [null, undefined, "steps", [], {}, { steps: [] }, { steps: "none" }, { steps: [{}, { title: " " }] }, { refusal: "I can't" }]) {
      assert.equal(x.normalizeStepsReply(raw, { start: 0, end: 10 }), null, JSON.stringify(raw));
    }
  });

  it("limits the length of every field", () => {
    const long = "word ".repeat(1000);
    const draft = x.normalizeStepsReply(
      { steps: [{ title: long, instruction: long, callout: long }], parts: [{ name: long, qty: 1 }] },
      null,
    )!;
    assert.ok(draft.steps[0]!.title.length <= x.LIMITS.title);
    assert.ok(draft.steps[0]!.instruction.length <= x.LIMITS.instruction);
    assert.ok(draft.steps[0]!.callout!.length <= x.LIMITS.callout);
    assert.ok(draft.parts[0]!.name.length <= x.LIMITS.partName);
  });
});

describe("appendDraft", () => {
  it("renumbers the appended window's part links", () => {
    const a = { steps: [{ title: "A", instruction: "A", start: 0, end: 1, callout: null }], parts: [{ name: "Bolt", kind: "hardware" as const, qty: 1, step: 1 }] };
    const b = {
      steps: [
        { title: "B", instruction: "B", start: 2, end: 3, callout: null },
        { title: "C", instruction: "C", start: 4, end: 5, callout: null },
      ],
      parts: [
        { name: "Panel", kind: "component" as const, qty: 1, step: 2 },
        { name: "Clip", kind: "hardware" as const, qty: 3, step: null },
      ],
    };
    const joined = x.appendDraft(a, b);
    assert.deepEqual(joined.steps.map((s) => s.title), ["A", "B", "C"]);
    assert.deepEqual(joined.parts.map((p) => p.step), [1, 3, null]);
  });
});

describe("draftFromTranscript (no language model)", () => {
  it("splits at cue words and pauses, and keeps the timestamps", () => {
    const draft = x.draftFromTranscript(segments());
    assert.deepEqual(
      draft.steps.map((s) => [s.title, s.start, s.end]),
      [
        ["This is the teardown of the lab workstation", 0, 5.2],
        ["Unplug the power cord and the two network cables from the back", 5.2, 12.8],
        ["Remove the four M4 screws holding the top cover", 12.8, 35.4],
        ["Lift out the two drive caddies", 38, 47.5],
        ["Unscrew the six standoff screws and pull the motherboard", 47.5, 58],
      ],
    );
    assert.match(draft.steps[2]!.callout!, /Be careful, the fan cable/);
    assert.match(draft.steps[3]!.callout!, /Label them left and right/);
    assert.match(draft.steps[4]!.callout!, /ten screws total/);
  });

  it("picks counted parts out of the words", () => {
    const draft = x.draftFromTranscript(segments());
    assert.deepEqual(
      draft.parts.map((p) => [p.name, p.kind, p.qty, p.step]),
      [
        ["Network cable", "cable", 2, 2],
        ["M4 screw", "hardware", 4, 3],
        ["Drive caddy", "component", 2, 4],
        ["Standoff screw", "hardware", 6, 5],
        ["Screw", "hardware", 10, 5],
      ],
    );
  });

  it("handles untimed text", () => {
    const draft = x.draftFromTranscript(x.untimedSegments("Remove the cover. Then pull a dozen clips. Now lift the shelf."), { timed: false });
    assert.equal(draft.steps.length, 3);
    assert.ok(draft.steps.every((s) => s.start === null));
    assert.deepEqual(draft.parts, [{ name: "Clip", kind: "hardware", qty: 12, step: 2 }]);
  });

  it("recognises part mentions", () => {
    assert.deepEqual(x.partsMentioned("take out the 14 M6 bolts and a pair of shelves, then three power supplies"), [
      { name: "M6 bolt", qty: 14, kind: "hardware" },
      { name: "Shelf", qty: 2, kind: "component" },
      { name: "Power supply", qty: 3, kind: "component" },
    ]);
    assert.deepEqual(x.partsMentioned("remove 4 of the screws. Two cables. Then lift it"), [
      { name: "Screw", qty: 4, kind: "hardware" },
      { name: "Cable", qty: 2, kind: "cable" },
    ]);
    assert.deepEqual(x.partsMentioned("nothing counted here"), []);
  });
});

describe("refining part names", () => {
  it("builds one prompt line per photo and part", () => {
    const prompt = x.buildRefinePrompt(
      [
        { stepN: 2, stepTitle: "Remove the top cover", parts: [{ id: "p1", name: "Screw", kind: "hardware", qty: 4 }] },
        { stepN: 4, stepTitle: "Lift out the drive caddies", parts: [{ id: "p2", name: "Caddy", kind: "component", qty: 2 }] },
      ],
      "Lab workstation",
    );
    assert.match(prompt, /Photo 1: step 2, "Remove the top cover"\n {2}p1: Screw \(hardware, qty 4\)/);
    assert.match(prompt, /Photo 2: step 4/);
    assert.match(prompt, /Do not add parts/);
  });

  it("accepts renames only for parts it asked about, and only real kinds", () => {
    const asked = new Map([
      ["p1", { name: "Screw", kind: "hardware" as const }],
      ["p2", { name: "Top cover", kind: "component" as const }],
      ["p3", { name: "Caddy", kind: "component" as const }],
    ]);
    const changes = x.normalizeRefineReply(REFINE_REPLY, asked);
    assert.deepEqual([...changes.entries()], [
      ["p1", { name: "M4 x 6 mm pan head screw", kind: "hardware" }],
      ["p3", { name: "Drive sled", kind: "component" }],
    ]);
    assert.equal(x.normalizeRefineReply(null, asked).size, 0);
    assert.equal(x.normalizeRefineReply({ parts: "nope" }, asked).size, 0);
  });
});
