import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useScan } from "../scan/ScanProvider";
import type { LocationDetail, VerifyResult } from "../types";

/**
 * Reconcile what is physically in a container against what is on file. While
 * this is open every hardware read lands in the list rather than opening an
 * item, and codes can also be typed in. Applying the result marks what was
 * found as checked and flags what was not.
 */
export function VerifyContents({
  location,
  onApplied,
}: {
  location: LocationDetail;
  onApplied: (d: LocationDetail) => void;
}) {
  const { armBulkCapture } = useScan();
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  // While open, reads go into the list instead of opening the scanned item.
  useEffect(() => {
    if (!open) return;
    armBulkCapture((code) => {
      setCodes((c) => (c.includes(code) ? c : [...c, code]));
      setResult(null);
    });
    return () => armBulkCapture(null);
  }, [open, armBulkCapture]);

  const addCode = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setCodes((c) => (c.includes(v) ? c : [...c, v]));
    setResult(null);
  };

  const reset = () => {
    setCodes([]);
    setManual("");
    setResult(null);
  };

  const reconcile = async () => {
    setBusy(true);
    try {
      setResult(await api.verifyLocation(location.id, codes));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const updated = await api.applyVerifyLocation(
        location.id,
        result.present.map((p) => p.id),
        result.missing.map((m) => m.id),
      );
      onApplied(updated);
      setOpen(false);
      reset();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
      >
        Verify contents
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-200">
          Scanning: <span className="text-sky-300">{codes.length}</span> tag
          {codes.length === 1 ? "" : "s"} read
        </p>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Read tags with your scanner anywhere on this page, or add codes by hand, then reconcile
        against the {location.itemCount} item{location.itemCount === 1 ? "" : "s"} on file here.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCode(manual);
              setManual("");
            }
          }}
          placeholder="Add a tag / code by hand"
          className="min-w-[12rem] flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100"
        />
        <button
          onClick={() => {
            addCode(manual);
            setManual("");
          }}
          className="rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800"
        >
          Add
        </button>
        <button
          onClick={reset}
          disabled={!codes.length && !result}
          className="rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          Clear
        </button>
        <button
          onClick={reconcile}
          disabled={busy || !codes.length}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Reconcile
        </button>
      </div>

      {result && (
        <div className="mt-3 space-y-3">
          <Group
            title={`Present (${result.present.length})`}
            color="text-emerald-300"
            lines={result.present.map((r) => `${r.name} · ${r.assetCode}`)}
            empty="None found yet."
          />
          <Group
            title={`Missing (${result.missing.length})`}
            color="text-red-300"
            lines={result.missing.map((r) => `${r.name} · ${r.assetCode}`)}
            empty="Nothing missing."
          />
          {result.unexpected.length > 0 && (
            <Group
              title={`Unexpected (${result.unexpected.length})`}
              color="text-amber-300"
              lines={result.unexpected.map(
                (r) => `${r.name} · ${r.assetCode}${r.locationName ? ` (in ${r.locationName})` : ""}`,
              )}
              empty=""
            />
          )}
          {result.unresolved.length > 0 && (
            <Group
              title={`Unknown tags (${result.unresolved.length})`}
              color="text-slate-400"
              lines={result.unresolved}
              empty=""
            />
          )}
          <button
            onClick={apply}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Apply: mark {result.present.length} checked, flag {result.missing.length} missing
          </button>
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  color,
  lines,
  empty,
}: {
  title: string;
  color: string;
  lines: string[];
  empty: string;
}) {
  return (
    <div>
      <p className={`text-sm font-medium ${color}`}>{title}</p>
      {lines.length ? (
        <ul className="mt-1 space-y-0.5">
          {lines.map((t, i) => (
            <li key={i} className="font-mono text-xs text-slate-300">
              {t}
            </li>
          ))}
        </ul>
      ) : empty ? (
        <p className="text-xs text-slate-500">{empty}</p>
      ) : null}
    </div>
  );
}
