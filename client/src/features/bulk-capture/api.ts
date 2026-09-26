import { req } from "../../api/client";
import type {
  AnalyseResult,
  BulkCaptureSettings,
  BulkCaptureStatus,
  CaptureMode,
  CaptureSession,
  CaptureSessionSummary,
  CommitResult,
  CountRule,
  DraftPatch,
} from "./types";

/** Client calls for AI bulk capture. Files go up through the attachments API first. */

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const base = "/api/bulk-capture";
const session = (id: string) => `${base}/sessions/${id}`;

export const captureApi = {
  status: () => req<BulkCaptureStatus>(`${base}/status`),
  settings: () => req<BulkCaptureSettings>(`${base}/settings`),
  saveSettings: (patch: Partial<BulkCaptureSettings>) =>
    req<BulkCaptureSettings>(`${base}/settings`, { method: "PUT", ...json(patch) }),

  list: () => req<CaptureSessionSummary[]>(`${base}/sessions`),
  create: (payload: {
    mode: CaptureMode;
    title?: string | null;
    locationId?: string | null;
    imageCap?: number | null;
    countRule?: CountRule;
    deskTemplateId?: string | null;
  }) => req<CaptureSession>(`${base}/sessions`, { method: "POST", ...json(payload) }),
  get: (id: string) => req<CaptureSession>(session(id)),
  update: (
    id: string,
    patch: { title?: string; locationId?: string | null; imageCap?: number; countRule?: CountRule; deskTemplateId?: string },
  ) => req<CaptureSession>(session(id), { method: "PATCH", ...json(patch) }),
  remove: (id: string) => req<void>(session(id), { method: "DELETE" }),

  addSource: (id: string, attachmentId: string, area: string | null) =>
    req<{ added: CaptureSession["sources"]; message: string | null }>(`${session(id)}/sources`, {
      method: "POST",
      ...json({ attachmentId, area }),
    }),
  updateSource: (id: string, sourceId: string, area: string | null) =>
    req<CaptureSession>(`${session(id)}/sources/${sourceId}`, { method: "PATCH", ...json({ area }) }),
  removeSource: (id: string, sourceId: string) =>
    req<CaptureSession>(`${session(id)}/sources/${sourceId}`, { method: "DELETE" }),
  retrySource: (id: string, sourceId: string) =>
    req<CaptureSession>(`${session(id)}/sources/${sourceId}/retry`, { method: "POST" }),
  analyse: (id: string, limit = 2) =>
    req<AnalyseResult>(`${session(id)}/analyse`, { method: "POST", ...json({ limit }) }),

  addDraft: (id: string, draft: DraftPatch & { name: string }) =>
    req<CaptureSession>(`${session(id)}/drafts`, { method: "POST", ...json(draft) }),
  updateDraft: (id: string, draftId: string, patch: DraftPatch) =>
    req<CaptureSession>(`${session(id)}/drafts/${draftId}`, { method: "PATCH", ...json(patch) }),
  discardDraft: (id: string, draftId: string) =>
    req<CaptureSession>(`${session(id)}/drafts/${draftId}`, { method: "DELETE" }),
  mergeDrafts: (id: string, ids: string[]) =>
    req<CaptureSession>(`${session(id)}/drafts/merge`, { method: "POST", ...json({ ids }) }),
  splitDraft: (id: string, draftId: string, how: { by: "source" } | { qty: number }) =>
    req<CaptureSession>(`${session(id)}/drafts/${draftId}/split`, { method: "POST", ...json(how) }),

  commit: (id: string, opts: { draftIds?: string[]; individual?: boolean; areaLocations?: boolean }) =>
    req<CommitResult>(`${session(id)}/commit`, { method: "POST", ...json(opts) }),
};
