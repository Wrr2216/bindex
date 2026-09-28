/** Shapes returned by /api/audit-log, /api/webhooks and /api/events. */

export type ActorKind = "user" | "api_key" | "device" | "system";

export interface AuditEntry {
  id: number;
  occurredAt: string;
  actor: { kind: ActorKind; id: string | null; name: string | null };
  type: string;
  subject: { type: string; id: string } | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextBefore: number | null;
}

export interface AuditFilters {
  type?: string;
  subjectType?: string;
  subjectId?: string;
  actor?: string;
  from?: string;
  to?: string;
}

export interface AuditStatus {
  count: number;
  head: { id: number; hash: string; occurredAt: string } | null;
  firstId: number | null;
  lastCheckpoint: { id: number; occurredAt: string; headId: number; count: number } | null;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstBrokenId: number | null;
  reason: string | null;
  head: { id: number; hash: string } | null;
  anchor: { id: number; archivedHeadId: number; archivedHeadHash: string; archivedCount: number } | null;
  checkpoints: { checked: number; invalid: number[]; unknownKey: number[] };
}

export interface EventTypeInfo {
  type: string;
  description: string;
  subject?: string;
  group?: string;
}

export type DeliveryStatus = "pending" | "succeeded" | "failed" | "dead";

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  eventPatterns: string[];
  active: boolean;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
  secretHint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deliveries: {
    pending: number;
    retrying: number;
    dead: number;
    last: { status: DeliveryStatus; responseStatus: number | null; at: string } | null;
  };
}

export interface WebhookEndpointInput {
  url: string;
  description?: string;
  eventPatterns: string[];
  active?: boolean;
}

export interface WebhookDelivery {
  id: number;
  endpointId: string;
  auditLogId: number | null;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseMs: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
