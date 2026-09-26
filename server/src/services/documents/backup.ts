import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  documentCustomFields,
  documentExports,
  documentJobPackets,
  documentPacketTemplates,
  documentPackets,
  documentTemplateVersions,
  documentTemplates,
  documents,
} from "../../db/schema";
import type { Executor } from "./shared";

/**
 * Documents in the instance backup. services/backup.ts lists these tables and
 * calls the functions below, so the backup format stays in one place while the
 * knowledge of these tables stays here.
 *
 * Signatures and exported PDFs are attachments, which the JSON backup leaves
 * out (see docs/media-ai-core.md); a restore over the same database keeps
 * them, and a database dump covers the rest.
 */

/** Parent-before-child order, which is also the insert order. */
export const DOCUMENTS_TABLES = [
  "document_custom_fields",
  "document_templates",
  "document_template_versions",
  "document_packets",
  "document_packet_templates",
  "document_job_packets",
  "documents",
  "document_exports",
] as const;
export type DocumentsTable = (typeof DOCUMENTS_TABLES)[number];

/** Configuration rather than data: kept when restoring a file written before documents existed. */
const CONFIGURATION: DocumentsTable[] = [
  "document_custom_fields",
  "document_templates",
  "document_template_versions",
  "document_packets",
  "document_packet_templates",
];

const TABLE = {
  document_custom_fields: documentCustomFields,
  document_templates: documentTemplates,
  document_template_versions: documentTemplateVersions,
  document_packets: documentPackets,
  document_packet_templates: documentPacketTemplates,
  document_job_packets: documentJobPackets,
  documents,
  document_exports: documentExports,
} as const;

export const DOCUMENTS_DATE_FIELDS: Record<DocumentsTable, string[]> = {
  document_custom_fields: ["createdAt", "updatedAt"],
  document_templates: ["createdAt", "updatedAt"],
  document_template_versions: ["publishedAt", "createdAt", "updatedAt"],
  document_packets: ["createdAt", "updatedAt"],
  document_packet_templates: [],
  document_job_packets: ["attachedAt", "updatedAt"],
  documents: ["completedAt", "signedAt", "createdAt", "updatedAt"],
  document_exports: ["createdAt"],
};

export async function exportDocumentsTables(): Promise<Record<DocumentsTable, Record<string, unknown>[]>> {
  const rows: Record<string, unknown>[][] = await Promise.all(DOCUMENTS_TABLES.map((t) => db.select().from(TABLE[t])));
  const out = {} as Record<DocumentsTable, Record<string, unknown>[]>;
  DOCUMENTS_TABLES.forEach((t, i) => {
    out[t] = rows[i]!;
  });
  return out;
}

/**
 * Replace documents with the snapshot's. Runs after jobs are restored (a
 * document may belong to a job). A file with no templates predates documents:
 * its templates, fields and packets are kept, the way job types are.
 */
export async function restoreDocumentsTables(
  tx: Executor,
  data: Record<DocumentsTable, Record<string, unknown>[]>,
): Promise<void> {
  const keepConfiguration = data.document_templates.length === 0 && data.document_custom_fields.length === 0 && data.document_packets.length === 0;
  for (const t of [...DOCUMENTS_TABLES].reverse()) {
    if (keepConfiguration && CONFIGURATION.includes(t)) continue;
    await tx.delete(TABLE[t]);
  }
  // A document copied from a later one would trip the self-reference, so the
  // links go in after every document is back.
  const copiedFrom = new Map<string, string>();
  const prepared: Partial<Record<DocumentsTable, Record<string, unknown>[]>> = {
    documents: data.documents.map((row) => {
      if (row.copiedFrom) copiedFrom.set(row.id as string, row.copiedFrom as string);
      return { ...row, copiedFrom: null };
    }),
    // Exported PDFs are attachments, which are not in the file. On another
    // database they may not exist; the export stays recorded by its hash.
    document_exports: await withExistingAttachments(tx, data.document_exports),
  };
  for (const t of DOCUMENTS_TABLES) {
    if (keepConfiguration && CONFIGURATION.includes(t)) continue;
    const rows = prepared[t] ?? data[t];
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(TABLE[t]).values(rows.slice(i, i + 500) as never);
    }
  }
  const restored = new Set(data.documents.map((d) => d.id as string));
  for (const [id, from] of copiedFrom) {
    if (restored.has(from)) await tx.update(documents).set({ copiedFrom: from }).where(eq(documents.id, id));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withExistingAttachments(tx: Executor, rows: Record<string, unknown>[]) {
  const ids = [...new Set(rows.map((r) => r.attachmentId).filter((v): v is string => typeof v === "string" && UUID.test(v)))];
  if (!ids.length) return rows;
  const found = await tx.execute<{ id: string }>(sql`SELECT id FROM attachments WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
  const present = new Set(found.rows.map((r) => r.id));
  return rows.map((r) => (typeof r.attachmentId === "string" && !present.has(r.attachmentId) ? { ...r, attachmentId: null } : r));
}
