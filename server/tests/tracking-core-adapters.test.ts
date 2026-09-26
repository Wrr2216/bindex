import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdapterError,
  MAX_READS_PER_REQUEST,
  parseGeneric,
  parseImpinj,
  parseSpeedwayConnect,
  parseZebra,
} from "../src/services/tracking/adapters";
import { splitLine } from "../src/services/tracking/adapters/speedway";

/**
 * Fixture payloads follow the shapes in each vendor's documentation. None of
 * them has been captured from real hardware yet; see docs/tracking-core.md.
 */

const EPC = "E28011606000020A1B2C3D4E";

describe("generic JSON", () => {
  it("reads the documented shape", () => {
    const parsed = parseGeneric({
      device: "dock-1",
      battery: 87.4,
      reads: [
        { code: EPC, ts: "2023-05-09T15:04:12.310Z", rssi: -61, antenna: 2, tech: "rfid" },
        { code: "INV-4F2K1B" },
        { lat: 51.5007, lng: -0.1246, accuracy: 8, speed: 1.2, heading: 90 },
      ],
    });
    assert.equal(parsed.readerId, "dock-1");
    assert.equal(parsed.batteryPct, 87);
    assert.equal(parsed.reads.length, 3);
    assert.deepEqual(parsed.reads[0]!.observedAt, new Date("2023-05-09T15:04:12.310Z"));
    assert.equal(parsed.reads[0]!.rssi, -61);
    assert.equal(parsed.reads[0]!.antenna, 2);
    assert.equal(parsed.reads[0]!.tech, "rfid");
    assert.equal(parsed.reads[1]!.code, "INV-4F2K1B");
    assert.equal(parsed.reads[2]!.code, null);
    assert.equal(parsed.reads[2]!.lat, 51.5007);
    assert.equal(parsed.reads[2]!.accuracyM, 8);
    assert.equal(parsed.reads[2]!.headingDeg, 90);
  });

  it("accepts bare strings, epoch timestamps and JSON sent as text", () => {
    const parsed = parseGeneric(JSON.stringify({ reads: [EPC, { code: EPC, ts: 1683644652310 }, { code: EPC, ts: 1683644652 }] }));
    assert.equal(parsed.reads[0]!.code, EPC);
    assert.deepEqual(parsed.reads[1]!.observedAt, new Date(1683644652310));
    assert.deepEqual(parsed.reads[2]!.observedAt, new Date(1683644652000));
  });

  it("tolerates fields it does not know", () => {
    const parsed = parseGeneric({ firmware: "1.2", reads: [{ code: EPC, phase: 12, extra: { a: 1 } }] });
    assert.equal(parsed.reads.length, 1);
  });

  it("says what it expected when the payload is wrong", () => {
    assert.throws(() => parseGeneric({ epcs: [EPC] }), (e: unknown) => e instanceof AdapterError && /"reads" must be an array/.test(e.message));
    assert.throws(() => parseGeneric({ reads: [{ rssi: -50 }] }), /needs a "code"/);
    assert.throws(() => parseGeneric({ reads: [{ code: 42 }] }), /code must be a string/);
    assert.throws(() => parseGeneric({ reads: [{ code: EPC, tech: "wifi" }] }), /tech must be one of/);
    assert.throws(() => parseGeneric({ reads: [{ code: EPC, ts: "yesterday" }] }), /ts is not a time/);
    assert.throws(() => parseGeneric({ reads: [{ lat: 95, lng: 0 }] }), /lat must be between/);
    assert.throws(() => parseGeneric("not json at all"), /not JSON/);
    assert.throws(() => parseGeneric([1, 2]), /Expected an object/);
  });

  it("refuses an oversized batch before parsing it", () => {
    const reads = Array.from({ length: MAX_READS_PER_REQUEST + 1 }, () => EPC);
    assert.throws(() => parseGeneric({ reads }), /Too many reads/);
  });
});

