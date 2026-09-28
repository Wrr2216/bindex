import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { documentExports, documents, jobs, type DocumentRow } from "../../db/schema";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getConfig } from "../config";
import { getSignature, readAttachmentBytes, saveAttachment } from "../media-ai-core";
import { formatting, loadDocument, renderModel, verifyDocument, type VerifyReport } from "./documents";
import { emitDocumentEvent } from "./events";
import { formatValue } from "./merge";
import { fieldsOf, isSigningType } from "./model";
import { renderDocumentPdf } from "./pdf";
import type { Actor } from "./shared";
import { getVersion, loadTemplate } from "./templates";
import { isSignatureValue } from "./values";

/**
 * PDFs of documents, and checking a PDF that turns up later.
 *
 * A draft prints marked as a draft and is not recorded. A completed or signed
 * document's PDF is recorded by the sha256 of its bytes (and kept as an
 * attachment of the document), so anyone holding a copy can upload it and be
 * told which document it is, what state it was in, and whether the document
 * still matches. Rendering is deterministic, so exporting the same state
 * again gives the same bytes and the same record.
 */

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const MAX_SIGNATURE_BYTES = 1024 * 1024;

async function signatureImages(doc: DocumentRow, keys: string[]): Promise<Map<string, Buffer>> {
  const images = new Map<string, Buffer>();
  for (const key of keys) {
    const value = doc.values[key];
    if (!isSignatureValue(value)) continue;
    try {
      const sig = await getSignature(value.signatureId);
      if (sig?.attachmentId) images.set(value.signatureId, (await readAttachmentBytes(sig.attachmentId, MAX_SIGNATURE_BYTES)).bytes);
    } catch (err) {
      // The PDF prints the signer's name instead of a missing image.
      logger.warn("documents.pdf.signature_image_failed", { documentId: doc.id, signatureId: value.signatureId, err: describeError(err) });
    }
  }
  return images;
}

