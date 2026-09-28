import { req } from "../../api/client";
import type {
  ConfirmLine,
  ConfirmResult,
  Declaration,
  DeclarationScope,
  DeclarationSummary,
  EstimateResult,
  ItemValuation,
  LineProposal,
  Overview,
  ProfilePatch,
  ReadResult,
  Receipt,
  ReceiptLine,
  ReceiptSummary,
  ServicePlan,
  Valuation,
  ValuationProfile,
  ValuationSettings,
  ValuationSource,
  ValuationStatus,
  WarrantyDue,
  ServiceDue,
} from "./types";

/** Client calls for valuation, receipts, declarations, warranty and service. */

const BASE = "/api/valuation";
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** The viewer's time zone, so printed times read as local. */
const tz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const valuationApi = {
  status: () => req<ValuationStatus>(`${BASE}/status`),
  settings: () => req<ValuationSettings>(`${BASE}/settings`),
  saveSettings: (patch: Partial<ValuationSettings>) => req<ValuationSettings>(`${BASE}/settings`, json("PUT", patch)),
  overview: () => req<Overview>(`${BASE}/overview`),
  due: () => req<{ warranty: WarrantyDue[]; service: ServiceDue[] }>(`${BASE}/due`),
  runDigest: () => req<{ announced: number; notified: boolean; skipped?: string }>(`${BASE}/digest/run`, { method: "POST" }),

  item: (itemId: string) => req<ItemValuation>(`${BASE}/items/${itemId}`),
  estimate: (itemId: string, body: { unitId?: string | null; attachmentIds: string[]; crossCheck?: boolean }) =>
    req<EstimateResult>(`${BASE}/items/${itemId}/estimate`, json("POST", body)),
  recordValuation: (
    itemId: string,
    body: {
      unitId?: string | null;
      valueCents: number;
      source: ValuationSource;
      basis?: string | null;
      confidence?: number | null;
      lowCents?: number | null;
      highCents?: number | null;
      valuedOn?: string | null;
      details?: Record<string, unknown>;
      apply?: { brand?: string | null; model?: string | null };
    },
  ) => req<Valuation>(`${BASE}/items/${itemId}/valuations`, json("POST", body)),
  saveProfile: (itemId: string, patch: ProfilePatch) => req<ValuationProfile>(`${BASE}/items/${itemId}/profile`, json("PUT", patch)),

  createPlan: (
    itemId: string,
    body: { unitId?: string | null; name: string; intervalDays?: number | null; intervalHours?: number | null; lastDoneAt?: string | null; lastDoneHours?: number | null; notes?: string | null },
  ) => req<ServicePlan>(`${BASE}/items/${itemId}/service-plans`, json("POST", body)),
  updatePlan: (id: string, patch: Partial<{ name: string; intervalDays: number | null; intervalHours: number | null; notes: string | null; active: boolean }>) =>
    req<ServicePlan>(`${BASE}/service-plans/${id}`, json("PATCH", patch)),
  deletePlan: (id: string) => req<void>(`${BASE}/service-plans/${id}`, { method: "DELETE" }),
  logService: (id: string, body: { doneAt?: string | null; hours?: number | null; costCents?: number | null; notes?: string | null }) =>
    req<ServicePlan>(`${BASE}/service-plans/${id}/done`, json("POST", body)),

  declarations: () => req<DeclarationSummary[]>(`${BASE}/declarations`),
  createDeclaration: (body: {
    title?: string | null;
    scope: DeclarationScope;
    scopeId?: string | null;
    scopeLabel?: string | null;
    notes?: string | null;
    populate?: boolean;
    itemIds?: string[];
  }) => req<Declaration>(`${BASE}/declarations`, json("POST", body)),
  declaration: (id: string) => req<Declaration>(`${BASE}/declarations/${id}`),
  updateDeclaration: (id: string, patch: { title?: string; notes?: string | null; scopeLabel?: string | null }) =>
    req<Declaration>(`${BASE}/declarations/${id}`, json("PATCH", patch)),
  deleteDeclaration: (id: string) => req<void>(`${BASE}/declarations/${id}`, { method: "DELETE" }),
  addLines: (id: string, lines: { itemId: string; unitId?: string | null }[]) =>
    req<Declaration>(`${BASE}/declarations/${id}/lines`, json("POST", { lines })),
  updateLine: (id: string, lineId: string, patch: Partial<Pick<Declaration["lines"][number], "declaredCents" | "name" | "description" | "materials" | "condition" | "serial" | "notes">>) =>
    req<Declaration>(`${BASE}/declarations/${id}/lines/${lineId}`, json("PATCH", patch)),
  removeLine: (id: string, lineId: string) => req<Declaration>(`${BASE}/declarations/${id}/lines/${lineId}`, { method: "DELETE" }),
  markSigned: (id: string, signatureId: string) => req<Declaration>(`${BASE}/declarations/${id}/signed`, json("POST", { signatureId })),
  verifyDeclaration: (id: string) => req<{ valid: boolean; reason: string; code: string; signedAt: string }>(`${BASE}/declarations/${id}/verify`),
  declarationPdfUrl: (id: string) => `${BASE}/declarations/${id}/pdf?tz=${encodeURIComponent(tz())}`,

  receipts: (opts: { itemId?: string; status?: "draft" | "confirmed" } = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter((e): e is [string, string] => Boolean(e[1]))).toString();
    return req<ReceiptSummary[]>(`${BASE}/receipts${qs ? `?${qs}` : ""}`);
  },
  createReceipt: (notes?: string) => req<Receipt>(`${BASE}/receipts`, json("POST", { notes: notes ?? null })),
  receipt: (id: string) => req<Receipt>(`${BASE}/receipts/${id}`),
  updateReceipt: (
    id: string,
    patch: Partial<Pick<Receipt, "vendor" | "purchaseDate" | "currency" | "subtotalCents" | "taxCents" | "totalCents" | "notes">> & {
      lines?: Partial<Omit<ReceiptLine, "id" | "receiptId" | "position">>[];
    },
  ) => req<Receipt>(`${BASE}/receipts/${id}`, json("PUT", patch)),
  deleteReceipt: (id: string) => req<void>(`${BASE}/receipts/${id}`, { method: "DELETE" }),
  readReceipt: (id: string) => req<ReadResult>(`${BASE}/receipts/${id}/read`, { method: "POST" }),
  matches: (id: string, preferItemId?: string | null) =>
    req<LineProposal[]>(`${BASE}/receipts/${id}/matches${preferItemId ? `?preferItemId=${preferItemId}` : ""}`),
  confirmReceipt: (id: string, lines: ConfirmLine[]) => req<ConfirmResult>(`${BASE}/receipts/${id}/confirm`, json("POST", { lines })),

  reportUrl: (opts: { format: "pdf" | "xlsx"; locationId?: string; companyId?: string; groupBy?: "location" | "company"; highValueOnly?: boolean; asOf?: string }) => {
    const qs = new URLSearchParams({ format: opts.format, tz: tz() });
    if (opts.locationId) qs.set("locationId", opts.locationId);
    if (opts.companyId) qs.set("companyId", opts.companyId);
    if (opts.groupBy) qs.set("groupBy", opts.groupBy);
    if (opts.highValueOnly) qs.set("highValueOnly", "true");
    if (opts.asOf) qs.set("asOf", opts.asOf);
    return `${BASE}/report?${qs}`;
  },
};
