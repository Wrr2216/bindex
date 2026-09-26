import { useEffect, useMemo, useState } from "react";
import { AlertIcon } from "../../components/icons";
import { Modal } from "../media-ai-core";
import { conditionApi } from "./api";
import { DefectList } from "./DefectEditor";
import type { Comparison, ComparisonDraft, ConditionReport, Defect } from "./types";
import { RatingBadge, errorMessage, reportStage, useConditionAi, when } from "./vocab";

/**
 * The pair to compare by default: the latest "before" against the latest
 * "after" when both exist, otherwise the two most recent reports. Reports are
 * newest first.
 */
export function defaultPair(reports: ConditionReport[]): [string, string] | null {
  if (reports.length < 2) return null;
  const after = reports.find((r) => r.stage === "after");
  const before = reports.find((r) => r.stage === "before" && (!after || r.createdAt < after.createdAt));
  if (before && after) return [before.id, after.id];
  return [reports[1]!.id, reports[0]!.id];
}

const reportLabel = (r: ConditionReport) =>
  `${reportStage(r)} · ${when(r.createdAt)}${r.unitLabel ? ` · ${r.unitLabel}` : ""}`;

/**
 * Before and after, side by side: photos, rating and defects, with new damage
 * marked from the defect lists people confirmed, and an optional AI read of
 * the two sets of photos next to it.
 */
export function CompareView({ reports, onClose }: { reports: ConditionReport[]; onClose: () => void }) {
  const aiOn = useConditionAi();
  const initial = useMemo(() => defaultPair(reports), [reports]);
  const [beforeId, setBeforeId] = useState(initial?.[0] ?? "");
  const [afterId, setAfterId] = useState(initial?.[1] ?? "");
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [ai, setAi] = useState<{ draft: ComparisonDraft | null; message?: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCmp(null);
    setAi(null);
    setError(null);
    if (!beforeId || !afterId || beforeId === afterId) return;
    let live = true;
    conditionApi
      .compare(beforeId, afterId)
      .then((c) => live && setCmp(c))
      .catch((err) => live && setError(errorMessage(err, "Could not compare these reports.")));
    return () => {
      live = false;
    };
  }, [beforeId, afterId]);

  const runAi = async () => {
    setAiBusy(true);
    setAi(null);
    try {
      const res = await conditionApi.compareWithAi(beforeId, afterId);
      setAi(
        res.available
          ? { draft: res.draft, message: res.message }
          : { draft: null, message: "No vision model is configured." },
      );
    } catch (err) {
      setAi({ draft: null, message: errorMessage(err, "The photos could not be compared.") });
    } finally {
      setAiBusy(false);
    }
  };

  const markAfter = (_d: Defect, i: number) => {
    const status = cmp?.diff.afterStatus[i];
    if (status === "new") return { label: "New", tone: "bg-red-950/70 text-red-200 ring-1 ring-red-800" };
    if (status === "worse") return { label: "Worse", tone: "bg-amber-950/70 text-amber-200 ring-1 ring-amber-800" };
    return null;
  };
  const markBefore = (_d: Defect, i: number) =>
    cmp?.diff.beforeStatus[i] === "gone"
      ? { label: "Gone", tone: "bg-emerald-950/60 text-emerald-200 line-through decoration-emerald-700" }
      : null;

  const picker = (value: string, set: (v: string) => void, label: string) => (
    <select
      value={value}
      onChange={(e) => set(e.target.value)}
      aria-label={label}
      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
    >
      {reports.map((r) => (
        <option key={r.id} value={r.id}>
          {reportLabel(r)}
        </option>
      ))}
    </select>
  );

  const side = (r: ConditionReport, which: "before" | "after") => (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <RatingBadge rating={r.rating} />
        <span className="text-xs text-slate-400">{when(r.createdAt)}</span>
      </div>
      {r.photos.length ? (
        <div className="grid grid-cols-2 gap-1.5">
          {r.photos.map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded-lg bg-slate-800">
              <img src={p.thumbUrl ?? p.url} alt="" className="h-full w-full object-cover" />
            </a>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No photos.</p>
      )}
      {(r.notes || r.aiNotes) && <p className="text-sm text-slate-300">{r.notes ?? r.aiNotes}</p>}
      <DefectList defects={r.defects} mark={which === "after" ? markAfter : markBefore} />
    </div>
  );

  const change = cmp?.rating;

  return (
    <Modal title="Before and after" onClose={onClose} wide>
      {!initial ? (
        <p className="text-sm text-slate-400">Record at least two reports to compare them.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs uppercase tracking-wide text-slate-400">
              Before
              <div className="mt-1">{picker(beforeId, setBeforeId, "Before report")}</div>
            </label>
            <label className="block text-xs uppercase tracking-wide text-slate-400">
              After
              <div className="mt-1">{picker(afterId, setAfterId, "After report")}</div>
            </label>
          </div>
          {beforeId === afterId && <p className="text-sm text-slate-400">Pick two different reports.</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {cmp && (
            <>
              <div
                className={`rounded-lg px-3 py-2 text-sm ${
                  cmp.diff.added.length || cmp.diff.worsened.length || change === "worse"
                    ? "bg-red-950/60 text-red-200"
                    : "bg-slate-800 text-slate-200"
                }`}
              >
                {cmp.diff.added.length} new, {cmp.diff.worsened.length} worse, {cmp.diff.resolved.length} gone,{" "}
                {cmp.diff.unchanged.length + cmp.diff.improved.length} unchanged or better.
                {change && change !== "same" && ` Condition ${change === "worse" ? "got worse" : "improved"}.`}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {side(cmp.before, "before")}
                {side(cmp.after, "after")}
              </div>
              {aiOn && (
                <div className="space-y-2 rounded-lg border border-slate-800 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-200">AI comparison of the photos</h3>
                    <button
                      type="button"
                      onClick={() => void runAi()}
                      disabled={aiBusy || !cmp.before.photos.length || !cmp.after.photos.length}
                      className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
                    >
                      {aiBusy ? "Comparing…" : "Compare photos with AI"}
                    </button>
                  </div>
                  {(!cmp.before.photos.length || !cmp.after.photos.length) && (
                    <p className="text-xs text-slate-500">Both reports need photos.</p>
                  )}
                  {ai?.message && (
                    <p className="flex items-center gap-1.5 text-sm text-amber-200">
                      <AlertIcon className="h-4 w-4" />
                      {ai.message}
                    </p>
                  )}
                  {ai?.draft && (
                    <div className="space-y-2 text-sm">
                      {ai.draft.summary && <p className="text-slate-200">{ai.draft.summary}</p>}
                      {ai.draft.ratingAfter && (
                        <p className="text-slate-400">
                          Condition after, as the model sees it: <RatingBadge rating={ai.draft.ratingAfter} />
                        </p>
                      )}
                      {ai.draft.newDefects.length > 0 && (
                        <>
                          <p className="text-xs uppercase tracking-wide text-slate-400">New damage it sees</p>
                          <DefectList defects={ai.draft.newDefects} mark={() => ({ label: "New", tone: "bg-red-950/70 text-red-200" })} />
                        </>
                      )}
                      {ai.draft.resolvedDefects.length > 0 && (
                        <>
                          <p className="text-xs uppercase tracking-wide text-slate-400">No longer visible</p>
                          <DefectList defects={ai.draft.resolvedDefects} />
                        </>
                      )}
                      <p className="text-xs text-slate-500">A suggestion from the photos. The reports themselves are unchanged.</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
