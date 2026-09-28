import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import type { Item } from "../../types";
import { tagsApi } from "./api";
import { invalidateSummaries } from "./stores";
import { nfc, nfcSupported, useNfcState, type NfcTap } from "./webnfc";

const PREF_KEY = "bindex.nfc.tap";
const UUID_PATH = /^\/(items|locations)\/[0-9a-fA-F-]{36}(?:\/|$)/;

/**
 * Where a tag's URL record should take the app, if anywhere: a page of this
 * instance, or an item or location link written by another address of it
 * (a tag written through a LAN address, read through the public one).
 */
export function inAppPath(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin === window.location.origin || UUID_PATH.test(u.pathname)) {
      return `${u.pathname}${u.search}`;
    }
  } catch {
    // Not a URL at all; fall through to the UID.
  }
  return null;
}

function NfcIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8.3a6 6 0 0 1 0 7.4" />
      <path d="M9.5 5.6a10 10 0 0 1 0 12.8" />
      <path d="M13 3a14 14 0 0 1 0 18" />
      <path d="M2.5 11v2" />
    </svg>
  );
}

/** Offer to bind a tag nobody knows yet to an existing record. */
function UnknownTag({ uid, onClose }: { uid: string; onClose: () => void }) {
  const terms = useTerms();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setError(null);
    try {
      setResults((await api.listItems({ q: q.trim() })).slice(0, 8));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    }
  };

  const bind = async (item: Item) => {
    setError(null);
    try {
      await tagsApi.bind(item.id, "nfc", uid);
      invalidateSummaries(item.id);
      onClose();
      navigate(`/items/${item.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Binding failed");
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-slate-700 bg-slate-900 p-4 shadow-2xl">
      <div className="mx-auto max-w-md space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-medium text-slate-100">Unknown tag</p>
            <p className="font-mono text-xs text-slate-400">{uid}</p>
          </div>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="text-sm text-slate-400">
          Nothing has this tag yet. Find the {terms.item.singular.toLowerCase()} it is stuck on to bind it.
        </p>
        <form onSubmit={search} className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${terms.item.plural.toLowerCase()}…`}
            aria-label={`Search ${terms.item.plural.toLowerCase()}`}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            autoFocus
          />
          <button className="rounded-lg bg-sky-600 px-3 text-sm font-medium text-white hover:bg-sky-500">Find</button>
        </form>
        <ul className="max-h-60 space-y-1 overflow-y-auto">
          {results.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => void bind(item)}
                className="flex w-full items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
              >
                <span className="truncate">{item.name}</span>
                <span className="ml-2 shrink-0 font-mono text-xs text-slate-500">{item.assetCode}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Tap to look up, from any screen: a floating NFC button on phones whose
 * browser supports Web NFC. While it is on, tapping a tag opens the record it
 * links to, or the record its UID is bound to (through the same scan path a
 * barcode takes), or offers to bind an unknown tag. Pages that want taps for
 * themselves (binding, bulk sessions) take them first.
 */
export function NfcTapLayer() {
  const { scan } = useScan();
  const navigate = useNavigate();
  const nfcState = useNfcState();
  const [unknown, setUnknown] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onTap = useCallback(
    async (tap: NfcTap) => {
      setNotice(null);
      const path = tap.url ? inAppPath(tap.url) : null;
      if (path) {
        navigate(path);
        return;
      }
      if (!tap.uid) {
        setNotice("That tag has no ID the phone can read and no link to this app. Write a link to it from a record's page.");
        return;
      }
      try {
        const hit = await tagsApi.resolve(tap.uid);
        if (hit.found) scan(tap.uid);
        else setUnknown(tap.uid);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Lookup failed");
      }
    },
    [navigate, scan],
  );

  useEffect(() => {
    if (!nfcSupported) return;
    nfc.setFallback((tap) => void onTap(tap));
    return () => nfc.setFallback(null);
  }, [onTap]);

  // Resume tap mode on the next visit, but only where permission was already
  // given: asking for it needs a tap on the button.
  useEffect(() => {
    if (!nfcSupported) return;
    let pref = false;
    try {
      pref = localStorage.getItem(PREF_KEY) === "1";
    } catch {
      // No storage, no resume.
    }
    if (!pref || !navigator.permissions) return;
    navigator.permissions
      .query({ name: "nfc" as PermissionName })
      .then((p) => {
        if (p.state === "granted") void nfc.start();
      })
      .catch(() => undefined);
  }, []);

  if (!nfcSupported) return null;

  const on = nfcState.status === "on";
  const toggle = async () => {
    const next = !on;
    try {
      localStorage.setItem(PREF_KEY, next ? "1" : "0");
    } catch {
      // Private browsing; the choice just will not stick.
    }
    if (next) {
      if (await nfc.start()) setNotice("NFC on. Tap a tag to the back of the phone.");
    } else {
      nfc.stop();
      setNotice(null);
    }
  };

  const error = nfcState.status === "error" ? nfcState.error : null;

  return (
    <>
      <div className="fixed bottom-24 right-5 z-40 flex flex-col items-end gap-2 print:hidden">
        {(notice || error) && (
          <p className="max-w-60 rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 text-xs text-slate-300 shadow-lg">
            {error ?? notice}
          </p>
        )}
        <button
          onClick={() => void toggle()}
          aria-pressed={on}
          aria-label={on ? "Stop NFC tap lookup" : "Look up NFC tags by tapping"}
          title={on ? "NFC tap lookup is on" : "Tap NFC tags to look them up"}
          className={`flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition active:scale-95 ${
            on ? "bg-emerald-600 text-white shadow-emerald-900/50" : "border border-slate-700 bg-slate-800 text-slate-300"
          }`}
        >
          <NfcIcon className={`h-6 w-6 ${on ? "animate-pulse" : ""}`} />
        </button>
      </div>
      {unknown && <UnknownTag uid={unknown} onClose={() => setUnknown(null)} />}
    </>
  );
}
