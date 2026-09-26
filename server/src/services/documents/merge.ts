/**
 * Merge fields: `{{job.name}}` in a heading or paragraph, replaced with data
 * from the job, the project, the instance and the document's own fields
 * (`{{field.customer_name}}`). Pure, so resolution is tested directly.
 *
 * A placeholder whose path does not exist resolves to nothing and is reported
 * as unknown, which is how the editor catches a typo. A path that exists but
 * holds nothing (a job with no notes) is just empty.
 */

export const MERGE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

export type MergeContext = Record<string, unknown>;
export type Formatting = { timeZone: string; locale: string };

export const DEFAULT_FORMATTING: Formatting = { timeZone: "UTC", locale: "en-US" };

/** Every placeholder path in `text`, in order, without repeats. */
export function mergeKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MERGE_PATTERN)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * Walk a dotted path. Own properties only, so `{{job.constructor}}` finds
 * nothing rather than a function.
 */
export function lookup(ctx: MergeContext, path: string): { found: boolean; value: unknown } {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: cur !== undefined, value: cur };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function formatDate(value: string, fmt: Formatting, withTime: boolean): string {
  // A date without a time is a calendar day, not an instant: shown in UTC so
  // it never slides to the day before in a zone west of Greenwich.
  const d = new Date(withTime ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: fmt.timeZone, timeZoneName: "short" }
    : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
  try {
    return new Intl.DateTimeFormat(fmt.locale, opts).format(d);
  } catch {
    // An unknown locale or zone from a query string: fall back rather than fail the document.
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(d);
  }
}

/**
 * How a value prints. Dates in ISO form (which is how everything stored is
 * written) are formatted for people; booleans read Yes / No; lists are joined.
 */
export function formatValue(value: unknown, fmt: Formatting = DEFAULT_FORMATTING): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value.toISOString(), fmt, true);
  switch (typeof value) {
    case "string":
      if (DATE_ONLY.test(value)) return formatDate(value, fmt, false);
      if (DATE_TIME.test(value)) return formatDate(value, fmt, true);
      return value;
    case "number":
      return Number.isFinite(value) ? value.toLocaleString(fmt.locale, { maximumFractionDigits: 6 }) : "";
    case "boolean":
      return value ? "Yes" : "No";
    case "object":
      if (Array.isArray(value)) return value.map((v) => formatValue(v, fmt)).filter(Boolean).join(", ");
      // A signature value: print who signed rather than an object.
      if (typeof (value as { signerName?: unknown }).signerName === "string") {
        return (value as { signerName: string }).signerName;
      }
      return "";
    default:
      return "";
  }
}

export type Resolved = { text: string; unknown: string[] };

/** Replace every placeholder in `text`. Unknown paths become "" and are listed. */
export function resolveMerge(text: string, ctx: MergeContext, fmt: Formatting = DEFAULT_FORMATTING): Resolved {
  const unknown: string[] = [];
  const out = text.replace(MERGE_PATTERN, (_whole, path: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      if (!unknown.includes(path)) unknown.push(path);
      return "";
    }
    return formatValue(value, fmt);
  });
  return { text: out, unknown };
}

/**
 * The placeholders the editor offers. `field.<key>` and `job.metadata.<key>`
 * are open-ended and listed as patterns.
 */
export const MERGE_CATALOG: { key: string; label: string }[] = [
  { key: "job.code", label: "Job code" },
  { key: "job.name", label: "Job name" },
  { key: "job.type", label: "Job type" },
  { key: "job.status", label: "Job status" },
  { key: "job.origin", label: "Where the job moves from" },
  { key: "job.destination", label: "Where the job moves to" },
  { key: "job.originPath", label: "Origin, full path" },
  { key: "job.destinationPath", label: "Destination, full path" },
  { key: "job.scheduledStart", label: "Scheduled start" },
  { key: "job.scheduledEnd", label: "Scheduled end" },
  { key: "job.startedAt", label: "Started" },
  { key: "job.completedAt", label: "Completed" },
  { key: "job.notes", label: "Job notes" },
  { key: "job.metadata.<key>", label: "Any value stored on the job" },
  { key: "project.code", label: "Project code" },
  { key: "project.name", label: "Project name" },
  { key: "project.client", label: "Project client" },
  { key: "project.startsOn", label: "Project start" },
  { key: "project.endsOn", label: "Project end" },
  { key: "phase.name", label: "Phase" },
  { key: "phase.startsOn", label: "Phase start" },
  { key: "phase.endsOn", label: "Phase end" },
  { key: "manifest.count", label: "Lines on the manifest" },
  { key: "manifest.floors", label: "Floors on the manifest" },
  { key: "manifest.departments", label: "Departments on the manifest" },
  { key: "manifest.packed", label: "Lines packed or further" },
  { key: "manifest.loaded", label: "Lines loaded or further" },
  { key: "manifest.delivered", label: "Lines delivered or further" },
  { key: "manifest.placed", label: "Lines placed" },
  { key: "shipments.count", label: "Number of shipments" },
  { key: "shipments.codes", label: "Shipment codes" },
  { key: "tasks.count", label: "Number of tasks" },
  { key: "tasks.done", label: "Tasks done" },
  { key: "org.name", label: "Organisation name" },
  { key: "app.name", label: "Application name" },
  { key: "document.id", label: "Document id" },
  { key: "document.title", label: "Document title" },
  { key: "today", label: "Today's date (the completion date once completed)" },
  { key: "field.<key>", label: "A value filled in on this document" },
];
