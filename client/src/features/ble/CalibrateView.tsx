import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field } from "../../components/ui";
import type { Location } from "../../types";
import { ZonePicker } from "../tracking-core/ZonePicker";
import { bleApi } from "./api";
import type { BleDevice, Calibration } from "./types";

const POLL_MS = 2000;

/**
 * "Calibrate zone": leave a tag in a room, record what every gateway hears,
 * and see whether the room wins and by how much. Suggests a gateway offset
 * when it does not, which can be applied in one click.
 */
export function CalibrateView() {
  const terms = useTerms();
  const [tags, setTags] = useState<BleDevice[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [tagId, setTagId] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(60);
  const [run, setRun] = useState<Calibration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    bleApi
      .listDevices()
      .then((d) => setTags(d.filter((x) => x.kind === "ble_tag" && !x.disabled)))
      .catch(() => undefined);
    api.listLocations().then(setLocations).catch(() => undefined);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const poll = (id: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      bleApi
        .calibration(id)
        .then((c) => {
          setRun(c);
          if (c.done && timer.current) clearInterval(timer.current);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Lost the calibration.");
          if (timer.current) clearInterval(timer.current);
        });
    }, POLL_MS);
  };

  const start = async () => {
    if (!tagId || !locationId) {
      setError(`Pick the tag and the ${terms.location.singular.toLowerCase()} it is sitting in.`);
      return;
    }
    setError(null);
    setApplied(null);
    try {
      const c = await bleApi.startCalibration({ tagId, locationId, seconds });
      setRun(c);
      poll(c.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start.");
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      setRun(await bleApi.stopCalibration(run.id));
      if (timer.current) clearInterval(timer.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop.");
    }
  };

  const apply = async (gatewayId: string, name: string, offset: number) => {
    try {
      await bleApi.updateDevice(gatewayId, { ble: { rssiOffset: offset } });
      setApplied(`${name} now adds ${offset > 0 ? "+" : ""}${offset} dB. Run the calibration again to check, then check the room next door.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the offset.");
    }
  };

  const elapsed = run ? Math.min(1, (Date.now() - new Date(run.startedAt).getTime()) / (new Date(run.endsAt).getTime() - new Date(run.startedAt).getTime())) : 0;
  const s = run?.summary;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Put a tag where things normally sit in a {terms.location.singular.toLowerCase()} (on a shelf, not in your
        hand), start, and step away: people absorb Bluetooth. Every gateway's readings are summarised at the end.
      </p>
      <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-3">
        <Field label="Tag">
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className={FIELD}>
            <option value="">Pick a tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${terms.location.singular} it is in`}>
          <ZonePicker locations={locations} value={locationId} onChange={setLocationId} label="Room" emptyLabel="Pick one" />
        </Field>
        <Field label="For (seconds)">
          <input
            type="number"
            min={10}
            max={600}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value) || 60)}
            className={FIELD}
          />
        </Field>
        <div className="flex gap-2 sm:col-span-3">
          <button onClick={() => void start()} className={BUTTON} disabled={!!run && !run.done}>
            {run && !run.done ? "Recording…" : "Start"}
          </button>
          {run && !run.done && (
            <button onClick={() => void stop()} className={BUTTON_QUIET}>
              Stop now
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {applied && <p className="text-sm text-emerald-400">{applied}</p>}

      {run && s && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-100">
              {run.tagName} in {run.locationName}
            </h3>
            <span className="text-xs text-slate-400">
              {run.readings} readings{run.done ? "" : ", recording"}
            </span>
          </div>
          {!run.done && (
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden>
              <div className="h-full bg-sky-600 transition-all" style={{ width: `${Math.round(elapsed * 100)}%` }} />
            </div>
          )}
          {run.readings > 0 && (
            <p className={`text-sm ${s.ok ? "text-emerald-400" : "text-amber-400"}`}>
              {s.ok
                ? `This room wins${s.margin !== null ? ` by ${s.margin} dB` : ""}. A tag here will be placed here.`
                : s.winnerZoneId
                  ? `Another room wins or the lead is too small${s.margin !== null ? ` (${s.margin} dB)` : ""}.`
                  : "No room can be decided from these readings."}
            </p>
          )}
          {s.gateways.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-2 py-1.5">Gateway</th>
                    <th className="px-2 py-1.5">Readings</th>
                    <th className="px-2 py-1.5">Median</th>
                    <th className="px-2 py-1.5">With offset</th>
                    <th className="px-2 py-1.5">Range</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {s.gateways.map((g) => (
                    <tr key={g.gatewayId} className={g.zoneId === run.locationId ? "text-slate-100" : "text-slate-400"}>
                      <td className="px-2 py-1.5">
                        {g.name}
                        {g.zoneId === run.locationId && <span className="ml-1 text-xs text-sky-400">(this room)</span>}
                        {!g.zoneId && <span className="ml-1 text-xs text-slate-500">(no room)</span>}
                      </td>
                      <td className="px-2 py-1.5">{g.samples}</td>
                      <td className="px-2 py-1.5">{g.medianRaw} dBm</td>
                      <td className="px-2 py-1.5">
                        {g.medianAdjusted} dBm{g.offset ? ` (${g.offset > 0 ? "+" : ""}${g.offset})` : ""}
                      </td>
                      <td className="px-2 py-1.5">
                        {g.min} to {g.max} (±{g.spread})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.notes.map((n) => (
            <p key={n} className="text-sm text-slate-400">
              {n}
            </p>
          ))}
          {run.done &&
            s.suggestions.map((sg) => (
              <div key={sg.gatewayId} className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-800/50 p-3 text-sm">
                <span className="text-slate-200">
                  Set {sg.name}'s offset from {sg.currentOffset} to {sg.suggestedOffset} dB
                </span>
                <button onClick={() => void apply(sg.gatewayId, sg.name, sg.suggestedOffset)} className={BUTTON_QUIET}>
                  Apply
                </button>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
