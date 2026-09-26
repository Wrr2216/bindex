import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { jobsApi } from "./api";
import { ShipmentLinks } from "../integration/ShipmentLinks";
import { ScanToStage } from "./ScanToStage";
import type { ManifestLine, ShipmentDetail as Detail, ShipmentStatus } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LocationSelect,
  Notice,
  ProgressBar,
  StageBadge,
  StatusBadge,
  StepBars,
  errorText,
  fmtDateTime,
  fromLocalInput,
  openDocument,
  statusText,
  toLocalInput,
  useCaptureOwner,
  useJobsMeta,
  useLocations,
} from "./ui";

/**
 * One shipment: its status, held back until its lines are ready unless forced
 * with a reason; its truck, seals and load figures; what is on it; a scan
 * panel fixed to it; and its load sheet.
 */
export function ShipmentDetail() {
  const { id = "" } = useParams();
  const meta = useJobsMeta();
  const terms = useTerms();
  const navigate = useNavigate();
  const { options: locationOptions } = useLocations();
  const { owner, claim } = useCaptureOwner<"stage">();
  const [shipment, setShipment] = useState<Detail | null>(null);
  const [lines, setLines] = useState<ManifestLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ status: ShipmentStatus; message: string } | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await jobsApi.getShipment(id);
      setShipment(s);
      setLines((await jobsApi.listLines(s.jobId, { shipmentId: s.id })).lines);
      setError(null);
    } catch (err) {
      setError(errorText(err, "This shipment could not be loaded."));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !shipment) return <Notice tone="error">{error}</Notice>;
  if (!shipment) return <p className="text-slate-400">Loading…</p>;

  const move = async (status: ShipmentStatus, force = false) => {
    setError(null);
    try {
      await jobsApi.setShipmentStatus(shipment.id, status, force || undefined, force ? reason.trim() : undefined);
      setPending(null);
      setReason("");
      await load();
    } catch (err) {
      // Lines not ready, or a step back: offer to force it with a reason.
      if (err instanceof ApiError && (err.code === "lines_not_ready" || err.code === "backward")) {
        setPending({ status, message: err.message });
      } else {
        setError(errorText(err));
      }
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${shipment.code}? Its lines stay on the job, off any shipment.`)) return;
    try {
      await jobsApi.deleteShipment(shipment.id);
      navigate(`/jobs/${shipment.jobId}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const statuses = meta?.shipmentStatuses ?? [];
  const currentIndex = statuses.indexOf(shipment.status);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to="/jobs" className="text-sky-400 hover:underline">
          Jobs
        </Link>
        <span className="text-slate-600">/</span>
        <Link to={`/jobs/${shipment.jobId}`} className="text-sky-400 hover:underline">
          {shipment.jobCode} {shipment.jobName}
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{shipment.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <span className="font-mono">{shipment.code}</span>
            <StatusBadge status={shipment.status} />
            {shipment.vehicleName && <span>{shipment.vehicleName}</span>}
            {shipment.carrier && <span>{shipment.carrier}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ShipmentLinks shipmentId={shipment.id} />
          <button onClick={() => openDocument(jobsApi.loadSheetUrl(shipment.id))} className={BTN}>
            Print load sheet
          </button>
          <button onClick={() => setEditing((e) => !e)} className={BTN_QUIET}>
            {editing ? "Close" : "Edit"}
          </button>
          <button onClick={() => void remove()} className={BTN_DANGER}>
            Delete
          </button>
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {editing && (
        <ShipmentForm
          shipment={shipment}
          locationOptions={locationOptions}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      <section className={`${CARD} space-y-3`} aria-label="Status">
        <h2 className={H2}>Status</h2>
        <ol className="flex flex-wrap gap-2">
          {statuses.map((s, i) => (
            <li key={s}>
              <button
                onClick={() => void move(s)}
                disabled={s === shipment.status}
                className={`rounded-full px-3 py-1 text-sm ${
                  s === shipment.status
                    ? "bg-sky-600 text-white"
                    : i < currentIndex
                      ? "bg-slate-800 text-slate-400 hover:bg-slate-700"
                      : "border border-slate-700 text-slate-200 hover:bg-slate-800"
                }`}
              >
                {statusText(s)}
              </button>
            </li>
          ))}
        </ol>
        {pending && (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void move(pending.status, true);
            }}
            className="space-y-2 rounded-lg border border-amber-800 bg-amber-950/30 p-3"
          >
            <p className="text-sm text-amber-200">{pending.message}</p>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why go ahead anyway? This is kept with the shipment."
              aria-label="Reason"
              className={FIELD}
            />
            <div className="flex gap-2">
              <button className={BTN} disabled={!reason.trim()}>
                Mark {statusText(pending.status)} anyway
              </button>
              <button type="button" onClick={() => setPending(null)} className={BTN_QUIET}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-slate-500">Seals</dt>
          <dd className="text-slate-200">{shipment.sealNumbers.join(", ") || "None"}</dd>
          <dt className="text-slate-500">ETA</dt>
          <dd className="text-slate-200">{fmtDateTime(shipment.eta) || "Not set"}</dd>
          <dt className="text-slate-500">Departed</dt>
          <dd className="text-slate-200">{fmtDateTime(shipment.departedAt) || "Not yet"}</dd>
          <dt className="text-slate-500">Arrived</dt>
          <dd className="text-slate-200">{fmtDateTime(shipment.arrivedAt) || "Not yet"}</dd>
          <dt className="text-slate-500">Weight</dt>
          <dd className="text-slate-200">{shipment.weightKg != null ? `${shipment.weightKg} kg` : "Not set"}</dd>
          <dt className="text-slate-500">Volume</dt>
          <dd className="text-slate-200">{shipment.volumeM3 != null ? `${shipment.volumeM3} m³` : "Not set"}</dd>
          <dt className="text-slate-500">Distance</dt>
          <dd className="text-slate-200">{shipment.distanceKm != null ? `${shipment.distanceKm} km` : "Not set"}</dd>
        </dl>
        <ProgressBar progress={shipment.progress} />
        <StepBars progress={shipment.progress} />
      </section>

      {shipment.status !== "closed" && (
        <ScanToStage
          jobId={shipment.jobId}
          meta={meta}
          shipments={[shipment]}
          lockedShipmentId={shipment.id}
          // Once the truck has left, the next scans are at the far end.
          defaultStage={shipment.status === "in_transit" || shipment.status === "delivered" ? "delivered" : "loaded"}
          active={owner === "stage"}
          onActiveChange={(on) => claim("stage", on)}
          onChanged={() => void load()}
        />
      )}

      <section className={`${CARD} space-y-2`} aria-label="On this shipment">
        <h2 className={H2}>
          On this shipment ({lines.length} {lines.length === 1 ? terms.item.singular.toLowerCase() : terms.item.plural.toLowerCase()})
        </h2>
        {lines.length === 0 && (
          <p className="text-sm text-slate-500">Nothing yet. Scan lines onto it, or assign them from the job's manifest.</p>
        )}
        <ul className="divide-y divide-slate-800">
          {lines.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
              {l.crateNo && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">{l.crateNo}</span>}
              <Link to={`/items/${l.itemId}`} className="text-slate-100 hover:underline">
                {l.itemName}
              </Link>
              <span className="font-mono text-xs text-slate-500">{l.unitCode ?? l.assetCode}</span>
              <span className="text-xs text-slate-400">
                {[l.destinationName, l.destinationLabel].filter(Boolean).join(" · ")}
              </span>
              <span className="ml-auto">
                <StageBadge stage={l.stage} meta={meta} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${CARD} space-y-2`} aria-label="Status history">
        <h2 className={H2}>History</h2>
        <ul className="space-y-1 text-sm">
          {shipment.history.map((h) => (
            <li key={h.id} className="text-slate-300">
              {h.fromStatus ? `${statusText(h.fromStatus)} → ` : "Created as "}
              <span className="text-slate-100">{statusText(h.toStatus)}</span>
              <span className="text-xs text-slate-500">
                {" "}
                · {h.actor ? `${h.actor}, ` : ""}
                {fmtDateTime(h.createdAt)}
              </span>
              {h.forced && <span className="ml-2 text-xs text-amber-300">forced: {h.reason}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ShipmentForm({
  shipment,
  locationOptions,
  onSaved,
}: {
  shipment: Detail;
  locationOptions: { id: string; label: string }[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(shipment.name);
  const [vehicle, setVehicle] = useState(shipment.vehicleLocationId ?? "");
  const [carrier, setCarrier] = useState(shipment.carrier ?? "");
  const [seals, setSeals] = useState(shipment.sealNumbers.join(", "));
  const [weight, setWeight] = useState(shipment.weightKg?.toString() ?? "");
  const [volume, setVolume] = useState(shipment.volumeM3?.toString() ?? "");
  const [distance, setDistance] = useState(shipment.distanceKm?.toString() ?? "");
  const [eta, setEta] = useState(toLocalInput(shipment.eta));
  const [notes, setNotes] = useState(shipment.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const values = [num(weight), num(volume), num(distance)];
    if (values.some((v) => v !== null && (!Number.isFinite(v) || v < 0))) {
      setError("Weight, volume and distance must be positive numbers.");
      return;
    }
    try {
      await jobsApi.updateShipment(shipment.id, {
        name: name.trim(),
        vehicleLocationId: vehicle || null,
        carrier: carrier.trim() || null,
        sealNumbers: seals.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean),
        weightKg: values[0],
        volumeM3: values[1],
        distanceKm: values[2],
        eta: fromLocalInput(eta),
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={`${CARD} grid gap-3 sm:grid-cols-2`}>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Shipment name" required className={FIELD} />
      <LocationSelect value={vehicle} onChange={setVehicle} options={locationOptions} placeholder="Vehicle: none" label="Vehicle" />
      <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" aria-label="Carrier" className={FIELD} />
      <input value={seals} onChange={(e) => setSeals(e.target.value)} placeholder="Seal numbers, comma separated" aria-label="Seal numbers" className={FIELD} />
      <input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="Weight (kg)" aria-label="Weight in kilograms" className={FIELD} />
      <input value={volume} onChange={(e) => setVolume(e.target.value)} inputMode="decimal" placeholder="Volume (m³)" aria-label="Volume in cubic metres" className={FIELD} />
      <input value={distance} onChange={(e) => setDistance(e.target.value)} inputMode="decimal" placeholder="Distance (km)" aria-label="Distance in kilometres" className={FIELD} />
      <label className="text-xs text-slate-400">
        ETA
        <input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} className={`${FIELD} mt-1`} />
      </label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" aria-label="Notes" rows={2} className={`${FIELD} sm:col-span-2`} />
      <div className="flex items-center gap-3 sm:col-span-2">
        <button className={BTN} disabled={!name.trim()}>
          Save
        </button>
        {error && <span className="text-sm text-red-300">{error}</span>}
      </div>
    </form>
  );
}
