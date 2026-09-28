import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { onJobChanged } from "../jobs-core";
import { registerOwnerType } from "../media-ai-core";
import { pool } from "../../db/client";
import { syncJobPackets } from "./packets";

/**
 * Where documents plug into the rest of the app, registered once when this
 * module loads (the documents router imports it):
 *
 * - "document" is an owner type for attachments and signatures, so the
 *   signing dialog can sign against a document and exported PDFs are kept on
 *   it; the orphan sweep removes them when a document is deleted.
 * - Every job create and update runs the packet sync, which attaches packets
 *   the job now matches (a new "IT relocation" job gets its packet) and
 *   withdraws untouched ones it no longer does (its type changed).
 */

let wired = false;

export function wireDocuments(): void {
  if (wired) return;
  wired = true;

  registerOwnerType(
    "document",
    async (id) => {
      const { rowCount } = await pool.query("SELECT 1 FROM documents WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
    { table: "documents", label: "document" },
  );

  onJobChanged(async ({ job, userOid }) => {
    try {
      await syncJobPackets(job.id, { userOid });
    } catch (err) {
      // The job change itself has already been saved; say so and move on.
      logger.warn("documents.packet.sync_failed", { jobId: job.id, err: describeError(err) });
    }
  });
}

wireDocuments();
