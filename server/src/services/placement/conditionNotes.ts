import { handlingNotesForRefs } from "../ai-condition";
import { getConfig } from "../config";
import { handlingKey, registerHandlingNotes } from "./handling";

/**
 * Handling notes from condition records and container captures ("Fragile ·
 * This side up. Handle with care to prevent further scratching."), on the
 * placement card and the kiosk, while that feature is switched on. A unit
 * gets its own latest report's note, or its item's.
 */
registerHandlingNotes("ai-condition", async (refs) => {
  const out = new Map<string, string[]>();
  if (!(await getConfig()).features.aiCondition) return out;
  const notes = await handlingNotesForRefs(refs);
  notes.forEach((note, i) => {
    if (note?.text) out.set(handlingKey(refs[i]!), [note.text]);
  });
  return out;
});
