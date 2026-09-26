import { env } from "../../env";
import { logger } from "../../lib/logger";
import { describeError } from "../../lib/errors";
import { registerEventTypes } from "../event-backbone";
import { readAttachmentBytes, registerOwnerType, renderJpeg } from "../media-ai-core";
import { GUIDE_OWNER, getGuide, guideExists, unitName } from "./guides";
import { bagLabels, teardownReportPdf, type ReportStep } from "./report";

/**
 * T20: teardown guides. A narrated video of something being taken apart
 * becomes numbered steps tied to the moments in the video, a list of the parts
 * detached, a printable report and labels for the hardware bags. See
 * docs/teardown.md.
 */

export * from "./guides";
export { enqueueGuide, cancelGuideJob, kickTeardownWorker, startTeardownWorker, type ProcessMode } from "./worker";
export { ffmpegAvailable } from "./ffmpeg";
export { PART_KINDS } from "./extract";

// Step pictures are attachments of the guide itself, so they go when it does.
registerOwnerType(GUIDE_OWNER, guideExists, { table: "teardown_guides", label: "teardown guide" });

registerEventTypes([
  {
    type: "teardown.guide_created",
    group: "Teardown guides",
    subject: "teardown_guide",
    description: "A teardown guide was started for an item or unit. data: { guideId, itemId, unitId, title, hasVideo }",
  },
  {
    type: "teardown.guide_processed",
    group: "Teardown guides",
    subject: "teardown_guide",
    description:
      "A guide's video finished processing. data: { guideId, itemId, unitId, title, transcribed, steps, parts, draftPending, notes }",
  },
  {
    type: "teardown.reassembly_completed",
    group: "Teardown guides",
    subject: "teardown_guide",
    description: "Every part on a guide was ticked off as refitted. data: { guideId, itemId, unitId, title, parts }",
  },
  {
    type: "teardown.guide_deleted",
    group: "Teardown guides",
    subject: "teardown_guide",
    description: "A teardown guide was deleted. data: { guideId, itemId, unitId, title }",
  },
]);

export const guideUrl = (id: string, step?: number) =>
  `${env.APP_BASE_URL.replace(/\/+$/, "")}/teardown/${id}${step ? `?step=${step}` : ""}`;

/** A step picture scaled for print, or null when it cannot be read. */
async function printablePicture(attachmentId: string, guideId: string): Promise<Buffer | null> {
  try {
    const { bytes } = await readAttachmentBytes(attachmentId, 32 * 1024 * 1024);
    return await renderJpeg(bytes, { maxEdge: 600, quality: 80 });
  } catch (err) {
    logger.warn("teardown.report.picture_failed", { guideId, attachmentId, err: describeError(err) });
    return null;
  }
}

export async function guideReport(id: string, opts: { appName: string; timeZone: string; printedAt?: Date }): Promise<{ pdf: Buffer; title: string }> {
  const g = await getGuide(id);
  const steps: ReportStep[] = [];
  for (const s of g.steps) {
    steps.push({
      n: s.n,
      title: s.title,
      instruction: s.instruction,
      start: s.start,
      end: s.end,
      callout: s.callout,
      picture: s.keyframe ? await printablePicture(s.keyframe.id, g.id) : null,
    });
  }
  const pdf = await teardownReportPdf({
    appName: opts.appName,
    printedAt: opts.printedAt ?? new Date(),
    timeZone: opts.timeZone,
    guideUrl: guideUrl(g.id),
    title: g.title,
    itemName: g.item?.name ?? null,
    itemCode: g.item?.assetCode ?? null,
    unitName: g.unit ? unitName(g.unit) : null,
    durationSec: g.durationSec,
    notes: g.notes,
    steps,
    parts: g.parts.map((p) => ({
      name: p.name,
      kind: p.kind,
      qty: p.qty,
      stepN: p.stepN,
      note: p.note,
      reassembled: p.reassembledAt !== null,
    })),
  });
  return { pdf, title: g.title };
}

export async function guideBagLabels(id: string, onlySteps?: number[] | null) {
  const g = await getGuide(id);
  if (!g.item) return [];
  return bagLabels(
    {
      guideId: g.id,
      baseUrl: env.APP_BASE_URL,
      itemName: g.item.name,
      unitName: g.unit ? unitName(g.unit) : null,
      code: g.unit?.assetCode ?? g.item.assetCode,
      steps: g.steps.map((s) => ({ n: s.n, title: s.title })),
      parts: g.parts,
    },
    onlySteps,
  );
}
