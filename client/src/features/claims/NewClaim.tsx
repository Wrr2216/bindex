import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { claimsApi, type JobOption } from "./api";
import type { Candidate, ClaimType, LineProblem } from "./types";
import {
  BTN,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LABEL,
  MoneyInput,
  Notice,
  SELECT,
  errorText,
  fromLocalInput,
  toLocalInput,
  useCents,
  useClaimsMeta,
  useLocationOptions,
} from "./ui";

/**
 * Opening a claim or an incident report. Pick the job it happened on and the
 * lines it is about (damaged, missing and refused lines are ticked already),
 * or scan the things themselves. Everything else, the photos, notes and trip
 * history, the claim gathers on its own.
 */
export function NewClaim() {
  const meta = useClaimsMeta();
  const terms = useTerms();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { armBulkCapture } = useScan();
  const locations = useLocationOptions();
  const money = useCents();

  const [kind, setKind] = useState<"claim" | "incident">(params.get("kind") === "incident" ? "incident" : "claim");
  const [type, setType] = useState<ClaimType>("damage");
  const [category, setCategory] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [locationId, setLocationId] = useState("");
  const [jobId, setJobId] = useState(params.get("jobId") ?? "");
  const [shipmentId, setShipmentId] = useState(params.get("shipmentId") ?? "");
  const [carrierReference, setCarrierReference] = useState("");
  const [insurerReference, setInsurerReference] = useState("");
  const [estimatedTotal, setEstimatedTotal] = useState<number | null>(null);
  const [onBehalf, setOnBehalf] = useState(false);
  const [reporterName, setReporterName] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [relatedClaimId, setRelatedClaimId] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [shipments, setShipments] = useState<{ id: string; code: string; name: string }[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<string[]>([]);
  const [codeText, setCodeText] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<LineProblem[]>([]);

  const incident = kind === "incident";
  const moneyTypes = meta?.types.filter((t) => t.money) ?? [];

  // A claim opened from an incident report starts from what the report says.
  useEffect(() => {
    const from = params.get("from");
    if (!from) return;
    claimsApi
      .get(from)
      .then((c) => {
        setRelatedClaimId(c.id);
        setKind("claim");
        setType(c.category === "site_damage" ? "property_damage" : "damage");
        setTitle(c.title);
        setDescription(`${c.description ?? ""}${c.description ? "\n\n" : ""}From incident report ${c.code}.`);
        if (c.jobId) setJobId(c.jobId);
        if (c.shipmentId) setShipmentId(c.shipmentId);
        if (c.locationId) setLocationId(c.locationId);
        setOccurredAt(toLocalInput(c.occurredAt));
      })
      .catch(() => undefined);
  }, [params]);

  useEffect(() => {
    if (!meta?.jobs) return;
    claimsApi.jobs().then(setJobs).catch(() => setJobs([]));
  }, [meta?.jobs]);

  useEffect(() => {
    setCandidates(null);
    setShipments([]);
    if (!jobId || !meta?.jobs) return;
    claimsApi.job(jobId).then((j) => setShipments(j.shipments)).catch(() => undefined);
  }, [jobId, meta?.jobs]);

  useEffect(() => {
    if (!jobId || !meta?.jobs) return;
    let live = true;
    claimsApi
      .candidates(jobId, shipmentId || null)
      .then((list) => {
        if (!live) return;
        setCandidates(list);
        // Damaged, missing and refused lines are what claims are usually about.
        setPicked(new Set(incident ? [] : list.filter((c) => c.flagged && c.claims.length === 0).map((c) => c.jobItemId)));
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [jobId, shipmentId, meta?.jobs, incident]);

  // Any scan while the form is open adds that thing to the claim.
  useEffect(() => {
    armBulkCapture((code) => setCodes((cur) => (cur.includes(code) ? cur : [...cur, code])));
    return () => armBulkCapture(null);
  }, [armBulkCapture]);

  const addCode = () => {
    const c = codeText.trim();
    if (c && !codes.includes(c)) setCodes([...codes, c]);
    setCodeText("");
  };

  const lineCount = picked.size + codes.length;
  const pickedValue = useMemo(
    () => (candidates ?? []).filter((c) => picked.has(c.jobItemId)).reduce((sum, c) => sum + (c.declaredValueCents ?? 0), 0),
    [candidates, picked],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give it a short title, such as what was damaged and where.");
      return;
    }
    setSaving(true);
    setError(null);
    setProblems([]);
    try {
      const claim = await claimsApi.create({
        type: incident ? "incident" : type,
        category: incident ? category || null : null,
        title: title.trim(),
        description: description.trim() || null,
        jobId: jobId || null,
        shipmentId: shipmentId || null,
        locationId: locationId || null,
        occurredAt: fromLocalInput(occurredAt),
        carrierReference: incident ? null : carrierReference.trim() || null,
        insurerReference: incident ? null : insurerReference.trim() || null,
        estimatedTotalCents: incident || lineCount > 0 ? null : estimatedTotal,
        reporterName: onBehalf ? reporterName.trim() || null : null,
        reporterEmail: onBehalf ? reporterEmail.trim() || null : null,
        relatedClaimId,
        lines: [...[...picked].map((jobItemId) => ({ jobItemId })), ...codes.map((code) => ({ code }))],
      });
      navigate(`/claims/${claim.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "line_problems") {
        setProblems(((err.details as { problems?: LineProblem[] })?.problems ?? []) as LineProblem[]);
      }
      setError(errorText(err, "The claim could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-100">{incident ? "Report an incident" : "New claim"}</h1>
        <Link to="/claims" className={BTN_QUIET}>
          Cancel
        </Link>
      </div>

      <div className="flex overflow-hidden rounded-lg border border-slate-700 sm:w-fit" role="group" aria-label="Claim or incident">
        {(["claim", "incident"] as const).map((k) => (
          <button
            type="button"
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={`flex-1 px-4 py-2 text-sm ${kind === k ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
          >
            {k === "claim" ? "Claim (money)" : "Incident (no money)"}
          </button>
        ))}
      </div>

      <section className={`${CARD} space-y-4`}>
        <div className="grid gap-4 sm:grid-cols-2">
          {incident ? (
            <label className="space-y-1">
              <span className={LABEL}>What kind of incident</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${SELECT} w-full`}>
                <option value="">Choose…</option>
                {meta?.incidentCategories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="space-y-1">
              <span className={LABEL}>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as ClaimType)} className={`${SELECT} w-full`}>
                {moneyTypes.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-slate-500">{moneyTypes.find((t) => t.type === type)?.description}</span>
            </label>
          )}
          <label className="space-y-1">
            <span className={LABEL}>When it happened</span>
            <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} className={FIELD} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className={LABEL}>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={incident ? "Dock plate gave way at door 3" : "Glass cabinet arrived cracked"}
            className={FIELD}
            required
            maxLength={200}
          />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>What happened</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={FIELD} maxLength={10000} />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>Where</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${SELECT} w-full`} aria-label={`Where (${terms.location.singular.toLowerCase()})`}>
            <option value="">Not given</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={`${CARD} space-y-4`}>
        <h2 className={H2}>{incident ? `${terms.item.plural} involved` : `What is claimed`}</h2>
        {meta?.jobs && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={LABEL}>Job</span>
              <select
                value={jobId}
                onChange={(e) => {
                  setJobId(e.target.value);
                  setShipmentId("");
                }}
                className={`${SELECT} w-full`}
              >
                <option value="">No job</option>
                {jobs?.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.code} {j.name}
                  </option>
                ))}
              </select>
            </label>
            {jobId && (
              <label className="space-y-1">
                <span className={LABEL}>Shipment</span>
                <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} className={`${SELECT} w-full`}>
                  <option value="">Any shipment</option>
                  {shipments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {candidates && candidates.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs text-slate-400">
              Tick the lines this is about. Flagged lines (damaged, missing, refused) are ticked for you.
            </legend>
            <ul className="max-h-80 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
              {candidates.map((c) => (
                <li key={c.jobItemId}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-slate-800/50">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.has(c.jobItemId)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(c.jobItemId);
                        else next.delete(c.jobItemId);
                        setPicked(next);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-slate-100">{c.itemName}</span>
                        <span className="font-mono text-xs text-slate-500">{c.assetCode}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${c.flagged ? "bg-red-950 text-red-300" : "bg-slate-800 text-slate-400"}`}>
                          {c.stageLabel}
                        </span>
                        {c.shipmentCode && <span className="text-xs text-slate-500">{c.shipmentCode}</span>}
                        {c.claims.map((k) => (
                          <span key={k.id} className="text-xs text-amber-300">
                            on {k.code}
                          </span>
                        ))}
                      </span>
                      {c.stageNote && <span className="block text-xs text-slate-400">“{c.stageNote}”</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {candidates && candidates.length === 0 && <p className="text-sm text-slate-500">This job has no lines yet.</p>}

        <div className="space-y-2">
          <span className={LABEL}>Scan or type a code</span>
          <div className="flex gap-2">
            <input
              value={codeText}
              onChange={(e) => setCodeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCode();
                }
              }}
              placeholder="Asset code, serial or tag"
              aria-label="Code to add"
              className={FIELD}
            />
            <button type="button" onClick={addCode} className={BTN_QUIET}>
              Add
            </button>
          </div>
          {codes.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {codes.map((c) => (
                <li key={c} className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-200">
                  {c}
                  <button type="button" aria-label={`Remove ${c}`} onClick={() => setCodes(codes.filter((x) => x !== c))} className="text-slate-400 hover:text-slate-100">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!incident && picked.size > 0 && pickedValue > 0 && (
          <p className="text-xs text-slate-400">Declared value of the ticked lines: {money(pickedValue)}. Amounts are set per line on the next screen.</p>
        )}
        {!incident && lineCount === 0 && (
          <label className="block space-y-1 sm:w-64">
            <span className={LABEL}>Amount claimed</span>
            <MoneyInput value={estimatedTotal} onCommit={setEstimatedTotal} label="Amount claimed" />
            <span className="block text-xs text-slate-500">For a claim that is not about particular {terms.item.plural.toLowerCase()}, such as a delay.</span>
          </label>
        )}
      </section>

      {!incident && (
        <section className={`${CARD} grid gap-4 sm:grid-cols-2`}>
          <label className="space-y-1">
            <span className={LABEL}>Carrier reference</span>
            <input value={carrierReference} onChange={(e) => setCarrierReference(e.target.value)} className={FIELD} maxLength={200} />
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Insurer reference</span>
            <input value={insurerReference} onChange={(e) => setInsurerReference(e.target.value)} className={FIELD} maxLength={200} />
          </label>
        </section>
      )}

      <section className={`${CARD} space-y-3`}>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={onBehalf} onChange={(e) => setOnBehalf(e.target.checked)} />
          Reported by someone else (a customer who phoned, a site contact)
        </label>
        {onBehalf && (
          <div className="grid gap-4 sm:grid-cols-2">
            <input value={reporterName} onChange={(e) => setReporterName(e.target.value)} placeholder="Their name" aria-label="Reporter's name" className={FIELD} />
            <input value={reporterEmail} onChange={(e) => setReporterEmail(e.target.value)} placeholder="Email or phone" aria-label="Reporter's contact" className={FIELD} />
          </div>
        )}
      </section>

      {error && <Notice tone="error">{error}</Notice>}
      {problems.length > 1 && (
        <ul className="list-inside list-disc text-sm text-red-300">
          {problems.map((p, i) => (
            <li key={i}>
              {p.input ? `${p.input}: ` : ""}
              {p.problem}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <button type="submit" disabled={saving} className={BTN}>
          {saving ? "Saving…" : "Save as draft"}
        </button>
      </div>
    </form>
  );
}
