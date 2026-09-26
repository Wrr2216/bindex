import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batteryPctFromMv,
  canonicalIdentity,
  decodeEddystoneUrl,
  formatMac,
  hexToBytes,
  macIdentity,
  parseAdvertisement,
} from "../src/services/ble/advert";

/**
 * Byte fixtures built from the published frame layouts: Apple's iBeacon
 * (manufacturer data 0x004C, 0x02 0x15), Google's Eddystone (service data
 * 0xFEAA, frame types 0x00 UID, 0x10 URL, 0x20 TLM, 0x30 EID) and AltBeacon
 * (beacon code 0xBEAC). Each is the complete advertising data a gateway
 * forwards, flags included.
 */
const FIXTURES = {
  // Apple's sample UUID, major 1, minor 2, measured power -59 dBm.
  ibeacon: "0201061AFF4C000215E2C56DB5DFFB48D2B060D0F5A71096E000010002C5",
  // Namespace EDD1EBEAC04E5DEFA017, instance 0BDB87539B67, tx -25 dBm at 0 m.
  eddystoneUid: "0201060303AAFE1716AAFE00E7EDD1EBEAC04E5DEFA0170BDB87539B670000",
  // https://www. + "bindex" + .com, tx -21 dBm at 0 m.
  eddystoneUrl: "0201060303AAFE0D16AAFE10EB0162696E64657807",
  // 3000 mV, 23.5 °C, 1024 adverts, 1000 s up.
  eddystoneTlm: "0201060303AAFE1116AAFE20000BB817800000040000002710",
  // Battery not reported (0), -0.5 °C.
  eddystoneTlmNegative: "0201060303AAFE1116AAFE20000000FF800000000700000005",
  // 2500 mV, temperature not supported (0x8000).
  eddystoneTlmNoTemp: "0201060303AAFE1116AAFE200009C480000000000700000005",
  // Encrypted TLM (version 1): unreadable without the key.
  eddystoneEtlm: "0201060303AAFE1516AAFE200100000000000000000000000000000000",
  eddystoneEid: "0201060303AAFE0D16AAFE30EB0102030405060708",
  // Radius Networks (0x0118), id1 2F234454-…, id2 1, id3 2, reference -59 dBm.
  altbeacon: "0201061BFF1801BEAC2F234454CF6D4A0FADF2F4911BA9FFA600010002C500",
  // iBeacon, a zero byte of padding, then a scan response with the name "Tag7".
  withScanResponse: "0201061AFF4C000215E2C56DB5DFFB48D2B060D0F5A71096E000010002C500050954616737",
  // A phone: flags, a name, Microsoft manufacturer data. No beacon frame.
  plain: "0201060809506978656C203808FF06000109200255",
};

describe("iBeacon", () => {
  it("reads UUID, major, minor and measured power", () => {
    const p = parseAdvertisement(FIXTURES.ibeacon)!;
    assert.equal(p.frame, "ibeacon");
    assert.equal(p.identity, "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2");
    assert.deepEqual(p.ibeacon, {
      uuid: "e2c56db5-dffb-48d2-b060-d0f5a71096e0",
      major: 1,
      minor: 2,
      measuredPower: -59,
    });
    assert.equal(p.txPower, -59);
    assert.equal(p.manufacturerId, 0x004c);
    assert.equal(p.truncated, false);
  });

  it("reads the same bytes in lowercase, with spaces, or from a Uint8Array", () => {
    const spaced = FIXTURES.ibeacon.toLowerCase().replace(/(..)/g, "$1 ");
    assert.equal(parseAdvertisement(spaced)!.identity, parseAdvertisement(FIXTURES.ibeacon)!.identity);
    assert.equal(parseAdvertisement(hexToBytes(FIXTURES.ibeacon)!)!.identity, parseAdvertisement(FIXTURES.ibeacon)!.identity);
  });

  it("keeps the identity when a scan response follows zero padding", () => {
    const p = parseAdvertisement(FIXTURES.withScanResponse)!;
    assert.equal(p.identity, "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2");
    assert.equal(p.name, "Tag7");
  });

  it("ignores Apple data that is not an iBeacon", () => {
    // Apple Continuity (type 0x10), as an iPhone sends.
    const p = parseAdvertisement("0201060AFF4C001005031C1A2B3C")!;
    assert.equal(p.frame, "none");
    assert.equal(p.identity, null);
    assert.equal(p.manufacturerId, 0x004c);
  });
});

