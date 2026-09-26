import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  itemUnits,
  items,
  locations,
  trackingDevices,
  type TrackingDevice,
  type TrackingDeviceKind,
} from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { hashKey } from "../apiKeys";
import { REPORTING_KINDS } from "./types";

/**
 * The device registry: readers, portals, gateways, beacons, tags and trackers.
 *
 * Tokens work like API keys: only a SHA-256 hash is stored and the token is
 * returned once, when it is issued or rotated.
 */

/** What clients see. The token hash never leaves this module. */
export type DeviceView = Omit<TrackingDevice, "tokenHash"> & {
  hasToken: boolean;
  locationName: string | null;
  itemName: string | null;
  itemAssetCode: string | null;
  unitLabel: string | null;
  unitAssetCode: string | null;
};

export type DeviceInput = {
  kind: TrackingDeviceKind;
  name: string;
  externalId?: string | null;
  locationId?: string | null;
  itemId?: string | null;
  unitId?: string | null;
  updatesLocation?: boolean;
  settings?: Record<string, unknown>;
  disabled?: boolean;
};

/** The `bdt_` prefix makes a leaked device token recognisable. */
export const generateDeviceToken = (): string => `bdt_${randomBytes(24).toString("base64url")}`;

/**
 * The live-feed channel a device's reads are pushed to: its external id when
 * it has one (so a bridge's READER_ID keeps naming its channel), else its id.
 */
export const channelOf = (device: Pick<TrackingDevice, "id" | "externalId">): string =>
  device.externalId || device.id;

const clean = (s: string | null | undefined) => (s === undefined ? undefined : s?.trim() || null);

async function views(rows: TrackingDevice[]): Promise<DeviceView[]> {
  const locIds = [...new Set(rows.map((r) => r.locationId).filter((v): v is string => !!v))];
  const itemIds = [...new Set(rows.map((r) => r.itemId).filter((v): v is string => !!v))];
  const unitIds = [...new Set(rows.map((r) => r.unitId).filter((v): v is string => !!v))];
  const [locs, its, units] = await Promise.all([
    locIds.length
      ? db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, locIds))
      : [],
    itemIds.length
      ? db
          .select({ id: items.id, name: items.name, assetCode: items.assetCode })
          .from(items)
          .where(inArray(items.id, itemIds))
      : [],
    unitIds.length
      ? db
          .select({ id: itemUnits.id, label: itemUnits.label, assetCode: itemUnits.assetCode })
          .from(itemUnits)
          .where(inArray(itemUnits.id, unitIds))
      : [],
  ]);
  const locName = new Map(locs.map((l) => [l.id, l.name]));
  const item = new Map(its.map((i) => [i.id, i]));
  const unit = new Map(units.map((u) => [u.id, u]));
  return rows.map(({ tokenHash, ...row }) => ({
    ...row,
    hasToken: Boolean(tokenHash),
    locationName: row.locationId ? (locName.get(row.locationId) ?? null) : null,
    itemName: row.itemId ? (item.get(row.itemId)?.name ?? null) : null,
    itemAssetCode: row.itemId ? (item.get(row.itemId)?.assetCode ?? null) : null,
    unitLabel: row.unitId ? (unit.get(row.unitId)?.label ?? null) : null,
    unitAssetCode: row.unitId ? (unit.get(row.unitId)?.assetCode ?? null) : null,
  }));
}

export async function listDevices(filter: { kinds?: TrackingDeviceKind[] } = {}): Promise<DeviceView[]> {
  const rows = await db
    .select()
    .from(trackingDevices)
    .where(filter.kinds?.length ? inArray(trackingDevices.kind, filter.kinds) : undefined)
    .orderBy(asc(trackingDevices.name));
  return views(rows);
}

/** The full row, for services. Throws a 404 when it does not exist. */
export async function getDeviceRow(id: string): Promise<TrackingDevice> {
  const [row] = await db.select().from(trackingDevices).where(eq(trackingDevices.id, id)).limit(1);
  if (!row) throw notFound("Device not found");
  return row;
}

export async function getDevice(id: string): Promise<DeviceView> {
  return (await views([await getDeviceRow(id)]))[0]!;
}

