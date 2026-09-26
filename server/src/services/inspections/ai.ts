import type { FindingArea, FindingSeverity, InspectionKind } from "../../db/schema";
import { chatJson, visionJson, type VisionImage } from "../ai";
import { SPOTS, type Spot } from "./model";
import { normalizeRoom, type PairingFinding } from "./pairing";

/**
 * The two places inspections ask a model for help, and the pure functions that
 * turn whatever it answers into something safe to show a person.
 *
 * - Reading damage from one photo: room, spot, description and severity, all
 *   editable before anything is saved.
 * - Matching the findings the room-and-spot rule could not pair ("Boardroom"
 *   before, "Conference room" after), as a suggestion stored on the finding.
 *
 * Both return null when no model is configured or it fails, and the screens
 * carry on by hand.
 */

export type KnownRoom = { name: string; locationId: string | null };

export type DamageSuggestion = {
  /** False when the model saw nothing worth recording. The other fields may still be filled. */
  damage: boolean;
  area: FindingArea | null;
  room: string | null;
  /** Set when the room matched one of the site's known rooms. */
  locationId: string | null;
  spot: Spot;
  spotDetail: string | null;
  description: string | null;
  severity: FindingSeverity | null;
  /** 0 to 1, or null when the model gave none. */
  confidence: number | null;
};

export type AiMatch = { pre: number; post: number; confidence: number | null };

// ---- Shared cleaning ---------------------------------------------------------

const PLACEHOLDER = new Set(["", "n/a", "na", "none", "null", "unknown", "-", "--", "?", "not visible", "unclear"]);

/** A trimmed single-line string, or null for blanks and placeholders. */
export function cleanText(v: unknown, max = 200): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (PLACEHOLDER.has(s.toLowerCase())) return null;
  return s.slice(0, max);
}

/** A model's confidence in whatever form it chose: 0.9, 90, "90%", "high". */
export function confidence(v: unknown): number | null {
  if (typeof v === "string") {
    const word = v.trim().toLowerCase();
    if (word === "high") return 0.9;
    if (word === "medium") return 0.6;
    if (word === "low") return 0.3;
    v = Number(word.replace(/%$/, ""));
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if (v > 1 && v <= 100) return v / 100;
  return v <= 1 ? v : null;
}

function yes(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y"].includes(s)) return true;
    if (["false", "no", "n"].includes(s)) return false;
  }
  return null;
}

// ---- Reading damage from a photo ----------------------------------------------

const SPOT_WORDS: [RegExp, Spot][] = [
  [/\b(dock|loading bay|leveller|leveler|bumper)\b/, "dock"],
  [/\b(elevator|lift)\b/, "elevator"],
  [/\b(stair|stairs|staircase|stairwell|steps?|landing|handrail|banister)\b/, "stairs"],
  [/\b(baseboards?|skirting( boards?)?|kick ?plates?)\b/, "baseboard"],
  [/\b(frames?|jambs?|casings?|door ?frames?|window ?frames?)\b/, "frame"],
  [/\b(trim|moulding|molding|architrave|chair rail|crown)\b/, "trim"],
  [/\b(ceilings?|ceiling tiles?)\b/, "ceiling"],
  [/\b(windows?|glass|glazing|sills?|panes?)\b/, "window"],
  [/\b(doors?|doorways?|gates?|shutters?|roller doors?)\b/, "door"],
  [/\b(floors?|flooring|carpet|tiles?|laminate|hardwood|vinyl|concrete|threshold)\b/, "floor"],
  // Before walls, so a "wall socket" is the socket.
  [/\b(fixtures?|light fixtures?|lighting|outlets?|sockets?|switch(es)?|sinks?|radiators?|vents?|sprinklers?|signage)\b/, "fixture"],
  [/\b(walls?|drywall|plaster|partition|column|pillar)\b/, "wall"],
];

/** Whatever the model called the spot, as one of SPOTS. Unknown words become "other". */
export function normalizeSpot(v: unknown): Spot {
  const s = cleanText(v, 80)?.toLowerCase();
  if (!s) return "other";
  const exact = s.replace(/\s+/g, "_");
  if ((SPOTS as readonly string[]).includes(exact)) return exact as Spot;
  for (const [re, spot] of SPOT_WORDS) if (re.test(s)) return spot;
  return "other";
}

export function normalizeSeverity(v: unknown): FindingSeverity | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 1) return "minor";
    if (v <= 2) return "moderate";
    return "major";
  }
  const s = cleanText(v, 40)?.toLowerCase();
  if (!s) return null;
  if (/\b(minor|low|light|cosmetic|slight|superficial|small)\b/.test(s)) return "minor";
  if (/\b(moderate|medium|mid|noticeable)\b/.test(s)) return "moderate";
  if (/\b(major|high|severe|serious|critical|significant|structural|heavy)\b/.test(s)) return "major";
  return null;
}