describe("Zebra IoT Connector", () => {
  // Tag data events in the IoT Connector's JSON format, batched.
  const fixture = [
    {
      data: {
        eventNum: 231,
        format: "epc",
        idHex: "e28011606000020a1b2c3d4e",
        antenna: 1,
        peakRssi: -61,
        reads: 2,
        channel: 915.75,
        phase: 0,
      },
      timestamp: "2023-05-09T15:04:12.310+0000",
      type: "SIMPLE",
    },
    {
      data: { eventNum: 232, format: "epc", idHex: "e28011606000020a1b2c3d4f", antenna: 3, peakRssi: -48, reads: 5 },
      timestamp: "2023-05-09T15:04:12.410+0000",
      type: "SIMPLE",
    },
    { type: "heartbeat", timestamp: "2023-05-09T15:04:13.000+0000", data: { hostname: "FX9600F0A1B2" } },
  ];

  it("reads tag data events and skips heartbeats", () => {
    const parsed = parseZebra(fixture);
    assert.equal(parsed.reads.length, 2);
    assert.equal(parsed.skipped, 1);
    assert.equal(parsed.readerId, "FX9600F0A1B2");
    const [a, b] = parsed.reads;
    assert.equal(a!.code, "e28011606000020a1b2c3d4e");
    assert.equal(a!.antenna, 1);
    assert.equal(a!.rssi, -61);
    assert.equal(a!.tech, "rfid");
    // Zebra writes the offset without a colon.
    assert.deepEqual(a!.observedAt, new Date("2023-05-09T15:04:12.310Z"));
    assert.deepEqual(a!.meta, { vendor: "zebra", format: "epc", reads: 2, channel: 915.75, phase: 0, eventNum: 231 });
    assert.equal(b!.antenna, 3);
  });

  it("accepts a single event, and newline-delimited JSON", () => {
    assert.equal(parseZebra(fixture[0]).reads.length, 1);
    const ndjson = fixture.map((e) => JSON.stringify(e)).join("\n");
    assert.equal(parseZebra(ndjson).reads.length, 2);
  });

  it("rejects something that is not Zebra at all", () => {
    assert.throws(() => parseZebra({ reads: [{ code: EPC }] }), /Zebra IoT Connector/);
    assert.throws(() => parseZebra("<xml/>"), /not JSON/);
  });

  it("accepts an empty batch", () => {
    assert.equal(parseZebra([]).reads.length, 0);
  });
});

describe("Impinj IoT device interface", () => {
  // Webhook body: a JSON array of events.
  const fixture = [
    {
      timestamp: "2023-05-09T15:04:12.310Z",
      hostname: "impinj-14-1f-23",
      eventType: "tagInventory",
      tagInventoryEvent: {
        epc: "4oARYGAAAgobLD1O",
        epcHex: EPC,
        antennaPort: 2,
        antennaName: "Dock outside",
        peakRssiCdbm: -6150,
        frequency: 915750,
        transmitPowerCdbm: 3000,
        lastSeenTime: "2023-05-09T15:04:12.305Z",
      },
    },
    {
      timestamp: "2023-05-09T15:04:12.400Z",
      hostname: "impinj-14-1f-23",
      eventType: "tagInventory",
      // Only the base64 EPC: the hex form is derived from it.
      tagInventoryEvent: { epc: "4oARYGAAAgobLD1O", antennaPort: 3, peakRssiCdbm: -4800 },
    },
    { timestamp: "2023-05-09T15:04:13.000Z", hostname: "impinj-14-1f-23", eventType: "inventoryStatus", inventoryStatusEvent: { inventoryStatus: "running" } },
  ];

  it("reads tagInventory events, converting centi-dBm", () => {
    const parsed = parseImpinj(fixture);
    assert.equal(parsed.readerId, "impinj-14-1f-23");
    assert.equal(parsed.reads.length, 2);
    assert.equal(parsed.skipped, 1);
    const [a, b] = parsed.reads;
    assert.equal(a!.code, EPC);
    assert.equal(a!.rssi, -61.5);
    assert.equal(a!.antenna, 2);
    assert.deepEqual(a!.observedAt, new Date("2023-05-09T15:04:12.305Z"));
    assert.equal(a!.meta?.antennaName, "Dock outside");
    assert.equal(b!.code, EPC);
    assert.deepEqual(b!.observedAt, new Date("2023-05-09T15:04:12.400Z"));
  });

  it("accepts the HTTP stream's newline-delimited JSON and a single event", () => {
    const ndjson = fixture.map((e) => JSON.stringify(e)).join("\r\n");
    assert.equal(parseImpinj(ndjson).reads.length, 2);
    assert.equal(parseImpinj(fixture[0]).reads.length, 1);
  });

  it("rejects something that is not Impinj", () => {
    assert.throws(() => parseImpinj([{ data: { idHex: EPC } }]), /Impinj IoT device interface/);
  });
});

