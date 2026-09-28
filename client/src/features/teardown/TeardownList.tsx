import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SearchIcon } from "../../components/icons";
import { useTerms } from "../../config/useConfig";
import { teardownApi } from "./api";
import { errorMessage } from "./format";
import { StatusPill } from "./TeardownSection";
import type { GuideSummary } from "./types";

/** Every teardown guide, most recently changed first, with a search. */
export function TeardownList() {
  const terms = useTerms();
  const [q, setQ] = useState("");
  const [guides, setGuides] = useState<GuideSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      teardownApi
        .list({ q: q.trim() || undefined })
        .then((list) => {
          setGuides(list);
          setError(null);
        })
        .catch((err) => setError(errorMessage(err, "Could not load the guides.")));
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Teardown guides</h1>
        <p className="mt-1 text-sm text-slate-400">
          Narrated teardown videos turned into numbered steps and parts lists, for putting things back together. Start one from a{" "}
          {terms.item.singular.toLowerCase()}'s page.
        </p>
      </div>
      <label className="relative block">
        <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search by guide or ${terms.item.singular.toLowerCase()}`}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {guides === null ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : guides.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          {q ? "No guide matches that." : `No teardown guides yet. Open a ${terms.item.singular.toLowerCase()} and choose New guide.`}
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
          {guides.map((g) => (
            <li key={g.id}>
              <Link to={`/teardown/${g.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-800/60">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">{g.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {[
                      `${g.itemName} · ${g.itemAssetCode}`,
                      g.unitName ? `Unit ${g.unitName}` : null,
                      `${g.stepCount} step${g.stepCount === 1 ? "" : "s"}`,
                      g.partCount ? `${g.partsReassembled}/${g.partCount} parts refitted` : null,
                      new Date(g.updatedAt).toLocaleDateString(),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <StatusPill status={g.job.status} draftPending={g.draftPending} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
