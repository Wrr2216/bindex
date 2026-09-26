import { and, desc, eq, isNull } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool } from "../../db/client";
import { itemUnits, items } from "../../db/schema";
import {
  serviceRecords,
  servicePlans,
  valuationProfiles,
  type HighValueMode,
  type ServicePlanRow,
  type ServiceRecordRow,
  type ValuationProfileRow,
} from "../../db/tables/valuation";
import { badRequest, notFound } from "../../lib/errors";
import { actorFromOid, publish } from "../event-backbone";
import { cleanText, latestDay, today } from "./parse";
import { serviceStatus, type ServiceStatus } from "./schedule";
import { getValuationSettings } from "./settings";

/**
 * Per-record facts that are not a value: when and where it was bought, its
 * warranty, whether it counts as high value regardless of the threshold, its
 * hour meter; and the service plans and log that run off them. An item has
 * one profile for itself and one per unit.
 */

export type ProfilePatch = {
  purchaseDate?: string | null;
  purchaseCents?: number | null;
  vendor?: string | null;
  receiptId?: string | null;
  warrantyEnds?: string | null;
  warrantyTerms?: string | null;
  warrantyProvider?: string | null;
  highValue?: HighValueMode;
  usageHours?: number | null;
};

const COLUMN: Record<keyof ProfilePatch, string> = {
  purchaseDate: "purchase_date",
  purchaseCents: "purchase_cents",
  vendor: "vendor",
  receiptId: "receipt_id",
  warrantyEnds: "warranty_ends",
  warrantyTerms: "warranty_terms",
  warrantyProvider: "warranty_provider",
  highValue: "high_value",
  usageHours: "usage_hours",
};

/** The unit's item, or 404; also checks the item exists when there is no unit. */
async function ownerItem(itemId: string, unitId: string | null): Promise<void> {
  if (unitId) {
    const [u] = await db.select({ itemId: itemUnits.itemId }).from(itemUnits).where(eq(itemUnits.id, unitId)).limit(1);
    if (!u || u.itemId !== itemId) throw notFound("That unit no longer exists, or belongs to another item.");
    return;
  }
  const [i] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!i) throw notFound("That item no longer exists.");
}

export async function getProfile(itemId: string, unitId: string | null): Promise<ValuationProfileRow | null> {
  const [row] = await db
    .select()
    .from(valuationProfiles)
    .where(and(eq(valuationProfiles.itemId, itemId), unitId ? eq(valuationProfiles.unitId, unitId) : isNull(valuationProfiles.unitId)))
    .limit(1);
  return row ?? null;
}

export async function listProfiles(itemId: string): Promise<ValuationProfileRow[]> {
  return db.select().from(valuationProfiles).where(eq(valuationProfiles.itemId, itemId));
}

/** The high-value override for a record, "auto" when it has no profile yet. */
export async function getProfileMode(itemId: string, unitId: string | null): Promise<HighValueMode> {
  return (await getProfile(itemId, unitId))?.highValue ?? "auto";
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Set some profile fields, creating the profile on first use. Fields left out
 * are untouched; null clears one.
 */
export async function upsertProfile(itemId: string, unitId: string | null, patch: ProfilePatch): Promise<ValuationProfileRow> {
  await ownerItem(itemId, unitId);
  await writeProfile(pool, itemId, unitId, patch);
  return (await getProfile(itemId, unitId))!;
}

/** upsertProfile inside a transaction the caller holds, for owners it has already checked. */
export async function upsertProfileTx(client: PoolClient, itemId: string, unitId: string | null, patch: ProfilePatch): Promise<void> {
  await writeProfile(client, itemId, unitId, patch);
}

async function writeProfile(
  executor: Pick<PoolClient, "query">,
  itemId: string,
  unitId: string | null,
  patch: ProfilePatch,
): Promise<void> {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(COLUMN) as (keyof ProfilePatch)[]) {
    if (patch[key] === undefined) continue;
    let v = patch[key] as unknown;
    if (key === "vendor" || key === "warrantyTerms" || key === "warrantyProvider") v = cleanText(v, key === "warrantyTerms" ? 1000 : 200);
    if ((key === "purchaseDate" || key === "warrantyEnds") && v !== null && !isDate(String(v))) {
      throw badRequest("Dates must be written as YYYY-MM-DD.");
    }
    if (key === "purchaseDate" && v !== null && String(v) > latestDay()) throw badRequest("The purchase date cannot be in the future.");
    if ((key === "purchaseCents" || key === "usageHours") && v !== null && (typeof v !== "number" || v < 0 || !Number.isFinite(v))) {
      throw badRequest(key === "usageHours" ? "Hours of use cannot be negative." : "The purchase price cannot be negative.");
    }
    values[COLUMN[key]] = v;
  }
  if (patch.usageHours !== undefined) values.usage_read_at = patch.usageHours === null ? null : new Date();

  const cols = Object.keys(values);
  const params: unknown[] = [itemId, unitId, ...cols.map((c) => values[c])];
  const insertCols = ["item_id", "unit_id", ...cols].join(", ");
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const updates = [...cols.map((c) => `${c} = excluded.${c}`), "updated_at = now()"].join(", ");
  // The two partial unique indexes need their own conflict targets.
  const target = unitId ? "(unit_id) WHERE unit_id IS NOT NULL" : "(item_id) WHERE unit_id IS NULL";
  await executor.query(
    `INSERT INTO valuation_profiles (${insertCols}) VALUES (${placeholders})
     ON CONFLICT ${target} DO UPDATE SET ${updates}`,
    params,
  );
}

