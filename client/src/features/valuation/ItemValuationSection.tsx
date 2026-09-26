import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { ItemDetail } from "../../types";
import { valuationApi } from "./api";
import { EstimateDialog } from "./EstimateDialog";
import {
  BTN,
  BTN_PRIMARY,
  CARD,
  EstimateNote,
  H2,
  HighValueBadge,
  Pill,
  SERVICE_LABEL,
  SOURCE_LABEL,
  describeService,
  describeWarranty,
  errorText,
  formatDay,
  serviceTone,
  useMoneyExact,
  warrantyTone,
} from "./format";
import { LogServiceDialog, PlanDialog, ProfileDialog, RecordValueDialog } from "./ItemDialogs";
import type { HighValueMode, ItemValuation, ServicePlan, ValuationStatus } from "./types";

type Dialog =
  | { kind: "estimate" }
  | { kind: "value" }
  | { kind: "profile" }
  | { kind: "plan"; plan: ServicePlan | null }
  | { kind: "log"; plan: ServicePlan };

/**
 * Value, purchase, warranty and service on the item page: the current value
 * and where it came from, its history, "Estimate from photos", receipts and
 * declarations that name the item, and service plans with what is due. An
 * item with tracked units is valued unit by unit, picked with the chips at
 * the top. Hidden when the feature is off.
 */
