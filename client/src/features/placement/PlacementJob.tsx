import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import {
  BTN,
  BTN_QUIET,
  CARD,
  H2,
  Notice,
  StageBadge,
  StatusBadge,
  errorText,
  fmtDateTime,
  useJobsMeta,
} from "../jobs-core/ui";
import { placementApi } from "./api";
import { Destinations } from "./Destinations";
import type { AfterDeliveryReason, JobProgress, Observation, PlacementLine } from "./types";
import { FloorBand, PlacementBar, floorText, labelCode, pathText, shortPath } from "./ui";

type Tab = "progress" | "destinations" | "log";

const REASONS: Record<AfterDeliveryReason, { title: string; hint: string; tone: string }> = {
  not_unloaded: {
    title: "Never unloaded",
    hint: "Its truck is delivered, but it was never scanned off. Check the truck, then flag what is not there.",
    tone: "text-red-300",
  },
  flagged_missing: { title: "Flagged missing", hint: "Already marked missing.", tone: "text-amber-300" },
  not_placed: {
    title: "Unloaded, not in its room",
    hint: "Scanned off the truck, but not placed yet. Sweep the rooms or the dock.",
    tone: "text-orange-300",
  },
};

const OUTCOME_TEXT: Record<Observation["outcome"], string> = {
  placed: "Placed",
  misplaced: "Found in the wrong room",
  wrong_shipment: "Off the wrong truck",
  wrong_job: "Not on this job",
};

const LIST_CAP = 200;

function LineRow({ line, meta, select }: { line: PlacementLine; meta: ReturnType<typeof useJobsMeta>; select?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 py-2 text-sm last:border-0">
      {select}
      <span className="min-w-0 flex-1">
        <Link to={`/items/${line.itemId}`} className="text-slate-100 hover:underline">
          {line.itemName}
        </Link>
        {line.unitLabel && <span className="text-slate-400"> · {line.unitLabel}</span>}
        <span className="ml-2 font-mono text-xs text-slate-500">{labelCode(line)}</span>
      </span>
      <StageBadge stage={line.stage} meta={meta} />
      <FloorBand floor={line.floor} color={line.floorColor} size="sm" />
      <span className="text-slate-300">
        {line.destination ? shortPath(line.destination) : <span className="text-amber-300">No destination</span>}
        {line.destinationLabel && <span className="text-slate-400"> · {line.destinationLabel}</span>}
      </span>
      {line.shipmentCode && <span className="font-mono text-xs text-slate-500">{line.shipmentCode}</span>}
    </li>
  );
}

