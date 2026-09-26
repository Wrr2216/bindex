import { createHash } from "node:crypto";
import { pool } from "../../db/client";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import {
  hopCovers,
  hopHappened,
  normalizeConditionReport,
  normalizeContainerCapture,
  normalizeCustodyTransfer,
  normalizePortalGrant,
  type ConditionReport,
  type CustodyHop,
  type ItemRef,
  type PackList,
  type PortalGrant,
} from "./normalize";

/**
 * Evidence from features that may not be installed: condition reports,
 * custody transfers and portal grants. Each is found by looking for its table
 * at the time of the request, never by importing its code, so this feature
 * works the same with or without them and picks them up as soon as their
 * migrations have run.
 *
 * Column names below are only ever the constants in this file, checked against
 * the catalog before use; nothing a request sends is interpolated.
 */

const TABLES = [
  "condition_reports",
  "container_captures",
  "custody_transfers",
  "custody_transfer_items",
  "portal_grants",
] as const;
type OptionalTable = (typeof TABLES)[number];

export type Shapes = Map<OptionalTable, Set<string>>;

/** Which optional tables exist, and their columns. One catalog query. */
export async function detectShapes(): Promise<Shapes> {
  const { rows } = await pool.query<{ table_name: OptionalTable; column_name: string }>(
    `SELECT t.name AS table_name, a.attname AS column_name
       FROM unnest($1::text[]) AS t(name)
       JOIN pg_attribute a ON a.attrelid = to_regclass(t.name)
      WHERE a.attnum > 0 AND NOT a.attisdropped`,
    [TABLES],
  );
  const shapes: Shapes = new Map();
  for (const r of rows) {
    if (!shapes.has(r.table_name)) shapes.set(r.table_name, new Set());
    shapes.get(r.table_name)!.add(r.column_name);
  }
  return shapes;
}

export type SourceAvailability = {
  /** Condition reports (before/after ratings, defects, handling notes). */
  conditionReports: boolean;
  /** Container pack lists: what went into a box, and what was written on it. */
  packLists: boolean;
  /** Custody transfers (who handed what to whom, with seals and signatures). */
  custody: boolean;
  /** Portal grants, through which an outside party can file a claim. */
  portal: boolean;
};

export function availability(shapes: Shapes): SourceAvailability {
  return {
    conditionReports: Boolean(shapes.get("condition_reports")?.has("item_id")),
    packLists: Boolean(shapes.get("container_captures")?.has("item_id")),
    custody: custodyPlan(shapes) !== null,
    portal: Boolean(shapes.get("portal_grants")?.has("token_hash")),
  };
}

const firstOf = (cols: Set<string> | undefined, ...names: string[]) => names.find((n) => cols?.has(n)) ?? null;

// Each source's shape problem is logged once per process, not on every claim.
const warned = new Set<string>();
function warnOnce(event: string, meta: Record<string, unknown>) {
  const key = `${event}:${JSON.stringify(meta)}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(event, meta);
}

export type SourceResult<T> = { available: boolean; rows: T[] };

// --- Condition reports ----------------------------------------------------------

export async function conditionReportsFor(
  shapes: Shapes,
  itemIds: readonly string[],
): Promise<SourceResult<ConditionReport>> {
  const cols = shapes.get("condition_reports");
  if (!cols) return { available: false, rows: [] };
  if (!cols.has("item_id")) {
    warnOnce("claims.evidence.source_unreadable", { table: "condition_reports", missing: "item_id" });
    return { available: false, rows: [] };
  }
  if (itemIds.length === 0) return { available: true, rows: [] };
  const order = firstOf(cols, "created_at", "at");
  try {
    const { rows } = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(c) AS row FROM condition_reports c
        WHERE c.item_id = ANY($1::uuid[])
        ORDER BY ${order ? `c.${order}, ` : ""}c.id
        LIMIT 5000`,
      [itemIds],
    );
    return {
      available: true,
      rows: rows.map((r) => normalizeConditionReport(r.row)).filter((r): r is ConditionReport => r !== null),
    };
  } catch (err) {
    warnOnce("claims.evidence.source_failed", { table: "condition_reports", err: describeError(err) });
    return { available: false, rows: [] };
  }
}

// --- Container pack lists ---------------------------------------------------------------

