# Readers, beacons and trackers

Bindex can follow things through a building on its own: fixed RFID readers
cover zones, dock-door portals tell which way a pallet went, and tags or
trackers attached to equipment report where it is. This page covers the
tracking core that all of that shares, and the fixed RFID readers built on it.
Bluetooth beacons, GPS and placement guidance build on the same pieces.

The feature switch is **Readers, beacons and trackers** in Settings, Features.
It is on by default. Switching it off removes every screen and the
`/api/tracking` API, makes the `/api/device/reads` endpoints answer 503, and
stops storing sightings; `/api/device/scan` keeps feeding the Building Audit
exactly as before.

## Concepts

**Device.** Anything that reports reads, or that is read: an RFID reader, a
portal, a BLE gateway, beacon or tag, a GPS tracker, an NFC reader, a phone.
Devices are registered in **Settings, Readers and devices**. A device that
reports gets its own ingest token, stored hashed and shown once, like an API
key.

**Zone.** Any location. A fixed device covers one (its *zone*); a reader whose
antennas point into different rooms can map antennas to zones of their own.
Zones nest like locations do, so "Warehouse" contains "Aisle 3".

**Sighting.** One stored read: when, which device, the raw code, the item or
unit it resolved to, the zone, signal strength, antenna, direction through a
portal, and coordinates when there are any. Sightings are history and are
pruned by age.

**Position.** Each asset's latest known state: the zone it is in, since when,
where it came from, and which device saw it last. One per item, or per unit
when a unit carries its own tag. Positions only move forward in time, so a
batch that arrives late is stored as history without rewinding anything.

**Move.** When a sighting puts an asset in a different zone from the one it
was in, one `moved` event is written to the item's history, not one per read.
Whether the item's recorded location changes as well depends on the device's
**Move items when read** setting (`updates_location`). With it off, the
device only says where the item was last seen; the item stays on file where it
was, and the item page shows the difference.

A read with no zone behind it (a handheld with no zone, or a portal read before
the tag has crossed from one side to the other) is stored and updates "last
seen", but moves nothing.

## Setting up a zone reader

1. Tag your things and store each tag's EPC on its item as an `rfid`
   identifier (or use the item's printed code, a unit's code, or a unit's
   serial; all of them resolve).
2. In **Settings, Readers and devices**, add an **RFID reader**. Pick the zone
   it covers. Turn on **Move items when read** if a read here should change
   where things are on file. Copy the token.
3. Point the reader at `/api/device/reads` (or its vendor endpoint, below) with
   the token.
4. Open **Tracking** (Live reads) and read a tag. It should appear within a
   second with its item and zone.

If the reader picks up tags in the next aisle, set **Ignore reads weaker than**
(for example -70 dBm). If its antennas cover different rooms, list them under
**Antennas in other zones**.

## Setting up a dock-door portal

A portal is a reader with antennas on both sides of a doorway, often a tripod
with a tablet at a dock door. Bindex works out the direction of each pass from
which side a tag was read on first and last.

1. Add an **RFID portal**. Its **Inside zone** is where a pallet is after
   passing in, for example "Warehouse". Set **Outside zone** to where it is
   after passing out ("Yard", "Truck 12"), or leave it empty if outside is not
   a location, in which case an outbound pallet leaves the warehouse without
   being put anywhere.
2. Fill in the **Antenna map**: which antenna ports face outside and which face
   inside. A new portal starts with ports 1 and 2 outside and 3 and 4 inside.
3. **Pass window** is the longest gap between two reads of a tag that still
   counts as one pass, 3 seconds by default. A pallet that sits in the doorway
   longer than that and then continues starts a new pass.
4. Turn on **Move items when read** so passes update where things are on file.
5. Commission it: open **Tracking**, pick the portal, and carry a tagged box
   through both ways. Each pass shows as **In** or **Out** with its zone, and
   the counters at the top add up. A tag that approaches and turns back has no
   direction and moves nothing.

The rule, precisely: reads from antennas with no side are ignored; a pass is a
run of reads with no gap longer than the window; the first and last side of
the pass decide the direction (outside then inside is in, inside then outside
is out, the same side on both ends is none); when several antennas see a tag
at the same instant, the strongest read decides the side. Portal reads get a
zone only once the direction is known.