export function ItemValuationSection({ item, onItemChange }: { item: ItemDetail; onItemChange?: () => void }) {
  const features = useFeatures();
  const terms = useTerms();
  const navigate = useNavigate();
  const money = useMoneyExact();
  const [data, setData] = useState<ItemValuation | null>(null);
  const [status, setStatus] = useState<ValuationStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await valuationApi.item(item.id));
    } catch (err) {
      setError(errorText(err, "Could not load the valuation."));
    }
  }, [item.id]);

  useEffect(() => {
    if (!features.valuation) return;
    void load();
    valuationApi.status().then(setStatus).catch(() => setStatus(null));
    // Reload when the item itself changes (a unit added, a value edited in the form).
  }, [features.valuation, load, item.updatedAt, item.units.length]);

  if (!features.valuation || item.category === "Domain") return null;
  if (!data) return error ? <p className="text-sm text-red-400">{error}</p> : null;

  const records = data.records;
  // With units, the item's own row is their total and is not valued directly.
  const current = records.find((r) => r.unitId === selected) ?? (data.hasUnits ? records[1] ?? records[0]! : records[0]!);
  const unit = current.unitId ? { id: current.unitId, label: current.label } : null;
  const history = data.valuations.filter((v) => (v.unitId ?? null) === current.unitId);
  const plans = data.servicePlans.filter((p) => (p.unitId ?? null) === current.unitId);
  const latest = current.latest;
  const itemTotal = records[0]!;

  const done = () => {
    setDialog(null);
    void load();
    onItemChange?.();
  };

  const setMode = async (mode: HighValueMode) => {
    setError(null);
    try {
      await valuationApi.saveProfile(item.id, { unitId: current.unitId, highValue: mode });
      await load();
    } catch (err) {
      setError(errorText(err, "Could not change that."));
    }
  };

  const addReceipt = async () => {
    setError(null);
    try {
      const receipt = await valuationApi.createReceipt();
      navigate(`/valuation/receipts/${receipt.id}?item=${item.id}`);
    } catch (err) {
      setError(errorText(err, "Could not start a receipt."));
    }
  };

  const deletePlan = async (plan: ServicePlan) => {
    if (!confirm(`Remove the plan "${plan.name}"? Its log stays.`)) return;
    try {
      await valuationApi.deletePlan(plan.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not remove the plan."));
    }
  };

  const profile = current.profile;
  const purchase = [profile?.purchaseDate && formatDay(profile.purchaseDate), profile?.purchaseCents != null && money(profile.purchaseCents), profile?.vendor]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={`${CARD} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className={H2}>Value and warranty</h2>
          {current.highValue && <HighValueBadge />}
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.vision && (
            <button type="button" className={BTN_PRIMARY} onClick={() => setDialog({ kind: "estimate" })}>
              Estimate from photos
            </button>
          )}
          <button type="button" className={BTN} onClick={() => setDialog({ kind: "value" })}>
            Record value
          </button>
          <button type="button" className={BTN} onClick={addReceipt}>
            Add receipt
          </button>
        </div>
      </div>

      {data.hasUnits && (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which unit">
            {records.slice(1).map((r) => (
              <button
                key={r.unitId}
                type="button"
                aria-pressed={current.unitId === r.unitId}
                onClick={() => setSelected(r.unitId)}
                className={`rounded-lg px-3 py-1 text-xs ${
                  current.unitId === r.unitId ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {r.label}
                {r.highValue ? " ★" : ""}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            This {terms.item.singular.toLowerCase()} is valued unit by unit: {money(itemTotal.valueCents ?? 0)} in total.
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase text-slate-500">Value</dt>
          <dd className="text-lg font-semibold text-slate-100">{current.valueCents == null ? "Not valued" : money(current.valueCents)}</dd>
          {latest && (
            <dd className="text-xs text-slate-400">
              {SOURCE_LABEL[latest.source]} · {formatDay(latest.valuedOn)}
              {latest.source === "ai" && latest.confidence != null ? ` · ${Math.round(latest.confidence * 100)}% confident` : ""}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Book value</dt>
          <dd className="text-slate-200">{current.depreciation ? money(current.depreciation.bookCents) : "Needs a purchase date"}</dd>
          {current.depreciation && (
            <dd className="text-xs text-slate-400">
              Straight line, {current.depreciation.ageYears.toFixed(1)} of {current.lifeYears} years
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">High value</dt>
          <dd>
            <select
              aria-label="High value"
              value={current.highValueMode}
              onChange={(e) => void setMode(e.target.value as HighValueMode)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
            >
              <option value="auto">Automatic (from {money(data.thresholdCents)})</option>
              <option value="yes">Always high value</option>
              <option value="no">Never high value</option>
            </select>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Purchase</dt>
          <dd className="text-slate-200">{purchase || "Not on file"}</dd>
          {profile?.receiptId && (
            <dd>
              <Link to={`/valuation/receipts/${profile.receiptId}`} className="text-xs text-sky-400 hover:underline">
                View receipt
              </Link>
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Warranty</dt>
          <dd>
            <Pill tone={warrantyTone(current.warranty.state)}>{describeWarranty(current.warranty.state, current.warranty.daysLeft)}</Pill>
          </dd>
          {profile?.warrantyEnds && (
            <dd className="text-xs text-slate-400">
              {formatDay(profile.warrantyEnds)}
              {profile.warrantyProvider ? ` · ${profile.warrantyProvider}` : ""}
            </dd>
          )}
          {profile?.warrantyTerms && <dd className="text-xs text-slate-500">{profile.warrantyTerms}</dd>}
        </div>
        <div>
          <dt className="text-xs uppercase text-slate-500">Hour meter</dt>
          <dd className="text-slate-200">{profile?.usageHours != null ? `${profile.usageHours} h` : "Not recorded"}</dd>
          <dd>
            <button type="button" onClick={() => setDialog({ kind: "profile" })} className="text-xs text-sky-400 hover:underline">
              Edit purchase, warranty and meter
            </button>
          </dd>
        </div>
      </dl>

      {latest?.source === "ai" && (
        <div className="rounded-lg bg-slate-800/50 p-3 text-sm">
          <p className="text-slate-300">
            {[latest.details.brand, latest.details.model].filter(Boolean).join(" ") || "Unidentified"}
            {latest.lowCents != null && latest.highCents != null && (
              <span className="text-slate-400"> · estimated {money(latest.lowCents)} to {money(latest.highCents)}</span>
            )}
          </p>
          {typeof latest.details.description === "string" && <p className="text-slate-400">{latest.details.description}</p>}
          {[latest.details.materials, latest.details.condition].some((x) => typeof x === "string" && x) && (
            <p className="text-xs text-slate-500">
              {[latest.details.materials && `Materials: ${latest.details.materials as string}`, latest.details.condition && `Condition: ${latest.details.condition as string}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {latest.basis && <p className="text-xs text-slate-500">{latest.basis}</p>}
          <EstimateNote className="mt-1" />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Service</h3>
          <button type="button" className={BTN} onClick={() => setDialog({ kind: "plan", plan: null })}>
            Add plan
          </button>
        </div>
        {plans.length === 0 ? (
          <p className="text-sm text-slate-500">No scheduled service.</p>
        ) : (
          <ul className="space-y-1.5">
            {plans.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-slate-100">
                    {p.name}{" "}
                    <span className="text-xs text-slate-500">
                      every {[p.intervalDays && `${p.intervalDays} days`, p.intervalHours && `${p.intervalHours} h`].filter(Boolean).join(" or ")}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {describeService(p.status)}
                    {p.lastDoneAt ? ` · last done ${new Date(p.lastDoneAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={serviceTone(p.status.state)}>{SERVICE_LABEL[p.status.state]}</Pill>
                  <button type="button" className={BTN} onClick={() => setDialog({ kind: "log", plan: p })}>
                    Log service
                  </button>
                  <button type="button" className="text-xs text-slate-400 hover:text-slate-100" onClick={() => setDialog({ kind: "plan", plan: p })}>
                    Edit
                  </button>
                  <button type="button" className="text-xs text-slate-500 hover:text-red-400" onClick={() => void deletePlan(p)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.serviceRecords.filter((r) => (r.unitId ?? null) === current.unitId).length > 0 && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-xs text-slate-400">Service log</summary>
            <ul className="mt-1 space-y-1">
              {data.serviceRecords
                .filter((r) => (r.unitId ?? null) === current.unitId)
                .map((r) => (
                  <li key={r.id} className="text-xs text-slate-400">
                    {new Date(r.doneAt).toLocaleDateString()} · {r.planName ?? "Service"}
                    {r.hours != null ? ` · ${r.hours} h` : ""}
                    {r.costCents != null ? ` · ${money(r.costCents)}` : ""}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </div>

      {history.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300">
            Value history ({history.length}) {showHistory ? "▾" : "▸"}
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1.5">
              {history.map((v) => (
                <li key={v.id} className="rounded-lg bg-slate-800/40 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-100">
                      {money(v.valueCents)}
                      {v.previousCents != null && v.previousCents !== v.valueCents && (
                        <span className="ml-2 text-xs text-slate-500">was {money(v.previousCents)}</span>
                      )}
                    </span>
                    <span className="text-xs text-slate-400">
                      {SOURCE_LABEL[v.source]} · {formatDay(v.valuedOn)}
                      {v.createdByName ? ` · ${v.createdByName}` : ""}
                    </span>
                  </div>
                  {v.basis && <p className="text-xs text-slate-500">{v.basis}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(data.receipts.length > 0 || data.declarations.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.receipts.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Receipts</h3>
              <ul className="space-y-1">
                {data.receipts.map((r) => (
                  <li key={r.id}>
                    <Link to={`/valuation/receipts/${r.id}`} className="flex items-center gap-2 text-sm text-sky-400 hover:underline">
                      {r.thumbUrl && <img src={`${r.thumbUrl}?w=96`} alt="" className="h-8 w-8 rounded object-cover" />}
                      {r.vendor ?? "Receipt"} · {formatDay(r.purchaseDate)} {r.totalCents != null ? `· ${money(r.totalCents, r.currency)}` : ""}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.declarations.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Declarations</h3>
              <ul className="space-y-1">
                {data.declarations.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <Link to={`/valuation/declarations/${d.id}`} className="text-sky-400 hover:underline">
                      {d.code}
                    </Link>
                    <span className="text-slate-400">{money(d.declaredCents)}</span>
                    <Pill tone={d.status === "signed" ? "ok" : "muted"}>{d.status === "signed" ? "Signed" : "Draft"}</Pill>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {dialog?.kind === "estimate" && (
        <EstimateDialog
          item={item}
          unit={unit}
          crossCheckAvailable={Boolean(status?.webPrice)}
          onSaved={done}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "value" && (
        <RecordValueDialog itemId={item.id} unitId={current.unitId} currentCents={current.valueCents} onSaved={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "profile" && (
        <ProfileDialog itemId={item.id} unitId={current.unitId} profile={profile} onSaved={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "plan" && (
        <PlanDialog itemId={item.id} unitId={current.unitId} plan={dialog.plan} onSaved={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "log" && <LogServiceDialog plan={dialog.plan} onSaved={done} onClose={() => setDialog(null)} />}
    </section>
  );
}
