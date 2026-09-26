import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { claims, itemUnits, items, jobItems, jobs, shipments, type ClaimType } from "../../db/schema";
import { HttpError, badRequest, forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { isExceptionStage, stageLabel } from "../jobs-core";
import { createClaim, setStatus } from "./claims";
import { MONEY_TYPES, TYPE_INFO } from "./model";
import { grantUsable, type PortalGrant } from "./normalize";
import type { ClaimActor } from "./shared";
import { findPortalGrant } from "./sources";

/**
 * Filing a claim from the external portal. The portal is another feature; this
 * reads its grants table when it exists, and answers 404 when it does not, so
 * nothing here depends on that feature being installed.
 *
 * A grant sees only what it was given: its own shipment (or job), that
 * shipment's lines, and the claims filed through that same grant. Nothing
 * about other claims, other jobs, reviewers or internal comments leaves here.
 */

type Scope = { grant: PortalGrant; jobId: string; shipmentId: string | null; label: string };

const GONE = "This link has expired or been withdrawn. Ask whoever sent it for a new one.";

export async function portalScope(token: string): Promise<Scope> {
  const grant = await findPortalGrant(token);
  if (!grant) throw notFound("This link is not valid. Check it was copied in full.");
  const check = grantUsable(grant, new Date());
  if (!check.ok) {
    if (check.reason === "scope") throw forbidden("Claims can be filed on a shipment or a job link. This link covers neither.");
    throw new HttpError(410, "gone", GONE);
  }
  if (grant.scope === "shipment") {
    const [s] = await db
      .select({ id: shipments.id, jobId: shipments.jobId, code: shipments.code, name: shipments.name })
      .from(shipments)
      .where(eq(shipments.id, grant.scopeId!))
      .limit(1);
    if (!s) throw new HttpError(410, "gone", GONE);
    return { grant, jobId: s.jobId, shipmentId: s.id, label: `${s.code} ${s.name}` };
  }
  const [j] = await db.select({ id: jobs.id, code: jobs.code, name: jobs.name }).from(jobs).where(eq(jobs.id, grant.scopeId!)).limit(1);
  if (!j) throw new HttpError(410, "gone", GONE);
  return { grant, jobId: j.id, shipmentId: null, label: `${j.code} ${j.name}` };
}

const portalActor = (grant: PortalGrant, email?: string | null): ClaimActor => ({
  userOid: null,
  name: grant.name ?? grant.org ?? "Portal user",
  email: email ?? grant.email,
  grantId: grant.id,
});

async function scopeLines(scope: Scope) {
  return db
    .select({
      jobItemId: jobItems.id,
      itemName: items.name,
      unitLabel: itemUnits.label,
      assetCode: items.assetCode,
      unitCode: itemUnits.assetCode,
      stage: jobItems.stage,
    })
    .from(jobItems)
    .innerJoin(items, eq(jobItems.itemId, items.id))
    .leftJoin(itemUnits, eq(jobItems.unitId, itemUnits.id))
    .where(and(eq(jobItems.jobId, scope.jobId), scope.shipmentId ? eq(jobItems.shipmentId, scope.shipmentId) : undefined))
    .orderBy(items.name)
    .limit(5000);
}

export type PortalView = {
  grant: { name: string | null; org: string | null; scope: string; expiresAt: string | null };
  scope: string;
  types: { type: ClaimType; label: string; description: string }[];
  lines: { jobItemId: string; itemName: string; code: string; stage: string; stageLabel: string; flagged: boolean }[];
  claims: {
    code: string;
    type: ClaimType;
    status: string;
    title: string;
    currency: string;
    estimatedTotalCents: number | null;
    approvedTotalCents: number | null;
    createdAt: Date;
  }[];
};

export async function portalView(token: string): Promise<PortalView> {
  const scope = await portalScope(token);
  const [lines, filed] = await Promise.all([
    scopeLines(scope),
    db
      .select({
        code: claims.code,
        type: claims.type,
        status: claims.status,
        title: claims.title,
        currency: claims.currency,
        estimatedTotalCents: claims.estimatedTotalCents,
        approvedTotalCents: claims.approvedTotalCents,
        createdAt: claims.createdAt,
      })
      .from(claims)
      .where(eq(claims.reporterGrantId, scope.grant.id))
      .orderBy(desc(claims.createdAt)),
  ]);
  return {
    grant: { name: scope.grant.name, org: scope.grant.org, scope: scope.grant.scope!, expiresAt: scope.grant.expiresAt },
    scope: scope.label,
    types: MONEY_TYPES.map((t) => ({ type: t, label: TYPE_INFO[t].label, description: TYPE_INFO[t].description })),
    lines: lines.map((l) => ({
      jobItemId: l.jobItemId,
      itemName: l.unitLabel ? `${l.itemName} · ${l.unitLabel}` : l.itemName,
      code: l.unitCode ?? l.assetCode,
      stage: l.stage,
      stageLabel: stageLabel(l.stage),
      flagged: isExceptionStage(l.stage),
    })),
    claims: filed,
  };
}

export type PortalClaimInput = {
  type: ClaimType;
  title?: string | null;
  description: string;
  occurredAt?: string | null;
  contactEmail?: string | null;
  lines: { jobItemId: string; damageDescription?: string | null; estimatedCents?: number | null }[];
};

/**
 * File a claim through a grant. It arrives submitted, with its evidence
 * gathered and its decision clock running, so the team sees it straight away.
 */
export async function portalFileClaim(token: string, input: PortalClaimInput) {
  const scope = await portalScope(token);
  if (!TYPE_INFO[input.type]?.money) throw badRequest("Pick what kind of claim this is.");
  if ((input.type === "loss" || input.type === "damage") && input.lines.length === 0) {
    throw badRequest(`Pick the items that were ${input.type === "loss" ? "lost" : "damaged"}.`);
  }
  const ids = [...new Set(input.lines.map((l) => l.jobItemId))];
  if (ids.length) {
    const inScope = await db
      .select({ id: jobItems.id })
      .from(jobItems)
      .where(
        and(
          inArray(jobItems.id, ids),
          eq(jobItems.jobId, scope.jobId),
          scope.shipmentId ? eq(jobItems.shipmentId, scope.shipmentId) : undefined,
        ),
      );
    // Out-of-scope lines are refused as if they did not exist, so a link
    // cannot be used to learn about anything it was not given.
    if (inScope.length !== ids.length) throw badRequest("Pick items from this delivery only.");
  }
  const actor = portalActor(scope.grant, input.contactEmail);
  const created = await createClaim(
    {
      type: input.type,
      title: input.title?.trim() || `${TYPE_INFO[input.type].label} on ${scope.label}`,
      description: input.description,
      jobId: scope.jobId,
      shipmentId: scope.shipmentId,
      occurredAt: input.occurredAt ?? null,
      reporterEmail: input.contactEmail ?? null,
      lines: input.lines.map((l) => ({
        jobItemId: l.jobItemId,
        damageDescription: l.damageDescription ?? null,
        estimatedCents: l.estimatedCents ?? null,
      })),
    },
    actor,
  );
  const submitted = await setStatus(created.id, { status: "submitted", note: "Filed through the portal." }, actor);
  logger.info("claims.portal.filed", { claimId: submitted.id, code: submitted.code, grantId: scope.grant.id });
  return {
    code: submitted.code,
    status: submitted.status,
    title: submitted.title,
    lines: submitted.lines.length,
    currency: submitted.currency,
    estimatedTotalCents: submitted.totals.estimatedTotalCents,
    submittedAt: submitted.submittedAt,
  };
}
