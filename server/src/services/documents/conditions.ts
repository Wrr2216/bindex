import { z } from "zod";

/**
 * When a packet applies to a job. Pure, so every rule is tested directly.
 *
 * Each kind of condition that is set must hold (job type, project, phase,
 * site, rules); a kind left empty does not restrict. Within a list the job
 * needs to match any one entry. Rules on job fields combine with `ruleMatch`
 * (all by default). A packet with no conditions at all applies to every job.
 */

export const RULE_OPS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "exists",
  "not_exists",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

/** Job fields a rule can test. `metadata.<key>` reaches anything stored on the job. */
export const RULE_FIELDS: { key: string; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "name", label: "Name" },
  { key: "code", label: "Code" },
  { key: "type", label: "Job type name" },
  { key: "project", label: "Project name" },
  { key: "phase", label: "Phase name" },
  { key: "origin", label: "Origin" },
  { key: "destination", label: "Destination" },
  { key: "scheduledStart", label: "Scheduled start" },
  { key: "scheduledEnd", label: "Scheduled end" },
  { key: "notes", label: "Notes" },
  { key: "metadata.<key>", label: "A value stored on the job" },
];

const FIELD_PATTERN = new RegExp(
  `^(${RULE_FIELDS.filter((f) => !f.key.includes("<"))
    .map((f) => f.key)
    .join("|")}|metadata\\.[A-Za-z0-9_]{1,60})$`,
);

const uuidList = z.array(z.string().uuid()).max(200);

export const ruleSchema = z.object({
  field: z.string().regex(FIELD_PATTERN, "Pick a job field such as status, name or metadata.<key>"),
  op: z.enum(RULE_OPS),
  value: z.union([z.string().max(500), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(100)]).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const conditionsSchema = z.object({
  jobTypeIds: uuidList.optional(),
  projectIds: uuidList.optional(),
  phaseIds: uuidList.optional(),
  /** The job's origin or destination (see siteSide) is this location or inside it. */
  siteLocationIds: uuidList.optional(),
  siteSide: z.enum(["either", "origin", "destination"]).optional(),
  rules: z.array(ruleSchema).max(20).optional(),
  ruleMatch: z.enum(["all", "any"]).optional(),
});
export type PacketConditions = z.infer<typeof conditionsSchema>;

/** Stored conditions from an older or hand-edited row: keep what parses, drop the rest. */
export function readConditions(raw: unknown): PacketConditions {
  const parsed = conditionsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** What a packet is tested against. */
export type PacketJob = {
  jobTypeId: string | null;
  projectId: string | null;
  phaseId: string | null;
  /** The origin location and every location above it. */
  originSites: string[];
  destinationSites: string[];
  /** status, name, code, type, project, phase, origin, destination, scheduledStart, scheduledEnd, notes, metadata. */
  fields: Record<string, unknown>;
};

export type ConditionCheck = { kind: "jobType" | "project" | "phase" | "site" | "rules"; ok: boolean; detail: string };
export type Evaluation = { matches: boolean; checks: ConditionCheck[] };

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

const text = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).trim().toLowerCase();

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const asTime = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" && ISO_DATE.test(v.trim())) {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

function same(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return text(a) === text(b);
}

/** A rule's value as a list, for in / not_in: an array, or a comma-separated string. */
const listOf = (v: Rule["value"]): unknown[] =>
  Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v === undefined ? [] : [v];

function compare(actual: unknown, expected: unknown): number | null {
  const na = asNumber(actual);
  const nb = asNumber(expected);
  if (na !== null && nb !== null) return na - nb;
  const ta = asTime(actual);
  const tb = asTime(expected);
  if (ta !== null && tb !== null) return ta - tb;
  return null;
}

export function fieldValue(job: PacketJob, field: string): unknown {
  if (field.startsWith("metadata.")) {
    const meta = job.fields.metadata;
    if (!meta || typeof meta !== "object") return undefined;
    const key = field.slice("metadata.".length);
    return Object.prototype.hasOwnProperty.call(meta, key) ? (meta as Record<string, unknown>)[key] : undefined;
  }
  return job.fields[field];
}

export function evaluateRule(rule: Rule, job: PacketJob): boolean {
  const actual = fieldValue(job, rule.field);
  const values = Array.isArray(actual) ? actual : [actual];
  switch (rule.op) {
    case "exists":
      return !isEmpty(actual);
    case "not_exists":
      return isEmpty(actual);
    case "equals":
      return values.some((v) => same(v, rule.value));
    case "not_equals":
      return !values.some((v) => same(v, rule.value));
    case "in":
      return listOf(rule.value).some((want) => values.some((v) => same(v, want)));
    case "not_in":
      return !listOf(rule.value).some((want) => values.some((v) => same(v, want)));
    case "contains":
    case "not_contains": {
      const needle = isEmpty(rule.value) ? null : text(rule.value);
      const hit =
        needle !== null &&
        (Array.isArray(actual) ? actual.some((v) => same(v, rule.value)) : !isEmpty(actual) && text(actual).includes(needle));
      return rule.op === "contains" ? hit : !hit;
    }
    case "starts_with":
      return !isEmpty(actual) && !isEmpty(rule.value) && text(actual).startsWith(text(rule.value));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (isEmpty(actual)) return false;
      const c = compare(actual, rule.value);
      if (c === null) return false;
      return rule.op === "gt" ? c > 0 : rule.op === "gte" ? c >= 0 : rule.op === "lt" ? c < 0 : c <= 0;
    }
  }
}

const inList = (list: string[] | undefined, id: string | null) => !list?.length || (id !== null && list.includes(id));

export function evaluateConditions(conditions: PacketConditions, job: PacketJob): Evaluation {
  const checks: ConditionCheck[] = [];
  const c = conditions;
  if (c.jobTypeIds?.length) {
    checks.push({ kind: "jobType", ok: inList(c.jobTypeIds, job.jobTypeId), detail: `job type is one of ${c.jobTypeIds.length}` });
  }
  if (c.projectIds?.length) {
    checks.push({ kind: "project", ok: inList(c.projectIds, job.projectId), detail: `project is one of ${c.projectIds.length}` });
  }
  if (c.phaseIds?.length) {
    checks.push({ kind: "phase", ok: inList(c.phaseIds, job.phaseId), detail: `phase is one of ${c.phaseIds.length}` });
  }
  if (c.siteLocationIds?.length) {
    const side = c.siteSide ?? "either";
    const sites =
      side === "origin" ? job.originSites : side === "destination" ? job.destinationSites : [...job.originSites, ...job.destinationSites];
    const ok = c.siteLocationIds.some((id) => sites.includes(id));
    checks.push({ kind: "site", ok, detail: `${side === "either" ? "origin or destination" : side} is at one of ${c.siteLocationIds.length} sites` });
  }
  if (c.rules?.length) {
    const results = c.rules.map((r) => evaluateRule(r, job));
    const all = (c.ruleMatch ?? "all") === "all";
    const ok = all ? results.every(Boolean) : results.some(Boolean);
    checks.push({
      kind: "rules",
      ok,
      detail: `${results.filter(Boolean).length} of ${results.length} rules hold (${all ? "all" : "any"} needed)`,
    });
  }
  return { matches: checks.every((ch) => ch.ok), checks };
}

/** True when nothing restricts the packet, so it would attach to every job. */
export const isUnconditional = (c: PacketConditions) =>
  !c.jobTypeIds?.length && !c.projectIds?.length && !c.phaseIds?.length && !c.siteLocationIds?.length && !c.rules?.length;
