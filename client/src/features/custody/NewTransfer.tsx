import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useFeatures, useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { jobsApi } from "../jobs-core/api";
import type { JobSummary, Shipment } from "../jobs-core/types";
import { custodyApi } from "./api";
import type { PartyInput } from "./types";
import { BTN, BTN_QUIET, CARD, FIELD, LABEL, PartyFields, SELECT, errorText, useCustodyMeta } from "./ui";

/** Where the handoff happens: a place on file and, when the device knows, a position. */
export function usePosition() {
  const [pos, setPos] = useState<{ lat: number; lng: number; accuracyM: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) {
      setError("This device cannot share its position.");
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) });
        setBusy(false);
      },
      (err) => {
        setError(err.code === err.PERMISSION_DENIED ? "Position was not shared. Allow it in the browser to record it." : "The position could not be found.");
        setBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  return { pos, setPos, error, busy, locate };
}

export function NewTransfer() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const meta = useCustodyMeta();
  const features = useFeatures();
  const terms = useTerms();
  const { user } = useAuth();
  const [purpose, setPurpose] = useState("handoff");
  const [from, setFrom] = useState<PartyInput>({ kind: "user", userOid: null });
  const [to, setTo] = useState<PartyInput>({ kind: "external", name: "", org: "" });
  const [locationId, setLocationId] = useState("");
  const [jobId, setJobId] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [seals, setSeals] = useState("");
  const [condition, setCondition] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const position = usePosition();

  useEffect(() => {
    if (user) setFrom((f) => (f.kind === "user" && !f.userOid ? { kind: "user", userOid: user.oid } : f));
  }, [user]);
  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    if (features.jobs) {
      jobsApi
        .listJobs()
        .then((all) => setJobs(all.filter((j) => j.status === "planned" || j.status === "in_progress")))
        .catch(() => undefined);
    }
  }, [features.jobs]);
  useEffect(() => {
    setShipmentId("");
    setShipments([]);
    if (jobId) jobsApi.getJob(jobId).then((j) => setShipments(j.shipments)).catch(() => undefined);
  }, [jobId]);

  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const places = useMemo(
    () => locations.map((l) => ({ id: l.id, label: label(l) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [locations, label],
  );
  const info = meta?.purposes.find((p) => p.name === purpose);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await custodyApi.create({
        purpose,
        from,
        to,
        locationId: locationId || null,
        lat: position.pos?.lat ?? null,
        lng: position.pos?.lng ?? null,
        accuracyM: position.pos?.accuracyM ?? null,
        jobId: jobId || null,
        shipmentId: shipmentId || null,
        sealNumbers: seals.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
        conditionNote: condition.trim() || null,
      });
      const first = params.get("item");
      if (first) await custodyApi.scan(created.id, [first], "manual").catch(() => undefined);
      navigate(`/custody/transfers/${created.id}`);
    } catch (err) {
      setError(errorText(err, "The transfer could not be started."));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">New handoff</h1>
        <p className="text-sm text-slate-400">
          Say who is handing over to whom, then scan the {terms.item.plural.toLowerCase()}. Both sign once the count is confirmed.
        </p>
      </div>

      <section className={`${CARD} space-y-4`}>
        <div>
          <label className={LABEL} htmlFor="custody-purpose">
            Purpose
          </label>
          <select id="custody-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} className={`${SELECT} w-full`}>
            {(meta?.purposes ?? [{ name: "handoff", label: "Handoff", help: "", requires: [] }]).map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
          {info?.help && <p className="mt-1 text-xs text-slate-400">{info.help}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <PartyFields label="Released by" value={from} onChange={setFrom} />
          <PartyFields label="Received by" value={to} onChange={setTo} />
        </div>
      </section>

      <section className={`${CARD} space-y-4`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="custody-place">
              Where
            </label>
            <select id="custody-place" value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${SELECT} w-full`}>
              <option value="">Not recorded</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <button type="button" onClick={position.locate} disabled={position.busy} className={BTN_QUIET}>
                {position.busy ? "Finding…" : position.pos ? "Update my position" : "Add my position"}
              </button>
              {position.pos && (
                <span className="text-slate-300">
                  {position.pos.lat.toFixed(5)}, {position.pos.lng.toFixed(5)} (±{position.pos.accuracyM} m)
                </span>
              )}
              {position.error && <span className="text-amber-300">{position.error}</span>}
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="custody-seals">
              Seal numbers
            </label>
            <input
              id="custody-seals"
              value={seals}
              onChange={(e) => setSeals(e.target.value)}
              placeholder="e.g. 004512, 004513"
              className={FIELD}
            />
          </div>
        </div>
        {features.jobs && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="custody-job">
                Job
              </label>
              <select id="custody-job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={`${SELECT} w-full`}>
                <option value="">None</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.code} · {j.name}
                  </option>
                ))}
              </select>
              {purpose === "delivery" && !jobId && (
                <p className="mt-1 text-xs text-amber-300">Pick the job, so its controlled lines can be marked delivered.</p>
              )}
            </div>
            <div>
              <label className={LABEL} htmlFor="custody-shipment">
                Shipment
              </label>
              <select
                id="custody-shipment"
                value={shipmentId}
                onChange={(e) => setShipmentId(e.target.value)}
                disabled={!jobId}
                className={`${SELECT} w-full disabled:opacity-60`}
              >
                <option value="">None</option>
                {shipments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div>
          <label className={LABEL} htmlFor="custody-condition">
            Condition
          </label>
          <input
            id="custody-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. Boxes taped and sealed, no visible damage"
            maxLength={2000}
            className={FIELD}
          />
        </div>
      </section>

      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BTN}>
          {busy ? "Starting…" : "Start and scan"}
        </button>
        <button type="button" onClick={() => navigate(-1)} className={BTN_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  );
}
