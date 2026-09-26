/** Client-side shapes for AI bulk capture. Mirrors server/src/services/bulk-capture. */

export type CaptureMode = "walkthrough" | "desk" | "manifest";
export type CountRule = "max" | "sum";
export type SourceKind = "photo" | "video_frame" | "pdf_page";
export type SourceStatus = "pending" | "analysing" | "analysed" | "failed";
export type DraftStatus = "pending" | "discarded" | "created";

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeskTemplateItem {
  key: string;
  label: string;
  qty: number;
  match: string[];
}

export interface DeskTemplate {
  id: string;
  name: string;
  items: DeskTemplateItem[];
}

export interface BulkCaptureStatus {
  available: boolean;
  vision: boolean;
  video: boolean;
  pdf: boolean;
  maxImagesPerSession: number;
  deskTemplates: DeskTemplate[];
}

export interface BulkCaptureSettings {
  maxImagesPerSession: number;
  deskTemplates: DeskTemplate[];
}

export interface CaptureSource {
  id: string;
  attachmentId: string;
  originAttachmentId: string | null;
  kind: SourceKind;
  position: number;
  label: string;
  frameMs: number | null;
  pageNo: number | null;
  area: string | null;
  status: SourceStatus;
  error: string | null;
  found: number | null;
  room: string | null;
  url: string;
  thumbUrl: string;
}

export interface DraftSource {
  sourceId: string;
  attachmentId: string;
  name: string;
  qty: number;
  bbox: Bbox | null;
  confidence: number | null;
  label: string;
  missing: boolean;
}

export interface CaptureDraft {
  id: string;
  position: number;
  status: DraftStatus;
  name: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  qty: number;
  qtyLocked: boolean;
  edited: boolean;
  manual: boolean;
  area: string | null;
  locationId: string | null;
  lineNo: number | null;
  condition: string | null;
  conditionCodes: string[];
  stickerColor: string | null;
  stickerLot: string | null;
  stickerNumber: string | null;
  confidence: number | null;
  sources: DraftSource[];
  note: string | null;
  createdItemIds: string[];
  explanation: string | null;
  updatedAt: string;
}

export interface DeskLine {
  key: string;
  label: string;
  expected: number;
  found: number;
  missing: number;
  extra: number;
}

export interface DeskCheck {
  desk: string;
  lines: DeskLine[];
  others: { name: string; qty: number }[];
  complete: boolean;
}

export interface CaptureSession {
  id: string;
  mode: CaptureMode;
  modeLabel: string;
  title: string;
  locationId: string | null;
  locationName: string | null;
  status: "open" | "committed";
  countRule: CountRule;
  deskTemplate: DeskTemplate | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  committedBy: string | null;
  cap: { imageCap: number; used: number; remaining: number; instanceMax: number };
  toAnalyse: number;
  sources: CaptureSource[];
  drafts: CaptureDraft[];
  deskCheck: DeskCheck[] | null;
  counts: { pending: number; discarded: number; created: number };
  tools: { vision: boolean; video: boolean; pdf: boolean };
}

export interface CaptureSessionSummary {
  id: string;
  mode: CaptureMode;
  modeLabel: string;
  title: string;
  status: "open" | "committed";
  locationId: string | null;
  locationName: string | null;
  sources: number;
  toAnalyse: number;
  draftsPending: number;
  draftsCreated: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftPatch {
  name?: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  qty?: number;
  area?: string | null;
  locationId?: string | null;
  lineNo?: number | null;
  condition?: string | null;
  stickerColor?: string | null;
  stickerLot?: string | null;
  stickerNumber?: string | null;
  status?: "pending" | "discarded";
}

export interface AnalyseResult {
  available: boolean;
  analysed: number;
  failed: number;
  session: CaptureSession;
}

export interface CommitResult {
  created: { draftId: string; name: string; itemIds: string[] }[];
  itemCount: number;
  photos: { saved: number; failed: number };
  session: CaptureSession;
}
