import type { CrewCredentialType, CrewWorker } from "../../db/schema";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { mergeVerified } from "./credentials";
import { normalizeVerifierReply } from "./model";

/**
 * An optional external verifier: a background-check provider, a union
 * compliance service, or a small adapter in front of one. When
 * CREDENTIAL_VERIFY_URL is set, every badge scan asks it about the worker and
 * the answer is merged into their credentials before compliance is judged.
 *
 *   POST <CREDENTIAL_VERIFY_URL>
 *   Authorization: Bearer <CREDENTIAL_VERIFY_TOKEN>      (when set)
 *   { "badgeCode": "CRW-7F3K2A", "worker": { "id", "name", "company" }, "credentialTypes": ["forklift", …] }
 *
 *   200 { "credentials": [{ "type": "background_check", "status": "clear", "expiresOn": "2027-01-31" }] }
 *   404 the verifier does not know this badge (nothing is merged)
 *
 * It degrades quietly: unset, it reports available: false; slow, down or
 * answering nonsense, the check-in goes ahead on what is already on file and
 * the result says the verifier could not be reached.
 */

export type VerifierResult = {
  available: boolean;
  ok: boolean;
  /** The verifier knew this badge. */
  found: boolean;
  /** Credentials whose status or expiry changed. */
  merged: number;
  /** Type keys the verifier sent that this instance has no type for. */
  unmatched: string[];
  error: string | null;
  checkedAt: string | null;
};

const UNAVAILABLE: VerifierResult = {
  available: false,
  ok: false,
  found: false,
  merged: 0,
  unmatched: [],
  error: null,
  checkedAt: null,
};

const MAX_REPLY_BYTES = 256 * 1024;

let warnedBadUrl = false;

function target(): URL | null {
  const raw = env.CREDENTIAL_VERIFY_URL.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Reported once below.
  }
  if (!warnedBadUrl) {
    warnedBadUrl = true;
    logger.warn("crew.verify.bad_url", { hint: "CREDENTIAL_VERIFY_URL must be an http(s) URL; the verifier is off" });
  }
  return null;
}

export const verifierAvailable = (): boolean => target() !== null;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel();
      throw new Error(`reply larger than ${MAX_REPLY_BYTES} bytes`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function verifyWorker(worker: CrewWorker, types: Map<string, CrewCredentialType>): Promise<VerifierResult> {
  const url = target();
  if (!url) return UNAVAILABLE;
  const checkedAt = new Date().toISOString();
  const fail = (error: string, extra: Record<string, unknown> = {}): VerifierResult => {
    logger.warn("crew.verify.failed", { workerId: worker.id, host: url.host, error, ...extra });
    return { ...UNAVAILABLE, available: true, error, checkedAt };
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Bindex-Crew/1",
        ...(env.CREDENTIAL_VERIFY_TOKEN ? { Authorization: `Bearer ${env.CREDENTIAL_VERIFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        badgeCode: worker.badgeCode,
        worker: { id: worker.id, name: worker.name, company: worker.company },
        credentialTypes: [...types.values()].filter((t) => t.active).map((t) => t.key),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(env.CREDENTIAL_VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(timedOut ? "The verifier did not answer in time." : "The verifier could not be reached.", {
      err: describeError(err),
    });
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    logger.info("crew.verify.unknown_badge", { workerId: worker.id });
    return { available: true, ok: true, found: false, merged: 0, unmatched: [], error: null, checkedAt };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return fail(`The verifier answered ${res.status}.`, { status: res.status });
  }
  let body: unknown;
  try {
    body = JSON.parse(await readCapped(res));
  } catch (err) {
    return fail("The verifier's answer was not JSON.", { err: describeError(err) });
  }
  const { credentials, unmatched } = normalizeVerifierReply(body, new Set(types.keys()));
  let merged = 0;
  try {
    merged = await mergeVerified(worker.id, credentials, types);
  } catch (err) {
    return fail("The verifier's answer could not be saved.", { err: describeError(err) });
  }
  if (unmatched.length) logger.info("crew.verify.unmatched", { workerId: worker.id, unmatched });
  return { available: true, ok: true, found: true, merged, unmatched, error: null, checkedAt };
}
