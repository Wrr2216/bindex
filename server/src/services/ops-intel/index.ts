/**
 * Operations insights: anomaly rules, storage analytics, slotting and load
 * planning. The public surface; docs/ops-intel.md describes every rule and
 * threshold.
 */
export * from "./model";
export { runRule, RULE_FACTS, type Finding, type Facts } from "./rules";
export { reconcile, type ExistingAnomaly, type ReconcileOps } from "./reconcile";
export { runAnomalyRules, startOpsIntel, type RunResult, type RuleRunStat } from "./engine";
export {
  listAnomalies,
  getAnomaly,
  resolveAnomaly,
  summary,
  explainAnomaly,
  explanationsAvailable,
  type AnomalyView,
  type AnomalyFilters,
  type OpsSummary,
} from "./anomalies";
export { getSettings, updateSettings } from "./settings";
export { storageAnalysis, listStorageItems, invalidateStorage, type StorageItemFilters } from "./storageData";
export type { StorageItem, StorageReport, ZoneStat } from "./storage";
export type { SlottingResult, SlottingSuggestion } from "./slotting";
export { registerOpsEventTypes } from "./events";
