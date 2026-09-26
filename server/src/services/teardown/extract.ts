import type { TeardownPartKind } from "../../db/tables/teardown";

/**
 * Pure logic for turning a narrated teardown into steps and parts: splitting
 * the transcript into windows a model can answer in one go, the prompts, and
 * normalizing whatever the model sends back. No I/O, so every awkward reply
 * can be tested with a fixture (tests/teardown-extract.test.ts).
 */

export type Segment = { start: number; end: number; text: string };

export type StepDraft = {
  title: string;
  instruction: string;
  start: number | null;
  end: number | null;
  callout: string | null;
};

export type PartDraft = {
  name: string;
  kind: TeardownPartKind;
  qty: number;
  /** 1-based index into the draft's steps, or null when not tied to one. */
  step: number | null;
};

export type Draft = { steps: StepDraft[]; parts: PartDraft[] };

export type TranscriptWindow = { index: number; start: number; end: number; segments: Segment[] };

export const PART_KINDS = ["hardware", "component", "cable", "other"] as const satisfies readonly TeardownPartKind[];

export const LIMITS = { title: 120, instruction: 2000, callout: 300, partName: 120, qty: 100_000 } as const;

// ---- Small parsers ----------------------------------------------------------

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Shorten at a word boundary, marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Seconds from a number or a string: 83.2, "83.2", "83.2s", "1:23", "1:23.5",
 * "01:02:03". Null for anything else, and for negatives.
 */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s*(s|sec|secs|seconds)$/i, "");
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null;
  return h * 3600 + min * 60 + sec;
}

/** "m:ss" under an hour, "h:mm:ss" beyond. */
export function formatClock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/** A count from a number, "14", "14x", "x14", "fourteen" or "a dozen". Defaults to 1. */
export function parseQty(v: unknown): number {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v;
  else if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    const digits = s.match(/\d+(\.\d+)?/);
    if (digits) n = Number(digits[0]);
    else {
      const word = s.replace(/^(a|an)\s+/, "").split(/[\s-]+/)[0] ?? "";
      n = NUMBER_WORDS[word] ?? NUMBER_WORDS[s] ?? null;
    }
  }
  if (n === null || n < 1) return 1;
  return Math.min(LIMITS.qty, Math.round(n));
}

const HARDWARE =
  /\b(screws?|bolts?|nuts?|washers?|pins?|clips?|rivets?|dowels?|cam ?locks?|cams?|studs?|standoffs?|spacers?|anchors?|fasteners?|thumbscrews?|grommets?|hinges?|keys?|shims?|springs?|circlips?|e-?clips?|hardware)\b/i;
const CABLE = /\b(cables?|cords?|wires?|wiring|harness(es)?|leads?|hoses?|pigtails?|jumpers?|patch ?cords?|fib(er|re)s?)\b/i;

/**
 * One of hardware, component, cable or other. Takes the model's word when it
 * is one of those or a close synonym ("fastener", "furniture", "wire"), and
 * otherwise infers it from the part's name.
 */
