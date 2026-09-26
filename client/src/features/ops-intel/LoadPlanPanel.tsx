import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { opsApi } from "./api";
import type { JobLoadPlan, JobOption, Profile, ShipmentCapacity, VehiclePlan } from "./types";
import { BTN, CARD, H2, Meter, NUM, Notice, SELECT, TABLE, TD, TH, errorText, kg, m3 } from "./ui";

/**
 * Load planning for one job: what goes on which vehicle, in what order it
 * goes in, and what does not fit. Stops can be put in delivery order, and a
 * vehicle added to see how a second truck would change things. Planning never
 * changes the job; assigning lines to shipments stays on the job's manifest.
 */
export function LoadPlanPanel({ onSetup }: { onSetup: () => void }) {
  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [jobId, setJobId] = useState("");
  const [stops, setStops] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<string[]>([]);
  const [repack, setRepack] = useState(false);
  const [plan, setPlan] = useState<JobLoadPlan | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    opsApi
      .openJobs()
      .then(setJobs)
      .catch((err) => setError(errorText(err, "Jobs could not be loaded.")));
    opsApi.profiles().then(setProfiles).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!jobId) {
      setPlan(null);
      return;
    }
    setLoading(true);
    opsApi
      .loadPlan(jobId, { stops, vehicles, repack })
      .then((p) => {
        setPlan(p);
        setError(null);
      })
      .catch((err) => setError(errorText(err, "The plan could not be worked out.")))
      .finally(() => setLoading(false));
  }, [jobId, stops, vehicles, repack]);

  const vehicleOptions = useMemo(
    () => profiles.filter((p) => p.role === "vehicle" || p.maxKg !== null || p.maxM3 !== null),
    [profiles],
  );

  // Starts from the order the planner used, so moving one stop keeps the rest.
  const move = (index: number, by: -1 | 1) =>
    setStops((cur) => {
      const next = cur.length ? [...cur] : (plan?.plan.stops.map((s) => s.key) ?? []);
      const [x] = next.splice(index, 1);
      next.splice(index + by, 0, x!);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={jobId}
          onChange={(e) => {
            setJobId(e.target.value);
            setStops([]);
            setVehicles([]);
          }}
          aria-label="Job"
          className={SELECT}
        >
          <option value="">Pick an open job…</option>
          {jobs?.map((j) => (
            <option key={j.id} value={j.id}>
              {j.code} {j.name}
            </option>
          ))}
        </select>
        {jobId && (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={repack} onChange={(e) => setRepack(e.target.checked)} />
              Repack from scratch
            </label>
            <select
              value=""
              onChange={(e) => e.target.value && setVehicles((v) => [...new Set([...v, e.target.value])])}
              aria-label="Add a vehicle"
              className={SELECT}
            >
              <option value="">Add a vehicle…</option>
              {vehicleOptions.map((p) => (
                <option key={p.locationId} value={p.locationId}>
                  {p.locationName}
                </option>
              ))}
            </select>
            <a href={opsApi.loadPlanPdfUrl(jobId, { stops, vehicles, repack })} target="_blank" rel="noopener" className={BTN}>
              Print load plan
            </a>
          </>
        )}
      </div>
      {jobs && jobs.length === 0 && <p className="text-sm text-slate-500">No open jobs to plan.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      {vehicleOptions.length === 0 && (
        <Notice tone="info">
          No vehicle has a capacity yet.{" "}
          <button onClick={onSetup} className="text-sky-400 hover:underline">
            Add one under Setup
          </button>{" "}
          with its maximum weight and volume or interior size.
        </Notice>
      )}

      {plan && (
        <div className={`space-y-4 ${loading ? "opacity-60" : ""}`}>
          {vehicles.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {vehicles.map((id) => (
                <button
                  key={id}
                  onClick={() => setVehicles((v) => v.filter((x) => x !== id))}
                  className="rounded-full bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
                  title="Take this vehicle out of the plan"
                >
                  {profiles.find((p) => p.locationId === id)?.locationName ?? id} ✕
                </button>
              ))}
            </div>
          )}

          <section className={`${CARD} space-y-2`}>
            <h2 className={H2}>Stops, in delivery order</h2>
            {plan.plan.stops.length === 0 && <p className="text-sm text-slate-500">Nothing left to load.</p>}
            <ol className="space-y-1 text-sm">
              {plan.plan.stops.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="w-6 text-right tabular-nums text-slate-500">{i + 1}.</span>
                  <span className="flex-1 text-slate-200">{s.label}</span>
                  <span className="text-xs text-slate-500">
                    {s.lines} {s.lines === 1 ? "line" : "lines"}
                  </span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30" aria-label={`Deliver ${s.label} earlier`}>
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === plan.plan.stops.length - 1}
                    className="rounded px-1.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                    aria-label={`Deliver ${s.label} later`}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
            <p className="text-xs text-slate-500">The last stop is loaded first, so the first stop's things come off first.</p>
          </section>

          {plan.plan.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}

          {plan.plan.vehicles.map((v) => (
            <VehicleCard key={v.key} vehicle={v} />
          ))}

          {plan.plan.unassigned.length > 0 && (
            <section className={`${CARD} space-y-2`}>
              <h2 className={H2}>Did not fit ({plan.plan.unassigned.length})</h2>
              <ul className="space-y-1 text-sm">
                {plan.plan.unassigned.map((u) => (
                  <li key={u.line.jobItemId} className="flex flex-wrap gap-2">
                    <Link to={`/items/${u.line.itemId}`} className="text-sky-400 hover:underline">
                      {u.line.name}
                    </Link>
                    <span className="text-slate-400">
                      {kg(u.line.measure.weightKg)}, {m3(u.line.measure.volumeM3)}
                    </span>
                    <span className="text-slate-500">{u.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(plan.plan.skipped.done > 0 || plan.plan.skipped.exception > 0 || plan.plan.skipped.elsewhere > 0) && (
            <p className="text-xs text-slate-500">
              Left out: {plan.plan.skipped.done} already delivered or placed, {plan.plan.skipped.elsewhere} loaded on a vehicle not in
              the plan, {plan.plan.skipped.exception} missing, damaged or otherwise held.
            </p>
          )}
          <p className="text-xs text-slate-500">
            <Link to={`/jobs/${plan.job.id}`} className="text-sky-400 hover:underline">
              Open {plan.job.code}
            </Link>{" "}
            to put lines on shipments; the plan does not change the job.
          </p>
        </div>
      )}

      <Capacities />
    </div>
  );
}

const SOURCE: Record<string, string> = { item: "", dimensions: "from size", category: "category", default: "estimate" };

function VehicleCard({ vehicle: v }: { vehicle: VehiclePlan }) {
  const terms = useTerms();
  const cap = v.capacity;
  return (
    <section className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="font-medium text-slate-100">
          {v.shipmentCode ? (
            <Link to={`/shipments/${v.shipmentId}`} className="text-sky-400 hover:underline">
              {v.shipmentCode}
            </Link>
          ) : (
            "What if"
          )}{" "}
          {v.name}
          {v.vehicleName && v.vehicleName !== v.name && <span className="ml-1 text-sm text-slate-400">({v.vehicleName})</span>}
        </h3>
        {cap ? (
          <>
            <span className="flex items-center gap-2 text-xs text-slate-400">
              Weight {kg(v.totals.weightKg)}
              {cap.maxKg !== null && ` of ${kg(cap.maxKg)}`}
              <Meter value={v.utilization.weight} label="Weight used" />
            </span>
            <span className="flex items-center gap-2 text-xs text-slate-400">
              Volume {m3(v.totals.volumeM3)}
              {cap.maxM3 !== null && ` of ${m3(cap.maxM3)} usable`}
              <Meter value={v.utilization.volume} label="Volume used" />
            </span>
          </>
        ) : (
          <span className="text-xs text-amber-300">No capacity set</span>
        )}
      </div>
      {v.lines.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing on it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={`${TH} text-right`}>Load</th>
                <th className={TH}>{terms.item.singular}</th>
                <th className={TH}>Stop</th>
                <th className={`${TH} text-right`}>Weight</th>
                <th className={`${TH} text-right`}>Volume</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {v.lines.map((l) => (
                <tr key={l.jobItemId} className="border-t border-slate-800">
                  <td className={`${NUM} font-semibold text-slate-100`}>{l.sequence}</td>
                  <td className={TD}>
                    <Link to={`/items/${l.itemId}`} className="text-sky-400 hover:underline">
                      {l.name}
                    </Link>
                    {l.measure.pieces > 1 && <span className="ml-1 text-slate-400">×{l.measure.pieces}</span>}
                    {l.code && <span className="ml-1 font-mono text-xs text-slate-500">{l.code}</span>}
                  </td>
                  <td className={TD}>
                    {l.stopIndex + 1}. {l.stopLabel}
                  </td>
                  <td className={NUM}>{kg(l.measure.weightKg)}</td>
                  <td className={NUM}>{m3(l.measure.volumeM3)}</td>
                  <td className="px-2 py-1.5 text-xs text-slate-500">
                    {[l.pinned ? (l.stage === "loaded" ? "on board" : "on this shipment") : "", SOURCE[l.measure.weightSource], SOURCE[l.measure.volumeSource]]
                      .filter(Boolean)
                      .filter((x, i, all) => all.indexOf(x) === i)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Capacities() {
  const [rows, setRows] = useState<ShipmentCapacity[] | null>(null);
  useEffect(() => {
    opsApi.capacities().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <section className={`${CARD} space-y-2`}>
      <h2 className={H2}>Open shipments against their vehicles</h2>
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Shipment</th>
              <th className={TH}>Vehicle</th>
              <th className={`${TH} text-right`}>Lines</th>
              <th className={TH}>Weight</th>
              <th className={TH}>Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.shipmentId} className="border-t border-slate-800">
                <td className={TD}>
                  <Link to={`/shipments/${s.shipmentId}`} className="text-sky-400 hover:underline">
                    {s.code}
                  </Link>{" "}
                  <span className="text-xs text-slate-500">
                    {s.jobCode} · {s.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td className={TD}>{s.vehicleName ?? <span className="text-slate-500">none</span>}</td>
                <td className={NUM}>{s.totals.lines}</td>
                <td className={TD}>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    {kg(s.totals.weightKg)}
                    <Meter value={s.utilization.weight} label="Weight used" />
                  </div>
                </td>
                <td className={TD}>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    {m3(s.totals.volumeM3)}
                    <Meter value={s.utilization.volume} label="Volume used" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Estimated from the lines on each shipment that are still to load or on board.</p>
    </section>
  );
}
