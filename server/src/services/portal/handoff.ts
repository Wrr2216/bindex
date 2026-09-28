/**
 * What a crew signs when it hands over: the lines of its shipment or job and
 * the stage each had reached at that moment. Pure, so the same content can be
 * rebuilt to verify a signature (see verifySignature in media-ai-core).
 */

export const HANDOFF_STATEMENT =
  "I confirm that the items listed were at the stages shown when I signed, and that the condition notes and photos I added are accurate.";

export type HandoffLine = { id: string; code: string; name: string; stage: string };

export type HandoffInput = {
  grant: { id: string; granteeName: string; granteeOrg: string | null };
  owner: { kind: "job" | "shipment"; id: string; code: string; name: string };
  lines: HandoffLine[];
};

export function handoffContent(input: HandoffInput) {
  // Sorted by id: array order is part of the signed hash, and this keeps it
  // independent of the order the database happened to return.
  const lines = [...input.lines]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => ({ id: l.id, code: l.code, name: l.name, stage: l.stage }));
  const byStage: Record<string, number> = {};
  for (const l of lines) byStage[l.stage] = (byStage[l.stage] ?? 0) + 1;
  return {
    type: "bindex.portal.handoff",
    version: 1,
    grant: { id: input.grant.id, name: input.grant.granteeName, org: input.grant.granteeOrg },
    owner: input.owner,
    count: lines.length,
    byStage,
    lines,
  };
}

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/;

/** The drawn signature from a data URL, or null when there is none or it is not an image. */
export function signatureImage(dataUrl: string | null | undefined): Buffer | null {
  if (!dataUrl) return null;
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const bytes = Buffer.from(m[2]!.replace(/\s/g, ""), "base64");
  return bytes.length ? bytes : null;
}
