/**
 * The Content-Security-Policy sources a map tile URL needs. Leaflet fetches
 * tiles as images, and the helmet policy in index.ts only allows HTTPS images
 * from anywhere, so a self-hosted tile server on plain HTTP (common on a LAN)
 * has to be named. Pure, so index.ts can call it at startup.
 *
 * "{s}" subdomain placeholders become a CSP wildcard: the template
 * "https://{s}.tile.example.com/{z}/{x}/{y}.png" needs
 * "https://*.tile.example.com".
 */
export function mapTileSources(template: string): string[] {
  const trimmed = template.trim();
  const m = /^(https?):\/\/([^/?#]+)/i.exec(trimmed);
  if (!m) return [];
  const scheme = m[1]!.toLowerCase();
  let host = m[2]!.toLowerCase();
  // Credentials in a tile URL would end up in the policy header; refuse them.
  if (host.includes("@")) return [];
  host = host.replace(/\{s\}/g, "*");
  // Any other placeholder in the host is a subdomain too (for example {switch:a,b,c}).
  host = host.replace(/\{[^}]*\}/g, "*");
  if (!/^[a-z0-9*.:[\]-]+$/.test(host)) return [];
  // CSP only allows a wildcard as the whole leftmost label. Anything fancier
  // ("tiles-{s}.example.com") falls back to the scheme alone.
  if (host.includes("*") && !/^\*\.[^*]+$/.test(host)) return [`${scheme}:`];
  return [`${scheme}://${host}`];
}
