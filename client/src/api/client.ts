import type {
  Account,
  ApiKey,
  AppConfig,
  AuthMethods,
  Company,
  Enrichment,
  Entity,
  Identifier,
  IdentifierType,
  Item,
  ItemDetail,
  AuditResult,
  Location,
  LocationDetail,
  NinjaStatus,
  VerifyResult,
  RegistrarStatus,
  PricingResult,
  ScanResult,
  Stats,
  User,
} from "../types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText, body.details);
  }
  return body as T;
}

export type UnitPayload = {
  label?: string | null;
  serial?: string | null;
  status?: string;
  valueCents?: number | null;
  locationId?: string | null;
  utilizedByEntityId?: string | null;
  notes?: string | null;
};

export type CreateItemPayload = {
  name: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  primaryImageUrl?: string | null;
  parentItemId?: string | null;
  locationId?: string | null;
  utilizedByEntityId?: string | null;
  companyId?: string | null;
  valueCents?: number | null;
  expiresAt?: string | null;
  quantity?: number;
  enrichmentSource?: string | null;
  metadata?: Record<string, unknown>;
  identifiers?: { type: IdentifierType; value: string }[];
  images?: string[];
};

export const api = {
  config: () => req<AppConfig>("/api/config"),
  authMethods: () => req<AuthMethods>("/auth/methods"),
  login: (email: string, password: string) =>
    req<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }).then((r) => r.user),
  setup: (input: { email: string; name: string; password: string }) =>
    req<{ user: User }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.user),

  me: () => req<{ user: User }>("/api/me").then((r) => r.user),
  scan: (code: string) => req<ScanResult>(`/api/scan/${encodeURIComponent(code)}`),
  enrich: (code: string, refresh = false) =>
    req<Enrichment>("/api/enrich", { method: "POST", body: JSON.stringify({ code, refresh }) }),

  listItems: (params: { q?: string; locationId?: string; companyId?: string; kind?: "physical" | "digital" | "all" } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.locationId) qs.set("locationId", params.locationId);
    if (params.companyId) qs.set("companyId", params.companyId);
    if (params.kind && params.kind !== "physical") qs.set("kind", params.kind);
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<Item[]>(`/api/items${suffix}`);
  },
  listDomains: () => req<Item[]>("/api/items/domains"),
  /** Search by describing what you want; the filter comes back with the hits. */
  askSearch: (query: string, kind?: "physical" | "digital" | "all") => {
    const qs = kind && kind !== "physical" ? `?kind=${kind}` : "";
    return req<{ filter: Record<string, unknown>; items: Item[] }>(`/api/search/ask${qs}`, {
      method: "POST",
      body: JSON.stringify({ query }),
    });
  },
  getItem: (id: string) => req<ItemDetail>(`/api/items/${id}`),
  createItem: (payload: CreateItemPayload) =>
    req<ItemDetail>("/api/items", { method: "POST", body: JSON.stringify(payload) }),
  updateItem: (id: string, payload: Partial<CreateItemPayload>) =>
    req<ItemDetail>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  uploadPhoto: async (itemId: string, file: File): Promise<ItemDetail> => {
    const res = await fetch(`/api/items/${itemId}/photo`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": file.type || "image/jpeg" },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.code ?? "error", body.error ?? res.statusText);
    return body as ItemDetail;
  },
  // Street price and photos for an item that already exists.
  lookupPricing: (itemId: string) =>
    req<PricingResult>(`/api/items/${itemId}/pricing`, { method: "POST" }),
  // Suggested description and photos for an item that already exists.
  lookupItem: (itemId: string) =>
    req<{ description?: string; images: string[] }>(`/api/items/${itemId}/lookup`, {
      method: "POST",
    }),
  // Copy an image found elsewhere into local storage as the item's photo.
  setPhotoFromUrl: (itemId: string, url: string) =>
    req<ItemDetail>(`/api/items/${itemId}/photo-from-url`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  deleteItem: (id: string) => req<void>(`/api/items/${id}`, { method: "DELETE" }),
  bulkUpdate: (
    ids: string[],
    set: { locationId?: string | null; utilizedByEntityId?: string | null; companyId?: string | null; status?: string },
  ) => req<{ updated: number }>("/api/items/bulk", { method: "POST", body: JSON.stringify({ ids, set }) }),
  bulkDelete: (ids: string[]) =>
    req<{ deleted: number }>("/api/items/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),

  addIdentifier: (itemId: string, type: IdentifierType, value: string) =>
    req<Identifier>(`/api/items/${itemId}/identifiers`, {
      method: "POST",
      body: JSON.stringify({ type, value }),
    }),
  removeIdentifier: (id: string) => req<void>(`/api/identifiers/${id}`, { method: "DELETE" }),

  addUnit: (itemId: string, payload: UnitPayload) =>
    req<ItemDetail>(`/api/items/${itemId}/units`, { method: "POST", body: JSON.stringify(payload) }),
  updateUnit: (itemId: string, unitId: string, payload: UnitPayload) =>
    req<ItemDetail>(`/api/items/${itemId}/units/${unitId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteUnit: (itemId: string, unitId: string) =>
    req<ItemDetail>(`/api/items/${itemId}/units/${unitId}`, { method: "DELETE" }),

  checkOutUnit: (itemId: string, unitId: string, entityId: string, note?: string | null) =>
    req<ItemDetail>(`/api/items/${itemId}/units/${unitId}/checkout`, {
      method: "POST",
      body: JSON.stringify({ entityId, note }),
    }),
  checkInUnit: (itemId: string, unitId: string, note?: string | null) =>
    req<ItemDetail>(`/api/items/${itemId}/units/${unitId}/checkin`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  checkOut: (itemId: string, entityId: string, note?: string | null) =>
    req<ItemDetail>(`/api/items/${itemId}/checkout`, {
      method: "POST",
      body: JSON.stringify({ entityId, note }),
    }),
  checkIn: (itemId: string, note?: string | null) =>
    req<ItemDetail>(`/api/items/${itemId}/checkin`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  // Reconciling a whole building in one walk.
  auditReconcile: (codes: string[], companyId?: string) =>
    req<AuditResult>("/api/audit/reconcile", {
      method: "POST",
      body: JSON.stringify({ codes, companyId }),
    }),
  auditApply: (seenIds: string[], missingIds: string[]) =>
    req<{ ok: true; checked: number; flaggedMissing: number }>("/api/audit/apply", {
      method: "POST",
      body: JSON.stringify({ seenIds, missingIds }),
    }),
  // A networked reader pushes tags in; this is where the audit screen polls.
  auditLive: (reader: string, since: number) =>
    req<{ seq: number; codes: string[] }>(
      `/api/audit/live?reader=${encodeURIComponent(reader)}&since=${since}`,
    ),
  auditLiveClear: (reader: string) =>
    req<{ ok: true }>(`/api/audit/live/clear?reader=${encodeURIComponent(reader)}`, {
      method: "POST",
    }),

  stats: () => req<Stats>("/api/stats"),
  itemsCsvUrl: () => "/api/reports/items.csv",

  listApiKeys: () => req<{ keys: ApiKey[] }>("/api/settings/api-keys").then((r) => r.keys),
  createApiKey: (name: string, scope: ApiKey["scope"]) =>
    req<ApiKey & { key: string }>("/api/settings/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, scope }),
    }),
  revokeApiKey: (id: string) =>
    req<void>(`/api/settings/api-keys/${id}`, { method: "DELETE" }),

  spotCheckCandidate: (itemId: string) =>
    req<{ candidate: { id: string; name: string } | null }>(
      `/api/items/${itemId}/spot-check-candidate`,
    ),
  recordSpotCheck: (candidateId: string, seen: boolean) =>
    req<{ ok: true }>(`/api/items/${candidateId}/spot-check`, {
      method: "POST",
      body: JSON.stringify({ seen }),
    }),

  listLocations: () => req<Location[]>("/api/locations"),
  getLocation: (id: string) => req<LocationDetail>(`/api/locations/${id}`),
  assignItemsToLocation: (id: string, itemIds: string[]) =>
    req<LocationDetail>(`/api/locations/${id}/items`, {
      method: "POST",
      body: JSON.stringify({ itemIds }),
    }),
  verifyLocation: (id: string, codes: string[]) =>
    req<VerifyResult>(`/api/locations/${id}/verify`, {
      method: "POST",
      body: JSON.stringify({ codes }),
    }),
  applyVerifyLocation: (id: string, presentIds: string[], missingIds: string[]) =>
    req<LocationDetail>(`/api/locations/${id}/verify/apply`, {
      method: "POST",
      body: JSON.stringify({ presentIds, missingIds }),
    }),
  createLocation: (payload: {
    name: string;
    address?: string | null;
    notes?: string | null;
    companyId?: string | null;
    parentId?: string | null;
  }) => req<Location>("/api/locations", { method: "POST", body: JSON.stringify(payload) }),
  updateLocation: (
    id: string,
    payload: {
      name?: string;
      address?: string | null;
      notes?: string | null;
      companyId?: string | null;
      parentId?: string | null;
    },
  ) => req<Location>(`/api/locations/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteLocation: (id: string) => req<void>(`/api/locations/${id}`, { method: "DELETE" }),

  listCompanies: () => req<Company[]>("/api/companies"),
  createCompany: (payload: { name: string; notes?: string | null }) =>
    req<Company>("/api/companies", { method: "POST", body: JSON.stringify(payload) }),
  updateCompany: (id: string, payload: { name?: string; notes?: string | null }) =>
    req<Company>(`/api/companies/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCompany: (id: string) => req<void>(`/api/companies/${id}`, { method: "DELETE" }),

  listEntities: () => req<Entity[]>("/api/entities"),
  createEntity: (payload: { name: string; kind?: string | null; notes?: string | null }) =>
    req<Entity>("/api/entities", { method: "POST", body: JSON.stringify(payload) }),
  updateEntity: (id: string, payload: { name?: string; kind?: string | null; notes?: string | null }) =>
    req<Entity>(`/api/entities/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteEntity: (id: string) => req<void>(`/api/entities/${id}`, { method: "DELETE" }),

  // Label printing. The browser sends these to a printer on its own machine.
  // Compact means the QR code alone, with the printed code beneath it.
  labelPreviewUrl: (id: string) => `/api/print/label/${id}/preview.png`, // PNG, on-screen preview
  labelPdfUrl: (id: string) => `/api/print/label/${id}/print.pdf`, // exact-size PDF, one page
  labelCompactPreviewUrl: (id: string) => `/api/print/label/${id}/compact-preview.png`,
  labelCompactPdfUrl: (id: string) => `/api/print/label/${id}/compact.pdf`,
  labelsPdfUrl: (ids: string[], compact = false) =>
    `/api/print/labels.pdf?ids=${ids.join(",")}${compact ? "&style=compact" : ""}`, // batch, one page each
  sampleLabelUrl: () => `/api/print/sample.png`,
  samplePdfUrl: () => `/api/print/sample.pdf`,

  // Container printing: the label marks it as a container, and the contents
  // sheet is a full-page packing slip with serials and a print timestamp.
  containerLabelPreviewUrl: (id: string) => `/api/print/container/${id}/preview.png`,
  containerLabelPdfUrl: (id: string) => `/api/print/container/${id}/label.pdf`,
  manifestPdfUrl: (id: string) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `/api/print/manifest/${id}/contents.pdf${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`;
  },

  // Location printing: the label identifies the shelf or tote, and the contents
  // sheet lists everything assigned to it.
  locationLabelPreviewUrl: (id: string) => `/api/print/location/${id}/preview.png`,
  locationLabelPdfUrl: (id: string) => `/api/print/location/${id}/label.pdf`,
  locationLabelCompactPdfUrl: (id: string) => `/api/print/location/${id}/compact.pdf`,
  locationManifestPdfUrl: (id: string) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `/api/print/manifest/location/${id}/contents.pdf${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`;
  },

  // Per-unit labels: every tracked unit carries its own printed code.
  unitLabelPreviewUrl: (unitId: string) => `/api/print/unit/${unitId}/preview.png`,
  unitLabelPdfUrl: (unitId: string) => `/api/print/unit/${unitId}/print.pdf`,
  unitLabelCompactPreviewUrl: (unitId: string) => `/api/print/unit/${unitId}/compact-preview.png`,
  unitLabelCompactPdfUrl: (unitId: string) => `/api/print/unit/${unitId}/compact.pdf`,
  unitLabelsPdfUrl: (unitIds: string[], compact = false) =>
    `/api/print/unit-labels.pdf?ids=${unitIds.map(encodeURIComponent).join(",")}${
      compact ? "&style=compact" : ""
    }`,

  // The same labels as a spreadsheet, for label software that imports a data
  // file instead of printing a PDF.
  labelSheetUrl: (ids: string[]) =>
    `/api/print/labels.xlsx?ids=${ids.map(encodeURIComponent).join(",")}`,
  unitLabelSheetUrl: (unitIds: string[]) =>
    `/api/print/labels.xlsx?units=${unitIds.map(encodeURIComponent).join(",")}`,
  containerLabelSheetUrl: (id: string) =>
    `/api/print/labels.xlsx?container=${encodeURIComponent(id)}`,
  locationLabelSheetUrl: (id: string) =>
    `/api/print/labels.xlsx?location=${encodeURIComponent(id)}`,
  sampleLabelSheetUrl: () => "/api/print/labels.xlsx?test=1",

  // Device management sync
  ninjaStatus: () => req<NinjaStatus>("/api/ninjaone/status"),
  ninjaSync: () =>
    req<{ created: number; updated: number; pushed: number; total: number }>("/api/ninjaone/sync", {
      method: "POST",
    }),
  ninjaDisconnect: () => req<{ ok: true }>("/api/ninjaone/disconnect", { method: "POST" }),

  // Domain registrars
  registrarStatus: () => req<RegistrarStatus>("/api/registrars/status"),
  registrarSync: () =>
    req<{ created: number; updated: number; flaggedMissing: number; total: number }>(
      "/api/registrars/sync",
      { method: "POST" },
    ),

  // Instance settings (administrators only)
  getConfig: () => req<AppConfig>("/api/settings"),
  saveConfig: (patch: Record<string, unknown>) =>
    req<AppConfig>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  // Accounts
  listAccounts: () => req<Account[]>("/api/settings/users"),
  createAccount: (input: {
    email: string;
    name?: string;
    role?: "admin" | "member";
    password?: string;
  }) => req<Account>("/api/settings/users", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (
    oid: string,
    patch: { name?: string; role?: "admin" | "member"; disabled?: boolean; password?: string },
  ) =>
    req<Account>(`/api/settings/users/${encodeURIComponent(oid)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteAccount: (oid: string) =>
    req<void>(`/api/settings/users/${encodeURIComponent(oid)}`, { method: "DELETE" }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>("/api/settings/users/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Backup
  // A JSON download, authenticated by the session cookie.
  backupExportUrl: () => "/api/backup/export",
  backupImport: (snapshot: unknown) =>
    req<{ ok: true; restored: Record<string, number> }>("/api/backup/import", {
      method: "POST",
      body: JSON.stringify({ ...(snapshot as object), confirm: true }),
    }),

  // Serve an external image from this origin, which sidesteps hotlink blocks,
  // expiring URLs and mixed-content warnings.
  imageProxyUrl: (url: string) => `/api/image?url=${encodeURIComponent(url)}`,
};

/** Deep link to a device in NinjaOne, built from the region this instance uses. */
export const ninjaoneAssetUrl = (baseUrl: string, assetId: string) =>
  `${baseUrl.replace(/\/+$/, "")}/#/assetManagement/search?assetId=${encodeURIComponent(assetId)}`;
