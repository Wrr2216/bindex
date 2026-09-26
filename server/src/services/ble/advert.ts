/**
 * Bluetooth LE advertisements: parsing the bytes a gateway hears, and the
 * stable identity strings Bindex stores for a tag or beacon.
 *
 * Pure functions with no database or environment access. Every format here is
 * decoded from its published specification (Apple iBeacon, Google Eddystone,
 * AltBeacon) and tested against byte fixtures.
 *
 * Identities, as stored in tracking_devices.external_id and sightings.code:
 *
 *   ibeacon:<uuid, lowercase, dashed>:<major>:<minor>
 *   altbeacon:<id1, lowercase, dashed when 16 bytes>:<id2>:<id3>
 *   eddystone:<namespace, 20 hex>:<instance, 12 hex>
 *   mac:<AA:BB:CC:DD:EE:FF>
 *
 * Anything else (kontakt:<uniqueId>, a custom id) is kept exactly as given.
 */

export type BeaconFrame =
  | "ibeacon"
  | "altbeacon"
  | "eddystone_uid"
  | "eddystone_url"
  | "eddystone_tlm"
  | "eddystone_eid"
  | "none";

/** Eddystone-TLM telemetry. Each value is null when the beacon does not report it. */
export type Telemetry = {
  batteryMv: number | null;
  temperatureC: number | null;
  advCount: number | null;
  uptimeS: number | null;
};

export type ParsedAdvert = {
  /** The stable identity a frame carries: null for TLM, URL, EID and plain adverts. */
  identity: string | null;
  /** The most specific frame found. Identity frames win over TLM and URL. */
  frame: BeaconFrame;
  ibeacon?: { uuid: string; major: number; minor: number; measuredPower: number };
  altbeacon?: { id1: string; id2: number; id3: number; refRssi: number; manufacturerId: number };
  eddystone?: { namespace: string; instance: string; txPower0m: number };
  url?: string;
  tlm?: Telemetry;
  /**
   * Received signal at 1 m that the beacon advertises, dBm. iBeacon and
   * AltBeacon give it at 1 m; Eddystone gives it at 0 m, and the Eddystone
   * specification says to subtract 41 dB for 1 m.
   */
  txPower: number | null;
  /** Complete or shortened local name. */
  name: string | null;
  /** Bluetooth SIG company identifier of manufacturer-specific data. */
  manufacturerId: number | null;
  /** 16-bit service UUIDs listed or carrying service data, as 4 hex digits. */
  services: string[];
  /** A structure ran past the end of the data; what came before it was read. */
  truncated: boolean;
};

const APPLE = 0x004c;
const EDDYSTONE_SERVICE = 0xfeaa;

const HEX_ONLY = /^[0-9a-f]*$/i;

/**
 * Advertising data from a hex string (spaces, colons and a 0x prefix are
 * ignored). Null when it is not an even number of hex digits.
 */
export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, "").replace(/[\s:-]/g, "");
  if (!clean || clean.length % 2 !== 0 || !HEX_ONLY.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const int8 = (b: number) => (b > 127 ? b - 256 : b);
const u16be = (d: Uint8Array, i: number) => (d[i]! << 8) | d[i + 1]!;
const u32be = (d: Uint8Array, i: number) => ((d[i]! << 24) >>> 0) + (d[i + 1]! << 16) + (d[i + 2]! << 8) + d[i + 3]!;

/** 16 bytes as a lowercase dashed UUID. */
export function formatUuid(bytes: Uint8Array | string): string {
  const hex = typeof bytes === "string" ? bytes.replace(/-/g, "").toLowerCase() : toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A MAC address in any common notation as AA:BB:CC:DD:EE:FF, or null. */
export function formatMac(raw: string): string | null {
  const hex = raw.trim().replace(/[\s:.-]/g, "");
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  return hex.toUpperCase().match(/../g)!.join(":");
}

export const ibeaconIdentity = (uuid: string, major: number, minor: number) =>
  `ibeacon:${formatUuid(uuid)}:${major}:${minor}`;
export const eddystoneIdentity = (namespace: string, instance: string) =>
  `eddystone:${namespace.toLowerCase()}:${instance.toLowerCase()}`;
export const macIdentity = (mac: string): string | null => {
  const m = formatMac(mac);
  return m ? `mac:${m}` : null;
};

function altbeaconIdentity(id1: string, id2: number, id3: number): string {
  return `altbeacon:${id1.length === 32 ? formatUuid(id1) : id1.toLowerCase()}:${id2}:${id3}`;
}

const isUuidHex = (s: string) => /^[0-9a-f]{32}$/i.test(s.replace(/-/g, ""));
const u16 = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d{1,5}$/.test(s.trim())) return null;
  const n = Number(s);
  return n <= 0xffff ? n : null;
};

