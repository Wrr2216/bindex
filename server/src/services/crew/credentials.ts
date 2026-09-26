import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  attachments,
  crewCredentialTypes,
  crewCredentials,
  crewWorkers,
  type CredentialStatus,
  type CrewCredential,
  type CrewCredentialType,
} from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { credentialTypesByKey, getCredentialType } from "./credentialTypes";
import { crewEvent } from "./events";
import { addMonths, isDateOnly, type CredentialFacts, type VerifiedCredential } from "./model";
import { clean, type CrewActor } from "./shared";

/**
 * What a worker holds. Renewals are new rows rather than edits, so the history
 * of a licence stays; compliance looks at the best one (model.ts). Rows written
 * by the external verifier are one per worker and type and are refreshed by it.
 */

export type CredentialInput = {
  typeId?: string;
  typeKey?: string;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  /** Null: does not expire. Left out: worked out from the issue date and the type's validity. */
  expiresOn?: string | null;
  status?: CredentialStatus;
  notes?: string | null;
};

export type CredentialRow = CrewCredential & {
  typeKey: string;
  typeName: string;
  warnDays: number;
  typeActive: boolean;
  documentCount: number;
};

export const asFacts = (c: CredentialRow): CredentialFacts => ({
  id: c.id,
  typeKey: c.typeKey,
  status: c.status,
  expiresOn: c.expiresOn,
  issuedOn: c.issuedOn,
  source: c.source,
  number: c.number,
});

