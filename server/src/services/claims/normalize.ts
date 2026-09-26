/**
 * Reading other features' rows without importing their code.
 *
 * Condition reports, custody transfers and portal grants belong to features
 * that may or may not be installed, and whose exact columns this one cannot
 * see. They are read as whole rows (`to_jsonb(t)`) and normalized here, taking
 * each field from whichever of its likely names is present and ignoring the
 * rest. A row that lacks what it needs normalizes to null and is left out,
 * rather than failing the evidence pack. Pure, and tested with fixtures.
 */

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first present, non-null value among `keys`. */
function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function uuid(v: unknown): string | null {
  const s = str(v);
  return s && UUID.test(s) ? s.toLowerCase() : null;
}

/** ISO string for a timestamp in any of the shapes jsonb or a driver produces. */
function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An array, or a JSON string holding one. */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Ids from an array of ids, or of objects carrying one. */
function ids(v: unknown, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const entry of list(v)) {
    const id = entry && typeof entry === "object" ? uuid(pick(entry as Row, ...keys)) : uuid(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function strings(v: unknown): string[] {
  return list(v)
    .map(str)
    .filter((s): s is string => s !== null);
}

// --- Condition reports ------------------------------------------------------------

export type Defect = { area: string | null; type: string | null; severity: string | null; description: string | null };

export type ConditionReport = {
  id: string;
  itemId: string | null;
  unitId: string | null;
  stage: string | null;
  rating: string | null;
  notes: string | null;
  aiNotes: string | null;
  handlingNote: string | null;
  defects: Defect[];
  attachmentIds: string[];
  createdBy: string | null;
  createdAt: string | null;
};

export function normalizeConditionReport(row: Row): ConditionReport | null {
  const id = uuid(pick(row, "id"));
  if (!id) return null;
  const defects = list(pick(row, "defects"))
    .filter((d): d is Row => Boolean(d) && typeof d === "object")
    .map((d) => ({
      area: str(pick(d, "area", "location", "part")),
      type: str(pick(d, "type", "kind")),
      severity: str(pick(d, "severity", "level")),
      description: str(pick(d, "description", "notes", "note")),
    }))
    .filter((d) => d.area || d.type || d.description);
  return {
    id,
    itemId: uuid(pick(row, "item_id", "itemId")),
    unitId: uuid(pick(row, "unit_id", "unitId")),
    stage: str(pick(row, "stage", "phase")),
    rating: str(pick(row, "rating", "condition")),
    notes: str(pick(row, "notes", "note")),
    aiNotes: str(pick(row, "ai_notes", "aiNotes")),
    handlingNote: str(pick(row, "handling_note", "handlingNote")),
    defects,
    attachmentIds: ids(pick(row, "attachment_ids", "attachmentIds", "attachments", "photo_ids"), "id", "attachmentId"),
    createdBy: str(pick(row, "created_by", "createdBy")),
    createdAt: iso(pick(row, "created_at", "createdAt", "at")),
  };
}

// --- Custody transfers ------------------------------------------------------------

export type ItemRef = { itemId: string; unitId: string | null };

export type CustodyHop = {
  id: string;
  at: string | null;
  from: string | null;
  to: string | null;
  locationId: string | null;
  lat: number | null;
  lng: number | null;
  sealNumbers: string[];
  conditionNote: string | null;
  signatureIds: string[];
  contentHash: string | null;
  auditLogId: number | null;
  items: ItemRef[];
};

/** A party as it might be stored: free text, or an object naming a person, a holder or an organisation. */
export function partyLabel(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (!s.startsWith("{")) return s || null;
    try {
      return partyLabel(JSON.parse(s));
    } catch {
      return s;
    }
  }
  if (!v || typeof v !== "object") return null;
  const p = v as Row;
  const name = str(pick(p, "name", "label", "displayName", "entityName", "userName"));
  const org = str(pick(p, "org", "organization", "organisation", "company"));
  if (name && org) return `${name} (${org})`;
  return name ?? org ?? str(pick(p, "email", "userOid", "user_oid", "entityId", "entity_id"));
}

function itemRefs(v: unknown): ItemRef[] {
  const out: ItemRef[] = [];
  for (const entry of list(v)) {
    let ref: ItemRef | null = null;
    if (entry && typeof entry === "object") {
      const e = entry as Row;
      const itemId = uuid(pick(e, "itemId", "item_id", "id"));
      if (itemId) ref = { itemId, unitId: uuid(pick(e, "unitId", "unit_id")) };
    } else {
      const itemId = uuid(entry);
      if (itemId) ref = { itemId, unitId: null };
    }
    if (ref && !out.some((r) => r.itemId === ref!.itemId && r.unitId === ref!.unitId)) out.push(ref);
  }
  return out;
}

/**
 * `extraItems` carries refs read from a separate item table, for a feature
 * that keeps the transferred items in rows of their own.
 */
export function normalizeCustodyTransfer(row: Row, extraItems: ItemRef[] = []): CustodyHop | null {
  const id = uuid(pick(row, "id"));
  if (!id) return null;
  const from = partyLabel(pick(row, "from_party", "fromParty", "from")) ??
    str(pick(row, "from_name", "fromName", "from_label", "from_org"));
  const to = partyLabel(pick(row, "to_party", "toParty", "to")) ?? str(pick(row, "to_name", "toName", "to_label", "to_org"));
  const signatureIds = [
    ...ids(pick(row, "signature_ids", "signatureIds")),
    ...[
      pick(row, "from_signature_id", "fromSignatureId"),
      pick(row, "to_signature_id", "toSignatureId"),
    ]
      .map(uuid)
      .filter((s): s is string => s !== null),
  ];
  const items = itemRefs(pick(row, "items", "item_refs", "itemRefs"));
  for (const r of [...itemRefs(pick(row, "item_ids", "itemIds")), ...extraItems]) {
    if (!items.some((i) => i.itemId === r.itemId && i.unitId === r.unitId)) items.push(r);
  }
  return {
    id,
    at: iso(pick(row, "at", "transferred_at", "transferredAt", "created_at", "createdAt")),
    from,
    to,
    locationId: uuid(pick(row, "place_location_id", "location_id", "placeLocationId", "locationId")),
    lat: num(pick(row, "lat", "latitude")),
    lng: num(pick(row, "lng", "lon", "longitude")),
    sealNumbers: strings(pick(row, "seal_numbers", "sealNumbers", "seals")),
    conditionNote: str(pick(row, "condition_note", "conditionNote", "note", "notes")),
    signatureIds: [...new Set(signatureIds)],
    contentHash: str(pick(row, "content_hash", "contentHash")),
    auditLogId: num(pick(row, "audit_log_id", "auditLogId")),
    items,
  };
}

/**
 * Whether a transfer moved this item. A transfer of the whole item covers each
 * of its units, and a transfer of one unit counts for a claim on the item.
 */
export function hopCovers(hop: CustodyHop, ref: ItemRef): boolean {
  return hop.items.some(
    (i) => i.itemId === ref.itemId && (i.unitId === null || ref.unitId === null || i.unitId === ref.unitId),
  );
}

// --- Portal grants --------------------------------------------------------------

export type PortalGrant = {
  id: string;
  scope: "project" | "job" | "shipment" | null;
  scopeId: string | null;
  role: string | null;
  name: string | null;
  email: string | null;
  org: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

const SCOPES = ["project", "job", "shipment"] as const;

export function normalizePortalGrant(row: Row): PortalGrant | null {
  const id = uuid(pick(row, "id"));
  if (!id) return null;
  const rawScope = str(pick(row, "scope", "scope_type", "scopeType"))?.toLowerCase() ?? null;
  let scope = (SCOPES as readonly string[]).includes(rawScope ?? "") ? (rawScope as PortalGrant["scope"]) : null;
  let scopeId = uuid(pick(row, "scope_id", "scopeId"));
  // A grant may instead carry one id column per scope. Without a scope
  // column, the narrowest id present is the one it was granted on.
  if (!scopeId) {
    for (const s of scope ? [scope] : ([...SCOPES].reverse() as NonNullable<PortalGrant["scope"]>[])) {
      const v = uuid(pick(row, `${s}_id`, `${s}Id`));
      if (v) {
        scope = s;
        scopeId = v;
        break;
      }
    }
  }
  return {
    id,
    scope,
    scopeId,
    role: str(pick(row, "role"))?.toLowerCase() ?? null,
    name: str(pick(row, "grantee_name", "granteeName", "name")),
    email: str(pick(row, "grantee_email", "granteeEmail", "email")),
    org: str(pick(row, "grantee_org", "granteeOrg", "org", "organization")),
    expiresAt: iso(pick(row, "expires_at", "expiresAt")),
    revokedAt: iso(pick(row, "revoked_at", "revokedAt")),
  };
}

export type GrantCheck = { ok: true } | { ok: false; reason: "revoked" | "expired" | "scope" };

/**
 * A grant a claim can be filed through: live, and scoped to one shipment or
 * one job. A project-wide grant is refused, because a claim has to say which
 * delivery it is about.
 */
export function grantUsable(grant: PortalGrant, now: Date): GrantCheck {
  if (grant.revokedAt) return { ok: false, reason: "revoked" };
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if ((grant.scope !== "shipment" && grant.scope !== "job") || !grant.scopeId) return { ok: false, reason: "scope" };
  return { ok: true };
}
