import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdapterError,
  detectFormat,
  interpretAdvert,
  parseBleGeneric,
  parseGatewayPayload,
  parseIngics,
  parseKontakt,
  parseMinew,
  parsePhone,
  parseTeltonika,
} from "../src/services/ble/adapters";

/**
 * Gateway payloads shaped as each vendor documents them. None has been
 * captured from real hardware yet; see docs/ble.md. The advertising data inside
 * them is the byte fixtures of ble-advert.test.ts.
 */

const IBEACON_DATA = "0201061AFF4C000215E2C56DB5DFFB48D2B060D0F5A71096E000010002C5";
const TLM_DATA = "0201060303AAFE1116AAFE20000BB817800000040000002710";
const IBEACON_ID = "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2";

const MINEW = [
  { timestamp: "2023-05-09T08:14:17.448Z", type: "Gateway", mac: "AC233FC04EAB", gatewayFree: 97, gatewayLoad: 0.13 },
  {
    timestamp: "2023-05-09T08:14:17.524Z",
    type: "iBeacon",
    mac: "AC233F266BF2",
    bleName: "",
    ibeaconUuid: "E2C56DB5DFFB48D2B060D0F5A71096E0",
    ibeaconMajor: 1,
    ibeaconMinor: 2,
    rssi: -58,
    ibeaconTxPower: -59,
    battery: 0,
  },
  { timestamp: "2023-05-09T08:14:17.526Z", type: "Unknown", mac: "C7B3FC5A83DD", bleName: "", rssi: -86, rawData: TLM_DATA },
  { timestamp: "2023-05-09T08:14:17.530Z", type: "S1", mac: "AC233FA24C11", rssi: -71, battery: 84, temperature: 21.4 },
];

describe("Minew G1 / MG3", () => {
  it("reads the gateway entry and every advertiser", () => {
    const p = parseMinew(MINEW);
    assert.equal(p.gatewayId, "AC233FC04EAB");
    assert.equal(p.skipped, 1);
    assert.equal(p.adverts.length, 3);
    const [ib, tlm, sensor] = p.adverts.map(interpretAdvert);
    assert.equal(ib!.identity, IBEACON_ID);
    assert.equal(ib!.mac, "mac:AC:23:3F:26:6B:F2");
    assert.equal(ib!.rssi, -58);
    assert.equal(ib!.txPower, -59);
    // Minew's 0 means "not reported", not "flat".
    assert.equal(ib!.batteryPct, null);
    assert.deepEqual(ib!.at, new Date("2023-05-09T08:14:17.524Z"));
    assert.equal(tlm!.frame, "eddystone_tlm");
    assert.equal(tlm!.batteryMv, 3000);
    assert.equal(tlm!.temperatureC, 23.5);
    assert.equal(sensor!.batteryPct, 84);
    assert.equal(sensor!.identity, null);
    assert.equal(sensor!.mac, "mac:AC:23:3F:A2:4C:11");
  });

  it("takes rawData over the gateway's own decoding", () => {
    const p = parseMinew([{ type: "iBeacon", mac: "AC233F266BF2", rssi: -60, rawData: IBEACON_DATA, ibeaconUuid: "00000000000000000000000000000000", ibeaconMajor: 9, ibeaconMinor: 9 }]);
    assert.equal(interpretAdvert(p.adverts[0]!).identity, IBEACON_ID);
  });

  it("accepts the array as text, as MQTT delivers it", () => {
    assert.equal(parseMinew(JSON.stringify(MINEW)).adverts.length, 3);
  });

  it("refuses what is not Minew JSON", () => {
    assert.throws(() => parseMinew("hello"), AdapterError);
    assert.throws(() => parseMinew([{ mac: "AC233F266BF2", rawData: "zz" }]), /hex/);
  });
});

const INGICS = [
  `$GPRP,C4BE84E7EC3E,E1C8BC3DFF84,-58,${IBEACON_DATA},1683620057`,
  "$SRRP,C4BE84E7EC3E,E1C8BC3DFF84,-60,050954616737",
  `$GPRP,F0C77F123456,E1C8BC3DFF84,-77,${TLM_DATA}`,
  "$HBRP,E1C8BC3DFF84,1683620057",
  "",
].join("\r\n");

describe("Ingics iGS", () => {
  it("reads report lines, the gateway MAC and optional timestamps", () => {
    const p = parseIngics(INGICS);
    assert.equal(p.gatewayId, "E1:C8:BC:3D:FF:84");
    assert.equal(p.adverts.length, 3);
    assert.equal(p.skipped, 1);
    const [ib, sr, tlm] = p.adverts.map(interpretAdvert);
    assert.equal(ib!.identity, IBEACON_ID);
    assert.equal(ib!.mac, "mac:C4:BE:84:E7:EC:3E");
    assert.equal(ib!.rssi, -58);
    assert.deepEqual(ib!.at, new Date(1683620057 * 1000));
    assert.equal(sr!.name, "Tag7");
    assert.equal(sr!.identity, null);
    assert.equal(tlm!.batteryMv, 3000);
    assert.equal(tlm!.at, null);
  });

  it("accepts the lines as a JSON array or a form field", () => {
    const lines = INGICS.split("\r\n").filter(Boolean);
    assert.equal(parseIngics(lines).adverts.length, 3);
    assert.equal(parseIngics({ data: INGICS }).adverts.length, 3);
  });

  it("refuses a body with no report lines", () => {
    assert.throws(() => parseIngics(""), AdapterError);
    assert.throws(() => parseIngics("hello\nworld"), /Ingics/);
  });
});

