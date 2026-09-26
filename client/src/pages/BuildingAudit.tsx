import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useScan } from "../scan/ScanProvider";
import { ReaderChannelPicker } from "../features/tracking-core/ReaderChannelPicker";
import type { AuditLocationGroup, AuditResult, Company } from "../types";

/**
 * Walk a whole building and reconcile everything read against everything in
 * scope. Any reader works, because reads arrive through the same global capture
 * a handheld scanner uses. The running set is reconciled on the server as you
 * go, so the tally stays live without holding it all in the browser.
 */
export function BuildingAudit() {
  const { armBulkCapture, rfidEnabled, setRfidEnabled, rfidReaderId, setRfidReaderId } = useScan();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [flagMissing, setFlagMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const seenSet = useRef<Set<string>>(new Set());
  const codesRef = useRef<string[]>([]);
  codesRef.current = codes;
  const companyRef = useRef("");
  companyRef.current = companyId;
  const lastLen = useRef(-1);

  useEffect(() => {
    api.listCompanies().then(setCompanies).catch(() => undefined);
  }, []);

  const addCode = useCallback((raw: string) => {
    const v = raw.trim();
    if (!v || seenSet.current.has(v)) return;
    seenSet.current.add(v);
    setCodes((c) => [...c, v]);
  }, []);

  const reconcile = useCallback(async () => {
    lastLen.current = codesRef.current.length;
    try {
      setResult(await api.auditReconcile(codesRef.current, companyRef.current || undefined));
    } catch {
      // A blip; the next tick retries.
    }
  }, []);

  // Auto-reconcile a few seconds after new reads land while walking.
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => {
      if (codesRef.current.length !== lastLen.current) void reconcile();
    }, 3000);
    return () => clearInterval(t);
  }, [scanning, reconcile]);

  useEffect(() => () => armBulkCapture(null), [armBulkCapture]);

  const start = async () => {
    setMsg(null);
    if (rfidEnabled) {
      try {
        await api.auditLiveClear(rfidReaderId); // A fresh walk starts clean.
      } catch {
        // ignore; we'll still pick up new reads
      }
    }
    setScanning(true);
    // Networked reader, camera and handheld scanner all arrive through the same
    // capture, which this claims for as long as the walk is running.
    armBulkCapture(addCode);
  };
  const stop = () => {
    setScanning(false);
    armBulkCapture(null);
    void reconcile();
  };
  const reset = () => {
    seenSet.current = new Set();
    setCodes([]);
    setResult(null);
    lastLen.current = -1;
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    addCode(manual);
    setManual("");
  };

  const apply = async () => {
    if (!result) return;
    const missingIds = flagMissing
      ? result.locations.flatMap((g) => g.missing.map((m) => m.id))
      : [];
    setBusy(true);
    try {
      const r = await api.auditApply(result.seenIds, missingIds);
      setScanning(false);
      armBulkCapture(null);
      reset();
      setMsg(
        `Applied: ${r.checked} marked checked${
          r.flaggedMissing ? `, ${r.flaggedMissing} flagged missing` : ""
        }.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const pct = result && result.totalItems ? Math.round((result.seenItems / result.totalItems) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Building audit</h1>
        <Link to="/audit" className="text-sm text-sky-400 hover:underline">
          Stock take, one place at a time
        </Link>
      </div>
      <p className="text-sm text-slate-400">
        Pick a scope, start, and walk with a reader. Everything read is reconciled against what
        is on file, grouped by where it should be.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          disabled={scanning}
          aria-label="Audit scope"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 disabled:opacity-60"
        >
          <option value="">Everything</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {!scanning ? (
          <button
            onClick={() => void start()}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            Start walking
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
          >
            Stop
          </button>
        )}
        <span className="text-sm text-slate-400">
          <span className="text-sky-300">{codes.length}</span> tag{codes.length === 1 ? "" : "s"} read
        </span>
        {(codes.length > 0 || result) && (
          <button
            onClick={reset}
            disabled={scanning}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Reset
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={rfidEnabled}
            onChange={(e) => setRfidEnabled(e.target.checked)}
          />
          Use M7e live reader
        </label>
        {rfidEnabled && (
          <ReaderChannelPicker value={rfidReaderId} onChange={setRfidReaderId} disabled={scanning} />
        )}
        {rfidEnabled && (
          <span className="text-xs text-slate-500">
            Streams EPCs the Raspberry Pi bridge pushes to “{rfidReaderId}”.
          </span>
        )}
      </div>

      {scanning && (
        <p className="animate-pulse text-sm text-sky-300">
          {rfidEnabled ? "Walking. Streaming reads from the reader…" : "Walking. Keep reading tags…"}
        </p>
      )}
      {msg && <p className="rounded-lg bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{msg}</p>}

      <form onSubmit={submitManual} className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type/scan a code here…"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
        />
        <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">
          Add
        </button>
        <button
          type="button"
          onClick={() => void reconcile()}
          disabled={!codes.length}
          className="rounded-lg border border-slate-700 px-4 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          Reconcile
        </button>
      </form>

      {result && (
        <>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3">
              <p className="text-2xl font-semibold text-emerald-400">{result.seenItems}</p>
              <p className="text-xs text-slate-400">Seen / {result.totalItems}</p>
            </div>
            <div className="rounded-xl border border-amber-900 bg-amber-950/30 p-3">
              <p className="text-2xl font-semibold text-amber-400">{result.missingItems}</p>
              <p className="text-xs text-slate-400">Not seen</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
              <p className="text-2xl font-semibold text-slate-300">{result.unknownCodes.length}</p>
              <p className="text-xs text-slate-400">Unknown tags</p>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={flagMissing}
                onChange={(e) => setFlagMissing(e.target.checked)}
              />
              Also flag the {result.missingItems} not-seen item
              {result.missingItems === 1 ? "" : "s"} as missing
            </label>
            <button
              onClick={apply}
              disabled={busy || result.seenItems === 0}
              className="mt-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy
                ? "Applying…"
                : `Apply: mark ${result.seenItems} checked${
                    flagMissing ? `, flag ${result.missingItems} missing` : ""
                  }`}
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Tip: only flag missing once you’ve walked the whole scope, or you’ll flag aisles you
              skipped.
            </p>
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              By location
            </h2>
            {result.locations.map((g) => (
              <LocationRow key={g.locationId ?? "none"} group={g} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function LocationRow({ group }: { group: AuditLocationGroup }) {
  const [open, setOpen] = useState(false);
  const complete = group.seen === group.total;
  const CAP = 50;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${complete ? "bg-emerald-500" : "bg-amber-500"}`} />
          {group.locationId ? (
            <Link
              to={`/locations/${group.locationId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-sky-400 hover:underline"
            >
              {group.locationName}
            </Link>
          ) : (
            <span className="text-sm text-slate-300">Unassigned</span>
          )}
        </span>
        <span className="text-xs text-slate-400">
          {group.seen}/{group.total}
          {group.missing.length > 0 && (
            <span className="ml-2 text-amber-400">{group.missing.length} not seen</span>
          )}
        </span>
      </button>
      {open && group.missing.length > 0 && (
        <ul className="space-y-1 px-3 pb-2">
          {group.missing.slice(0, CAP).map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <Link to={`/items/${m.id}`} className="truncate text-slate-300 hover:underline">
                {m.name}
              </Link>
              <span className="ml-auto font-mono text-xs text-slate-500">{m.assetCode}</span>
            </li>
          ))}
          {group.missing.length > CAP && (
            <li className="text-xs text-slate-500">…and {group.missing.length - CAP} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
