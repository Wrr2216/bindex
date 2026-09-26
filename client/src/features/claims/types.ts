/** Claims and incident reports, as the /api/claims routes return them. */

export type ClaimType = "loss" | "damage" | "property_damage" | "delay" | "other" | "incident";
export type ClaimStatus = "draft" | "submitted" | "under_review" | "approved" | "denied" | "paid" | "closed";
export type Resolution = "repair" | "replace" | "cash" | "deny";
export type SlaState = "none" | "running" | "due_soon" | "overdue" | "met" | "missed";

export type TypeInfo = { type: ClaimType; label: string; money: boolean; description: string };

export type Transition = {
  from: ClaimStatus;
  to: ClaimStatus;
  action: string;
  note: "required" | "optional";
  decision: boolean;
  money: boolean;
};

export type ClaimsMeta = {
  types: TypeInfo[];
  statuses: { status: ClaimStatus; label: string }[];
  resolutions: { resolution: Resolution; label: string }[];
  incidentCategories: { name: string; label: string }[];
  transitions: Transition[];
  sla: { claimHours: number; incidentHours: number };
  sources: { conditionReports: boolean; custody: boolean; portal: boolean };
  jobs: boolean;
  currency: string;
};

export type Sla = { state: SlaState; dueAt: string | null; remainingMs: number | null };