export async function packListsFor(shapes: Shapes, itemIds: readonly string[]): Promise<SourceResult<PackList>> {
  const cols = shapes.get("container_captures");
  if (!cols?.has("item_id")) return { available: false, rows: [] };
  if (itemIds.length === 0) return { available: true, rows: [] };
  const order = cols.has("created_at") ? "c.created_at, " : "";
  try {
    const { rows } = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(c) AS row FROM container_captures c
        WHERE c.item_id = ANY($1::uuid[])
        ORDER BY ${order}c.id
        LIMIT 2000`,
      [itemIds],
    );
    return {
      available: true,
      rows: rows.map((r) => normalizeContainerCapture(r.row)).filter((r): r is PackList => r !== null),
    };
  } catch (err) {
    warnOnce("claims.evidence.source_failed", { table: "container_captures", err: describeError(err) });
    return { available: false, rows: [] };
  }
}

// --- Custody transfers ------------------------------------------------------------

type CustodyPlan =
  | { kind: "child"; fk: string; hasUnit: boolean; hasOutcome: boolean; hasNote: boolean; order: string | null }
  | { kind: "column"; column: string; order: string | null };

/**
 * How transferred items are stored: rows in custody_transfer_items, or a
 * list column on the transfer itself. Null when neither is recognisable.
 */
function custodyPlan(shapes: Shapes): CustodyPlan | null {
  const cols = shapes.get("custody_transfers");
  if (!cols) return null;
  const order = firstOf(cols, "at", "transferred_at", "created_at");
  const child = shapes.get("custody_transfer_items");
  const fk = firstOf(child, "transfer_id", "custody_transfer_id");
  if (child && fk && child.has("item_id")) {
    return { kind: "child", fk, hasUnit: child.has("unit_id"), hasOutcome: child.has("outcome"), hasNote: child.has("note"), order };
  }
  const column = firstOf(cols, "items", "item_ids", "item_refs");
  if (column) return { kind: "column", column, order };
  warnOnce("claims.evidence.source_unreadable", { table: "custody_transfers", missing: "items" });
  return null;
}

export async function custodyHopsFor(shapes: Shapes, refs: readonly ItemRef[]): Promise<SourceResult<CustodyHop>> {
  const plan = custodyPlan(shapes);
  if (!plan) return { available: false, rows: [] };
  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  if (itemIds.length === 0) return { available: true, rows: [] };
  const order = plan.order ? `ORDER BY t.${plan.order}, t.id` : "ORDER BY t.id";
  try {
    let rows: { row: Record<string, unknown>; items: unknown }[];
    if (plan.kind === "child") {
      ({ rows } = await pool.query(
        `SELECT to_jsonb(t) AS row,
                (SELECT jsonb_agg(jsonb_build_object('itemId', i.item_id, 'unitId', ${plan.hasUnit ? "i.unit_id" : "NULL"},
                                                     'outcome', ${plan.hasOutcome ? "i.outcome" : "NULL"},
                                                     'note', ${plan.hasNote ? "i.note" : "NULL"}))
                   FROM custody_transfer_items i WHERE i.${plan.fk} = t.id) AS items
           FROM custody_transfers t
          WHERE EXISTS (SELECT 1 FROM custody_transfer_items i WHERE i.${plan.fk} = t.id AND i.item_id = ANY($1::uuid[]))
          ${order} LIMIT 2000`,
        [itemIds],
      ));
    } else {
      // Whatever the column's type (jsonb, uuid[], text), an item id appears
      // in its text form exactly when the item is on the transfer. The
      // normalizer then reads the list properly and matches units.
      ({ rows } = await pool.query(
        `SELECT to_jsonb(t) AS row, NULL AS items
           FROM custody_transfers t
          WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS x(id) WHERE position(x.id IN lower(t.${plan.column}::text)) > 0)
          ${order} LIMIT 2000`,
        [itemIds],
      ));
    }
    const hops = rows
      .map((r) => {
        const extra = Array.isArray(r.items)
          ? (r.items as { itemId: string; unitId: string | null; outcome?: string | null; note?: string | null }[]).map((i) => ({
              itemId: i.itemId,
              unitId: i.unitId ?? null,
              outcome: i.outcome ?? null,
              note: i.note ?? null,
            }))
          : [];
        return normalizeCustodyTransfer(r.row, extra);
      })
      .filter((h): h is CustodyHop => h !== null && hopHappened(h) && refs.some((ref) => hopCovers(h, ref)));
    return { available: true, rows: hops };
  } catch (err) {
    warnOnce("claims.evidence.source_failed", { table: "custody_transfers", err: describeError(err) });
    return { available: false, rows: [] };
  }
}

// --- Portal grants ----------------------------------------------------------------

/** Portal tokens are stored as the sha256 of the token, like API keys and device tokens. */
export const hashPortalToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * The grant a portal token belongs to, or null when there is no portal, no
 * such token, or the grant cannot be read. Callers decide whether it is still
 * usable (grantUsable), so an expired link can be told apart from a wrong one.
 */
export async function findPortalGrant(token: string): Promise<PortalGrant | null> {
  const shapes = await detectShapes();
  const cols = shapes.get("portal_grants");
  if (!cols?.has("token_hash")) return null;
  try {
    const { rows } = await pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(g) AS row FROM portal_grants g WHERE g.token_hash = $1 LIMIT 1",
      [hashPortalToken(token)],
    );
    const grant = rows[0] ? normalizePortalGrant(rows[0].row) : null;
    if (grant && cols.has("last_used_at")) {
      await pool.query("UPDATE portal_grants SET last_used_at = now() WHERE id = $1", [grant.id]);
    }
    return grant;
  } catch (err) {
    warnOnce("claims.portal.grant_unreadable", { err: describeError(err) });
    return null;
  }
}

export async function portalAvailable(): Promise<boolean> {
  return availability(await detectShapes()).portal;
}