/**
 * The canonical form of an identity typed by a person or sent by a gateway:
 * prefixes lowercased, UUIDs dashed and lowercased, MACs uppercased with
 * colons. A bare MAC becomes mac:…. A recognised prefix with a malformed value
 * gives null, so a form can say what is wrong. Anything else is kept as given.
 */
export function canonicalIdentity(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const colon = s.indexOf(":");
  const prefix = colon > 0 ? s.slice(0, colon).toLowerCase() : "";
  const rest = colon > 0 ? s.slice(colon + 1) : "";
  switch (prefix) {
    case "ibeacon":
    case "altbeacon": {
      const [id1, id2, id3, extra] = rest.split(":");
      const major = u16(id2);
      const minor = u16(id3);
      if (!id1 || extra !== undefined || major === null || minor === null) return null;
      if (prefix === "ibeacon") return isUuidHex(id1) ? ibeaconIdentity(id1, major, minor) : null;
      const hex = id1.replace(/-/g, "");
      return /^([0-9a-f]{2})+$/i.test(hex) ? altbeaconIdentity(hex, major, minor) : null;
    }
    case "eddystone": {
      const [ns, inst, extra] = rest.split(":");
      if (!ns || !inst || extra !== undefined) return null;
      return /^[0-9a-f]{20}$/i.test(ns) && /^[0-9a-f]{12}$/i.test(inst) ? eddystoneIdentity(ns, inst) : null;
    }
    case "mac":
      return macIdentity(rest);
  }
  return macIdentity(s) ?? s;
}

/** The bare MAC in a mac: identity, as AA:BB:CC:DD:EE:FF. */
export const macOf = (identity: string | null | undefined): string | null =>
  identity?.startsWith("mac:") ? identity.slice(4) : null;

const URL_SCHEMES = ["http://www.", "https://www.", "http://", "https://"];
const URL_EXPANSIONS = [
  ".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/",
  ".com", ".org", ".edu", ".net", ".info", ".biz", ".gov",
];

/** An Eddystone-URL frame's compressed URL, or null when the scheme is unknown. */
export function decodeEddystoneUrl(scheme: number, encoded: Uint8Array): string | null {
  const prefix = URL_SCHEMES[scheme];
  if (prefix === undefined) return null;
  let url = prefix;
  for (const b of encoded) {
    if (b < URL_EXPANSIONS.length) url += URL_EXPANSIONS[b];
    // 0x0e-0x20 and 0x7f-0xff are reserved; printable ASCII is itself.
    else if (b > 0x20 && b < 0x7f) url += String.fromCharCode(b);
  }
  return url;
}

function parseEddystone(d: Uint8Array, out: Working): void {
  if (d.length < 2) return;
  const frameType = d[0];
  if (frameType === 0x00 && d.length >= 18) {
    const namespace = toHex(d.subarray(2, 12));
    const instance = toHex(d.subarray(12, 18));
    out.eddystone = { namespace, instance, txPower0m: int8(d[1]!) };
  } else if (frameType === 0x10 && d.length >= 3) {
    const url = decodeEddystoneUrl(d[2]!, d.subarray(3));
    if (url) out.url = url;
    out.eddystoneUrlTx = int8(d[1]!);
  } else if (frameType === 0x20) {
    // Version 0 is plain telemetry; version 1 is encrypted and unreadable here.
    if (d[1] === 0x00 && d.length >= 14) {
      const mv = u16be(d, 2);
      const rawTemp = u16be(d, 4);
      out.tlm = {
        batteryMv: mv === 0 ? null : mv,
        // Signed 8.8 fixed point; 0x8000 means "not supported".
        temperatureC: rawTemp === 0x8000 ? null : (rawTemp > 0x7fff ? rawTemp - 0x10000 : rawTemp) / 256,
        advCount: u32be(d, 6),
        // Counted in tenths of a second since power-on.
        uptimeS: u32be(d, 10) / 10,
      };
    }
    out.sawTlm = true;
  } else if (frameType === 0x30) {
    out.sawEid = true;
  }
}

