import { handlingNotesForRefs } from "../ai-condition";
import { getConfig } from "../config";
import { registerManifestNotes } from "../jobs-core";

let wired = false;

/**
 * Condition capture and jobs were built side by side. This prints each line's
 * handling note ("Fragile · This side up. Handle with care…") under the item on
 * manifests and load sheets, while condition capture is switched on.
 */
export function wireHandlingNotes(): void {
  if (wired) return;
  wired = true;
  registerManifestNotes(async (refs) => {
    if (!(await getConfig()).features.aiCondition) return refs.map(() => null);
    const notes = await handlingNotesForRefs(refs);
    return notes.map((n) => n?.text || null);
  });
}
