import { useEffect, useState } from "react";
import { AlertIcon } from "../../components/icons";
import { conditionApi } from "./api";
import type { HandlingNote } from "./types";
import { FLAG_LABEL, RatingBadge, useConditionEnabled } from "./vocab";

/** The handling note for one item, or null while loading or when there is none. */
export function useHandlingNote(itemId: string, refreshKey?: unknown): HandlingNote | null {
  const enabled = useConditionEnabled();
  const [note, setNote] = useState<HandlingNote | null>(null);
  useEffect(() => {
    setNote(null);
    if (!enabled) return;
    let live = true;
    conditionApi
      .handling([itemId])
      .then((r) => live && setNote(r.notes[itemId] ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, itemId, refreshKey]);
  return note;
}

/**
 * How to handle an item: its marks (Fragile, This side up), a poor rating,
 * and the note from its latest condition report. For the scan overlay, the
 * item page and placement cards. Renders nothing when there is nothing to say
 * or the feature is off.
 */
export function HandlingNoteBanner({ itemId, refreshKey, compact = false }: { itemId: string; refreshKey?: unknown; compact?: boolean }) {
  const note = useHandlingNote(itemId, refreshKey);
  if (!note || (!note.note && !note.flags.length && note.rating !== "poor" && note.rating !== "damaged")) return null;
  return (
    <div
      role="note"
      aria-label="Handling"
      className={`flex items-start gap-2 rounded-xl border border-amber-700/70 bg-amber-950/50 text-amber-100 ${compact ? "px-3 py-2" : "p-3"}`}
    >
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0 space-y-1">
        {(note.flags.length > 0 || note.rating === "poor" || note.rating === "damaged") && (
          <div className="flex flex-wrap items-center gap-1">
            {note.flags.map((f) => (
              <span key={f} className="rounded-full bg-amber-600 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
                {FLAG_LABEL[f]}
              </span>
            ))}
            {(note.rating === "poor" || note.rating === "damaged") && <RatingBadge rating={note.rating} />}
          </div>
        )}
        {note.note && <p className={compact ? "text-sm" : "text-sm font-medium"}>{note.note}</p>}
      </div>
    </div>
  );
}
