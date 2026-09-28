import { asc } from "drizzle-orm";
import { db } from "../../db/client";
import { jobTypes, type CrewCredentialType, type CrewPolicy } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { getJobTypeSetting, setJobTypeSetting } from "../jobs-core";
import { credentialTypesByKey } from "./credentialTypes";
import { crewEvent } from "./events";
import { DEFAULT_POLICY, normalizePolicy, type CrewPolicySetting, type RequiredType } from "./model";
import type { CrewActor } from "./shared";

/**
 * What each job type asks of its crew, stored with the job type itself under
 * `settings.crew` (jobs core's per-feature settings), so this feature needs no
 * column on a table it does not own:
 *
 *   { "required": ["forklift", "site_induction"], "policy": "block", "overrideAdminOnly": false }
 *
 * A job with no type, or a type with nothing set, requires nothing and warns.
 */

export const SETTING_KEY = "crew";

export async function policyForJobType(jobTypeId: string | null): Promise<CrewPolicySetting> {
  if (!jobTypeId) return { ...DEFAULT_POLICY };
  // A job whose type was deleted keeps the id only until the foreign key nulls it.
  const raw = await getJobTypeSetting(jobTypeId, SETTING_KEY).catch(() => undefined);
  return normalizePolicy(raw);
}

/**
 * The credential types a policy asks for, in the order given. A key whose type
 * has been deleted or retired asks for nothing: retiring a type is how an
 * administrator stops tracking it everywhere at once.
 */
export function requiredTypes(policy: CrewPolicySetting, types: Map<string, CrewCredentialType>): RequiredType[] {
  const out: RequiredType[] = [];
  for (const key of policy.required) {
    const t = types.get(key);
    if (t?.active) out.push({ key: t.key, name: t.name, warnDays: t.warnDays });
  }
  return out;
}

export async function listJobTypePolicies() {
  const rows = await db.select().from(jobTypes).orderBy(asc(jobTypes.name));
  return rows.map((t) => ({
    jobTypeId: t.id,
    name: t.name,
    color: t.color,
    active: t.active,
    ...normalizePolicy(t.settings[SETTING_KEY]),
  }));
}

export type PolicyInput = { required: string[]; policy: CrewPolicy; overrideAdminOnly?: boolean };

export async function setJobTypePolicy(jobTypeId: string, input: PolicyInput, actor: CrewActor) {
  const types = await credentialTypesByKey();
  const unknown = input.required.filter((k) => !types.has(k));
  if (unknown.length) {
    throw badRequest(`Unknown credential type${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Add them in Crew settings first.`);
  }
  const value = normalizePolicy({ ...input, required: [...new Set(input.required)] });
  const before = await policyForJobType(jobTypeId);
  const row = await setJobTypeSetting(jobTypeId, SETTING_KEY, value);
  await crewEvent(
    "crew.policy_changed",
    { jobType: row.name, before, after: value },
    actor,
    { type: "job_type", id: jobTypeId },
  );
  return { jobTypeId: row.id, name: row.name, color: row.color, active: row.active, ...value };
}