export function normalizeKind(kind: unknown, name: string): TeardownPartKind {
  const k = clean(kind).toLowerCase();
  if ((PART_KINDS as readonly string[]).includes(k)) return k as TeardownPartKind;
  if (/^(fasteners?|screws?|bolts?|small parts?|hard ?ware)$/.test(k)) return "hardware";
  if (/^(furniture|panels?|assembl(y|ies)|modules?|components?|parts?|sub-?assembl(y|ies)|mechanical)$/.test(k)) {
    return "component";
  }
  if (/^(cables?|wires?|wiring|cords?|electrical|hoses?|harness(es)?)$/.test(k)) return "cable";
  if (CABLE.test(name)) return "cable";
  if (HARDWARE.test(name)) return "hardware";
  return k ? "other" : "component";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A title from the first sentence of some narration: filler lead-ins dropped,
 * and a long sentence cut back to its first clause ("Remove the four screws
 * holding the cover, and slide it off" gives "Remove the four screws holding
 * the cover"), or to its first words when it has no usable clause.
 */
function titleFrom(text: string, maxWords = 12): string {
  const first = text.split(/(?<=[.!?;])\s+/)[0] ?? text;
  const stripped = first
    .replace(/^(ok(ay)?|alright|all right|so|um+|uh+)[,.]?\s+/i, "")
    .replace(/^(and\s+)?(now|next|then|first|second|third|finally|lastly|after that)[,:]?\s+/i, "")
    .replace(/^(we'?re going to|we will|we'll|i'?m going to|i'll|you want to|go ahead and)\s+/i, "")
    .replace(/[.!?;:,]+$/, "")
    .trim();
  const words = stripped.split(/\s+/);
  let title = stripped;
  if (words.length > maxWords) {
    const clause = stripped.split(/,?\s+(?:and|then|so|but|while)\s+|[,;:]\s+/i)[0]?.trim() ?? "";
    const n = clause.split(/\s+/).length;
    title = n >= 3 && n <= maxWords ? clause : `${words.slice(0, maxWords).join(" ")}…`;
  }
  return clip(capitalize(title), LIMITS.title);
}

function cleanCallout(v: unknown): string | null {
  const parts = (Array.isArray(v) ? v : [v]).map(clean).filter((s) => s && !/^(none|n\/?a|null|no|-)$/i.test(s));
  return parts.length ? clip(parts.join("; "), LIMITS.callout) : null;
}

// ---- Windows and prompts ----------------------------------------------------

/**
 * Split a transcript into windows short enough for one model call each: the
 * chat helper waits ten seconds for an answer, and a reply covering a few
 * minutes of narration comfortably fits in that.
 */
export function windowSegments(
  segments: Segment[],
  opts: { maxChars?: number; maxSeconds?: number } = {},
): TranscriptWindow[] {
  const maxChars = opts.maxChars ?? 3500;
  const maxSeconds = opts.maxSeconds ?? 240;
  const windows: TranscriptWindow[] = [];
  let current: Segment[] = [];
  let chars = 0;
  const flush = () => {
    if (!current.length) return;
    windows.push({
      index: windows.length,
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      segments: current,
    });
    current = [];
    chars = 0;
  };
  for (const seg of segments) {
    const text = clean(seg.text);
    if (!text) continue;
    const first = current[0];
    if (first && (chars + text.length > maxChars || seg.end - first.start > maxSeconds)) flush();
    current.push({ start: seg.start, end: seg.end, text });
    chars += text.length + 1;
  }
  flush();
  return windows;
}

/**
 * Pseudo-segments for a transcript that came back without timestamps: its
 * sentences, all at time zero, so windowing still bounds the prompt size.
 */
export function untimedSegments(text: string): Segment[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ start: 0, end: 0, text: t }));
}

export const STEPS_SYSTEM = [
  "You turn a technician's narration, recorded while taking equipment apart, into a disassembly guide that another crew can follow backwards to reassemble it.",
  "Reply with one JSON object and nothing else, shaped exactly like:",
  '{"steps":[{"n":1,"title":"Remove the side panels","instruction":"Undo the four M6 bolts on each side and lift both panels off.","start":12.5,"end":41.0,"callout":"8 bolts total; the left panel has the ground strap"}],',
  '"parts":[{"name":"M6 bolt","kind":"hardware","qty":8,"stepN":1},{"name":"Side panel","kind":"component","qty":2,"stepN":1}]}',
  "Rules:",
  "- One step per distinct physical action, in the order they happened. Titles are short imperatives. Instructions say exactly what to do, in the narrator's terms.",
  "- start and end are seconds taken from the timestamps of the lines the step came from.",
  "- callout: counts, warnings, orientation, labels to add, anything easy to get wrong at reassembly. null when there is none.",
  "- parts: everything detached, with kind one of hardware (screws, bolts, nuts, washers, clips, pins, cam locks), component (panels, shelves, doors, modules, drives, furniture pieces), cable (cables, cords, wires, hoses) or other; qty as a number; stepN the step it came off in.",
  "- Use only what the narration says. Do not invent parts, counts or steps. Skip chatter that is not an action.",
].join("\n");

export type StepsPromptInput = {
  window: TranscriptWindow;
  windowCount: number;
  /** Steps already written from earlier windows. */
  stepsBefore: number;
  lastStepTitle?: string | null;
  /** Part names already listed, so the model keeps names consistent. */
  partsSoFar?: string[];
  /** "Dell PowerEdge R740 (server rack)" */
  equipment?: string | null;
  timed: boolean;
};

