import { req } from "../../api/client";
import type { Guide, GuideSummary, PartPayload, ProcessMode, StepPayload, TeardownStatus } from "./types";

/** Client calls for teardown guides. Every change answers with the whole guide. */

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const base = "/api/teardown";

export const teardownApi = {
  status: () => req<TeardownStatus>(`${base}/status`),
  list: (opts: { itemId?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.itemId) qs.set("itemId", opts.itemId);
    if (opts.q) qs.set("q", opts.q);
    const query = qs.toString();
    return req<GuideSummary[]>(`${base}/guides${query ? `?${query}` : ""}`);
  },
  get: (id: string) => req<Guide>(`${base}/guides/${id}`),
  create: (payload: {
    itemId: string;
    unitId?: string | null;
    title?: string | null;
    videoAttachmentId?: string | null;
    process?: boolean;
  }) => req<Guide>(`${base}/guides`, json("POST", payload)),
  update: (id: string, patch: { title?: string; notes?: string | null; videoAttachmentId?: string | null; process?: boolean }) =>
    req<Guide>(`${base}/guides/${id}`, json("PATCH", patch)),
  remove: (id: string) => req<void>(`${base}/guides/${id}`, { method: "DELETE" }),

  process: (id: string, mode: ProcessMode = "continue") => req<Guide>(`${base}/guides/${id}/process`, json("POST", { mode })),
  cancel: (id: string) => req<Guide>(`${base}/guides/${id}/process/cancel`, { method: "POST" }),
  applyDraft: (id: string) => req<Guide>(`${base}/guides/${id}/draft/apply`, { method: "POST" }),
  discardDraft: (id: string) => req<Guide>(`${base}/guides/${id}/draft`, { method: "DELETE" }),

  addStep: (id: string, payload: StepPayload & { title: string; afterN?: number }) =>
    req<Guide>(`${base}/guides/${id}/steps`, json("POST", payload)),
  updateStep: (stepId: string, patch: StepPayload) => req<Guide>(`${base}/steps/${stepId}`, json("PATCH", patch)),
  deleteStep: (stepId: string) => req<Guide>(`${base}/steps/${stepId}`, { method: "DELETE" }),

  addPart: (id: string, payload: PartPayload & { name: string }) => req<Guide>(`${base}/guides/${id}/parts`, json("POST", payload)),
  updatePart: (partId: string, patch: PartPayload) => req<Guide>(`${base}/parts/${partId}`, json("PATCH", patch)),
  deletePart: (partId: string) => req<Guide>(`${base}/parts/${partId}`, { method: "DELETE" }),
  resetReassembly: (id: string) => req<Guide>(`${base}/guides/${id}/reassembly/reset`, { method: "POST" }),

  reportUrl: (id: string) =>
    `${base}/guides/${id}/report.pdf?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`,
  bagLabelsUrl: (id: string, steps?: number[]) =>
    `${base}/guides/${id}/bag-labels.pdf${steps?.length ? `?steps=${steps.join(",")}` : ""}`,
};