// ---- Service plans ------------------------------------------------------------

export type ServicePlan = ServicePlanRow & { status: ServiceStatus };

export type ServicePlanInput = {
  itemId: string;
  unitId?: string | null;
  name: string;
  intervalDays?: number | null;
  intervalHours?: number | null;
  /** The last time it was done before tracking started, if known. */
  lastDoneAt?: string | null;
  lastDoneHours?: number | null;
  notes?: string | null;
  active?: boolean;
};

function checkIntervals(days: number | null | undefined, hours: number | null | undefined): void {
  if (!days && !hours) throw badRequest("Give the plan an interval: every so many days, hours of use, or both.");
  if (days != null && (!Number.isInteger(days) || days <= 0)) throw badRequest("The interval in days must be a whole number above zero.");
  if (hours != null && !(hours > 0)) throw badRequest("The interval in hours must be above zero.");
}

async function withStatus(plans: ServicePlanRow[]): Promise<ServicePlan[]> {
  if (!plans.length) return [];
  const settings = await getValuationSettings();
  const profiles = await db.select().from(valuationProfiles).where(eq(valuationProfiles.itemId, plans[0]!.itemId));
  const meter = (p: ServicePlanRow) =>
    profiles.find((x) => (x.unitId ?? null) === (p.unitId ?? null))?.usageHours ?? null;
  return plans.map((p) => ({
    ...p,
    status: serviceStatus(p, meter(p), { soonDays: settings.serviceSoonDays, soonPercent: settings.serviceSoonPercent }),
  }));
}

export async function listServicePlans(itemId: string): Promise<ServicePlan[]> {
  const plans = await db.select().from(servicePlans).where(eq(servicePlans.itemId, itemId)).orderBy(servicePlans.createdAt);
  return withStatus(plans);
}

export async function getServicePlan(id: string): Promise<ServicePlan> {
  const [plan] = await db.select().from(servicePlans).where(eq(servicePlans.id, id)).limit(1);
  if (!plan) throw notFound("That service plan no longer exists.");
  return (await withStatus([plan]))[0]!;
}

export async function createServicePlan(input: ServicePlanInput, userOid: string | null): Promise<ServicePlan> {
  const unitId = input.unitId ?? null;
  await ownerItem(input.itemId, unitId);
  const name = cleanText(input.name, 120);
  if (!name) throw badRequest("Name the service, such as \"Annual inspection\" or \"Oil change\".");
  checkIntervals(input.intervalDays, input.intervalHours);
  // A plan counted in hours starts from the meter as it reads today.
  const meter = input.intervalHours ? ((await getProfile(input.itemId, unitId))?.usageHours ?? null) : null;
  const [row] = await db
    .insert(servicePlans)
    .values({
      itemId: input.itemId,
      unitId,
      name,
      intervalDays: input.intervalDays ?? null,
      intervalHours: input.intervalHours ?? null,
      startsHours: meter,
      lastDoneAt: input.lastDoneAt ? new Date(input.lastDoneAt) : null,
      lastDoneHours: input.lastDoneHours ?? null,
      notes: cleanText(input.notes, 1000),
      active: input.active ?? true,
      createdBy: userOid,
    })
    .returning();
  return getServicePlan(row!.id);
}

