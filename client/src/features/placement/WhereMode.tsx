import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { BTN_QUIET, FIELD, SELECT, errorText } from "../jobs-core/ui";
import { placementApi } from "./api";
import { play, primeAudio, type Cue } from "./sound";
import type { Card, JobProgress } from "./types";
import { FULL_SCREEN, FloorBand, ModeHeader, floorText, labelCode, pathText, shortPath } from "./ui";

/**
 * "Where does this go?" for the crew at the truck: scan a label (handheld,
 * camera, desk reader or the live reader feed) and the whole screen says
 * where it goes, in a colour per floor that reads from across a corridor.
 * Anything that is not on this job, or came off the wrong truck, turns the
 * screen red and sounds an alarm.
 */

type Shown = { card: Card; placed: boolean; placing: boolean; error: string | null };

const RECENT = 12;

const CUE: Record<Card["outcome"], Cue> = {
  ok: "ok",
  no_destination: "warn",
  already_placed: "already",
  wrong_shipment: "alarm",
  not_on_job: "alarm",
  unknown: "warn",
};

function Headline({ card }: { card: Card }) {
  const terms = useTerms();
  switch (card.outcome) {
    case "wrong_shipment":
      return (
        <div className="bg-red-600 px-6 py-6 text-white">
          <p className="text-4xl font-black uppercase tracking-wide sm:text-6xl">Wrong truck</p>
          <p className="mt-2 text-xl">
            Planned for {card.line?.shipmentCode ?? "another shipment"}
            {card.shipment ? `, not ${card.shipment.code}` : ""}. Set it aside and tell the crew lead.
          </p>
          {card.recorded && <p className="mt-1 text-sm opacity-90">Flagged on the job.</p>}
        </div>
      );
    case "not_on_job":
      return (
        <div className="bg-red-600 px-6 py-6 text-white">
          <p className="text-4xl font-black uppercase tracking-wide sm:text-6xl">Not on this job</p>
          <p className="mt-2 text-xl">
            {card.otherJobs.length
              ? `It belongs to ${card.otherJobs.map((j) => j.code).join(", ")}.`
              : `No open job moves this ${terms.item.singular.toLowerCase()}.`}{" "}
            Keep it off this delivery.
          </p>
        </div>
      );
    case "unknown":
      return (
        <div className="bg-fuchsia-700 px-6 py-6 text-white">
          <p className="text-4xl font-black uppercase tracking-wide">Unknown label</p>
          <p className="mt-2 text-xl">No {terms.item.singular.toLowerCase()} has the code {card.code}.</p>
        </div>
      );
    case "no_destination":
      return (
        <div className="bg-amber-600 px-6 py-6 text-white">
          <p className="text-4xl font-black uppercase tracking-wide">No destination</p>
          <p className="mt-2 text-xl">It is on this job, but the plan does not say where it goes. Ask the crew lead.</p>
        </div>
      );
    case "already_placed":
      return (
        <FloorBand floor={card.line?.floor ?? null} color="#334155" size="xl">
          <span className="ml-4 text-2xl font-semibold normal-case">already placed</span>
        </FloorBand>
      );
    default:
      return <FloorBand floor={card.line?.floor ?? null} color={card.line?.floorColor ?? "#475569"} size="xl" />;
  }
}

function CardView({ shown, onPlace }: { shown: Shown; onPlace: () => void }) {
  const terms = useTerms();
  const { card } = shown;
  const line = card.line;
  const dest = line?.destination ?? null;
  const other = card.outcome === "not_on_job" ? card.otherJobs[0] : undefined;
  const canPlace = line && dest && (card.outcome === "ok" || card.outcome === "wrong_shipment") && !shown.placed;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="status" aria-live="assertive">
      <Headline card={card} />
      <div className="flex-1 space-y-4 px-6 py-5">
        {dest && (
          <div>
            <p className="text-sm uppercase tracking-wide text-slate-400">Goes to</p>
            <p className="text-5xl font-bold leading-tight text-slate-50 sm:text-7xl">{dest.name}</p>
            <p className="mt-1 text-lg text-slate-300">{pathText(dest)}</p>
          </div>
        )}
        {other && (
          <div>
            <p className="text-sm uppercase tracking-wide text-slate-400">On {other.code} it goes to</p>
            <p className="text-3xl font-bold text-slate-50">{other.destination ? shortPath(other.destination) : "no destination yet"}</p>
          </div>
        )}
        {line && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-lg sm:grid-cols-4">
            {line.destinationLabel && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Desk</dt>
                <dd className="text-2xl font-semibold text-slate-100">{line.destinationLabel}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Floor</dt>
              <dd className="text-slate-100">{floorText(line.floor)}</dd>
            </div>
            {line.department && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Department</dt>
                <dd className="text-slate-100">{line.department}</dd>
              </div>
            )}
            {line.crateNo && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Crate</dt>
                <dd className="text-slate-100">{line.crateNo}</dd>
              </div>
            )}
          </dl>
        )}
        {card.item && (
          <p className="text-lg text-slate-300">
            {card.item.name}
            {line?.unitLabel ? ` · ${line.unitLabel}` : ""}{" "}
            <span className="font-mono text-sm text-slate-500">{line ? labelCode(line) : card.item.assetCode}</span>
          </p>
        )}
        {(card.handlingNotes.length > 0 || line?.notes) && (
          <div className="rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Handling</p>
            {card.handlingNotes.map((n) => (
              <p key={n} className="text-lg text-amber-100">
                {n}
              </p>
            ))}
            {line?.notes && <p className="text-lg text-amber-100">{line.notes}</p>}
          </div>
        )}
        {shown.error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-red-300">{shown.error}</p>}
      </div>
      {line && (canPlace || shown.placed) && (
        <div className="border-t border-slate-800 p-4">
          {shown.placed ? (
            <p className="rounded-xl bg-emerald-700 px-6 py-5 text-center text-2xl font-bold text-white">
              Placed in {dest ? dest.name : "its room"}
            </p>
          ) : (
            <button
              onClick={onPlace}
              disabled={shown.placing}
              className="w-full rounded-xl bg-emerald-600 px-6 py-5 text-2xl font-bold text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              {shown.placing ? "Saving…" : `Placed here${card.outcome === "wrong_shipment" ? " anyway" : ""}`}
            </button>
          )}
          <p className="mt-2 text-center text-sm text-slate-500">
            Scan the next {terms.item.singular.toLowerCase()} at any time.
          </p>
        </div>
      )}
    </div>
  );
}

