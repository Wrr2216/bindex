import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";

/**
 * Per-line notes other features print under an item on manifests and load
 * sheets, such as handling instructions. A provider answers for every ref in
 * order, with null where it has nothing to say. A provider that fails is
 * logged and skipped, so a note never stops a manifest from printing.
 */
export type ManifestNoteRef = { itemId: string; unitId: string | null };
export type ManifestNoteProvider = (refs: ManifestNoteRef[]) => Promise<(string | null)[]>;

const providers: ManifestNoteProvider[] = [];

export function registerManifestNotes(provider: ManifestNoteProvider): void {
  providers.push(provider);
}

export async function manifestNotesFor(refs: ManifestNoteRef[]): Promise<(string | null)[]> {
  const out: (string | null)[] = refs.map(() => null);
  if (!refs.length) return out;
  for (const provider of providers) {
    try {
      const notes = await provider(refs);
      notes.forEach((n, i) => {
        if (i < out.length && n) out[i] = out[i] ? `${out[i]}  ·  ${n}` : n;
      });
    } catch (err) {
      logger.warn("jobs.manifest_notes.failed", { err: describeError(err) });
    }
  }
  return out;
}
