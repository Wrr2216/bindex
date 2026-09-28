import { req } from "../../api/client";
import type {
  AiAnswer,
  AssessmentDraft,
  CapturePayload,
  Comparison,
  ComparisonDraft,
  ConditionReport,
  ConditionSettings,
  ContainerCapture,
  ContainerDraft,
  HandlingNote,
  ReportPayload,
  Sweep,
  SweepDetail,
  SweepScan,
  SweepStage,
} from "./types";

/** Client calls for condition records and container capture (/api/condition). */

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

export const conditionApi = {
  settings: () => req<ConditionSettings>("/api/condition/settings"),
  saveSettings: (patch: Partial<Omit<ConditionSettings, "vision">>) =>
    req<ConditionSettings>("/api/condition/settings", json("PUT", patch)),

  listReports: (q: { itemId?: string; unitId?: string; sweepId?: string; limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
    return req<{ reports: ConditionReport[]; nextBefore: string | null }>(`/api/condition/reports?${qs}`);
  },
  createReport: (payload: ReportPayload & { itemId: string; sweepId?: string | null }) =>
    req<ConditionReport>("/api/condition/reports", json("POST", payload)),
  updateReport: (id: string, patch: Partial<ReportPayload>) =>
    req<ConditionReport>(`/api/condition/reports/${id}`, json("PATCH", patch)),
  deleteReport: (id: string) => req<void>(`/api/condition/reports/${id}`, { method: "DELETE" }),

  compare: (before: string, after: string) =>
    req<Comparison>(`/api/condition/compare?${new URLSearchParams({ before, after })}`),
  compareWithAi: (before: string, after: string) =>
    req<AiAnswer<ComparisonDraft>>("/api/condition/compare/ai", json("POST", { before, after })),

  /** A draft from photos already attached to the item. Saves nothing. */
  assess: (itemId: string, attachmentIds: string[]) =>
    req<AiAnswer<AssessmentDraft>>("/api/condition/assess", json("POST", { itemId, attachmentIds })),

  captures: (itemId: string) => req<{ captures: ContainerCapture[] }>(`/api/condition/containers/${itemId}`),
  /** A draft from the container's photos. Saves nothing. */
  readContainer: (itemId: string, attachmentIds: string[]) =>
    req<AiAnswer<ContainerDraft>>(`/api/condition/containers/${itemId}/read`, json("POST", { attachmentIds })),
  saveCapture: (itemId: string, payload: CapturePayload) =>
    req<{ capture: ContainerCapture; createdItemIds: string[]; reportIds: string[] }>(
      `/api/condition/containers/${itemId}/capture`,
      json("POST", payload),
    ),

  handling: (itemIds: string[]) =>
    req<{ notes: Record<string, HandlingNote> }>(`/api/condition/handling?${new URLSearchParams({ itemIds: itemIds.join(",") })}`),

  sweeps: (status?: "open" | "closed") =>
    req<{ sweeps: Sweep[] }>(`/api/condition/sweeps${status ? `?status=${status}` : ""}`).then((r) => r.sweeps),
  startSweep: (locationId: string, stage: SweepStage, name?: string) =>
    req<Sweep>("/api/condition/sweeps", json("POST", { locationId, stage, name: name || null })),
  sweep: (id: string) => req<SweepDetail>(`/api/condition/sweeps/${id}`),
  sweepScan: (id: string, code: string) => req<SweepScan>(`/api/condition/sweeps/${id}/scan`, json("POST", { code })),
  closeSweep: (id: string) => req<Sweep>(`/api/condition/sweeps/${id}/close`, { method: "POST" }),
};
