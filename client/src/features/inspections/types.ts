/**
 * Types for site inspections. Mirrors server/src/services/inspections; see
 * docs/inspections.md.
 */
import type { Attachment, Signature } from "../media-ai-core";

export type InspectionKind = "pre" | "post" | "adhoc";
export type InspectionStatus = "draft" | "completed" | "signed";
export type FindingArea = "inside" | "outside";
export type Severity = "minor" | "moderate" | "major";
export type SignoffRole = "facility_contact" | "crew_lead";
export type ChangeKind = "new" | "worsened" | "resolved" | "unchanged";

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

export interface InspectionsMeta {
  kinds: Option<InspectionKind>[];
  statuses: Option<InspectionStatus>[];
  areas: Option<FindingArea>[];
  spots: Option[];
  severities: (Option<Severity> & { color: string })[];
  signoffs: Option<SignoffRole>[];
  share: { defaultDays: number; maxDays: number };
  ai: { vision: boolean; languageModel: boolean };
}

export interface Inspection {
  id: string;
  code: string;
  kind: InspectionKind;
  status: InspectionStatus;
  jobId: string | null;
  jobTaskId: string | null;
  locationId: string | null;
  siteName: string;
  preInspectionId: string | null;
  inspectors: string[];
  notes: string | null;
  facilitySignatureId: string | null;
  crewSignatureId: string | null;
  startedBy: string | null;
  startedAt: string;
  completedAt: string | null;
  completedBy: string | null;
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InspectionSummary extends Inspection {
  jobCode: string | null;
  jobName: string | null;
  preCode: string | null;
  findingCount: number;
}

export interface Finding {
  id: string;
  inspectionId: string;
  sequence: number;
  number: number;
  area: FindingArea;
  room: string;
  locationId: string | null;
  spot: string;
  spotDetail: string | null;
  description: string;
  severity: Severity;
  aiGenerated: boolean;
  aiSuggestion: Record<string, unknown> | null;
  preExisting: boolean;
  attachmentIds: string[];
  pairedWithId: string | null;
  pairSource: "ai" | "manual" | null;
  photos: Attachment[];
}

export interface ComparisonEntry {
  change: ChangeKind;
  preId: string | null;
  postId: string | null;
  source: "manual" | "ai" | "room_spot" | null;
  notedPreExisting: boolean;
}

export interface SignatureView extends Signature {
  verification: { valid: boolean; reason: string };
  role: SignoffRole | null;
}

export interface KnownRoom {
  name: string;
  locationId: string | null;
}

export interface InspectionDetail extends Inspection {
  job: {
    id: string;
    code: string;
    name: string;
    status: string;
    originLocationId: string | null;
    destinationLocationId: string | null;
  } | null;
  task: { id: string; title: string; kind: string; status: string } | null;
  location: { id: string; name: string; address: string | null } | null;
  preInspection: {
    id: string;
    code: string;
    status: InspectionStatus;
    siteName: string;
    startedAt: string;
    completedAt: string | null;
  } | null;
  findings: Finding[];
  preFindings: Finding[];
  photos: Attachment[];
  rooms: KnownRoom[];
  comparison: { counts: Record<ChangeKind, number>; entries: ComparisonEntry[] } | null;
  signatures: SignatureView[];
  editable: boolean;
}

export interface FindingInput {
  area?: FindingArea;
  room?: string | null;
  locationId?: string | null;
  spot?: string;
  spotDetail?: string | null;
  description?: string;
  severity?: Severity;
  preExisting?: boolean;
  aiGenerated?: boolean;
  aiSuggestion?: Record<string, unknown> | null;
  attachmentIds?: string[];
}

export interface InspectionInput {
  kind: InspectionKind;
  locationId?: string | null;
  siteName?: string | null;
  jobId?: string | null;
  jobTaskId?: string | null;
  preInspectionId?: string | null;
  inspectors?: string[];
  notes?: string | null;
}

export interface DamageSuggestion {
  damage: boolean;
  area: FindingArea | null;
  room: string | null;
  locationId: string | null;
  spot: string;
  spotDetail: string | null;
  description: string | null;
  severity: Severity | null;
  confidence: number | null;
}

export interface SignRequest {
  ownerType: "inspection";
  ownerId: string;
  role: SignoffRole;
  statement: string;
  content: unknown;
}

export interface ShareLink {
  id: string;
  inspectionId: string;
  expiresAt: string;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  active: boolean;
  token: string | null;
  path: string | null;
  url: string | null;
}