export function normalizeArea(v: unknown): FindingArea | null {
  const s = cleanText(v, 40)?.toLowerCase();
  if (!s) return null;
  if (/\b(inside|interior|indoors?|internal)\b/.test(s)) return "inside";
  if (/\b(outside|exterior|outdoors?|external)\b/.test(s)) return "outside";
  return null;
}

/**
 * Snap a room the model named to one of the site's known rooms, so the same
 * room is spelled the same way in the pre- and post-inspection and the two
 * pair up. Matches the whole path or its last level, and only when exactly one
 * known room does.
 */
export function matchKnownRoom(room: string | null, known: KnownRoom[]): KnownRoom | null {
  if (!room) return null;
  const want = normalizeRoom(room);
  if (!want) return null;
  const whole = known.filter((k) => normalizeRoom(k.name) === want);
  if (whole.length === 1) return whole[0]!;
  if (whole.length > 1) return null;
  const last = known.filter((k) => normalizeRoom(k.name.split(/\s*[/>]\s*/).pop() ?? k.name) === want);
  return last.length === 1 ? last[0]! : null;
}

export function normalizeDamageReading(raw: unknown, known: KnownRoom[] = []): DamageSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Some models wrap the answer: { "finding": { ... } } or { "result": { ... } }.
  let r = raw as Record<string, unknown>;
  for (const key of ["finding", "result", "damage_report", "inspection"]) {
    const inner = r[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) r = inner as Record<string, unknown>;
  }

  const description = cleanText(r.description ?? r.summary ?? r.details, 1000);
  const roomText = cleanText(r.room ?? r.location ?? r.place, 120);
  const matched = matchKnownRoom(roomText, known);
  const flagged = yes(r.damage ?? r.damaged ?? r.hasDamage ?? r.has_damage);
  const suggestion: DamageSuggestion = {
    damage: flagged ?? Boolean(description),
    area: normalizeArea(r.area ?? r.inside_outside ?? r.setting),
    room: matched?.name ?? roomText,
    locationId: matched?.locationId ?? null,
    spot: normalizeSpot(r.spot ?? r.surface ?? r.element),
    spotDetail: cleanText(r.spotDetail ?? r.spot_detail ?? r.position ?? r.exactSpot, 200),
    description,
    severity: normalizeSeverity(r.severity),
    confidence: confidence(r.confidence),
  };
  const anything =
    suggestion.description || suggestion.room || suggestion.area || suggestion.severity || suggestion.spot !== "other";
  return anything || flagged === false ? suggestion : null;
}

export const DAMAGE_SYSTEM =
  "You inspect buildings for damage before and after a move: walls, floors, doors, trim, dock doors, elevators and " +
  "stairs. From one photo you say where the damage is and describe it plainly, as a surveyor would. " +
  "You describe only what is visible and never guess at causes. Reply with one JSON object and nothing else.";

export function damagePrompt(opts: { kind: InspectionKind; siteName: string; knownRooms: KnownRoom[] }): string {
  const rooms = opts.knownRooms.slice(0, 80).map((r) => r.name);
  const when = opts.kind === "pre" ? "before a move" : opts.kind === "post" ? "after a move" : "during a site inspection";
  return `This photo was taken at ${opts.siteName} ${when}. Reply with this JSON object:
{
  "damage": true if the photo shows damage, wear or a defect worth recording, false if it shows none,
  "area": "inside" or "outside",
  "room": the room or place, such as "Kitchen", "Main corridor" or "Loading dock 2"${
    rooms.length ? `; use one of these known rooms when it fits: ${rooms.map((r) => JSON.stringify(r)).join(", ")}` : ""
  }; null if you cannot tell,
  "spot": one of ${SPOTS.map((s) => `"${s}"`).join(", ")},
  "spotDetail": where exactly on that spot, such as "left of the door, about 1 m up", or null,
  "description": one or two plain sentences saying what the damage is, its size and what it looks like, such as "Two scuff marks and a 5 cm gouge in the paint.",
  "severity": "minor" (cosmetic: scuffs, marks, light scratches), "moderate" (needs repair: dents, gouges, chips, cracked tiles) or "major" (holes, broken glass, water damage, a door that will not close, anything unsafe),
  "confidence": a number from 0 to 1 for how sure you are of the room and spot
}`;
}

