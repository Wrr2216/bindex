import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { crewCredentialTypes, crewCredentials, type CrewCredentialType } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { clean } from "./shared";

/**
 * Credential types: the administrator's list of what a worker can hold
 * (background check, forklift licence, site induction...). The key is fixed at
 * creation, because job type requirements and the external verifier refer to
 * it; the name can change freely.
 */

export type CredentialTypeInput = {
  key?: string;
  name: string;
  description?: string | null;
  validityMonths?: number | null;
  warnDays?: number;
  active?: boolean;
};

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** "Forklift licence (counterbalance)" → "forklift_licence_counterbalance". */
export function keyFromName(name: string): string {
  const k = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  return k || "credential";
}

export function listCredentialTypes(opts: { includeInactive?: boolean } = {}): Promise<CrewCredentialType[]> {
  return db
    .select()
    .from(crewCredentialTypes)
    .where(opts.includeInactive ? undefined : eq(crewCredentialTypes.active, true))
    .orderBy(asc(crewCredentialTypes.name));
}

/** Every type by key, active or not: a retired type still names old credentials. */
export async function credentialTypesByKey(): Promise<Map<string, CrewCredentialType>> {
  const rows = await listCredentialTypes({ includeInactive: true });
  return new Map(rows.map((t) => [t.key, t]));
}

export async function getCredentialType(id: string): Promise<CrewCredentialType> {
  const [row] = await db.select().from(crewCredentialTypes).where(eq(crewCredentialTypes.id, id)).limit(1);
  if (!row) throw notFound("Credential type not found");
  return row;
}

function taken(err: unknown, input: { key?: string; name?: string }): Error | null {
  if (isUniqueViolation(err, "uq_crew_credential_types_key")) {
    return conflict(`There is already a credential type with the key "${input.key}". Pick another key.`);
  }
  if (isUniqueViolation(err, "uq_crew_credential_types_name")) {
    return conflict(`There is already a credential type called "${input.name}".`);
  }
  return null;
}

export async function createCredentialType(input: CredentialTypeInput): Promise<CrewCredentialType> {
  const name = clean(input.name);
  if (!name) throw badRequest("A credential type needs a name.");
  const key = input.key?.trim() || keyFromName(name);
  if (!KEY.test(key)) {
    throw badRequest("The key must start with a letter and use lowercase letters, digits and underscores (at most 40).");
  }
  try {
    const [row] = await db
      .insert(crewCredentialTypes)
      .values({
        key,
        name,
        description: clean(input.description),
        validityMonths: input.validityMonths ?? null,
        warnDays: input.warnDays ?? 30,
        active: input.active ?? true,
      })
      .returning();
    return row!;
  } catch (err) {
    throw taken(err, { key, name }) ?? err;
  }
}

export async function updateCredentialType(
  id: string,
  patch: Partial<Omit<CredentialTypeInput, "key">>,
): Promise<CrewCredentialType> {
  const set: Partial<typeof crewCredentialTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (!name) throw badRequest("A credential type needs a name.");
    set.name = name;
  }
  if (patch.description !== undefined) set.description = clean(patch.description);
  if (patch.validityMonths !== undefined) set.validityMonths = patch.validityMonths;
  if (patch.warnDays !== undefined) set.warnDays = patch.warnDays;
  if (patch.active !== undefined) set.active = patch.active;
  try {
    const [row] = await db.update(crewCredentialTypes).set(set).where(eq(crewCredentialTypes.id, id)).returning();
    if (!row) throw notFound("Credential type not found");
    return row;
  } catch (err) {
    throw taken(err, { name: set.name }) ?? err;
  }
}

/** Only a type nobody holds can go; otherwise retire it (active: false). */
export async function deleteCredentialType(id: string): Promise<void> {
  const type = await getCredentialType(id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crewCredentials)
    .where(eq(crewCredentials.typeId, id));
  if (n > 0) {
    throw conflict(
      `${n} credential${n === 1 ? " is" : "s are"} on file as "${type.name}". Retire the type instead (switch it off), so their history stays.`,
    );
  }
  await db.delete(crewCredentialTypes).where(eq(crewCredentialTypes.id, id));
}
