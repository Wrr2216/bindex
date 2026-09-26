import { useEffect, useState, type FormEvent } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { useConfig, useTerms } from "../../config/useConfig";
import { BUTTON, FIELD, Field, Section } from "../../components/ui";
import { registerApi } from "./api";
import { ImportDetail } from "./ImportDetail";
import { RunView } from "./RunView";
import { Notice, PRESET_LABEL, SELECT, errorText, formatDate } from "./shared";
import type { RegisterImportSummary, RegisterPreset } from "./types";

/** Asset register import and reconciliation, under /audit/register. */
export function RegisterReconcile() {
  return (
    <Routes>
      <Route index element={<RegisterHome />} />
      <Route path="runs/:runId" element={<RunView />} />
      <Route path=":importId" element={<ImportDetail />} />
    </Routes>
  );
}

function RegisterHome() {
  const terms = useTerms();
  const { config } = useConfig();
  const navigate = useNavigate();
  const [imports, setImports] = useState<RegisterImportSummary[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<RegisterPreset | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registerApi.listImports().then(setImports).catch((e) => setError(errorText(e)));
  }, []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const imp = await registerApi.upload(file, { name: name.trim() || undefined, preset: preset || undefined });
      navigate(`/audit/register/${imp.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Asset registers</h1>
        <Link to="/audit" className="text-sm text-sky-400 hover:underline">
          Back to audit
        </Link>
      </div>
      <p className="text-sm text-slate-400">
        Upload the list another system keeps (an IT asset register, a fixed-asset ledger, a Snipe-IT or Homebox
        export) and compare it with what is on file here: what is missing, what is misplaced, and what disagrees.
        Or bring it in as new {terms.item.plural.toLowerCase()}. Nothing changes until you choose an action.
      </p>

      <Section title="Upload a register" description="CSV (comma, semicolon or tab separated) or XLSX, up to 50,000 rows.">
        <form onSubmit={upload} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="File">
            <input
              type="file"
              accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-slate-100"
            />
          </Field>
          <Field label="Source" hint="Which system wrote the file. Detected from the headers when left alone.">
            <select value={preset} onChange={(e) => setPreset(e.target.value as RegisterPreset | "")} className={`${SELECT} w-full`}>
              <option value="">Detect from the headers</option>
              {Object.entries(PRESET_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" hint="Defaults to the file name.">
            <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder="Q3 fixed-asset register" />
          </Field>
          <div className="flex items-end">
            <button type="submit" disabled={!file || busy} className={BUTTON}>
              {busy ? "Reading…" : "Upload"}
            </button>
          </div>
        </form>
        {error && (
          <div className="mt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </Section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Uploaded registers</h2>
        {imports === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : imports.length === 0 ? (
          <p className="text-sm text-slate-500">None yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {imports.map((imp) => (
              <li key={imp.id}>
                <Link
                  to={`/audit/register/${imp.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-800"
                >
                  <span className="font-medium text-slate-100">{imp.name}</span>
                  <span className="text-slate-400">
                    {imp.rowCount} rows · {PRESET_LABEL[imp.sourcePreset] ?? imp.sourcePreset}
                    {imp.fileName ? ` · ${imp.fileName}` : ""}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">
                    {imp.runCount
                      ? `${imp.runCount} run${imp.runCount === 1 ? "" : "s"}, last ${formatDate(imp.lastRunAt!, config.locale)}`
                      : `Uploaded ${formatDate(imp.createdAt, config.locale)}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
