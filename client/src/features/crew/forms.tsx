import { useState, type FormEvent } from "react";
import { crewApi, type CredentialInput, type WorkerInput } from "./api";
import { CREDENTIAL_STATUSES, type Credential, type CredentialStatus, type CredentialType, type Worker } from "./types";
import { BTN, BTN_QUIET, FIELD, LABEL, Notice, SELECT, addMonths, errorText } from "./ui";

/** The worker and credential forms, shared by the list and the worker page. */

export function WorkerForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Partial<Worker>;
  onSaved: (worker: Worker) => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    company: initial?.company ?? "",
    role: initial?.role ?? "",
    phone: initial?.phone ?? "",
    badgeCode: initial?.badgeCode ?? "",
    notes: initial?.notes ?? "",
    active: initial?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: WorkerInput = {
      name: form.name,
      company: form.company || null,
      role: form.role || null,
      phone: form.phone || null,
      notes: form.notes || null,
      active: form.active,
      ...(form.badgeCode.trim() ? { badgeCode: form.badgeCode.trim() } : {}),
    };
    try {
      onSaved(editing ? await crewApi.updateWorker(initial!.id!, body) : await crewApi.createWorker(body));
    } catch (err) {
      setError(errorText(err, "The worker could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Name</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} className={`${FIELD} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL}>Company or subcontractor</span>
          <input value={form.company} onChange={(e) => set("company", e.target.value)} maxLength={200} className={`${FIELD} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL}>Role</span>
          <input
            value={form.role}
            onChange={(e) => set("role", e.target.value)}
            maxLength={120}
            placeholder="Driver, forklift operator…"
            className={`${FIELD} mt-1`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Phone</span>
          <input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={60} inputMode="tel" className={`${FIELD} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL}>Badge code</span>
          <input
            value={form.badgeCode}
            onChange={(e) => set("badgeCode", e.target.value)}
            maxLength={64}
            placeholder={editing ? "" : "Leave blank to generate one"}
            className={`${FIELD} mt-1 font-mono`}
          />
          <span className="mt-1 block text-xs text-slate-500">To use an existing ID card, type or scan its number here.</span>
        </label>
        <label className="flex items-center gap-2 self-center text-sm text-slate-300">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active (can be checked in)
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={`${FIELD} mt-1`} />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !form.name.trim()} className={BTN}>
          {editing ? "Save" : "Add worker"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={BTN_QUIET}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<CredentialStatus, string> = {
  valid: "Valid",
  pending: "Pending (not cleared yet)",
  expired: "Expired",
  failed: "Failed",
  suspended: "Suspended",
  revoked: "Revoked",
};

export function CredentialForm({
  types,
  initial,
  onSubmit,
  onCancel,
}: {
  types: CredentialType[];
  initial?: Credential;
  onSubmit: (input: CredentialInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    typeId: initial?.typeId ?? types[0]?.id ?? "",
    status: (initial?.status ?? "valid") as CredentialStatus,
    issuer: initial?.issuer ?? "",
    number: initial?.number ?? "",
    issuedOn: initial?.issuedOn ?? "",
    expiresOn: initial?.expiresOn ?? "",
    noExpiry: initial ? initial.expiresOn === null : false,
    notes: initial?.notes ?? "",
  });
  // Once someone types an expiry, the issue date no longer rewrites it.
  const [expiryTouched, setExpiryTouched] = useState(Boolean(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = types.find((t) => t.id === form.typeId);

  const suggest = (issuedOn: string, typeId: string) => {
    const t = types.find((x) => x.id === typeId);
    return issuedOn && t?.validityMonths ? addMonths(issuedOn, t.validityMonths) : "";
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...(initial ? {} : { typeId: form.typeId }),
        status: form.status,
        issuer: form.issuer || null,
        number: form.number || null,
        issuedOn: form.issuedOn || null,
        expiresOn: form.noExpiry ? null : form.expiresOn || null,
        notes: form.notes || null,
      });
    } catch (err) {
      setError(errorText(err, "The credential could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {!initial && (
          <label className="block">
            <span className={LABEL}>Credential</span>
            <select
              value={form.typeId}
              onChange={(e) => {
                const typeId = e.target.value;
                setForm((f) => ({ ...f, typeId, ...(expiryTouched ? {} : { expiresOn: suggest(f.issuedOn, typeId) }) }));
              }}
              className={`${SELECT} mt-1 w-full`}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className={LABEL}>Status</span>
          <select
            value={form.status}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CredentialStatus }))}
            className={`${SELECT} mt-1 w-full`}
          >
            {CREDENTIAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Number</span>
          <input value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} maxLength={120} className={`${FIELD} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL}>Issuer</span>
          <input value={form.issuer} onChange={(e) => setForm((f) => ({ ...f, issuer: e.target.value }))} maxLength={200} className={`${FIELD} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL}>Issued</span>
          <input
            type="date"
            value={form.issuedOn}
            onChange={(e) => {
              const issuedOn = e.target.value;
              setForm((f) => ({ ...f, issuedOn, ...(expiryTouched || f.noExpiry ? {} : { expiresOn: suggest(issuedOn, f.typeId) }) }));
            }}
            className={`${FIELD} mt-1`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Expires</span>
          <input
            type="date"
            value={form.noExpiry ? "" : form.expiresOn}
            disabled={form.noExpiry}
            onChange={(e) => {
              setExpiryTouched(true);
              setForm((f) => ({ ...f, expiresOn: e.target.value }));
            }}
            className={`${FIELD} mt-1`}
          />
          <span className="mt-1 flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={form.noExpiry} onChange={(e) => setForm((f) => ({ ...f, noExpiry: e.target.checked }))} />
            Does not expire
            {!initial && type?.validityMonths && !form.noExpiry ? ` · usually ${type.validityMonths} months` : ""}
          </span>
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={2000} className={`${FIELD} mt-1`} />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || (!initial && !form.typeId)} className={BTN}>
          {initial ? "Save" : "Add credential"}
        </button>
        <button type="button" onClick={onCancel} className={BTN_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  );
}
