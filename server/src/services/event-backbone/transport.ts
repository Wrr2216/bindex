import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isBlockedHost } from "../images";

/**
 * The one outbound HTTP call webhooks make. node:http rather than fetch,
 * because it lets the address check run on the IP actually connected to: a
 * hostname that resolves to 10.0.0.5, or that changes its answer between a
 * check and the connection, is refused all the same.
 */

/**
 * Private, loopback, link-local and otherwise non-public addresses.
 *
 * IP literals go through isBlockedHost, shared with the image proxy, plus the
 * ranges it leaves out. Hostnames only get the name rules here: isBlockedHost
 * matches prefixes such as "fd" and "10." that would also catch public names
 * like fdx.example, and a name's real addresses are checked at connect time.
 */
export function isBlockedAddress(address: string): boolean {
  let a = address.toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (net.isIP(a) === 0) {
    return a === "localhost" || a.endsWith(".localhost") || a.endsWith(".local") || a.endsWith(".internal");
  }
  // An IPv4 address written as IPv6 reaches the IPv4 host. URL parsing turns
  // ::ffff:127.0.0.1 into ::ffff:7f00:1, so both spellings are unwrapped.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (dotted) a = dotted[1]!;
  else if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (isBlockedHost(a)) return true;
  if (a === "::" || a === "0.0.0.0" || a === "255.255.255.255") return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // carrier-grade NAT
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return true; // benchmarking
    return o1 >= 224; // multicast and reserved
  }
  // IPv6 unique-local (fc00::/7), link-local (fe80::/10) and multicast.
  return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a) || /^ff[0-9a-f]{0,2}:/.test(a);
}

export type TargetCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Vet an endpoint address before storing it or sending to it. */
export function checkTargetUrl(raw: string, allowPrivate: boolean): TargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Webhook URLs must start with https:// or http://." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Put credentials in the receiver's configuration, not in the URL." };
  }
  if (!allowPrivate && isBlockedAddress(url.hostname)) {
    return {
      ok: false,
      reason:
        "That address is on a private or local network. Set WEBHOOK_ALLOW_PRIVATE=true to deliver to systems on your own network.",
    };
  }
  return { ok: true, url };
}

export type PostResult = {
  status: number | null;
  ms: number;
  error: string | null;
  /** The start of the response body, for the delivery log. */
  body: string;
};

const MAX_BODY_KEPT = 2048;

/**
 * dns.lookup, refusing names that resolve to a blocked address. Given to the
 * socket as its lookup, so the check covers the address actually connected to.
 */
export function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate) {
        const blocked = list.find((a) => isBlockedAddress(a.address));
        if (blocked) {
          return callback(
            Object.assign(new Error(`${hostname} resolves to a private address (${blocked.address})`), {
              code: "EBLOCKED",
            }),
          );
        }
      }
      if (list.length === 0) return callback(new Error(`${hostname} did not resolve`));
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as net.LookupFunction;
}

/**
 * POST a body and report what happened. Never throws: every failure comes
 * back as { status: null, error }. Redirects are not followed; a 3xx is
 * reported like any other non-2xx answer.
 */
export function postJson(
  target: URL,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; allowPrivate: boolean },
): Promise<PostResult> {
  const started = Date.now();
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: Omit<PostResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, ms: Date.now() - started });
    };

    // A literal IP never goes through the lookup, so check it here.
    if (!opts.allowPrivate && isBlockedAddress(target.hostname)) {
      done({ status: null, error: `${target.hostname} is a private address`, body: "" });
      return;
    }

    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        lookup: guardedLookup(opts.allowPrivate),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? null;
        const chunks: Buffer[] = [];
        let kept = 0;
        const finish = () => {
          const text = Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY_KEPT);
          const location = res.headers.location;
          const error =
            status !== null && status >= 300 && status < 400
              ? `Redirect to ${location ?? "(no location)"} not followed. Use the final URL.`
              : null;
          done({ status, error, body: text });
        };
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          kept += chunk.length;
          // Only the start is kept for the log; stop downloading the rest.
          if (kept >= MAX_BODY_KEPT) {
            finish();
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", (err) => done({ status, error: err.message, body: "" }));
      },
    );
    timer = setTimeout(() => {
      req.destroy(new Error(`No response within ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    req.on("error", (err) => done({ status: null, error: err.message, body: "" }));
    req.end(body);
  });
}
