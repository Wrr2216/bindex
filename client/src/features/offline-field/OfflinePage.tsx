import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import { useScan } from "../../scan/ScanProvider";
import { BUTTON, BUTTON_QUIET, FIELD, Section, Toggle } from "../../components/ui";
import type { ItemDetail, Location } from "../../types";
import { offlineApi } from "./api";
import { clearCopy, makeAvailable, refreshAll, removeScope, turnOff, turnOn } from "./copy";
import * as store from "./store";
import { ageOf, useOfflineStatus } from "./status";
import { keepMine, keepServer, refreshQueueStatus, syncNow } from "./sync";
import type { FieldNote, LogEntry, OfflineScope, QueuedAction } from "./types";

const when = (iso: string) => new Date(iso).toLocaleString();

function formatBytes(n: number | null): string {
  if (n === null) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const errorOf = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** Re-reads the queue, the log and the copy whenever the shared status moves. */
function useDeviceData() {
  const status = useOfflineStatus();
  const [queue, setQueue] = useState<QueuedAction[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [scopes, setScopes] = useState<OfflineScope[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof store.stats>> | null>(null);

  const reload = useCallback(async () => {
    if (!status.supported) return;
    const [q, l, s, st] = await Promise.all([
      store.listQueue(),
      store.recentLog(15),
      store.scopes(),
      store.stats(),
    ]);
    setQueue(q);
    setLog(l);
    setScopes(s);
    setStats(st);
  }, [status.supported]);

  useEffect(() => {
    void reload();
  }, [
    reload,
    status.pending,
    status.attention,
    status.otherUsers,
    status.cacheAt,
    status.itemCount,
    status.lastSync,
    status.deviceEnabled,
  ]);

  return { status, queue, log, scopes, stats, reload };
}

function Attention({ entries, myOid }: { entries: QueuedAction[]; myOid: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!entries.length) return null;

  const decide = async (q: QueuedAction, mine: boolean) => {
    if (!mine && myOid !== null && q.userOid !== myOid) {
      const ok = window.confirm(`Discard ${q.userName}'s change "${q.action.label}"? It will not be sent.`);
      if (!ok) return;
    }
    setBusy(q.id);
    try {
      if (mine) await keepMine(q);
      else await keepServer(q);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Needs attention"
      description="These changes could not be sent as they were. Nothing here is sent or thrown away until you choose."
    >
      <ul className="mt-4 space-y-3">
        {entries.map((q) => {
          const someoneElse = myOid !== null && q.userOid !== myOid;
          const canKeepMine = !someoneElse && (q.status === "rejected" || q.conflict?.canKeepMine !== false);
          return (
            <li key={q.id} className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3">
              <p className="text-sm font-medium text-slate-100">{q.action.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Made {when(q.createdAt)}
                {q.userName ? ` by ${q.userName}` : ""}
              </p>
              <p className="mt-2 text-sm text-amber-300">
                {someoneElse
                  ? `Made by ${q.userName} on this device. It is sent when they sign in here again.`
                  : (q.conflict?.reason ?? q.lastError ?? "The server did not accept this change.")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {canKeepMine && (
                  <button
                    onClick={() => void decide(q, true)}
                    disabled={busy === q.id}
                    className={BUTTON}
                    title="Send my change anyway"
                  >
                    {q.status === "rejected" ? "Try again" : "Keep mine"}
                  </button>
                )}
                <button
                  onClick={() => void decide(q, false)}
                  disabled={busy === q.id}
                  className={BUTTON_QUIET}
                  title="Discard this change and keep what the server has"
                >
                  {q.status === "rejected" && !q.conflict ? "Discard" : "Keep the server's"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Scopes({
  scopes,
  online,
  deviceEnabled,
  onChange,
}: {
  scopes: OfflineScope[];
  online: boolean;
  deviceEnabled: boolean;
  onChange: () => void;
}) {
  const terms = useTerms();
  const [locations, setLocations] = useState<Location[]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [scopes.length]);

  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
      onChange();
    } catch (err) {
      setMessage(errorOf(err, "That did not work. Check the connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!choice) return;
    const locationId = choice === "__all" ? null : choice;
    void run(async () => {
      const snap = await makeAvailable(locationId);
      return `${snap.scope.name}: ${snap.items.length} ${terms.item.plural.toLowerCase()} now on this device.`;
    });
  };

  return (
    <Section
      title="Available offline"
      description={
        deviceEnabled
          ? `What this device keeps for working without a connection: a ${terms.location.singular.toLowerCase()} and everything in it, or everything when the inventory is small.`
          : `This device keeps nothing yet. Choose a ${terms.location.singular.toLowerCase()} to take with you; the app will then also open here without a connection.`
      }
      aside={
        scopes.length > 0 && (
          <button
            onClick={() => void run(async () => (await refreshAll(), "Offline copy refreshed."))}
            disabled={busy || !online}
            className={BUTTON_QUIET}
          >
            Refresh all
          </button>
        )
      }
    >
      <ul className="mt-4 space-y-2">
        {scopes.map((s) => (
          <li
            key={s.locationId ?? "__all"}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/60 px-3 py-2"
          >
            <span className="text-sm text-slate-200">
              <span className="font-medium text-slate-100">{s.name}</span>{" "}
              <span className="text-slate-400">
                · {s.itemCount} {terms.item.plural.toLowerCase()} · fetched {ageOf(s.fetchedAt)}
              </span>
            </span>
            <button
              onClick={() => void run(async () => (await removeScope(s.locationId), `${s.name} removed.`))}
              disabled={busy || !online}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Remove
            </button>
          </li>
        ))}
        {scopes.length === 0 && (
          <li className="text-sm text-slate-500">Nothing yet. Pick what to take with you below.</li>
        )}
      </ul>
      <form onSubmit={add} className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          aria-label={`${terms.location.singular} to make available offline`}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
        >
          <option value="">{`Choose a ${terms.location.singular.toLowerCase()}…`}</option>
          <option value="__all">{`Everything (all ${terms.item.plural.toLowerCase()})`}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {label(l)}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !choice || !online} className={BUTTON}>
          {busy ? "Working…" : "Make available offline"}
        </button>
      </form>
      {!online && <p className="mt-2 text-sm text-slate-500">Changing what is kept needs a connection.</p>}
      {message && <p className="mt-2 text-sm text-slate-400">{message}</p>}
    </Section>
  );
}

function FieldNotes() {
  const terms = useTerms();
  const { armCapture } = useScan();
  const [code, setCode] = useState("");
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [notes, setNotes] = useState<FieldNote[]>([]);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => () => armCapture(null), [armCapture]);

  const loadNotes = (id: string) => offlineApi.listNotes(id).then(setNotes).catch(() => setNotes([]));

  const find = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setMessage(null);
    try {
      const res = await api.scan(value);
      if (!res.found || !res.item) {
        setItem(null);
        setMessage(`Nothing matches ${value}.`);
        return;
      }
      setItem(res.item);
      void loadNotes(res.item.id);
    } catch (err) {
      setItem(null);
      setMessage(errorOf(err, "Could not look that up."));
    }
  };

  const scan = () => {
    setWaiting(true);
    armCapture((c) => {
      setWaiting(false);
      setCode(c);
      void find(c);
    });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!item || !text.trim()) return;
    try {
      const note = await offlineApi.addNote(item.id, text.trim());
      setText("");
      setMessage(note.queued ? "Saved on this device. It is sent when the connection is back." : "Note saved.");
      void loadNotes(item.id);
    } catch (err) {
      setMessage(errorOf(err, "Could not save the note."));
    }
  };

  return (
    <Section
      title="Field notes"
      description={`Scan a ${terms.item.singular.toLowerCase()} and write down what you found: damage, a missing part, where it really is. Notes are kept in its history.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void find(code);
        }}
        className="mt-4 flex flex-wrap gap-2"
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Type a code, or scan"
          aria-label="Code to look up"
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button type="submit" className={BUTTON_QUIET}>
          Look up
        </button>
        <button
          type="button"
          onClick={waiting ? () => (armCapture(null), setWaiting(false)) : scan}
          className={BUTTON_QUIET}
        >
          {waiting ? "Cancel" : "Scan"}
        </button>
      </form>
      {waiting && <p className="mt-2 animate-pulse text-sm text-sky-300">Scan a code now…</p>}

      {item && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-300">
            <Link to={`/items/${item.id}`} className="font-medium text-sky-400 hover:underline">
              {item.name}
            </Link>{" "}
            <span className="text-slate-500">
              · {item.locationName ?? "Unassigned"} · {item.assetCode}
            </span>
          </p>
          <form onSubmit={save} className="space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What did you find?"
              aria-label="Note"
              className={FIELD}
            />
            <button type="submit" disabled={!text.trim()} className={BUTTON}>
              Save note
            </button>
          </form>
          {notes.length > 0 && (
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg bg-slate-800/60 px-3 py-2 text-sm">
                  <p className="text-slate-200">{n.text}</p>
                  <p className="text-xs text-slate-500">
                    {when(n.writtenAt)}
                    {n.queued ? " · waiting to sync" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {message && <p className="mt-2 text-sm text-slate-400">{message}</p>}
    </Section>
  );
}

function ThisDevice({
  stats,
  log,
  onChange,
}: {
  stats: Awaited<ReturnType<typeof store.stats>> | null;
  log: LogEntry[];
  onChange: () => void;
}) {
  const status = useOfflineStatus();
  const terms = useTerms();
  const [busy, setBusy] = useState(false);

  const toggle = async (next: boolean) => {
    if (!next) {
      const waiting = status.pending + status.attention;
      const ok = window.confirm(
        `Stop working offline on this device? Its offline copy is deleted.${
          waiting ? ` The ${waiting} change(s) not yet sent are kept and still sent.` : ""
        }`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (next) await turnOn();
      else await turnOff();
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("Delete the offline copy on this device? Changes not yet sent are kept.")) return;
    setBusy(true);
    try {
      await clearCopy();
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const last = status.lastSync;

  return (
    <Section
      title="This device"
      description="These settings belong to this browser on this device, not to the instance."
      aside={
        <Toggle
          label="Work offline on this device"
          checked={status.deviceEnabled}
          onChange={(next) => void (busy ? undefined : toggle(next))}
        />
      }
    >
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase text-slate-500">Connection</dt>
          <dd className={status.online ? "text-emerald-400" : "text-amber-300"}>
            {status.online ? "Online" : "Offline"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Offline copy</dt>
          <dd className="text-slate-200">
            {stats ? `${stats.items} ${terms.item.plural.toLowerCase()}` : "…"}
            {status.cacheAt && <span className="text-slate-500"> · {ageOf(status.cacheAt)}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Waiting to send</dt>
          <dd className="text-slate-200">
            {status.pending}
            {status.attention > 0 && <span className="text-amber-300"> · {status.attention} need attention</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Last sync</dt>
          <dd className="text-slate-200">
            {last ? (
              <>
                {ageOf(last.at)}
                <span className="text-slate-500">
                  {" "}
                  · {last.sent} sent{last.skipped ? `, ${last.skipped} already done` : ""}
                </span>
              </>
            ) : (
              "Never"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Photos waiting</dt>
          <dd className="text-slate-200">{stats ? formatBytes(stats.photoBytes) : "…"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Storage used</dt>
          <dd className="text-slate-200" title="Includes the app itself, kept for opening offline">
            {stats ? formatBytes(stats.usage) : "…"}
            {stats?.quota ? <span className="text-slate-500"> of {formatBytes(stats.quota)}</span> : null}
          </dd>
        </div>
      </dl>
      {last?.error && <p className="mt-3 text-sm text-amber-300">{last.error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => void syncNow().then(onChange)}
          disabled={status.syncing || !status.online || status.pending === 0}
          className={BUTTON}
        >
          {status.syncing ? "Sending…" : "Sync now"}
        </button>
        <button onClick={() => void clear()} disabled={busy || !stats?.items} className={BUTTON_QUIET}>
          Clear offline copy
        </button>
      </div>

      {log.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Recently sent</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {log.map((l) => (
              <li key={`${l.id}-${l.at}`} className="text-slate-300">
                <span
                  className={
                    l.outcome === "discarded"
                      ? "text-slate-500 line-through"
                      : l.outcome === "skipped"
                        ? "text-slate-400"
                        : "text-slate-200"
                  }
                >
                  {l.label}
                </span>{" "}
                <span className="text-xs text-slate-500">
                  · {ageOf(l.at)}
                  {l.note ? ` · ${l.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/**
 * Working without a connection: what this device keeps, what is waiting to be
 * sent, what needs a decision, and notes from the field.
 */
export function OfflinePage() {
  const { user } = useAuth();
  const { status, queue, log, scopes, stats, reload } = useDeviceData();

  const changed = useCallback(() => {
    void refreshQueueStatus().then(reload);
  }, [reload]);

  if (!status.supported) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">Work offline</h1>
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          This browser does not let the app keep data on the device (private browsing, or storage
          turned off), so it cannot work offline here. Everything still works with a connection.
        </p>
      </div>
    );
  }

  const myOid = user?.oid ?? null;
  const attention = queue.filter((q) => q.status !== "pending" || (myOid && q.userOid !== myOid));
  const pending = queue.filter((q) => q.status === "pending" && (!myOid || q.userOid === myOid));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Work offline</h1>
        <p className="mt-1 text-sm text-slate-400">
          Keep a copy on this device for basements, trucks and steel buildings. Scans, moves,
          check-outs, spot checks, audits, notes and photos keep working without a signal and are
          sent when it comes back.
        </p>
      </div>

      <Attention entries={attention} myOid={myOid} />

      {pending.length > 0 && (
        <Section title="Waiting to send" description="Sent oldest first as soon as there is a connection.">
          <ul className="mt-4 space-y-1.5">
            {pending.map((q) => (
              <li key={q.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-800/60 px-3 py-2 text-sm">
                <span className="text-slate-200">{q.action.label}</span>
                <span className="text-xs text-slate-500">
                  {when(q.createdAt)}
                  {q.lastError ? ` · last try: ${q.lastError}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Scopes
        scopes={scopes}
        online={status.online}
        deviceEnabled={status.deviceEnabled}
        onChange={changed}
      />

      <FieldNotes />

      <ThisDevice stats={stats} log={log} onChange={changed} />
    </div>
  );
}
