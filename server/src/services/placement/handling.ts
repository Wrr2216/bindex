import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * Handling notes on the placement card ("fragile, this side up", "handle with
 * care to prevent further scratching"). Placement does not write them; a
 * feature that does (AI condition records) registers a provider when its
 * module loads:
 *
 *   registerHandlingNotes("condition", async (refs) => new Map([[handlingKey(ref), ["Fragile"]]]))
 *
 * A provider that throws is logged and skipped: a missing note must never
 * stop a crew from finding out where a box goes.
 */

export type AssetRef = { itemId: string; unitId: string | null };
export type HandlingNotesProvider = (refs: AssetRef[]) => Promise<Map<string, string[]>> | Map<string, string[]>;

/** The key a provider's map uses for one item or unit. */
export const handlingKey = (ref: AssetRef) => `${ref.itemId}:${ref.unitId ?? ""}`;

const providers = new Map<string, HandlingNotesProvider>();

/** Register (or replace) a named provider. Returns a function that removes it. */
export function registerHandlingNotes(name: string, provider: HandlingNotesProvider): () => void {
  providers.set(name, provider);
  return () => {
    if (providers.get(name) === provider) providers.delete(name);
  };
}

/**
 * Every provider's notes for these assets, merged and de-duplicated. A unit
 * also gets the notes about its item as a whole.
 */
export async function handlingNotesFor(refs: AssetRef[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!refs.length || !providers.size) return out;
  const asked = [...new Map(refs.flatMap((r) => [r, { itemId: r.itemId, unitId: null }]).map((r) => [handlingKey(r), r])).values()];
  for (const [name, provider] of providers) {
    try {
      const notes = await provider(asked);
      for (const ref of refs) {
        const merged = out.get(handlingKey(ref)) ?? [];
        for (const key of new Set([handlingKey(ref), handlingKey({ itemId: ref.itemId, unitId: null })])) {
          for (const n of notes.get(key) ?? []) if (n.trim() && !merged.includes(n.trim())) merged.push(n.trim());
        }
        if (merged.length) out.set(handlingKey(ref), merged);
      }
    } catch (err) {
      logger.warn("placement.handling.failed", { provider: name, err: describeError(err) });
    }
  }
  return out;
}
