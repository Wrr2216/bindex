export type RegistrarName = "cloudflare" | "porkbun";

/** A domain as reported by its registrar, normalized across providers. */
export type RegistrarDomain = {
  name: string; // FQDN, lowercase
  registrar: RegistrarName;
  status: string | null;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  whoisPrivacy: boolean | null;
};

/** A DNS zone (used to cross-reference where a domain's DNS actually lives). */
export type DnsZone = {
  name: string; // FQDN, lowercase
  nameservers: string[];
};
