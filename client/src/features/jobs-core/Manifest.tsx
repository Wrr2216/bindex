import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useFeatures, useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { jobsApi } from "./api";
import type { CsvImportResult, JobsMeta, LineFields, ManifestLine, ManifestPage } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LocationSelect,
  Notice,
  SELECT,
  StageBadge,
  floorLabel,
  errorText,
} from "./ui";

/**
 * The manifest: every line on the job, filterable by floor, department, stage
 * and shipment, with bulk edits for the move plan (destination, floor,
 * department, crate, shipment) and three ways to add lines.
 */

type Filters = { floor: string; department: string; stage: string; shipmentId: string; q: string };
const NO_FILTERS: Filters = { floor: "", department: "", stage: "", shipmentId: "", q: "" };
const SHOW = 300;

type ShipmentOption = { id: string; code: string; name: string };

export function Manifest({
  jobId,
  meta,
  shipments,
  locationOptions,
  editable,
  refreshKey,
  captureActive,
  onCaptureChange,
  onChanged,
}: {
  jobId: string;
  meta: JobsMeta | null;
  shipments: ShipmentOption[];
  locationOptions: { id: string; label: string }[];
  /** False once the job is completed or cancelled. */
  editable: boolean;
  /** Bumped by the page when lines change elsewhere (a scan), to reload. */
  refreshKey: number;
  captureActive: boolean;
  onCaptureChange: (on: boolean) => void;
  onChanged: () => void;
}) {
  const terms = useTerms();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState<ManifestPage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(
        await jobsApi.listLines(jobId, {
          floor: filters.floor || undefined,
          department: filters.department || undefined,
          stage: filters.stage || undefined,
          shipmentId: filters.shipmentId || undefined,
          q: filters.q || undefined,
        }),
      );
      setError(null);
    } catch (err) {
      setError(errorText(err, "The manifest could not be loaded."));
    }
  }, [jobId, filters]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Selection only ever covers lines that are still listed.
  useEffect(() => {
    if (!page) return;
    const ids = new Set(page.lines.map((l) => l.id));
    setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
  }, [page]);

  const changed = () => {
    void load();
    onChanged();
  };

  const lines = page?.lines ?? [];
  const visible = showAll ? lines : lines.slice(0, SHOW);
  const allSelected = lines.length > 0 && selected.size === lines.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <section className={`${CARD} space-y-4`} aria-label="Manifest">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={H2}>Manifest</h2>
        <span className="text-sm text-slate-400">
          {page ? `${page.total} line${page.total === 1 ? "" : "s"}${filtered ? " match" : ""}` : "Loading…"}
        </span>
      </div>

      {editable && (
        <AddItems
          jobId={jobId}
          locationOptions={locationOptions}
          captureActive={captureActive}
          onCaptureChange={onCaptureChange}
          onAdded={changed}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder={`Search ${terms.item.plural.toLowerCase()}, codes, crates`}
          aria-label="Search the manifest"
          className={`${FIELD} sm:w-56`}
        />
        <select value={filters.floor} onChange={(e) => set("floor", e.target.value)} aria-label="Floor" className={SELECT}>
          <option value="">All floors</option>
          {page?.floors.map((f) => (
            <option key={f} value={f}>
              {floorLabel(f)}
            </option>
          ))}
        </select>
        <select
          value={filters.department}
          onChange={(e) => set("department", e.target.value)}
          aria-label="Department"
          className={SELECT}
        >
          <option value="">All departments</option>
          {page?.departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={filters.stage} onChange={(e) => set("stage", e.target.value)} aria-label="Stage" className={SELECT}>
          <option value="">All stages</option>
          {meta?.stages.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={filters.shipmentId}
          onChange={(e) => set("shipmentId", e.target.value)}
          aria-label="Shipment"
          className={SELECT}
        >
          <option value="">All shipments</option>
          <option value="none">Not on a shipment</option>
          {shipments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
        {filtered && (
          <button onClick={() => setFilters(NO_FILTERS)} className={BTN_QUIET}>
            Clear filters
          </button>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {selected.size > 0 && (
        <BulkBar
          jobId={jobId}
          meta={meta}
          ids={[...selected]}
          shipments={shipments}
          locationOptions={locationOptions}
          editable={editable}
          onDone={() => {
            setSelected(new Set());
            changed();
          }}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr className="border-b border-slate-800">
              <th className="w-8 py-2">
                <input
                  type="checkbox"
                  aria-label="Select every line listed"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))}
                />
              </th>
              <th className="py-2 pr-3">{terms.item.singular}</th>
              <th className="py-2 pr-3">From</th>
              <th className="py-2 pr-3">To</th>
              <th className="py-2 pr-3">Floor</th>
              <th className="py-2 pr-3">Department</th>
              <th className="py-2 pr-3">Crate</th>
              <th className="py-2 pr-3">Shipment</th>
              <th className="py-2">Stage</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <LineRow key={l.id} line={l} meta={meta} checked={selected.has(l.id)} onToggle={() => toggle(l.id)} />
            ))}
          </tbody>
        </table>
        {page && lines.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">
            {filtered ? "No lines match these filters." : `No ${terms.item.plural.toLowerCase()} on this job yet. Add some above.`}
          </p>
        )}
        {lines.length > SHOW && !showAll && (
          <button onClick={() => setShowAll(true)} className={`${BTN_QUIET} mt-2`}>
            Show all {lines.length}
          </button>
        )}
      </div>
    </section>
  );
}