describe("Impinj Speedway Connect", () => {
  // HTTP POST mode, form-encoded, two tags, EPCs quoted as the reader sends them.
  const raw =
    "reader_name=SpeedwayR-10-EF-18&mac_address=00%3A16%3A25%3A10%3AEF%3A18&line_ending=%0A&field_delim=%2C" +
    "&field_names=antenna_port%2Cepc%2Cfirst_seen_timestamp%2Cpeak_rssi%2Ctid" +
    "&field_values=1%2C%22E28011606000020A1B2C3D4E%22%2C1683644652310000%2C-61%2C%22E2003411B802011383279478%22" +
    "%0A3%2C%22E28011606000020A1B2C3D4F%22%2C1683644652410000%2C-58%2C%22%22";

  it("reads a raw form body", () => {
    const parsed = parseSpeedwayConnect(raw);
    assert.equal(parsed.readerId, "SpeedwayR-10-EF-18");
    assert.equal(parsed.reads.length, 2);
    const [a, b] = parsed.reads;
    assert.equal(a!.code, EPC);
    assert.equal(a!.antenna, 1);
    assert.equal(a!.rssi, -61);
    // Microseconds since the epoch.
    assert.deepEqual(a!.observedAt, new Date("2023-05-09T15:04:12.310Z"));
    assert.equal(a!.meta?.tid, "E2003411B802011383279478");
    assert.equal(b!.antenna, 3);
    assert.equal(b!.meta?.tid, undefined);
  });

  it("reads the same form after Express has parsed it", () => {
    const form = Object.fromEntries(new URLSearchParams(raw));
    assert.equal(parseSpeedwayConnect(form).reads.length, 2);
  });

  it("honours a custom delimiter and line ending", () => {
    const form = {
      reader_name: "dock",
      field_delim: ";",
      line_ending: "\r\n",
      field_names: "epc;antenna_port",
      field_values: `${EPC};2\r\nE28011606000020A1B2C3D50;4\r\n`,
    };
    const parsed = parseSpeedwayConnect(form);
    assert.deepEqual(
      parsed.reads.map((r) => [r.code, r.antenna]),
      [
        [EPC, 2],
        ["E28011606000020A1B2C3D50", 4],
      ],
    );
  });

  it("says what is missing", () => {
    assert.throws(() => parseSpeedwayConnect({ reader_name: "x" }), /field_names or field_values/);
    assert.throws(
      () => parseSpeedwayConnect({ field_names: "antenna_port,peak_rssi", field_values: "1,-50" }),
      /must include "epc"/,
    );
    assert.throws(() => parseSpeedwayConnect(42), /Speedway Connect/);
  });

  it("splits quoted values", () => {
    assert.deepEqual(splitLine('1,"a,b",c', ","), ["1", "a,b", "c"]);
    assert.deepEqual(splitLine('"say ""hi"""', ","), ['say "hi"']);
    assert.deepEqual(splitLine("a||b", "||"), ["a", "b"]);
  });
});
