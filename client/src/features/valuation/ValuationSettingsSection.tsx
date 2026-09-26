import { useEffect, useState } from "react";
import { BUTTON, Field, FIELD, Section, Toggle } from "../../components/ui";
import { useFeatures } from "../../config/useConfig";
import { valuationApi } from "./api";
import { centsToInput, errorText, parseMoneyInput } from "./format";
import type { ValuationSettings } from "./types";

/**
 * Administrator settings for valuation: the high-value threshold, how far
 * ahead reminders look, and depreciation lives per category. Shown on the
 * Settings screen while the feature is on.
 */
export function ValuationSettingsSection() {
  const features = useFeatures();
  const [s, setS] = useState<ValuationSettings | null>(null);
  const [threshold, setThreshold] = useState("");
  const [lives, setLives] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!features.valuation) return;
    valuationApi
      .settings()
      .then((v) => {
        setS(v);
        setThreshold(centsToInput(v.highValueThresholdCents));
        setLives(Object.entries(v.depreciation.lifeYearsByCategory).map(([k, y]) => `${k}: ${y}`).join("\n"));
      })
      .catch(() => setS(null));
  }, [features.valuation]);

  if (!features.valuation || !s) return null;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const cents = parseMoneyInput(threshold);
      if (cents === null || cents < 0) throw new Error("Enter the high-value threshold as an amount, or 0 to turn automatic marking off.");
      const byCategory: Record<string, number> = {};
      for (const line of lives.split("\n")) {
        if (!line.trim()) continue;
        const m = /^(.+?)\s*[:=]\s*([\d.]+)\s*$/.exec(line.trim());
        if (!m || !(Number(m[2]) > 0)) throw new Error(`"${line.trim()}" should read like "Laptop: 3".`);
        byCategory[m[1]!.trim()] = Number(m[2]);
      }
      const saved = await valuationApi.saveSettings({
        ...s,
        highValueThresholdCents: cents,
        depreciation: { ...s.depreciation, lifeYearsByCategory: byCategory },
      });
      setS(saved);
      setMessage("Saved.");
    } catch (err) {
      setMessage(errorText(err, "Not saved."));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

  return (
    <Section
      title="Valuation and warranty"
      description="Where high value starts, when warranty and service reminders go out, and how the valuation report depreciates. AI values are estimates, and are labelled as such everywhere they appear."
    >
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="High value from" hint="Records worth at least this are marked high value. 0 turns automatic marking off.">
          <input className={FIELD} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        <Field label="Warranty reminder (days ahead)">
          <input className={FIELD} inputMode="numeric" value={s.warrantyAlertDays} onChange={(e) => setS({ ...s, warrantyAlertDays: num(e.target.value) })} />
        </Field>
        <Field label="Service due soon (days ahead)">
          <input className={FIELD} inputMode="numeric" value={s.serviceSoonDays} onChange={(e) => setS({ ...s, serviceSoonDays: num(e.target.value) })} />
        </Field>
        <Field label="Service due soon (% of an hour interval)">
          <input className={FIELD} inputMode="numeric" value={s.serviceSoonPercent} onChange={(e) => setS({ ...s, serviceSoonPercent: num(e.target.value) })} />
        </Field>
        <Field label="Default useful life (years)">
          <input
            className={FIELD}
            inputMode="decimal"
            value={s.depreciation.defaultLifeYears}
            onChange={(e) => setS({ ...s, depreciation: { ...s.depreciation, defaultLifeYears: num(e.target.value) } })}
          />
        </Field>
        <Field label="Salvage value (% of cost)">
          <input
            className={FIELD}
            inputMode="decimal"
            value={s.depreciation.salvagePercent}
            onChange={(e) => setS({ ...s, depreciation: { ...s.depreciation, salvagePercent: num(e.target.value) } })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Useful life by category" hint='One per line, such as "Laptop: 3" or "Furniture: 10". Matched to the category without regard to case.'>
            <textarea className={FIELD} rows={4} value={lives} onChange={(e) => setLives(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4 sm:col-span-2">
          <div>
            <p className="text-sm font-medium text-slate-200">Send reminders as notifications</p>
            <p className="text-sm text-slate-500">Through Pushover and Wazuh when configured. Events for webhooks are sent either way.</p>
          </div>
          <Toggle label="Send reminders as notifications" checked={s.notify} onChange={(notify) => setS({ ...s, notify })} />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className={BUTTON}>
          {busy ? "Saving…" : "Save valuation settings"}
        </button>
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
    </Section>
  );
}
