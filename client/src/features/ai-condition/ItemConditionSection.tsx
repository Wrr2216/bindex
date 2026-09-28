import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useFeatures } from "../../config/useConfig";
import type { ItemDetail } from "../../types";
import { Modal } from "../media-ai-core";
import { conditionApi } from "./api";
import { CompareView } from "./CompareView";
import { ContainerCapture } from "./ContainerCapture";
import { DefectList } from "./DefectEditor";
import { HandlingNoteBanner } from "./HandlingNote";
import { ReportForm, type ReportFormItem } from "./ReportForm";
import type { ConditionReport, ContainerCapture as Capture } from "./types";
import { FLAG_LABEL, RatingBadge, errorMessage, reportStage, useConditionEnabled, when } from "./vocab";

const CARD = "space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4";
const BTN = "rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

const unitName = (u: ItemDetail["units"][number]) => u.label?.trim() || u.serial?.trim() || u.assetCode;

/**
 * The item page's condition section: its handling note, condition reports
 * with before/after comparison, and the container pack list. Renders nothing
 * when the feature is off.
 */
export function ItemConditionSection({ item, onChange }: { item: ItemDetail; onChange: (item: ItemDetail) => void }) {
  const enabled = useConditionEnabled();
  if (!enabled || item.category === "Domain") return null;
  return <Section item={item} onChange={onChange} />;
}

function Section({ item, onChange }: { item: ItemDetail; onChange: (item: ItemDetail) => void }) {
  const features = useFeatures();
  const { user } = useAuth();
  const [reports, setReports] = useState<ConditionReport[] | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [editing, setEditing] = useState<ConditionReport | "new" | null>(null);
  const [comparing, setComparing] = useState(false);
  const [packing, setPacking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    conditionApi
      .listReports({ itemId: item.id, limit: 100 })
      .then((r) => setReports(r.reports))
      .catch(() => setReports([]));
    conditionApi
      .captures(item.id)
      .then((r) => setCaptures(r.captures))
      .catch(() => setCaptures([]));
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load]);

  const formItem: ReportFormItem = {
    id: item.id,
    name: item.name,
    units: features.units ? item.units.map((u) => ({ id: u.id, label: unitName(u) })) : [],
  };
  const latestItemLevel = reports?.find((r) => !r.unitId) ?? null;

  const saved = () => {
    setEditing(null);
    setRefresh((n) => n + 1);
    load();
  };

  const remove = async (r: ConditionReport) => {
    if (!confirm("Delete this condition report? Its photos stay with the item.")) return;
    setError(null);
    try {
      await conditionApi.deleteReport(r.id);
      setOpen(null);
      saved();
    } catch (err) {
      setError(errorMessage(err, "Could not delete the report."));
    }
  };

  const latestCapture = captures[0] ?? null;
  const canDelete = (r: ConditionReport) => user?.role === "admin" || (user && r.createdBy === user.oid);

  return (
    <>
      <HandlingNoteBanner itemId={item.id} refreshKey={refresh} />

      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Condition
            {latestItemLevel && <RatingBadge rating={latestItemLevel.rating} className="ml-2 normal-case tracking-normal" />}
          </h2>
          <div className="flex flex-wrap gap-2">
            {reports && reports.length >= 2 && (
              <button type="button" onClick={() => setComparing(true)} className={BTN}>
                Before and after
              </button>
            )}
            <button type="button" onClick={() => setPacking(true)} className={BTN}>
              Pack list
            </button>
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            >
              Record condition
            </button>
          </div>
        </div>

        {reports === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-slate-500">No condition recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {reports.map((r) => (
              <li key={r.id} className="py-2">
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full flex-wrap items-center gap-2 text-left">
                  <RatingBadge rating={r.rating} />
                  <span className="text-sm text-slate-200">{reportStage(r)}</span>
                  {r.unitLabel && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">{r.unitLabel}</span>}
                  {r.defects.length > 0 && (
                    <span className="text-xs text-slate-400">
                      {r.defects.length} defect{r.defects.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {r.aiAssisted && <span className="rounded bg-violet-900/60 px-1.5 text-[10px] uppercase text-violet-200">AI assisted</span>}
                  <span className="ml-auto text-xs text-slate-500">
                    {when(r.createdAt)}
                    {r.createdByName ? ` · ${r.createdByName}` : ""}
                  </span>
                </button>
                {open === r.id && (
                  <div className="mt-2 space-y-2 pl-1">
                    {r.photos.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {r.photos.map((p) => (
                          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden rounded-md bg-slate-800">
                            <img src={p.thumbUrl ?? p.url} alt="" className="h-full w-full object-cover" />
                          </a>
                        ))}
                      </div>
                    )}
                    {r.notes && <p className="text-sm text-slate-300">{r.notes}</p>}
                    {r.aiNotes && <p className="text-sm text-violet-200/90">AI: {r.aiNotes}</p>}
                    <DefectList defects={r.defects} />
                    {r.handlingNote && <p className="text-sm text-amber-200">Handling: {r.handlingNote}</p>}
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setEditing(r)} className={BTN}>
                        Correct
                      </button>
                      {canDelete(r) && (
                        <button type="button" onClick={() => void remove(r)} className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950">
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {latestCapture && (
          <div className="rounded-lg bg-slate-800/50 p-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-slate-400">
              Packed {when(latestCapture.createdAt)}
              {latestCapture.aiAssisted ? " · read with AI" : ""}
            </p>
            <p className="mt-1 text-slate-200">
              {[latestCapture.sizeClass, latestCapture.room, latestCapture.contentsSummary].filter(Boolean).join(" · ") ||
                `${latestCapture.contents.length} line(s)`}
            </p>
            {latestCapture.flags.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {latestCapture.flags.map((f) => (
                  <span key={f} className="rounded-full bg-amber-700/70 px-2 py-0.5 text-xs text-white">
                    {FLAG_LABEL[f]}
                  </span>
                ))}
              </p>
            )}
            {latestCapture.handwrittenText && (
              <p className="mt-1 whitespace-pre-line font-mono text-xs text-slate-400">{latestCapture.handwrittenText}</p>
            )}
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      {editing && (
        <Modal title={editing === "new" ? `Record condition: ${item.name}` : "Correct condition report"} onClose={() => setEditing(null)} wide>
          <ReportForm
            item={formItem}
            report={editing === "new" ? undefined : editing}
            defaults={editing === "new" ? { handlingNote: latestItemLevel?.handlingNote ?? null } : undefined}
            onSaved={saved}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {comparing && reports && <CompareView reports={reports} onClose={() => setComparing(false)} />}
      {packing && (
        <ContainerCapture
          container={{ id: item.id, name: item.name, locationId: item.locationId, locationName: item.locationName }}
          onClose={() => setPacking(false)}
          onSaved={async () => {
            setPacking(false);
            load();
            setRefresh((n) => n + 1);
            try {
              // The new contents show under the item.
              onChange(await api.getItem(item.id));
            } catch {
              // The page still shows the item; a reload picks up the contents.
            }
          }}
        />
      )}
    </>
  );
}