describe("Kontakt.io", () => {
  const events = {
    events: [
      { trackingId: "f0:c7:7f:12:34:56", uniqueId: "AbC1", sourceId: "gw-dock-a", rssi: -63, timestamp: 1683620057, batteryLevel: 87 },
      { uniqueId: "XyZ9", sourceId: "gw-dock-a", rssi: -80, timestamp: 1683620058123 },
      { trackingId: "not-a-mac-id", rssi: -90 },
      { sourceId: "gw-dock-a", rssi: -50 },
    ],
  };

  it("reads unique ids, tracking ids, source, battery and both timestamp units", () => {
    const p = parseKontakt(events);
    assert.equal(p.gatewayId, "gw-dock-a");
    assert.equal(p.adverts.length, 3);
    assert.equal(p.skipped, 1);
    const [a, b, c] = p.adverts.map(interpretAdvert);
    assert.equal(a!.identity, "kontakt:AbC1");
    assert.equal(a!.mac, "mac:F0:C7:7F:12:34:56");
    assert.equal(a!.batteryPct, 87);
    assert.deepEqual(a!.at, new Date(1683620057 * 1000));
    assert.equal(b!.identity, "kontakt:XyZ9");
    assert.deepEqual(b!.at, new Date(1683620058123));
    assert.equal(c!.identity, "kontakt:not-a-mac-id");
  });

  it("accepts a bare array and refuses events that name no beacon", () => {
    assert.equal(parseKontakt(events.events).adverts.length, 3);
    assert.throws(() => parseKontakt([{ rssi: -50 }]), /uniqueId or trackingId/);
  });
});

describe("Teltonika via a forwarder", () => {
  const records = [
    {
      ident: "352093081452251",
      timestamp: 1683620057,
      "position.latitude": 54.68,
      "position.longitude": 25.27,
      "ble.beacons": [
        { id: "e2c56db5dffb48d2b060d0f5a71096e000010002", rssi: -70 },
        { id: "edd1ebeac04e5defa0170bdb87539b67", rssi: -81, "battery.voltage": 3.05 },
        { id: "AC233FA1B2C3", rssi: -90 },
      ],
    },
    // An older GPS-only record: skipped, and its position does not win.
    { ident: "352093081452251", timestamp: 1683620050, "position.latitude": 54.6, "position.longitude": 25.2 },
  ];

  it("reads iBeacon, Eddystone and MAC ids, the IMEI and the latest position", () => {
    const p = parseTeltonika(records);
    assert.equal(p.gatewayId, "352093081452251");
    assert.equal(p.lat, 54.68);
    assert.equal(p.lng, 25.27);
    assert.equal(p.skipped, 1);
    const [ib, ed, mac] = p.adverts.map(interpretAdvert);
    assert.equal(ib!.identity, IBEACON_ID);
    assert.equal(ed!.identity, "eddystone:edd1ebeac04e5defa017:0bdb87539b67");
    assert.equal(ed!.batteryMv, 3050);
    assert.equal(mac!.identity, null);
    assert.equal(mac!.mac, "mac:AC:23:3F:A1:B2:C3");
    assert.deepEqual(ib!.at, new Date(1683620057 * 1000));
  });

  it("accepts nested ble.beacons and a flespi-style result wrapper", () => {
    const p = parseTeltonika({ result: [{ ident: "1", ble: { beacons: [{ id: "AC233FA1B2C3", rssi: -60 }] } }] });
    assert.equal(p.adverts.length, 1);
    assert.throws(() => parseTeltonika("[1, 2]"), AdapterError);
  });
});

