/** Shapes of the external portal API (server/src/routes/portal.ts). */

export type PortalScopeKind = "project" | "job" | "shipment";
export type PortalRole = "viewer" | "contributor";
export type NoteCondition = "good" | "fair" | "poor" | "damaged";

export type Progress = {
  total: number;
  byStage: Record<string, number>;
  reached: { packed: number; loaded: number; delivered: number; placed: number };
  percent: { packed: number; loaded: number; delivered: number; placed: number };
  exceptions: number;
  overall: number;
  complete: boolean;
};

export type StageInfo = { name: string; label: string; kind: "progress" | "exception"; color?: string };

export type PortalSession = {
  codeRequired: boolean;
  verified: boolean;
  role: PortalRole;
  granteeName: string;
  granteeOrg: string | null;
  expiresAt: string;
  email: string | null;
  notify: boolean;
  mailAvailable: boolean;
  permissions: { values: boolean; documents: boolean };
  scope: { kind: PortalScopeKind; code: string; name: string; project: { code: string; name: string } | null } | null;
  contributor: {
    stages: StageInfo[];
    photoStages: string[];
    conditions: NoteCondition[];
    handoffStatement: string;
    shipments: { id: string; code: string; name: string; status: string }[];
  } | null;
  instance: {
    appName: string;
    orgName: string;
    accentColor: string;
    currency: string;
    locale: string;
    itemTerm: { singular: string; plural: string };
    locationTerm: { singular: string; plural: string };
  };
  stages: StageInfo[];
};

export type Milestone = {
  key: string;
  label: string;
  state: "done" | "current" | "upcoming";
  at: string | null;
  detail: string | null;
};

export type LastPosition = {
  lat: number | null;
  lng: number | null;
  place: string | null;
  at: string;
  source: "gps" | "tracking";
};

export type PortalShipment = {
  id: string;
  code: string;
  name: string;
  jobId: string;
  status: string;
  carrier: string | null;
  vehicle: string | null;
  sealNumbers: string[];
  weightKg: number | null;
  volumeM3: number | null;
  distanceKm: number | null;
  eta: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  progress: Progress;
  lastPosition: LastPosition | null;
};

export type PortalOverview = {
  scope: { kind: PortalScopeKind; code: string; name: string; project: { code: string; name: string } | null };
  jobs: {
    id: string;
    code: string;
    name: string;
    status: string;
    origin: string | null;
    destination: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }[];
  shipments: PortalShipment[];
  progress: Progress;
  milestones: Milestone[];
  updates: { at: string; title: string; kind: "status" | "location" }[];
};

export type PortalLine = {
  id: string;
  itemName: string;
  brand: string | null;
  model: string | null;
  code: string;
  assetCode: string;
  unitCode: string | null;
  unitLabel: string | null;
  stage: string;
  stageAt: string;
  shipmentId: string | null;
  shipmentCode: string | null;
  room: string | null;
  destinationLabel: string | null;
  floor: string | null;
  department: string | null;
  crateNo: string | null;
  handlingNotes: string | null;
  flags: { highValue: boolean; exception: boolean; conditionNoted: boolean; handling: boolean };
  flagged: boolean;
  valueCents?: number | null;
  noteCount: number;
  photoCount: number;
};

export type LinePage = {
  lines: PortalLine[];
  total: number;
  facets: {
    rooms: { room: string | null; progress: Progress }[];
    floors: string[];
    departments: string[];
    stages: Record<string, number>;
  };
};

export type LineFilter = {
  q?: string;
  stage?: string;
  room?: string;
  shipmentId?: string;
  flag?: "flagged" | "high_value" | "exception" | "noted";
  limit?: number;
  offset?: number;
};

export type PortalPhoto = {
  id: string;
  stage: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  byPortal: boolean;
};

export type PortalNote = {
  id: string;
  author: string;
  condition: NoteCondition | null;
  body: string;
  createdAt: string;
  mine: boolean;
};

export type LineDetail = {
  line: PortalLine;
  photos: PortalPhoto[];
  notes: PortalNote[];
  history: { from: string | null; to: string; via: string; at: string }[];
};

export type FlaggedPage = { lines: (PortalLine & { photoIds: string[] })[]; highValueThreshold: number | null };

export type PortalDocuments = {
  shared: boolean;
  documents: {
    id: string;
    kind: string;
    mime: string;
    stage: string | null;
    caption: string | null;
    filename: string | null;
    sizeBytes: number;
    createdAt: string;
    owner: string;
  }[];
  receipts: {
    id: string;
    signerName: string;
    signerRole: string | null;
    statement: string;
    contentHash: string;
    imageId: string | null;
    signedAt: string;
    owner: string;
  }[];
};

export type ScanLine = {
  id: string;
  itemName: string;
  code: string;
  assetCode: string;
  unitCode: string | null;
  stage: string;
  room: string | null;
  floor: string | null;
  crateNo: string | null;
  shipmentCode: string | null;
  scanned: string | null;
};

export type ScanResult = {
  stage: string;
  shipmentId: string | null;
  advanced: ScanLine[];
  alreadyAt: ScanLine[];
  wrongShipment: ScanLine[];
  notInScope: string[];
  unknown: string[];
  blocked: (ScanLine & { reason: string })[];
};

export type HandoffReceipt = {
  id: string;
  signerName: string;
  signerRole: string | null;
  statement: string;
  contentHash: string;
  imageId: string | null;
  signedAt: string;
  owner: string;
  lines: number;
};

// ---- Administrators ----------------------------------------------------------

export type GrantState = "active" | "revoked" | "expired" | "no_link";

export type GrantTarget = { kind: PortalScopeKind; id: string; code: string; name: string; jobCode: string | null };

export type Grant = {
  id: string;
  scope: PortalScopeKind;
  projectId: string | null;
  jobId: string | null;
  shipmentId: string | null;
  role: PortalRole;
  granteeName: string;
  granteeEmail: string | null;
  granteeOrg: string | null;
  showValues: boolean;
  showDocuments: boolean;
  allowedStages: string[] | null;
  requireCode: boolean;
  notify: boolean;
  tokenLast4: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
  useCount: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  state: GrantState;
  hasLink: boolean;
  target: GrantTarget | null;
};

export type IssuedLink = { grant: Grant; token: string; url: string; qr: string; emailed: boolean };

export type PortalStatus = {
  mailAvailable: boolean;
  trustedMode: boolean;
  baseUrl: string;
  highValue: number;
  notifyIntervalMinutes: number;
  defaultExpiryDays: number;
  maxExpiryDays: number;
  defaultStages: string[];
  stages: StageInfo[];
};

export type GrantInput = {
  scope: PortalScopeKind;
  targetId: string;
  role: PortalRole;
  granteeName: string;
  granteeEmail?: string | null;
  granteeOrg?: string | null;
  expiresAt: string;
  showValues?: boolean;
  showDocuments?: boolean;
  allowedStages?: string[] | null;
  requireCode?: boolean;
  notify?: boolean;
  note?: string | null;
};

export type GrantActivity = {
  entries: {
    id: number;
    occurredAt: string;
    type: string;
    actor: { kind: string; name: string | null };
    data: Record<string, unknown>;
  }[];
  nextBefore: number | null;
};

export type GrantNote = {
  id: string;
  author: string;
  condition: NoteCondition | null;
  body: string;
  createdAt: string;
  jobCode: string;
  itemName: string;
  assetCode: string;
  unitCode: string | null;
  stage: string;
};