## The existing reader bridge

A bridge that posts to `/api/device/scan` with `INGEST_TOKEN` keeps working
with no change. Its reads still stream into the Building Audit screen, and are
now also stored as sightings. The first time it posts, it is registered as an
RFID reader named after its `READER_ID`; give it a zone in Settings to make it
a fixed reader.

`bridge/m7e_bridge.py` can also post to `/api/device/reads` with each tag's
antenna, signal strength and read time: set `SEND_READS=1`. See
[bridge/README.md](../bridge/README.md).

In the Building Audit, **Use M7e live reader** now lists registered readers by
name. **Other channel** keeps the free-text channel for a bridge that has not
posted yet.

## Device endpoints

Hardware posts to `/api/device`, which takes no browser session or API key.

### Authentication

Send the device's own token, one of:

- `Authorization: Bearer <token>` (preferred)
- `x-device-token: <token>`
- HTTP Basic with the token as the password (any user name), for firmware that
  only offers Basic authentication
- `?token=<token>` on the URL, for firmware that cannot send a header at all.
  Query strings can end up in proxy logs, so use a header where you can.

`INGEST_TOKEN` is also accepted. A post made with it is attributed to the
device whose serial or reader id matches the reader's name for itself (the
`reader` or `device` field, the vendor host name, or `?reader=`), and a new
RFID reader is registered when there is none.

| Status | Meaning |
| --- | --- |
| 401 | No token, or one no device has. Rotated and revoked tokens stop working at once. |
| 403 | The device is disabled, or its kind cannot post to this endpoint. |
| 400 | The body is not the format the endpoint expects. The message says what was expected. |
| 503 | `code: tracking_disabled`: the feature switch is off. `code: ingest_disabled`: there is no `INGEST_TOKEN` and no device has a token. |

Bodies up to `DEVICE_INGEST_MAX_MB` (16 MB) are accepted, as JSON,
newline-delimited JSON, a form, or plain text containing JSON. One request
takes at most 50,000 reads.

### Endpoints

| Method | Path | Body | Who |
| --- | --- | --- | --- |
| `POST` | `/api/device/scan` | `{ reader?, epcs: [] }`, unchanged | RFID and NFC readers, phones |
| `POST` | `/api/device/reads` | Generic format, below | Any kind |
| `POST` | `/api/device/reads/zebra` | Zebra IoT Connector JSON | RFID readers and portals |
| `POST` | `/api/device/reads/impinj` | Impinj IoT device interface events | RFID readers and portals |
| `POST` | `/api/device/reads/speedway-connect` | Speedway Connect HTTP POST form | RFID readers and portals |

`/scan` answers `{ ok: true, accepted }` as it always has. The others answer:

```json
{
  "ok": true,
  "deviceId": "3a70d812-89f4-47ea-a383-22b3622269f8",
  "accepted": 3,
  "matched": 3,
  "unknown": 0,
  "recorded": 1,
  "suppressed": 2,
  "ignored": 0,
  "moved": 1,
  "skipped": 0
}
```

`accepted` reads were valid and above the RSSI floor; `matched` and `unknown`
split them by whether they resolved to an item. `recorded` were stored;
`suppressed` repeated a recent read and were not. `ignored` were dropped (below
the RSSI floor, or empty). `moved` is the number of zone changes. `skipped`
counts events in a vendor payload that were not tag reads, such as heartbeats.

RFID, NFC and barcode reads from any of these endpoints also feed the device's
Building Audit channel, which is its serial or reader id, or its id when it has
neither.

### Generic format

```json
{
  "device": "dock-1",
  "battery": 87,
  "reads": [
    { "code": "E28011606000020A1B2C3D4E", "ts": "2026-09-26T14:04:12.310Z", "rssi": -61, "antenna": 2 },
    { "code": "INV-4F2K1B", "tech": "barcode" },
    { "lat": 51.5007, "lng": -0.1246, "accuracy": 8, "speed": 1.2, "heading": 90 }
  ]
}
```

