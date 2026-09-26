import { useEffect, useState } from "react";
import { useFeatures } from "../../config/useConfig";
import { useAiAvailability } from "../media-ai-core";
import { conditionApi } from "./api";
import type {
  ConditionRating,
  ConditionReport,
  ConditionSettings,
  ConditionStage,
  ContainerFlag,
  DefectSeverity,
  DefectType,
} from "./types";

/** Labels, colours and small hooks shared by the condition screens. */

export const RATINGS: ConditionRating[] = ["excellent", "good", "fair", "poor", "damaged"];
export const STAGES: ConditionStage[] = ["before", "after", "inspection", "custom"];
export const DEFECT_TYPES: DefectType[] = ["scratch", "dent", "gouge", "stain", "crack", "loose", "missing_part", "other"];
export const SEVERITIES: DefectSeverity[] = ["minor", "moderate", "major"];
export const FLAGS: ContainerFlag[] = ["fragile", "this_side_up", "high_value", "heavy", "keep_dry"];

export const RATING_LABEL: Record<ConditionRating, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  damaged: "Damaged",
};

export const RATING_TONE: Record<ConditionRating, string> = {
  excellent: "bg-emerald-900/70 text-emerald-200 border-emerald-700",
  good: "bg-sky-900/70 text-sky-200 border-sky-700",
  fair: "bg-amber-900/60 text-amber-200 border-amber-700",
  poor: "bg-orange-900/70 text-orange-200 border-orange-700",
  damaged: "bg-red-900/70 text-red-200 border-red-700",
};

export const STAGE_LABEL: Record<ConditionStage, string> = {
  before: "Before",
  after: "After",
  inspection: "Inspection",
  custom: "Other",
};

export const DEFECT_LABEL: Record<DefectType, string> = {
  scratch: "Scratch",
  dent: "Dent",
  gouge: "Gouge or chip",
  stain: "Stain",
  crack: "Crack",
  loose: "Loose",
  missing_part: "Missing part",
  other: "Other",
};

export const SEVERITY_LABEL: Record<DefectSeverity, string> = { minor: "Minor", moderate: "Moderate", major: "Major" };

export const FLAG_LABEL: Record<ContainerFlag, string> = {
  fragile: "Fragile",
  this_side_up: "This side up",
  high_value: "High value",
  heavy: "Heavy",
  keep_dry: "Keep dry",
};

export const reportStage = (r: Pick<ConditionReport, "stage" | "stageLabel">) =>
  r.stage === "custom" && r.stageLabel ? r.stageLabel : STAGE_LABEL[r.stage];

/** The stage an attachment gets when taken for a report at this stage. */
export const photoStage = (stage: ConditionStage, label: string | null | undefined) =>
  stage === "custom" ? (label?.trim().toLowerCase() || "condition") : stage;

export function RatingBadge({ rating, className = "" }: { rating: ConditionRating | null; className?: string }) {
  if (!rating) return <span className={`rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400 ${className}`}>Not rated</span>;
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${RATING_TONE[rating]} ${className}`}>{RATING_LABEL[rating]}</span>;
}

export const errorMessage = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Condition records are on for this instance. */
export function useConditionEnabled(): boolean {
  return useFeatures().aiCondition;
}

/** The AI buttons: the feature is on and a vision model is configured. */
export function useConditionAi(): boolean {
  const on = useConditionEnabled();
  return on && useAiAvailability().vision;
}

let cached: Promise<ConditionSettings> | null = null;

/** The configured size classes and categories, loaded once per page load. */
export function useConditionSettings(): ConditionSettings | null {
  const [settings, setSettings] = useState<ConditionSettings | null>(null);
  useEffect(() => {
    let live = true;
    cached ??= conditionApi.settings().catch((err) => {
      cached = null;
      throw err;
    });
    cached.then((s) => live && setSettings(s)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return settings;
}

/** After an administrator changes the lists. */
export function forgetConditionSettings(): void {
  cached = null;
}
