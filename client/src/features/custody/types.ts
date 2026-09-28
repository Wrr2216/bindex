/** Shapes the /api/custody endpoints return. */

export type CustodyStatus = "draft" | "locked" | "completed" | "void";
export type PartyKind = "entity" | "user" | "external";
export type Outcome = "accepted" | "missing" | "damaged" | "refused";
export type Party = "from" | "to";
export type LinkState = "none" | "active" | "used" | "expired";

export interface PurposeInfo {
  name: string;
  label: string;
  requires: Party[];
  help: string;
}

export interface CustodyMeta {
  purposes: PurposeInfo[];
  outcomes: Outcome[];
  partyKinds: PartyKind[];
}

export interface PartyInput {
  kind: PartyKind;
  entityId?: string | null;
  userOid?: string | null;
  name?: string | null;
  org?: string | null;
}

export interface TransferLine {
  id: string;
  transferId: string;
  position: number;
  itemId: string;
  unitId: string | null;
  assetCode: string;
  unitCode: string | null;
  name: string;
  via: "scan" | "contained" | "line" | "manual";
  parentItemId: string | null;
  jobItemId: string | null;
  outcome: Outcome;
  note: string | null;
  createdAt: string;
}

export interface CustodySignature {
  id: string;
  signerName: string;
  signerEmail: string | null;
  signerRole: string | null;
  statement: string;
  contentHash: string;
  signedAt: string;
  imageUrl: string | null;
}

export interface TransferSummary {
  id: string;
  code: string;
  purpose: string;
  purposeLabel: string;
  status: CustodyStatus;
  fromKind: PartyKind;
  fromEntityId: string | null;
  fromUserOid: string | null;
  fromName: string;
  fromOrg: string | null;
  toKind: PartyKind;
  toEntityId: string | null;
  toUserOid: string | null;
  toName: string;
  toOrg: string | null;
  at: string | null;
  locationId: string | null;
  locationName: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  jobId: string | null;
  jobCode: string | null;
  shipmentId: string | null;
  shipmentCode: string | null;
  sealNumbers: string[];
  conditionNote: string | null;
  notes: string | null;
  contentHash: string | null;
  lockedAt: string | null;
  fromSignatureId: string | null;
  toSignatureId: string | null;
  signing: Partial<Record<Party, { via: "device" | "link"; capturedBy: string | null }>>;
  linkParty: Party | null;
  linkExpiresAt: string | null;
  linkUsedAt: string | null;
  receiptAttachmentId: string | null;
  auditEntryId: number | null;
  auditHash: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lineCount?: number;
  exceptionCount?: number;
}

export interface TransferDetail extends TransferSummary {
  required: Party[];
  missing: Party[];
  link: { state: LinkState; party: Party | null; expiresAt: string | null };
  counted: number;
  statements: Record<Party, string>;
  lines: TransferLine[];
  signatures: CustodySignature[];
}

export interface ScanOutcome {
  added: { code: string; itemId: string; unitId: string | null; name: string; assetCode: string; contents: number }[];
  already: { code: string; name: string; assetCode: string }[];
  unknown: string[];
  ambiguous: { code: string; count: number }[];
  total: number;
}

export interface SignResponse {
  completed: boolean;
  finalized: { receiptAttachmentId: string | null; auditEntryId: number | null; error?: string } | null;
  transfer: TransferDetail;
}

export interface LineChange {
  key: string;
  before: ContentLine | null;
  after: ContentLine | null;
  fields: string[];
}

export interface ContentLine {
  itemId: string;
  unitId: string | null;
  assetCode: string;
  unitCode: string | null;
  name: string;
  via: string;
  inside: string | null;
  outcome: string;
  note: string | null;
}

export interface VerifyReport {
  transferId: string;
  code: string;
  status: CustodyStatus;
  valid: boolean;
  checkedAt: string;
  problems: string[];
  items: { storedHash: string | null; currentHash: string; matches: boolean | null };
  signatures: {
    party: Party;
    id: string;
    signerName: string | null;
    signedAt: string | null;
    valid: boolean;
    reason: string;
    signedHash: string | null;
    currentHash: string | null;
  }[];
  changes: { lines: LineChange[]; fields: string[] } | null;
  audit: {
    entryId: number | null;
    found: boolean;
    hashMatches: boolean;
    contentMatches: boolean;
    occurredAt: string | null;
    receiptSha256: string | null;
  };
  receipt: { attachmentId: string | null; sha256: string | null; intact: boolean; matchesAudit: boolean };
}

export interface ChainParty {
  kind: PartyKind;
  name: string;
  org: string | null;
}

export interface ChainEntry {
  transferId: string;
  code: string;
  status: CustodyStatus;
  purpose: string;
  purposeLabel: string;
  at: string | null;
  createdAt: string;
  from: ChainParty;
  to: ChainParty;
  place: string | null;
  lat: number | null;
  lng: number | null;
  jobCode: string | null;
  shipmentCode: string | null;
  seals: string[];
  unitCode: string | null;
  via: string;
  inside: string | null;
  outcome: Outcome;
  outcomeLabel: string;
  note: string | null;
  signatures: { party: Party; id: string; signerName: string; signedAt: string; imageUrl: string | null; via: string }[];
  hasReceipt: boolean;
  auditEntryId: number | null;
}

export interface ItemChain {
  item: { id: string; name: string; assetCode: string; parentItemId: string | null };
  controlled: boolean;
  control: { reason: string | null; setBy: string | null; setAt: string } | null;
  controlledBy: string | null;
  custodian: (ChainParty & { since: string; transferId: string }) | null;
  hops: ChainEntry[];
  pending: ChainEntry[];
}

export interface ReviewLine {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  name: string;
  sub: string | null;
  assetCode: string;
  unitCode: string | null;
  stage: string;
  crateNo: string | null;
  destination: string | null;
  picture: string | null;
  photos: { id: string; stage: string | null; caption: string | null; thumbUrl: string }[];
  controlled: boolean;
  presetOutcome: Outcome;
}

export interface ShipmentReview {
  shipment: {
    id: string;
    code: string;
    name: string;
    status: string;
    carrier: string | null;
    sealNumbers: string[];
    jobId: string;
    jobCode: string;
    jobName: string;
    vehicleName: string | null;
  };
  lines: ReviewLine[];
  deliveries: TransferSummary[];
  open: TransferDetail | null;
}

export interface AwaitingShipment {
  id: string;
  code: string;
  name: string;
  status: string;
  carrier: string | null;
  eta: string | null;
  jobId: string;
  jobCode: string;
  jobName: string;
  lines: number;
  openTransferId: string | null;
}
