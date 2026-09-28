import { useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "../media-ai-core/Modal";
import { valuationApi } from "./api";
import { BTN, BTN_PRIMARY, FIELD, LABEL, centsToInput, errorText, parseMoneyInput, todayIso } from "./format";
import type { ServicePlan, ValuationProfile, ValuationSource } from "./types";

/** The small forms behind the item's valuation panel. */

function Form({ title, onClose, onSubmit, busy, error, submitLabel, children }: {
  title: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {children}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className={`${BTN_PRIMARY} flex-1 justify-center py-2`}>
            {busy ? "Saving…" : submitLabel}
          </button>
          <button type="button" onClick={onClose} className={BTN}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className={LABEL}>{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function useSubmit(action: () => Promise<void>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(errorText(err, "That was not saved."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Record a value by hand: an appraisal, a price seen elsewhere, a correction. */
export function RecordValueDialog({ itemId, unitId, currentCents, onSaved, onClose }: {
  itemId: string;
  unitId: string | null;
  currentCents: number | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(centsToInput(currentCents));
  const [source, setSource] = useState<ValuationSource>("manual");
  const [valuedOn, setValuedOn] = useState(todayIso());
  const [basis, setBasis] = useState("");
  const s = useSubmit(async () => {
    const cents = parseMoneyInput(value);
    if (cents === null || cents < 0) throw new Error("Enter a value of zero or more.");
    await valuationApi.recordValuation(itemId, { unitId, valueCents: cents, source, valuedOn, basis: basis.trim() || null });
  }, onSaved);
  return (
    <Form title="Record value" onClose={onClose} onSubmit={s.run} busy={s.busy} error={s.error} submitLabel="Record value">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Value">
          <input className={FIELD} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
        </Field>
        <Field label="Source">
          <select className={FIELD} value={source} onChange={(e) => setSource(e.target.value as ValuationSource)}>
            <option value="manual">Entered by hand</option>
            <option value="appraisal">Appraisal</option>
            <option value="web">Web price</option>
          </select>
        </Field>
        <Field label="Valued on">
          <input type="date" className={FIELD} value={valuedOn} max={todayIso()} onChange={(e) => setValuedOn(e.target.value)} required />
        </Field>
        <Field label="Basis" wide>
          <input className={FIELD} value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="e.g. Appraisal by Smith & Co, ref 1142" maxLength={500} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">The value before this one stays in the history.</p>
    </Form>
  );
}

/** Purchase, warranty and hour-meter facts for the item or one unit. */
export function ProfileDialog({ itemId, unitId, profile, onSaved, onClose }: {
  itemId: string;
  unitId: string | null;
  profile: ValuationProfile | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [purchaseDate, setPurchaseDate] = useState(profile?.purchaseDate ?? "");
  const [price, setPrice] = useState(centsToInput(profile?.purchaseCents));
  const [vendor, setVendor] = useState(profile?.vendor ?? "");
  const [warrantyEnds, setWarrantyEnds] = useState(profile?.warrantyEnds ?? "");
  const [provider, setProvider] = useState(profile?.warrantyProvider ?? "");
  const [terms, setTerms] = useState(profile?.warrantyTerms ?? "");
  const [hours, setHours] = useState(profile?.usageHours?.toString() ?? "");
  const s = useSubmit(async () => {
    const purchaseCents = price.trim() ? parseMoneyInput(price) : null;
    if (price.trim() && purchaseCents === null) throw new Error("The purchase price could not be read.");
    const usage = hours.trim() ? Number(hours) : null;
    if (usage !== null && !(usage >= 0)) throw new Error("Hours of use must be a number.");
    await valuationApi.saveProfile(itemId, {
      unitId,
      purchaseDate: purchaseDate || null,
      purchaseCents,
      vendor: vendor.trim() || null,
      warrantyEnds: warrantyEnds || null,
      warrantyProvider: provider.trim() || null,
      warrantyTerms: terms.trim() || null,
      ...(usage !== (profile?.usageHours ?? null) ? { usageHours: usage } : {}),
    });
  }, onSaved);
  return (
    <Form title="Purchase and warranty" onClose={onClose} onSubmit={s.run} busy={s.busy} error={s.error} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Purchase date">
          <input type="date" className={FIELD} value={purchaseDate} max={todayIso()} onChange={(e) => setPurchaseDate(e.target.value)} />
        </Field>
        <Field label="Price paid">
          <input className={FIELD} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Bought from" wide>
          <input className={FIELD} value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Warranty ends">
          <input type="date" className={FIELD} value={warrantyEnds} onChange={(e) => setWarrantyEnds(e.target.value)} />
        </Field>
        <Field label="Warranty provider">
          <input className={FIELD} value={provider} onChange={(e) => setProvider(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Warranty terms" wide>
          <textarea className={FIELD} rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={1000} />
        </Field>
        <Field label="Hour meter (hours of use)">
          <input className={FIELD} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
    </Form>
  );
}

/** Add or change a service plan. */
export function PlanDialog({ itemId, unitId, plan, onSaved, onClose }: {
  itemId: string;
  unitId: string | null;
  plan: ServicePlan | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(plan?.name ?? "");
  const [days, setDays] = useState(plan?.intervalDays?.toString() ?? "");
  const [hours, setHours] = useState(plan?.intervalHours?.toString() ?? "");
  const [lastDone, setLastDone] = useState(plan?.lastDoneAt?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [active, setActive] = useState(plan?.active ?? true);
  const s = useSubmit(async () => {
    const intervalDays = days.trim() ? Number(days) : null;
    const intervalHours = hours.trim() ? Number(hours) : null;
    if (!intervalDays && !intervalHours) throw new Error("Give an interval in days, hours of use, or both.");
    if (plan) {
      await valuationApi.updatePlan(plan.id, { name, intervalDays, intervalHours, notes: notes.trim() || null, active });
    } else {
      await valuationApi.createPlan(itemId, { unitId, name, intervalDays, intervalHours, lastDoneAt: lastDone || null, notes: notes.trim() || null });
    }
  }, onSaved);
  return (
    <Form title={plan ? "Edit service plan" : "Add service plan"} onClose={onClose} onSubmit={s.run} busy={s.busy} error={s.error} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Service" wide>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Annual inspection, Oil change" required maxLength={120} autoFocus />
        </Field>
        <Field label="Every (days)">
          <input className={FIELD} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 365" />
        </Field>
        <Field label="Every (hours of use)">
          <input className={FIELD} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 250" />
        </Field>
        {!plan && (
          <Field label="Last done (if known)">
            <input type="date" className={FIELD} value={lastDone} max={todayIso()} onChange={(e) => setLastDone(e.target.value)} />
          </Field>
        )}
        {plan && (
          <label className="flex items-center gap-2 pt-6 text-sm text-slate-300">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        )}
        <Field label="Notes" wide>
          <input className={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        With both intervals, service falls due at whichever comes first. Hours are counted from the hour meter on the purchase and warranty form.
      </p>
    </Form>
  );
}

/** Record that a plan's service was done. */
export function LogServiceDialog({ plan, onSaved, onClose }: { plan: ServicePlan; onSaved: () => void; onClose: () => void }) {
  const [doneAt, setDoneAt] = useState(todayIso());
  const [hours, setHours] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const s = useSubmit(async () => {
    await valuationApi.logService(plan.id, {
      doneAt: doneAt === todayIso() ? null : doneAt,
      hours: hours.trim() ? Number(hours) : null,
      costCents: cost.trim() ? parseMoneyInput(cost) : null,
      notes: notes.trim() || null,
    });
  }, onSaved);
  return (
    <Form title={`Log service: ${plan.name}`} onClose={onClose} onSubmit={s.run} busy={s.busy} error={s.error} submitLabel="Log service">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Done on">
          <input type="date" className={FIELD} value={doneAt} max={todayIso()} onChange={(e) => setDoneAt(e.target.value)} required />
        </Field>
        <Field label={plan.intervalHours ? "Hour meter reading *" : "Hour meter reading"}>
          <input className={FIELD} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} required={Boolean(plan.intervalHours)} />
        </Field>
        <Field label="Cost">
          <input className={FIELD} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label="Notes" wide>
          <input className={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Form>
  );
}