export function PlacementJob() {
  const { id = "" } = useParams();
  const terms = useTerms();
  const meta = useJobsMeta();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "progress";
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [log, setLog] = useState<Observation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    placementApi
      .progress(id)
      .then((p) => {
        setProgress(p);
        setError(null);
      })
      .catch((err) => setError(errorText(err, "Could not load the job.")));
  }, [id]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (tab !== "log") return;
    placementApi
      .observations(id, 200)
      .then(setLog)
      .catch((err) => setError(errorText(err, "Could not load the log.")));
  }, [id, tab]);

  const risk = useMemo(() => {
    const groups = new Map<AfterDeliveryReason, JobProgress["afterDelivery"]>();
    for (const l of progress?.afterDelivery ?? []) groups.set(l.reason, [...(groups.get(l.reason) ?? []), l]);
    return groups;
  }, [progress]);

  const markMissing = async () => {
    if (!picked.size) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await placementApi.markMissing(id, [...picked]);
      setNotice(`${r.missing} flagged missing.${r.blocked.length ? ` ${r.blocked.length} refused: ${r.blocked[0]!.reason}` : ""}`);
      setPicked(new Set());
      load();
    } catch (err) {
      setNotice(errorText(err, "Could not flag them."));
    } finally {
      setBusy(false);
    }
  };

  if (error && !progress) return <Notice tone="error">{error}</Notice>;
  if (!progress) return <p className="text-slate-400">Loading…</p>;
  const { job } = progress;
  const remaining = showAll ? progress.remaining : progress.remaining.slice(0, LIST_CAP);
  const setTab = (t: Tab) => setParams(t === "progress" ? {} : { tab: t }, { replace: true });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Link to="/placement" className="text-sm text-sky-400 hover:underline">
          Placement
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-400">{job.code}</span>
          <h1 className="text-xl font-semibold text-slate-100">{job.name}</h1>
          <StatusBadge status={job.status} />
          <Link to={`/jobs/${job.id}`} className="text-sm text-sky-400 hover:underline">
            Job and manifest
          </Link>
        </div>
        {(job.origin || job.destination) && (
          <p className="text-sm text-slate-400">
            {job.origin ? pathText(job.origin) : "?"} → {job.destination ? pathText(job.destination) : "?"}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Link to={`/placement/jobs/${job.id}/where`} className={BTN}>
            Where does this go?
          </Link>
          <Link to={`/placement/jobs/${job.id}/sweep`} className={BTN_QUIET}>
            Sweep a room
          </Link>
          <Link to={`/placement/jobs/${job.id}/kiosk`} className={BTN_QUIET}>
            Entrance kiosk
          </Link>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-800" role="tablist">
        {(
          [
            ["progress", "Progress"],
            ["destinations", "Destinations"],
            ["log", "Log"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t ? "border-sky-500 text-sky-300" : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {tab === "progress" && (
        <div className="space-y-4">
          <section className={`${CARD} space-y-3`}>
            <PlacementBar
              tally={progress.overall}
              label={<span className="font-medium">All {terms.item.plural.toLowerCase()}</span>}
            />
            {progress.truncated && (
              <Notice tone="warn">This manifest is too large to list in full here; the counts cover the first part.</Notice>
            )}
          </section>

          {progress.byFloor.length > 0 && (
            <section className={`${CARD} space-y-3`}>
              <h2 className={H2}>By floor</h2>
              {progress.byFloor.map((f) => (
                <PlacementBar key={f.floor ?? ""} tally={f.tally} color={f.color} label={floorText(f.floor)} />
              ))}
            </section>
          )}

          {progress.byRoom.length > 0 && (
            <section className={`${CARD} space-y-3`}>
              <h2 className={H2}>By room</h2>
              {progress.byRoom.map((r) => (
                <PlacementBar
                  key={r.destination?.id ?? ""}
                  tally={r.tally}
                  color={r.color}
                  label={
                    r.destination ? (
                      <Link
                        to={`/placement/jobs/${job.id}/sweep?room=${r.destination.id}`}
                        className="hover:underline"
                        title="Sweep this room"
                      >
                        {pathText(r.destination)}
                      </Link>
                    ) : (
                      <span className="text-amber-300">No destination yet</span>
                    )
                  }
                />
              ))}
            </section>
          )}

          {progress.misplaced.length > 0 && (
            <section className={`${CARD} space-y-2`}>
              <h2 className={H2}>In the wrong room</h2>
              <ul>
                {progress.misplaced.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-x-3 border-b border-slate-800 py-2 text-sm last:border-0">
                    <Link to={`/items/${l.itemId}`} className="text-slate-100 hover:underline">
                      {l.itemName}
                    </Link>
                    <span className="font-mono text-xs text-slate-500">{labelCode(l)}</span>
                    <span className="text-orange-300">found in {l.lastActual ? shortPath(l.lastActual) : "another room"}</span>
                    <span className="text-slate-300">belongs in {shortPath(l.destination)}</span>
                    {l.lastActual && <span className="text-xs text-slate-500">{fmtDateTime(l.lastActual.at)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {progress.afterDelivery.length > 0 && (
            <section className={`${CARD} space-y-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className={H2}>Missing after delivery</h2>
                <button onClick={() => void markMissing()} disabled={busy || picked.size === 0} className={BTN_QUIET}>
                  Flag {picked.size || ""} missing
                </button>
              </div>
              {notice && <Notice>{notice}</Notice>}
              {[...risk.entries()].map(([reason, lines]) => (
                <div key={reason}>
                  <p className={`text-sm font-medium ${REASONS[reason].tone}`}>
                    {REASONS[reason].title} ({lines.length})
                  </p>
                  <p className="text-xs text-slate-500">{REASONS[reason].hint}</p>
                  <ul>
                    {lines.map((l) => (
                      <LineRow
                        key={l.id}
                        line={l}
                        meta={meta}
                        select={
                          reason !== "flagged_missing" ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${l.itemName}`}
                              checked={picked.has(l.id)}
                              onChange={(e) =>
                                setPicked((s) => {
                                  const next = new Set(s);
                                  if (e.target.checked) next.add(l.id);
                                  else next.delete(l.id);
                                  return next;
                                })
                              }
                            />
                          ) : undefined
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section className={`${CARD} space-y-2`}>
            <h2 className={H2}>Still to place ({progress.remaining.length})</h2>
            {progress.remaining.length === 0 ? (
              <p className="text-sm text-emerald-300">Everything is in its room.</p>
            ) : (
              <ul>
                {remaining.map((l) => (
                  <LineRow key={l.id} line={l} meta={meta} />
                ))}
              </ul>
            )}
            {!showAll && progress.remaining.length > LIST_CAP && (
              <button onClick={() => setShowAll(true)} className={BTN_QUIET}>
                Show all {progress.remaining.length}
              </button>
            )}
          </section>
        </div>
      )}

      {tab === "destinations" && <Destinations jobId={job.id} progress={progress} onChanged={load} />}

      {tab === "log" && (
        <section className={`${CARD} space-y-2`}>
          <h2 className={H2}>What was found where</h2>
          {log === null && <p className="text-sm text-slate-400">Loading…</p>}
          {log?.length === 0 && <p className="text-sm text-slate-400">Nothing yet.</p>}
          <ul>
            {log?.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-slate-800 py-2 text-sm last:border-0">
                <span className="w-36 shrink-0 text-xs text-slate-500">{fmtDateTime(o.at)}</span>
                <span className={o.outcome === "placed" ? "text-emerald-300" : "text-orange-300"}>
                  {OUTCOME_TEXT[o.outcome]}
                </span>
                <Link to={`/items/${o.itemId}`} className="text-slate-100 hover:underline">
                  {o.itemName}
                </Link>
                {o.actual && <span className="text-slate-300">in {shortPath(o.actual)}</span>}
                {o.outcome === "misplaced" && o.expected && (
                  <span className="text-slate-400">belongs in {shortPath(o.expected)}</span>
                )}
                {o.shipmentCode && <span className="text-slate-400">unloading {o.shipmentCode}</span>}
                {o.otherJob && (
                  <Link to={`/placement/jobs/${o.otherJob.id}`} className="text-sky-400 hover:underline">
                    belongs to {o.otherJob.code}
                  </Link>
                )}
                <span className="text-xs text-slate-500">
                  {o.deviceName ?? o.actor ?? ""} · {o.via}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
