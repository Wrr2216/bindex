import { actorFromOid, publish, registerEventTypes } from "../event-backbone";
import type { Actor } from "./shared";

/**
 * Document events on the event backbone: they land in the tamper-evident audit
 * log and in front of webhooks. Published after the change commits; publish()
 * never throws, so a failure to record never fails the change.
 */

registerEventTypes([
  { type: "document.created", group: "Documents", subject: "document", description: "A document was started from a template." },
  { type: "document.completed", group: "Documents", subject: "document", description: "A document was completed: its values are fixed and hashed." },
  { type: "document.reopened", group: "Documents", subject: "document", description: "A completed, unsigned document went back to draft." },
  { type: "document.signed", group: "Documents", subject: "document", description: "A signature or initials were added to a document." },
  { type: "document.exported", group: "Documents", subject: "document", description: "A completed document was exported as a PDF; carries the file's sha256." },
  { type: "document.deleted", group: "Documents", subject: "document", description: "A document was deleted." },
  { type: "document_packet.attached", group: "Documents", subject: "job", description: "A packet of documents was attached to a job." },
  { type: "document_packet.withdrawn", group: "Documents", subject: "job", description: "A packet stopped applying to a job; its untouched documents were removed." },
  { type: "document_template.published", group: "Documents", subject: "document_template", description: "A new version of a document template was published." },
]);

export function emitDocumentEvent(
  type: string,
  subject: { type: string; id: string },
  data: Record<string, unknown>,
  actor: Actor,
): Promise<unknown> {
  return publish(type, data, { actor: actorFromOid(actor.userOid, actor.name ?? null), subject });
}
