import bwipjs from "bwip-js";
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  jobs,
  portalCodes,
  portalGrants,
  portalPasses,
  projects,
  shipments,
  type PortalGrant,
  type PortalRole,
  type PortalScope,
} from "../../db/schema";
import { env } from "../../env";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { actorFromOid, publish } from "../event-backbone";
import { isStage } from "../jobs-core";
import { mailAvailable, sendMail } from "./mailer";
import { composeCodeEmail, composeLinkEmail } from "./milestones";
import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  contributorStages,
  expiryProblem,
  grantShapeProblem,
  grantState,
  passExpiry,
  portalActor,
  type GrantState,
} from "./policy";
import { grantTarget } from "./scope";
import { codeMatches, generateCode, generatePass, generateToken, hashCode, hashSecret, looksLikePass } from "./tokens";

/**
 * Portal grants: creating, changing and revoking links (administrators), and
 * resolving a presented link and code (the portal itself).
 */

export type GrantTargetInfo = {
  kind: PortalScope;
  id: string;
  code: string;
  name: string;
  /** The job a shipment belongs to. */
  jobCode: string | null;
};

/** A grant as administrators see it. The token hash never leaves this module. */
export type GrantInfo = Omit<PortalGrant, "tokenHash"> & {
  state: GrantState;
  hasLink: boolean;
  target: GrantTargetInfo | null;
};

export type GrantInput = {
  scope: PortalScope;
  targetId: string;
  role: PortalRole;
  granteeName: string;
  granteeEmail?: string | null;
  granteeOrg?: string | null;
  expiresAt: Date;
  showValues?: boolean;
  showDocuments?: boolean;
  allowedStages?: string[] | null;
  requireCode?: boolean;
  notify?: boolean;
  note?: string | null;
};

export type GrantPatch = Partial<Omit<GrantInput, "scope" | "targetId">>;

/** What a new or reissued link comes back with: shown once, never stored. */
export type IssuedLink = { grant: GrantInfo; token: string; url: string; qr: string; emailed: boolean };

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

// ---- Presenting ---------------------------------------------------------------

async function targetsFor(rows: PortalGrant[]): Promise<Map<string, GrantTargetInfo>> {
  const ids = (kind: PortalScope) => [...new Set(rows.filter((r) => r.scope === kind).map((r) => grantTarget(r)!))];
  const [p, j, s] = await Promise.all([
    ids("project").length
      ? db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, ids("project")))
      : [],
    ids("job").length
      ? db.select({ id: jobs.id, code: jobs.code, name: jobs.name }).from(jobs).where(inArray(jobs.id, ids("job")))
      : [],
    ids("shipment").length
      ? db
          .select({ id: shipments.id, code: shipments.code, name: shipments.name, jobCode: jobs.code })
          .from(shipments)
          .innerJoin(jobs, eq(shipments.jobId, jobs.id))
          .where(inArray(shipments.id, ids("shipment")))
      : [],
  ]);
  const out = new Map<string, GrantTargetInfo>();
  for (const r of p) out.set(r.id, { kind: "project", ...r, jobCode: null });
  for (const r of j) out.set(r.id, { kind: "job", ...r, jobCode: null });
  for (const r of s) out.set(r.id, { kind: "shipment", ...r });
  return out;
}

async function present(rows: PortalGrant[], now = new Date()): Promise<GrantInfo[]> {
  const targets = await targetsFor(rows);
  return rows.map(({ tokenHash, ...rest }) => ({
    ...rest,
    state: grantState({ ...rest, tokenHash }, now),
    hasLink: Boolean(tokenHash),
    target: targets.get(grantTarget(rest)!) ?? null,
  }));
}

async function loadGrantRow(id: string): Promise<PortalGrant> {
  const [row] = await db.select().from(portalGrants).where(eq(portalGrants.id, id)).limit(1);
  if (!row) throw notFound("Portal link not found.");
  return row;
}

export async function getGrant(id: string): Promise<GrantInfo> {
  return (await present([await loadGrantRow(id)]))[0]!;
}

export type GrantFilter = {
  state?: "active" | "inactive";
  scope?: PortalScope;
  targetId?: string;
  q?: string;
  limit?: number;
};