/**
 * Check that an attachment makes sense and fill in the item from the unit, so
 * a caller can attach to a unit by its id alone.
 */
async function resolveAttachment(
  itemId: string | null | undefined,
  unitId: string | null | undefined,
): Promise<{ itemId: string | null | undefined; unitId: string | null | undefined }> {
  if (!unitId) return { itemId, unitId };
  const [unit] = await db
    .select({ itemId: itemUnits.itemId })
    .from(itemUnits)
    .where(eq(itemUnits.id, unitId))
    .limit(1);
  if (!unit) throw badRequest("That unit does not exist. Pick the unit again.");
  if (itemId && itemId !== unit.itemId) {
    throw badRequest("That unit belongs to a different item. Pick the item first, then one of its units.");
  }
  return { itemId: unit.itemId, unitId };
}

/** Map database errors to something a person can act on. */
function explain(err: unknown, kind?: string): never {
  if (isUniqueViolation(err, "uq_tracking_devices_kind_external")) {
    throw conflict(`Another ${kind ?? "device"} is already registered with that serial or id.`);
  }
  for (let cur: unknown = err, depth = 0; cur && depth < 10; depth++) {
    if ((cur as { code?: string }).code === "23503") {
      throw badRequest("The zone or asset picked no longer exists. Pick it again.");
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  throw err;
}

/**
 * Register a device. Kinds that post reads get an ingest token unless
 * `issueToken` is false; the token is in the result and nowhere else.
 */
export async function createDevice(
  input: DeviceInput,
  opts: { issueToken?: boolean } = {},
): Promise<{ device: DeviceView; token: string | null }> {
  const attach = await resolveAttachment(input.itemId, input.unitId);
  const issue = opts.issueToken ?? REPORTING_KINDS.includes(input.kind);
  const token = issue ? generateDeviceToken() : null;
  try {
    const [row] = await db
      .insert(trackingDevices)
      .values({
        kind: input.kind,
        name: input.name.trim(),
        externalId: clean(input.externalId) ?? null,
        locationId: input.locationId ?? null,
        itemId: attach.itemId ?? null,
        unitId: attach.unitId ?? null,
        updatesLocation: input.updatesLocation ?? false,
        settings: input.settings ?? {},
        disabled: input.disabled ?? false,
        tokenHash: token ? hashKey(token) : null,
        tokenLast4: token ? token.slice(-4) : null,
      })
      .returning();
    logger.info("tracking.device.created", { id: row!.id, kind: row!.kind });
    return { device: (await views([row!]))[0]!, token };
  } catch (err) {
    explain(err, input.kind);
  }
}

export async function updateDevice(id: string, patch: Partial<DeviceInput>): Promise<DeviceView> {
  const existing = await getDeviceRow(id);
  const itemId = patch.itemId === undefined ? existing.itemId : patch.itemId;
  // Detaching from an item also detaches from its unit.
  let unitId = patch.unitId === undefined ? existing.unitId : patch.unitId;
  if (patch.itemId !== undefined && patch.unitId === undefined && itemId !== existing.itemId) unitId = null;
  const attach = await resolveAttachment(itemId, unitId);

  const set: Partial<typeof trackingDevices.$inferInsert> = { updatedAt: new Date() };
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.externalId !== undefined) set.externalId = clean(patch.externalId) ?? null;
  if (patch.locationId !== undefined) set.locationId = patch.locationId;
  set.itemId = attach.itemId ?? null;
  set.unitId = attach.unitId ?? null;
  if (patch.updatesLocation !== undefined) set.updatesLocation = patch.updatesLocation;
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;

  try {
    const [row] = await db.update(trackingDevices).set(set).where(eq(trackingDevices.id, id)).returning();
    if (!row) throw notFound("Device not found");
    return (await views([row]))[0]!;
  } catch (err) {
    explain(err, patch.kind ?? existing.kind);
  }
}

export async function deleteDevice(id: string): Promise<void> {
  const rows = await db.delete(trackingDevices).where(eq(trackingDevices.id, id)).returning({ id: trackingDevices.id });
  if (!rows.length) throw notFound("Device not found");
  logger.info("tracking.device.deleted", { id });
}

/** Issue a new token, invalidating the old one immediately. */
export async function rotateDeviceToken(id: string): Promise<{ device: DeviceView; token: string }> {
  const token = generateDeviceToken();
  const [row] = await db
    .update(trackingDevices)
    .set({ tokenHash: hashKey(token), tokenLast4: token.slice(-4), updatedAt: new Date() })
    .where(eq(trackingDevices.id, id))
    .returning();
  if (!row) throw notFound("Device not found");
  logger.info("tracking.device.token_rotated", { id });
  return { device: (await views([row]))[0]!, token };
}

/** Remove a device's token, so it can only post again after a rotation. */
export async function revokeDeviceToken(id: string): Promise<DeviceView> {
  const [row] = await db
    .update(trackingDevices)
    .set({ tokenHash: null, tokenLast4: null, updatedAt: new Date() })
    .where(eq(trackingDevices.id, id))
    .returning();
  if (!row) throw notFound("Device not found");
  return (await views([row]))[0]!;
}

export async function findDeviceByToken(token: string): Promise<TrackingDevice | null> {
  const [row] = await db
    .select()
    .from(trackingDevices)
    .where(eq(trackingDevices.tokenHash, hashKey(token)))
    .limit(1);
  return row ?? null;
}

/** Whether any device has its own token, which decides 401 versus 503. */
export async function anyDeviceTokens(): Promise<boolean> {
  const [row] = await db
    .select({ id: trackingDevices.id })
    .from(trackingDevices)
    .where(isNotNull(trackingDevices.tokenHash))
    .limit(1);
  return Boolean(row);
}

/**
 * The device behind a post authenticated with the shared INGEST_TOKEN: the
 * one whose external id is the reader id in the payload, among the kinds the
 * endpoint accepts, or a new rfid_reader when there is none. This is what lets
 * an existing bridge keep working with no registration step.
 */
export async function findOrCreateIngestDevice(
  readerId: string,
  kinds: readonly TrackingDeviceKind[],
): Promise<TrackingDevice> {
  const externalId = readerId.trim().slice(0, 200) || "default";
  const find = () =>
    db
      .select()
      .from(trackingDevices)
      .where(
        and(
          eq(trackingDevices.externalId, externalId),
          kinds.length ? inArray(trackingDevices.kind, [...kinds]) : undefined,
        ),
      )
      .orderBy(asc(trackingDevices.createdAt))
      .limit(1);

  const [found] = await find();
  if (found) return found;

  const [created] = await db
    .insert(trackingDevices)
    .values({ kind: "rfid_reader", name: externalId, externalId })
    .onConflictDoNothing()
    .returning();
  if (created) {
    logger.info("tracking.device.auto_created", { id: created.id, externalId });
    return created;
  }
  // Lost a race with a concurrent post from the same reader.
  const [raced] = await find();
  if (raced) return raced;
  const [byKind] = await db
    .select()
    .from(trackingDevices)
    .where(and(eq(trackingDevices.kind, "rfid_reader"), eq(trackingDevices.externalId, externalId)))
    .limit(1);
  if (!byKind) throw new Error(`Could not register reader ${externalId}`);
  return byKind;
}

/**
 * Record that a device reported in, with whatever status it sent. Other
 * features call this for a tag or tracker whose status arrives through a
 * different device (a BLE tag's battery heard by a gateway).
 */
export async function updateDeviceStatus(
  id: string,
  status: { seenAt?: Date; batteryPct?: number | null; lat?: number | null; lng?: number | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  // A late batch must not wind the clock back.
  if (status.seenAt) {
    set.lastSeenAt = sql`GREATEST(COALESCE(${trackingDevices.lastSeenAt}, ${status.seenAt}::timestamptz), ${status.seenAt}::timestamptz)`;
  }
  if (typeof status.batteryPct === "number" && Number.isFinite(status.batteryPct)) {
    set.batteryPct = Math.round(Math.min(100, Math.max(0, status.batteryPct)));
  }
  if (typeof status.lat === "number" && typeof status.lng === "number") {
    set.lastLat = status.lat;
    set.lastLng = status.lng;
  }
  if (!Object.keys(set).length) return;
  await db.update(trackingDevices).set(set).where(eq(trackingDevices.id, id));
}
