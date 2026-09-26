import { formatValue, resolveMerge, type Formatting, type MergeContext } from "./merge";
import type { Block, FieldDef } from "./model";
import { MAX_TABLE_ROWS, tableSource, type TableColumn, type TableData } from "./sources";
import { isFilled, isSignatureValue, type SignatureValue, type Values } from "./values";

/**
 * A template plus data, resolved into what is shown: merge fields replaced,
 * values formatted, tables filled. The fill screen, the preview and the PDF
 * all draw from this one model, so they cannot disagree. Pure.
 */

/** Job data frozen when a document is completed. */
export type Snapshot = {
  /** Merge context without the document's own fields. */
  context: MergeContext;
  /** Table rows by block id. */
  tables: Record<string, TableData>;
  /** YYYY-MM-DD: what {{today}} printed on completion. */
  today: string;
  capturedAt: string;
};

export type RenderBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; type: "paragraph"; text: string }
  | {
      id: string;
      type: "field";
      field: FieldDef;
      value: unknown;
      /** The value as printed. */
      display: string;
      filled: boolean;
      signature: SignatureValue | null;
    }
  | {
      id: string;
      type: "table";
      title: string | null;
      columns: TableColumn[];
      rows: string[][];
      total: number;
      truncated: boolean;
      emptyText: string;
    }
  | { id: string; type: "divider" };

export type RenderModel = {
  title: string;
  blocks: RenderBlock[];
  /** Placeholders that matched nothing, for the editor to point out. */
  unknown: string[];
};

export type RenderInput = {
  /** The version's title, which may hold merge fields. */
  title: string;
  body: Block[];
  values: Values;
  context: MergeContext;
  tables: Record<string, TableData>;
  today: string;
  document: { id: string; title: string } | null;
  fmt: Formatting;
};

/** Field values as merge fields print them, keyed like the fields. */
function fieldContext(body: Block[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of body) {
    if (b.type === "field") out[b.field.key] = values[b.field.key] ?? null;
  }
  return out;
}

export function buildRenderModel(input: RenderInput): RenderModel {
  const unknown = new Set<string>();
  const ctx: MergeContext = {
    ...input.context,
    today: input.today,
    document: input.document ?? { id: "", title: "" },
    field: fieldContext(input.body, input.values),
  };
  const merge = (text: string) => {
    const r = resolveMerge(text, ctx, input.fmt);
    for (const u of r.unknown) unknown.add(u);
    return r.text;
  };

  const blocks: RenderBlock[] = input.body.map((block): RenderBlock => {
    switch (block.type) {
      case "heading":
        return { id: block.id, type: "heading", level: block.level ?? 2, text: merge(block.text) };
      case "paragraph":
        return { id: block.id, type: "paragraph", text: merge(block.text) };
      case "divider":
        return { id: block.id, type: "divider" };
      case "field": {
        const value = input.values[block.field.key];
        const signature = isSignatureValue(value) ? value : null;
        return {
          id: block.id,
          type: "field",
          field: block.field,
          value: value ?? null,
          display: formatValue(value, input.fmt),
          filled: isFilled(block.field, value),
          signature,
        };
      }
      case "table": {
        const source = tableSource(block.source);
        const columns = block.columns.map(
          (key) => source?.columns.find((c) => c.key === key) ?? { key, label: key },
        );
        const data = input.tables[block.id] ?? { rows: [], total: 0 };
        const rows = data.rows.slice(0, MAX_TABLE_ROWS).map((row) => columns.map((c) => formatValue(row[c.key], input.fmt)));
        return {
          id: block.id,
          type: "table",
          title: block.title ? merge(block.title) : null,
          columns,
          rows,
          total: data.total,
          truncated: data.total > rows.length,
          emptyText: block.emptyText || "Nothing to list.",
        };
      }
    }
  });

  return { title: merge(input.title), blocks, unknown: [...unknown] };
}
