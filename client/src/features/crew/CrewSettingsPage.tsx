import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Toggle } from "../../components/ui";
import { crewApi } from "./api";
import type { CredentialType, CrewPolicy, JobTypePolicy } from "./types";
import { BTN, BTN_QUIET, CARD, FIELD, H2, LABEL, Notice, SELECT, errorText, useCrewStatus } from "./ui";

/**
 * Administrator settings for crew: the kinds of credential workers can hold,
 * what each job type requires of its crew and whether a gap blocks or warns,
 * and the state of the verifier and the expiry digest.
 */
export function CrewSettingsPage() {
  const status = useCrewStatus();
  const [types, setTypes] = useState<CredentialType[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTypes = useCallback(async () => {
    try {
      setTypes(await crewApi.credentialTypes(true));
    } catch (err) {
      setError(errorText(err, "Credential types could not be loaded."));
    }
  }, []);

  useEffect(() => {
    void loadTypes();
  }, [loadTypes]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/settings" className="text-sm text-sky-400 hover:underline">
          ← Settings
        </Link>
        <h1 className="text-xl font-semibold text-slate-100">Crew check-in</h1>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {types && <CredentialTypes types={types} onChanged={loadTypes} />}
      {types && status?.jobs && <JobTypeRules types={types.filter((t) => t.active)} />}
      {status && !status.jobs && (
        <Notice tone="warn">Projects, jobs and shipments are switched off, so there are no jobs to check crew in on. Workers and credentials still work.</Notice>
      )}
      {status && (
        <section className={`${CARD} space-y-2`}>
          <h2 className={H2}>Verifier and digest</h2>
          <p className="text-sm text-slate-300">
            {status.verifier.available
              ? "An external verifier is configured: every badge scanned at check-in is checked with it, and its answer is merged into the worker's credentials."
              : "No external verifier is configured. Set CREDENTIAL_VERIFY_URL to have a background-check or compliance service asked about every badge scanned."}
          </p>
          <p className="text-sm text-slate-300">
            {status.digest.days > 0
              ? `A daily digest of credentials expired or expiring within ${status.digest.days} days goes out after ${String(status.digest.hourUtc).padStart(2, "0")}:00 UTC through the configured notifications, and as a crew.credentials_expiring event.`
              : "The daily expiry digest is off (CREW_EXPIRY_ALERT_DAYS is 0)."}
          </p>
        </section>
      )}
    </div>
  );
}

function CredentialTypes({ types, onChanged }: { types: CredentialType[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className={H2}>Credential types</h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className={BTN_QUIET}>
            Add type
          </button>
        )}
      </div>
      <p className="text-sm text-slate-400">
        What a worker can hold. Amber shows this many days before expiry. A type someone holds cannot be deleted; switch it off to
        stop asking for it everywhere.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {adding && (
        <TypeForm
          onSubmit={async (v) => {
            if (await run(() => crewApi.createCredentialType(v))) setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      <ul className="space-y-2">
        {types.map((t) =>
          editing === t.id ? (
            <li key={t.id}>
              <TypeForm
                initial={t}
                onSubmit={async ({ key: _k, ...v }) => {
                  if (await run(() => crewApi.updateCredentialType(t.id, v))) setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={t.id} className={`${CARD} flex flex-wrap items-center gap-3 ${t.active ? "" : "opacity-60"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-100">
                  {t.name} <span className="ml-1 font-mono text-xs text-slate-500">{t.key}</span>
                </p>
                <p className="text-xs text-slate-400">
                  {t.validityMonths ? `Lasts ${t.validityMonths} months` : "No usual expiry"} · amber {t.warnDays} days before
                  {t.description ? ` · ${t.description}` : ""}
                </p>
              </div>
              <Toggle label={`${t.name} active`} checked={t.active} onChange={(on) => void run(() => crewApi.updateCredentialType(t.id, { active: on }))} />
              <button onClick={() => setEditing(t.id)} className="text-xs text-sky-400 hover:underline">
                Edit
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Delete "${t.name}"?`)) void run(() => crewApi.deleteCredentialType(t.id));
                }}
                className="text-xs text-red-400 hover:underline"
              >
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

type TypeValues = { key?: string; name: string; description: string | null; validityMonths: number | null; warnDays: number };

function TypeForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: CredentialType;
  onSubmit: (v: TypeValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [validity, setValidity] = useState(initial?.validityMonths ? String(initial.validityMonths) : "");
  const [warn, setWarn] = useState(String(initial?.warnDays ?? 30));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onSubmit({
      ...(initial || !key.trim() ? {} : { key: key.trim() }),
      name,
      description: description || null,
      validityMonths: validity ? Math.max(1, Math.min(600, Math.round(Number(validity)))) : null,
      warnDays: Math.max(0, Math.min(365, Math.round(Number(warn) || 0))),
    });
  };

  return (
    <form onSubmit={submit} className={`${CARD} grid gap-3 sm:grid-cols-2`}>
      <label className="block">
        <span className={LABEL}>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} className={`${FIELD} mt-1`} />
      </label>
      {!initial && (
        <label className="block">
          <span className={LABEL}>Key (optional)</span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            maxLength={40}
            placeholder="made from the name"
            className={`${FIELD} mt-1 font-mono`}
          />
          <span className="mt-1 block text-xs text-slate-500">What the verifier calls it. Cannot be changed later.</span>
        </label>
      )}
      <label className="block">
        <span className={LABEL}>Usually lasts (months)</span>
        <input value={validity} onChange={(e) => setValidity(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="does not expire" className={`${FIELD} mt-1`} />
      </label>
      <label className="block">
        <span className={LABEL}>Amber this many days before expiry</span>
        <input value={warn} onChange={(e) => setWarn(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={`${FIELD} mt-1`} />
      </label>
      <label className="block sm:col-span-2">
        <span className={LABEL}>Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className={`${FIELD} mt-1`} />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={!name.trim()} className={BTN}>
          {initial ? "Save" : "Add type"}
        </button>
        <button type="button" onClick={onCancel} className={BTN_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function JobTypeRules({ types }: { types: CredentialType[] }) {
  const [rules, setRules] = useState<JobTypePolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    crewApi
      .jobTypePolicies()
      .then(setRules)
      .catch((err) => setError(errorText(err, "Job types could not be loaded.")));
  }, []);

  return (
    <section className="space-y-2">
      <h2 className={H2}>What each job type requires</h2>
      <p className="text-sm text-slate-400">
        Checked every time a badge is scanned on a job of that type. Block stops anyone red at the door until someone overrides
        with a reason; warn lets them in and flags it.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {rules && rules.length === 0 && (
        <p className="text-sm text-slate-500">
          No job types yet. Add them under{" "}
          <Link to="/settings/job-types" className="text-sky-400 hover:underline">
            Job types
          </Link>
          .
        </p>
      )}
      <ul className="space-y-2">
        {rules?.map((r) => (
          <RuleRow key={r.jobTypeId} rule={r} types={types} onSaved={(saved) => setRules((all) => all?.map((x) => (x.jobTypeId === saved.jobTypeId ? saved : x)) ?? null)} />
        ))}
      </ul>
    </section>
  );
}

function RuleRow({ rule, types, onSaved }: { rule: JobTypePolicy; types: CredentialType[]; onSaved: (r: JobTypePolicy) => void }) {
  const [required, setRequired] = useState<string[]>(rule.required);
  const [policy, setPolicy] = useState<CrewPolicy>(rule.policy);
  const [adminOnly, setAdminOnly] = useState(rule.overrideAdminOnly);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const dirty =
    policy !== rule.policy || adminOnly !== rule.overrideAdminOnly || [...required].sort().join() !== [...rule.required].sort().join();

  const save = async () => {
    setMessage(null);
    try {
      onSaved(await crewApi.setJobTypePolicy(rule.jobTypeId, { required, policy, overrideAdminOnly: adminOnly }));
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  // A required type that has since been retired still shows, so it can be unticked.
  const shown = [...types, ...rule.required.filter((k) => !types.some((t) => t.key === k)).map((k) => ({ key: k, name: `${k} (retired)` }))];

  return (
    <li className={`${CARD} space-y-3 ${rule.active ? "" : "opacity-60"}`}>
      <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: rule.color }} />
        {rule.name}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {shown.map((t) => (
          <label key={t.key} className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={required.includes(t.key)}
              onChange={(e) => setRequired((r) => (e.target.checked ? [...r, t.key] : r.filter((k) => k !== t.key)))}
            />
            {t.name}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select value={policy} onChange={(e) => setPolicy(e.target.value as CrewPolicy)} aria-label={`${rule.name} policy`} className={SELECT}>
          <option value="warn">Warn, and let them in</option>
          <option value="block">Block until overridden</option>
        </select>
        {policy === "block" && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={adminOnly} onChange={(e) => setAdminOnly(e.target.checked)} />
            Only administrators can override
          </label>
        )}
        <button onClick={() => void save()} disabled={!dirty} className={BTN}>
          Save
        </button>
        {message && <span className={`text-sm ${message.tone === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</span>}
      </div>
    </li>
  );
}
