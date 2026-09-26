import { z } from "zod";
import { tableSource } from "./sources";

/**
 * The shape of a template: an ordered list of blocks. Pure, so the editor's
 * rules and the renderer can be tested without a database.
 *
 * A field block carries its whole definition. Fields inserted from the custom
 * field library are copied in (with `libraryId` to say where from), so a
 * published version never changes when the library does.
 */

export const FIELD_TYPES = ["text", "number", "date", "checkbox", "select", "signature", "initials"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const BLOCK_TYPES = ["heading", "paragraph", "field", "table", "divider"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const DOCUMENT_STATUSES = ["draft", "completed", "signed"] as const;

/** Signature and initials are drawn through the signing dialog, never typed. */
export const isSigningType = (type: FieldType | string) => type === "signature" || type === "initials";

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const MAX_BLOCKS = 300;

const trimmed = (max: number) => z.string().trim().max(max);

export const fieldDefSchema = z.object({
  key: z.string().regex(FIELD_KEY, "Field keys are lowercase letters, digits and underscores, starting with a letter"),
  label: trimmed(200).min(1, "Every field needs a label"),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(trimmed(200).min(1)).max(100).optional(),
  multiline: z.boolean().optional(),
  placeholder: trimmed(200).optional(),
  help: trimmed(500).optional(),
  /** Signature and initials: the words the signer agrees to. */
  statement: trimmed(2000).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  libraryId: z.string().uuid().optional(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

const tableFilterSchema = z
  .object({
    floor: trimmed(100).optional(),
    department: trimmed(100).optional(),
    stage: trimmed(40).optional(),
  })
  .optional();

export const blockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().regex(BLOCK_ID),
    type: z.literal("heading"),
    text: trimmed(500),
    /** 1 to 3; 2 when left out. */
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
  z.object({ id: z.string().regex(BLOCK_ID), type: z.literal("paragraph"), text: z.string().max(20000) }),
  z.object({ id: z.string().regex(BLOCK_ID), type: z.literal("field"), field: fieldDefSchema }),
  z.object({
    id: z.string().regex(BLOCK_ID),
    type: z.literal("table"),
    source: z.string().min(1).max(40),
    columns: z.array(z.string().min(1).max(40)).min(1).max(20),
    title: trimmed(200).optional(),
    filter: tableFilterSchema,
    emptyText: trimmed(200).optional(),
  }),
  z.object({ id: z.string().regex(BLOCK_ID), type: z.literal("divider") }),
]);
export type Block = z.infer<typeof blockSchema>;
export type FieldBlock = Extract<Block, { type: "field" }>;
export type TableBlock = Extract<Block, { type: "table" }>;

export const bodySchema = z.array(blockSchema).max(MAX_BLOCKS, `A template holds at most ${MAX_BLOCKS} blocks`);

export type BodyProblem = { blockId: string | null; message: string };

/**
 * Rules zod cannot express: unique ids and keys, options a select needs,
 * tables over a known source and its columns. `publishing` adds the rules that
 * only matter once people fill it in.
 */
export function checkBody(body: Block[], opts: { publishing?: boolean } = {}): BodyProblem[] {
  const problems: BodyProblem[] = [];
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const block of body) {
    if (ids.has(block.id)) problems.push({ blockId: block.id, message: `Two blocks share the id "${block.id}".` });
    ids.add(block.id);
    if (block.type === "field") {
      const f = block.field;
      const other = keys.get(f.key);
      if (other) {
        problems.push({ blockId: block.id, message: `"${f.label}" uses the key "${f.key}", which "${other}" already uses.` });
      } else keys.set(f.key, f.label);
      if (f.type === "select") {
        const options = f.options ?? [];
        if (options.length === 0) problems.push({ blockId: block.id, message: `"${f.label}" is a list with no choices. Add at least one.` });
        if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
          problems.push({ blockId: block.id, message: `"${f.label}" lists the same choice twice.` });
        }
      }
      if (f.type === "number" && f.min !== undefined && f.max !== undefined && f.min > f.max) {
        problems.push({ blockId: block.id, message: `"${f.label}" has a minimum above its maximum.` });
      }
    }
    if (block.type === "table") {
      const source = tableSource(block.source);
      if (!source) {
        problems.push({ blockId: block.id, message: `There is no table source called "${block.source}".` });
        continue;
      }
      const known = new Set(source.columns.map((c) => c.key));
      for (const col of block.columns) {
        if (!known.has(col)) problems.push({ blockId: block.id, message: `The ${source.label} table has no column "${col}".` });
      }
    }
  }
  if (opts.publishing && body.length === 0) problems.push({ blockId: null, message: "Add at least one block before publishing." });
  return problems;
}

export const fieldsOf = (body: Block[]): FieldDef[] =>
  body.flatMap((b) => (b.type === "field" ? [b.field] : []));

/** A library entry as a field definition, ready to drop into a block. */
export function libraryFieldDef(row: {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  config: Record<string, unknown>;
}): FieldDef {
  const c = row.config;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const def: FieldDef = {
    key: row.key,
    label: row.label,
    type: row.type as FieldType,
    required: row.required,
    libraryId: row.id,
  };
  if (Array.isArray(c.options)) def.options = c.options.filter((o): o is string => typeof o === "string");
  if (c.multiline === true) def.multiline = true;
  const placeholder = str(c.placeholder);
  if (placeholder) def.placeholder = placeholder;
  const help = str(c.help);
  if (help) def.help = help;
  const statement = str(c.statement);
  if (statement) def.statement = statement;
  if (num(c.min) !== undefined) def.min = num(c.min);
  if (num(c.max) !== undefined) def.max = num(c.max);
  return def;
}

export const DEFAULT_SIGN_STATEMENT = "I confirm that the information in this document is correct.";
export const DEFAULT_INITIALS_STATEMENT = "I have read this section.";

export const statementFor = (field: FieldDef) =>
  field.statement?.trim() || (field.type === "initials" ? DEFAULT_INITIALS_STATEMENT : DEFAULT_SIGN_STATEMENT);
