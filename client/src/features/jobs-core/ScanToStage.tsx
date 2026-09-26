import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { jobsApi } from "./api";
import { play, primeAudio, type Cue } from "./sound";
import type { AdvanceResult, JobsMeta, LineOutcome } from "./types";
import { BTN, BTN_QUIET, CARD, FIELD, H2, SELECT, errorText, stageInfo } from "./ui";

/**
 * Scan to stage: every read (handheld, camera, or the networked reader feed)
 * moves the matching manifest line to the chosen stage, and each read gets a
 * colour and a sound a crew can follow without reading: green advanced, grey
 * already done, red not on this job or wrong shipment.
 */

type Tone = "ok" | "already" | "wrong" | "stranger" | "unknown" | "blocked";

type FeedEntry = {
  id: number;
  tone: Tone;
  title: string;
  name: string;
  detail: string;
  code: string | null;
};

const TONE: Record<Tone, { row: string; big: string }> = {
  ok: { row: "border-emerald-800 bg-emerald-950/40 text-emerald-200", big: "bg-emerald-600 text-white" },
  already: { row: "border-slate-700 bg-slate-800/50 text-slate-300", big: "bg-slate-700 text-slate-100" },
  wrong: { row: "border-orange-700 bg-orange-950/50 text-orange-200", big: "bg-orange-600 text-white" },
  stranger: { row: "border-red-700 bg-red-950/50 text-red-200", big: "bg-red-600 text-white" },
  unknown: { row: "border-fuchsia-800 bg-fuchsia-950/40 text-fuchsia-200", big: "bg-fuchsia-700 text-white" },
  blocked: { row: "border-amber-700 bg-amber-950/50 text-amber-200", big: "bg-amber-600 text-white" },
};

const FEED_CAP = 100;
const FLUSH_MS = 150;

function where(o: LineOutcome): string {
  const dest = [o.destinationName, o.destinationLabel].filter(Boolean).join(" · ");
  const parts = [dest ? `To ${dest}` : null, o.floor ? `floor ${o.floor}` : null, o.crateNo ? `crate ${o.crateNo}` : null];
  return parts.filter(Boolean).join(" · ");
}

