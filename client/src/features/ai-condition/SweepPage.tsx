import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { AlertIcon, ArrowLeftIcon, CameraIcon } from "../../components/icons";
import { ProductImage } from "../../components/ProductImage";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { conditionApi } from "./api";
import { SweepProgress } from "./ConditionPage";
import { ReportForm, type ReportFormItem } from "./ReportForm";
import type { SweepDetail, SweepItem } from "./types";
import { RatingBadge, STAGE_LABEL, errorMessage, when } from "./vocab";

type Current = {
  item: ReportFormItem & { primaryImageUrl: string | null; assetCode: string; locationName: string | null };
  unitId: string | null;
  expected: boolean;
  alreadyChecked: boolean;
  handlingNote: string | null;
};

const unitName = (u: { label: string | null; serial: string | null; assetCode: string }) => u.label?.trim() || u.serial?.trim() || u.assetCode;

/**
 * A condition sweep in progress: scan (or pick) the next thing, photograph
 * it, let AI suggest its condition, confirm, next. Every scan while this page
 * is open comes here rather than opening the usual overlay.
 */
export function SweepPage() {
  const { id = "" } = useParams<{ id: string }>();
  const terms = useTerms();
  const { armCapture, openCamera } = useScan();
  const [sweep, setSweep] = useState<SweepDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    conditionApi
      .sweep(id)
      .then(setSweep)
      .catch((err) => setLoadError(errorMessage(err, "This sweep could not be loaded.")));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const open = useCallback(
    async (itemId: string, unitId: string | null, expected: boolean, alreadyChecked: boolean) => {
      setOpening(true);
      try {
        const [item, latest] = await Promise.all([
          api.getItem(itemId),
          conditionApi.listReports({ itemId, limit: 1 }).catch(() => ({ reports: [] })),
        ]);
        setCurrent({
          item: {
            id: item.id,
            name: item.name,
            units: item.units.map((u) => ({ id: u.id, label: unitName(u) })),
            primaryImageUrl: item.primaryImageUrl,
            assetCode: item.assetCode,
            locationName: item.locationName ?? null,
          },
          unitId,
          expected,
          alreadyChecked,
          handlingNote: latest.reports[0]?.handlingNote ?? null,
        });
      } catch (err) {
        setNotice({ tone: "warn", text: errorMessage(err, "That could not be opened.") });
      } finally {
        setOpening(false);
      }
    },
    [],
  );

  const currentRef = useRef(current);
  currentRef.current = current;

  // A reader can send the same tag several times in a second; one lookup at a time.
  const looking = useRef(false);
  const onCode = useCallback(
    async (code: string) => {
      if (looking.current) return;
      looking.current = true;
      setNotice(null);
      try {
        const hit = await conditionApi.sweepScan(id, code);
        if (currentRef.current?.item.id === hit.itemId) return;
        await open(hit.itemId, hit.unitId, hit.expected, Boolean(hit.report));
      } catch (err) {
        setNotice({ tone: "warn", text: errorMessage(err, "That code could not be looked up.") });
      } finally {
        looking.current = false;
      }
    },
    [id, open],
  );

  // Every scan on this page belongs to the sweep, until the page is left. A
  // one-shot capture, re-armed after each scan, so the camera closes after
  // each read and the form behind it can be filled in.
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const isOpen = sweep?.status === "open";
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const arm = () =>
      armCapture((code) => {
        if (!active) return;
        arm();
        void onCodeRef.current(code);
      });
    arm();
    return () => {
      active = false;
      armCapture(null);
    };
  }, [armCapture, isOpen]);

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const code = typed.trim();
    if (!code) return;
    setTyped("");
    void onCode(code);
  };

  const finish = async () => {
    if (!sweep) return;
    const left = sweep.expected - sweep.checked;
    if (left > 0 && !confirm(`${left} not checked yet. Finish the sweep anyway?`)) return;
    try {
      await conditionApi.closeSweep(sweep.id);
      setCurrent(null);
      load();
    } catch (err) {
      setNotice({ tone: "warn", text: errorMessage(err, "The sweep could not be finished.") });
    }
  };

  if (loadError) return <p className="py-10 text-center text-red-400">{loadError}</p>;
  if (!sweep) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const remaining = sweep.items.filter((i) => !i.report);
  const done = [...sweep.items.filter((i) => i.report), ...sweep.extra];

  const row = (i: SweepItem) => (
    <li key={i.itemId}>
      <button
        type="button"
        disabled={!isOpen || opening}
        onClick={() => void open(i.itemId, null, sweep.items.some((x) => x.itemId === i.itemId), Boolean(i.report))}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-800 disabled:hover:bg-transparent"
      >
        <span className="min-w-0 flex-1 truncate text-slate-200">{i.name}</span>
        {i.locationName && <span className="hidden truncate text-xs text-slate-500 sm:inline">{i.locationName}</span>}
        <span className="font-mono text-xs text-slate-500">{i.assetCode}</span>
        {i.report && <RatingBadge rating={i.report.rating} />}
      </button>
    </li>
  );

  return (
    <div className="space-y-5">
      <Link to="/condition" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Condition
      </Link>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-100">
            Sweep: {sweep.locationName ?? `a deleted ${terms.location.singular.toLowerCase()}`}
          </h1>
          {isOpen ? (
            <button type="button" onClick={() => void finish()} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
              Finish sweep
            </button>
          ) : (
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">Finished {sweep.closedAt ? when(sweep.closedAt) : ""}</span>
          )}
        </div>
        <p className="text-sm text-slate-400">
          {STAGE_LABEL[sweep.stage]} · {sweep.checked} of {sweep.expected} checked
          {sweep.extra.length ? ` · ${sweep.extra.length} from elsewhere` : ""}
        </p>
        <SweepProgress sweep={sweep} />
      </div>

      {notice && (
        <p
          className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-sm ${
            notice.tone === "ok" ? "bg-emerald-950/60 text-emerald-200" : "bg-amber-950/60 text-amber-200"
          }`}
        >
          {notice.tone === "warn" && <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />}
          {notice.text}
        </p>
      )}

      {isOpen && !current && (
        <section className="space-y-3 rounded-xl border border-sky-800 bg-sky-950/30 p-5 text-center">
          <p className="text-lg font-medium text-sky-100">{opening ? "Opening…" : `Scan the next ${terms.item.singular.toLowerCase()}`}</p>
          <p className="text-sm text-slate-400">Use a handheld reader or the camera, type its code, or pick it from the list below.</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={openCamera} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500">
              <CameraIcon className="h-4 w-4" />
              Camera
            </button>
            <form onSubmit={submitTyped} className="flex gap-2">
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Type a code"
                aria-label="Code"
                className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              />
              <button className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Go</button>
            </form>
          </div>
        </section>
      )}

      {isOpen && current && (
        <section className="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
          <div className="flex gap-3">
            <ProductImage src={current.item.primaryImageUrl} alt={current.item.name} className="h-16 w-16 shrink-0 rounded-lg object-contain" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-100">{current.item.name}</h2>
              <p className="font-mono text-xs text-slate-400">{current.item.assetCode}</p>
              {!current.expected && (
                <p className="mt-1 text-sm text-amber-300">
                  Not recorded here{current.item.locationName ? `: on file at ${current.item.locationName}` : ""}.
                </p>
              )}
              {current.alreadyChecked && <p className="mt-1 text-sm text-slate-400">Already checked in this sweep. Saving adds another report.</p>}
            </div>
          </div>
          <ReportForm
            key={current.item.id}
            item={current.item}
            defaults={{ unitId: current.unitId, handlingNote: current.handlingNote }}
            lockStage={sweep.stage}
            sweepId={sweep.id}
            autoAssess
            saveLabel="Save and next"
            onSaved={(r) => {
              setNotice({ tone: "ok", text: `Saved ${r.itemName}${r.rating ? `: ${r.rating}` : ""}.` });
              setCurrent(null);
              load();
            }}
            onCancel={() => setCurrent(null)}
          />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Still to check ({remaining.length})</h2>
        {remaining.length ? (
          <ul className="max-h-96 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-1">{remaining.map(row)}</ul>
        ) : (
          <p className="text-sm text-slate-500">Everything recorded here has been checked.</p>
        )}
      </section>

      <section className="space-y-2">
        <button type="button" onClick={() => setShowDone((v) => !v)} className="text-sm font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200">
          Checked ({done.length}) {showDone ? "▾" : "▸"}
        </button>
        {showDone && done.length > 0 && <ul className="rounded-xl border border-slate-800 bg-slate-900 p-1">{done.map(row)}</ul>}
      </section>
    </div>
  );
}
