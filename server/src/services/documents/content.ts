import { contentHash } from "../media-ai-core";
import type { Snapshot } from "./layout";
import type { FieldDef } from "./model";
import { contentValues, type Values } from "./values";

/**
 * What a completed document says, as plain JSON, and its fingerprint.
 *
 * The content is the template version, the title, every value except
 * signatures, and the job data snapshot taken at completion. Its canonical
 * sha256 (the same canonical form signatures use) is stored on the document
 * and printed in the PDF footer, so a printed copy can be checked against
 * the record.
 *
 * Each signature signs a small statement that names this hash and the field
 * it fills, so a signature cannot be moved to another field or document, and
 * any later change to the content breaks every signature on it.
 */

export type ContentInput = {
  documentId: string;
  templateId: string;
  templateVersionId: string;
  version: number;
  title: string;
  fields: FieldDef[];
  values: Values;
  snapshot: Snapshot | null;
};

export function documentContent(input: ContentInput) {
  return {
    kind: "bindex.document",
    documentId: input.documentId,
    template: { id: input.templateId, versionId: input.templateVersionId, version: input.version },
    title: input.title,
    values: contentValues(input.fields, input.values),
    snapshot: input.snapshot,
  };
}

export const documentContentHash = (input: ContentInput): string => contentHash(documentContent(input));

/** Exactly what a signature on `fieldKey` signs. The client passes it to the signing dialog. */
export function signingContent(documentId: string, templateVersionId: string, hash: string, fieldKey: string) {
  return { kind: "bindex.document.signature", documentId, templateVersionId, contentHash: hash, field: fieldKey };
}
