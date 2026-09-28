import type { ConditionRating, Defect } from "../../db/tables/ai-condition";
import { CONTAINER_FLAGS, DEFECT_TYPES, RATINGS, SEVERITIES } from "./vocab";

/**
 * Prompts for the three vision calls. Built by functions rather than held as
 * constants because the size classes, categories and the organisation's own
 * note are settings. docs/ai-condition.md explains the choices made here.
 *
 * Every prompt names its fixed vocabularies literally and asks for one JSON
 * object; the normalizers map near misses back onto the vocabulary anyway,
 * because models drift ("Scuff" for scratch, "4/5" for good).
 */

const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

const withHint = (prompt: string, hint: string) =>
  hint.trim() ? `${prompt}\n\nNotes from the organisation using this system:\n${hint.trim()}` : prompt;

export const CONTAINER_SYSTEM =
  "You catalogue packed containers (boxes, totes, crates, pallets) from photos for a moving and warehouse inventory. " +
  "You transcribe writing exactly as written and never invent contents you cannot see or read. " +
  "Reply with one JSON object and nothing else.";

export function containerPrompt(opts: { sizeClasses: readonly string[]; categories: readonly string[]; hint: string }): string {
  return withHint(
    `The photos show one container: usually the outside, often with handwriting or a label, and sometimes the open top.
Reply with this JSON object:
{
  "sizeClass": the one of [${list(opts.sizeClasses)}] that best describes the container, or null if you cannot tell,
  "handwrittenText": every word written on the container by hand or marker, line by line, exactly as written, or null if there is none,
  "room": the room or area the writing says the container belongs in (such as "Kitchen" or "Office 3.14"), or null,
  "contentsSummary": a short phrase for what is inside, such as "Dinner plates and bowls", or null,
  "contents": [{
    "name": a short name for one kind of thing inside,
    "category": one of [${list(opts.categories)}], or null,
    "qty": a whole number, 1 if you cannot count them,
    "condition": one of [${list(RATINGS)}] if you can see it, else null,
    "fragile": true if it could break in handling,
    "description": colour, material or other detail that tells it apart, or null
  }],
  "flags": the handling marks written on the container or that clearly apply, from [${list(CONTAINER_FLAGS)}],
  "confidence": { "sizeClass": 0 to 1, "handwrittenText": 0 to 1, "room": 0 to 1, "contents": 0 to 1 }
}
List only contents you can see in an open container or read in the writing, one entry per kind of thing. Copy handwriting exactly; do not correct spelling. Lower a confidence when writing is faint, partly hidden or ambiguous. If the photos do not show a container, set every field to null and contents to [].`,
    opts.hint,
  );
}

export const ASSESS_SYSTEM =
  "You are a careful condition inspector documenting physical items for moving, storage and insurance records. " +
  "You describe only damage you can see in the photos and never guess at damage that is hidden. " +
  "Reply with one JSON object and nothing else.";

export function assessPrompt(opts: { itemName?: string | null; hint: string }): string {
  const what = opts.itemName ? `the item shown ("${opts.itemName.replace(/"/g, "'")}")` : "the item shown";
  return withHint(
    `Assess the condition of ${what}. Reply with this JSON object:
{
  "rating": one of "excellent" (like new, no visible wear), "good" (light wear only), "fair" (noticeable wear or minor damage), "poor" (heavy wear or several defects), "damaged" (broken, cracked, or not usable as it is),
  "summary": one or two plain sentences describing its overall condition,
  "defects": [{
    "area": where on the item, as specific as you can ("top left corner of the lid", "rear right leg"),
    "type": one of [${list(DEFECT_TYPES)}],
    "severity": one of [${list(SEVERITIES)}],
    "description": what it looks like, in a few words
  }],
  "handlingNote": one short instruction for the crew who will move it, written to prevent further damage (such as "Handle with care to prevent further scratching of the lid"), or null if it needs no special handling,
  "confidence": 0 to 1 for the assessment as a whole
}
List each distinct defect once. Use [] when no defects are visible. Do not report reflections, shadows, dust or packaging as damage.`,
    opts.hint,
  );
}

export const COMPARE_SYSTEM =
  "You compare photos of the same item taken at two different times to find damage that appeared in between. " +
  "You report only differences you can see, and you ignore changes in lighting, angle, framing and background. " +
  "Reply with one JSON object and nothing else.";

export function comparePrompt(opts: {
  beforeCount: number;
  afterCount: number;
  beforeLabel: string;
  afterLabel: string;
  beforeDefects: Defect[];
  beforeRating: ConditionRating | null;
  itemName?: string | null;
  hint: string;
}): string {
  const recorded = opts.beforeDefects.length
    ? JSON.stringify(opts.beforeDefects.map((d) => ({ area: d.area, type: d.type, severity: d.severity })))
    : "none";
  const what = opts.itemName ? ` of "${opts.itemName.replace(/"/g, "'")}"` : "";
  return withHint(
    `The first ${opts.beforeCount} photo(s)${what} were taken BEFORE (${opts.beforeLabel}); the next ${opts.afterCount} were taken AFTER (${opts.afterLabel}).
Condition recorded before: ${opts.beforeRating ?? "not rated"}. Defects recorded before: ${recorded}.
Reply with this JSON object:
{
  "summary": one or two plain sentences on what changed, or that nothing did,
  "newDefects": [{ "area": where, "type": one of [${list(DEFECT_TYPES)}], "severity": one of [${list(SEVERITIES)}], "description": what it looks like }] for damage visible AFTER that was not there BEFORE,
  "resolvedDefects": the recorded defects, same shape, that are no longer visible,
  "ratingAfter": one of [${list(RATINGS)}] for the item as it is AFTER,
  "changed": true if there is any new damage
}
A defect already recorded before is not new, even if it is easier to see now. Use [] when there is nothing to list.`,
    opts.hint,
  );
}
