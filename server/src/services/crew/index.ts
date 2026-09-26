import { pool } from "../../db/client";
import { registerTaskKind } from "../jobs-core";
import { registerOwnerType } from "../media-ai-core";
import { CREW_TASK_KIND } from "./checkins";
import "./events";

/**
 * Crew check-in and credentials: the public surface. docs/crew.md describes
 * the rules and the API.
 */

const exists = (table: string) => async (id: string) => {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
};

// Worker photos and credential documents are attachments; the sweep removes
// them once their worker or credential is deleted.
registerOwnerType("crew_worker", exists("crew_workers"), { table: "crew_workers", label: "worker" });
registerOwnerType("crew_credential", exists("crew_credentials"), { table: "crew_credentials", label: "credential" });

// A job type can start its jobs with a "Crew check-in" task, done when the
// first worker is checked in.
registerTaskKind(CREW_TASK_KIND, { label: "Crew check-in" });

export * from "./model";
export {
  listCredentialTypes,
  credentialTypesByKey,
  getCredentialType,
  createCredentialType,
  updateCredentialType,
  deleteCredentialType,
  keyFromName,
  type CredentialTypeInput,
} from "./credentialTypes";
export { addCredential, updateCredential, deleteCredential, credentialsForWorkers, type CredentialInput } from "./credentials";
export {
  listWorkers,
  getWorker,
  loadWorker,
  findWorkerByBadge,
  createWorker,
  updateWorker,
  deleteWorker,
  reissueBadge,
  type WorkerInput,
  type WorkerFilters,
} from "./workers";
export { policyForJobType, requiredTypes, listJobTypePolicies, setJobTypePolicy, type PolicyInput } from "./policy";
export {
  CREW_TASK_KIND,
  checkIn,
  checkOut,
  checkOutByCode,
  checkOutAll,
  updateCheckin,
  deleteCheckin,
  listCrewJobs,
  roster,
  candidates,
  type CheckInInput,
  type CheckInOutcome,
  type CheckOutInput,
  type CheckinPatch,
} from "./checkins";
export { verifierAvailable, verifyWorker, type VerifierResult } from "./verifier";
export { timesheetRows, timesheetXlsx, rosterFromRows, hoursByDay, type TimesheetFilters } from "./timesheet";
export { badgePng, badgesPdf, badgePhoto, badgeUrl, type BadgeData } from "./badge";
export { expiringCredentials, sendCrewDigest, startCrewDigest, describeExpiring } from "./digest";
export { exportCrewTables, clearCrewTables, restoreCrewTables, predatesCrew, CREW_TABLES } from "./backup";
export { isForeignKeyViolation, type CrewActor } from "./shared";