export function buildStepsPrompt(input: StepsPromptInput): string {
  const lines: string[] = [];
  if (input.equipment) lines.push(`Equipment: ${clip(input.equipment, 200)}`);
  if (input.windowCount > 1) {
    lines.push(`This is part ${input.window.index + 1} of ${input.windowCount} of the narration.`);
  }
  if (input.stepsBefore > 0) {
    lines.push(
      `Earlier parts already produced ${input.stepsBefore} step${input.stepsBefore === 1 ? "" : "s"}` +
        (input.lastStepTitle ? `, the last being "${clip(input.lastStepTitle, 120)}"` : "") +
        ". Number your steps from 1; they will be appended.",
    );
  }
  const names = [...new Set(input.partsSoFar ?? [])].slice(0, 60);
  if (names.length) lines.push(`Parts already listed (reuse these names for the same parts): ${names.join(", ")}`);
  if (input.timed) {
    lines.push("Narration, one line per segment as [start-end seconds] text:");
    for (const s of input.window.segments) lines.push(`[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
  } else {
    lines.push("Narration (no timestamps are available; use null for start and end):");
    lines.push(input.window.segments.map((s) => s.text).join(" "));
  }
  return lines.join("\n");
}

// ---- Normalizing a model's reply ------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const firstOf = (o: Obj, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const stepNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/\d+/);
    if (m) return Number(m[0]);
  }
  return null;
};

function normalizeTimes(
  rawStart: unknown,
  rawEnd: unknown,
  bounds: { start: number; end: number } | null,
): { start: number | null; end: number | null } {
  if (!bounds) return { start: null, end: null };
  const clamp = (t: number | null) => (t === null ? null : Math.min(bounds.end, Math.max(bounds.start, t)));
  // A little slack either side: segment edges are approximate.
  const within = (t: number | null) => t !== null && t >= bounds.start - 5 && t <= bounds.end + 5;
  let start = parseTimestamp(rawStart);
  let end = parseTimestamp(rawEnd);
  if (!within(start)) start = null;
  if (!within(end)) end = null;
  start = clamp(start);
  end = clamp(end);
  if (start !== null && end !== null && end < start) end = null;
  return { start, end };
}

function normalizePart(raw: unknown, step: number | null): PartDraft | null {
  if (typeof raw === "string") raw = { name: raw };
  if (!isObj(raw)) return null;
  const name = clip(clean(firstOf(raw, ["name", "part", "item", "label"])), LIMITS.partName);
  if (!name) return null;
  return {
    name: capitalize(name),
    kind: normalizeKind(firstOf(raw, ["kind", "type", "category", "tag"]), name),
    qty: parseQty(firstOf(raw, ["qty", "quantity", "count", "number"])),
    step,
  };
}

/**
 * The steps and parts in one model reply, cleaned up: titles and instructions
 * filled from each other, timestamps parsed and kept inside the window they
 * came from (or dropped when they plainly are not), steps put in time order,
 * and each part tied to the step it names. Null when the reply holds nothing
 * usable, which callers treat like no reply at all.
 *
 * `bounds` is the stretch of video the window covered; pass null when the
 * transcript had no timestamps, and every time is dropped.
 */
export function normalizeStepsReply(raw: unknown, bounds: { start: number; end: number } | null): Draft | null {
  if (!isObj(raw)) return null;
  const root = isObj(raw.guide) ? raw.guide : raw;
  const rawSteps = firstOf(root, ["steps", "Steps"]);
  const rawParts = firstOf(root, ["parts", "partsDetached", "parts_detached", "Parts"]);

  type Tmp = StepDraft & { n: number | null; order: number; nested: unknown[] };
  const steps: Tmp[] = [];
  (Array.isArray(rawSteps) ? rawSteps : []).forEach((s, i) => {
    if (typeof s === "string") s = { instruction: s };
    if (!isObj(s)) return;
    let instruction = clip(clean(firstOf(s, ["instruction", "instructions", "description", "text", "detail", "details"])), LIMITS.instruction);
    let title = capitalize(clip(clean(firstOf(s, ["title", "name", "summary", "action"])), LIMITS.title));
    if (!title && !instruction) return;
    if (!title) title = titleFrom(instruction);
    if (!instruction) instruction = title;
    const { start, end } = normalizeTimes(
      firstOf(s, ["start", "startSec", "start_sec", "from", "startTime"]),
      firstOf(s, ["end", "endSec", "end_sec", "to", "endTime"]),
      bounds,
    );
    const nested = firstOf(s, ["parts", "partsDetached", "parts_detached"]);
    steps.push({
      n: stepNumber(firstOf(s, ["n", "number", "step", "stepN"])) ?? i + 1,
      order: i,
      title,
      instruction,
      start,
      end,
      callout: cleanCallout(firstOf(s, ["callout", "callouts", "warning", "note", "notes"])),
      nested: Array.isArray(nested) ? nested : [],
    });
  });

  // Models occasionally list steps out of order; the timestamps are the
  // better witness when every step has one.
  if (steps.length > 1 && steps.every((s) => s.start !== null)) {
    steps.sort((a, b) => a.start! - b.start! || a.order - b.order);
  }
  const indexOfN = new Map<number, number>();
  steps.forEach((s, i) => {
    if (s.n !== null && !indexOfN.has(s.n)) indexOfN.set(s.n, i + 1);
  });

  const parts: PartDraft[] = [];
  steps.forEach((s, i) => {
    for (const p of s.nested) {
      const part = normalizePart(p, i + 1);
      if (part) parts.push(part);
    }
  });
  for (const p of Array.isArray(rawParts) ? rawParts : []) {
    const n = isObj(p) ? stepNumber(firstOf(p, ["stepN", "step", "step_n", "stepNumber", "fromStep"])) : null;
    const part = normalizePart(p, n !== null ? (indexOfN.get(n) ?? null) : null);
    if (part) parts.push(part);
  }

  if (!steps.length && !parts.length) return null;
  return {
    steps: steps.map(({ title, instruction, start, end, callout }) => ({ title, instruction, start, end, callout })),
    parts,
  };
}

/** Append one window's draft to the guide's, renumbering its parts' steps. */
export function appendDraft(into: Draft, add: Draft): Draft {
  const offset = into.steps.length;
  return {
    steps: [...into.steps, ...add.steps],
    parts: [...into.parts, ...add.parts.map((p) => ({ ...p, step: p.step === null ? null : p.step + offset }))],
  };
}

// ---- Without a language model -----------------------------------------------------

const CUE = /^(ok(ay)?[,.]?\s+|alright[,.]?\s+|and\s+)?(next|then|now|after that|first|second|third|finally|lastly|step \w+)\b/i;
const CALLOUT_WORDS =
  /\b(careful|caution|warning|watch out|make sure|be sure|note|remember|don'?t|do not|never|heavy|sharp|fragile|total|label|mark|keep track|orientation|this way up)\b/i;

const COUNT = "\\d{1,4}|a dozen|dozen|a pair of|a couple of|" + Object.keys(NUMBER_WORDS).filter((w) => !["a", "an", "single", "pair", "couple", "dozen"].includes(w)).join("|");
const NOUN =
  "cam locks?|thumbscrews?|screws?|bolts?|nuts?|washers?|pins?|clips?|rivets?|dowels?|cams?|standoffs?|spacers?|brackets?|hinges?|anchors?|" +
  "cables?|wires?|cords?|hoses?|panels?|shelves|shelf|doors?|drawers?|legs?|feet|fans?|drives?|caddy|caddies|sleds?|trays?|" +
  "modules?|cards?|covers?|rails?|batteries|battery|power supplies|power supply|psus?";
// Up to two words before the noun ("four M4 screws", "six standoff screws"),
// matched greedily so the longest name wins. A word may hold a decimal
// ("2.5mm") but not a sentence's full stop.
const PART_MENTION = new RegExp(`\\b(${COUNT})\\s+(?:x\\s+)?((?:[a-z0-9][\\w/-]*(?:\\.\\d+)?\\s+){0,2})(${NOUN})\\b`, "gi");
const NOT_MODIFIER = /^(the|of|more|other|small|little|big|of the|on|in|from)$/i;

function singular(noun: string): string {
  const n = noun.toLowerCase();
  if (n === "feet") return "foot";
  if (n === "shelves") return "shelf";
  if (n === "batteries") return "battery";
  if (n === "power supplies") return "power supply";
  if (/(ss|us)$/.test(n)) return noun;
  if (/ies$/.test(n)) return noun.replace(/ies$/i, "y");
  return noun.replace(/s$/i, "");
}

/** Counted parts mentioned in one stretch of narration: "the four M6 screws". */
export function partsMentioned(text: string): { name: string; qty: number; kind: TeardownPartKind }[] {
  const found: { name: string; qty: number; kind: TeardownPartKind }[] = [];
  for (const m of text.matchAll(PART_MENTION)) {
    const qty = parseQty(m[1]!.replace(/^(a|an)\s+/i, "").replace(/\s+of$/i, ""));
    const modifiers = (m[2] ?? "")
      .trim()
      .split(/\s+/)
      .filter((w) => w && !NOT_MODIFIER.test(w));
    const noun = singular(m[3]!);
    const name = [...modifiers, noun].join(" ");
    found.push({ name: name.charAt(0).toUpperCase() + name.slice(1), qty, kind: normalizeKind(null, noun) });
  }
  return found;
}

/**
 * A draft built straight from the transcript, for when no language model is
 * configured or one did not answer: a new step wherever the narrator paused
 * or said "next", "then" or "now", warnings and counts as callouts, and
 * counted parts ("four screws") picked out of the words. Rougher than a
 * model's, but every step still carries its timestamps, so the video lines up.
 */
export function draftFromTranscript(segments: Segment[], opts: { timed?: boolean } = {}): Draft {
  const timed = opts.timed ?? true;
  const groups: Segment[][] = [];
  let current: Segment[] = [];
  let chars = 0;
  for (const seg of segments) {
    const text = clean(seg.text);
    if (!text) continue;
    const prev = current[current.length - 1];
    const pause = timed && prev ? seg.start - prev.end >= 2.5 : false;
    if (prev && (pause || CUE.test(text) || chars + text.length > 360)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push({ ...seg, text });
    chars += text.length + 1;
  }
  if (current.length) groups.push(current);

  const draft: Draft = { steps: [], parts: [] };
  groups.forEach((group, i) => {
    const text = group.map((s) => s.text).join(" ");
    const sentences = text.split(/(?<=[.!?])\s+/);
    const callouts = sentences.filter((s) => CALLOUT_WORDS.test(s));
    draft.steps.push({
      title: titleFrom(text),
      instruction: clip(text, LIMITS.instruction),
      start: timed ? group[0]!.start : null,
      end: timed ? group[group.length - 1]!.end : null,
      callout: callouts.length ? clip(callouts.join(" "), LIMITS.callout) : null,
    });
    for (const p of partsMentioned(text)) draft.parts.push({ ...p, step: i + 1 });
  });
  return draft;
}

// ---- Refining part names from keyframes -------------------------------------

export const REFINE_SYSTEM =
  "You identify parts in stills taken while equipment was being taken apart. Reply with one JSON object and nothing else.";

export type RefineEntry = {
  stepN: number;
  stepTitle: string;
  parts: { id: string; name: string; kind: TeardownPartKind; qty: number }[];
};

/** One photo per entry, in the same order as the entries. */
export function buildRefinePrompt(entries: RefineEntry[], equipment?: string | null): string {
  const lines = [
    ...(equipment ? [`Equipment: ${clip(equipment, 200)}`] : []),
    "Each photo is a still from the step named below, in the same order. For each part listed, give the most specific name the photo supports, such as \"M6 hex bolt\", \"cam lock nut\" or \"SATA data cable\", and its kind: hardware, component, cable or other.",
    "Keep the name as given when the photo does not clearly show the part. Do not add parts or change quantities.",
    'Reply exactly as {"parts":[{"id":"p1","name":"M6 hex bolt","kind":"hardware"}]}',
    "",
  ];
  entries.forEach((e, i) => {
    lines.push(`Photo ${i + 1}: step ${e.stepN}, "${clip(e.stepTitle, 120)}"`);
    for (const p of e.parts) lines.push(`  ${p.id}: ${p.name} (${p.kind}, qty ${p.qty})`);
  });
  return lines.join("\n");
}

/**
 * The renames a refine reply proposes, keyed by part id: only for ids that
 * were asked about, only with a non-empty name, and only where something
 * actually changes. The kind is taken only when it is one of the four.
 */
export function normalizeRefineReply(
  raw: unknown,
  asked: Map<string, { name: string; kind: TeardownPartKind }>,
): Map<string, { name: string; kind: TeardownPartKind }> {
  const out = new Map<string, { name: string; kind: TeardownPartKind }>();
  if (!isObj(raw) || !Array.isArray(raw.parts)) return out;
  for (const p of raw.parts) {
    if (!isObj(p)) continue;
    const id = clean(p.id);
    const before = asked.get(id);
    if (!before) continue;
    const named = clip(clean(p.name), LIMITS.partName);
    const name = named ? named.charAt(0).toUpperCase() + named.slice(1) : before.name;
    const k = clean(p.kind).toLowerCase();
    const kind = (PART_KINDS as readonly string[]).includes(k) ? (k as TeardownPartKind) : before.kind;
    if (name.toLowerCase() !== before.name.toLowerCase() || kind !== before.kind) out.set(id, { name, kind });
  }
  return out;
}
