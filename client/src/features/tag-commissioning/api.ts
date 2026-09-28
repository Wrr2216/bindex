import { ApiError, req } from "../../api/client";
import type {
  BindSession,
  BoundTag,
  CodeLookup,
  ItemTags,
  PaletteColor,
  ReadOutcome,
  SessionListing,
  TagSettings,
  TagSummary,
  TagType,
  TierReport,
} from "./types";

const BASE = "/api/tag-commissioning";

/** The most useful message in an error, including the first validation failure. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.details && typeof err.details === "object") {
    const d = err.details as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
    const first = d.formErrors?.[0] ?? Object.values(d.fieldErrors ?? {}).flat()[0];
    if (first) return first;
  }
  return err instanceof Error ? err.message : fallback;
}
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const tagsApi = {
  settings: () => req<TagSettings>(`${BASE}/settings`),
  saveSettings: (patch: { gs1CompanyPrefix?: string; palette?: PaletteColor[] }) =>
    req<TagSettings>(`${BASE}/settings`, { method: "PUT", body: JSON.stringify(patch) }),

  resolve: (code: string) => req<CodeLookup>(`${BASE}/resolve?code=${encodeURIComponent(code)}`),
  summary: (itemIds: string[]) => req<Record<string, TagSummary>>(`${BASE}/summary`, json({ itemIds })),
  itemTags: (itemId: string) => req<ItemTags>(`${BASE}/items/${itemId}`),
  bind: (itemId: string, type: TagType, value: string, unitId?: string | null) =>
    req<{ tag: BoundTag; created: boolean }>(`${BASE}/items/${itemId}/bind`, json({ type, value, unitId })),

  setLegacy: (itemId: string, color: string, lot: string | null, number: number) =>
    req<{ value: string }>(`${BASE}/items/${itemId}/legacy`, {
      method: "PUT",
      body: JSON.stringify({ color, lot, number }),
    }),
  removeLegacy: (itemId: string) => req<void>(`${BASE}/items/${itemId}/legacy`, { method: "DELETE" }),
  nextLegacyNumber: (color: string, lot: string | null, after: number) => {
    const qs = new URLSearchParams({ color, after: String(after) });
    if (lot) qs.set("lot", lot);
    return req<{ number: number }>(`${BASE}/legacy/next?${qs}`);
  },
  createFromSticker: (input: {
    name: string;
    color: string;
    lot: string | null;
    number: number;
    locationId?: string | null;
  }) =>
    req<{
      item: { id: string; name: string; assetCode: string };
      value: string;
      next: { color: string; lot: string | null; number: number };
    }>(`${BASE}/legacy/items`, json(input)),

  tierReport: (locationId?: string) =>
    req<TierReport>(`${BASE}/report/tiers${locationId ? `?locationId=${locationId}` : ""}`),

  sessions: () => req<SessionListing[]>(`${BASE}/sessions`),
  session: (id: string) => req<BindSession>(`${BASE}/sessions/${id}`),
  createSession: (input: {
    tagType: TagType;
    locationId: string;
    includeSubLocations: boolean;
    onlyUntagged: boolean;
    includeUnits: boolean;
    name?: string;
  }) => req<BindSession>(`${BASE}/sessions`, json(input)),
  sessionRead: (id: string, code: string) =>
    req<{ outcome: ReadOutcome; session: BindSession }>(`${BASE}/sessions/${id}/read`, json({ code })),
  sessionSkip: (id: string) => req<BindSession>(`${BASE}/sessions/${id}/skip`, json({})),
  sessionUndo: (id: string) => req<BindSession>(`${BASE}/sessions/${id}/undo`, json({})),
  sessionFinish: (id: string) => req<BindSession>(`${BASE}/sessions/${id}/finish`, json({})),

  /**
   * The ZPL or CSV for "Print and encode", as a file. Not JSON, so it is
   * fetched directly and handed back as a blob with the counts the server
   * put in the headers.
   */
  encode: async (input: {
    itemIds?: string[];
    unitIds?: string[];
    format: "zpl" | "csv";
    dpi: number;
    bind: boolean;
    sample?: boolean;
  }) => {
    const res = await fetch(`${BASE}/encode`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
    }
    const disposition = res.headers.get("Content-Disposition") ?? "";
    return {
      blob: await res.blob(),
      filename: disposition.match(/filename="([^"]+)"/)?.[1] ?? `labels.${input.format}`,
      count: Number(res.headers.get("X-Label-Count") ?? 0),
      bound: Number(res.headers.get("X-Tags-Bound") ?? 0),
    };
  },
};
