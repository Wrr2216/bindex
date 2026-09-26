import { req } from "../../api/client";
import type {
  CatalogRow,
  ConsumableDetail,
  ConsumableSettings,
  CountResult,
  DescribedCode,
  HolderDetail,
  HolderSummary,
  KitDetail,
  KitFailure,
  KitLineInput,
  KitSummary,
  LocationStock,
  LookupResult,
  LowStockRow,
  Movement,
  MovementPayload,
  MovementResult,
  OverdueLine,
  ReturnResult,
  StockReason,
  UsageReport,
} from "./types";

const BASE = "/api/consumables";
const enc = encodeURIComponent;

function query(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

const post = <T>(path: string, body: unknown) =>
  req<T>(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) });

export const suppliesApi = {
  catalog: (q?: string) => req<CatalogRow[]>(`${BASE}/catalog${query({ q })}`),
  detail: (itemId: string) => req<ConsumableDetail>(`${BASE}/items/${enc(itemId)}`),
  saveSettings: (itemId: string, settings: ConsumableSettings) =>
    req<ConsumableDetail>(`${BASE}/items/${enc(itemId)}`, { method: "PUT", body: JSON.stringify(settings) }),
  untrack: (itemId: string) => req<void>(`${BASE}/items/${enc(itemId)}`, { method: "DELETE" }),

  lookup: (code: string) => req<LookupResult>(`${BASE}/lookup${query({ code })}`),
  resolve: (codes: string[]) => post<DescribedCode[]>("/resolve", { codes }),

  move: (payload: MovementPayload) => post<MovementResult>("/movements", payload),
  movements: (filter: {
    itemId?: string;
    holderId?: string;
    locationId?: string;
    reason?: StockReason;
    from?: string;
    to?: string;
    limit?: number;
  }) => req<Movement[]>(`${BASE}/movements${query(filter)}`),
  count: (locationId: string, lines: { itemId: string; countedQty: number }[], note?: string) =>
    post<CountResult>("/counts", { locationId, lines, note: note || null }),
  locationStock: (locationId: string) => req<LocationStock>(`${BASE}/locations/${enc(locationId)}`),
  lowStock: () => req<LowStockRow[]>(`${BASE}/low-stock`),

  holders: () => req<HolderSummary[]>(`${BASE}/holders`),
  holder: (id: string, since?: string) => req<HolderDetail>(`${BASE}/holders/${enc(id)}${query({ since })}`),

  createKit: (payload: {
    holderId: string;
    expectedReturnAt?: string | null;
    jobRef?: string | null;
    note?: string | null;
    lines: KitLineInput[];
  }) => post<{ kit: KitDetail; failures: KitFailure[] }>("/kits", payload),
  kits: (status: "open" | "closed" | "overdue" | "all" = "open", holderId?: string) =>
    req<KitSummary[]>(`${BASE}/kits${query({ status, holderId })}`),
  overdue: () => req<OverdueLine[]>(`${BASE}/kits/overdue`),
  kit: (id: string) => req<KitDetail>(`${BASE}/kits/${enc(id)}`),
  returnEquipment: (payload: { holderId?: string | null; lines: KitLineInput[] }) =>
    post<ReturnResult>("/returns", payload),

  usage: (from: string, to: string) => req<UsageReport>(`${BASE}/reports/usage${query({ from, to })}`),
  usageXlsxUrl: (from: string, to: string) => `${BASE}/reports/usage.xlsx${query({ from, to })}`,
};