export async function listGrants(f: GrantFilter = {}): Promise<GrantInfo[]> {
  const now = new Date();
  const conds: (SQL | undefined)[] = [];
  if (f.state === "active") {
    conds.push(isNull(portalGrants.revokedAt), isNotNull(portalGrants.tokenHash), gt(portalGrants.expiresAt, now));
  } else if (f.state === "inactive") {
    conds.push(or(isNotNull(portalGrants.revokedAt), isNull(portalGrants.tokenHash), lte(portalGrants.expiresAt, now)));
  }
  if (f.scope) conds.push(eq(portalGrants.scope, f.scope));
  if (f.targetId) {
    conds.push(
      or(eq(portalGrants.projectId, f.targetId), eq(portalGrants.jobId, f.targetId), eq(portalGrants.shipmentId, f.targetId)),
    );
  }
  const q = f.q?.trim();
  if (q) {
    conds.push(
      or(
        ilike(portalGrants.granteeName, `%${q}%`),
        ilike(portalGrants.granteeEmail, `%${q}%`),
        ilike(portalGrants.granteeOrg, `%${q}%`),
      ),
    );
  }
  const rows = await db
    .select()
    .from(portalGrants)
    .where(and(...conds))
    .orderBy(desc(portalGrants.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 200, 1), 500));
  return present(rows, now);
}

// ---- Validation ----------------------------------------------------------------

async function assertTarget(scope: PortalScope, id: string): Promise<void> {
  const table = scope === "project" ? projects : scope === "job" ? jobs : shipments;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  if (!row) throw badRequest(`That ${scope} does not exist. Pick one from the list.`);
}

function validateShape(g: {
  scope: PortalScope;
  role: PortalRole;
  granteeEmail: string | null;
  requireCode: boolean;
  notify: boolean;
  expiresAt: Date;
}): void {
  const problem = grantShapeProblem(g, mailAvailable()) ?? expiryProblem(g.expiresAt);
  if (problem) throw badRequest(problem);
}

function cleanStages(role: PortalRole, stages: string[] | null | undefined): string[] | null {
  if (role !== "contributor" || !stages || stages.length === 0) return null;
  const bad = stages.find((s) => s === "pending" || !isStage(s));
  if (bad) throw badRequest(`"${bad}" is not a stage a crew can scan to. Pick from the list.`);
  return contributorStages(role, stages, isStage);
}

// ---- Links -----------------------------------------------------------------------

/** A base URL the administrator's browser gave, if it is a plain http(s) origin. */
export function linkBase(given: string | null | undefined): string {
  if (given) {
    try {
      const u = new URL(given);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.origin;
    } catch {
      // fall back
    }
  }
  return env.APP_BASE_URL.replace(/\/+$/, "");
}

