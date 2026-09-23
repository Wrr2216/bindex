import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptRaw = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Each scrypt call holds about 128 MB while it runs, so a burst of sign-in
// attempts could otherwise exhaust memory. Run at most this many at once and
// queue the rest; the queue only costs a closure per waiting request.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function scryptAsync(...args: Parameters<typeof scryptRaw>): Promise<Buffer> {
  // A finishing call hands its slot straight to the next waiter, so a new
  // arrival can never slip in between and push the count over the cap.
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await scryptRaw(...args);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

// scrypt ships with Node, so there is no native module to build and no extra
// dependency to audit. The cost parameters follow the OWASP recommendation of
// N=2^17, r=8, p=1, which takes roughly 100ms on current hardware.
const N = 1 << 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
// scrypt needs about 128 * N * r bytes; Node's default cap is below that.
const MAX_MEM = 256 * N * R;

const PARAMS = { N, r: R, p: P, maxmem: MAX_MEM };

/** Stored form: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, KEY_LEN, PARAMS);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Constant-time check of a password against a stored hash. Returns false for
 * anything it cannot parse rather than throwing, so a corrupt row reads as a
 * failed sign-in instead of a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * Number(n) * Number(r) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) {
    return false;
  }

  const expected = Buffer.from(hashB64, "base64");
  let actual: Buffer;
  try {
    actual = await scryptAsync(
      password.normalize("NFKC"),
      Buffer.from(saltB64, "base64"),
      expected.length,
      cost,
    );
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 10;

/** Null when acceptable, otherwise the reason to show the person typing it. */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 512) return "That password is too long.";
  return null;
}
