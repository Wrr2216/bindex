import { req } from "../../api/client";
import type {
  AwaitingShipment,
  CustodyMeta,
  ItemChain,
  Outcome,
  Party,
  PartyInput,
  ScanOutcome,
  ShipmentReview,
  SignResponse,
  TransferDetail,
  TransferSummary,
  VerifyReport,
} from "./types";

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export type TransferInput = {
  purpose: string;
  from: PartyInput;
  to: PartyInput;
  locationId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  jobId?: string | null;
  shipmentId?: string | null;
  sealNumbers?: string[];
  conditionNote?: string | null;
  notes?: string | null;
};

export type OutcomeInput = { lineId: string; outcome: Outcome; note?: string | null };

export type SignInput = {
  party: Party;
  signerName: string;
  signerEmail?: string | null;
  signerRole?: string | null;
  image: string;
  expectedCount?: number;
  outcomes?: OutcomeInput[];
};

export const custodyApi = {
  meta: () => req<CustodyMeta>("/api/custody/meta"),

  chain: (itemId: string) => req<ItemChain>(`/api/custody/items/${itemId}/chain`),
  setControl: (itemId: string, controlled: boolean, reason?: string | null) =>
    req<unknown>(`/api/custody/controls/${itemId}`, json("PUT", { controlled, reason })),

  list: (params: { status?: string; purpose?: string; q?: string; jobId?: string; shipmentId?: string } = {}) =>
    req<TransferSummary[]>(`/api/custody/transfers${query(params)}`),
  get: (id: string) => req<TransferDetail>(`/api/custody/transfers/${id}`),
  create: (input: TransferInput) => req<TransferDetail>("/api/custody/transfers", json("POST", input)),
  update: (id: string, patch: Partial<TransferInput>) => req<TransferDetail>(`/api/custody/transfers/${id}`, json("PATCH", patch)),
  scan: (id: string, codes: string[], via: "scan" | "manual" = "scan") =>
    req<ScanOutcome>(`/api/custody/transfers/${id}/scan`, json("POST", { codes, via })),
  removeLines: (id: string, ids: string[]) =>
    req<{ removed: number }>(`/api/custody/transfers/${id}/lines/remove`, json("POST", { ids })),
  setOutcomes: (id: string, outcomes: OutcomeInput[]) =>
    req<{ updated: number }>(`/api/custody/transfers/${id}/outcomes`, json("POST", { outcomes })),
  lock: (id: string, expectedCount: number) =>
    req<TransferDetail>(`/api/custody/transfers/${id}/lock`, json("POST", { expectedCount })),
  sign: (id: string, input: SignInput) => req<SignResponse>(`/api/custody/transfers/${id}/sign`, json("POST", input)),
  issueLink: (id: string, party: Party, hours?: number) =>
    req<{ url: string; path: string; expiresAt: string; transfer: TransferDetail }>(
      `/api/custody/transfers/${id}/link`,
      json("POST", { party, hours }),
    ),
  revokeLink: (id: string) => req<void>(`/api/custody/transfers/${id}/link`, { method: "DELETE" }),
  void: (id: string, reason: string | null) => req<TransferDetail>(`/api/custody/transfers/${id}/void`, json("POST", { reason })),
  finalize: (id: string) => req<{ transfer: TransferDetail }>(`/api/custody/transfers/${id}/finalize`, { method: "POST" }),
  verify: (id: string) => req<VerifyReport>(`/api/custody/transfers/${id}/verify`),
  receiptUrl: (id: string) => `/api/custody/transfers/${id}/receipt.pdf`,
  verifyReceipt: (file: Blob) =>
    req<{ found: boolean; sha256: string; report: VerifyReport | null }>("/api/custody/verify-receipt", {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/pdf" },
    }),

  awaiting: () => req<AwaitingShipment[]>("/api/custody/shipments/awaiting"),
  review: (shipmentId: string) => req<ShipmentReview>(`/api/custody/shipments/${shipmentId}/review`),
  startSignOff: (shipmentId: string, input: { to: PartyInput; from?: PartyInput; sealNumbers?: string[]; locationId?: string | null }) =>
    req<TransferDetail>(`/api/custody/shipments/${shipmentId}/sign-off`, json("POST", input)),
};
