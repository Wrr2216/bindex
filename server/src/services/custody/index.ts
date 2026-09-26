import { pool } from "../../db/client";
import { registerEventTypes } from "../event-backbone";
import { registerExceptionStage } from "../jobs-core";
import { registerOwnerType } from "../media-ai-core";
import { registerCustodyGuard } from "./policy";

/**
 * Chain of custody and digital sign-off: the public surface. Importing this
 * module registers what the feature adds to the shared cores (the transfer as
 * an owner of signatures and receipts, the "refused" delivery exception, the
 * custody stage guard, and its event types). docs/custody.md describes it.
 */

registerOwnerType(
  "custody_transfer",
  async (id) => ((await pool.query(`SELECT 1 FROM custody_transfers WHERE id = $1`, [id])).rowCount ?? 0) > 0,
  { table: "custody_transfers", label: "custody transfer" },
);

registerExceptionStage("refused", { label: "Refused", color: "#f97316" });

registerCustodyGuard();

registerEventTypes([
  {
    type: "custody.transferred",
    group: "Custody",
    subject: "custody_transfer",
    description: "A custody handoff or delivery sign-off was completed and signed; carries the list fingerprint and the receipt hash.",
  },
  {
    type: "custody.control_changed",
    group: "Custody",
    subject: "item",
    description: "An item or container was marked, or unmarked, as custody-controlled.",
  },
  {
    type: "custody.voided",
    group: "Custody",
    subject: "custody_transfer",
    description: "An unfinished custody transfer was abandoned.",
  },
  {
    type: "custody.link_issued",
    group: "Custody",
    subject: "custody_transfer",
    description: "A one-time signing link was sent to a party. The token itself is never logged.",
  },
]);

export * from "./model";
export { contentLines, diffLines, itemsHash, transferContent, type ContentLine, type SignedContent } from "./content";
export { covers, currentCustodian, custodyVetoes, linkState } from "./rules";
export { controlsFor, custodyGuard, getControl, setControl } from "./policy";
export {
  MAX_LINES,
  countable,
  createTransfer,
  getTransfer,
  issueLink,
  listTransfers,
  loadTransfer,
  lockTransfer,
  removeLines,
  revokeLink,
  scanIntoTransfer,
  setOutcomes,
  signByLink,
  signTransfer,
  signableContent,
  transferLines,
  updateTransfer,
  voidTransfer,
  type Actor,
  type OutcomeInput,
  type SignerInput,
  type TransferInput,
} from "./transfers";
export { finalizeTransfer, renderReceipt, transferUrl } from "./finalize";
export { itemChain } from "./chain";
export { awaitingSignOff, shipmentReview, startSignOff, type SignOffInput } from "./review";
export { verifyReceiptBytes, verifyTransfer, type VerifyReport } from "./verify";
export { publicPhoto, publicView, transferForToken } from "./public";
export { SIGN_PAGE_SCRIPT, signPageHtml } from "./publicPage";
