import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { BTN, BTN_QUIET, FIELD, LocationSelect, SELECT, errorText, useLocations } from "../jobs-core/ui";
import { placementApi } from "./api";
import { play, primeAudio } from "./sound";
import type { JobProgress, RoomStatus, SweepEntry } from "./types";
import { FULL_SCREEN, FloorBand, ModeHeader, labelCode, pathText, shortPath } from "./ui";

/**
 * Handheld sweep: pick the room, walk it with a reader, and see what belongs
 * here and is here, what is here but belongs elsewhere, and what should be
 * here and is not. Each batch of reads is saved as it arrives: lines that
 * belong are placed, lines that do not are flagged misplaced in this room.
 */

const FLUSH_MS = 300;

export function SweepMode() {
  const { id = "" } = useParams();
  const terms = useTerms();
  const { armBulkCapture, rfidEnabled, setRfidEnabled, rfidReaderId, setRfidReaderId } = useScan();
  const { options } = useLocations();
  const [params, setParams] = useSearchParams();
  const roomId = params.get("room") ?? "";
  const [info, setInfo] = useState<JobProgress | null>(null);
  const [nested, setNested] = useState(false);
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [active, setActive] = useState(false);
  const [entries, setEntries] = useState<SweepEntry[]>([]);
  const [seen, setSeen] = useState(0);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bleHint, setBleHint] = useState(false);
  const sessionCodes = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const current = useRef({ roomId, nested });
  current.current = { roomId, nested };

  useEffect(() => {
    placementApi
      .progress(id)
      .then(setInfo)
      .catch((err) => setError(errorText(err, "Could not load the job.")));
  }, [id]);

  // With Bluetooth room beacons installed, start in the room this phone is in.
  useEffect(() => {
    if (roomId) return;
    let live = true;
    void placementApi.bleRoom().then((room) => {
      if (live && room) {
        setParams({ room }, { replace: true });
        setBleHint(true);
      }
    });
    return () => {
      live = false;
    };
    // Only on arrival: a room picked by hand is not overridden.
  }, []);

  const loadStatus = useCallback(() => {
    if (!roomId) {
      setStatus(null);
      return;
    }
    placementApi
      .room(id, roomId, nested)
      .then(setStatus)
      .catch((err) => setError(errorText(err, "Could not load the room.")));
  }, [id, roomId, nested]);
  useEffect(() => loadStatus(), [loadStatus]);

  const reset = () => {
    sessionCodes.current = new Set();
    queue.current = [];
    setEntries([]);
    setSeen(0);
  };

  const flush = useCallback(async () => {
    timer.current = null;
    if (inFlight.current || !queue.current.length) return;
    const { roomId: room, nested: inside } = current.current;
    if (!room) return;
    const codes = queue.current.splice(0, queue.current.length);
    inFlight.current = true;
    try {
      const r = await placementApi.sweep(id, room, codes, inside);
      setStatus(r.status);
      setEntries((e) => [...r.entries, ...e]);
      setError(null);
      const bad = r.entries.some((x) => x.outcome === "not_on_job" || x.outcome === "misplaced");
      play(bad ? "alarm" : r.entries.some((x) => x.outcome === "placed") ? "ok" : "already");
    } catch (err) {
      // Put them back so the next batch retries them.
      queue.current.unshift(...codes);
      for (const c of codes) sessionCodes.current.delete(c);
      setError(errorText(err, "The reads could not be saved. They will be sent again with the next ones."));
    } finally {
      inFlight.current = false;
      if (queue.current.length && timer.current === null) timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    }
  }, [id]);

  const enqueue = useCallback(
    (raw: string) => {
      const code = raw.trim();
      // A reader repeats every tag it can see; each only needs saving once a sweep.
      if (!code || sessionCodes.current.has(code)) return;
      sessionCodes.current.add(code);
      setSeen(sessionCodes.current.size);
      queue.current.push(code);
      if (timer.current === null) timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    },
    [flush],
  );

  useEffect(() => {
    if (active) armBulkCapture(enqueue);
    return () => armBulkCapture(null);
  }, [active, enqueue, armBulkCapture]);

  const start = async () => {
    primeAudio();
    reset();
    if (rfidEnabled) await api.auditLiveClear(rfidReaderId).catch(() => undefined);
    setActive(true);
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    for (const c of manual.split(/[\s,]+/)) enqueue(c);
    setManual("");
  };

  const rooms = useMemo(() => {
    // The job's destinations first: those are the rooms worth sweeping.
    const own = (info?.byRoom ?? []).flatMap((r) => (r.destination ? [{ id: r.destination.id, label: pathText(r.destination) }] : []));
    const ids = new Set(own.map((o) => o.id));
    return [...own, ...options.filter((o) => !ids.has(o.id))];
  }, [info, options]);

  const extras = entries.filter((e) => e.outcome === "misplaced");
  const strangers = entries.filter((e) => e.outcome === "not_on_job" || e.outcome === "unknown");
  const other = entries.filter((e) => ["nearby", "no_destination", "held", "blocked"].includes(e.outcome));
  const belongs = status?.belongs;
  const extraSummary = (status?.extrasByDestination ?? [])
    .map((g) => `${g.count} ${g.destination ? `belong in ${g.destination.name}` : "with no destination"}`)
    .join(", ");

  return (
    <div className={FULL_SCREEN}>
      <ModeHeader jobId={id} title={info ? `${info.job.code} · sweep a room` : "Sweep a room"}>
        <LocationSelect
          value={roomId}
          onChange={(v) => {
            setActive(false);
            reset();
            setBleHint(false);
            setParams(v ? { room: v } : {}, { replace: true });
          }}
          options={rooms}
          label={`Room to sweep`}
          placeholder={`Pick the ${terms.location.singular.toLowerCase()}`}
          className={`${SELECT} max-w-xs`}
        />
      </ModeHeader>

      {error && <p className="bg-red-950/70 px-4 py-2 text-sm text-red-300">{error}</p>}

      <div className="flex-1 space-y-4 overflow-y-auto p-4 pb-24">
        {!roomId ? (
          <p className="py-10 text-center text-xl text-slate-400">Pick the room you are standing in.</p>
        ) : (
          status && (
            <>
              <FloorBand floor={status.room.floor} color={status.room.floorColor}>
                <span className="ml-2 font-normal">· {pathText(status.room)}</span>
              </FloorBand>
              {bleHint && <p className="text-xs text-sky-300">Picked from the Bluetooth beacon this device hears.</p>}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-4">
                  <p className="text-xs uppercase tracking-wide text-emerald-300">Belongs here</p>
                  <p className="text-4xl font-bold tabular-nums text-emerald-100">
                    {belongs?.placed ?? 0}/{belongs?.total ?? 0}
                  </p>
                </div>
                <div className="rounded-xl border border-orange-800 bg-orange-950/40 p-4">
                  <p className="text-xs uppercase tracking-wide text-orange-300">Extra</p>
                  <p className="text-4xl font-bold tabular-nums text-orange-100">{status.extras.length}</p>
                  {extraSummary && <p className="text-sm text-orange-200">({extraSummary})</p>}
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Read this sweep</p>
                  <p className="text-4xl font-bold tabular-nums text-slate-100">{seen}</p>
                  {strangers.length > 0 && <p className="text-sm text-red-300">{strangers.length} not on this job</p>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {!active ? (
                  <button onClick={() => void start()} className={BTN}>
                    Start sweep
                  </button>
                ) : (
                  <button
                    onClick={() => setActive(false)}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
                  >
                    Stop
                  </button>
                )}
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={rfidEnabled} onChange={(e) => setRfidEnabled(e.target.checked)} />
                  Use the live reader feed
                </label>
                {rfidEnabled && (
                  <input
                    value={rfidReaderId}
                    onChange={(e) => setRfidReaderId(e.target.value.trim())}
                    disabled={active}
                    aria-label="Reader channel"
                    className="w-32 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-60"
                  />
                )}
                <label
                  className="flex items-center gap-2 text-sm text-slate-400"
                  title="For a plan that names desks: things going to a desk in this room count as belonging here"
                >
                  <input type="checkbox" checked={nested} onChange={(e) => setNested(e.target.checked)} disabled={active} />
                  Count desks inside this room
                </label>
              </div>
              {active && <p className="animate-pulse text-sm text-sky-300">Sweeping. Every read is saved as it arrives.</p>}
              {!nested && status.nearby > 0 && (
                <p className="text-xs text-slate-500">
                  {status.nearby} {status.nearby === 1 ? "thing goes" : "things go"} to places inside this one; tick "Count
                  desks" to include them.
                </p>
              )}

              <form onSubmit={submitManual} className="flex gap-2">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="Or type codes"
                  aria-label="Codes"
                  className={FIELD}
                />
                <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600" disabled={!active}>
                  Add
                </button>
              </form>

              {status.extras.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-orange-300">Take these elsewhere</h2>
                  <ul className="mt-1 space-y-1">
                    {status.extras.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-900 bg-orange-950/30 px-3 py-2 text-sm">
                        <span className="text-slate-100">{l.itemName}</span>
                        <span className="font-mono text-xs text-slate-500">{labelCode(l)}</span>
                        <span className="ml-auto flex items-center gap-2 text-orange-200">
                          belongs in {shortPath(l.destination)}
                          <FloorBand floor={l.floor} color={l.floorColor} size="sm" />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {strangers.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-red-300">Not on this job</h2>
                  <ul className="mt-1 space-y-1">
                    {strangers.map((e) => (
                      <li key={e.code} className="rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-100">
                        {e.item?.name ?? e.code}
                        {e.otherJobs.length > 0 && (
                          <span className="ml-2 text-red-300">belongs to {e.otherJobs.map((j) => j.code).join(", ")}</span>
                        )}
                        {e.outcome === "unknown" && <span className="ml-2 text-red-300">unknown code</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {other.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Left as they were</h2>
                  <ul className="mt-1 space-y-1 text-sm text-slate-300">
                    {other.map((e) => (
                      <li key={e.code}>
                        {e.item?.name ?? e.code}:{" "}
                        {e.outcome === "nearby"
                          ? `goes to ${shortPath(e.line?.destination)}`
                          : e.outcome === "no_destination"
                            ? "no destination on the plan"
                            : e.outcome === "held"
                              ? "flagged damaged; left for a person"
                              : (e.reason ?? "refused")}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Should be here, not seen ({status.remaining.length})
                </h2>
                {status.remaining.length === 0 ? (
                  <p className="mt-1 text-sm text-emerald-300">Everything that belongs here is placed.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {status.remaining.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-sm">
                        <span className="text-slate-100">{l.itemName}</span>
                        <span className="font-mono text-xs text-slate-500">{labelCode(l)}</span>
                        {l.destinationLabel && <span className="text-slate-400">{l.destinationLabel}</span>}
                        <span className="ml-auto text-xs text-slate-500">{l.stage.replace(/_/g, " ")}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <button onClick={() => { reset(); loadStatus(); }} className={BTN_QUIET} disabled={active}>
                Start a new sweep
              </button>
            </>
          )
        )}
      </div>
    </div>
  );
}
