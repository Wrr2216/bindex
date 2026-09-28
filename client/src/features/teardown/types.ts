/**
 * Types for teardown guides. Mirrors server/src/services/teardown; see
 * docs/teardown.md.
 */
import type { Attachment } from "../media-ai-core";

export type PartKind = "hardware" | "component" | "cable" | "other";
export type JobStatus = "idle" | "queued" | "running" | "done" | "failed";
export type ProcessMode = "continue" | "steps" | "all";

export interface JobNote {
  code: string;
  message: string;
}

export interface GuideJob {
  status: JobStatus;
  /** audio, transcribe, steps, keyframes or refine while running. */
  stage: string | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  notes: JobNote[];
  attempts: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Step {
  id: string;
  n: number;
  title: string;
  instruction: string;
  /** Seconds into the video. */
  start: number | null;
  end: number | null;
  callout: string | null;
  source: "narration" | "manual";
  keyframe: { id: string; url: string; thumbUrl: string | null } | null;
  updatedAt: string;
}

export interface Part {
  id: string;
  stepId: string | null;
  stepN: number | null;
  name: string;
  kind: PartKind;
  qty: number;
  note: string | null;
  source: "narration" | "manual";
  /** The name as heard in the narration, when a picture let it be named better. */
  heardAs: string | null;
  edited: boolean;
  reassembledAt: string | null;
  reassembledBy: string | null;
}

export interface DraftStep {
  title: string;
  instruction: string;
  start: number | null;
  end: number | null;
  callout: string | null;
}

export interface DraftPart {
  name: string;
  kind: PartKind;
  qty: number;
  step: number | null;
}

export type Draft =
  | { complete: true; steps: DraftStep[]; parts: DraftPart[] }
  | { complete: false; windowsDone: number; windowsTotal: number };

export interface Guide {
  id: string;
  title: string;
  notes: string | null;
  itemId: string;
  unitId: string | null;
  item: { id: string; name: string; assetCode: string; brand: string | null; model: string | null; category: string | null } | null;
  unit: { id: string; assetCode: string; label: string | null; serial: string | null } | null;
  video: Attachment | null;
  durationSec: number | null;
  transcript: {
    text: string;
    segments: { start: number; end: number; text: string }[];
    language: string | null;
    complete: boolean;
  } | null;
  draft: Draft | null;
  job: GuideJob;
  steps: Step[];
  parts: Part[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuideSummary {
  id: string;
  title: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  itemAssetCode: string;
  unitName: string | null;
  videoAttachmentId: string | null;
  stepCount: number;
  partCount: number;
  partsReassembled: number;
  draftPending: boolean;
  job: { status: JobStatus; stage: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface TeardownStatus {
  ffmpeg: boolean;
  transcription: boolean;
  languageModel: boolean;
  vision: boolean;
  printing: boolean;
}

export interface StepPayload {
  title?: string;
  instruction?: string | null;
  start?: number | null;
  end?: number | null;
  callout?: string | null;
  keyframeAttachmentId?: string | null;
  /** Move to this position (1-based). */
  n?: number;
}

export interface PartPayload {
  name?: string;
  kind?: PartKind;
  qty?: number;
  stepId?: string | null;
  note?: string | null;
  reassembled?: boolean;
}
