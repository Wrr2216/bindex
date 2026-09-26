import { ApiError, req } from "../../api/client";
import type { ItemDetail } from "../../types";
import type {
  Attachment,
  AttachmentKind,
  DataPlateAccepted,
  DataPlateResult,
  Signature,
  VerifyResult,
} from "./types";

/** Client calls for attachments, signatures and AI capture. */

export type UploadOptions = {
  ownerType: string;
  ownerId: string;
  /** Inferred from the file when omitted. */
  kind?: AttachmentKind;
  stage?: string | null;
  caption?: string | null;
  filename?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /** Called with 0 to 1 as the bytes go up. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

/**
 * Upload one file. Uses XMLHttpRequest rather than fetch because fetch cannot
 * report upload progress, which matters for a video on a phone connection.
 * The body is sent as octet-stream with the real type alongside, so nothing
 * on the way tries to parse it.
 */
export function uploadAttachment(file: Blob, opts: UploadOptions): Promise<Attachment> {
  const qs = new URLSearchParams({ ownerType: opts.ownerType, ownerId: opts.ownerId });
  if (opts.kind) qs.set("kind", opts.kind);
  if (opts.stage) qs.set("stage", opts.stage);
  if (opts.caption) qs.set("caption", opts.caption);
  if (file.type) qs.set("type", file.type);
  const filename = opts.filename ?? (file instanceof File ? file.name : undefined);
  if (filename) qs.set("filename", filename.slice(0, 200));
  for (const key of ["width", "height", "durationMs"] as const) {
    const v = opts[key];
    if (typeof v === "number" && v > 0) qs.set(key, String(Math.round(v)));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/attachments?${qs}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: string; code?: string; details?: unknown } & Partial<Attachment> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A proxy error page, most likely.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Attachment);
      else reject(new ApiError(xhr.status, body.code ?? "error", body.error ?? `Upload failed (${xhr.status}).`, body.details));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "The upload did not get through. Check the connection and try again."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function listAttachments(
  ownerType: string,
  ownerId: string,
  opts: { kind?: AttachmentKind[]; stage?: string | null } = {},
): Promise<Attachment[]> {
  const qs = new URLSearchParams({ ownerType, ownerId });
  if (opts.kind?.length) qs.set("kind", opts.kind.join(","));
  if (opts.stage) qs.set("stage", opts.stage);
  return req<Attachment[]>(`/api/attachments?${qs}`);
}

export const updateAttachment = (
  id: string,
  patch: { caption?: string | null; stage?: string | null; meta?: Record<string, unknown> },
) => req<Attachment>(`/api/attachments/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteAttachment = (id: string) => req<void>(`/api/attachments/${id}`, { method: "DELETE" });

/** Make an item's photo attachment its main photo. */
export const setPrimaryPhoto = (id: string) => req<ItemDetail>(`/api/attachments/${id}/primary`, { method: "POST" });

export const listSignatures = (ownerType: string, ownerId: string) =>
  req<Signature[]>(`/api/signatures?${new URLSearchParams({ ownerType, ownerId })}`);

export type SignPayload = {
  ownerType: string;
  ownerId: string;
  signerName: string;
  signerEmail?: string | null;
  signerRole?: string | null;
  statement: string;
  content: unknown;
  /** PNG data URL from SignaturePad. */
  image?: string | null;
};

export const createSignature = (payload: SignPayload) =>
  req<Signature>("/api/signatures", { method: "POST", body: JSON.stringify(payload) });

export const verifySignature = (id: string, content: unknown) =>
  req<VerifyResult>(`/api/signatures/${id}/verify`, { method: "POST", body: JSON.stringify({ content }) });

/** Read a label photo. Saves nothing. */
export function readDataPlate(photo: Blob, owner?: { ownerType: "item" | "unit"; ownerId: string }) {
  const qs = owner ? `?${new URLSearchParams(owner)}` : "";
  return req<DataPlateResult>(`/api/ai/data-plate${qs}`, {
    method: "POST",
    body: photo,
    headers: { "Content-Type": photo.type || "image/jpeg" },
  });
}

/** Save the fields a person accepted onto an item or a unit. */
export const applyDataPlate = (target: { ownerType: "item" | "unit"; ownerId: string }, fields: DataPlateAccepted) =>
  req<ItemDetail>("/api/ai/data-plate/apply", { method: "POST", body: JSON.stringify({ ...target, ...fields }) });
