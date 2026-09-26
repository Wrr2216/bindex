import { pool } from "../../db/client";
import { registerEventTypes } from "../event-backbone";
import { registerStageGuard } from "../jobs-core";
import { isOwnerType, registerOwnerType } from "../media-ai-core";
import { portalScopeGuard } from "./guard";

/**
 * External portal: links for people without an account. docs/portal.md
 * describes the feature, its API and its threat model. Import from here.
 */

export * from "./grants";
export { portalScan, addNote, addPhoto, signHandoff, type PortalScanResult } from "./contribute";
export {
  sessionInfo,
  overview,
  listLines,
  lineDetail,
  flaggedLines,
  documents,
  openFile,
  type PortalContext,
  type LineQuery,
  type PortalFile,
} from "./views";
export { loadScope, type PortalScopeView } from "./scope";
export { grantNotes } from "./notes";
export { recordAccess, recordDenied } from "./access";
export { mailAvailable, setMailTransport, type MailTransport } from "./mailer";
export { runNotifierOnce, startPortalNotifier } from "./notifier";
export { exportPortalTables, keepPortalSecrets, restorePortalTables, PORTAL_TABLES } from "./backup";
export * from "./policy";
export { looksLikeToken, looksLikePass, hashSecret, normalizeCode } from "./tokens";

let wired = false;

/**
 * Hooks into the cores, once, when this module loads: the scope guard on
 * stage changes, the records a crew signs against or staff file shared
 * documents on, and the event types for the webhook picker.
 */
function wire(): void {
  if (wired) return;
  wired = true;
  registerStageGuard("portal-scope", portalScopeGuard);

  // Another feature (custody, claims) may register these first; theirs stands.
  const rowExists = (table: string) => async (id: string) =>
    ((await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0;
  if (!isOwnerType("project")) registerOwnerType("project", rowExists("projects"), { table: "projects" });
  if (!isOwnerType("job")) registerOwnerType("job", rowExists("jobs"), { table: "jobs" });
  if (!isOwnerType("shipment")) registerOwnerType("shipment", rowExists("shipments"), { table: "shipments" });

  const group = "Portal";
  const subject = "portal_grant";
  registerEventTypes([
    { type: "portal.grant_created", group, subject, description: "A portal link was made for someone outside." },
    { type: "portal.grant_updated", group, subject, description: "A portal link's settings changed." },
    { type: "portal.grant_revoked", group, subject, description: "A portal link was revoked." },
    { type: "portal.grant_reissued", group, subject, description: "A portal link was replaced with a new one." },
    { type: "portal.accessed", group, subject, description: "Someone opened a portal link (one entry per visit)." },
    { type: "portal.access_denied", group, subject, description: "A revoked or expired portal link, or one missing its code, was used." },
    { type: "portal.code_sent", group, subject, description: "A sign-in code was emailed for a portal link." },
    { type: "portal.code_verified", group, subject, description: "A browser entered a portal link's code." },
    { type: "portal.code_failed", group, subject, description: "A wrong code was entered for a portal link." },
    { type: "portal.scanned", group, subject, description: "A crew scanned lines to a stage through a portal link." },
    { type: "portal.note_added", group, subject, description: "A crew added a condition note through a portal link." },
    { type: "portal.photo_added", group, subject, description: "A crew added a photo through a portal link." },
    { type: "portal.handoff_signed", group, subject, description: "A crew signed a handoff through a portal link." },
    { type: "portal.notify_changed", group, subject, description: "Milestone emails were switched on or off from a portal link." },
    { type: "portal.notification_sent", group, subject, description: "Milestone emails were sent to a portal link's person." },
  ]);
}

wire();