export async function updateServicePlan(id: string, patch: Partial<Omit<ServicePlanInput, "itemId" | "unitId">>): Promise<ServicePlan> {
  const [existing] = await db.select().from(servicePlans).where(eq(servicePlans.id, id)).limit(1);
  if (!existing) throw notFound("That service plan no longer exists.");
  const intervalDays = patch.intervalDays === undefined ? existing.intervalDays : patch.intervalDays;
  const intervalHours = patch.intervalHours === undefined ? existing.intervalHours : patch.intervalHours;
  checkIntervals(intervalDays, intervalHours);
  const name = patch.name === undefined ? existing.name : cleanText(patch.name, 120);
  if (!name) throw badRequest("Name the service.");
  await db
    .update(servicePlans)
    .set({
      name,
      intervalDays,
      intervalHours,
      lastDoneAt: patch.lastDoneAt === undefined ? existing.lastDoneAt : patch.lastDoneAt ? new Date(patch.lastDoneAt) : null,
      lastDoneHours: patch.lastDoneHours === undefined ? existing.lastDoneHours : patch.lastDoneHours,
      notes: patch.notes === undefined ? existing.notes : cleanText(patch.notes, 1000),
      active: patch.active ?? existing.active,
      updatedAt: new Date(),
    })
    .where(eq(servicePlans.id, id));
  return getServicePlan(id);
}

export async function deleteServicePlan(id: string): Promise<void> {
  const gone = await db.delete(servicePlans).where(eq(servicePlans.id, id)).returning({ id: servicePlans.id });
  if (!gone.length) throw notFound("That service plan no longer exists.");
}

export type LogServiceInput = { doneAt?: string | null; hours?: number | null; costCents?: number | null; notes?: string | null };

/**
 * Record that a plan's service was done: a log entry, the plan's new last-done
 * point, and the hour meter when a reading was given.
 */
export async function logService(planId: string, input: LogServiceInput, userOid: string | null): Promise<ServicePlan> {
  const [plan] = await db.select().from(servicePlans).where(eq(servicePlans.id, planId)).limit(1);
  if (!plan) throw notFound("That service plan no longer exists.");
  const doneAt = input.doneAt ? new Date(input.doneAt) : new Date();
  if (Number.isNaN(doneAt.getTime())) throw badRequest("That date could not be read.");
  if (doneAt.getTime() > Date.now() + 60_000) throw badRequest("Service cannot be logged in the future.");
  if (input.hours != null && !(input.hours >= 0)) throw badRequest("Hours of use cannot be negative.");
  if (plan.intervalHours && input.hours == null) {
    throw badRequest("This plan counts hours of use. Enter the hour-meter reading at the time of service.");
  }

  await db.transaction(async (tx) => {
    await tx.insert(serviceRecords).values({
      planId: plan.id,
      itemId: plan.itemId,
      unitId: plan.unitId,
      planName: plan.name,
      doneAt,
      hours: input.hours ?? null,
      costCents: input.costCents ?? null,
      notes: cleanText(input.notes, 1000),
      doneBy: userOid,
    });
    // Logging an older visit must not move the due point backwards.
    const newer = !plan.lastDoneAt || doneAt >= plan.lastDoneAt;
    if (newer) {
      await tx
        .update(servicePlans)
        .set({ lastDoneAt: doneAt, lastDoneHours: input.hours ?? plan.lastDoneHours, alertedFor: null, updatedAt: new Date() })
        .where(eq(servicePlans.id, plan.id));
    }
  });
  if (input.hours != null) {
    const profile = await getProfile(plan.itemId, plan.unitId);
    if (profile?.usageHours == null || input.hours >= profile.usageHours) {
      await upsertProfile(plan.itemId, plan.unitId, { usageHours: input.hours });
    }
  }

  await publish(
    "service.logged",
    { planId: plan.id, name: plan.name, itemId: plan.itemId, unitId: plan.unitId, doneAt: doneAt.toISOString(), hours: input.hours ?? null },
    { actor: actorFromOid(userOid), subject: { type: "item", id: plan.itemId } },
  );
  return getServicePlan(plan.id);
}

export async function listServiceRecords(itemId: string, limit = 50): Promise<ServiceRecordRow[]> {
  return db
    .select()
    .from(serviceRecords)
    .where(eq(serviceRecords.itemId, itemId))
    .orderBy(desc(serviceRecords.doneAt))
    .limit(limit);
}
