import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useConfig, useFeatures, useMoney, useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Section } from "../../components/ui";
import { registerApi } from "./api";
import {
  CLASS_LABEL,
  Notice,
  PRESET_LABEL,
  SELECT,
  errorText,
  formatDate,
  useCompanies,
  useLocationOptions,
} from "./shared";
import {
  CLASS_ORDER,
  type FieldInfo,
  type ImportPreview,
  type LocationResolution,
  type RegisterField,
  type RegisterImport,
  type RegisterPreset,
  type RegisterRow,
} from "./types";

export function ImportDetail() {
  const { importId = "" } = useParams();
  const navigate = useNavigate();
  const [imp, setImp] = useState<RegisterImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = useCallback(() => {
    registerApi.getImport(importId).then(setImp).catch((e) => setError(errorText(e)));
  }, [importId]);

  useEffect(() => {
    load();
    registerApi.presets().then((p) => setFields(p.fields)).catch(() => undefined);
  }, [load]);

  if (error && !imp) return <Notice tone="error">{error}</Notice>;
  if (!imp) return <p className="text-sm text-slate-500">Loading…</p>;

  const rename = async () => {
    if (!renaming?.trim()) return setRenaming(null);
    try {
      setImp(await registerApi.updateImport(imp.id, { name: renaming.trim() }));
      setRenaming(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${imp.name}" and all its reconciliation runs? Records already created from it stay.`)) return;
    await registerApi.deleteImport(imp.id);
    navigate("/audit/register");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renaming === null ? (
          <h1 className="text-xl font-semibold text-slate-100">{imp.name}</h1>
        ) : (
          <div className="flex gap-2">
            <input value={renaming} onChange={(e) => setRenaming(e.target.value)} className={FIELD} aria-label="Register name" />
            <button onClick={rename} className={BUTTON}>
              Save
            </button>
          </div>
        )}
        <div className="flex items-center gap-3 text-sm">
          {renaming === null && (
            <button onClick={() => setRenaming(imp.name)} className="text-sky-400 hover:underline">
              Rename
            </button>
          )}
          <button onClick={remove} className="text-red-400 hover:underline">
            Delete
          </button>
          <Link to="/audit/register" className="text-sky-400 hover:underline">
            All registers
          </Link>
        </div>
      </div>
      <p className="text-sm text-slate-400">
        {imp.rowCount} rows from {imp.fileName ?? "an upload"} ({imp.fileFormat.toUpperCase()}), read as{" "}
        {PRESET_LABEL[imp.sourcePreset] ?? imp.sourcePreset}.
        {imp.createdItems > 0 && ` ${imp.createdItems} rows have been imported as new records.`}
      </p>
      {imp.sameFileAs && (
        <Notice tone="info">
          The same file was already uploaded as{" "}
          <Link to={`/audit/register/${imp.sameFileAs.id}`} className="text-sky-400 hover:underline">
            {imp.sameFileAs.name}
          </Link>
          .
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <MappingSection imp={imp} fields={fields} onChange={setImp} />
      <LocationsSection importId={imp.id} version={imp.updatedAt} />
      <ReconcileSection imp={imp} />
      <ImportNewSection imp={imp} onDone={load} />
      <RunsSection imp={imp} onChange={load} />
    </div>
  );
}

// --- Column mapping -----------------------------------------------------------

function MappingSection({
  imp,
  fields,
  onChange,
}: {
  imp: RegisterImport;
  fields: FieldInfo[];
  onChange: (imp: RegisterImport) => void;
}) {
  const money = useMoney();
  const [mapping, setMapping] = useState<Record<string, string>>(imp.columnMapping as Record<string, string>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<RegisterRow[] | null>(null);

  useEffect(() => setMapping(imp.columnMapping as Record<string, string>), [imp.columnMapping]);

  const dirty = JSON.stringify(mapping) !== JSON.stringify(imp.columnMapping);
  const used = new Map<string, string>();
  for (const [field, header] of Object.entries(mapping)) if (header) used.set(header, field);

  const save = async (patch: { preset?: RegisterPreset; mapping?: Record<string, string | null> }) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await registerApi.updateImport(imp.id, patch));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const showIssues = async () => {
    const res = await registerApi.rows(imp.id, { issues: true, limit: 100 });
    setIssues(res.rows);
  };

  const sample = imp.sample.slice(0, 8);
  return (
    <Section
      title="Columns"
      description="Which column in the file feeds each field. Matching uses the asset tag, serial, EPC and printed code."
      aside={
        <select
          value={imp.sourcePreset}
          disabled={busy}
          onChange={(e) => void save({ preset: e.target.value as RegisterPreset })}
          aria-label="Source preset"
          className={SELECT}
        >
          {Object.entries(PRESET_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      }
    >
      <div className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="flex items-center gap-3 text-sm" title={f.hint}>
            <span className="w-32 shrink-0 text-slate-300">{f.label}</span>
            <select
              value={mapping[f.key] ?? ""}
              onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
              className={`${SELECT} min-w-0 flex-1`}
            >
              <option value="">Not used</option>
              {imp.headers.map((h) => (
                <option key={h} value={h} disabled={used.has(h) && used.get(h) !== f.key}>
                  {h}
                </option>
              ))}
            </select>
            <span className="w-16 shrink-0 text-right text-xs text-slate-500">
              {mapping[f.key] && !dirty ? `${imp.coverage[f.key as RegisterField] ?? 0} rows` : ""}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save({ mapping: Object.fromEntries(fields.map((f) => [f.key, mapping[f.key] || null])) })}
          disabled={!dirty || busy}
          className={BUTTON}
        >
          {busy ? "Re-reading rows…" : "Save columns"}
        </button>
        {imp.rowsWithIssues > 0 && (
          <button onClick={() => void showIssues()} className="text-sm text-amber-400 hover:underline">
            {imp.rowsWithIssues} row{imp.rowsWithIssues === 1 ? " has" : "s have"} unreadable cells
          </button>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {issues && (
        <ul className="mt-3 space-y-1 text-sm">
          {issues.map((r) => (
            <li key={r.id} className="text-slate-400">
              <span className="text-slate-300">Row {r.rowNumber}:</span> {r.issues.join(" ")}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Row</th>
              <th className="py-1 pr-3 font-medium">Tag</th>
              <th className="py-1 pr-3 font-medium">Serial</th>
              <th className="py-1 pr-3 font-medium">Name</th>
              <th className="py-1 pr-3 font-medium">Model</th>
              <th className="py-1 pr-3 font-medium">Location</th>
              <th className="py-1 pr-3 font-medium">Cost</th>
              <th className="py-1 font-medium">Purchased</th>
            </tr>
          </thead>
          <tbody className="text-slate-300">
            {sample.map((r) => (
              <tr key={r.id} className="border-t border-slate-800">
                <td className="py-1 pr-3 text-slate-500">{r.rowNumber}</td>
                <td className="py-1 pr-3 font-mono">{r.assetTag ?? ""}</td>
                <td className="py-1 pr-3 font-mono">{r.serial ?? ""}</td>
                <td className="py-1 pr-3">{r.name ?? ""}</td>
                <td className="py-1 pr-3">{r.model ?? ""}</td>
                <td className="py-1 pr-3">{r.locationText ?? ""}</td>
                <td className="py-1 pr-3">{r.costCents == null ? "" : money(r.costCents)}</td>
                <td className="py-1">{r.purchaseDate ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {dirty && <p className="mt-2 text-xs text-amber-400">The preview shows the saved columns. Save to re-read the rows.</p>}
      </div>
    </Section>
  );
}

// --- Locations ----------------------------------------------------------------

function LocationsSection({ importId, version }: { importId: string; version: string }) {
  const terms = useTerms();
  const options = useLocationOptions();
  const [list, setList] = useState<LocationResolution[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    registerApi.locations(importId).then(setList).catch((e) => setError(errorText(e)));
  }, [importId]);
  useEffect(load, [load, version]);

  const save = async (text: string, locationId: string | null) => {
    setError(null);
    try {
      await registerApi.setLocationMapping(text, locationId);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!list) return null;
  const unresolved = list.filter((l) => !l.locationId).length;
  return (
    <Section
      title={`${terms.location.plural} in the register`}
      description={`Matched by full path, then by a name only one ${terms.location.singular.toLowerCase()} has, then by a mapping you save here. Mappings are remembered for later registers.`}
    >
      {list.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">The register has no location column, or it is empty.</p>
      ) : (
        <>
          {unresolved > 0 && (
            <p className="mt-3 text-sm text-amber-400">
              {unresolved} of {list.length} not matched yet. Rows there are never reported as misplaced.
            </p>
          )}
          <ul className="mt-3 divide-y divide-slate-800 text-sm">
            {list.map((l) => (
              <li key={l.text} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-40 text-slate-200">{l.text}</span>
                <span className="text-xs text-slate-500">
                  {l.rows} row{l.rows === 1 ? "" : "s"}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {l.locationId && l.via !== "mapping" ? (
                    <span className="text-slate-400">
                      {l.path} <span className="text-xs text-slate-500">(by {l.via})</span>
                    </span>
                  ) : (
                    <>
                      {!l.locationId && (
                        <span className="text-xs text-amber-400">{l.ambiguous ? "More than one match" : "Not found"}</span>
                      )}
                      <select
                        value={choice[l.text] ?? l.locationId ?? ""}
                        onChange={(e) => setChoice((c) => ({ ...c, [l.text]: e.target.value }))}
                        aria-label={`Map ${l.text}`}
                        className={`${SELECT} max-w-72`}
                      >
                        <option value="">Choose…</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => void save(l.text, choice[l.text] || null)}
                        disabled={(choice[l.text] ?? l.locationId ?? "") === (l.locationId ?? "")}
                        className={BUTTON_QUIET}
                      >
                        {l.via === "mapping" && !(choice[l.text] ?? l.locationId) ? "Forget" : "Save"}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </Section>
  );
}

// --- Reconcile ----------------------------------------------------------------

function ReconcileSection({ imp }: { imp: RegisterImport }) {
  const terms = useTerms();
  const features = useFeatures();
  const navigate = useNavigate();
  const companies = useCompanies(features.groups);
  const options = useLocationOptions();
  const [companyId, setCompanyId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await registerApi.reconcile(imp.id, { companyId: companyId || null, locationId: locationId || null });
      navigate(`/audit/register/runs/${r.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Section
      title="Reconcile"
      description={`Compare the register with what is on file. A scope limits which ${terms.item.plural.toLowerCase()} count as missing from the register; rows still match anything.`}
    >
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {features.groups && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Scope group" className={SELECT}>
            <option value="">Every {terms.group.singular.toLowerCase()}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Scope location" className={`${SELECT} max-w-80`}>
          <option value="">Every {terms.location.singular.toLowerCase()}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label} and inside
            </option>
          ))}
        </select>
        <button onClick={() => void run()} disabled={busy} className={BUTTON}>
          {busy ? "Reconciling…" : "Reconcile"}
        </button>
      </div>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </Section>
  );
}

// --- Import as new --------------------------------------------------------------

function ImportNewSection({ imp, onDone }: { imp: RegisterImport; onDone: () => void }) {
  const terms = useTerms();
  const features = useFeatures();
  const money = useMoney();
  const companies = useCompanies(features.groups);
  const options = useLocationOptions();
  const [companyId, setCompanyId] = useState("");
  const [defaultLocationId, setDefaultLocationId] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const opts = { companyId: companyId || null, defaultLocationId: defaultLocationId || null };

  useEffect(() => setPreview(null), [companyId, defaultLocationId, imp.updatedAt]);

  const doPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await registerApi.importPreview(imp.id, opts));
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await registerApi.importCommit(imp.id, { ...opts, planHash: preview.hash });
      setMessage({ tone: "ok", text: `Created ${res.created.length} ${terms.item.plural.toLowerCase()}.` });
      setPreview(null);
      onDone();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const skipReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of preview?.skip ?? []) {
      const key = s.reason.replace(/ \S+ is already on \S+\./, " is already on file.").replace(/the same as row \d+/, "a repeat of an earlier row");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts];
  }, [preview]);

  const shown = preview ? (showAll ? preview.create : preview.create.slice(0, 50)) : [];
  return (
    <Section
      title={`Import as new ${terms.item.plural.toLowerCase()}`}
      description={`For moving off another system. Every row whose tag, serial and EPC are not already on file becomes a new ${terms.item.singular.toLowerCase()}. Preview first: exactly what the preview lists is what gets created.`}
    >
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {features.groups && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Group for new records" className={SELECT}>
            <option value="">No {terms.group.singular.toLowerCase()}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={defaultLocationId}
          onChange={(e) => setDefaultLocationId(e.target.value)}
          aria-label="Default location"
          className={`${SELECT} max-w-80`}
        >
          <option value="">Unmatched {terms.location.plural.toLowerCase()}: leave empty</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              Unmatched {terms.location.plural.toLowerCase()}: {o.label}
            </option>
          ))}
        </select>
        <button onClick={() => void doPreview()} disabled={busy} className={BUTTON_QUIET}>
          Preview
        </button>
      </div>
      {message && (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      {preview && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-300">
            {preview.create.length} to create, {preview.skip.length} skipped
            {preview.warnings.length ? `, ${preview.warnings.length} with a warning` : ""}.
          </p>
          {skipReasons.length > 0 && (
            <ul className="text-sm text-slate-400">
              {skipReasons.map(([reason, n]) => (
                <li key={reason}>
                  Skipped {n}: {reason}
                </li>
              ))}
            </ul>
          )}
          {preview.create.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Row</th>
                    <th className="py-1 pr-3 font-medium">Name</th>
                    <th className="py-1 pr-3 font-medium">Model</th>
                    <th className="py-1 pr-3 font-medium">Identifiers</th>
                    <th className="py-1 pr-3 font-medium">{terms.location.singular}</th>
                    <th className="py-1 pr-3 font-medium">Qty</th>
                    <th className="py-1 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  {shown.map((c) => (
                    <tr key={c.rowId} className="border-t border-slate-800">
                      <td className="py-1 pr-3 text-slate-500">{c.rowNumber}</td>
                      <td className="py-1 pr-3">{c.name}</td>
                      <td className="py-1 pr-3">{[c.brand, c.model].filter(Boolean).join(" ")}</td>
                      <td className="py-1 pr-3 font-mono">{c.identifiers.map((i) => i.value).join(", ")}</td>
                      <td className="py-1 pr-3">{c.locationPath ?? ""}</td>
                      <td className="py-1 pr-3">{c.quantity}</td>
                      <td className="py-1">{c.valueCents == null ? "" : money(c.valueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.create.length > shown.length && (
                <button onClick={() => setShowAll(true)} className="mt-2 text-sm text-sky-400 hover:underline">
                  Show all {preview.create.length}
                </button>
              )}
            </div>
          )}
          {preview.warnings.length > 0 && (
            <details className="text-sm text-slate-400">
              <summary className="cursor-pointer text-amber-400">Warnings</summary>
              <ul className="mt-1">
                {preview.warnings.map((w) => (
                  <li key={w.rowId}>
                    Row {w.rowNumber}: {w.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button onClick={() => void commit()} disabled={busy || preview.create.length === 0} className={BUTTON}>
            Create {preview.create.length} {preview.create.length === 1 ? terms.item.singular.toLowerCase() : terms.item.plural.toLowerCase()}
          </button>
        </div>
      )}
    </Section>
  );
}

// --- Runs ---------------------------------------------------------------------

function RunsSection({ imp, onChange }: { imp: RegisterImport; onChange: () => void }) {
  const { config } = useConfig();
  if (!imp.runs.length) return null;
  const remove = async (id: string) => {
    if (!window.confirm("Delete this run? The register and any changes made from it stay.")) return;
    await registerApi.deleteRun(id);
    onChange();
  };
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Runs</h2>
      <ul className="space-y-1.5">
        {imp.runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-800/60 px-3 py-2 text-sm">
            <Link to={`/audit/register/runs/${r.id}`} className="font-medium text-sky-300 hover:underline">
              {formatDate(r.createdAt, config.locale)}
            </Link>
            <span className="text-slate-400">{r.scopeLabel}</span>
            <span className="text-xs text-slate-500">
              {CLASS_ORDER.filter((c) => r.counts[c])
                .map((c) => `${CLASS_LABEL[c]} ${r.counts[c]}`)
                .join(" · ")}
            </span>
            <button onClick={() => void remove(r.id)} className="ml-auto text-xs text-slate-500 hover:text-red-400">
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
