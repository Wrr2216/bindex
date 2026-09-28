import { bigint, doublePrecision, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Chain of custody. The SQL lives in migrations/0035_custody.sql; this file
 * only describes it for queries.
 */

export type CustodyStatus = "draft" | "locked" | "completed" | "void";
export type CustodyPartyKind = "entity" | "user" | "external";
export type CustodyOutcome = "accepted" | "missing" | "damaged" | "refused";
export type CustodyLineVia = "scan" | "contained" | "line" | "manual";
export type CustodyParty = "from" | "to";
export type CustodySigning = Partial<Record<CustodyParty, { via: "device" | "link"; capturedBy: string | null }>>;

export const custodyControls = pgTable("custody_controls", {
  itemId: uuid("item_id").primaryKey(),
  reason: text("reason"),
  setBy: text("set_by"),
  setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
});

export const custodyTransfers = pgTable("custody_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  purpose: text("purpose").default("handoff").notNull(),
  status: text("status").$type<CustodyStatus>().default("draft").notNull(),
  fromKind: text("from_kind").$type<CustodyPartyKind>().notNull(),
  fromEntityId: uuid("from_entity_id"),
  fromUserOid: text("from_user_oid"),
  fromName: text("from_name").notNull(),
  fromOrg: text("from_org"),
  toKind: text("to_kind").$type<CustodyPartyKind>().notNull(),
  toEntityId: uuid("to_entity_id"),
  toUserOid: text("to_user_oid"),
  toName: text("to_name").notNull(),
  toOrg: text("to_org"),
  at: timestamp("at", { withTimezone: true }),
  locationId: uuid("location_id"),
  locationName: text("location_name"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accuracyM: doublePrecision("accuracy_m"),
  jobId: uuid("job_id"),
  jobCode: text("job_code"),
  shipmentId: uuid("shipment_id"),
  shipmentCode: text("shipment_code"),
  sealNumbers: text("seal_numbers").array().default(sql`'{}'::text[]`).notNull(),
  conditionNote: text("condition_note"),
  notes: text("notes"),
  contentHash: text("content_hash"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  fromSignatureId: uuid("from_signature_id"),
  toSignatureId: uuid("to_signature_id"),
  signing: jsonb("signing").$type<CustodySigning>().default({}).notNull(),
  linkTokenHash: text("link_token_hash"),
  linkParty: text("link_party").$type<CustodyParty>(),
  linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
  linkCreatedBy: text("link_created_by"),
  linkUsedAt: timestamp("link_used_at", { withTimezone: true }),
  receiptAttachmentId: uuid("receipt_attachment_id"),
  auditEntryId: bigint("audit_entry_id", { mode: "number" }),
  auditHash: text("audit_hash"),
  voidReason: text("void_reason"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const custodyTransferItems = pgTable("custody_transfer_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  transferId: uuid("transfer_id").notNull(),
  position: integer("position").notNull(),
  itemId: uuid("item_id").notNull(),
  unitId: uuid("unit_id"),
  assetCode: text("asset_code").notNull(),
  unitCode: text("unit_code"),
  name: text("name").notNull(),
  via: text("via").$type<CustodyLineVia>().default("scan").notNull(),
  parentItemId: uuid("parent_item_id"),
  jobItemId: uuid("job_item_id"),
  outcome: text("outcome").$type<CustodyOutcome>().default("accepted").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CustodyControl = typeof custodyControls.$inferSelect;
export type CustodyTransfer = typeof custodyTransfers.$inferSelect;
export type CustodyTransferItem = typeof custodyTransferItems.$inferSelect;