describe("generic BLE format", () => {
  it("reads raw data, identities, MACs and bare strings", () => {
    const p = parseBleGeneric({
      gateway: "pi-dock-a",
      battery: 99.6,
      reads: [
        { mac: "AC:23:3F:A1:B2:C3", rssi: -61, ts: "2023-05-09T08:14:17.000Z", data: IBEACON_DATA },
        { code: "eddystone:EDD1EBEAC04E5DEFA017:0BDB87539B67", rssi: -70, ts: 1683620057123 },
        { uuid: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", major: 3, minor: 4, rssi: -75 },
        { code: "AC233FA1B2C4", rssi: -80, tech: "ble" },
        "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:9:9",
      ],
    });
    assert.equal(p.gatewayId, "pi-dock-a");
    assert.equal(p.batteryPct, 100);
    const o = p.adverts.map(interpretAdvert);
    assert.equal(o[0]!.identity, IBEACON_ID);
    assert.equal(o[0]!.mac, "mac:AC:23:3F:A1:B2:C3");
    assert.equal(o[1]!.identity, "eddystone:edd1ebeac04e5defa017:0bdb87539b67");
    assert.deepEqual(o[1]!.at, new Date(1683620057123));
    assert.equal(o[2]!.identity, "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:3:4");
    // A code that is a MAC is the advertiser's address, not a frame identity.
    assert.equal(o[3]!.identity, null);
    assert.equal(o[3]!.mac, "mac:AC:23:3F:A1:B2:C4");
    assert.equal(o[4]!.identity, "ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:9:9");
  });

  it("says what a read is missing", () => {
    assert.throws(() => parseBleGeneric({ reads: [{ rssi: -60 }] }), /needs "mac", "data"/);
    assert.throws(() => parseBleGeneric({ reads: [{ mac: "AC233FA1B2C3", ts: "yesterday" }] }), /not a time/);
    assert.throws(() => parseBleGeneric({ nope: [] }), /"reads" must be an array/);
  });
});

describe("phones", () => {
  it("reads beacons by uuid/major/minor, namespace/instance and id", () => {
    const p = parsePhone({
      phone: "dana-pixel",
      battery: 64,
      beacons: [
        { uuid: "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", major: 1, minor: 2, rssi: -63 },
        { namespace: "EDD1EBEAC04E5DEFA017", instance: "0BDB87539B67", rssi: -80 },
        { id: "mac:AC:23:3F:A1:B2:C3", rssi: -88 },
        { rssi: -50 },
      ],
    });
    assert.equal(p.gatewayId, "dana-pixel");
    assert.equal(p.batteryPct, 64);
    assert.equal(p.adverts.length, 3);
    assert.equal(p.skipped, 1);
    const o = p.adverts.map(interpretAdvert);
    assert.equal(o[0]!.identity, IBEACON_ID);
    assert.equal(o[1]!.identity, "eddystone:edd1ebeac04e5defa017:0bdb87539b67");
    assert.equal(o[2]!.mac, "mac:AC:23:3F:A1:B2:C3");
  });

  it("reads the Beacon Scanner app's logging format", () => {
    const p = parsePhone({
      reader: "Pixel 8",
      beacons: [
        {
          beaconType: "ibeacon",
          ibeaconData: { uuid: "e2c56db5-dffb-48d2-b060-d0f5a71096e0", major: "1", minor: "2" },
          rssi: -66,
          distance: 1.8,
          lastSeen: 1683620057123,
          hashcode: 12345,
        },
        {
          beaconType: "eddystone_uid",
          eddystoneUidData: { namespaceId: "0xedd1ebeac04e5defa017", instanceId: "0x0bdb87539b67" },
          rssi: -79,
        },
      ],
    });
    const o = p.adverts.map(interpretAdvert);
    assert.equal(o[0]!.identity, IBEACON_ID);
    assert.deepEqual(o[0]!.at, new Date(1683620057123));
    assert.equal(o[1]!.identity, "eddystone:edd1ebeac04e5defa017:0bdb87539b67");
  });

  it("accepts the generic reads format and refuses anything else", () => {
    assert.equal(parsePhone({ reads: [{ code: IBEACON_ID, rssi: -60 }] }).adverts.length, 1);
    assert.throws(() => parsePhone({ something: 1 }), /"beacons" must be an array/);
  });
});

describe("format detection (MQTT)", () => {
  it("tells each format apart by its shape", () => {
    assert.equal(detectFormat(JSON.stringify(MINEW)), "minew");
    assert.equal(detectFormat(INGICS), "ingics");
    assert.equal(detectFormat(JSON.stringify(INGICS.split("\r\n").filter(Boolean))), "ingics");
    assert.equal(detectFormat('{"events":[{"uniqueId":"AbC1","rssi":-60}]}'), "kontakt");
    assert.equal(detectFormat('[{"ident":"1","ble.beacons":[]}]'), "teltonika");
    assert.equal(detectFormat('{"reads":[{"mac":"AC233FA1B2C3","rssi":-60}]}'), "generic");
    assert.equal(detectFormat('[{"mac":"AC233FA1B2C3","rssi":-60,"data":"0201"}]'), "generic");
  });

  it("parses with the detected format, or the one it is told", () => {
    assert.equal(parseGatewayPayload(JSON.stringify(MINEW)).gatewayId, "AC233FC04EAB");
    assert.equal(parseGatewayPayload(INGICS, "ingics").adverts.length, 3);
    assert.throws(() => detectFormat("not json at all"), AdapterError);
    assert.throws(() => detectFormat('[{"foo":1}]'), /BLE_MQTT_FORMAT/);
  });
});