export type Claim = {
  id: string;
  code: string;
  type: ClaimType;
  category: string | null;
  status: ClaimStatus;
  title: string;
  description: string | null;
  jobId: string | null;
  shipmentId: string | null;
  locationId: string | null;
  occurredAt: string | null;
  reporterUserOid: string | null;
  reporterGrantId: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  assigneeUserOid: string | null;
  assigneeName: string | null;
  assignedAt: string | null;
  currency: string;
  estimatedTotalCents: number | null;
  approvedTotalCents: number | null;
  paidTotalCents: number | null;
  carrierReference: string | null;
  insurerReference: string | null;
  paymentReference: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  slaDueAt: string | null;
  slaBreachedAt: string | null;
  evidenceHash: string | null;
  evidenceFrozenAt: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimSummary = Claim & { jobCode: string | null; shipmentCode: string | null; lineCount: number; sla: Sla };

export type ClaimLine = {
  id: string;
  claimId: string;
  position: number;
  jobItemId: string | null;
  itemId: string | null;
  unitId: string | null;
  itemName: string | null;
  assetCode: string | null;
  declaredValueCents: number | null;
  description: string | null;
  damageDescription: string | null;
  estimatedCents: number | null;
  approvedCents: number | null;
  resolution: Resolution | null;
  notes: string | null;
  currentItemName: string | null;
  stage: string | null;
  stageLabel: string | null;
  jobCode: string | null;
  shipmentCode: string | null;
  photoCount: number;
};

export type Activity = {
  id: string;
  claimId: string;
  kind: "created" | "comment" | "status" | "assignment" | "lines" | "update" | "export" | "sla";
  fromStatus: ClaimStatus | null;
  toStatus: ClaimStatus | null;
  body: string | null;
  detail: Record<string, unknown>;
  authorUserOid: string | null;
  authorName: string | null;
  authorGrantId: string | null;
  auditLogId: number | null;
  createdAt: string;
};

export type Totals = {
  fromLines: boolean;
  lineCount: number;
  estimatedTotalCents: number | null;
  approvedTotalCents: number | null;
  decidedLines: number;
  undecidedLines: number;
  deniedLines: number;
  unestimatedLines: number;
};

export type ClaimDetail = Claim & {
  jobCode: string | null;
  jobName: string | null;
  shipmentCode: string | null;
  shipmentName: string | null;
  locationName: string | null;
  lines: ClaimLine[];
  activity: Activity[];
  totals: Totals;
  sla: Sla;
  transitions: Transition[];
  viewer: { canDecide: boolean; decideRefusal: string | null };
};

export type Candidate = {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  itemName: string;
  assetCode: string;
  stage: string;
  stageLabel: string;
  flagged: boolean;
  stageNote: string | null;
  shipmentId: string | null;
  shipmentCode: string | null;
  declaredValueCents: number | null;
  claims: { id: string; code: string; status: ClaimStatus }[];
};

export type LineInput = {
  jobItemId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  code?: string | null;
  description?: string | null;
  damageDescription?: string | null;
  estimatedCents?: number | null;
  notes?: string | null;
};

export type LineProblem = { input: string; problem: string };

// --- Evidence --------------------------------------------------------------------

export type Phase = "before" | "during" | "after" | "unknown";

export type EvidenceAttachment = {
  id: string;
  owner: "item" | "unit" | "claim_line" | "claim" | "condition_report";
  kind: string;
  stage: string | null;
  phase: Phase;
  caption: string | null;
  mime: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  url: string;
  thumbUrl: string | null;
};

export type ConditionNote = {
  source: "stage" | "line" | "condition_report" | "photo" | "custody";
  at: string | null;
  stage: string | null;
  text: string;
  by: string | null;
  ref: string | null;
};

export type ConditionReport = {
  id: string;
  stage: string | null;
  rating: string | null;
  notes: string | null;
  aiNotes: string | null;
  handlingNote: string | null;
  defects: { area: string | null; type: string | null; severity: string | null; description: string | null }[];
  attachmentIds: string[];
  createdAt: string | null;
};

export type CustodyHop = {
  id: string;
  at: string | null;
  from: string | null;
  to: string | null;
  sealNumbers: string[];
  conditionNote: string | null;
  contentHash: string | null;
  auditLogId: number | null;
  signatures: { id: string; signerName: string; signerRole: string | null; signedAt: string }[];
};

export type AuditRef = { id: number; type: string; occurredAt: string; hash: string; actorName: string | null };

export type LineEvidence = {
  lineId: string;
  position: number;
  itemId: string | null;
  unitId: string | null;
  itemName: string | null;
  assetCode: string | null;
  jobItemId: string | null;
  jobId: string | null;
  jobCode: string | null;
  shipmentCode: string | null;
  currentStage: string | null;
  trip: {
    packedAt: string | null;
    loadedAt: string | null;
    deliveredAt: string | null;
    placedAt: string | null;
    exceptions: { stage: string; at: string }[];
    currentStage: string | null;
  } | null;
  stageHistory: {
    id: string;
    fromStage: string | null;
    toStage: string;
    label: string;
    at: string;
    via: string;
    deviceId: string | null;
    actor: string | null;
    note: string | null;
    shipmentCode: string | null;
  }[];
  conditionNotes: ConditionNote[];
  conditionReports: ConditionReport[];
  custody: CustodyHop[];
  attachments: EvidenceAttachment[];
  audit: AuditRef[];
};

export type TimelineEntry = {
  at: string;
  kind: "stage" | "condition" | "custody" | "shipment" | "claim";
  lineId: string | null;
  label: string;
  detail: string | null;
};

export type EvidencePack = {
  claimId: string;
  code: string;
  generatedAt: string;
  hash: string;
  frozen: { hash: string; at: string } | null;
  unchangedSinceSubmission: boolean | null;
  sources: { conditionReports: boolean; custody: boolean; portal: boolean };
  lines: LineEvidence[];
  claim: {
    attachments: EvidenceAttachment[];
    signatures: { id: string; signerName: string; signerRole: string | null; statement: string; signedAt: string; ownerType: string }[];
    shipment: { code: string; name: string; status: string; departedAt: string | null; arrivedAt: string | null } | null;
    audit: AuditRef[];
  };
  timeline: TimelineEntry[];
};

// --- Portal -----------------------------------------------------------------------

export type PortalView = {
  grant: { name: string | null; org: string | null; scope: string; expiresAt: string | null };
  scope: string;
  types: { type: ClaimType; label: string; description: string }[];
  lines: { jobItemId: string; itemName: string; code: string; stage: string; stageLabel: string; flagged: boolean }[];
  claims: {
    code: string;
    type: ClaimType;
    status: ClaimStatus;
    title: string;
    currency: string;
    estimatedTotalCents: number | null;
    approvedTotalCents: number | null;
    createdAt: string;
  }[];
};