| Field | Notes |
| --- | --- |
| `device` | Optional. The reader's name for itself; only used with `INGEST_TOKEN`. |
| `battery` | Optional, 0 to 100. Stored on the device. |
| `reads[].code` | EPC, tag UID, printed code, serial, or a tag's id. A bare string works too: `"reads": ["E280..."]`. |
| `reads[].ts` | Optional. ISO 8601, or epoch seconds, milliseconds or microseconds. Defaults to when the server received it; a time more than a minute in the future is replaced by the server's. |
| `reads[].rssi` | Optional, dBm. |
| `reads[].antenna` | Optional antenna port. Needed for portals. |
| `reads[].tech` | Optional: `rfid`, `ble`, `gps`, `nfc`, `barcode` or `manual`. Defaults from the device kind. |
| `reads[].direction` | Optional `in` or `out`, when the hardware already knows. |
| `reads[].lat`, `lng`, `accuracy`, `speed`, `heading` | Optional. A read with coordinates and no code is a tracker reporting its own position, and is about the item the tracker is attached to. |

Unknown fields are ignored.

## Vendor setup

These adapters were **built from each vendor's published documentation and
have not yet been verified on hardware**. The fixtures they are tested against
follow the documented shapes. If your reader's payload differs, the endpoint
answers 400 saying what it expected; please report it with a sample.

### Zebra FX7500, FX9600, ATR7000 (IoT Connector)

1. In the reader's web console, enable the **IoT Connector** and add an
   **HTTP POST** data endpoint.
2. URL: `https://<your host>/api/device/reads/zebra`.
3. Authentication: Basic, with any user name and the device token as the
   password, or a bearer token if your firmware offers one.
4. Data format: JSON tag data events. Batching may be on or off; both a single
   event and an array are accepted. Heartbeats and GPI events are ignored.
5. Put the reader's host name (for example `FX9600F0A1B2`) in the device's
   serial field, so the events' `hostName` matches when `INGEST_TOKEN` is used.

Fields used: `data.idHex`, `data.antenna`, `data.peakRssi`, and the event
`timestamp`. `reads`, `channel`, `phase`, `format` and `eventNum` are kept in
the sighting's `meta`.

### Impinj R700, R660, R720 (IoT device interface)

1. Configure the reader's IoT device interface to deliver tag inventory
   events to a **webhook** at `https://<your host>/api/device/reads/impinj`,
   with the header `Authorization: Bearer <device token>`, and start an
   inventory preset. See Impinj's IoT device interface reference for the calls
   your firmware version uses.
2. The webhook body is a JSON array of events; one event, or newline-delimited
   JSON from the HTTP stream (`/api/v1/data/stream` on the reader) forwarded by
   a small relay, work too.

Fields used: `tagInventoryEvent.epcHex` (or the base64 `epc`),
`antennaPort`, `peakRssiCdbm` (converted from centi-dBm), and `lastSeenTime`
or the event `timestamp`. The event `hostname` names the reader.

### Impinj Speedway Connect (R420, R220)

1. In Speedway Connect, choose **HTTP POST** output.
2. URL: `https://<your host>/api/device/reads/speedway-connect`. Speedway
   Connect cannot add an Authorization header, so either use its user name and
   password fields (any user name, the device token as the password) if your
   version has them, or append `?token=<device token>` to the URL.
3. Include at least `epc` and `antenna_port`, and preferably `peak_rssi` and
   `first_seen_timestamp` or `last_seen_timestamp`.

The form fields used are `reader_name`, `mac_address`, `field_delim`,
`line_ending`, `field_names` and `field_values` (one tag per line; quoted
values are fine; timestamps are microseconds since the epoch).

## How codes match

A read resolves to an item or unit by, in order: an identifier on an item (any
type, including `rfid`), a tag or tracker device attached to an item, an item's
printed code, a unit's printed code, a unit's serial. Matching is exact first,
then on the normalized form: a value made only of hex digits, ignoring spaces
and colons, is compared uppercased with them removed, so `e2 80 11 60` on file
matches `E2801160` from a reader. Anything else (a printed code, a beacon id
such as `mac:AA:BB:CC:DD:EE:FF`) is only trimmed. A code that matches two
different items equally well, such as a UPC shared by two items, resolves to
neither rather than guessing.

