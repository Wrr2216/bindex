import { logger } from "../../lib/logger";
import type { Actor } from "./shared";

/**
 * Sharing a document outside the instance (with a customer or a third-party
 * crew) belongs to the external portal, which is a separate feature. This is
 * the seam: the portal registers a provider when its module loads, and until
 * one is registered sharing reports itself unavailable and the button stays
 * hidden. Nothing here imports the portal, so either can ship without the
 * other.
 *
 *   registerDocumentShareProvider({
 *     name: "portal",
 *     available: async () => (await getConfig()).features.portal,
 *     share: async ({ documentId, jobId, email, expiresInDays }, actor) => ({ url, expiresAt }),
 *   });
 */

export type ShareRequest = {
  documentId: string;
  jobId: string | null;
  /** Who the link is for, when the provider sends it. */
  email?: string | null;
  expiresInDays?: number;
  /** Let the recipient sign fields that are still unsigned. */
  allowSigning?: boolean;
};

export type ShareResult = { url: string; expiresAt: string | null; message?: string };

export type DocumentShareProvider = {
  name: string;
  /** Checked on every request, so the provider can follow its own feature switch. */
  available: () => boolean | Promise<boolean>;
  share: (request: ShareRequest, actor: Actor) => Promise<ShareResult>;
};

let provider: DocumentShareProvider | null = null;

export function registerDocumentShareProvider(p: DocumentShareProvider): () => void {
  provider = p;
  logger.info("documents.share.provider", { name: p.name });
  return () => {
    if (provider === p) provider = null;
  };
}

export async function shareAvailability(): Promise<{ available: boolean; provider: string | null }> {
  if (!provider) return { available: false, provider: null };
  try {
    return { available: await provider.available(), provider: provider.name };
  } catch {
    return { available: false, provider: provider.name };
  }
}

export async function shareDocument(request: ShareRequest, actor: Actor): Promise<ShareResult | null> {
  const { available } = await shareAvailability();
  if (!provider || !available) return null;
  return provider.share(request, actor);
}