/** A file name people recognise: the title, tidied, and the start of the id. */
export function pdfFilename(title: string, id: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "document"}-${id.slice(0, 8)}.pdf`;
}

export type PdfResult = { bytes: Buffer; sha256: string; filename: string; exportId: string | null; recorded: boolean };

export async function documentPdf(id: string, opts: { timeZone?: string; actor: Actor }): Promise<PdfResult> {
  const doc = await loadDocument(id);
  const [version, template, fmt, config] = await Promise.all([
    getVersion(doc.templateVersionId),
    loadTemplate(doc.templateId),
    formatting(opts.timeZone),
    getConfig(),
  ]);
  const fields = fieldsOf(version.body);
  const signingFields = fields.filter((f) => isSigningType(f.type));
  const [model, images, job] = await Promise.all([
    renderModel(doc, version, fmt),
    signatureImages(doc, signingFields.map((f) => f.key)),
    doc.jobId ? db.select({ code: jobs.code, name: jobs.name }).from(jobs).where(eq(jobs.id, doc.jobId)).then((r) => r[0] ?? null) : null,
  ]);

  const record: [string, string][] = [];
  const signedTimes: string[] = [];
  if (doc.status !== "draft") {
    record.push(["Status", doc.status === "signed" ? "Signed" : "Completed"]);
    if (doc.completedAt) record.push(["Completed", `${formatValue(doc.completedAt, fmt)}${doc.completedBy ? ` by ${doc.completedBy}` : ""}`]);
    for (const f of signingFields) {
      const v = doc.values[f.key];
      if (!isSignatureValue(v)) continue;
      signedTimes.push(v.signedAt);
      record.push([f.label, `${v.signerName}${v.signerRole ? `, ${v.signerRole}` : ""} - ${formatValue(v.signedAt, fmt)} - signature ${v.signatureId}`]);
    }
    record.push(["Template", `${template.name}, version ${version.version}`]);
    record.push(["Document id", doc.id]);
    record.push(["Content sha256", doc.contentHash ?? ""]);
  }
  // The PDF's own dates come from the document, never the clock, so one state
  // always renders to the same bytes.
  const at = new Date(
    [doc.completedAt?.toISOString(), ...signedTimes].filter(Boolean).sort().pop() ?? doc.updatedAt.toISOString(),
  );
  const bytes = await renderDocumentPdf({
    model,
    documentId: doc.id,
    status: doc.status,
    contentHash: doc.contentHash,
    kicker: config.orgName || config.appName,
    details: [job ? `Job ${job.code} - ${job.name}` : null, `${template.name}, version ${version.version}`].filter((l): l is string => !!l),
    record,
    signatureImages: images,
    at,
    fmt,
  });
  const hash = sha256(bytes);
  const filename = pdfFilename(model.title || doc.title, doc.id);
  if (doc.status === "draft" || !doc.contentHash) return { bytes, sha256: hash, filename, exportId: null, recorded: false };

  const [existing] = await db
    .select({ id: documentExports.id })
    .from(documentExports)
    .where(and(eq(documentExports.documentId, doc.id), eq(documentExports.sha256, hash)))
    .limit(1);
  if (existing) return { bytes, sha256: hash, filename, exportId: existing.id, recorded: true };

  const attachment = await saveAttachment({
    ownerType: "document",
    ownerId: doc.id,
    kind: "document",
    mime: "application/pdf",
    bytes,
    stage: "export",
    caption: `PDF export (${doc.status})`,
    meta: { filename, sha256: hash, contentHash: doc.contentHash, documentStatus: doc.status },
    createdBy: opts.actor.userOid,
  }).catch((err) => {
    // The export is still recorded by hash; only the stored copy is missing.
    logger.warn("documents.export.store_failed", { documentId: doc.id, err: describeError(err) });
    return null;
  });
  const [row] = await db
    .insert(documentExports)
    .values({
      documentId: doc.id,
      sha256: hash,
      contentHash: doc.contentHash,
      status: doc.status,
      sizeBytes: bytes.length,
      attachmentId: attachment?.id ?? null,
      createdBy: opts.actor.userOid,
    })
    .returning({ id: documentExports.id });
  logger.info("documents.export.recorded", { documentId: doc.id, sha256: hash, bytes: bytes.length });
  await emitDocumentEvent(
    "document.exported",
    { type: "document", id: doc.id },
    { title: doc.title, sha256: hash, contentHash: doc.contentHash, status: doc.status, exportId: row!.id },
    opts.actor,
  );
  return { bytes, sha256: hash, filename, exportId: row!.id, recorded: true };
}

export type PdfCheck = {
  sha256: string;
  found: boolean;
  exports: { id: string; documentId: string; title: string; status: string; contentHash: string; createdAt: Date }[];
  /** The document as it is now, for the first match. */
  document: (VerifyReport & { title: string; exportedContentStillCurrent: boolean }) | null;
};

/** Which recorded export a PDF is, if any, and whether its document still matches. */
export async function verifyPdf(bytes: Buffer): Promise<PdfCheck> {
  const hash = sha256(bytes);
  const rows = await db
    .select({
      id: documentExports.id,
      documentId: documentExports.documentId,
      title: documents.title,
      status: documentExports.status,
      contentHash: documentExports.contentHash,
      createdAt: documentExports.createdAt,
    })
    .from(documentExports)
    .innerJoin(documents, eq(documentExports.documentId, documents.id))
    .where(eq(documentExports.sha256, hash))
    .orderBy(desc(documentExports.createdAt));
  if (!rows.length) return { sha256: hash, found: false, exports: [], document: null };
  const first = rows[0]!;
  const report = await verifyDocument(first.documentId);
  return {
    sha256: hash,
    found: true,
    exports: rows,
    document: {
      ...report,
      title: first.title,
      exportedContentStillCurrent: report.content.currentHash === first.contentHash,
    },
  };
}
