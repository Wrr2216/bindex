import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Item, Location } from "../types";
import { useScan } from "../scan/ScanProvider";
import { useFeatures } from "../config/useConfig";

/**
 * Stock take for one place: scan what is there, and see present, missing and
 * unexpected update as you go. Anything found in the wrong place can be moved
 * into this one without leaving the screen.
 */
export function Audit() {
  const { armCapture } = useScan();
  const features = useFeatures();
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [expected, setExpected] = useState<Item[]>([]);
  const [foundIds, setFoundIds] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<Item[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);

  useEffect(() => {
    setFoundIds(new Set());
    setExtras([]);
    setUnknown([]);
    if (!locationId) {
      setExpected([]);
      return;
    }
    api.listItems({ locationId }).then(setExpected).catch(() => setExpected([]));
  }, [locationId]);

  // The scan handler is registered once, so it reads current state through
  // refs rather than closing over a stale render.
  const ref = useRef({ locationId, expected });
  ref.current = { locationId, expected };
  const scanningRef = useRef(false);

  const processCode = useCallback(async (code: string) => {
    try {
      const res = await api.scan(code);
      if (!res.found || !res.item) {
        setUnknown((u) => (u.includes(code) ? u : [...u, code]));
        return;
      }
      const item = res.item;
      if (ref.current.expected.some((e) => e.id === item.id)) {
        setFoundIds((s) => new Set(s).add(item.id));
      } else {
        setExtras((x) => (x.some((e) => e.id === item.id) ? x : [...x, item]));
      }
    } catch {
      setUnknown((u) => (u.includes(code) ? u : [...u, code]));
    }
  }, []);

  const handlerRef = useRef<(code: string) => void>(() => {});
  handlerRef.current = (code: string) => {
    if (scanningRef.current) armCapture((c) => handlerRef.current(c)); // re-arm immediately
    void processCode(code);
  };

  const start = () => {
    if (!locationId) return;
    scanningRef.current = true;
    setScanning(true);
    armCapture((c) => handlerRef.current(c));
  };
  const stop = () => {
    scanningRef.current = false;
    setScanning(false);
    armCapture(null);
  };

  useEffect(() => () => armCapture(null), [armCapture]); // release on unmount

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const c = manual.trim();
    if (c) {
      void processCode(c);
      setManual("");
    }
  };

  const moveHere = async (item: Item) => {
    await api.updateItem(item.id, { locationId });
    setExtras((x) => x.filter((e) => e.id !== item.id));
    setExpected((exp) => [...exp, { ...item, locationId }]);
    setFoundIds((s) => new Set(s).add(item.id));
  };

  const present = expected.filter((e) => foundIds.has(e.id));
  const missing = expected.filter((e) => !foundIds.has(e.id));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Stock take</h1>
        <div className="flex flex-wrap items-center gap-4">
          {features.registerReconcile && (
            <Link to="/audit/register" className="text-sm text-sky-400 hover:underline">
              Reconcile against a register
            </Link>
          )}
          <Link to="/audit/building" className="text-sm text-sky-400 hover:underline">
            Audit the whole building
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          disabled={scanning}
          aria-label="Location to audit"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 disabled:opacity-60"
        >
          <option value="">Select a location…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {!scanning ? (
          <button
            onClick={start}
            disabled={!locationId}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Start scanning
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
          >
            Stop
          </button>
        )}
      </div>

      {scanning && (
        <p className="animate-pulse text-sm text-sky-300">
          Scanning. Point your reader at items in this location…
        </p>
      )}

      {locationId && (
        <>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3">
              <p className="text-2xl font-semibold text-emerald-400">{present.length}</p>
              <p className="text-xs text-slate-400">Present</p>
            </div>
            <div className="rounded-xl border border-amber-900 bg-amber-950/30 p-3">
              <p className="text-2xl font-semibold text-amber-400">{missing.length}</p>
              <p className="text-xs text-slate-400">Missing</p>
            </div>
            <div className="rounded-xl border border-sky-900 bg-sky-950/30 p-3">
              <p className="text-2xl font-semibold text-sky-400">{extras.length}</p>
              <p className="text-xs text-slate-400">Unexpected</p>
            </div>
          </div>

          <form onSubmit={submitManual} className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Or type/scan a code here…"
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            />
            <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">
              Mark
            </button>
          </form>

          <AuditList title="Missing" tone="amber" items={missing} />
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Unexpected ({extras.length})
            </h2>
            {extras.length === 0 ? (
              <p className="text-sm text-slate-500">None.</p>
            ) : (
              <ul className="space-y-1.5">
                {extras.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-sm"
                  >
                    <Link to={`/items/${item.id}`} className="truncate text-slate-200 hover:underline">
                      {item.name}
                      <span className="ml-2 text-slate-500">
                        ({item.locationName ?? "no location"})
                      </span>
                    </Link>
                    <button
                      onClick={() => moveHere(item)}
                      className="ml-2 shrink-0 rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
                    >
                      Move here
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <AuditList title="Present" tone="emerald" items={present} />

          {unknown.length > 0 && (
            <p className="text-sm text-slate-500">
              Unrecognized codes: <span className="font-mono">{unknown.join(", ")}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function AuditList({ title, items, tone }: { title: string; items: Item[]; tone: "emerald" | "amber" }) {
  const dot = tone === "emerald" ? "bg-emerald-500" : "bg-amber-500";
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
              <Link to={`/items/${item.id}`} className="truncate text-slate-200 hover:underline">
                {item.name}
              </Link>
              <span className="ml-auto font-mono text-xs text-slate-500">{item.assetCode}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
