import { createHash, randomBytes } from "node:crypto";
import { GUARDED_STAGES, outcomePasses } from "./model";

/**
 * The custody policy as pure decisions, so the rules can be tested without a
 * database: which job lines a controlled item may not move on, and who holds
 * an item now.
 */

/** A manifest line about to change stage, as the jobs guard sees it. */
export type GuardedLine = {
  jobItemId: string;
  itemId: string;
  unitId: string | null;
  /** When the line was added to the job. */
  addedAt: Date;
};

/**
 * A controlled item: its own code, and the code of the controlled container it
 * is packed in when the control comes from there rather than from itself.
 */
export type Control = { assetCode: string; container: string | null };

/** One line of a completed delivery transfer that might cover a job line. */
export type Coverage = {
  itemId: string;
  unitId: string | null;
  outcome: string;
  jobId: string | null;
  completedAt: Date;
};

/**
 * Whether a completed delivery covers a job line:
 * - the same item, and the same unit or the whole item;
 * - an outcome that passed custody (accepted or damaged);
 * - recorded against this job, or against no job after the line was added to
 *   this one (someone forgot to pick the job; the handoff still happened).
 */
export function covers(c: Coverage, line: GuardedLine, jobId: string): boolean {
  if (c.itemId !== line.itemId) return false;
  if (c.unitId !== null && c.unitId !== line.unitId) return false;
  if (!outcomePasses(c.outcome)) return false;
  if (c.jobId === jobId) return true;
  return c.jobId === null && c.completedAt.getTime() >= line.addedAt.getTime();
}

export function vetoMessage(control: Control, stage: string): string {
  const inside = control.container ? ` (it travels in ${control.container})` : "";
  return (
    `${control.assetCode} is custody-controlled${inside}. Record its delivery first: ` +
    `a custody transfer with purpose Delivery, or the shipment's delivery sign-off. Then mark it ${stage}.`
  );
}

/**
 * The lines a stage change must refuse: controlled items moving to delivered
 * or placed with no completed delivery that covers them. Overriding (`force`)
 * does not lift this; custody is not a sequencing rule.
 */
export function custodyVetoes(
  stage: string,
  jobId: string,
  lines: readonly GuardedLine[],
  controls: ReadonlyMap<string, Control>,
  coverage: readonly Coverage[],
): { jobItemId: string; reason: string }[] {
  if (!GUARDED_STAGES.has(stage)) return [];
  const out: { jobItemId: string; reason: string }[] = [];
  for (const line of lines) {
    const control = controls.get(line.itemId);
    if (!control) continue;
    if (coverage.some((c) => covers(c, line, jobId))) continue;
    out.push({ jobItemId: line.jobItemId, reason: vetoMessage(control, stage) });
  }
  return out;
}

export type ChainParty = { kind: string; name: string; org: string | null };

/** One completed transfer in an item's chain, oldest first. */
export type ChainHop = {
  transferId: string;
  at: Date;
  from: ChainParty;
  to: ChainParty;
  outcome: string;
};

/**
 * Who holds the item now: the receiving party of the latest handoff that
 * passed custody. A refused or missing line leaves it with whoever held it
 * before, so the answer falls back to that hop's releasing party when it is
 * the latest word on the item.
 */
export function currentCustodian(hops: readonly ChainHop[]): (ChainParty & { since: Date; transferId: string }) | null {
  if (!hops.length) return null;
  const sorted = [...hops].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1]!;
  if (outcomePasses(last.outcome)) return { ...last.to, since: last.at, transferId: last.transferId };
  if (last.outcome === "refused") return { ...last.from, since: last.at, transferId: last.transferId };
  // Missing: nobody can be named. Report the last known holder before it.
  for (let i = sorted.length - 2; i >= 0; i--) {
    const hop = sorted[i]!;
    if (outcomePasses(hop.outcome)) return { ...hop.to, since: hop.at, transferId: hop.transferId };
  }
  return null;
}

// --- One-time signing links ---------------------------------------------------

/** A fresh token for a signing link, and the hash that is stored instead of it. */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashLinkToken(token) };
}

export const hashLinkToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Tokens are 32 base64url characters; anything else is not worth a query. */
export const looksLikeToken = (token: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(token);

export const LINK_HOURS_DEFAULT = 72;
export const LINK_HOURS_MAX = 24 * 30;

export type LinkState = "none" | "active" | "used" | "expired";

export function linkState(
  t: { linkTokenHash: string | null; linkExpiresAt: Date | null; linkUsedAt: Date | null },
  now = new Date(),
): LinkState {
  if (t.linkUsedAt) return "used";
  if (!t.linkTokenHash) return "none";
  if (!t.linkExpiresAt || t.linkExpiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}
