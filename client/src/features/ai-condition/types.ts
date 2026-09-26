/**
 * Types for condition records and container capture. Mirrors the server's
 * services/ai-condition; see docs/ai-condition.md.
 */

export type ConditionStage = "before" | "after" | "inspection" | "custom";
export type ConditionRating = "excellent" | "good" | "fair" | "poor" | "damaged";
export type DefectType = "scratch" | "dent" | "gouge" | "stain" | "crack" | "loose" | "missing_part" | "other";
export type DefectSeverity = "minor" | "moderate" | "major";
export type ContainerFlag = "fragile" | "this_side_up" | "high_value" | "heavy" | "keep_dry";
export type SweepStage = "before" | "after" | "inspection";

export interface Defect {
  area: string;
  type: DefectType;
  severity: DefectSeverity;
  description: string | null;
}

export interface PhotoRef {
  id: string;
  url: string;
  thumbUrl: string | null;
  stage: string | null;
  ownerType: string;
  ownerId: string;
  createdAt: string;
}

export interface ConditionReport {
  id: string;
  itemId: string;
  itemName: string;
  itemAssetCode: string;
  unitId: string | null;
  unitLabel: string | null;
  stage: ConditionStage;
  stageLabel: string | null;
  rating: ConditionRating | null;
  notes: string | null;
  aiNotes: string | null;
  defects: Defect[];
  handlingNote: string | null;
  attachmentIds: string[];
  photos: PhotoRef[];
  aiAssisted: boolean;
  sweepId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportPayload {
  unitId?: string | null;
  stage: ConditionStage;
  stageLabel?: string | null;
  rating?: ConditionRating | null;
  notes?: string | null;
  aiNotes?: string | null;
  defects?: Defect[];
  handlingNote?: string | null;
  attachmentIds?: string[];
  aiAssisted?: boolean;
}

export interface ContentLine {
  name: string;
  category: string | null;
  qty: number;
  condition: ConditionRating | null;
  fragile: boolean;
  description: string | null;
  itemId?: string | null;
}

export interface ContainerCapture {
  id: string;
  itemId: string;
  sizeClass: string | null;
  handwrittenText: string | null;
  room: string | null;
  contentsSummary: string | null;
  contents: ContentLine[];
  flags: ContainerFlag[];
  confidence: Record<string, number> | null;
  aiAssisted: boolean;
  attachmentIds: string[];
  photos: PhotoRef[];
  createdItemIds: string[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ContainerDraft {
  sizeClass: string | null;
  sizeClassRaw: string | null;
  handwrittenText: string | null;
  room: string | null;
  contentsSummary: string | null;
  contents: ContentLine[];
  flags: ContainerFlag[];
  confidence: { sizeClass: number; handwrittenText: number; room: number; contents: number };
}

export interface AssessmentDraft {
  rating: ConditionRating | null;
  summary: string | null;
  defects: Defect[];
  handlingNote: string | null;
  confidence: number | null;
}

export interface ComparisonDraft {
  summary: string | null;
  newDefects: Defect[];
  resolvedDefects: Defect[];
  ratingAfter: ConditionRating | null;
  changed: boolean;
}

/** Every AI endpoint answers in this shape. Nothing is saved by it. */
export interface AiAnswer<T> {
  /** False when no vision model is configured. */
  available: boolean;
  found: boolean;
  draft: T | null;
  lowConfidence: number;
  message?: string;
}

export interface DefectPair {
  before: Defect;
  after: Defect;
}

export interface Comparison {
  before: ConditionReport;
  after: ConditionReport;
  diff: {
    added: Defect[];
    resolved: Defect[];
    worsened: DefectPair[];
    improved: DefectPair[];
    unchanged: DefectPair[];
    /** Per defect of the after report, in order. */
    afterStatus: ("new" | "worse" | "better" | "same")[];
    /** Per defect of the before report, in order. */
    beforeStatus: ("gone" | "matched")[];
  };
  rating: "worse" | "better" | "same" | null;
}

export interface CaptureLinePayload {
  name: string;
  category?: string | null;
  qty?: number;
  condition?: ConditionRating | null;
  fragile?: boolean;
  description?: string | null;
  /** False records the line without adding an item for it. */
  create?: boolean;
}

export interface CapturePayload {
  sizeClass?: string | null;
  handwrittenText?: string | null;
  room?: string | null;
  contentsSummary?: string | null;
  flags?: ContainerFlag[];
  contents?: CaptureLinePayload[];
  attachmentIds?: string[];
  aiAssisted?: boolean;
  confidence?: Record<string, number> | null;
  containerName?: string | null;
  inheritLocation?: boolean;
}

export interface HandlingNote {
  itemId: string;
  unitId: string | null;
  note: string | null;
  rating: ConditionRating | null;
  reportId: string | null;
  reportedAt: string | null;
  flags: ContainerFlag[];
  text: string;
}

export interface ConditionSettings {
  sizeClasses: string[];
  categories: string[];
  promptHint: string;
  vision: boolean;
}

export interface Sweep {
  id: string;
  locationId: string | null;
  locationName: string | null;
  name: string | null;
  stage: SweepStage;
  status: "open" | "closed";
  startedBy: string | null;
  startedByName: string | null;
  startedAt: string;
  closedAt: string | null;
  expected: number;
  checked: number;
}

export interface SweepItem {
  itemId: string;
  name: string;
  assetCode: string;
  locationId: string | null;
  locationName: string | null;
  primaryImageUrl: string | null;
  report: { id: string; rating: ConditionRating | null; createdAt: string } | null;
}

export interface SweepDetail extends Sweep {
  items: SweepItem[];
  extra: SweepItem[];
}

export interface SweepScan {
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  primaryImageUrl: string | null;
  locationName: string | null;
  expected: boolean;
  report: { id: string; rating: ConditionRating | null; createdAt: string } | null;
}