describe("Eddystone", () => {
  it("reads a UID frame and converts its 0 m power to 1 m", () => {
    const p = parseAdvertisement(FIXTURES.eddystoneUid)!;
    assert.equal(p.frame, "eddystone_uid");
    assert.equal(p.identity, "eddystone:edd1ebeac04e5defa017:0bdb87539b67");
    assert.deepEqual(p.eddystone, { namespace: "edd1ebeac04e5defa017", instance: "0bdb87539b67", txPower0m: -25 });
    assert.equal(p.txPower, -66);
    assert.ok(p.services.includes("feaa"));
  });

  it("reads a URL frame with scheme and expansion codes", () => {
    const p = parseAdvertisement(FIXTURES.eddystoneUrl)!;
    assert.equal(p.frame, "eddystone_url");
    assert.equal(p.url, "https://www.bindex.com");
    assert.equal(p.identity, null);
    assert.equal(p.txPower, -21 - 41);
  });

  it("decodes every URL scheme and expansion", () => {
    assert.equal(decodeEddystoneUrl(0x00, new Uint8Array([0x61, 0x00])), "http://www.a.com/");
    assert.equal(decodeEddystoneUrl(0x02, new Uint8Array([0x78, 0x0d])), "http://x.gov");
    assert.equal(decodeEddystoneUrl(0x03, new Uint8Array([0x78, 0x04, 0x79])), "https://x.info/y");
    assert.equal(decodeEddystoneUrl(0x09, new Uint8Array([0x78])), null);
  });

  it("reads TLM telemetry: battery, temperature, counters", () => {
    const p = parseAdvertisement(FIXTURES.eddystoneTlm)!;
    assert.equal(p.frame, "eddystone_tlm");
    assert.equal(p.identity, null);
    assert.deepEqual(p.tlm, { batteryMv: 3000, temperatureC: 23.5, advCount: 1024, uptimeS: 1000 });
  });

  it("reads negative temperatures and 'not reported' markers in TLM", () => {
    assert.deepEqual(parseAdvertisement(FIXTURES.eddystoneTlmNegative)!.tlm, {
      batteryMv: null,
      temperatureC: -0.5,
      advCount: 7,
      uptimeS: 0.5,
    });
    const noTemp = parseAdvertisement(FIXTURES.eddystoneTlmNoTemp)!.tlm!;
    assert.equal(noTemp.batteryMv, 2500);
    assert.equal(noTemp.temperatureC, null);
  });

  it("recognises encrypted TLM and EID frames without inventing data", () => {
    const etlm = parseAdvertisement(FIXTURES.eddystoneEtlm)!;
    assert.equal(etlm.frame, "eddystone_tlm");
    assert.equal(etlm.tlm, undefined);
    const eid = parseAdvertisement(FIXTURES.eddystoneEid)!;
    assert.equal(eid.frame, "eddystone_eid");
    assert.equal(eid.identity, null);
  });
});

describe("AltBeacon", () => {
  it("reads the 20-byte id as UUID, id2, id3 and the reference RSSI", () => {
    const p = parseAdvertisement(FIXTURES.altbeacon)!;
    assert.equal(p.frame, "altbeacon");
    assert.equal(p.identity, "altbeacon:2f234454-cf6d-4a0f-adf2-f4911ba9ffa6:1:2");
    assert.equal(p.altbeacon!.manufacturerId, 0x0118);
    assert.equal(p.txPower, -59);
  });
});

