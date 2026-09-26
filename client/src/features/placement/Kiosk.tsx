import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useFeatures, useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { trackingApi } from "../tracking-core/api";
import type { TrackingDevice } from "../tracking-core/types";
import { BTN, BTN_QUIET, CARD, LocationSelect, Notice, SELECT, errorText, useLocations } from "../jobs-core/ui";
import { placementApi } from "./api";
import { play, primeAudio } from "./sound";
import type { KioskEntry, KioskOutcome } from "./types";
import { FULL_SCREEN, ModeHeader, floorText, pathText, shortPath } from "./ui";

/**
 * The entrance kiosk: a tablet on a tripod at a floor entrance, next to a
 * door portal. It lists what just went through and where each thing goes,
 * large enough to read while pushing a trolley, from the reader's live feed
 * (and any label scanned at the tablet). It only shows; rooms are confirmed
 * by their own readers, sweeps and the placement card.
 */

const POLL_MS = 1000;
const SHOW = 12;

type Row = KioskEntry & { key: string };

const TONE: Record<KioskOutcome, { label: string; cls: string }> = {
  this_way: { label: "This way", cls: "bg-emerald-600 text-white" },
  elsewhere: { label: "Wrong floor", cls: "bg-red-600 text-white" },
  not_on_job: { label: "Not on this job", cls: "bg-red-600 text-white" },
  no_destination: { label: "No destination", cls: "bg-amber-600 text-white" },
  placed: { label: "Already placed", cls: "bg-slate-700 text-slate-100" },
  info: { label: "", cls: "bg-slate-700 text-slate-100" },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function Kiosk() {
  const { id = "" } = useParams();
  const terms = useTerms();
  const features = useFeatures();
  const { armBulkCapture } = useScan();
  const { options } = useLocations();
  const [params, setParams] = useSearchParams();
  const deviceId = params.get("device") ?? "";
  const locationId = params.get("location") ?? "";
  const [devices, setDevices] = useState<TrackingDevice[]>([]);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [zone, setZone] = useState<string | null>(null);
  const [counts, setCounts] = useState({ thisWay: 0, flagged: 0 });
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (!features.tracking) return;
    trackingApi
      .listDevices()
      .then((d) => setDevices(d.filter((x) => x.locationId || x.kind === "rfid_portal" || x.kind === "rfid_reader")))
      .catch(() => undefined);
  }, [features.tracking]);

  const add = useCallback((fresh: Row[]) => {
    if (!fresh.length) return;
    setRows((prev) => {
      // One row per thing: a tag read again moves back to the top.
      const keys = new Set(fresh.map((r) => r.key));
      return [...fresh, ...prev.filter((r) => !keys.has(r.key))].slice(0, 50);
    });
    setCounts((c) => ({
      thisWay: c.thisWay + fresh.filter((r) => r.outcome === "this_way").length,
      flagged: c.flagged + fresh.filter((r) => r.outcome === "elsewhere" || r.outcome === "not_on_job").length,
    }));
    if (!mutedRef.current) {
      const bad = fresh.some((r) => r.outcome === "elsewhere" || r.outcome === "not_on_job");
      play(bad ? "alarm" : fresh.some((r) => r.outcome === "this_way") ? "ok" : "already");
    }
  }, []);

  useEffect(() => {
    if (!running || !features.tracking) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const first = cursor.current === undefined;
        const page = await placementApi.kiosk(id, {
          deviceId: deviceId || undefined,
          locationId: locationId || undefined,
          since: cursor.current,
        });
        if (stopped) return;
        cursor.current = page.cursor;
        setZone(page.zone ? pathText(page.zone) : null);
        setError(null);
        // What passed before the kiosk started is not news.
        if (first) return;
        const seen = new Set<string>();
        const fresh: Row[] = [];
        for (const e of [...page.entries].reverse()) {
          const key = `${e.itemId}:${e.unitId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          fresh.push({ ...e, key });
        }
        add(fresh);
      } catch (err) {
        if (!stopped) setError(errorText(err, "Lost the reader feed; retrying."));
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [running, id, deviceId, locationId, add, features.tracking]);

  const onScan = useCallback(
    (code: string) => {
      placementApi
        .kioskScan(id, code, { deviceId: deviceId || undefined, locationId: locationId || undefined })
        .then((entry) => {
          if (entry) add([{ ...entry, key: `${entry.itemId}:${entry.unitId ?? ""}`, deviceName: "Scanned here" }]);
        })
        .catch(() => undefined);
    },
    [id, deviceId, locationId, add],
  );

  useEffect(() => {
    if (running) armBulkCapture(onScan);
    return () => armBulkCapture(null);
  }, [running, onScan, armBulkCapture]);

  const start = () => {
    primeAudio();
    cursor.current = undefined;
    setRows([]);
    setCounts({ thisWay: 0, flagged: 0 });
    setRunning(true);
    // A kiosk runs full screen where the browser allows it.
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const set = (key: "device" | "location", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (!running) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">Entrance kiosk</h1>
        <section className={`${CARD} space-y-3`}>
          <p className="text-sm text-slate-400">
            Set a tablet by the door with the reader at this entrance. Everything read shows here with where it goes, and
            anything bound for another floor, or not on this job, turns red.
          </p>
          {!features.tracking && (
            <Notice tone="warn">
              Readers, beacons and trackers are switched off, so the kiosk can only show labels scanned at the tablet.
            </Notice>
          )}
          {features.tracking && (
            <label className="block text-sm text-slate-400">
              Reader at this entrance
              <select
                value={deviceId}
                onChange={(e) => set("device", e.target.value)}
                className={`${SELECT} mt-1 w-full`}
                aria-label="Reader at this entrance"
              >
                <option value="">Every reader</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.locationName ? ` · ${d.locationName}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm text-slate-400">
            This entrance leads to
            <LocationSelect
              value={locationId}
              onChange={(v) => set("location", v)}
              options={options}
              label="This entrance leads to"
              placeholder={deviceId ? "The reader's own zone" : `No ${terms.location.singular.toLowerCase()}`}
              className={`${SELECT} mt-1 w-full`}
            />
          </label>
          <button onClick={start} className={BTN}>
            Start the kiosk
          </button>
        </section>
      </div>
    );
  }

  const shown = rows.slice(0, SHOW);
  return (
    <div className={FULL_SCREEN}>
      <ModeHeader jobId={id} title={zone ? `To ${zone}` : "Entrance kiosk"}>
        <span className="rounded-full bg-emerald-900 px-3 py-1 text-sm text-emerald-100">{counts.thisWay} this way</span>
        <span className="rounded-full bg-red-900 px-3 py-1 text-sm text-red-100">{counts.flagged} turned back</span>
        <button onClick={() => setMuted((m) => !m)} className={BTN_QUIET} aria-pressed={muted}>
          {muted ? "Sound off" : "Sound on"}
        </button>
        <button onClick={() => setRunning(false)} className={BTN_QUIET}>
          Settings
        </button>
      </ModeHeader>
      {error && <p className="bg-red-950/70 px-4 py-2 text-sm text-red-300">{error}</p>}
      <ul className="flex-1 space-y-2 overflow-y-auto p-3 pb-24" aria-live="polite">
        {shown.length === 0 && (
          <li className="py-16 text-center text-3xl text-slate-500">Waiting for the next {terms.item.singular.toLowerCase()}…</li>
        )}
        {shown.map((r, i) => {
          const line = r.line;
          const other = r.otherJobs[0];
          const floor = line?.floor ?? other?.floor ?? null;
          const color = line?.floorColor ?? other?.floorColor ?? "#475569";
          const tone = TONE[r.outcome];
          return (
            <li
              key={r.key}
              className={`flex items-stretch overflow-hidden rounded-xl border border-slate-800 bg-slate-900 ${i === 0 ? "text-2xl" : "text-lg"}`}
            >
              <div className="flex w-32 shrink-0 items-center justify-center px-2 text-center font-black text-white sm:w-44" style={{ backgroundColor: color }}>
                {floorText(floor)}
              </div>
              <div className="min-w-0 flex-1 px-4 py-3">
                <p className="truncate font-semibold text-slate-50">{r.itemName}</p>
                <p className="truncate text-slate-300">
                  {line?.destination
                    ? `${shortPath(line.destination)}${line.destinationLabel ? ` · ${line.destinationLabel}` : ""}`
                    : other
                      ? `${other.code}: ${other.destination ? shortPath(other.destination) : "no destination"}`
                      : "Not on any open job"}
                </p>
                {r.handlingNotes.length > 0 && <p className="truncate text-base text-amber-300">{r.handlingNotes.join(" · ")}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end justify-center gap-1 px-4">
                {tone.label && <span className={`rounded-lg px-3 py-1 font-bold uppercase ${tone.cls}`}>{tone.label}</span>}
                <span className="text-sm text-slate-500">
                  {r.direction === "in" ? "In · " : r.direction === "out" ? "Out · " : ""}
                  {time(r.at)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
