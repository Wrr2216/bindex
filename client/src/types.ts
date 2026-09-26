export type IdentifierType =
  | "upc"
  | "serial"
  | "asset_tag"
  | "mac"
  | "sku"
  | "other"
  | "rfid"
  | "domain"
  | "nfc"
  | "legacy";

export interface Identifier {
  id: string;
  itemId: string;
  type: IdentifierType;
  value: string;
  createdAt: string;
}

export interface ItemImage {
  id: string;
  url: string;
  isPrimary: boolean;
  sort: number;
}

export interface ItemEvent {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
  userOid: string | null;
}

export interface Item {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  primaryImageUrl: string | null;
  parentItemId: string | null;
  locationId: string | null;
  quantity: number;
  status: string;
  valueCents: number | null;
  expiresAt: string | null;
  enrichmentSource: string | null;
  metadata: Record<string, unknown>;
  assetCode: string;
  ninjaoneDeviceId: number | null;
  ninjaoneAssetId: string | null;
  ninjaoneOrg: string | null;
  ninjaoneSyncedAt: string | null;
  utilizedByEntityId: string | null;
  companyId: string | null;
  lastSpotCheckedAt: string | null;
  lastSpotCheckedBy: string | null;
  flaggedMissing: boolean;
  createdAt: string;
  updatedAt: string;
  locationName?: string | null;
  companyName?: string | null;
  utilizedByEntityName?: string | null;
}

export interface Assignment {
  id: string;
  entityId: string | null;
  entityName: string;
  checkedOutAt: string;
  checkedInAt: string | null;
  note: string | null;
}

/** A unit's currently-open check-out, if it's out. */
export interface UnitAssignment {
  id: string;
  entityId: string | null;
  entityName: string;
  checkedOutAt: string;
  note: string | null;
}

export interface ItemUnit {
  id: string;
  itemId: string;
  /** The unit's own printed code, distinct from the item's. */
  assetCode: string;
  /** Optional human name for the unit ("Unit 1", "Spare in Rack B"). */
  label: string | null;
  serial: string | null;
  status: string;
  valueCents: number | null;
  locationId: string | null;
  utilizedByEntityId: string | null;
  notes: string | null;
  createdAt: string;
  /** Set while this unit is checked out; null when it's on the shelf. */
  assignment: UnitAssignment | null;
  locationName?: string | null;
  utilizedByEntityName?: string | null;
}

export interface ItemDetail extends Item {
  identifiers: Identifier[];
  images: ItemImage[];
  children: Item[];
  events: ItemEvent[];
  /** Item-level check-out history; per-unit ones live on each unit. */
  assignments: Assignment[];
  units: ItemUnit[];
  /** Set when the item was resolved by scanning a unit's own code or serial. */
  matchedUnitId?: string | null;
}

export interface Location {
  id: string;
  name: string;
  address: string | null;
  notes: string | null;
  companyId: string | null;
  parentId: string | null;
  companyName?: string | null;
  parentName?: string | null;
}

/** A sub-location (container) nested inside a rack. */
export interface LocationChild {
  id: string;
  name: string;
  itemCount: number;
}

export interface LocationContent {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  assetCode: string;
  quantity: number;
  serials: string[];
  flaggedMissing: boolean;
}

export interface LocationDetail extends Location {
  parentName: string | null;
  contents: LocationContent[];
  itemCount: number;
  totalUnits: number;
  children: LocationChild[];
}

export interface VerifyRef {
  id: string;
  name: string;
  assetCode: string;
}

export interface VerifyUnexpected extends VerifyRef {
  locationName: string | null;
}

export interface VerifyResult {
  present: VerifyRef[];
  missing: VerifyRef[];
  unexpected: VerifyUnexpected[];
  unresolved: string[];
}

export interface AuditMissingItem {
  id: string;
  name: string;
  assetCode: string;
}

export interface AuditLocationGroup {
  locationId: string | null;
  locationName: string | null;
  total: number;
  seen: number;
  missing: AuditMissingItem[];
}

export interface AuditResult {
  totalItems: number;
  seenItems: number;
  missingItems: number;
  seenIds: string[];
  unknownCodes: string[];
  locations: AuditLocationGroup[];
}

export interface Company {
  id: string;
  name: string;
  notes: string | null;
  createdAt: string;
}