async function qrDataUrl(url: string): Promise<string> {
  try {
    const png = await bwipjs.toBuffer({ bcid: "qrcode", text: url, scale: 4, paddingwidth: 2, paddingheight: 2 });
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (err) {
    logger.warn("portal.qr.failed", { err: String(err) });
    return "";
  }
}

async function scopeLabelFor(grant: GrantInfo): Promise<string> {
  const t = grant.target;
  return t ? `${t.name} (${t.code})` : "your delivery";
}

async function issue(grant: GrantInfo, token: string, base: string, sendEmail: boolean): Promise<IssuedLink> {
  const url = `${base}/p/${token}`;
  let emailed = false;
  if (sendEmail && grant.granteeEmail) {
    const config = await getConfig();
    const mail = composeLinkEmail({
      appName: config.appName,
      orgName: config.orgName,
      granteeName: grant.granteeName,
      scopeLabel: await scopeLabelFor(grant),
      url,
      role: grant.role,
      expiresAt: grant.expiresAt,
    });
    emailed = await sendMail({ to: grant.granteeEmail, ...mail }, config.appName, "portal.link_mail");
  }
  return { grant, token, url, qr: await qrDataUrl(url), emailed };
}

const eventData = (g: GrantInfo) => ({
  scope: g.scope,
  targetId: grantTarget(g),
  targetCode: g.target?.code ?? null,
  role: g.role,
  granteeName: g.granteeName,
  granteeOrg: g.granteeOrg,
  // The address is personal data and the event feed is readable by every
  // signed-in user; whether there is one is enough.
  hasEmail: Boolean(g.granteeEmail),
  expiresAt: g.expiresAt,
  showValues: g.showValues,
  showDocuments: g.showDocuments,
  allowedStages: g.allowedStages,
  requireCode: g.requireCode,
  notify: g.notify,
});

const subject = (id: string) => ({ type: "portal_grant", id });

export async function createGrant(
  input: GrantInput,
  userOid: string,
  opts: { baseUrl?: string | null; sendEmail?: boolean } = {},
): Promise<IssuedLink> {
  const granteeEmail = clean(input.granteeEmail);
  const shape = {
    scope: input.scope,
    role: input.role,
    granteeEmail,
    requireCode: Boolean(input.requireCode),
    notify: Boolean(input.notify),
    expiresAt: input.expiresAt,
  };
  validateShape(shape);
  await assertTarget(input.scope, input.targetId);
  const granteeName = clean(input.granteeName);
  if (!granteeName) throw badRequest("Enter the name of the person or company the link is for.");

  const token = generateToken();
  const [row] = await db
    .insert(portalGrants)
    .values({
      scope: input.scope,
      projectId: input.scope === "project" ? input.targetId : null,
      jobId: input.scope === "job" ? input.targetId : null,
      shipmentId: input.scope === "shipment" ? input.targetId : null,
      role: input.role,
      granteeName,
      granteeEmail,
      granteeOrg: clean(input.granteeOrg),
      showValues: Boolean(input.showValues),
      showDocuments: input.showDocuments ?? true,
      allowedStages: cleanStages(input.role, input.allowedStages),
      requireCode: shape.requireCode,
      notify: shape.notify,
      tokenHash: hashSecret(token),
      tokenLast4: token.slice(-4),
      expiresAt: input.expiresAt,
      note: clean(input.note),
      createdBy: userOid,
    })
    .returning();
  const grant = (await present([row!]))[0]!;
  logger.info("portal.grant.created", { grantId: grant.id, scope: grant.scope, role: grant.role });
  await publish("portal.grant_created", eventData(grant), { actor: actorFromOid(userOid), subject: subject(grant.id) });
  return issue(grant, token, linkBase(opts.baseUrl), Boolean(opts.sendEmail));
}

export async function updateGrant(id: string, patch: GrantPatch, userOid: string): Promise<GrantInfo> {
  const current = await loadGrantRow(id);
  if (current.revokedAt) throw badRequest("This link is revoked. Make a new one instead.");
  const role = patch.role ?? current.role;
  const next = {
    scope: current.scope,
    role,
    granteeEmail: patch.granteeEmail !== undefined ? clean(patch.granteeEmail) : current.granteeEmail,
    requireCode: patch.requireCode ?? current.requireCode,
    notify: patch.notify ?? current.notify,
    expiresAt: patch.expiresAt ?? current.expiresAt,
  };
  // An expiry that is not being changed may already be in the past (editing
  // an expired link's name); only a new one has to be valid.
  const problem =
    grantShapeProblem(next, mailAvailable()) ?? (patch.expiresAt ? expiryProblem(patch.expiresAt) : null);
  if (problem) throw badRequest(problem);
  const granteeName = patch.granteeName !== undefined ? clean(patch.granteeName) : current.granteeName;
  if (!granteeName) throw badRequest("Enter the name of the person or company the link is for.");

  const [row] = await db
    .update(portalGrants)
    .set({
      role,
      granteeName,
      granteeEmail: next.granteeEmail,
      granteeOrg: patch.granteeOrg !== undefined ? clean(patch.granteeOrg) : current.granteeOrg,
      showValues: patch.showValues ?? current.showValues,
      showDocuments: patch.showDocuments ?? current.showDocuments,
      allowedStages:
        patch.allowedStages !== undefined || patch.role !== undefined
          ? cleanStages(role, patch.allowedStages !== undefined ? patch.allowedStages : current.allowedStages)
          : current.allowedStages,
      requireCode: next.requireCode,
      notify: next.notify,
      expiresAt: next.expiresAt,
      note: patch.note !== undefined ? clean(patch.note) : current.note,
      updatedAt: new Date(),
    })
    .where(eq(portalGrants.id, id))
    .returning();
  // A change of address or the switch to require a code must not leave an
  // already-verified browser (or a code sent to the old address) working.
  if (next.granteeEmail !== current.granteeEmail || (next.requireCode && !current.requireCode)) {
    await db.delete(portalPasses).where(eq(portalPasses.grantId, id));
    await db.delete(portalCodes).where(eq(portalCodes.grantId, id));
  }
  const grant = (await present([row!]))[0]!;
  const changed = Object.keys(patch).filter((k) => patch[k as keyof GrantPatch] !== undefined);
  await publish(
    "portal.grant_updated",
    { ...eventData(grant), changed },
    { actor: actorFromOid(userOid), subject: subject(id) },
  );
  return grant;
}

export async function revokeGrant(id: string, userOid: string): Promise<GrantInfo> {
  const [row] = await db
    .update(portalGrants)
    .set({ revokedAt: new Date(), revokedBy: userOid, updatedAt: new Date() })
    .where(and(eq(portalGrants.id, id), isNull(portalGrants.revokedAt)))
    .returning();
  if (!row) {
    await loadGrantRow(id); // 404 when it does not exist
    throw badRequest("This link is already revoked.");
  }
  await db.delete(portalPasses).where(eq(portalPasses.grantId, id));
  await db.delete(portalCodes).where(eq(portalCodes.grantId, id));
  const grant = (await present([row]))[0]!;
  logger.info("portal.grant.revoked", { grantId: id });
  await publish("portal.grant_revoked", eventData(grant), { actor: actorFromOid(userOid), subject: subject(id) });
  return grant;
}

/** A new token for the same grant; the old link stops working at once. */
export async function reissueGrant(
  id: string,
  userOid: string,
  opts: { baseUrl?: string | null; sendEmail?: boolean } = {},
): Promise<IssuedLink> {
  const current = await loadGrantRow(id);
  if (current.revokedAt) throw badRequest("This link is revoked. Make a new one instead.");
  const token = generateToken();
  const [row] = await db
    .update(portalGrants)
    .set({ tokenHash: hashSecret(token), tokenLast4: token.slice(-4), updatedAt: new Date() })
    .where(eq(portalGrants.id, id))
    .returning();
  await db.delete(portalPasses).where(eq(portalPasses.grantId, id));
  await db.delete(portalCodes).where(eq(portalCodes.grantId, id));
  const grant = (await present([row!]))[0]!;
  logger.info("portal.grant.reissued", { grantId: id });
  await publish("portal.grant_reissued", eventData(grant), { actor: actorFromOid(userOid), subject: subject(id) });
  return issue(grant, token, linkBase(opts.baseUrl), Boolean(opts.sendEmail));
}

/** Projects, jobs and shipments matching a code or name, for the new-link picker. */
export async function searchTargets(q: string): Promise<GrantTargetInfo[]> {
  const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query<GrantTargetInfo>(
    `(SELECT 'project' AS kind, id, code, name, NULL::text AS "jobCode"
        FROM projects WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY created_at DESC LIMIT 10)
     UNION ALL
     (SELECT 'job', id, code, name, NULL FROM jobs
        WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY created_at DESC LIMIT 15)
     UNION ALL
     (SELECT 'shipment', s.id, s.code, s.name, j.code FROM shipments s JOIN jobs j ON j.id = s.job_id
        WHERE s.code ILIKE $1 OR s.name ILIKE $1 OR j.code ILIKE $1 OR j.name ILIKE $1
        ORDER BY s.created_at DESC LIMIT 15)`,
    [like],
  );
  return rows;
}

/** A grant's entries in the audit log, newest first: every visit, action and change. */
export async function grantActivity(id: string, before?: number, limit = 50) {
  await loadGrantRow(id);
  const n = Math.min(Math.max(limit, 1), 200);
  const { rows } = await pool.query<{
    id: string;
    occurred_at: Date;
    type: string;
    actor_kind: string;
    actor_name: string | null;
    data: Record<string, unknown>;
  }>(
    `SELECT id, occurred_at, type, actor_kind, actor_name, data FROM audit_log
      WHERE subject_type = 'portal_grant' AND subject_id = $1 ${before ? "AND id < $3" : ""}
      ORDER BY id DESC LIMIT $2`,
    before ? [id, n + 1, before] : [id, n + 1],
  );
  const entries = rows.slice(0, n).map((r) => ({
    id: Number(r.id),
    occurredAt: r.occurred_at.toISOString(),
    type: r.type,
    actor: { kind: r.actor_kind, name: r.actor_name },
    data: r.data,
  }));
  return { entries, nextBefore: rows.length > n ? entries[entries.length - 1]!.id : null };
}

// ---- Presented links ---------------------------------------------------------------

export async function findGrantByTokenHash(tokenHash: string): Promise<PortalGrant | null> {
  const [row] = await db.select().from(portalGrants).where(eq(portalGrants.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

export async function touchGrant(id: string): Promise<void> {
  await db
    .update(portalGrants)
    .set({ lastUsedAt: new Date(), useCount: sql`${portalGrants.useCount} + 1` })
    .where(eq(portalGrants.id, id));
}

/** Whether `pass` is a live pass for this grant. Touches it when it is. */
export async function checkPass(grantId: string, pass: unknown): Promise<boolean> {
  if (!looksLikePass(pass)) return false;
  const rows = await db
    .update(portalPasses)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(portalPasses.passHash, hashSecret(pass)),
        eq(portalPasses.grantId, grantId),
        gt(portalPasses.expiresAt, new Date()),
      ),
    )
    .returning({ id: portalPasses.id });
  return rows.length > 0;
}

const codeUnavailable = () =>
  new HttpError(503, "mail_unavailable", "Codes cannot be emailed right now. Ask whoever shared this link.");

/** Email a fresh code, replacing any earlier one. */
export async function sendCode(grant: PortalGrant): Promise<{ sent: true }> {
  if (!grant.requireCode || !grant.granteeEmail) throw badRequest("This link does not use a code.");
  if (!mailAvailable()) throw codeUnavailable();
  const code = generateCode();
  const now = new Date();
  await db
    .insert(portalCodes)
    .values({ grantId: grant.id, codeHash: hashCode(grant.id, code), attempts: 0, expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now })
    .onConflictDoUpdate({
      target: portalCodes.grantId,
      set: { codeHash: hashCode(grant.id, code), attempts: 0, expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now },
    });
  const config = await getConfig();
  const sent = await sendMail(
    { to: grant.granteeEmail, ...composeCodeEmail({ appName: config.appName, orgName: config.orgName, code }) },
    config.appName,
    "portal.code_mail",
  );
  if (!sent) {
    await db.delete(portalCodes).where(eq(portalCodes.grantId, grant.id));
    throw codeUnavailable();
  }
  await publish("portal.code_sent", {}, { actor: portalActor(grant), subject: subject(grant.id) });
  return { sent: true };
}

/**
 * Exchange a code for a pass. A wrong code uses up one of five tries; after
 * the fifth, or after ten minutes, a new code has to be sent.
 */
export async function verifyCode(
  grant: PortalGrant,
  code: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ pass: string; expiresAt: Date }> {
  const wrong = () => new HttpError(401, "code_wrong", "That code is not right, or it has expired. Check it, or send a new one.");
  // Attempts are counted in the same statement that reads them, so parallel
  // guesses cannot share one try.
  const { rows } = await pool.query<{ code_hash: string; attempts: number }>(
    `UPDATE portal_codes SET attempts = attempts + 1
      WHERE grant_id = $1 AND expires_at > now() AND attempts < $2
      RETURNING code_hash, attempts`,
    [grant.id, CODE_MAX_ATTEMPTS],
  );
  const row = rows[0];
  if (!row || !codeMatches(row.code_hash, grant.id, code)) {
    await publish("portal.code_failed", { ip: meta.ip }, { actor: portalActor(grant), subject: subject(grant.id) });
    throw wrong();
  }
  await db.delete(portalCodes).where(eq(portalCodes.grantId, grant.id));
  const pass = generatePass();
  const expiresAt = passExpiry(grant.expiresAt);
  await db.insert(portalPasses).values({
    grantId: grant.id,
    passHash: hashSecret(pass),
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  await publish("portal.code_verified", { ip: meta.ip }, { actor: portalActor(grant), subject: subject(grant.id) });
  return { pass, expiresAt };
}

/** Turn milestone emails on or off, as the person themselves chooses on the portal. */
export async function setNotify(grant: PortalGrant, enabled: boolean): Promise<boolean> {
  if (enabled && !grant.granteeEmail) throw badRequest("There is no email address on this link. Ask whoever shared it to add one.");
  if (enabled && !mailAvailable()) throw codeUnavailable();
  await db.update(portalGrants).set({ notify: enabled, updatedAt: new Date() }).where(eq(portalGrants.id, grant.id));
  await publish("portal.notify_changed", { enabled }, { actor: portalActor(grant), subject: subject(grant.id) });
  return enabled;
}