Hardware reads never add "scanned" events to an item's history; only zone
changes are recorded, as `moved`.

## Duplicates, noise and clocks

- A repeat of the same code on the same device within `TRACKING_DEDUP_SECONDS`
  (5 by default, or the device's own setting) is not stored again, unless its
  zone or direction changed. A tag sitting in a reader's field is stored once
  per window, so "last seen" stays current without storing every read.
- Reads weaker than the device's RSSI floor are dropped.
- A device clock running more than a minute fast is corrected to the server's
  time. A late batch is stored with its real times but never rewinds a
  position.

## Retention and backups

Sightings older than `SIGHTINGS_RETENTION_DAYS` (90 by default; 0 keeps them
forever) are deleted once a day, along with the sightings of items that have
been deleted. Positions are the latest state and are not pruned.

Backups include the device registry but not device tokens, sightings or
positions. A restore keeps the tokens of devices whose ids survive it; a
device the file brings back that did not exist before needs a new token.
Positions are rebuilt from the next reads, because a restore replaces every
item they point at. A backup file from before this feature leaves the current
registry in place.

## Privacy

Sightings are location history. Anyone signed in can see where an item was
seen and read the live feed; only administrators can register or change
devices. Tags on equipment a person carries, or trackers in vehicles, can
reveal where that person has been: tell people what is tracked, keep the
retention window as short as the job allows, and switch the feature off where
it is not needed. Deleting an item deletes its sightings at the next daily
prune, and its position at once.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SIGHTINGS_RETENTION_DAYS` | `90` | Days of sightings to keep. 0 keeps them all. |
| `TRACKING_DEDUP_SECONDS` | `5` | Duplicate window. Devices can override it. |
| `DEVICE_INGEST_MAX_MB` | `16` | Largest request body under `/api/device`. |
| `INGEST_TOKEN` | | Shared token for bridges that predate per-device tokens. |

## Session API

Signed-in sessions and API keys can read; changing devices needs an
administrator's browser session. Every path answers 404 while the feature is
off.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/tracking/devices?kind=a,b` | `{ devices }`. Never includes tokens; `hasToken` and `tokenLast4` say whether one is set. |
| `GET` | `/api/tracking/devices/:id` | One device. |
| `POST` | `/api/tracking/devices` | Admin. Returns `{ device, token }`; the token is shown only here. `issueToken: false` skips it. |
| `PATCH` | `/api/tracking/devices/:id` | Admin. Any field; `settings` replaces the stored object, so send back keys you did not change. |
| `DELETE` | `/api/tracking/devices/:id` | Admin. Sightings stay. |
| `POST` | `/api/tracking/devices/:id/rotate-token` | Admin. `{ device, token }`; the old token stops working. |
| `DELETE` | `/api/tracking/devices/:id/token` | Admin. Removes the token. |
| `GET` | `/api/tracking/items/:id/positions` | `{ positions }`: the item's, and each tagged unit's. |
| `GET` | `/api/tracking/items/:id/sightings?limit=&before=` | Newest first. Pass `next` from the response as `before` for the next page. |
| `GET` | `/api/tracking/locations/:id/present?within=` | `{ present }`: assets whose position is in this zone or any zone inside it; `within` limits it to the last so many minutes. |
| `GET` | `/api/tracking/feed?since=&deviceId=&limit=` | `{ cursor, sightings }`, oldest first. Without `since`, the latest ones; poll again with the cursor. |

Device settings (`settings`) hold `rssiFloor`, `dedupSeconds`,
`antennaZones` (antenna port to location id) and, for portals, `portal:
{ sides, windowSeconds, inLocationId, outLocationId }`. Other keys are kept as
they are, so other features can store their own options there.

## Building on the tracking core

For features that add radios or use positions (BLE, GPS, placement,
operations insights). Import from `server/src/services/tracking`.

**Tables** (`server/src/db/tables/tracking-core.ts`):

- `tracking_devices`: `kind` is one of `rfid_reader`, `rfid_portal`,
  `ble_gateway`, `ble_beacon`, `ble_tag`, `gps_tracker`, `nfc_reader`,
  `mobile`; every kind BLE and GPS need is already allowed. `external_id` is
  unique per kind. `location_id` is the zone a fixed device covers; `item_id`
  and `unit_id` the asset a tag or tracker is attached to. `settings` is
  free-form jsonb; keep your keys namespaced by meaning (`bleUuid`,
  `rssiOffset`, `maxSpeedMps`).
- `sightings`: append-only, `bigserial` id, no foreign keys (joins tolerate
  missing rows). Indexed by `(item_id, observed_at desc)`,
  `(device_id, observed_at desc)` and `observed_at`.
- `asset_positions`: one row per item, or item and unit. `location_id` is the
  current zone, `entered_at` when it arrived there (dwell time is
  `now() - entered_at`), `previous_location_id` where it came from.

**`recordSightings(device, reads, opts?)`** is the only way to write
sightings. It resolves codes, infers portal direction, applies the device's
zone, drops duplicates, inserts sightings, advances positions, writes `moved`
events, updates the item's location when the device has `updates_location`,
and touches the device's last-seen time, position and battery, all in one
transaction and a fixed number of queries. 10,000 reads take a few hundred
milliseconds. Each read is a `NormalizedRead`:

```ts
{
  code?: string | null;          // omit for a tracker's own position
  observedAt?: Date | null;
  tech?: "rfid" | "ble" | "gps" | "nfc" | "barcode" | "manual" | null;
  rssi?, antenna?, lat?, lng?, accuracyM?, speedMps?, headingDeg?: number | null;
  direction?: "in" | "out" | null;
  locationId?: string | null;     // your decided zone; null = in no zone
  asset?: { itemId: string; unitId: string | null } | null;  // skip resolution
  meta?: Record<string, unknown> | null;
}
```

- Pass `locationId` when you have decided the zone yourself (a BLE presence
  engine choosing the strongest room, a geofence). `null` means "in no known
  zone": the position leaves its zone but nothing is moved. Leave it
  undefined to use the device's zone.
- Pass `asset` when you have already resolved the tag, for example a BLE tag
  device attached to an item.
- `opts.keepDuplicates` stores every read (for callers that already smooth or
  only report changes); `opts.batteryPct` updates the device; `opts.now` pins
  the receipt time in tests.
- It returns `{ accepted, matched, unknown, recorded, suppressed, ignored, moved }`.

A `moved` event's detail is `{ source: "tracking", tech, deviceId,
deviceName, from, to, applied, unitId?, direction? }`, where `applied` says
whether the recorded location changed.

**`resolveCodes(codes)`** returns a `Map` from each input code to `{ itemId,
unitId, via }`, in five queries whatever the number of codes, and writes no
history. **`zoneFor(device, settings, read)`** is the pure zone rule.
**`updateDeviceStatus(id, { seenAt, batteryPct, lat, lng })`** records a
device's status when it arrives through another device (a tag's battery heard
by a gateway).

**`requireDevice(kinds?, { readerId? })`** is Express middleware for hardware
routes. It accepts a device token or `INGEST_TOKEN` as described above, sets
`req.trackingDevice` (and `req.trackingAuth` to `"device"` or `"ingest"`), and
answers 401, 403 or 503 itself. `readerId(req, res)` tells it how to find the
reader's name in your payload for `INGEST_TOKEN` posts. Mount hardware routers
in `server/src/index.ts` next to `/api/device`, before the session guard.
Bodies under `/api/device/` skip the global 1 MB JSON parser; the device
router parses them (JSON, NDJSON, forms, text) and exports `deviceBody` for a
router mounted elsewhere.

**Read side:** `getItemPositions`, `listItemSightings`, `listPresent` and
`getFeed` back the session API and can be reused directly.

**Concurrency.** Duplicate suppression and portal passes are held in memory
per process; with several replicas, pin each device to one, or accept a few
extra stored reads. Batches that touch the same items take turns on a row
lock, so two readers reporting one pallet at once write one move, not two.
