import { AdapterError, isRecord, nonEmptyString } from "../../tracking/adapters/common";
import { finiteOrNull } from "../../tracking/normalize";
import {
  canonicalIdentity,
  eddystoneIdentity,
  ibeaconIdentity,
  macIdentity,
  parseAdvertisement,
  type BeaconFrame,
} from "../advert";

/**
 * BLE gateway adapters turn a vendor's payload into RawAdverts: one heard
 * advertisement each, with whatever the gateway sent (raw bytes, or an
 * identity it already decoded). interpretAdvert then turns each into an
 * Observation, so every format ends up in the same shape.
 *
 * Like the tracking core's adapters (services/tracking/adapters), these are
 * pure, tolerate fields they do not know, and throw AdapterError for a body
 * that is not the expected shape, which the route turns into a 400.
 */

export { AdapterError, isRecord, nonEmptyString };

export type RawAdvert = {
  /** The advertiser's Bluetooth address, in any notation. */
  mac?: string | null;
  rssi?: number | null;
  at?: Date | null;
  /** Advertising data as hex, when the gateway forwards the raw bytes. */
  data?: string | null;
  /** An identity the gateway (or phone) already decoded, or a MAC. */
  identity?: string | null;
  /** Advertised signal at 1 m, dBm. */
  txPower?: number | null;
  batteryPct?: number | null;
  batteryMv?: number | null;
  temperatureC?: number | null;
  name?: string | null;
};

export type GatewayPayload = {
  /** The gateway's own id (serial, MAC, IMEI), for INGEST_TOKEN and MQTT posts. */
  gatewayId?: string;
  /** The gateway's own battery, 0 to 100. */
  batteryPct?: number;
  /** Where a moving gateway (a vehicle tracker) was. */
  lat?: number;
  lng?: number;
  adverts: RawAdvert[];
  /** Entries understood but not advertisements (gateway heartbeats, empty records). */
  skipped: number;
};

/** One advertisement, decoded: what the presence engine and the registry work with. */
export type Observation = {
  /** The frame's identity (ibeacon:…, eddystone:…, altbeacon:…, kontakt:…), or null. */
  identity: string | null;
  /** The advertiser's address as mac:AA:BB:…, or null. */
  mac: string | null;
  rssi: number | null;
  at: Date | null;
  frame: BeaconFrame;
  txPower: number | null;
  batteryPct: number | null;
  batteryMv: number | null;
  temperatureC: number | null;
  name: string | null;
  url: string | null;
};

/** Advertising data is at most a few hundred bytes; longer is not an advert. */
const MAX_DATA_HEX = 1024;

/**
 * Decode one advertisement. Raw bytes win over an identity the gateway decoded
 * itself, since they are what was actually on the air. An identity that turns
 * out to be a MAC is treated as the address.
 */
export function interpretAdvert(raw: RawAdvert): Observation {
  const parsed = raw.data && raw.data.length <= MAX_DATA_HEX ? parseAdvertisement(raw.data) : null;
  let mac = raw.mac ? macIdentity(raw.mac) : null;
  let identity = parsed?.identity ?? null;
  if (!identity && raw.identity) {
    const given = canonicalIdentity(raw.identity);
    if (given?.startsWith("mac:")) mac ??= given;
    else identity = given;
  }
  return {
    identity,
    mac,
    rssi: finiteOrNull(raw.rssi),
    at: raw.at ?? null,
    frame: parsed?.frame ?? (identity?.startsWith("ibeacon:") ? "ibeacon" : identity?.startsWith("eddystone:") ? "eddystone_uid" : "none"),
    txPower: parsed?.txPower ?? finiteOrNull(raw.txPower),
    batteryPct: finiteOrNull(raw.batteryPct),
    batteryMv: parsed?.tlm?.batteryMv ?? finiteOrNull(raw.batteryMv),
    temperatureC: parsed?.tlm?.temperatureC ?? finiteOrNull(raw.temperatureC),
    name: parsed?.name ?? raw.name ?? null,
    url: parsed?.url ?? null,
  };
}

/**
 * An identity from loose fields: iBeacon uuid/major/minor, Eddystone
 * namespace/instance, or an id string. Used by formats that decode frames
 * themselves (Minew's parsed types, phone apps).
 */
export function identityFromFields(o: Record<string, unknown>): string | null {
  const uuid = nonEmptyString(o.uuid ?? o.ibeaconUuid ?? o.proximityUuid);
  const major = finiteOrNull(o.major ?? o.ibeaconMajor);
  const minor = finiteOrNull(o.minor ?? o.ibeaconMinor);
  if (uuid && major !== null && minor !== null && /^[0-9a-f]{32}$/i.test(uuid.replace(/-/g, ""))) {
    return ibeaconIdentity(uuid, Math.trunc(major), Math.trunc(minor));
  }
  const ns = nonEmptyString(o.namespace ?? o.namespaceId ?? o.eddystoneNamespace);
  const inst = nonEmptyString(o.instance ?? o.instanceId ?? o.eddystoneInstance);
  if (ns && inst && /^[0-9a-f]{20}$/i.test(ns.replace(/^0x/i, "")) && /^[0-9a-f]{12}$/i.test(inst.replace(/^0x/i, ""))) {
    return eddystoneIdentity(ns.replace(/^0x/i, ""), inst.replace(/^0x/i, ""));
  }
  const id = nonEmptyString(o.identity ?? o.code ?? o.id ?? o.beacon);
  return id ? canonicalIdentity(id) : null;
}

/** A hex string of advertising data, or an AdapterError naming the field. */
export function hexData(v: unknown, where: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^(0x)?[0-9a-f\s]*$/i.test(v.trim()) || v.replace(/^0x|\s/gi, "").length % 2 !== 0) {
    throw new AdapterError(`${where} must be the advertising data as hex, such as "0201061AFF4C00…".`);
  }
  return v;
}

/** A 0-100 battery level from a number or numeric string, or undefined. */
export function batteryLevel(v: unknown): number | undefined {
  const n = finiteOrNull(v);
  if (n === null || n < 0 || n > 100) return undefined;
  return Math.round(n);
}

/** The first array found under one of these keys, or the value itself when it is an array. */
export function arrayIn(body: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return null;
  for (const k of keys) if (Array.isArray(body[k])) return body[k] as unknown[];
  return null;
}