/** One photo in, a suggested finding out. Null when no model is configured or it failed. */
export async function readDamage(
  image: VisionImage,
  opts: { kind: InspectionKind; siteName: string; knownRooms: KnownRoom[]; context?: Record<string, unknown> },
): Promise<DamageSuggestion | null> {
  const raw = await visionJson({
    event: "ai.inspection_damage",
    system: DAMAGE_SYSTEM,
    prompt: damagePrompt(opts),
    images: [image],
    maxTokens: 600,
    context: opts.context,
  });
  return raw ? normalizeDamageReading(raw, opts.knownRooms) : null;
}

// ---- Matching findings -------------------------------------------------------

/** Below this, a proposed pair is left for a person to decide. */
export const MATCH_MIN_CONFIDENCE = 0.6;
const MAX_MATCH_FINDINGS = 60;

const findingLine = (tag: string, f: PairingFinding & { area?: string }) =>
  `${tag}. ${[
    f.area ? `area: ${f.area}` : null,
    `room: ${f.room}`,
    `spot: ${f.spot}${f.spotDetail ? ` (${f.spotDetail})` : ""}`,
    `severity: ${f.severity}`,
  ]
    .filter(Boolean)
    .join("; ")}; "${f.description.replace(/\s+/g, " ").slice(0, 300)}"`;

export const MATCH_SYSTEM =
  "You compare building inspection findings recorded before and after a move and decide which of them describe the " +
  "same damage in the same place. Rooms and spots may be named differently by different inspectors. " +
  "Reply with one JSON object and nothing else.";

export function matchPrompt(pre: PairingFinding[], post: PairingFinding[]): string {
  return `Before the move (pre-inspection):
${pre.map((f, i) => findingLine(`P${i + 1}`, f)).join("\n")}

After the move (post-inspection):
${post.map((f, i) => findingLine(`Q${i + 1}`, f)).join("\n")}

Reply with {"matches": [{"pre": "P1", "post": "Q2", "confidence": 0.8}]}, listing only pairs that describe the same damage in the same place, even when the room is named differently (Boardroom and Conference room) or the spot differently (trim and baseboard). A finding may appear in at most one pair. Leave out anything without a counterpart; an empty list is a fine answer.`;
}

const refIndex = (v: unknown, letter: "p" | "q", count: number): number | null => {
  let n: number | null = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string") {
    const m = new RegExp(`^\\s*${letter}?\\s*#?\\s*(\\d+)\\s*$`, "i").exec(v);
    if (m) n = Number(m[1]);
  }
  return n !== null && n >= 1 && n <= count ? n - 1 : null;
};

/**
 * The model's pairs as indexes into the lists it was shown: references it made
 * up are dropped, each finding is used once (the most confident pair wins),
 * and pairs under MATCH_MIN_CONFIDENCE are left out. A pair without a
 * confidence is kept; the person can still undo it.
 */
export function normalizeAiMatches(raw: unknown, preCount: number, postCount: number): AiMatch[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).matches ?? (raw as Record<string, unknown>).pairs;
  if (!Array.isArray(list)) return [];
  const proposed: AiMatch[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const pre = refIndex(e.pre ?? e.before, "p", preCount);
    const post = refIndex(e.post ?? e.after, "q", postCount);
    if (pre === null || post === null) continue;
    const c = e.confidence === undefined || e.confidence === null ? null : confidence(e.confidence);
    if (c !== null && c < MATCH_MIN_CONFIDENCE) continue;
    proposed.push({ pre, post, confidence: c });
  }
  proposed.sort((a, b) => (b.confidence ?? 0.7) - (a.confidence ?? 0.7));
  const usedPre = new Set<number>();
  const usedPost = new Set<number>();
  const out: AiMatch[] = [];
  for (const m of proposed) {
    if (usedPre.has(m.pre) || usedPost.has(m.post)) continue;
    usedPre.add(m.pre);
    usedPost.add(m.post);
    out.push(m);
  }
  return out;
}

/**
 * Ask a language model which unmatched findings are the same damage. Returns
 * [pre id, post id] pairs, an empty list when it found none, or null when no
 * model is configured or it failed.
 */
export async function matchWithAi<F extends PairingFinding>(
  pre: F[],
  post: F[],
  context?: Record<string, unknown>,
): Promise<{ preId: string; postId: string; confidence: number | null }[] | null> {
  const p = pre.slice(0, MAX_MATCH_FINDINGS);
  const q = post.slice(0, MAX_MATCH_FINDINGS);
  if (!p.length || !q.length) return [];
  const raw = await chatJson({
    event: "ai.inspection_match",
    system: MATCH_SYSTEM,
    user: matchPrompt(p, q),
    maxTokens: 800,
    context,
  });
  if (!raw) return null;
  return normalizeAiMatches(raw, p.length, q.length).map((m) => ({
    preId: p[m.pre]!.id,
    postId: q[m.post]!.id,
    confidence: m.confidence,
  }));
}
