import { isSigningType, type FieldDef } from "./model";

/**
 * Filled-in values: checking what someone typed against the field it is for,
 * the required-field rule, and copying from another document. Pure.
 *
 * Values are stored by field key. Signature and initials fields hold
 * `{ signatureId, signerName, signedAt }` and are only ever written by the
 * signing step, never by a save.
 */

export type SignatureValue = { signatureId: string; signerName: string; signerRole?: string | null; signedAt: string };
export type Values = Record<string, unknown>;
export type ValueProblem = { key: string; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 10_000;

const validDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const isSignatureValue = (v: unknown): v is SignatureValue =>
  !!v &&
  typeof v === "object" &&
  typeof (v as SignatureValue).signatureId === "string" &&
  typeof (v as SignatureValue).signerName === "string";

/**
 * The stored form of `raw` for `field`, `undefined` to clear it, or a problem
 * message. Lenient where a browser input is loose (a number typed as "12",
 * a choice in another case), strict where it matters.
 */
export function normalizeValue(field: FieldDef, raw: unknown): { value: unknown } | { problem: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "" && field.type !== "text")) {
    return { value: undefined };
  }
  switch (field.type) {
    case "text": {
      if (typeof raw !== "string") return { problem: "Enter text." };
      if (raw.trim() === "") return { value: undefined };
      if (raw.length > MAX_TEXT) return { problem: `Keep it under ${MAX_TEXT.toLocaleString("en-US")} characters.` };
      return { value: field.multiline ? raw : raw.replace(/[\r\n]+/g, " ") };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim().replace(/,/g, "")) : NaN;
      if (!Number.isFinite(n)) return { problem: "Enter a number." };
      if (field.min !== undefined && n < field.min) return { problem: `Enter ${field.min} or more.` };
      if (field.max !== undefined && n > field.max) return { problem: `Enter ${field.max} or less.` };
      return { value: n };
    }
    case "date": {
      if (typeof raw !== "string" || !validDate(raw.trim())) return { problem: "Enter a date such as 2026-10-01." };
      return { value: raw.trim() };
    }
    case "checkbox": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "false") return { value: raw === "true" };
      return { problem: "Tick or untick the box." };
    }
    case "select": {
      if (typeof raw !== "string") return { problem: "Pick one of the choices." };
      const match = (field.options ?? []).find((o) => o.toLowerCase() === raw.trim().toLowerCase());
      if (!match) return { problem: `Pick one of: ${(field.options ?? []).join(", ")}.` };
      return { value: match };
    }
    case "signature":
    case "initials":
      return { problem: "Signatures are added by signing, not by typing." };
  }
}

/**
 * Apply an autosave. Keys present in `patch` are set (null or empty clears
 * them); keys absent are left alone, so two people filling different fields do
 * not overwrite each other.
 */
export function applyValuesPatch(
  fields: FieldDef[],
  current: Values,
  patch: Values,
): { values: Values; problems: ValueProblem[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const values: Values = { ...current };
  const problems: ValueProblem[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) {
      problems.push({ key, message: "This document has no field with that key." });
      continue;
    }
    const result = normalizeValue(field, raw);
    if ("problem" in result) problems.push({ key, message: result.problem });
    else if (result.value === undefined) delete values[key];
    else values[key] = result.value;
  }
  return { values, problems };
}

/** A required field is filled when it has a value; a required checkbox when it is ticked. */
export function isFilled(field: FieldDef, value: unknown): boolean {
  if (isSigningType(field.type)) return isSignatureValue(value);
  if (field.type === "checkbox") return value === true;
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/**
 * Required fields still empty. `signing: false` leaves out signature and
 * initials fields, which are signed after the document is completed.
 */
export function missingRequired(fields: FieldDef[], values: Values, opts: { signing: boolean }): FieldDef[] {
  return fields.filter(
    (f) => f.required && (opts.signing || !isSigningType(f.type)) && isFilled(f, values[f.key]) === false,
  );
}

/** Everything but signatures: the part of a document that is fixed at completion and hashed. */
export function contentValues(fields: FieldDef[], values: Values): Values {
  const signing = new Set(fields.filter((f) => isSigningType(f.type)).map((f) => f.key));
  const known = new Set(fields.map((f) => f.key));
  const out: Values = {};
  for (const key of Object.keys(values).sort()) {
    if (known.has(key) && !signing.has(key)) out[key] = values[key];
  }
  return out;
}

/** True when nobody has entered anything: safe to withdraw automatically. */
export const isUntouched = (values: Values) => Object.keys(values).length === 0;

export type CopyResult = { values: Values; copied: string[]; skipped: { key: string; reason: string }[] };

/**
 * Fill `target` from another document's values. A value is copied when the
 * target has a field with the same key and it passes that field's rules;
 * signatures never are. Values already entered in the target are kept unless
 * `overwrite`.
 */
export function copyValues(
  targetFields: FieldDef[],
  targetValues: Values,
  sourceValues: Values,
  opts: { overwrite?: boolean } = {},
): CopyResult {
  const values: Values = { ...targetValues };
  const copied: string[] = [];
  const skipped: CopyResult["skipped"] = [];
  const byKey = new Map(targetFields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(sourceValues)) {
    const field = byKey.get(key);
    if (!field) continue;
    if (isSigningType(field.type)) {
      skipped.push({ key, reason: "Signatures are never copied." });
      continue;
    }
    if (!opts.overwrite && values[key] !== undefined) {
      skipped.push({ key, reason: "Already filled in here." });
      continue;
    }
    const result = normalizeValue(field, raw);
    if ("problem" in result) {
      skipped.push({ key, reason: result.problem });
    } else if (result.value !== undefined) {
      values[key] = result.value;
      copied.push(key);
    }
  }
  return { values, copied, skipped };
}