describe("plain advertisements and bad input", () => {
  it("gives no identity and no frame for a device that is not a beacon", () => {
    const p = parseAdvertisement(FIXTURES.plain)!;
    assert.equal(p.frame, "none");
    assert.equal(p.identity, null);
    assert.equal(p.name, "Pixel 8");
    assert.equal(p.manufacturerId, 0x0006);
  });

  it("keeps what came before a truncated structure", () => {
    const p = parseAdvertisement("0201060909546167")!;
    assert.equal(p.truncated, true);
    assert.equal(p.frame, "none");
    const cut = parseAdvertisement(FIXTURES.ibeacon.slice(0, 30))!;
    assert.equal(cut.truncated, true);
    assert.equal(cut.identity, null);
  });

  it("refuses what is not hex", () => {
    assert.equal(parseAdvertisement("not hex"), null);
    assert.equal(parseAdvertisement("020"), null);
    assert.equal(hexToBytes(""), null);
  });

  it("parses an empty or all-padding advertisement as nothing", () => {
    assert.equal(parseAdvertisement("000000")!.frame, "none");
  });
});

describe("identities", () => {
  it("formats MACs from any notation", () => {
    assert.equal(formatMac("ac233fa1b2c3"), "AC:23:3F:A1:B2:C3");
    assert.equal(formatMac("AC-23-3F-A1-B2-C3"), "AC:23:3F:A1:B2:C3");
    assert.equal(formatMac("ac23.3fa1.b2c3"), "AC:23:3F:A1:B2:C3");
    assert.equal(formatMac("AC:23:3F"), null);
    assert.equal(macIdentity("ac:23:3f:a1:b2:c3"), "mac:AC:23:3F:A1:B2:C3");
  });

  it("canonicalises typed identities", () => {
    assert.equal(
      canonicalIdentity(" iBeacon:E2C56DB5DFFB48D2B060D0F5A71096E0:1:2 "),
      "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2",
    );
    assert.equal(
      canonicalIdentity("EDDYSTONE:EDD1EBEAC04E5DEFA017:0BDB87539B67"),
      "eddystone:edd1ebeac04e5defa017:0bdb87539b67",
    );
    assert.equal(
      canonicalIdentity("altbeacon:2F234454-CF6D-4A0F-ADF2-F4911BA9FFA6:1:2"),
      "altbeacon:2f234454-cf6d-4a0f-adf2-f4911ba9ffa6:1:2",
    );
    assert.equal(canonicalIdentity("mac:ac233fa1b2c3"), "mac:AC:23:3F:A1:B2:C3");
    assert.equal(canonicalIdentity("AC:23:3F:A1:B2:C3"), "mac:AC:23:3F:A1:B2:C3");
    // Other schemes are kept exactly, including case.
    assert.equal(canonicalIdentity("kontakt:AbC1"), "kontakt:AbC1");
    assert.equal(canonicalIdentity("   "), null);
  });

  it("refuses malformed values under a known prefix", () => {
    assert.equal(canonicalIdentity("ibeacon:not-a-uuid:1:2"), null);
    assert.equal(canonicalIdentity("ibeacon:E2C56DB5DFFB48D2B060D0F5A71096E0:70000:2"), null);
    assert.equal(canonicalIdentity("ibeacon:E2C56DB5DFFB48D2B060D0F5A71096E0:1"), null);
    assert.equal(canonicalIdentity("eddystone:EDD1:0BDB87539B67"), null);
    assert.equal(canonicalIdentity("mac:12:34"), null);
  });

  it("gives the same identity to parsed bytes and typed values", () => {
    const parsed = parseAdvertisement(FIXTURES.ibeacon)!.identity;
    assert.equal(canonicalIdentity("ibeacon:E2C56DB5-DFFB-48D2-B060-D0F5A71096E0:1:2"), parsed);
  });
});

describe("battery from voltage", () => {
  it("maps a coin cell's range onto 0-100", () => {
    assert.equal(batteryPctFromMv(3000), 100);
    assert.equal(batteryPctFromMv(3300), 100);
    assert.equal(batteryPctFromMv(2500), 50);
    assert.equal(batteryPctFromMv(2000), 0);
    assert.equal(batteryPctFromMv(1500), 0);
    assert.equal(batteryPctFromMv(3600, 3600, 3000), 100);
    assert.equal(batteryPctFromMv(3300, 3600, 3000), 50);
  });

  it("says nothing when there is no reading", () => {
    assert.equal(batteryPctFromMv(0), null);
    assert.equal(batteryPctFromMv(null), null);
    assert.equal(batteryPctFromMv(2500, 2000, 3000), null);
  });
});