export function WhereMode() {
  const { id = "" } = useParams();
  const terms = useTerms();
  const { armBulkCapture } = useScan();
  const [params, setParams] = useSearchParams();
  const shipmentId = params.get("shipment") ?? "";
  const [info, setInfo] = useState<JobProgress | null>(null);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [recent, setRecent] = useState<Card[]>([]);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const settings = useRef({ shipmentId, muted });
  settings.current = { shipmentId, muted };

  useEffect(() => {
    placementApi
      .progress(id)
      .then(setInfo)
      .catch((err) => setError(errorText(err, "Could not load the job.")));
  }, [id]);

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (queue.current.length) {
        const code = queue.current.shift()!;
        try {
          const card = await placementApi.lookup(id, code, { shipmentId: settings.current.shipmentId || null });
          setError(null);
          setShown({ card, placed: false, placing: false, error: null });
          setRecent((r) => [card, ...r].slice(0, RECENT));
          if (!settings.current.muted) play(CUE[card.outcome]);
        } catch (err) {
          setError(errorText(err, "That scan could not be looked up."));
          if (!settings.current.muted) play("warn");
        }
      }
    } finally {
      busy.current = false;
    }
  }, [id]);

  const enqueue = useCallback(
    (code: string) => {
      queue.current.push(code);
      void drain();
    },
    [drain],
  );

  useEffect(() => {
    if (started) armBulkCapture(enqueue);
    return () => armBulkCapture(null);
  }, [started, enqueue, armBulkCapture]);

  const place = async () => {
    if (!shown?.card.line) return;
    const card = shown.card;
    setShown({ ...shown, placing: true, error: null });
    try {
      const r = await placementApi.place(id, [card.line!.id], card.code);
      if (r.blocked.length) {
        setShown({ card, placed: false, placing: false, error: r.blocked[0]!.reason });
        if (!settings.current.muted) play("warn");
      } else {
        setShown({ card, placed: true, placing: false, error: null });
        if (!settings.current.muted) play("ok");
      }
    } catch (err) {
      setShown({ card, placed: false, placing: false, error: errorText(err, "Could not record it.") });
    }
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const code = manual.trim();
    if (!code) return;
    primeAudio();
    setManual("");
    setStarted(true);
    enqueue(code);
  };

  return (
    <div className={FULL_SCREEN}>
      <ModeHeader jobId={id} title={info ? `${info.job.code} · where does this go?` : "Where does this go?"}>
        <select
          value={shipmentId}
          onChange={(e) => setParams(e.target.value ? { shipment: e.target.value } : {}, { replace: true })}
          aria-label="Shipment being unloaded"
          className={SELECT}
        >
          <option value="">Any truck</option>
          {info?.shipments.map((s) => (
            <option key={s.id} value={s.id}>
              Unloading {s.code} · {s.name}
            </option>
          ))}
        </select>
        <button onClick={() => setMuted((m) => !m)} className={BTN_QUIET} aria-pressed={muted}>
          {muted ? "Sound off" : "Sound on"}
        </button>
      </ModeHeader>

      {error && <p className="bg-red-950/70 px-4 py-2 text-sm text-red-300">{error}</p>}

      {!started ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="max-w-lg text-lg text-slate-300">
            Scan each {terms.item.singular.toLowerCase()} as it comes off the truck. Pick the truck above to catch anything
            that came on the wrong one.
          </p>
          <button
            onClick={() => {
              primeAudio();
              setStarted(true);
            }}
            className="rounded-xl bg-sky-600 px-8 py-5 text-2xl font-bold text-white hover:bg-sky-500"
          >
            Start scanning
          </button>
        </div>
      ) : shown ? (
        <CardView shown={shown} onPlace={() => void place()} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-2xl text-slate-400">
          Scan a label.
        </div>
      )}

      {/* Room at the bottom for the reader control and the camera button, which sit over every page. */}
      <div className="border-t border-slate-800 bg-slate-900 px-4 pb-20 pt-3">
        <form onSubmit={submitManual} className="flex gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Or type a code"
            aria-label="Code"
            className={FIELD}
          />
          <button className="whitespace-nowrap rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">Look up</button>
        </form>
        {recent.length > 1 && (
          <ul className="mt-2 flex gap-2 overflow-x-auto pb-1 text-xs">
            {recent.slice(1).map((c, i) => (
              <li
                key={`${c.code}-${i}`}
                className={`shrink-0 rounded-full px-3 py-1 ${
                  c.outcome === "ok"
                    ? "text-white"
                    : c.outcome === "wrong_shipment" || c.outcome === "not_on_job"
                      ? "bg-red-900 text-red-100"
                      : "bg-slate-800 text-slate-300"
                }`}
                style={c.outcome === "ok" && c.line ? { backgroundColor: c.line.floorColor } : undefined}
              >
                {c.item?.name ?? c.code} → {c.line?.destination ? c.line.destination.name : c.outcome.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