function parseManufacturer(d: Uint8Array, out: ParsedAdvert): void {
  if (d.length < 2) return;
  const company = d[0]! | (d[1]! << 8);
  out.manufacturerId = company;
  const m = d.subarray(2);
  if (company === APPLE && m[0] === 0x02 && m[1] === 0x15 && m.length >= 23) {
    out.ibeacon = {
      uuid: formatUuid(m.subarray(2, 18)),
      major: u16be(m, 18),
      minor: u16be(m, 20),
      measuredPower: int8(m[22]!),
    };
  } else if (m[0] === 0xbe && m[1] === 0xac && m.length >= 24) {
    // AltBeacon: a 20-byte id, conventionally a 16-byte UUID and two 16-bit values.
    out.altbeacon = {
      id1: toHex(m.subarray(2, 18)),
      id2: u16be(m, 18),
      id3: u16be(m, 20),
      refRssi: int8(m[22]!),
      manufacturerId: company,
    };
  }
}

type Working = ParsedAdvert & { eddystoneUrlTx?: number; sawTlm?: boolean; sawEid?: boolean };

/**
 * Parse advertising data: a sequence of [length][type][data] structures.
 * Tolerates what real gateways send: zero padding between the advertisement
 * and an appended scan response, unknown structures, and a truncated final
 * structure (reported as `truncated`, with everything before it kept).
 */
export function parseAdvertisement(input: Uint8Array | string): ParsedAdvert | null {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  if (!bytes) return null;
  const out: Working = {
    identity: null,
    frame: "none",
    txPower: null,
    name: null,
    manufacturerId: null,
    services: [],
    truncated: false,
  };
  const services = new Set<string>();

  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i]!;
    if (len === 0) {
      i += 1;
      continue;
    }
    if (i + 1 + len > bytes.length) {
      out.truncated = true;
      break;
    }
    const type = bytes[i + 1]!;
    const data = bytes.subarray(i + 2, i + 1 + len);
    switch (type) {
      case 0x02:
      case 0x03:
        for (let j = 0; j + 1 < data.length; j += 2) {
          services.add(((data[j]! | (data[j + 1]! << 8)) >>> 0).toString(16).padStart(4, "0"));
        }
        break;
      case 0x08:
      case 0x09:
        // A complete name beats a shortened one.
        if (type === 0x09 || !out.name) out.name = new TextDecoder("utf-8", { fatal: false }).decode(data).replace(/\0+$/, "") || null;
        break;
      case 0x16:
        if (data.length >= 2) {
          const uuid = data[0]! | (data[1]! << 8);
          services.add(uuid.toString(16).padStart(4, "0"));
          if (uuid === EDDYSTONE_SERVICE) parseEddystone(data.subarray(2), out);
        }
        break;
      case 0xff:
        parseManufacturer(data, out);
        break;
    }
    i += 1 + len;
  }

  out.services = [...services];
  if (out.ibeacon) {
    out.frame = "ibeacon";
    out.identity = ibeaconIdentity(out.ibeacon.uuid, out.ibeacon.major, out.ibeacon.minor);
    out.txPower = out.ibeacon.measuredPower;
  } else if (out.altbeacon) {
    out.frame = "altbeacon";
    out.identity = altbeaconIdentity(out.altbeacon.id1, out.altbeacon.id2, out.altbeacon.id3);
    out.txPower = out.altbeacon.refRssi;
  } else if (out.eddystone) {
    out.frame = "eddystone_uid";
    out.identity = eddystoneIdentity(out.eddystone.namespace, out.eddystone.instance);
    out.txPower = out.eddystone.txPower0m - 41;
  } else if (out.url !== undefined) {
    out.frame = "eddystone_url";
    out.txPower = out.eddystoneUrlTx !== undefined ? out.eddystoneUrlTx - 41 : null;
  } else if (out.sawTlm) {
    out.frame = "eddystone_tlm";
  } else if (out.sawEid) {
    out.frame = "eddystone_eid";
  }
  const { eddystoneUrlTx: _tx, sawTlm: _tlm, sawEid: _eid, ...result } = out;
  return result;
}

/**
 * A battery percentage from a cell voltage. Coin cells (CR2032, CR2477) run
 * from about 3.0 V new to about 2.0 V when a beacon stops, and fall roughly
 * linearly in between, so a straight line is as good as anything cheaper than
 * a per-model discharge curve. Tags can override both ends.
 */
export function batteryPctFromMv(mv: number | null | undefined, fullMv = 3000, emptyMv = 2000): number | null {
  if (typeof mv !== "number" || !Number.isFinite(mv) || mv <= 0 || fullMv <= emptyMv) return null;
  const pct = ((mv - emptyMv) / (fullMv - emptyMv)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}
