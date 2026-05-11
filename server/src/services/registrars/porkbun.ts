import { env } from "../../env";
import type { RegistrarDomain } from "./types";

/** Porkbun v3 API client (read-only): every call is a POST carrying the keys. */

const BASE = "https://api.porkbun.com/api/json/v3";

type RawDomain = {
  domain: string;
  status?: string;
  expireDate?: string; // "2027-03-04 05:00:00" (UTC)
  autoRenew?: number | string; // 1/0 or "1"/"0"
  whoisPrivacy?: number | string;
};

type ListAllResponse = { status: string; message?: string; domains?: RawDomain[] };

/** Porkbun dates are UTC without a timezone marker. */
function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const asBool = (v: number | string | undefined): boolean | null =>
  v == null ? null : String(v) === "1";

/** All domains on the Porkbun account (chunked by 1000 via `start`). */
export async function getPorkbunDomains(): Promise<RegistrarDomain[]> {
  const out: RegistrarDomain[] = [];
  for (let start = 0; start < 100_000; start += 1000) {
    const resp = await fetch(`${BASE}/domain/listAll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: env.PORKBUN_API_KEY,
        secretapikey: env.PORKBUN_SECRET_KEY,
        start: String(start),
      }),
    });
    const body = (await resp.json().catch(() => null)) as ListAllResponse | null;
    if (!resp.ok || body?.status !== "SUCCESS") {
      throw new Error(`Porkbun listAll failed: ${body?.message || `HTTP ${resp.status}`}`);
    }
    const page = body.domains ?? [];
    for (const d of page) {
      out.push({
        name: d.domain.toLowerCase(),
        registrar: "porkbun",
        status: d.status ?? null,
        expiresAt: parseDate(d.expireDate),
        autoRenew: asBool(d.autoRenew),
        whoisPrivacy: asBool(d.whoisPrivacy),
      });
    }
    if (page.length < 1000) break;
  }
  return out;
}