/** Every credential of these workers, newest first, with its type and document count. */
export async function credentialsForWorkers(workerIds: string[]): Promise<Map<string, CredentialRow[]>> {
  const out = new Map<string, CredentialRow[]>(workerIds.map((id) => [id, []]));
  if (workerIds.length === 0) return out;
  const rows = await db
    .select({
      ...getTableColumns(crewCredentials),
      typeKey: crewCredentialTypes.key,
      typeName: crewCredentialTypes.name,
      warnDays: crewCredentialTypes.warnDays,
      typeActive: crewCredentialTypes.active,
    })
    .from(crewCredentials)
    .innerJoin(crewCredentialTypes, eq(crewCredentials.typeId, crewCredentialTypes.id))
    .where(inArray(crewCredentials.workerId, workerIds))
    .orderBy(asc(crewCredentialTypes.name), desc(crewCredentials.expiresOn), desc(crewCredentials.createdAt));
  const docs = new Map<string, number>();
  if (rows.length) {
    const counts = await db
      .select({ ownerId: attachments.ownerId, n: sql<number>`count(*)::int` })
      .from(attachments)
      .where(
        and(
          eq(attachments.ownerType, "crew_credential"),
          inArray(
            attachments.ownerId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(attachments.ownerId);
    for (const c of counts) docs.set(c.ownerId, c.n);
  }
  for (const r of rows) out.get(r.workerId)?.push({ ...r, documentCount: docs.get(r.id) ?? 0 });
  return out;
}

async function loadCredential(id: string): Promise<CrewCredential> {
  const [row] = await db.select().from(crewCredentials).where(eq(crewCredentials.id, id)).limit(1);
  if (!row) throw notFound("Credential not found");
  return row;
}

async function resolveType(input: Pick<CredentialInput, "typeId" | "typeKey">): Promise<CrewCredentialType> {
  if (input.typeId) return getCredentialType(input.typeId);
  if (input.typeKey) {
    const type = (await credentialTypesByKey()).get(input.typeKey.trim());
    if (!type) throw badRequest(`There is no credential type "${input.typeKey}". Pick one from the list, or add it in Settings.`);
    return type;
  }
  throw badRequest("Say which kind of credential this is (typeId or typeKey).");
}

function checkDate(value: string | null | undefined, what: string): void {
  if (value && !isDateOnly(value)) throw badRequest(`${what} must be a date such as 2027-03-31.`);
}

function checkOrder(issuedOn: string | null, expiresOn: string | null): void {
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    throw badRequest("The expiry date is before the issue date. Check the dates.");
  }
}

export async function addCredential(workerId: string, input: CredentialInput, actor: CrewActor): Promise<CrewCredential> {
  const [worker] = await db.select({ id: crewWorkers.id }).from(crewWorkers).where(eq(crewWorkers.id, workerId)).limit(1);
  if (!worker) throw notFound("Worker not found");
  const type = await resolveType(input);
  checkDate(input.issuedOn, "The issue date");
  checkDate(input.expiresOn, "The expiry date");
  const issuedOn = input.issuedOn ?? null;
  let expiresOn = input.expiresOn === undefined ? null : input.expiresOn;
  if (input.expiresOn === undefined && issuedOn && type.validityMonths) expiresOn = addMonths(issuedOn, type.validityMonths);
  checkOrder(issuedOn, expiresOn);
  const [row] = await db
    .insert(crewCredentials)
    .values({
      workerId,
      typeId: type.id,
      issuer: clean(input.issuer),
      number: clean(input.number),
      issuedOn,
      expiresOn,
      status: input.status ?? "valid",
      source: "manual",
      notes: clean(input.notes),
      createdBy: actor.userOid,
      updatedBy: actor.userOid,
    })
    .returning();
  await crewEvent(
    "crew.credential_changed",
    { action: "added", workerId, credentialId: row!.id, type: type.key, status: row!.status, expiresOn: row!.expiresOn, source: "manual" },
    actor,
    { type: "crew_worker", id: workerId },
  );
  return row!;
}

export async function updateCredential(
  id: string,
  patch: Omit<CredentialInput, "typeId" | "typeKey">,
  actor: CrewActor,
): Promise<CrewCredential> {
  const current = await loadCredential(id);
  const touchesFacts = (["issuer", "number", "issuedOn", "expiresOn", "status"] as const).some((k) => patch[k] !== undefined);
  if (current.source === "verifier" && touchesFacts) {
    throw badRequest(
      "This credential comes from the external verifier and is refreshed on every check. Add a credential by hand instead, or delete this one.",
    );
  }
  checkDate(patch.issuedOn, "The issue date");
  checkDate(patch.expiresOn, "The expiry date");
  const set: Partial<typeof crewCredentials.$inferInsert> = { updatedAt: new Date(), updatedBy: actor.userOid };
  if (patch.issuer !== undefined) set.issuer = clean(patch.issuer);
  if (patch.number !== undefined) set.number = clean(patch.number);
  if (patch.issuedOn !== undefined) set.issuedOn = patch.issuedOn;
  if (patch.expiresOn !== undefined) set.expiresOn = patch.expiresOn;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.notes !== undefined) set.notes = clean(patch.notes);
  checkOrder(
    set.issuedOn !== undefined ? set.issuedOn : current.issuedOn,
    set.expiresOn !== undefined ? set.expiresOn : current.expiresOn,
  );
  const [row] = await db.update(crewCredentials).set(set).where(eq(crewCredentials.id, id)).returning();
  const type = await getCredentialType(row!.typeId);
  await crewEvent(
    "crew.credential_changed",
    {
      action: "updated",
      workerId: row!.workerId,
      credentialId: id,
      type: type.key,
      status: row!.status,
      previousStatus: current.status,
      expiresOn: row!.expiresOn,
      previousExpiresOn: current.expiresOn,
      source: row!.source,
    },
    actor,
    { type: "crew_worker", id: row!.workerId },
  );
  return row!;
}

export async function deleteCredential(id: string, actor: CrewActor): Promise<void> {
  const current = await loadCredential(id);
  await db.delete(crewCredentials).where(eq(crewCredentials.id, id));
  const type = await getCredentialType(current.typeId).catch(() => null);
  await crewEvent(
    "crew.credential_changed",
    { action: "removed", workerId: current.workerId, credentialId: id, type: type?.key ?? null, status: current.status, source: current.source },
    actor,
    { type: "crew_worker", id: current.workerId },
  );
}

/**
 * Write what the verifier said, one row per worker and type. Returns how many
 * rows changed. Only differences are published, so a verifier answering the
 * same thing at every check-in does not flood the audit log.
 */
export async function mergeVerified(
  workerId: string,
  verified: VerifiedCredential[],
  types: Map<string, CrewCredentialType>,
): Promise<number> {
  let changed = 0;
  const now = new Date();
  for (const v of verified) {
    const type = types.get(v.typeKey);
    if (!type) continue;
    const [before] = await db
      .select()
      .from(crewCredentials)
      .where(and(eq(crewCredentials.workerId, workerId), eq(crewCredentials.typeId, type.id), eq(crewCredentials.source, "verifier")))
      .limit(1);
    // A verifier that sends an expiry before the issue date is wrong about one
    // of them; keep the expiry, which is what compliance turns on.
    const issuedOn = v.issuedOn && v.expiresOn && v.expiresOn < v.issuedOn ? null : v.issuedOn;
    const values = {
      status: v.status,
      expiresOn: v.expiresOn,
      issuedOn,
      number: v.number,
      issuer: v.issuer,
      verifiedAt: now,
      updatedAt: now,
      updatedBy: "verifier",
    };
    if (before) {
      await db.update(crewCredentials).set(values).where(eq(crewCredentials.id, before.id));
    } else {
      await db
        .insert(crewCredentials)
        .values({ workerId, typeId: type.id, source: "verifier", createdBy: "verifier", ...values })
        .onConflictDoUpdate({
          target: [crewCredentials.workerId, crewCredentials.typeId],
          targetWhere: sql`source = 'verifier'`,
          set: values,
        });
    }
    const differs = !before || before.status !== v.status || before.expiresOn !== v.expiresOn;
    if (differs) {
      changed++;
      await crewEvent(
        "crew.credential_changed",
        {
          action: before ? "updated" : "added",
          workerId,
          type: type.key,
          status: v.status,
          previousStatus: before?.status ?? null,
          expiresOn: v.expiresOn,
          source: "verifier",
        },
        null,
        { type: "crew_worker", id: workerId },
      );
    }
  }
  if (changed) logger.info("crew.verify.merged", { workerId, changed });
  return changed;
}
