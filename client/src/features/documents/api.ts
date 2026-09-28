import { ApiError, req } from "../../api/client";
import type {
  Block,
  CopySource,
  CustomField,
  DocumentDetail,
  DocumentStatus,
  DocumentSummary,
  DocumentsMeta,
  Evaluation,
  FieldDef,
  JobDocuments,
  JobPick,
  Packet,
  PacketConditions,
  PacketOptions,
  PdfCheck,
  RenderModel,
  BodyProblem,
  SyncResult,
  TemplateDetail,
  TemplateSummary,
  TemplateVersion,
  VerifyReport,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The viewer's time zone, so dates print as they read them. */
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type TemplateInput = {
  name: string;
  description?: string | null;
  active?: boolean;
  title?: string;
  body?: Block[];
};

export type PacketInput = {
  name: string;
  description?: string | null;
  templateIds: string[];
  conditions?: PacketConditions;
  autoAttach?: boolean;
  active?: boolean;
};

export type CustomFieldInput = Omit<FieldDef, "libraryId"> & { active?: boolean };

export type PreviewInput = { title?: string; body: Block[]; jobId?: string | null; values?: Record<string, unknown> };

async function postBlob(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.code ?? "error", err.error ?? res.statusText, err.details);
  }
  return res.blob();
}

export const documentsApi = {
  meta: () => req<DocumentsMeta>("/api/documents/meta"),
  jobs: (q?: string) => req<JobPick[]>(`/api/documents/jobs${query({ q })}`),

  // Documents
  list: (filters: { jobId?: string; templateId?: string; status?: DocumentStatus; q?: string } = {}) =>
    req<DocumentSummary[]>(`/api/documents${query(filters)}`),
  get: (id: string) => req<DocumentDetail>(`/api/documents/${id}${query({ tz: tz() })}`),
  create: (input: { templateId: string; jobId?: string | null; copyFromId?: string }) =>
    req<DocumentDetail>(`/api/documents${query({ tz: tz() })}`, json("POST", input)),
  save: (id: string, patch: { values?: Record<string, unknown>; title?: string }) =>
    req<{ id: string; values: Record<string, unknown>; title: string; status: DocumentStatus; updatedAt: string }>(
      `/api/documents/${id}`,
      json("PATCH", patch),
    ),
  remove: (id: string) => req<void>(`/api/documents/${id}`, { method: "DELETE" }),
  copySources: (id: string) => req<CopySource[]>(`/api/documents/${id}/copy-sources`),
  copyFrom: (id: string, sourceId: string, overwrite = false) =>
    req<{ copied: string[]; skipped: { key: string; reason: string }[]; values: Record<string, unknown> }>(
      `/api/documents/${id}/copy-from`,
      json("POST", { sourceId, overwrite }),
    ),
  duplicate: (id: string, jobId?: string | null) =>
    req<DocumentDetail>(`/api/documents/${id}/duplicate${query({ tz: tz() })}`, json("POST", jobId === undefined ? {} : { jobId })),
  complete: (id: string) => req<DocumentDetail>(`/api/documents/${id}/complete`, json("POST", { tz: tz() })),
  reopen: (id: string) => req<DocumentDetail>(`/api/documents/${id}/reopen${query({ tz: tz() })}`, { method: "POST" }),
  attachSignature: (id: string, fieldKey: string, signatureId: string) =>
    req<DocumentDetail>(`/api/documents/${id}/signatures${query({ tz: tz() })}`, json("POST", { fieldKey, signatureId })),
  verify: (id: string) => req<VerifyReport>(`/api/documents/${id}/verify`),
  pdfUrl: (id: string, download = false) => `/api/documents/${id}/pdf${query({ tz: tz(), download: download ? 1 : undefined })}`,
  share: (id: string, input: { email?: string | null; expiresInDays?: number; allowSigning?: boolean }) =>
    req<{ url: string; expiresAt: string | null; message?: string }>(`/api/documents/${id}/share`, json("POST", input)),
  verifyPdf: async (file: Blob): Promise<PdfCheck> => {
    const res = await fetch("/api/documents/verify-pdf", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
    return body as PdfCheck;
  },

  // A job's documents
  forJob: (jobId: string) => req<JobDocuments>(`/api/documents/job/${jobId}`),
  syncJob: (jobId: string) => req<SyncResult>(`/api/documents/job/${jobId}/sync`, { method: "POST" }),
  attachPacket: (jobId: string, packetId: string) =>
    req<{ packetId: string; name: string; documents: number; unpublished: string[] }>(
      `/api/documents/job/${jobId}/packets`,
      json("POST", { packetId }),
    ),
  detachPacket: (jobId: string, packetId: string) =>
    req<{ removed: number; kept: number }>(`/api/documents/job/${jobId}/packets/${packetId}`, { method: "DELETE" }),

  // Templates
  templates: (all = false) => req<TemplateSummary[]>(`/api/document-templates${all ? "?all=true" : ""}`),
  template: (id: string) => req<TemplateDetail>(`/api/document-templates/${id}`),
  templateVersion: (id: string, version: number) => req<TemplateVersion>(`/api/document-templates/${id}/versions/${version}`),
  createTemplate: (input: TemplateInput) => req<TemplateDetail>("/api/document-templates", json("POST", input)),
  updateTemplate: (id: string, patch: Partial<TemplateInput>) =>
    req<TemplateDetail>(`/api/document-templates/${id}`, json("PATCH", patch)),
  publishTemplate: (id: string) => req<TemplateDetail>(`/api/document-templates/${id}/publish`, { method: "POST" }),
  discardDraft: (id: string) => req<TemplateDetail>(`/api/document-templates/${id}/draft`, { method: "DELETE" }),
  deleteTemplate: (id: string) => req<void>(`/api/document-templates/${id}`, { method: "DELETE" }),
  preview: (input: PreviewInput) =>
    req<RenderModel & { problems: BodyProblem[] }>("/api/document-templates/preview", json("POST", { ...input, tz: tz() })),
  previewPdf: (input: PreviewInput) => postBlob("/api/document-templates/preview.pdf", { ...input, tz: tz() }),

  // Packets
  packets: () => req<Packet[]>("/api/document-packets"),
  packetOptions: () => req<PacketOptions>("/api/document-packets/options"),
  createPacket: (input: PacketInput) => req<Packet>("/api/document-packets", json("POST", input)),
  updatePacket: (id: string, patch: Partial<PacketInput>) => req<Packet>(`/api/document-packets/${id}`, json("PATCH", patch)),
  deletePacket: (id: string) => req<void>(`/api/document-packets/${id}`, { method: "DELETE" }),
  applyPacket: (id: string) =>
    req<{ checked: number; attached: number; jobIds: string[] }>(`/api/document-packets/${id}/apply`, { method: "POST" }),
  testConditions: (conditions: PacketConditions, jobId: string) =>
    req<Evaluation>("/api/document-packets/test", json("POST", { conditions, jobId })),

  // Custom field library
  fields: (all = false) => req<CustomField[]>(`/api/document-fields${all ? "?all=true" : ""}`),
  createField: (input: CustomFieldInput) => req<CustomField>("/api/document-fields", json("POST", input)),
  updateField: (id: string, patch: Partial<CustomFieldInput>) => req<CustomField>(`/api/document-fields/${id}`, json("PATCH", patch)),
  deleteField: (id: string) => req<void>(`/api/document-fields/${id}`, { method: "DELETE" }),
};
