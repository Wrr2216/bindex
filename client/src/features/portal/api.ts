import { ApiError, req } from "../../api/client";
import type {
  FlaggedPage,
  Grant,
  GrantActivity,
  GrantInput,
  GrantNote,
  GrantTarget,
  HandoffReceipt,
  IssuedLink,
  LineDetail,
  LineFilter,
  LinePage,
  NoteCondition,
  PortalDocuments,
  PortalNote,
  PortalOverview,
  PortalPhoto,
  PortalSession,
  PortalStatus,
  ScanResult,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// ---- Administrators (session) -----------------------------------------------------

export const portalAdminApi = {
  status: () => req<PortalStatus>("/api/portal-grants/status"),
  list: (params: { state?: "active" | "inactive"; q?: string } = {}) =>
    req<Grant[]>(`/api/portal-grants${query(params)}`),
  targets: (q: string) => req<GrantTarget[]>(`/api/portal-grants/targets${query({ q })}`),
  create: (input: GrantInput & { sendEmail?: boolean }) =>
    req<IssuedLink>("/api/portal-grants", json("POST", { ...input, baseUrl: window.location.origin })),
  get: (id: string) => req<Grant>(`/api/portal-grants/${id}`),
  update: (id: string, patch: Partial<Omit<GrantInput, "scope" | "targetId">>) =>
    req<Grant>(`/api/portal-grants/${id}`, json("PATCH", patch)),
  revoke: (id: string) => req<Grant>(`/api/portal-grants/${id}/revoke`, { method: "POST" }),
  reissue: (id: string, sendEmail: boolean) =>
    req<IssuedLink>(`/api/portal-grants/${id}/reissue`, json("POST", { sendEmail, baseUrl: window.location.origin })),
  activity: (id: string, before?: number) =>
    req<GrantActivity>(`/api/portal-grants/${id}/activity${query({ before })}`),
  notes: (id: string) => req<GrantNote[]>(`/api/portal-grants/${id}/notes`),
};

// ---- The portal itself (link token) ---------------------------------------------------

/**
 * Calls made by a portal link's page. The token goes in a header, never the
 * URL of a request, and no cookie is sent: the portal API does not use one.
 */
export function portalClient(token: string, getPass: () => string | null) {
  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { "x-portal-token": token, ...extra };
    const pass = getPass();
    if (pass) h["x-portal-pass"] = pass;
    return h;
  };

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const isJson = typeof init.body === "string";
    const res = await fetch(`/api/portal${path}`, {
      ...init,
      credentials: "omit",
      headers: headers(isJson ? { "Content-Type": "application/json" } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
    return body as T;
  }

  async function blob(path: string): Promise<Blob> {
    const res = await fetch(`/api/portal${path}`, { credentials: "omit", headers: headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText);
    }
    return res.blob();
  }

  return {
    session: () => call<PortalSession>("/session"),
    sendCode: () => call<{ sent: true }>("/code", { method: "POST", body: "{}" }),
    verifyCode: (code: string) => call<{ pass: string; expiresAt: string }>("/code/verify", json("POST", { code })),
    overview: () => call<PortalOverview>("/overview"),
    items: (f: LineFilter) => call<LinePage>(`/items${query(f)}`),
    line: (id: string) => call<LineDetail>(`/items/${id}`),
    flagged: () => call<FlaggedPage>("/flagged"),
    documents: () => call<PortalDocuments>("/documents"),
    file: (id: string, thumb?: number) => blob(`/files/${id}${query({ thumb })}`),
    setNotify: (enabled: boolean) => call<{ notify: boolean }>("/notifications", json("POST", { enabled })),
    scan: (codes: string[], stage: string, shipmentId: string | null) =>
      call<ScanResult>("/scan", json("POST", { codes, stage, shipmentId })),
    addNote: (lineId: string, body: string, condition: NoteCondition | null) =>
      call<PortalNote>(`/items/${lineId}/notes`, json("POST", { body, condition })),
    addPhoto: async (lineId: string, file: Blob, stage: string, caption: string) => {
      const res = await fetch(
        `/api/portal/items/${lineId}/photos${query({ stage, caption, type: file.type || "image/jpeg" })}`,
        { method: "POST", body: file, credentials: "omit", headers: headers({ "Content-Type": "application/octet-stream" }) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText);
      return body as PortalPhoto;
    },
    handoff: (input: { signerName: string; signerRole: string | null; image: string; shipmentId: string | null }) =>
      call<HandoffReceipt>("/handoff", json("POST", input)),
  };
}

export type PortalClient = ReturnType<typeof portalClient>;
