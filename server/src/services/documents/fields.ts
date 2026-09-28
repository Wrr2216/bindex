import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { documentCustomFields, type DocumentCustomField } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { libraryFieldDef, type FieldDef, type FieldType } from "./model";

/**
 * The custom field library: field definitions an administrator creates once
 * and drops into any template. Keeping one key per meaning ("customer_name")
 * across templates is what lets one document fill in from another.
 */

export type CustomFieldInput = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  multiline?: boolean;
  placeholder?: string | null;
  help?: string | null;
  statement?: string | null;
  min?: number | null;
  max?: number | null;
  active?: boolean;
};

export type CustomField = DocumentCustomField & { definition: FieldDef };

const present = (row: DocumentCustomField): CustomField => ({ ...row, definition: libraryFieldDef(row) });

const CONFIG_KEYS = ["options", "multiline", "placeholder", "help", "statement", "min", "max"] as const;

function configFrom(input: Partial<CustomFieldInput>, type: FieldType, current: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = { ...current };
  for (const key of CONFIG_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) delete config[key];
    else config[key] = typeof v === "string" ? v.trim() : v;
  }
  if (type === "select") {
    const options = Array.isArray(config.options) ? (config.options as string[]).map((o) => o.trim()).filter(Boolean) : [];
    if (!options.length) throw badRequest("A list field needs at least one choice.");
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw badRequest("Each choice can be listed once.");
    config.options = options;
  } else delete config.options;
  if (type !== "text") delete config.multiline;
  if (type !== "number") {
    delete config.min;
    delete config.max;
  } else if (typeof config.min === "number" && typeof config.max === "number" && config.min > config.max) {
    throw badRequest("The minimum is above the maximum.");
  }
  if (type !== "signature" && type !== "initials") delete config.statement;
  return config;
}

const keyTaken = (err: unknown) => isUniqueViolation(err, "uq_document_custom_fields_key");

export async function listCustomFields(opts: { includeInactive?: boolean } = {}): Promise<CustomField[]> {
  const rows = await db
    .select()
    .from(documentCustomFields)
    .where(opts.includeInactive ? undefined : eq(documentCustomFields.active, true))
    .orderBy(asc(documentCustomFields.label));
  return rows.map(present);
}

export async function createCustomField(input: CustomFieldInput): Promise<CustomField> {
  try {
    const [row] = await db
      .insert(documentCustomFields)
      .values({
        key: input.key,
        label: input.label.trim(),
        type: input.type,
        required: input.required ?? false,
        config: configFrom(input, input.type),
        active: input.active ?? true,
      })
      .returning();
    return present(row!);
  } catch (err) {
    if (keyTaken(err)) throw conflict(`There is already a field with the key "${input.key}". Use that one, or pick another key.`);
    throw err;
  }
}

export async function updateCustomField(id: string, patch: Partial<CustomFieldInput>): Promise<CustomField> {
  const [current] = await db.select().from(documentCustomFields).where(eq(documentCustomFields.id, id)).limit(1);
  if (!current) throw notFound("Field not found");
  const type = (patch.type ?? current.type) as FieldType;
  const set: Partial<typeof documentCustomFields.$inferInsert> = {
    updatedAt: new Date(),
    config: configFrom(patch, type, current.config),
  };
  if (patch.key !== undefined) set.key = patch.key;
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.required !== undefined) set.required = patch.required;
  if (patch.active !== undefined) set.active = patch.active;
  try {
    const [row] = await db.update(documentCustomFields).set(set).where(eq(documentCustomFields.id, id)).returning();
    return present(row!);
  } catch (err) {
    if (keyTaken(err)) throw conflict(`There is already a field with the key "${patch.key}".`);
    throw err;
  }
}

/** Templates keep their copies of the definition, so removing it from the library breaks nothing. */
export async function deleteCustomField(id: string): Promise<void> {
  const deleted = await db.delete(documentCustomFields).where(eq(documentCustomFields.id, id)).returning({ id: documentCustomFields.id });
  if (!deleted.length) throw notFound("Field not found");
}
