import { ApiError, req } from "../../api/client";
import type {
  ActionOutcome,
  ActionRequest,
  FieldInfo,
  ImportPreview,
  LocationResolution,
  PresetInfo,
  ReconcileClass,
  RegisterImport,
  RegisterImportSummary,
  RegisterPreset,
  RegisterRow,
  ResultPage,
  RunComparison,
  RunDetail,
  RunSummary,
} from "./types";

const BASE = "/api/register-reconcile";
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const registerApi = {
  presets: () => req<{ fields: FieldInfo[]; presets: PresetInfo[] }>(`${BASE}/presets`),
  listImports: () => req<RegisterImportSummary[]>(`${BASE}/imports`),
  getImport: (id: string) => req<RegisterImport>(`${BASE}/imports/${id}`),

  /** The file goes up as the request body, whatever its type. */
  upload: async (file: File, opts: { name?: string; preset?: RegisterPreset }): Promise<RegisterImport> => {
    const qs = new URLSearchParams({ filename: file.name });
    if (opts.name) qs.set("name", opts.name);
    if (opts.preset) qs.set("preset", opts.preset);
    const res = await fetch(`${BASE}/imports?${qs}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": file.type && file.type !== "application/json" ? file.type : "application/octet-stream" },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
    return body as RegisterImport;
  },
  updateImport: (id: string, patch: { name?: string; preset?: RegisterPreset; mapping?: Record<string, string | null> }) =>
    req<RegisterImport>(`${BASE}/imports/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteImport: (id: string) => req<void>(`${BASE}/imports/${id}`, { method: "DELETE" }),
  rows: (id: string, opts: { offset?: number; limit?: number; q?: string; issues?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.q) qs.set("q", opts.q);
    if (opts.issues) qs.set("issues", "1");
    return req<{ rows: RegisterRow[]; total: number }>(`${BASE}/imports/${id}/rows?${qs}`);
  },
  locations: (id: string) => req<LocationResolution[]>(`${BASE}/imports/${id}/locations`),
  setLocationMapping: (text: string, locationId: string | null) =>
    req<{ mapping: unknown }>(`${BASE}/location-map`, { method: "PUT", body: JSON.stringify({ text, locationId }) }),

  reconcile: (id: string, scope: { companyId?: string | null; locationId?: string | null }) =>
    req<RunDetail>(`${BASE}/imports/${id}/reconcile`, json(scope)),
  importPreview: (id: string, opts: { companyId?: string | null; defaultLocationId?: string | null }) =>
    req<ImportPreview>(`${BASE}/imports/${id}/import-preview`, json(opts)),
  importCommit: (id: string, opts: { companyId?: string | null; defaultLocationId?: string | null; planHash: string }) =>
    req<{ created: { rowId: string; itemId: string; assetCode: string }[]; skipped: unknown[] }>(
      `${BASE}/imports/${id}/import-commit`,
      json(opts),
    ),

  listRuns: (importId?: string) => req<RunSummary[]>(`${BASE}/runs${importId ? `?importId=${importId}` : ""}`),
  getRun: (id: string) => req<RunDetail>(`${BASE}/runs/${id}`),
  deleteRun: (id: string) => req<void>(`${BASE}/runs/${id}`, { method: "DELETE" }),
  results: (
    id: string,
    opts: { cls?: ReconcileClass; status?: "open" | "resolved" | "ignored" | "all"; q?: string; offset?: number; limit?: number },
  ) => {
    const qs = new URLSearchParams();
    if (opts.cls) qs.set("class", opts.cls);
    if (opts.status) qs.set("status", opts.status);
    if (opts.q) qs.set("q", opts.q);
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.limit) qs.set("limit", String(opts.limit));
    return req<ResultPage>(`${BASE}/runs/${id}/results?${qs}`);
  },
  action: (runId: string, body: ActionRequest) => req<ActionOutcome>(`${BASE}/runs/${runId}/actions`, json(body)),
  compare: (runId: string, otherId: string) => req<RunComparison>(`${BASE}/runs/${runId}/compare/${otherId}`),
  reportXlsxUrl: (runId: string) => `${BASE}/runs/${runId}/report.xlsx`,
  reportPdfUrl: (runId: string) => `${BASE}/runs/${runId}/report.pdf`,
};
