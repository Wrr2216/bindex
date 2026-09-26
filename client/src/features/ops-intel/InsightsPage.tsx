import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";
import { opsApi } from "./api";
import { LoadPlanPanel } from "./LoadPlanPanel";
import { Overview } from "./Overview";
import { SetupPanel } from "./SetupPanel";
import { SlottingPanel } from "./SlottingPanel";
import { StoragePanel } from "./StoragePanel";
import type { OpsMeta } from "./types";
import { Notice, Tabs, errorText } from "./ui";

type Tab = "anomalies" | "storage" | "slotting" | "load" | "setup";

/**
 * Operations insights: anomalies found by rules, storage analytics,
 * slotting suggestions and load planning, on one page with a tab each.
 */
export function InsightsPage() {
  const features = useFeatures();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState<OpsMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMeta = useCallback(
    () =>
      opsApi
        .meta()
        .then((m) => {
          setMeta(m);
          setError(null);
        })
        .catch((err) => setError(errorText(err, "Insights could not be loaded."))),
    [],
  );
  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "anomalies", label: "Anomalies" },
    { id: "storage", label: "Storage" },
    { id: "slotting", label: "Slotting" },
    ...(features.jobs ? [{ id: "load" as const, label: "Load planning" }] : []),
    { id: "setup", label: "Setup" },
  ];
  const wanted = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some((t) => t.id === wanted) ? wanted! : "anomalies";
  const go = (t: Tab) => setParams(t === "anomalies" ? {} : { tab: t }, { replace: true });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Insights</h1>
        <p className="mt-1 text-sm text-slate-400">
          Problems caught by rules, how storage is used, and how loads fit the vehicles.
        </p>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={go} />
      {error && <Notice tone="error">{error}</Notice>}
      {tab === "anomalies" && <Overview meta={meta} />}
      {tab === "storage" && <StoragePanel />}
      {tab === "slotting" && <SlottingPanel onSetup={() => go("setup")} />}
      {tab === "load" && <LoadPlanPanel onSetup={() => go("setup")} />}
      {tab === "setup" && (meta ? <SetupPanel meta={meta} onSaved={() => void loadMeta()} /> : <p className="text-sm text-slate-500">Loading…</p>)}
    </div>
  );
}
