import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { opsApi } from "./api";
import type { SlottingResult } from "./types";
import { CARD, H2, Notice, errorText, metres } from "./ui";

/** Swap suggestions: fast movers far from the dock, slow movers near it. */
export function SlottingPanel({ onSetup }: { onSetup: () => void }) {
  const terms = useTerms();
  const [result, setResult] = useState<SlottingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    opsApi
      .slotting()
      .then(setResult)
      .catch((err) => setError(errorText(err, "Slotting suggestions could not be loaded.")));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!result) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <section className={`${CARD} space-y-2 text-sm text-slate-300`}>
        <h2 className={H2}>The rule</h2>
        <p>{result.rule}</p>
        <p className="text-xs text-slate-500">
          {result.cutoffM === null
            ? `No ${terms.location.singular.toLowerCase()} has a distance to the dock yet. `
            : `Median distance ${metres(result.cutoffM)} over ${result.considered} ${terms.item.plural.toLowerCase()}; ${result.withoutDistance} left out because their ${terms.location.singular.toLowerCase()} has no distance. `}
          <button onClick={onSetup} className="text-sky-400 hover:underline">
            Set distances under Setup
          </button>
          .
        </p>
      </section>

      {result.suggestions.length === 0 ? (
        <p className="text-sm text-slate-500">No suggestions: fast movers are already near the dock, or there is not enough movement to tell.</p>
      ) : (
        <ul className="space-y-2">
          {result.suggestions.map((s) => (
            <li key={`${s.fast.itemId}-${s.slow?.itemId ?? "none"}`} className={`${CARD} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                  {s.kind === "swap" ? "Swap" : "Move closer"}
                </span>
                <Link to={`/items/${s.fast.itemId}`} className="font-medium text-sky-400 hover:underline">
                  {s.fast.name}
                </Link>
                <span className="text-slate-400">
                  {s.fast.locationPath} · {metres(s.fast.distanceToDockM)}
                </span>
                {s.slow && (
                  <>
                    <span className="text-slate-500" aria-hidden="true">
                      ⇄
                    </span>
                    <Link to={`/items/${s.slow.itemId}`} className="font-medium text-sky-400 hover:underline">
                      {s.slow.name}
                    </Link>
                    <span className="text-slate-400">
                      {s.slow.locationPath} · {metres(s.slow.distanceToDockM)}
                    </span>
                  </>
                )}
                {s.savedMPerMonth !== null && (
                  <span className="ml-auto text-xs tabular-nums text-slate-400">saves about {metres(s.savedMPerMonth)} a month</span>
                )}
              </div>
              <p className="text-sm text-slate-400">{s.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
