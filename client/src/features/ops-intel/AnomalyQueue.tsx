import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { opsApi, type AnomalyQuery } from "./api";
import type { Anomaly, AnomalyDetail, OpsMeta, RuleInfo } from "./types";
import {
  BTN,
  BTN_QUIET,
  CARD,
  FIELD,
  Notice,
  SELECT,
  SeverityBadge,
  ago,
  errorText,
  fmtDateTime,
} from "./ui";

/**
 * The anomaly queue: filter, open the record where the fix is made, and
 * resolve with a reason. Resolving says who and why; "Not a problem" keeps an
 * anomaly quiet while its condition lasts, "Fixed" expects the next run not to
 * find it again.
 */

const PAGE = 25;

export function AnomalyQueue({ meta, onChanged }: { meta: OpsMeta | null; onChanged: () => void }) {
  const [filters, setFilters] = useState<AnomalyQuery>({ status: "open" });
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Anomaly[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    (offset = 0) =>
      opsApi
        .anomalies({ ...filters, q: q.trim() || undefined, limit: PAGE, offset })
        .then((page) => {
          setRows((prev) => (offset && prev ? [...prev, ...page.anomalies] : page.anomalies));
          setTotal(page.total);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Anomalies could not be loaded."))),
    [filters, q],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), 200);
    return () => clearTimeout(t);
  }, [load]);

  const rules = meta?.rules ?? [];
  const ruleInfo = (id: string) => rules.find((r) => r.rule === id);
  const set = (patch: Partial<AnomalyQuery>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <section className="space-y-3" aria-label="Anomaly queue">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.status ?? "open"}
          onChange={(e) => set({ status: e.target.value as AnomalyQuery["status"] })}
          aria-label="Status"
          className={SELECT}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select value={filters.rule ?? ""} onChange={(e) => set({ rule: e.target.value || undefined })} aria-label="Rule" className={SELECT}>
          <option value="">Every rule</option>
          {rules.map((r) => (
            <option key={r.rule} value={r.rule}>
              {r.title}
            </option>
          ))}
        </select>
        <select
          value={filters.severity ?? ""}
          onChange={(e) => set({ severity: e.target.value || undefined })}
          aria-label="Severity"
          className={SELECT}
        >
          <option value="">Any severity</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles" aria-label="Search anomalies" className={`${FIELD} sm:w-56`} />
        <span className="ml-auto text-xs text-slate-500">{rows ? `${total} ${total === 1 ? "anomaly" : "anomalies"}` : ""}</span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-slate-500">
          {filters.status === "open" ? "Nothing needs attention. The rules run on a schedule; Run now checks straight away." : "No anomalies match."}
        </p>
      )}
      <ul className="space-y-2">
        {rows?.map((a) => (
          <AnomalyRow
            key={a.id}
            anomaly={a}
            info={ruleInfo(a.rule)}
            expanded={open === a.id}
            onToggle={() => setOpen((cur) => (cur === a.id ? null : a.id))}
            explanations={meta?.explanations.available ?? false}
            onResolved={() => {
              setOpen(null);
              void load(0);
              onChanged();
            }}
          />
        ))}
      </ul>
      {rows && rows.length < total && (
        <button onClick={() => void load(rows.length)} className={BTN_QUIET}>
          Show more
        </button>
      )}
    </section>
  );
}

function AnomalyRow({
  anomaly: a,
  info,
  expanded,
  onToggle,
  explanations,
  onResolved,
}: {
  anomaly: Anomaly;
  info: RuleInfo | undefined;
  expanded: boolean;
  onToggle: () => void;
  explanations: boolean;
  onResolved: () => void;
}) {
  return (
    <li className={`${CARD} space-y-2`}>
      <div className="flex flex-wrap items-start gap-2">
        <SeverityBadge severity={a.severity} />
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{a.ruleTitle}</span>
        {a.resolution && <ResolutionChip anomaly={a} />}
        {a.reopenedFrom && !a.resolution && (
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-amber-300">found again</span>
        )}
        <span className="ml-auto text-xs text-slate-500" title={fmtDateTime(a.firstSeenAt)}>
          first seen {ago(a.firstSeenAt)}
        </span>
      </div>
      <p className="text-sm text-slate-100">{a.title}</p>
      <div className="flex flex-wrap items-center gap-2">
        {a.link && (
          <Link to={a.link} className={BTN_QUIET}>
            Open where it is fixed
          </Link>
        )}
        <button onClick={onToggle} className={BTN_QUIET} aria-expanded={expanded}>
          {expanded ? "Hide details" : a.resolution ? "Details" : "Details and resolve"}
        </button>
        {a.sticky && a.occurrences > 1 && <span className="text-xs text-slate-400">happened {a.occurrences} times</span>}
      </div>
      {expanded && <AnomalyDetails id={a.id} info={info} explanations={explanations} onResolved={onResolved} />}
    </li>
  );
}

