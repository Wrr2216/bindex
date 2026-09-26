import type { FindingSeverity, InspectionKind } from "../../db/schema";
import type { Comparison, PairingFinding } from "./pairing";

/**
 * What a signer attests to, as plain JSON for T02's sign() and
 * verifySignature(). Built the same way every time from the stored record, so
 * verifying later is a matter of calling this again.
 *
 * Only what the signer saw and agreed to is in it: the site as named, the
 * findings with the fingerprints of their photos, and for a post-inspection
 * the comparison. Timestamps and status are left out on purpose: reopening
 * and completing again without changing anything must not break a signature,
 * while editing a finding, deleting a photo or changing the pre-inspection it
 * is compared with must.
 */

export type ContentFinding = PairingFinding & {
  area: string;
  /** sha256 of each photo, in the order the finding lists them; null for one that is gone. */
  photos: (string | null)[];
};

export type ContentInput = {
  inspection: {
    id: string;
    code: string;
    kind: InspectionKind;
    siteName: string;
    locationId: string | null;
    jobId: string | null;
    preInspectionId: string | null;
    inspectors: string[];
    notes: string | null;
  };
  findings: ContentFinding[];
  comparison: Comparison<ContentFinding> | null;
};

export const CONTENT_FORMAT = "bindex.inspection/1";

export function buildSignContent(input: ContentInput) {
  const { inspection: i } = input;
  const findings = [...input.findings].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return {
    format: CONTENT_FORMAT,
    inspection: {
      id: i.id,
      code: i.code,
      kind: i.kind,
      site: i.siteName,
      locationId: i.locationId,
      jobId: i.jobId,
      preInspectionId: i.preInspectionId,
      inspectors: i.inspectors,
      notes: i.notes,
    },
    findings: findings.map((f) => ({
      id: f.id,
      area: f.area,
      room: f.room,
      locationId: f.locationId,
      spot: f.spot,
      spotDetail: f.spotDetail,
      description: f.description,
      severity: f.severity as FindingSeverity,
      preExisting: f.preExisting,
      photos: f.photos,
    })),
    comparison: input.comparison
      ? {
          counts: input.comparison.counts,
          entries: input.comparison.entries.map((e) => ({
            change: e.change,
            pre: e.pre?.id ?? null,
            post: e.post?.id ?? null,
            // The pre-inspection finding's words are part of what "unchanged"
            // or "worsened" means, so they are signed too.
            preSeverity: e.pre?.severity ?? null,
            preDescription: e.pre?.description ?? null,
            notedPreExisting: e.notedPreExisting,
          })),
        }
      : null,
  };
}

export type SignContent = ReturnType<typeof buildSignContent>;