export interface Entity {
  id: string;
  name: string;
  kind: string | null;
  notes: string | null;
  createdAt: string;
}

export interface Enrichment {
  found: boolean;
  source: string;
  name?: string;
  description?: string;
  brand?: string;
  model?: string;
  category?: string;
  imageUrl?: string;
  images?: string[];
}

export interface ScanResult {
  found: boolean;
  item?: ItemDetail;
  code?: string;
  enrichment?: Enrichment;
}

export interface PricingResult {
  found: boolean;
  priceCents?: number;
  currency?: string;
  retailer?: string;
  url?: string;
  checkedAt: string;
  notes?: string;
  images: string[];
}

export type UserRole = "admin" | "member";

export interface User {
  oid: string;
  email: string;
  name: string;
  role: UserRole;
}

/** An account as an administrator sees it on the accounts screen. */
export interface Account extends User {
  disabled: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLogin: string;
}

/** Which ways of signing in this instance offers. */
export interface AuthMethods {
  password: boolean;
  sso: boolean;
  ssoLabel: string;
  trusted: boolean;
  /** True while the instance has no accounts and is waiting for its first one. */
  needsSetup: boolean;
}

export interface Term {
  singular: string;
  plural: string;
}

export interface Features {
  groups: boolean;
  holders: boolean;
  domains: boolean;
  units: boolean;
  assignments: boolean;
  audit: boolean;
  printing: boolean;
  vehicleFields: boolean;
  lookup: boolean;
  askSearch: boolean;
  spotCheck: boolean;
  tracking: boolean;
  aiCapture: boolean;
  jobs: boolean;
  registerReconcile: boolean;
  consumables: boolean;
  legacyTags: boolean;
  offline: boolean;
  bulkCapture: boolean;
  aiCondition: boolean;
  inspections: boolean;
}

/**
 * What this instance is called, what it calls things, and which parts of the
 * app are switched on. Served unauthenticated so the sign-in screen can use it.
 */
export interface AppConfig {
  appName: string;
  orgName: string;
  tagline: string;
  accentColor: string;
  assetCodePrefix: string;
  locationCodePrefix: string;
  currency: string;
  locale: string;
  terms: {
    item: Term;
    location: Term;
    group: Term;
    holder: Term;
  };
  features: Features;
  /** Printed label size in mm, so the print view can state the real size. */
  label: { widthMm: number; heightMm: number };
  integrations: {
    ninjaone: boolean;
    registrars: boolean;
    lookup: boolean;
    webSearch: boolean;
    languageModel: boolean;
  };
}

export interface ApiKey {
  id: string;
  name: string;
  scope: "read" | "read_write";
  keyLast4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Breakdown {
  name: string;
  count: number;
  valueCents: number;
}

export interface Stats {
  items: number;
  valueCents: number;
  checkedOut: number;
  noLocation: number;
  noValue: number;
  byStatus: { name: string; count: number }[];
  byCategory: { name: string; count: number }[];
  byLocation: Breakdown[];
  byCompany: Breakdown[];
  byEntity: Breakdown[];
  digitalItems: number;
  digitalValueCents: number;
  byDigitalCategory: { name: string; count: number }[];
}

export interface SyncRun {
  id: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  created: number;
  updated: number;
  matched: number;
  error: string | null;
}

export interface NinjaStatus {
  enabled: boolean;
  intervalMinutes: number;
  lastRun: SyncRun | null;
  connected: boolean;
  connectedAt: string | null;
  /** Region-specific NinjaOne base URL, used to build asset deep links. */
  baseUrl: string;
}

export interface RegistrarStatus {
  enabled: boolean;
  cloudflare: boolean;
  porkbun: boolean;
  intervalMinutes: number;
  alertDays: number;
  lastRun: SyncRun | null;
}

export type OverlayState =
  | { kind: "closed" }
  | { kind: "loading"; code: string }
  | { kind: "found"; item: ItemDetail }
  | { kind: "create"; code: string; enrichment?: Enrichment; rev?: number; enriching?: boolean }
  | { kind: "error"; message: string };

export type ItemKind = "physical" | "digital" | "all";

export function itemKind(category: string | null): Exclude<ItemKind, "all"> {
  return category === "Domain" ? "digital" : "physical";
}
