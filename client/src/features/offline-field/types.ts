import type {
  Assignment,
  AuthMethods,
  AppConfig,
  Company,
  Entity,
  Identifier,
  Item,
  ItemImage,
  ItemUnit,
  Location,
  User,
} from "../../types";

/**
 * An item as this device keeps it: the record plus what scanning, moving and
 * checking out need without a connection. Names of places and holders are
 * looked up when read, so renaming a location does not mean rewriting items.
 */
export type CachedItem = Item & {
  identifiers: Identifier[];
  units: ItemUnit[];
  /** Open check-outs; enough to show and change who has it. */
  assignments: Assignment[];
  images: ItemImage[];
  /** When the server produced this copy. */
  cachedAt: string;
};

/** What GET /api/offline/snapshot returns. */
export type Snapshot = {
  generatedAt: string;
  scope: { locationId: string | null; name: string };
  items: Omit<CachedItem, "cachedAt">[];
  locations: Location[];
  entities: Entity[];
  companies: Company[];
};

/** One "Make available offline" this device holds. */
export type OfflineScope = {
  /** Null for the whole instance. */
  locationId: string | null;
  name: string;
  fetchedAt: string;
  itemCount: number;
};

/** A printed or read code, pointing at the item (and unit) it belongs to. */
export type CodeRow = {
  key: string;
  code: string;
  itemId: string;
  unitId: string | null;
  /** Lower wins, mirroring the server: identifiers, item codes, unit codes, serials. */
  rank: number;
  updatedAt: string;
};

export type FieldActionType =
  | "move"
  | "checkout"
  | "checkin"
  | "spot_check"
  | "verify_apply"
  | "audit_apply"
  | "note"
  | "photo";

/** What the device believed when a change was queued. */
export type ActionBase = {
  locationId?: string | null;
  parentItemId?: string | null;
  /** Open check-out holder id, "unknown" for a deleted holder, null for none. */
  holderId?: string | null;
};

/** A change made in the field, described well enough to plan, show and apply locally. */
export type FieldAction = {
  type: FieldActionType;
  itemId?: string | null;
  unitId?: string | null;
  /** The location a verification was of. */
  locationId?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  to?: { locationId?: string | null; parentItemId?: string | null };
  seen?: boolean;
  seenIds?: string[];
  missingIds?: string[];
  text?: string;
  /** A one-line description for lists, written when queued. */
  label: string;
};

/** How to send the change again: the original request. */
export type ReplayRequest = {
  method: string;
  path: string;
  /** JSON text, exactly as first sent. */
  body?: string;
  contentType?: string;
  /** A photo waiting in the blobs store. */
  blobId?: string;
};

/**
 * pending   waiting to be sent.
 * conflict  the server changed underneath it; a person chooses.
 * rejected  the server refused it, or it failed repeatedly; a person chooses.
 */
export type QueueStatus = "pending" | "conflict" | "rejected";

export type QueuedAction = {
  /** Creation order; assigned by IndexedDB. */
  seq?: number;
  id: string;
  idempotencyKey: string;
  createdAt: string;
  userOid: string;
  userName: string;
  action: FieldAction;
  base: ActionBase | null;
  request: ReplayRequest;
  status: QueueStatus;
  /** The person chose keep-mine. */
  force?: boolean;
  attempts: number;
  lastError?: string | null;
  conflict?: {
    code: string;
    reason: string;
    canKeepMine: boolean;
    missingItemIds?: string[];
  } | null;
};

/** A change that left the queue, kept briefly so the device can show what happened. */
export type LogEntry = {
  seq?: number;
  id: string;
  label: string;
  outcome: "sent" | "skipped" | "discarded";
  note?: string | null;
  createdAt: string;
  at: string;
};

export type PlanResult =
  | { id: string; verdict: "send" }
  | { id: string; verdict: "skip"; reason: string }
  | {
      id: string;
      verdict: "conflict";
      code: string;
      reason: string;
      canKeepMine: boolean;
      missingItemIds?: string[];
    }
  | { id: string; verdict: "blocked"; reason: string; blockedBy: string }
  | { id: string; verdict: "held" };

export type LastSync = {
  at: string;
  sent: number;
  skipped: number;
  needAttention: number;
  error?: string | null;
};

export type FieldNote = {
  id: string;
  itemId: string;
  unitId: string | null;
  text: string;
  writtenAt: string;
  createdAt: string;
  userOid: string | null;
  /** Still on this device, waiting to be sent. */
  queued?: boolean;
};

/** Values kept in the meta store, by key. */
export type MetaValues = {
  device: { enabled: boolean; since: string };
  scopes: OfflineScope[];
  config: AppConfig;
  me: User;
  authMethods: AuthMethods;
  lastSync: LastSync;
};
