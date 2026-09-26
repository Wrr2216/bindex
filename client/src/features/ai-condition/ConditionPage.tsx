import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { Field, FIELD, Section } from "../../components/ui";
import { useTerms } from "../../config/useConfig";
import type { Location } from "../../types";
import { ZonePicker } from "../tracking-core/ZonePicker";
import { conditionApi } from "./api";
import { ContainerCapture, type CaptureContainer } from "./ContainerCapture";
import type { ConditionReport, Sweep, SweepStage } from "./types";
import { RatingBadge, STAGE_LABEL, errorMessage, reportStage, useConditionAi, useConditionSettings, when } from "./vocab";

const BUTTON = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";

export function SweepProgress({ sweep }: { sweep: Pick<Sweep, "checked" | "expected"> }) {
  const pct = sweep.expected ? Math.min(100, Math.round((sweep.checked / sweep.expected) * 100)) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The condition hub: pack a new container from photos, walk a location
 * recording condition, and the latest reports across everything.
 */
export function ConditionPage() {
  const terms = useTerms();
  const navigate = useNavigate();
  const aiOn = useConditionAi();
  const settings = useConditionSettings();
  const [locations, setLocations] = useState<Location[]>([]);
  const [sweeps, setSweeps] = useState<Sweep[] | null>(null);
  const [reports, setReports] = useState<ConditionReport[] | null>(null);

  const [boxName, setBoxName] = useState("");
  const [boxLocation, setBoxLocation] = useState<string | null>(null);
  const [packing, setPacking] = useState<CaptureContainer | null>(null);
  const [sweepLocation, setSweepLocation] = useState<string | null>(null);
  const [sweepStage, setSweepStage] = useState<SweepStage>("inspection");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    conditionApi.sweeps().then(setSweeps).catch(() => setSweeps([]));
    conditionApi
      .listReports({ limit: 20 })
      .then((r) => setReports(r.reports))
      .catch(() => setReports([]));
  }, []);

  const startPacking = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = boxName.trim() || `Box ${new Date().toLocaleDateString()}`;
      // The container exists first, so its photos have a record to belong to.
      const created = await api.createItem({ name, locationId: boxLocation });
      setPacking({ id: created.id, name: created.name, locationId: created.locationId, locationName: created.locationName ?? null });
      setBoxName("");
    } catch (err) {
      setError(errorMessage(err, "The container could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const startSweep = async () => {
    if (!sweepLocation) return;
    setBusy(true);
    setError(null);
    try {
      const sweep = await conditionApi.startSweep(sweepLocation, sweepStage);
      navigate(`/condition/sweeps/${sweep.id}`);
    } catch (err) {
      setError(errorMessage(err, "The sweep could not be started."));
    } finally {
      setBusy(false);
    }
  };

  const open = (sweeps ?? []).filter((s) => s.status === "open");
  const closed = (sweeps ?? []).filter((s) => s.status === "closed").slice(0, 5);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Condition and containers</h1>
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-200">{error}</p>}

      <Section
        title="Pack a container"
        description={
          aiOn
            ? "Photograph a box, tote or crate and its writing. AI reads the size, room, handling marks and contents; you check them, and the contents are added inside it in one step."
            : "Record a box, tote or crate: its size, room, handling marks and contents, added inside it in one step."
        }
      >
        <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_2fr_auto] sm:items-end">
          <Field label="Name">
            <input
              value={boxName}
              onChange={(e) => setBoxName(e.target.value)}
              placeholder={settings?.sizeClasses[0] ? `e.g. Kitchen ${settings.sizeClasses[0]} 1` : "e.g. Kitchen box 1"}
              maxLength={200}
              className={FIELD}
            />
          </Field>
          <Field label={terms.location.singular}>
            <ZonePicker locations={locations} value={boxLocation} onChange={setBoxLocation} label={terms.location.singular} />
          </Field>
          <button type="button" onClick={() => void startPacking()} disabled={busy} className={BUTTON}>
            Start
          </button>
        </div>
      </Section>

      <Section
        title="Condition sweep"
        description={`Walk a ${terms.location.singular.toLowerCase()}: scan each thing, photograph it, record its condition, next. Progress is kept if you leave and come back.`}
      >
        <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <Field label={terms.location.singular}>
            <ZonePicker
              locations={locations}
              value={sweepLocation}
              onChange={setSweepLocation}
              label={terms.location.singular}
              emptyLabel={`Pick a ${terms.location.singular.toLowerCase()}`}
            />
          </Field>
          <Field label="Stage">
            <select value={sweepStage} onChange={(e) => setSweepStage(e.target.value as SweepStage)} className={FIELD}>
              {(["inspection", "before", "after"] as const).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" onClick={() => void startSweep()} disabled={busy || !sweepLocation} className={BUTTON}>
            Start sweep
          </button>
        </div>
        {open.length > 0 && (
          <ul className="mt-4 space-y-2">
            {open.map((s) => (
              <li key={s.id} className="rounded-lg bg-slate-800/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-slate-200">
                    {s.locationName ?? "A deleted location"} · {STAGE_LABEL[s.stage]} · started {when(s.startedAt)}
                    {s.startedByName ? ` by ${s.startedByName}` : ""}
                  </span>
                  <Link to={`/condition/sweeps/${s.id}`} className="text-sm font-medium text-sky-400 hover:underline">
                    Resume ({s.checked} of {s.expected})
                  </Link>
                </div>
                <div className="mt-2">
                  <SweepProgress sweep={s} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {closed.length > 0 && (
          <details className="mt-3 text-sm text-slate-400">
            <summary className="cursor-pointer">Finished sweeps</summary>
            <ul className="mt-2 space-y-1">
              {closed.map((s) => (
                <li key={s.id}>
                  <Link to={`/condition/sweeps/${s.id}`} className="text-sky-400 hover:underline">
                    {s.locationName ?? "A deleted location"}
                  </Link>{" "}
                  · {STAGE_LABEL[s.stage]} · {s.checked} of {s.expected} checked · {s.closedAt ? when(s.closedAt) : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section title="Recent condition reports">
        {reports === null ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing recorded yet. Record condition from any {terms.item.singular.toLowerCase()}'s page.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <RatingBadge rating={r.rating} />
                <Link to={`/items/${r.itemId}`} className="text-sky-400 hover:underline">
                  {r.itemName}
                </Link>
                {r.unitLabel && <span className="text-xs text-slate-400">{r.unitLabel}</span>}
                <span className="text-slate-400">{reportStage(r)}</span>
                {r.defects.length > 0 && <span className="text-xs text-slate-500">{r.defects.length} defect(s)</span>}
                <span className="ml-auto text-xs text-slate-500">
                  {when(r.createdAt)}
                  {r.createdByName ? ` · ${r.createdByName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {packing && (
        <ContainerCapture
          container={packing}
          onClose={() => navigate(`/items/${packing.id}`)}
          onSaved={() => navigate(`/items/${packing.id}`)}
        />
      )}
    </div>
  );
}