export function ScanToStage({
  jobId,
  meta,
  shipments,
  lockedShipmentId,
  defaultStage,
  active,
  onActiveChange,
  onChanged,
}: {
  jobId: string;
  meta: JobsMeta | null;
  shipments: { id: string; code: string; name: string; status: string }[];
  /** On a shipment's own page the shipment is fixed. */
  lockedShipmentId?: string;
  /** The stage picked when the panel opens. */
  defaultStage?: string;
  /** Whether this panel owns the page's scan capture. */
  active: boolean;
  onActiveChange: (on: boolean) => void;
  onChanged: () => void;
}) {
  const terms = useTerms();
  const { armBulkCapture, rfidEnabled, setRfidEnabled, rfidReaderId, setRfidReaderId } = useScan();
  const [stage, setStage] = useState(defaultStage ?? (lockedShipmentId ? "loaded" : "packed"));
  const [shipmentId, setShipmentId] = useState(lockedShipmentId ?? "");
  const [force, setForce] = useState(false);
  const [muted, setMuted] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [counts, setCounts] = useState<Record<Tone, number>>({
    ok: 0,
    already: 0,
    wrong: 0,
    stranger: 0,
    unknown: 0,
    blocked: 0,
  });
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const queue = useRef<string[]>([]);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const settings = useRef({ stage, shipmentId, force, muted, rfidEnabled });
  settings.current = { stage, shipmentId, force, muted, rfidEnabled };

  const stageLabel = (s: string) => stageInfo(meta, s).label;

  const record = useCallback(
    (result: AdvanceResult) => {
      const label = stageInfo(meta, result.stage).label;
      const entries: FeedEntry[] = [];
      const add = (tone: Tone, title: string, name: string, detail: string, code: string | null) =>
        entries.push({ id: ++seq.current, tone, title, name, detail, code });
      for (const o of result.advanced) add("ok", label, o.itemName, where(o), o.code);
      for (const o of result.alreadyAt)
        add("already", `Already ${stageInfo(meta, o.stage).label.toLowerCase()}`, o.itemName, where(o), o.code);
      for (const o of result.wrongShipment)
        add("wrong", "Wrong shipment", o.itemName, `It is on ${o.shipmentCode ?? "another shipment"}. Keep it off this one.`, o.code);
      for (const n of result.notOnJob)
        add(
          "stranger",
          "Not on this job",
          n.itemName,
          n.otherJobs.length ? `Belongs to ${n.otherJobs.map((j) => j.code).join(", ")}` : "Not on any open job.",
          n.code,
        );
      for (const code of result.unknown) add("unknown", "Unknown code", code, `No ${terms.item.singular.toLowerCase()} has this code.`, code);
      for (const o of result.blocked) add("blocked", "Blocked", o.itemName, o.reason, o.code);

      setFeed((f) => [...entries.reverse(), ...f].slice(0, FEED_CAP));
      setCounts((c) => {
        const next = { ...c };
        for (const e of entries) next[e.tone] += 1;
        return next;
      });
      if (!settings.current.muted && entries.length) {
        const bad = entries.some((e) => e.tone !== "ok" && e.tone !== "already");
        const cue: Cue = bad ? "error" : entries.some((e) => e.tone === "ok") ? "ok" : "already";
        play(cue);
      }
      if (result.advanced.length) onChanged();
    },
    [meta, onChanged, terms.item.singular],
  );

  const send = useCallback(
    async (codes: string[], via: string) => {
      const s = settings.current;
      setError(null);
      try {
        const result = await jobsApi.advance(jobId, codes, {
          stage: s.stage,
          shipmentId: s.shipmentId || null,
          via,
          force: s.force || undefined,
        });
        record(result);
      } catch (err) {
        setError(errorText(err, "The scans could not be saved. They were not applied."));
        if (!s.muted) play("error");
      }
    },
    [jobId, record],
  );

  const flush = useCallback(async () => {
    timer.current = null;
    if (inFlight.current || queue.current.length === 0) return;
    const codes = queue.current.splice(0, queue.current.length);
    inFlight.current = true;
    try {
      await send(codes, settings.current.rfidEnabled ? "rfid" : "scan");
    } finally {
      inFlight.current = false;
      if (queue.current.length) timer.current = window.setTimeout(() => void flush(), 0);
    }
  }, [send]);

  // Reads arrive one by one; a short pause lets a reader's burst go as one batch.
  const enqueue = useCallback(
    (code: string) => {
      queue.current.push(code);
      if (timer.current === null) timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    },
    [flush],
  );

  // Arm only. The page owns the capture and disarms it when nothing on the
  // page wants it, so two panels handing it between them cannot race.
  useEffect(() => {
    if (active) armBulkCapture(enqueue);
  }, [active, enqueue, armBulkCapture]);

  const start = async () => {
    primeAudio();
    if (rfidEnabled) {
      // The reader feed only reports a tag once per channel; clearing it lets
      // a box read at packing be read again at the truck.
      await api.auditLiveClear(rfidReaderId).catch(() => undefined);
    }
    onActiveChange(true);
  };

  const submitManual = async (e: FormEvent) => {
    e.preventDefault();
    const codes = manual
      .split(/[\s,]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!codes.length) return;
    primeAudio();
    setManual("");
    await send(codes, "manual");
  };

  const last = feed[0];
  const stages = meta?.stages.filter((s) => s.name !== "pending") ?? [];
  const shipment = shipments.find((s) => s.id === shipmentId);

  return (
    <section className={`${CARD} space-y-3`} aria-label="Scan to stage">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>Scan to stage</h2>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-emerald-300">{counts.ok} advanced</span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">{counts.already} already</span>
          <span className="rounded-full bg-orange-950 px-2 py-0.5 text-orange-300">{counts.wrong} wrong shipment</span>
          <span className="rounded-full bg-red-950 px-2 py-0.5 text-red-300">{counts.stranger} not on job</span>
          {counts.unknown + counts.blocked > 0 && (
            <span className="rounded-full bg-fuchsia-950 px-2 py-0.5 text-fuchsia-300">
              {counts.unknown + counts.blocked} other
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-400" htmlFor={`stage-${jobId}`}>
          Mark as
        </label>
        <select
          id={`stage-${jobId}`}
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          className={SELECT}
        >
          {stages.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={shipmentId}
          onChange={(e) => setShipmentId(e.target.value)}
          disabled={Boolean(lockedShipmentId)}
          aria-label="Shipment"
          className={`${SELECT} disabled:opacity-70`}
        >
          <option value="">Any shipment</option>
          {shipments.map((s) => (
            <option key={s.id} value={s.id} disabled={s.status === "closed"}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
        {!active ? (
          <button onClick={() => void start()} className={BTN}>
            Start scanning
          </button>
        ) : (
          <button
            onClick={() => onActiveChange(false)}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
          >
            Stop
          </button>
        )}
        <button onClick={() => setMuted((m) => !m)} className={BTN_QUIET} aria-pressed={muted}>
          {muted ? "Sound off" : "Sound on"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-slate-300">
          <input type="checkbox" checked={rfidEnabled} onChange={(e) => setRfidEnabled(e.target.checked)} />
          Use the live reader feed
        </label>
        {rfidEnabled && (
          <input
            value={rfidReaderId}
            onChange={(e) => setRfidReaderId(e.target.value.trim())}
            disabled={active}
            aria-label="Reader channel"
            placeholder="reader id"
            className="w-32 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-60"
          />
        )}
        <label className="flex items-center gap-2 text-slate-400" title="Move lines back a stage, or off another shipment onto this one">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Override (move back, or across shipments)
        </label>
      </div>

      {stage === "loaded" && !shipmentId && (
        <p className="text-xs text-amber-300">
          Pick a shipment so each line is recorded on the truck it went on, and anything scanned at the wrong truck is caught.
        </p>
      )}
      {active && (
        <p className="animate-pulse text-sm text-sky-300">
          Scanning to {stageLabel(stage).toLowerCase()}
          {shipment ? ` on ${shipment.code}` : ""}. Every read counts.
        </p>
      )}

      <form onSubmit={(e) => void submitManual(e)} className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type a code (several separated by spaces)"
          aria-label="Code to stage"
          className={FIELD}
        />
        <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">Apply</button>
      </form>

      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}

      {last && (
        <div className={`rounded-xl px-4 py-3 ${TONE[last.tone].big}`} role="status" aria-live="assertive">
          <p className="text-2xl font-bold uppercase tracking-wide">{last.title}</p>
          <p className="text-lg">{last.name}</p>
          {last.detail && <p className="text-sm opacity-90">{last.detail}</p>}
        </div>
      )}

      {feed.length > 1 && (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {feed.slice(1).map((e) => (
            <li key={e.id} className={`flex flex-wrap items-baseline gap-x-2 rounded-lg border px-3 py-1.5 text-sm ${TONE[e.tone].row}`}>
              <span className="font-semibold uppercase">{e.title}</span>
              <span>{e.name}</span>
              {e.detail && <span className="text-xs opacity-80">{e.detail}</span>}
              {e.code && <span className="ml-auto font-mono text-xs opacity-60">{e.code}</span>}
            </li>
          ))}
        </ul>
      )}
      {feed.length === 0 && (
        <p className="text-xs text-slate-500">
          Start, then scan labels with a handheld reader or the camera button, or turn on the live reader feed. Each result
          appears here as it lands.
        </p>
      )}
    </section>
  );
}
