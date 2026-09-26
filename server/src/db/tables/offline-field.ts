import { customType, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export type IdempotencyState = "pending" | "done";

/** Stored answers to requests sent with an Idempotency-Key. See migration 0029. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    principal: text("principal").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").$type<IdempotencyState>().default("pending").notNull(),
    status: integer("status"),
    contentType: text("content_type"),
    body: bytea("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.principal, t.key] })],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