function ResolutionChip({ anomaly: a }: { anomaly: Anomaly }) {
  const text = { fixed: "fixed", dismissed: "not a problem", cleared: "cleared by a run" }[a.resolution!];
  return (
    <span className="rounded-full bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300" title={fmtDateTime(a.resolvedAt)}>
      {text}
      {a.resolvedByName ? ` · ${a.resolvedByName}` : ""}
    </span>
  );
}

function AnomalyDetails({
  id,
  info,
  explanations,
  onResolved,
}: {
  id: string;
  info: RuleInfo | undefined;
  explanations: boolean;
  onResolved: () => void;
}) {
  const [detail, setDetail] = useState<AnomalyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);

  useEffect(() => {
    opsApi
      .anomaly(id)
      .then((d) => {
        setDetail(d);
        setExplanation(d.explanation);
      })
      .catch((err) => setError(errorText(err, "The anomaly could not be loaded.")));
  }, [id]);

  const resolve = async (resolution: "fixed" | "dismissed") => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.resolve(id, resolution, note);
      onResolved();
    } catch (err) {
      setError(errorText(err, "It could not be resolved."));
    } finally {
      setBusy(false);
    }
  };

  const explain = async () => {
    setExplaining(true);
    try {
      const r = await opsApi.explain(id);
      setExplanation(r.explanation ?? "No explanation came back. The facts above are the whole story.");
    } catch (err) {
      setExplanation(errorText(err, "No explanation is available right now."));
    } finally {
      setExplaining(false);
    }
  };

  if (error && !detail) return <Notice tone="error">{error}</Notice>;
  if (!detail) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-3 border-t border-slate-800 pt-3 text-sm">
      {info && (
        <div className="space-y-1 text-slate-400">
          <p>
            <span className="text-slate-300">What this rule checks: </span>
            {info.description}
          </p>
          <p>
            <span className="text-slate-300">Usual fix: </span>
            {info.fix}
          </p>
        </div>
      )}
      <Facts detail={detail.detail} />
      <p className="text-xs text-slate-500">
        First seen {fmtDateTime(detail.firstSeenAt)} · last seen {fmtDateTime(detail.lastSeenAt)}
        {detail.occurredAt ? ` · happened ${fmtDateTime(detail.occurredAt)}` : ""}
      </p>

      {explanations && (
        <div className="space-y-1">
          {explanation ? (
            <p className="rounded-lg bg-slate-800/60 px-3 py-2 text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">In plain words · </span>
              {explanation}
            </p>
          ) : (
            <button onClick={explain} disabled={explaining} className={BTN_QUIET}>
              {explaining ? "Asking…" : "Explain in plain words"}
            </button>
          )}
        </div>
      )}

      {detail.resolution ? (
        <p className="text-slate-400">
          {detail.resolution === "cleared" ? "Cleared automatically" : `Resolved by ${detail.resolvedByName ?? "someone"}`}{" "}
          {fmtDateTime(detail.resolvedAt)}
          {detail.resolutionNote ? `: ${detail.resolutionNote}` : ""}
        </p>
      ) : (
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-500">What was done, or why it is not a problem</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              className={`${FIELD} mt-1`}
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void resolve("fixed")} disabled={busy || !note.trim()} className={BTN}>
              Fixed
            </button>
            <button onClick={() => void resolve("dismissed")} disabled={busy || !note.trim()} className={BTN_QUIET}>
              Not a problem
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {detail.sticky
              ? "This records an event; it stays open until someone resolves it."
              : "Fixed: the next run checks again and reopens it if it is still there. Not a problem: it stays quiet until the condition goes away."}
          </p>
        </div>
      )}

      {detail.history.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Earlier and later occurrences</p>
          <ul className="mt-1 space-y-1 text-xs text-slate-400">
            {detail.history.map((h) => (
              <li key={h.id}>
                {fmtDateTime(h.firstSeenAt)}:{" "}
                {h.resolution ? `${h.resolution}${h.resolvedByName ? ` by ${h.resolvedByName}` : ""}${h.resolutionNote ? `: ${h.resolutionNote}` : ""}` : "open"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const LABELS: Record<string, string> = {
  jobCode: "Job",
  jobName: "Job name",
  shipmentCode: "Shipment",
  shipmentStatus: "Shipment status",
  stage: "Stage",
  stageAt: "At stage since",
  arrivedAt: "Shipment arrived",
  zonePath: "Read in",
  recordedPath: "On file in",
  lastSeenAt: "Last read",
  lastZonePath: "Last read in",
  since: "Since",
  distanceM: "Distance (m)",
  elapsedSeconds: "Seconds between reads",
  speedKmh: "Implied speed (km/h)",
  values: "Values",
  normalized: "Compared as",
  locationPath: "Where",
  reason: "Why",
};

const THRESHOLD: Record<string, (v: number) => string> = {
  graceMinutes: (v) => `${v} min after arrival`,
  hours: (v) => `${v} h`,
  days: (v) => `${v} days`,
  maxGroup: (v) => `groups of up to ${v}`,
  maxSpeedKmh: (v) => `faster than ${v} km/h`,
  minDistanceM: (v) => `at least ${v} m apart`,
};

const HIDDEN = new Set(["name", "code", "zoneId", "recordedLocationId", "lastZoneId", "effectiveDistanceM", "readsInWindow", "type", "exact", "count", "brand", "model", "from", "to", "shipments"]);

function isoLike(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

function show(v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return "none";
  if (isoLike(v)) return fmtDateTime(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k} ${String(x)}`)
      .join(", ");
  }
  return String(v).replace(/_/g, " ");
}

/** The facts a rule recorded, readable, with links to the records it lists. */
function Facts({ detail }: { detail: Record<string, unknown> }) {
  const records = Array.isArray(detail.records) ? (detail.records as { itemId: string; name?: string; code?: string | null; value?: string }[]) : [];
  const lines = Array.isArray(detail.lines)
    ? (detail.lines as { jobId: string; jobCode: string; shipmentCode: string; shipmentStatus: string }[])
    : [];
  const entries = Object.entries(detail).filter(([k]) => !HIDDEN.has(k) && k !== "records" && k !== "lines" && k !== "threshold");
  const threshold = detail.threshold as Record<string, unknown> | undefined;
  return (
    <div className="space-y-2">
      {entries.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 text-slate-500">{LABELS[k] ?? k}</dt>
              <dd className="min-w-0 break-words text-slate-300">{show(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {records.length > 0 && (
        <ul className="space-y-0.5">
          {records.map((r, i) => (
            <li key={`${r.itemId}-${i}`}>
              <Link to={`/items/${r.itemId}`} className="text-sky-400 hover:underline">
                {r.name ?? r.code ?? r.itemId}
              </Link>
              {r.code && <span className="ml-1 font-mono text-xs text-slate-500">{r.code}</span>}
              {r.value && <span className="ml-2 font-mono text-xs text-slate-400">{r.value}</span>}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((l, i) => (
            <li key={i}>
              <Link to={`/jobs/${l.jobId}`} className="text-sky-400 hover:underline">
                {l.jobCode}
              </Link>
              <span className="ml-2 text-slate-400">
                {l.shipmentCode} ({l.shipmentStatus.replace(/_/g, " ")})
              </span>
            </li>
          ))}
        </ul>
      )}
      {threshold && (
        <p className="text-xs text-slate-500">
          Threshold:{" "}
          {Object.entries(threshold)
            .map(([k, v]) => (THRESHOLD[k] && typeof v === "number" ? THRESHOLD[k](v) : `${k} ${String(v)}`))
            .join(", ")}
        </p>
      )}
    </div>
  );
}
