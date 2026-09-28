import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import { useScan } from "../../scan/ScanProvider";
import type { Location } from "../../types";
import { BUTTON, BUTTON_QUIET, FIELD } from "../../components/ui";
import { errorText, tagsApi } from "./api";
import { invalidateSummaries } from "./stores";
import type { BindSession, ReadOutcome, SessionEntry, SessionListing, TagType } from "./types";
import { NFC_HINT, nfc, nfcSupported, useNfcState, useNfcTaps } from "./webnfc";

const entryLabel = (e: SessionEntry) => `${e.name}${e.unitLabel ? ` · ${e.unitLabel}` : ""}`;

function NewSession({ onStarted }: { onStarted: (s: BindSession) => void }) {
  const terms = useTerms();
  const features = useFeatures();
  const [locations, setLocations] = useState<Location[]>([]);
  const [sessions, setSessions] = useState<SessionListing[]>([]);
  const [locationId, setLocationId] = useState("");
  const [tagType, setTagType] = useState<TagType>("rfid");
  const [includeSub, setIncludeSub] = useState(true);
  const [onlyUntagged, setOnlyUntagged] = useState(true);
  const [includeUnits, setIncludeUnits] = useState(features.units);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    tagsApi.sessions().then(setSessions).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(
    () => [...locations].sort((a, b) => label(a).localeCompare(label(b))),
    [locations, label],
  );

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!locationId) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await tagsApi.createSession({
          tagType,
          locationId,
          includeSubLocations: includeSub,
          onlyUntagged,
          includeUnits: features.units && includeUnits,
        }),
      );
    } catch (err) {
      setError(errorText(err, "Could not start"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <form onSubmit={start} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div>
          <h2 className="font-semibold text-slate-100">Bind a batch of tags</h2>
          <p className="mt-1 text-sm text-slate-400">
            Pick where the untagged {terms.item.plural.toLowerCase()} are. Then read tags one after
            another: each new tag binds to the next {terms.item.singular.toLowerCase()} in the list.
            Tags that are already bound are ignored.
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-200">
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={tagType === "rfid"} onChange={() => setTagType("rfid")} />
            RFID (UHF)
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" checked={tagType === "nfc"} onChange={() => setTagType("nfc")} />
            NFC
          </label>
        </div>
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          aria-label={terms.location.singular}
          className={FIELD}
          required
        >
          <option value="">Choose a {terms.location.singular.toLowerCase()}…</option>
          {sorted.map((l) => (
            <option key={l.id} value={l.id}>
              {label(l)}
            </option>
          ))}
        </select>
        <div className="flex flex-col gap-1.5 text-sm text-slate-300">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
            Include everything inside it
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={onlyUntagged} onChange={(e) => setOnlyUntagged(e.target.checked)} />
            Only {terms.item.plural.toLowerCase()} without {tagType === "rfid" ? "an RFID" : "an NFC"} tag
          </label>
          {features.units && (
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeUnits} onChange={(e) => setIncludeUnits(e.target.checked)} />
              One tag per tracked unit
            </label>
          )}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy || !locationId} className={BUTTON}>
          {busy ? "Starting…" : "Start binding"}
        </button>
      </form>

      {sessions.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold text-slate-100">Sessions in progress</h2>
          <ul className="mt-3 space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-slate-200">
                  {s.name}{" "}
                  <span className="text-slate-500">
                    {s.bound} bound, {s.remaining} left
                  </span>
                </span>
                <Link to={`/tags?tab=bind&session=${s.id}`} className="text-sky-400 hover:underline">
                  Resume
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function describeOutcome(outcome: ReadOutcome, boundTo: SessionEntry | null): { text: string; ok: boolean } | null {
  if (outcome.kind === "bound") {
    return { text: `Bound ${outcome.value} to ${boundTo ? entryLabel(boundTo) : "the next record"}.`, ok: true };
  }
  switch (outcome.reason) {
    case "repeat":
      return { text: `${outcome.value} is already bound in this session.`, ok: false };
    case "in_use":
      return { text: `${outcome.value} is already on ${outcome.heldBy ?? "another record"}. Ignored.`, ok: false };
    case "finished":
      return { text: "Everything in the list is done. Finish, or undo to redo the last one.", ok: false };
    default:
      return null;
  }
}

function SessionView({ id, onLeave }: { id: string; onLeave: () => void }) {
  const terms = useTerms();
  const { armBulkCapture, rfidEnabled, setRfidEnabled, rfidReaderId, setRfidReaderId } = useScan();
  const nfcState = useNfcState();
  const [session, setSession] = useState<BindSession | null>(null);
  const [last, setLast] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  // Reads arrive in bursts from a UHF reader; send them one at a time, in order.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const currentRef = useRef<SessionEntry | null>(null);

  useEffect(() => {
    tagsApi
      .session(id)
      .then(setSession)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the session"));
  }, [id]);
  useEffect(() => {
    currentRef.current = session?.current ?? null;
  }, [session]);

  const read = useCallback(
    (code: string) => {
      chain.current = chain.current.then(async () => {
        const target = currentRef.current;
        try {
          const { outcome, session: next } = await tagsApi.sessionRead(id, code);
          setSession(next);
          currentRef.current = next.current;
          const text = describeOutcome(outcome, target);
          if (text) setLast(text);
          if (outcome.kind === "bound") invalidateSummaries(outcome.itemId);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "That read failed");
        }
      });
    },
    [id],
  );

  const active = session?.status === "active";

  // Every scan while the session is open (desk reader, camera, networked
  // reader) comes here instead of opening a record.
  useEffect(() => {
    if (!active) return;
    armBulkCapture(read);
    return () => armBulkCapture(null);
  }, [active, armBulkCapture, read]);

  useNfcTaps(Boolean(active && session?.tagType === "nfc"), (tap) => {
    if (tap.uid) read(tap.uid);
    else setLast({ text: "That tag does not report an ID, so it cannot be bound.", ok: false });
  });

  const act = async (fn: () => Promise<BindSession>, note?: string) => {
    setError(null);
    try {
      const next = await fn();
      setSession(next);
      currentRef.current = next.current;
      setLast(note ? { text: note, ok: true } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work");
    }
  };

  if (!session) {
    return error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-slate-500">Loading…</p>;
  }

  const pct = session.total ? Math.round((session.position / session.total) * 100) : 100;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{session.name}</h2>
          <p className="text-sm text-slate-400">
            {session.bound} bound · {session.skipped} skipped · {session.remaining} left of {session.total}
          </p>
        </div>
        <button onClick={onLeave} className={BUTTON_QUIET}>
          All sessions
        </button>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>

      {active && session.current ? (
        <div className="rounded-xl border border-sky-800 bg-sky-950/30 p-5">
          <p className="text-xs uppercase tracking-wide text-sky-300">
            Next · {session.current.index + 1} of {session.total}
          </p>
          <p className="mt-1 text-xl font-semibold text-slate-100">{entryLabel(session.current)}</p>
          <p className="font-mono text-sm text-slate-400">
            {session.current.assetCode}
            {session.current.locationName ? ` · ${session.current.locationName}` : ""}
          </p>
          <p className="mt-3 text-sm text-slate-300">
            {session.tagType === "rfid"
              ? "Put a new tag on it and read the tag with the desk reader, or turn on the networked reader below."
              : nfcSupported
                ? "Put a new tag on it and tap the tag to the back of the phone, or read it with a desk reader."
                : "Put a new tag on it and read the tag with a desk reader."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-300">
          {active ? "Everything in the list has been bound or skipped." : "This session is finished."}
        </div>
      )}

      {last && <p className={`text-sm ${last.ok ? "text-emerald-400" : "text-amber-300"}`}>{last.text}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {active && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void act(() => tagsApi.sessionSkip(id), "Skipped.")} disabled={!session.current} className={BUTTON_QUIET}>
            Skip
          </button>
          <button
            onClick={() => void act(() => tagsApi.sessionUndo(id), "Undone.")}
            disabled={!session.canUndo}
            className={BUTTON_QUIET}
          >
            Undo last
          </button>
          <button
            onClick={() => {
              if (confirm("Finish this session? Tags already bound stay bound.")) void act(() => tagsApi.sessionFinish(id));
            }}
            className={BUTTON_QUIET}
          >
            Finish
          </button>
        </div>
      )}

      {active && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm">
          {session.tagType === "rfid" && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-slate-200">
                <input type="checkbox" checked={rfidEnabled} onChange={(e) => setRfidEnabled(e.target.checked)} />
                Networked reader
              </label>
              <input
                value={rfidReaderId}
                onChange={(e) => setRfidReaderId(e.target.value.trim())}
                aria-label="Reader channel"
                placeholder="Reader channel"
                className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100"
              />
              <span className="text-xs text-slate-500">
                Keep the reader at low power so only the tag in hand is read.
              </span>
            </div>
          )}
          {session.tagType === "nfc" &&
            (nfcSupported ? (
              nfcState.status !== "on" && (
                <button onClick={() => void nfc.start()} className={BUTTON_QUIET}>
                  Turn on NFC tapping
                </button>
              )
            ) : (
              <p className="text-xs text-slate-500">{NFC_HINT}</p>
            ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (manual.trim()) read(manual.trim());
              setManual("");
            }}
            className="flex gap-2"
          >
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Or type a tag ID"
              aria-label="Tag ID"
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-slate-100"
            />
            <button className={BUTTON_QUIET}>Bind</button>
          </form>
        </div>
      )}

      {session.upcoming.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Then</h3>
          <ol className="space-y-1 text-sm text-slate-400">
            {session.upcoming.map((e) => (
              <li key={e.index}>
                {e.index + 1}. {entryLabel(e)} <span className="font-mono text-xs text-slate-500">{e.assetCode}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {session.recent.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Done</h3>
          <ul className="space-y-1 text-sm">
            {session.recent.map((a, i) => (
              <li key={`${a.entry.index}-${i}`} className="flex flex-wrap items-center gap-2 text-slate-300">
                <Link to={`/items/${a.entry.itemId}${a.entry.unitId ? `?unit=${a.entry.unitId}` : ""}`} className="text-sky-400 hover:underline">
                  {entryLabel(a.entry)}
                </Link>
                {a.kind === "bind" ? (
                  <span className="font-mono text-xs text-slate-400">{a.value}</span>
                ) : (
                  <span className="text-xs text-slate-500">skipped</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-slate-500">
        Scans on this page bind tags instead of opening {terms.item.plural.toLowerCase()}.
      </p>
    </div>
  );
}

export function BulkBind({
  sessionId,
  onOpen,
}: {
  sessionId: string | null;
  onOpen: (id: string | null) => void;
}) {
  return sessionId ? (
    <SessionView id={sessionId} onLeave={() => onOpen(null)} />
  ) : (
    <NewSession onStarted={(s) => onOpen(s.id)} />
  );
}
