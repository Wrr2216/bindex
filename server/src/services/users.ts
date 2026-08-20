import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { users, type User, type UserRole } from "../db/schema";
import { env } from "../env";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { checkPasswordStrength, hashPassword, verifyPassword } from "../lib/password";
import type { SessionUser } from "../auth/session";

/** What the rest of the app sees. The password hash never leaves this module. */
export type UserInfo = {
  oid: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  /** True when this account can sign in with a password. */
  hasPassword: boolean;
  createdAt: Date;
  lastLogin: Date;
};

const info = (row: User): UserInfo => ({
  oid: row.oid,
  email: row.email,
  name: row.name,
  role: row.role,
  disabled: row.disabled,
  hasPassword: Boolean(row.passwordHash),
  createdAt: row.createdAt,
  lastLogin: row.lastLogin,
});

export const sessionUser = (row: User): SessionUser => ({
  oid: row.oid,
  email: row.email,
  name: row.name,
  role: row.role,
});

const normalizeEmail = (email: string) => email.trim().toLowerCase();

// Verified against when no account matches, so a failed sign-in costs the same
// as a successful one and response time cannot be used to enumerate addresses.
const decoyHash = hashPassword(randomBytes(32).toString("hex")).catch(() => "");

/**
 * An optional allowlist that applies to every sign-in method, so restricting a
 * public deployment does not depend on the identity provider supporting it.
 */
export function emailAllowed(email: string): boolean {
  return env.allowedEmails.length === 0 || env.allowedEmails.includes(normalizeEmail(email));
}

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

export async function listUsers(): Promise<UserInfo[]> {
  const rows = await db.select().from(users).orderBy(asc(users.email));
  return rows.map(info);
}

export async function findByEmail(email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function findByOid(oid: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.oid, oid)).limit(1);
  return row ?? null;
}

export type NewUser = {
  email: string;
  name?: string;
  role?: UserRole;
  /** Omit for an account that will only ever sign in through SSO. */
  password?: string;
};

export async function createUser(input: NewUser): Promise<UserInfo> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("Enter a valid email address.");

  let passwordHash: string | null = null;
  if (input.password) {
    const problem = checkPasswordStrength(input.password);
    if (problem) throw badRequest(problem);
    passwordHash = await hashPassword(input.password);
  }

  if (await findByEmail(email)) throw conflict("Someone already uses that email address.");

  const [row] = await db
    .insert(users)
    .values({
      oid: `local:${randomUUID()}`,
      email,
      name: input.name?.trim() || email,
      role: input.role ?? "member",
      passwordHash,
    })
    .returning();
  logger.info("user.created", { email, role: row!.role });
  return info(row!);
}

/**
 * Sign in with an email and password. Returns null for every failure mode, so
 * the caller cannot accidentally tell an attacker which part was wrong.
 */
export async function authenticate(email: string, password: string): Promise<User | null> {
  const row = await findByEmail(email);
  if (!row?.passwordHash || row.disabled) {
    await verifyPassword(password, await decoyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.passwordHash))) return null;
  if (!emailAllowed(row.email)) return null;
  await touchLogin(row.oid);
  return row;
}

/**
 * Record a successful SSO sign-in. An account created ahead of time by an
 * administrator is matched on email and adopted, so its role survives.
 */
export async function upsertFromSso(claims: {
  subject: string;
  email: string;
  name: string;
}): Promise<User> {
  const email = normalizeEmail(claims.email);
  const existing = (await findByOid(claims.subject)) ?? (email ? await findByEmail(email) : null);

  if (existing) {
    if (existing.disabled) throw forbidden("This account has been disabled.");
    const [row] = await db
      .update(users)
      .set({ email: email || existing.email, name: claims.name, lastLogin: new Date() })
      .where(eq(users.oid, existing.oid))
      .returning();
    return row!;
  }

  if (!env.OIDC_AUTO_PROVISION) {
    throw forbidden("No account exists for this sign-in. Ask an administrator to add you.");
  }
  // The first person through the door owns the instance; everyone after them
  // starts as a member and is promoted deliberately.
  const role: UserRole = (await countUsers()) === 0 ? "admin" : "member";
  const [row] = await db
    .insert(users)
    .values({ oid: claims.subject, email, name: claims.name || email, role })
    .returning();
  logger.info("user.provisioned", { email, role });
  return row!;
}

async function touchLogin(oid: string): Promise<void> {
  await db.update(users).set({ lastLogin: new Date() }).where(eq(users.oid, oid));
}

export type UserPatch = {
  name?: string;
  role?: UserRole;
  disabled?: boolean;
  password?: string;
};

export async function updateUser(oid: string, patch: UserPatch): Promise<UserInfo> {
  const target = await findByOid(oid);
  if (!target) throw notFound("No such account.");

  const set: Partial<User> = {};
  if (patch.name !== undefined) set.name = patch.name.trim() || target.name;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;
  if (patch.password !== undefined) {
    const problem = checkPasswordStrength(patch.password);
    if (problem) throw badRequest(problem);
    set.passwordHash = await hashPassword(patch.password);
  }

  // Removing the last administrator would lock everyone out of Settings.
  const losingAdmin =
    target.role === "admin" && (set.role === "member" || set.disabled === true);
  if (losingAdmin && (await countOtherActiveAdmins(oid)) === 0) {
    throw badRequest("This is the only administrator. Promote someone else first.");
  }

  const [row] = await db.update(users).set(set).where(eq(users.oid, oid)).returning();
  return info(row!);
}

export async function deleteUser(oid: string): Promise<void> {
  const target = await findByOid(oid);
  if (!target) throw notFound("No such account.");
  if (target.role === "admin" && (await countOtherActiveAdmins(oid)) === 0) {
    throw badRequest("This is the only administrator. Promote someone else first.");
  }
  // History rows keep the raw oid rather than a foreign key, so removing the
  // account leaves the audit trail intact.
  await db.delete(users).where(eq(users.oid, oid));
  logger.info("user.deleted", { email: target.email });
}

async function countOtherActiveAdmins(exceptOid: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.disabled, false), ne(users.oid, exceptOid)));
  return row?.n ?? 0;
}

/** Change your own password, which requires proving you know the current one. */
export async function changeOwnPassword(
  oid: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const row = await findByOid(oid);
  if (!row) throw notFound("No such account.");
  if (!row.passwordHash) throw badRequest("This account signs in through your identity provider.");
  if (!(await verifyPassword(currentPassword, row.passwordHash))) {
    throw badRequest("That is not your current password.");
  }
  const problem = checkPasswordStrength(newPassword);
  if (problem) throw badRequest(problem);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.oid, oid));
  logger.info("user.password_changed", { email: row.email });
}

/**
 * Create the first administrator if the instance has none. Called on boot when
 * ADMIN_EMAIL and ADMIN_PASSWORD are set; otherwise the empty instance serves
 * the setup screen and the first visitor creates the account.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return;
  if ((await countUsers()) > 0) return;
  await createUser({
    email: env.ADMIN_EMAIL,
    name: env.ADMIN_NAME,
    role: "admin",
    password: env.ADMIN_PASSWORD,
  });
  logger.info("user.bootstrap_admin_created", { email: normalizeEmail(env.ADMIN_EMAIL) });
}