function LineRow({
  line,
  meta,
  checked,
  onToggle,
}: {
  line: ManifestLine;
  meta: JobsMeta | null;
  checked: boolean;
  onToggle: () => void;
}) {
  const unit = line.unitLabel ?? line.unitCode;
  return (
    <tr className={`border-b border-slate-800/70 align-top ${checked ? "bg-sky-950/30" : ""}`}>
      <td className="py-2">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${line.itemName}`} />
      </td>
      <td className="py-2 pr-3">
        <Link to={`/items/${line.itemId}${line.unitId ? `?unit=${line.unitId}` : ""}`} className="text-slate-100 hover:underline">
          {line.itemName}
        </Link>
        <div className="font-mono text-xs text-slate-500">
          {line.unitCode ?? line.assetCode}
          {unit && line.unitLabel ? ` · ${unit}` : ""}
          {line.unitSerial ? ` · S/N ${line.unitSerial}` : ""}
        </div>
      </td>
      <td className="py-2 pr-3 text-slate-400">{line.originName ?? ""}</td>
      <td className="py-2 pr-3 text-slate-200">
        {line.destinationName}
        {line.destinationLabel && (
          <span className="block text-xs text-slate-400">{line.destinationLabel}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-slate-300">{line.floor ?? ""}</td>
      <td className="py-2 pr-3 text-slate-300">{line.department ?? ""}</td>
      <td className="py-2 pr-3 text-slate-300">{line.crateNo ?? ""}</td>
      <td className="py-2 pr-3 font-mono text-xs text-slate-400">{line.shipmentCode ?? ""}</td>
      <td className="py-2">
        <StageBadge stage={line.stage} meta={meta} />
      </td>
    </tr>
  );
}

/** Edits applied to every selected line at once. Blank fields are left alone. */
function BulkBar({
  jobId,
  meta,
  ids,
  shipments,
  locationOptions,
  editable,
  onDone,
}: {
  jobId: string;
  meta: JobsMeta | null;
  ids: string[];
  shipments: ShipmentOption[];
  locationOptions: { id: string; label: string }[];
  editable: boolean;
  onDone: () => void;
}) {
  const [destination, setDestination] = useState("");
  const [desk, setDesk] = useState("");
  const [floor, setFloor] = useState("");
  const [department, setDepartment] = useState("");
  const [crate, setCrate] = useState("");
  const [shipment, setShipment] = useState("");
  const [stage, setStage] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      setMessage({ tone: "ok", text });
      onDone();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const set: LineFields = {};
    if (destination) set.destinationLocationId = destination === "-" ? null : destination;
    if (desk) set.destinationLabel = desk;
    if (floor) set.floor = floor;
    if (department) set.department = department;
    if (crate) set.crateNo = crate;
    if (shipment) set.shipmentId = shipment === "-" ? null : shipment;
    if (Object.keys(set).length === 0) {
      setMessage({ tone: "error", text: "Fill in at least one field to set." });
      return;
    }
    void run(async () => {
      const r = await jobsApi.updateLines(jobId, ids, set);
      setDestination("");
      setDesk("");
      setFloor("");
      setDepartment("");
      setCrate("");
      setShipment("");
      return `Updated ${r.updated} line${r.updated === 1 ? "" : "s"}.`;
    });
  };

  const applyStage = () =>
    stage &&
    void run(async () => {
      const r = await jobsApi.setLineStage(jobId, ids, { stage, via: "manual" });
      const parts = [`${r.advanced.length} moved`];
      if (r.alreadyAt.length) parts.push(`${r.alreadyAt.length} already there`);
      if (r.blocked.length) parts.push(`${r.blocked.length} blocked: ${r.blocked[0]!.reason}`);
      return parts.join(", ") + ".";
    });

  const remove = () => {
    if (!window.confirm(`Take ${ids.length} line${ids.length === 1 ? "" : "s"} off this job? Their stage history goes too.`)) return;
    void run(async () => {
      const r = await jobsApi.removeLines(jobId, ids);
      return `Removed ${r.removed}.`;
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-sky-900 bg-sky-950/20 p-3">
      <p className="text-sm text-sky-200">
        {ids.length} line{ids.length === 1 ? "" : "s"} selected
      </p>
      <form onSubmit={apply} className="grid gap-2 sm:grid-cols-3">
        <LocationSelect
          value={destination}
          onChange={setDestination}
          options={[{ id: "-", label: "(clear destination)" }, ...locationOptions]}
          placeholder="Destination: unchanged"
          label="Destination"
        />
        <input value={desk} onChange={(e) => setDesk(e.target.value)} placeholder="Desk or room label" aria-label="Desk or room label" className={FIELD} />
        <input value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="Floor" aria-label="Floor" className={FIELD} />
        <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Department" aria-label="Department" className={FIELD} />
        <input value={crate} onChange={(e) => setCrate(e.target.value)} placeholder="Crate number" aria-label="Crate number" className={FIELD} />
        <select value={shipment} onChange={(e) => setShipment(e.target.value)} aria-label="Shipment" className={SELECT}>
          <option value="">Shipment: unchanged</option>
          <option value="-">(take off shipment)</option>
          {shipments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
        <div className="sm:col-span-3">
          <button className={BTN} disabled={busy}>
            Apply to selected
          </button>
        </div>
      </form>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Set stage" className={SELECT}>
            <option value="">Set stage…</option>
            {meta?.stages.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
          <button onClick={applyStage} disabled={busy || !stage} className={BTN_QUIET}>
            Set stage
          </button>
          <button onClick={remove} disabled={busy} className={BTN_DANGER}>
            Remove from job
          </button>
        </div>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

type Tab = "codes" | "location" | "csv";

function AddItems({
  jobId,
  locationOptions,
  captureActive,
  onCaptureChange,
  onAdded,
}: {
  jobId: string;
  locationOptions: { id: string; label: string }[];
  captureActive: boolean;
  onCaptureChange: (on: boolean) => void;
  onAdded: () => void;
}) {
  const terms = useTerms();
  const features = useFeatures();
  const { armBulkCapture } = useScan();
  const [tab, setTab] = useState<Tab | null>(null);
  const [codes, setCodes] = useState("");
  const [locationId, setLocationId] = useState("");
  const [departmentLevel, setDepartmentLevel] = useState("1");
  const [floor, setFloor] = useState("");
  const [includeContents, setIncludeContents] = useState(true);
  const [perUnit, setPerUnit] = useState(true);
  const [csv, setCsv] = useState("");
  const [addMissing, setAddMissing] = useState(true);
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  // Scanning into the code box, while this panel owns the page's capture.
  const appendRef = useRef((code: string) => setCodes((c) => (c ? `${c}\n${code}` : code)));
  useEffect(() => {
    if (captureActive) armBulkCapture(appendRef.current);
  }, [captureActive, armBulkCapture]);
  useEffect(() => {
    if (tab !== "codes" && captureActive) onCaptureChange(false);
  }, [tab, captureActive, onCaptureChange]);

  const run = async (fn: () => Promise<{ tone: "ok" | "warn"; text: string }>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
      onAdded();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const addCodes = () =>
    void run(async () => {
      const list = codes.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
      if (!list.length) throw new Error("Scan or type at least one code.");
      const r = await jobsApi.addByCodes(jobId, list);
      setCodes("");
      const notes = [
        r.alreadyOnJob.length ? `${r.alreadyOnJob.length} already on the job` : null,
        r.unknown.length ? `unknown: ${r.unknown.join(", ")}` : null,
        r.ambiguous.length ? `shared by several ${terms.item.plural.toLowerCase()} (scan their own label): ${r.ambiguous.join(", ")}` : null,
      ].filter(Boolean);
      return {
        tone: r.unknown.length || r.ambiguous.length ? "warn" : "ok",
        text: `Added ${r.added}.${notes.length ? ` ${notes.join("; ")}.` : ""}`,
      };
    });

  const addLocation = () =>
    void run(async () => {
      if (!locationId) throw new Error(`Choose a ${terms.location.singular.toLowerCase()}.`);
      const r = await jobsApi.addFromLocation(jobId, {
        locationId,
        includeContents,
        perUnit: features.units ? perUnit : false,
        departmentLevel: departmentLevel === "" ? null : Number(departmentLevel),
        floor: floor.trim() || undefined,
      });
      return {
        tone: "ok",
        text: `Found ${r.found}; added ${r.added}${r.alreadyOnJob ? `, ${r.alreadyOnJob} already on the job` : ""}.`,
      };
    });

  const importCsv = () =>
    void run(async () => {
      if (!csv.trim()) throw new Error("Paste a CSV or choose a file first.");
      const r = await jobsApi.importCsv(jobId, csv, addMissing);
      setCsvResult(r);
      const problems =
        r.unknownCodes.length + r.ambiguousCodes.length + r.unmatchedDestinations.length + r.errors.length + r.notOnJob.length;
      return {
        tone: problems ? "warn" : "ok",
        text: `Added ${r.added}, updated ${r.updated}.${problems ? " Some rows need a look; see below." : ""}`,
      };
    });

  const tabButton = (t: Tab, label: string) => (
    <button
      onClick={() => {
        setTab(tab === t ? null : t);
        setMessage(null);
      }}
      className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
      aria-pressed={tab === t}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-2 text-sm text-slate-400">Add {terms.item.plural.toLowerCase()}:</span>
        {tabButton("codes", "By code")}
        {tabButton("location", `Everything in a ${terms.location.singular.toLowerCase()}`)}
        {tabButton("csv", "Move plan (CSV)")}
      </div>

      {tab === "codes" && (
        <div className="space-y-2">
          <textarea
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            rows={3}
            placeholder="Asset codes, unit codes, serials or tags, one per line"
            aria-label="Codes to add"
            className={FIELD}
          />
          <div className="flex flex-wrap gap-2">
            <button onClick={addCodes} disabled={busy} className={BTN}>
              Add to job
            </button>
            <button onClick={() => onCaptureChange(!captureActive)} className={BTN_QUIET} aria-pressed={captureActive}>
              {captureActive ? "Stop scanning into the list" : "Scan into the list"}
            </button>
          </div>
        </div>
      )}

      {tab === "location" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <LocationSelect
            value={locationId}
            onChange={setLocationId}
            options={locationOptions}
            placeholder={`Choose a ${terms.location.singular.toLowerCase()}, such as a floor`}
            label={terms.location.singular}
          />
          <select
            value={departmentLevel}
            onChange={(e) => setDepartmentLevel(e.target.value)}
            aria-label="Department from"
            className={SELECT}
          >
            <option value="1">Department: the level just below it</option>
            <option value="2">Department: two levels below it</option>
            <option value="0">Department: the chosen {terms.location.singular.toLowerCase()} itself</option>
            <option value="">Department: leave blank</option>
          </select>
          <input
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            placeholder="Destination floor (optional)"
            aria-label="Destination floor"
            className={FIELD}
          />
          <div className="flex flex-col gap-1 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeContents} onChange={(e) => setIncludeContents(e.target.checked)} />
              Include what is packed inside containers
            </label>
            {features.units && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={perUnit} onChange={(e) => setPerUnit(e.target.checked)} />
                One line per tracked unit
              </label>
            )}
          </div>
          <div className="sm:col-span-2">
            <button onClick={addLocation} disabled={busy} className={BTN}>
              Add everything there
            </button>
          </div>
        </div>
      )}

      {tab === "csv" && (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Columns: <code className="text-slate-300">code, destination, floor, department, desk</code> (plus optional{" "}
            <code className="text-slate-300">crate</code> and <code className="text-slate-300">notes</code>). A row with a code
            sets that {terms.item.singular.toLowerCase()}; a row with only a department sets every line in that department.
            Destinations match a {terms.location.singular.toLowerCase()} by code, full path or unique name.
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={5}
            placeholder={"code,destination,floor,department,desk\n,HQ / Level 5,5,Finance,\nINV-7F3K2A,,,,5.12"}
            aria-label="Move plan CSV"
            className={`${FIELD} font-mono`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className={`${BTN_QUIET} cursor-pointer`}>
              Choose file
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void file.text().then(setCsv);
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={addMissing} onChange={(e) => setAddMissing(e.target.checked)} />
              Add {terms.item.plural.toLowerCase()} not on the job yet
            </label>
            <button onClick={importCsv} disabled={busy} className={BTN}>
              Apply move plan
            </button>
          </div>
          {csvResult && <CsvReport result={csvResult} />}
        </div>
      )}

      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

function CsvReport({ result }: { result: CsvImportResult }) {
  const rows = useMemo(
    () => [
      ...result.errors.map((e) => `Line ${e.line}: ${e.message}`),
      ...result.unknownCodes.map((e) => `Line ${e.line}: no record has code ${e.code}.`),
      ...result.ambiguousCodes.map((e) => `Line ${e.line}: ${e.code} is shared by several records; use each one's own label.`),
      ...result.notOnJob.map((e) => `Line ${e.line}: ${e.code} is not on this job (adding was off).`),
      ...result.unmatchedDestinations.map(
        (e) =>
          `Line ${e.line}: "${e.value}" ${e.reason === "ambiguous" ? "matches more than one place; use the full path" : "matches no place"}; kept as the destination label.`,
      ),
    ],
    [result],
  );
  return (
    <div className="space-y-1 text-sm">
      {result.departments.length > 0 && (
        <p className="text-slate-300">
          Departments set:{" "}
          {result.departments.map((d) => `${d.department} (${d.lines} line${d.lines === 1 ? "" : "s"})`).join(", ")}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-amber-300">
          {rows.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
