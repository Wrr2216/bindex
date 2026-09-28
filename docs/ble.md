# Bluetooth beacons, gateways and room-level presence

Bluetooth tags on equipment, pallets and vaults are heard by gateways
installed in each room, dock or aisle, and Bindex places each tag in the room
that hears it best. Room beacons do the reverse for people: a phone that hears
them tells Bindex which room it is in, so that person's scans can default to
that room.

It builds on the [tracking core](tracking-core.md): gateways, tags, room
beacons and phones are tracking devices, and every room change is written as a
sighting through the same code as an RFID read, so an item's position, its
"moved" history and (if you allow it) its location on file follow Bluetooth
exactly as they follow a fixed reader.

The feature switch is **Bluetooth beacons** in Settings, Features. It is off by
default, and only works while **Readers, beacons and trackers** is on. Off, it
removes the Bluetooth page, the item card and the `/api/ble` API, and the
hardware endpoints answer 503.

Contents: [Two ways to use it](#two-ways-to-use-it) ·
[Hardware](#choosing-hardware) · [Setting up](#setting-up) ·
[How a room is decided](#how-a-room-is-decided) ·
[Calibration](#calibrating-a-room) · [Accuracy](#what-accuracy-to-expect) ·
[Phones](#phones-and-room-beacons) · [Alerts and events](#alerts-and-events) ·
[Device endpoints](#device-endpoints) · [MQTT](#mqtt) ·
[Session API](#session-api) · [Configuration](#configuration) ·
[Storage and privacy](#storage-retention-and-privacy) ·
[For developers](#building-on-it)

## Two ways to use it

**A. Fixed gateways, moving tags.** A gateway (a Raspberry Pi running
[`bridge/ble_gateway.py`](../bridge/ble_gateway.py), or a commercial gateway
from Minew, Ingics, Kontakt.io or Teltonika) sits in each room and reports the
advertisements it hears. Tags, AirTag-sized beacons, are stuck on equipment,
materials, pallets and vaults. Every gateway that hears a tag reports how
strongly; Bindex puts the tag in the room whose gateway hears it best, with
enough smoothing that it does not flap between neighbouring rooms.

**B. Fixed room beacons, moving phone.** A small beacon sits in each room. A
phone running a beacon-scanner app (a companion app, or an Android scanner
with HTTP logging) posts the beacons it hears. Bindex works out which room the
phone is in and remembers it for a few minutes, so the person carrying it can
have their location filled in. Web Bluetooth scanning is not generally
available in browsers, which is why this needs an app rather than a web page.

The two can run side by side.

## Choosing hardware

**Tags.** Any beacon that broadcasts **iBeacon**, **Eddystone-UID** or
**AltBeacon** with a fixed id works; so does anything with a fixed Bluetooth
address (MAC) if you forward all advertisements. Prefer tags that also send
**Eddystone-TLM**, which carries battery voltage and temperature. Coin-cell
tags last one to three years at a 1 s advertising interval; faster intervals
give quicker, steadier placement and flatter batteries. Set the transmit power
to the same value on every tag of a kind. Tags that rotate their address or id
for privacy (Eddystone-EID, AirTags, phones) cannot be followed.

**Gateways.** One per room you want to tell apart; two in a large room. A
Raspberry Pi 3, 4, 5 or Zero 2 W with `ble_gateway.py` is cheap and reports raw
advertisements. Commercial gateways (Minew G1/MG3, Ingics iGS01/02/03,
Kontakt.io, Teltonika FMB trackers in vehicles) work through their own
formats, below. Mains power is best: gateways scan continuously.

**Room beacons** (pattern B). Any iBeacon or Eddystone-UID beacon, one per
room, fixed to a wall at about head height.

## Setting up

1. Switch on **Bluetooth beacons** in Settings, Features.
2. **Gateways.** On the **Bluetooth** page, Devices, add a **Gateway** for
   each one. Pick the room it covers. Turn on **Move items into this room** if
   a tag placed here should change where its item is on file (see
   [Move](tracking-core.md#concepts)); leave it off to only track where things
   were last seen. Copy the token and configure the gateway with it (Pi:
   [bridge/README.md](../bridge/README.md#ble-gateway); others: below).
3. **Tags.** Hold a new tag next to a gateway. It appears at the top of
   **Heard nearby** on the Devices tab. **Register as tag**, attach it to the
   item it will follow, and save. Or type its UUID, major and minor (or
   namespace and instance, or MAC) from the box it came in.
4. **Check.** Open **Rooms**: the tag appears in the gateway's room within
   half a minute. Carry it to another room and watch it follow.
5. **Calibrate** each room (below), especially rooms that share a wall.

A tag whose iBeacon or Eddystone-UID frames and telemetry (TLM) frames come
from different addresses: put the TLM address in the tag's **Telemetry MAC**,
or leave it empty and Bindex links them by the address it last saw the id on.

## How a room is decided

For each tag, the presence engine keeps the last `BLE_WINDOW_SECONDS` (20 s) of
readings from each gateway, after adding that gateway's calibration offset,
and:

1. smooths each gateway's readings: the **median** of the window by default
   (one spike cannot move a median), or an exponentially weighted moving
   average with `BLE_SMOOTHING=ewma`;
2. scores each room by its best gateway. Gateways with no room, and gateways
   with fewer than `BLE_MIN_SAMPLES` readings in the window, do not count;
3. moves the tag only when another room beats its current one by
   `BLE_HYSTERESIS_DB` (6 dB) **and keeps beating it at every reading for
   `BLE_DWELL_SECONDS` (10 s)**. A room whose gateways have stopped hearing the
   tag at all is beaten by any room;
4. places a tag with no room yet in the best room once that room has led for
   the dwell time.

With the defaults a move shows up about 15 to 25 seconds after the tag
actually changes room: half the window for the median to swing, plus the dwell.
That is the price of not flapping. A tag heard by nothing new stays in its last
room, however long it is silent; being silent is what **missing** is for.

Each room change is written as one sighting from the gateway that won the room,
with that room as its zone. The tracking core then updates the item's position,
writes one `moved` event if the room differs from where the item was, and
changes its location on file if that gateway has **Move items into this
room**. The first placement of a tag already on file in that room is not a
move. In between, a tag that stays put is stored as a sighting (no zone, from
the gateway that hears it best) once every `BLE_STORE_SECONDS` (60 s), which
keeps "last seen" current without storing every advertisement.

**Clocks.** Presence runs on the server's clock. Each batch is shifted so its
newest reading lands at the time it arrived, which cancels a gateway clock
running fast or slow but keeps the spacing of readings inside the batch. A
batch whose newest reading is more than five minutes old is a gateway catching
up after an outage: its readings are stored as history but move nothing.

**Missing.** A tag not heard by any gateway for `BLE_MISSING_MINUTES` (10), or
the tag's own **Missing after**, is marked missing (checked every 30 s). It
keeps its last room. Hearing it again clears it.

## Calibrating a room

Gateways differ: one is behind a rack, another hangs in a doorway, a third has
a better antenna. Each gateway has a **signal offset** in dB added to
everything it hears, and calibration helps set it.

On the **Calibrate** tab, pick a spare tag (it need not be attached to
anything) and the room it is in, place it where things normally sit, press
Start and step away for a minute. The result lists every gateway that heard it:
median, the median with its offset, and the spread. It says whether this room
wins and by how much. If another room wins or the margin is less than the
hysteresis, it suggests an offset for this room's gateway that would make it
win, which **Apply** sets.

Raising a gateway's offset also makes it win more often next door, so after
applying one, calibrate the neighbouring room too. If two rooms cannot both be
satisfied, the gateways are in the wrong places: move one, or add one.

## What accuracy to expect

Be honest with yourself about what RSSI can do.

- **Rooms with walls between them** are told apart reliably: walls cost 5 to
  15 dB, which the 6 dB hysteresis is sized for.
- **Adjacent open areas** (two aisles in one hall, two sides of a dock) are
  confused often. The engine will not flap, but it may keep a tag in the aisle
  it came from for a while, or pick the aisle next door. More gateways, closer
  together, help more than any setting; so do rooms defined as the areas
  between gateways rather than lines on a floor plan.
- **Signal strength is not distance.** Metal shelving, water (people, drinks,
  stock) and a tag lying face-down under a pallet move RSSI by 10 to 20 dB.
- **A tag between two rooms** will be placed in one of them and stay there
  until the other clearly wins.
- **Movement shows with a delay** of 15 to 25 seconds with the defaults; a
  shorter window and dwell react faster and flap more.
- For **doorway-exact** answers (which truck did this pallet go onto), use an
  RFID portal ([tracking core](tracking-core.md#setting-up-a-dock-door-portal)).

## Phones and room beacons

1. On the Devices tab, add a **Room beacon** for each room with its id and the
   room it is in. (Register from **Heard nearby** if a gateway can hear it.)
2. Add a **Phone** for each person, set **Belongs to**, and copy its token.
3. Configure the phone's scanner app to POST what it hears to
   `/api/device/ble/phone` with `Authorization: Bearer <token>`, every few
   seconds to a minute. Formats are below.

The phone's room is the strongest room beacon (smoothed, with the same
hysteresis but no dwell, because phones report sporadically). It is kept for
`BLE_PHONE_ROOM_SECONDS` (300) after the last report, then forgotten. Only the
current room is stored, never a history. `GET /api/ble/me/room` returns it for
the signed-in person, and the Bluetooth page shows "You are in …".

A phone cannot post with `INGEST_TOKEN`: the token is what says whose phone it
is.

## Alerts and events

| Alert | When | Resolves |
| --- | --- | --- |
| Missing | A tag has not been heard for its timeout | When it is heard again |
| Moved out of hours | A tag left a room outside `BLE_WORK_HOURS` | One-off |
| Battery low | A tag, room beacon or gateway reports `BLE_BATTERY_LOW_PCT` (20) or less | When it is back above the threshold plus 10 |

Alerts are listed on the Alerts tab and sent as a digest through the configured
notifications (Pushover, Wazuh; see [alerting](alerting.md)) every
`BLE_ALERT_DIGEST_MINUTES` (15). Out-of-hours alerts need `BLE_WORK_HOURS`,
for example `Mon-Fri 07:00-19:00; Sat 08:00-12:00` (overnight ranges such as
`22:00-06:00` run into the next morning), in `BLE_TIMEZONE` or the server's
zone. A tag can opt out with its **Alert when it changes room outside working
hours** option.

Every alert and every room change is also published as an event, logged in the
audit log and available to webhooks and the polling feed
([event backbone](event-backbone.md)):

| Type | Subject | `data` |
| --- | --- | --- |
| `ble.tag_zone_changed` | `item` (or `tracking_device` for a tag attached to nothing) | `{ tagId, tagName, identity, itemId, unitId, itemName, from, fromName, to, toName, gatewayId, gatewayName, rssi }`. `from` is null for a first placement. |
| `ble.tag_moved_after_hours` | as above | as `ble.tag_zone_changed` |
| `ble.tag_missing` | as above | `{ tagId, tagName, identity, itemId, unitId, itemName, lastLocationId, lastLocationName, lastHeardAt, minutes }` |
| `ble.tag_found` | as above | `{ tagId, tagName, identity, itemId, unitId, itemName, missingSince, locationId, locationName, gatewayId, gatewayName }` |
| `ble.battery_low` | `tracking_device` | `{ deviceId, kind, name, batteryPct, itemId, itemName, thresholdPct }` |

Phone rooms are deliberately not published: they are where a person is.

## Device endpoints

Hardware posts to `/api/device/ble`, with no browser session. Authentication is
the tracking core's ([details](tracking-core.md#authentication)): the device's
own token as `Authorization: Bearer`, `x-device-token`, HTTP Basic password or
`?token=`. Gateway endpoints accept only devices of kind **Gateway**; the phone
endpoint only **Phone**.

`INGEST_TOKEN` also works on the gateway endpoints. The gateway is found by the
id in the payload (Minew's gateway MAC, Ingics' gateway MAC, Kontakt.io's
`sourceId`, a Teltonika IMEI, `gateway` in the generic format) or by
`?reader=<id>`, compared as a MAC in any notation, and registered with no room
the first time it posts.

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/device/ble/reads` | Bindex's format, below |
| `POST` | `/api/device/ble/minew` | Minew G1 / MG3 JSON |
| `POST` | `/api/device/ble/ingics` | Ingics iGS report lines |
| `POST` | `/api/device/ble/kontakt` | Kontakt.io-style events |
| `POST` | `/api/device/ble/teltonika` | Teltonika records from a forwarder |
| `POST` | `/api/device/ble/phone` | Beacons a phone hears |

Gateway endpoints answer:

```json
{ "ok": true, "deviceId": "…", "accepted": 12, "matched": 3, "unknown": 9, "ignored": 0,
  "skipped": 1, "recorded": 1, "zoneChanges": 1, "moved": 1 }
```

`accepted` advertisements were readable and above the gateway's RSSI floor;
`matched` came from a known tag; `unknown` from anything else (kept in memory
for **Heard nearby** for ten minutes, never stored); `skipped` were entries
that are not advertisements (gateway heartbeats); `recorded` sightings were
written; `zoneChanges` rooms decided and `moved` item moves written. Errors are
as in the tracking core: 400 says what the body should look like, 401 a bad
token, 403 a disabled device or wrong kind, 503 `ble_disabled` when the feature
is off.

Posting BLE reads to the tracking core's `/api/device/reads` also works, but
each read then takes the posting gateway's own room directly, with no smoothing
across gateways. Use `/api/device/ble/reads` for room-level presence.

### Identities

What a tag or beacon is called, as stored in its device's serial field and on
its sightings:

| Frame | Identity |
| --- | --- |
| iBeacon | `ibeacon:<uuid, lowercase, dashed>:<major>:<minor>` |
| Eddystone-UID | `eddystone:<namespace, 20 hex>:<instance, 12 hex>` |
| AltBeacon | `altbeacon:<id1>:<id2>:<id3>` |
| Anything, by address | `mac:<AA:BB:CC:DD:EE:FF>` |
| Kontakt.io | `kontakt:<uniqueId>` |

The forms are canonicalised when a device is saved, so `iBeacon:E2C56DB5DFFB…:1:2`
and `ibeacon:e2c56db5-dffb-…:1:2` are the same tag. An item can also be
followed without registering its tag, by giving the item an identifier whose
value is the tag's identity or MAC (type `mac` for a MAC).

### Bindex's format

```json
{
  "gateway": "pi-dock-a",
  "battery": 100,
  "reads": [
    { "mac": "AC:23:3F:A1:B2:C3", "rssi": -61, "ts": 1790000000123, "data": "0201061AFF4C000215E2C56DB5…" },
    { "code": "eddystone:edd1ebeac04e5defa017:0bdb87539b67", "rssi": -70 },
    { "uuid": "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", "major": 1, "minor": 2, "rssi": -75 },
    "mac:AC:23:3F:A1:B2:C4"
  ]
}
```

| Field | Notes |
| --- | --- |
| `gateway` | Optional. The gateway's own id, for `INGEST_TOKEN` posts. `device` and `reader` work too. |
| `battery` | Optional. The gateway's own battery, 0 to 100. |
| `reads[].data` | The advertising data, hex. The best option: every frame type is decoded from it. |
| `reads[].mac` | The advertiser's address. |
| `reads[].code` | An identity or MAC, when the gateway decoded the frame itself. Or `uuid`/`major`/`minor`, or `namespace`/`instance`. |
| `reads[].rssi` | dBm. A read without it counts as heard but cannot place anything. |
| `reads[].ts` | Optional. ISO 8601 or epoch seconds or milliseconds. |
| `reads[].battery`, `batteryMv`, `temperature`, `txPower` | Optional, when the gateway decoded them. |

`reads` may also be the body itself. It is a superset of the tracking core's
generic format, so a script written for `/api/device/reads` works here.

### Vendor formats

These adapters were **built from each vendor's published documentation and
have not yet been verified on hardware**. The fixtures they are tested against
follow the documented shapes (`server/tests/ble-adapters.test.ts`). If your
gateway's payload differs, the endpoint answers 400 saying what it expected;
please report it with a sample.

**Minew G1 and MG3.** In the gateway's web console, set the upload to HTTP (or
MQTT, below) with the JSON format that includes `rawData`, the URL
`https://<host>/api/device/ble/minew`, and the gateway's token (as a bearer
token if offered, else `?token=`). The body is an array; the entry with
`"type": "Gateway"` names the gateway by its `mac`, and every other entry is
one advertiser with `mac`, `rssi`, `timestamp` and `rawData`. Parsed formats
(`ibeaconUuid`, `ibeaconMajor`, `ibeaconMinor`, `ibeaconTxPower`, `battery`)
are read too; `rawData` wins when both are present. A `battery` of 0 means not
reported.

**Ingics iGS01, iGS02, iGS03.** Configure HTTP POST to
`https://<host>/api/device/ble/ingics?token=<token>`. The body is report lines,
`$GPRP,<tag MAC>,<gateway MAC>,<RSSI>,<advertising data>[,<unix time>]`, one
per advertisement; `$SRRP` (scan responses), `$LRRP` and `$LRSR` (long range)
are read the same way, other lines ignored. Text, a JSON array of lines, or a
form field holding them are all accepted.

**Kontakt.io-style events.** For a Kontakt.io Portal Beam, gateway, or a
forwarder of their events: a JSON array (or `{ "events": [...] }`), each with
`uniqueId` (the id printed on a Kontakt.io beacon, registered as
`kontakt:<uniqueId>`) and/or `trackingId` (its MAC), `sourceId` (the gateway),
`rssi`, `timestamp` (seconds or milliseconds) and `batteryLevel`.

**Teltonika trackers** (FMB, FMC, FMT, TAT with beacon scanning) speak Codec 8
over TCP, which a forwarder such as flespi decodes into JSON; point its HTTP
stream at `/api/device/ble/teltonika`. Each record names the tracker by
`ident` (IMEI), with `timestamp`, `position.latitude` and `position.longitude`,
and the beacons it heard under `ble.beacons` as `{ id, rssi }`. An id of 40 hex
digits is an iBeacon (UUID, major, minor), 32 an Eddystone-UID, 12 a MAC. The
tracker is a moving gateway: give it the vehicle as its room (a "Truck 12"
location) and tags in the truck are placed in the truck, while the tracker's
own GPS position is kept on its device.

### Phone format

```json
{ "battery": 64, "beacons": [
  { "uuid": "E2C56DB5-DFFB-48D2-B060-D0F5A71096E0", "major": 1, "minor": 7, "rssi": -63 },
  { "namespace": "EDD1EBEAC04E5DEFA017", "instance": "0BDB87539B67", "rssi": -80 },
  { "id": "ibeacon:…", "rssi": -85 } ] }
```

The logging format of the open-source Android app **Beacon Scanner**
(`beacons` with `beaconType`, `ibeaconData`, `eddystoneUidData`, `rssi`,
`lastSeen`) and Bindex's gateway format are accepted too. The answer says which
room the phone was placed in:

```json
{ "ok": true, "deviceId": "…", "accepted": 3, "matched": 2,
  "room": { "locationId": "…", "name": "Dock A", "since": "…", "expiresAt": "…" } }
```

## MQTT

For gateways that publish rather than POST, set `BLE_MQTT_URL` (for example
`mqtt://broker.local:1883`, with `BLE_MQTT_USERNAME` and `BLE_MQTT_PASSWORD`)
and the server subscribes to `BLE_MQTT_TOPIC` (comma-separated filters,
default `bindex/ble/+`). The `mqtt` package is only loaded when this is set.

Each message is one report in any of the formats above, detected from its shape
or fixed with `BLE_MQTT_FORMAT`. The gateway is the one the payload names, or
else the topic segment under the first `+`: with the default, a gateway
publishing to `bindex/ble/AC233FC04EAB` is the gateway with that MAC. Unknown
gateways are registered with no room the first time they report. Messages are
processed in order; if more than 1,000 are waiting, new ones are dropped and
counted. Connection state, message counts and the last error are on the
Bluetooth page and in `GET /api/ble/status`. The broker is trusted: anything
that can publish to those topics can report sightings.

## Session API

Signed-in sessions and API keys can read; everything marked admin needs an
administrator's browser session. Every path answers 404 while the feature is
off.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/ble/status` | Tuning, work hours, MQTT state, device counts. |
| `GET` | `/api/ble/occupancy` | `{ zones }`: each room with its gateways, the tags there now, and missing tags last seen there. |
| `GET` | `/api/ble/not-seen?hours=24` | `{ tags }` not heard for that long, or never. |
| `GET` | `/api/ble/battery?below=20` | `{ devices }` at or below that level. |
| `GET` | `/api/ble/alerts?open=true&limit=&before=` | `{ alerts, next }`, newest first. `open` leaves out resolved and one-off alerts. |
| `GET` | `/api/ble/items/:id/presence` | `{ tags, attached }`: each tag on the item, its room, and the gateways hearing it now. |
| `GET` | `/api/ble/me/room` | `{ room }` for the signed-in person, or null. |
| `GET` | `/api/ble/devices` | Admin. Gateways, tags, room beacons and phones with their BLE options and state. |
| `POST` | `/api/ble/devices` | Admin. `{ kind, name, externalId, locationId, itemId, unitId, updatesLocation, disabled, ble: { … } }`. Returns `{ device, token }`; a gateway's or phone's token is shown only here. |
| `PATCH` | `/api/ble/devices/:id` | Admin. Any of the create fields. `ble` keys are merged into the device's settings; `null` clears one. |
| `GET` | `/api/ble/heard?gatewayId=&all=true` | Admin. Unregistered advertisers heard in the last ten minutes. `all` includes non-beacons. |
| `POST` | `/api/ble/calibrations` | Admin. `{ tagId, locationId, seconds }`. |
| `GET` | `/api/ble/calibrations/:id` | Admin. Progress and summary. |
| `POST` | `/api/ble/calibrations/:id/stop` | Admin. Finish now. |
| `DELETE` | `/api/ble/calibrations/:id` | Admin. |

Deleting a device and issuing tokens use the tracking core's
`/api/tracking/devices` routes.

BLE options (`ble` above, kept in the device's settings): `rssiOffset`
(gateways and room beacons, dB), `txPower`, `bleMac` (a tag's telemetry
address), `missingMinutes` (0 never), `afterHoursAlert` (false to opt out),
`batteryFullMv` and `batteryEmptyMv` (for batteries reported in millivolts;
3000 and 2000 by default, which suits a coin cell), `userOid` and `userName`
(a phone's person). The tracking core's own settings (`rssiFloor`) still apply.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `BLE_WINDOW_SECONDS` | `20` | Readings kept per gateway per tag. |
| `BLE_SMOOTHING` | `median` | `median` or `ewma`. |
| `BLE_HYSTERESIS_DB` | `6` | How much stronger a room must be to take a tag. |
| `BLE_DWELL_SECONDS` | `10` | For how long. |
| `BLE_MIN_SAMPLES` | `1` | Readings a gateway needs in the window to count. |
| `BLE_MISSING_MINUTES` | `10` | Unheard this long: missing. Tags can override. Keep it well above `BLE_STORE_SECONDS`. |
| `BLE_STORE_SECONDS` | `60` | A tag that stays put is stored this often. |
| `BLE_PHONE_ROOM_SECONDS` | `300` | How long a phone's room stays current. |
| `BLE_BATTERY_LOW_PCT` | `20` | Battery alert threshold. |
| `BLE_WORK_HOURS` | | e.g. `Mon-Fri 07:00-19:00; Sat 08:00-12:00`. Blank turns out-of-hours alerts off. |
| `BLE_TIMEZONE` | server's | IANA zone for the hours, e.g. `Europe/London`. |
| `BLE_ALERT_DIGEST_MINUTES` | `15` | Digest interval. 0 sends none. |
| `BLE_MQTT_URL` | | Broker; blank is off. |
| `BLE_MQTT_TOPIC` | `bindex/ble/+` | Filters, comma-separated. |
| `BLE_MQTT_USERNAME`, `BLE_MQTT_PASSWORD` | | |
| `BLE_MQTT_FORMAT` | `auto` | `auto`, `generic`, `minew`, `ingics`, `kontakt` or `teltonika`. |

## Storage, retention and privacy

- **Sightings** are the tracking core's and follow its retention
  (`SIGHTINGS_RETENTION_DAYS`). Bluetooth writes one per room change and one per
  tag per `BLE_STORE_SECONDS`, so 500 tags make about 720,000 a day; shorten the
  retention or lengthen the interval on large sites.
- **Each tag's state** (room, since, last heard, battery voltage, temperature)
  is one row per tag in `ble_tag_state`, and survives restarts so a restarted
  server does not re-place every tag.
- **Alerts** stay until resolved, then 90 days.
- **Phone rooms** are one row per phone, current room only, ignored after
  `BLE_PHONE_ROOM_SECONDS` and deleted a day later.
- **Unregistered advertisers** (phones, headphones, other people's devices)
  are held in memory for ten minutes for **Heard nearby** and never written
  anywhere.
- **Backups** include the devices and their BLE options (they are tracking
  devices), not tag state, alerts or phone rooms, which rebuild from the next
  reports.

A tag on equipment a person carries, and above all a phone, reveals where that
person is. Tell people what is tracked; register phones only for people who
agree; keep the retention short. Bindex keeps no history of phone rooms and
does not publish them as events.

**Several replicas.** The presence engine holds each tag's recent readings in
memory, as the tracking core does for portals. With several app replicas, pin
each gateway (and the MQTT subscription, which every replica opens) to one
replica, or run a single replica for Bluetooth. Missing, battery and digest
checks are safe to run in every replica.

## Building on it

- `GET /api/ble/me/room` and the client hook `useBleRoom()` (in
  `client/src/features/ble/useBleRoom.tsx`) give the room the signed-in
  person's phone last reported, for prefilling a location, for example in
  placement guidance. `<CurrentRoomChip />` shows it.
- Server code imports from `server/src/services/ble`: `processGatewayReport`,
  `processPhoneReport`, `roomForUser`, the pure `PresenceEngine`,
  `parseAdvertisement` and `canonicalIdentity`.
- The engine (`presence.ts`) and every parser are pure and unit-tested; the
  end-to-end path is tested against Postgres in
  `server/tests/ble-db.test.ts` (set `TEST_DATABASE_URL`).
