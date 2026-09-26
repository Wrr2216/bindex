/**
 * Types for valuation, declarations, receipts, warranty and service. Mirrors
 * server/src/services/valuation; see docs/valuation.md.
 */
import type { Attachment, Signature, VerifyResult } from "../media-ai-core/types";

export type ValuationSource = "ai" | "web" | "receipt" | "manual" | "appraisal";
export type HighValueMode = "auto" | "yes" | "no";

export interface ValuationStatus {
  vision: boolean;
  webPrice: boolean;
  pdfReceipts: boolean;
  thresholdCents: number;
  warrantyAlertDays: number;
}

export interface ValuationSettings {
  highValueThresholdCents: number;
  warrantyAlertDays: number;
  serviceSoonDays: number;
  serviceSoonPercent: number;
  notify: boolean;
  depreciation: { defaultLifeYears: number; salvagePercent: number; lifeYearsByCategory: Record<string, number> };
}

export interface Valuation {
  id: string;
  itemId: string;
  unitId: string | null;
  valueCents: number;
  previousCents: number | null;
  currency: string;
  source: ValuationSource;
  basis: string | null;
  confidence: number | null;
  lowCents: number | null;
  highCents: number | null;
  valuedOn: string;
  details: Record<string, unknown>;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ValueRange {
  lowCents: number;
  highCents: number;
  suggestedCents: number;
  currency: string;
  basis: string | null;
}

export interface ValuationEstimate {
  brand: string | null;
  model: string | null;
  category: string | null;
  materials: string | null;
  condition: string | null;
  conditionNotes: string | null;
  description: string | null;
  estimatedValue: ValueRange | null;
  confidence: number;
  currencyMismatch: boolean;
}

export interface WebPrice {
  found: boolean;
  priceCents?: number;
  currency?: string;
  retailer?: string;
  url?: string;
  notes?: string;
  checkedAt: string;
}

export interface EstimateResult {
  available: boolean;
  found: boolean;
  estimate: ValuationEstimate | null;
  webPrice: WebPrice | null;
  attachmentIds: string[];
  currency: string;
  message?: string;
}

export interface ValuationProfile {
  id: string;
  itemId: string;
  unitId: string | null;
  purchaseDate: string | null;
  purchaseCents: number | null;
  vendor: string | null;
  receiptId: string | null;
  warrantyEnds: string | null;
  warrantyTerms: string | null;
  warrantyProvider: string | null;
  highValue: HighValueMode;
  usageHours: number | null;
  usageReadAt: string | null;
}

export type ProfilePatch = Partial<Omit<ValuationProfile, "id" | "itemId" | "unitId" | "receiptId" | "usageReadAt">> & {
  unitId?: string | null;
};

export interface Depreciation {
  costCents: number;
  lifeYears: number;
  ageYears: number;
  bookCents: number;
  depreciatedCents: number;
  fullyDepreciated: boolean;
}

export type WarrantyState = "active" | "expiring" | "expired" | "none";

export interface RecordSummary {
  unitId: string | null;
  label: string;
  valueCents: number | null;
  highValue: boolean;
  highValueMode: HighValueMode;
  profile: ValuationProfile | null;
  latest: Valuation | null;
  warranty: { state: WarrantyState; daysLeft: number | null };
  depreciation: Depreciation | null;
  lifeYears: number;
}

export type ServiceState = "ok" | "soon" | "overdue" | "inactive";

export interface ServiceStatus {
  state: ServiceState;
  dueAt: string | null;
  dueHours: number | null;
  daysLeft: number | null;
  hoursLeft: number | null;
  reason: "days" | "hours" | null;
  dueKey: string;
}

export interface ServicePlan {
  id: string;
  itemId: string;
  unitId: string | null;
  name: string;
  intervalDays: number | null;
  intervalHours: number | null;
  startsAt: string;
  startsHours: number | null;
  lastDoneAt: string | null;
  lastDoneHours: number | null;
  notes: string | null;
  active: boolean;
  status: ServiceStatus;
}

export interface ServiceRecord {
  id: string;
  planId: string | null;
  itemId: string;
  unitId: string | null;
  planName: string | null;
  doneAt: string;
  hours: number | null;
  costCents: number | null;
  notes: string | null;
  doneBy: string | null;
}

export interface ReceiptSummary {
  id: string;
  status: "draft" | "confirmed";
  vendor: string | null;
  purchaseDate: string | null;
  currency: string | null;
  totalCents: number | null;
  notes: string | null;
  createdAt: string;
  confirmedAt: string | null;
  lineCount: number;
  matchedCount: number;
  fileCount: number;
  thumbUrl: string | null;
}

export interface ReceiptLine {
  id: string;
  receiptId: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number | null;
  totalCents: number | null;
  sku: string | null;
  serial: string | null;
  warrantyMonths: number | null;
  itemId: string | null;
  unitId: string | null;
  /** What the line is matched to, by name. */
  itemName: string | null;
  unitLabel: string | null;
}

export interface ReceiptReading {
  vendor: string | null;
  purchaseDate: string | null;
  datePrinted: string | null;
  currency: string;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  warnings: string[];
}

export interface Receipt {
  id: string;
  status: "draft" | "confirmed";
  vendor: string | null;
  purchaseDate: string | null;
  currency: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  reading: (ReceiptReading & Record<string, unknown>) | null;
  notes: string | null;
  createdAt: string;
  confirmedAt: string | null;
  createdByName: string | null;
  confirmedByName: string | null;
  lines: ReceiptLine[];
  files: Attachment[];
}

export interface ReadResult {
  available: boolean;
  found: boolean;
  reading: ReceiptReading | null;
  receipt: Receipt;
  message?: string;
}

export interface ScoredMatch {
  itemId: string;
  unitId: string | null;
  name: string;
  assetCode: string;
  score: number;
  reason: "serial" | "unit_serial" | "code" | "model" | "name";
  explanation: string;
}

export interface LineProposal {
  candidates: ScoredMatch[];
  suggested: ScoredMatch | null;
}

export interface ConfirmLine {
  lineId: string;
  itemId?: string | null;
  unitId?: string | null;
  create?: boolean;
  setValue?: boolean;
  setWarranty?: boolean;
}

export interface ConfirmResult {
  receipt: Receipt;
  matched: { lineId: string; itemId: string; unitId: string | null; created: boolean; valued: boolean }[];
  notes: string[];
}

export type DeclarationScope = "company" | "location" | "job";

export interface DeclarationLine {
  id: string;
  declarationId: string;
  position: number;
  itemId: string | null;
  unitId: string | null;
  valuationId: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  serial: string | null;
  assetCode: string | null;
  description: string | null;
  materials: string | null;
  condition: string | null;
  declaredCents: number;
  valueSource: string | null;
  notes: string | null;
}

export interface DeclarationSummary {
  id: string;
  code: string;
  title: string;
  scope: DeclarationScope;
  scopeLabel: string | null;
  status: "draft" | "signed";
  currency: string;
  signedAt: string | null;
  createdAt: string;
  lineCount: number;
  totalCents: number;
  createdByName: string | null;
}

export interface Declaration extends Omit<DeclarationSummary, "lineCount"> {
  scopeId: string | null;
  notes: string | null;
  signatureId: string | null;
  auditEntryId: number | null;
  lines: DeclarationLine[];
  signingContent: unknown;
  statement: string;
  signature: Signature | null;
  verification: VerifyResult | null;
}

export interface ItemDeclarationRef {
  id: string;
  code: string;
  title: string;
  status: "draft" | "signed";
  declaredCents: number;
  signedAt: string | null;
}

export interface ItemValuation {
  itemId: string;
  currency: string;
  thresholdCents: number;
  hasUnits: boolean;
  records: RecordSummary[];
  valuations: Valuation[];
  servicePlans: ServicePlan[];
  serviceRecords: ServiceRecord[];
  receipts: ReceiptSummary[];
  declarations: ItemDeclarationRef[];
}

export interface WarrantyDue {
  kind: "warranty";
  itemId: string;
  unitId: string | null;
  name: string;
  warrantyEnds: string;
  daysLeft: number;
  provider: string | null;
  isNew: boolean;
}

export interface ServiceDue {
  kind: "service";
  itemId: string;
  unitId: string | null;
  name: string;
  planId: string;
  planName: string;
  status: ServiceStatus;
  isNew: boolean;
}

export interface ValuedRecord {
  itemId: string;
  unitId: string | null;
  name: string;
  unitLabel: string | null;
  brand: string | null;
  model: string | null;
  assetCode: string;
  valueCents: number | null;
  locationName: string | null;
  lastSource: string | null;
  lastValuedOn: string | null;
}

export interface Overview {
  currency: string;
  thresholdCents: number;
  totals: { records: number; valued: number; highValue: number; valueCents: number; highValueCents: number; aiEstimated: number };
  highValue: ValuedRecord[];
  due: { warranty: WarrantyDue[]; service: ServiceDue[] };
  recent: (Valuation & { itemName: string })[];
  drafts: { receipts: number; declarations: number };
}
