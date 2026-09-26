# GPS trackers, maps and geofences

GPS trackers report where things are when they leave the building: a pallet
on a truck, a trailer between depots, a crate of high-value equipment, a van.
Bindex takes their positions from phones running Traccar Client or OsmAnd,
from any of the hundreds of hardware trackers a Traccar server understands,
or from your own scripts. It keeps each tracker's trail, draws everything on a
map, and watches **geofences**: when a tracker leaves a shipment's origin the
shipment goes **in transit**, when it enters the destination Bindex asks for
**delivery to be confirmed**, and every crossing is published as an event for
webhooks and the stakeholder portal.

The feature switch is **GPS tracking** in Settings, Features (`features.gps`).
It is off by default, and needs **Readers, beacons and trackers** on as well,
because trackers are devices of the tracking core ([tracking-core.md](tracking-core.md)).
Shipment screens also need **Projects, jobs and shipments**. With GPS off the
**Map** navigation entry and its screens are gone, `/api/gps` answers `404
feature_disabled`, and `/api/device/gps` answers `503 gps_disabled`.

Contents: [Setting up](#setting-up) · [Connecting trackers](#connecting-trackers) ·
[Which fixes are believed](#which-fixes-are-believed) · [Geofences](#geofences) ·
[Shipments](#shipments) · [Tracker lifecycle](#tracker-lifecycle) · [Maps and
tiles](#maps-and-tiles) · [Events](#events) · [API](#api) · [Data, backups and
retention](#data-backups-and-retention) · [Privacy](#privacy) ·
[Configuration](#configuration) · [For other features](#for-other-features) ·
[Limits](#limits)

## Setting up

1. **Settings, Features**: turn on **Readers, beacons and trackers** and **GPS
   tracking** (and **Projects, jobs and shipments** to follow shipments).
2. **Settings, Readers and devices, Add device**: kind **GPS tracker**. Put the
   tracker's IMEI or app identifier in **Serial, MAC or reader id** (Traccar
   forwarding matches on it). **Attached to** is the item it follows. Turn on
   **Move items when read** if entering a geofence linked to a location should
   change where the item is on file. Copy the token; it is shown once.
3. **Map, Geofences, New geofence**: draw a circle or polygon round each yard,
   site and depot, and link it to its location.
4. **Map, Trackers**: **Put on a shipment** (or **Fit to a vehicle**).
5. Connect the tracker (next section). It appears on **Map** within seconds.

## Connecting trackers

Every endpoint is under `/api/device/gps`, outside the browser session, and
authenticates like every other device: the device token as
`Authorization: Bearer <token>`, `x-device-token`, HTTP Basic password, or
`?token=<token>` for apps that can only be given a URL. `INGEST_TOKEN` also
works; the tracker is then found (or registered) by the id in the payload.
See [tracking-core.md](tracking-core.md#authentication) for the status codes.

| Method | Path | For | Speed unit |
| --- | --- | --- | --- |
| `GET`, `POST` | `/api/device/gps/osmand` | Traccar Client (Android, iOS), OsmAnd, anything speaking Traccar's OsmAnd protocol | knots (query/form); m/s (Traccar Client JSON) |
| `POST` | `/api/device/gps/traccar` | A Traccar server forwarding positions or events | knots |
| `POST` | `/api/device/gps` | Your own scripts, gateways, buffered uploads | m/s |

These parsers were **built from each protocol's published description and have
not been verified against every app version or tracker**. A payload that is not
the expected shape gets a `400` saying what was expected; please report it with
a sample.

### Traccar Client on a phone

In Traccar Client's settings:

- **Server URL**: `https://<your host>/api/device/gps/osmand?token=<device token>`
- **Device identifier**: anything; put the same value in the tracker's serial.
- **Location accuracy**: high. **Frequency**: 30 to 60 seconds for a vehicle.

Older versions send each position as query parameters; version 8 and later
post JSON (`device_id`, `location.coords`, `location.battery`). Both are read.

### OsmAnd

**Plugins, Trip recording, Online tracking**, web address:

```
https://<your host>/api/device/gps/osmand?token=<device token>&lat={0}&lon={1}&timestamp={2}&hdop={3}&altitude={4}&speed={5}&bearing={6}
```

OsmAnd sends speed in metres per second while the protocol says knots, so set
the tracker's **Speed arrives in** to metres per second (Map, Trackers, GPS
settings).

### A Traccar server (hardware trackers)

A [Traccar](https://www.traccar.org) server decodes almost every commercial
GPS tracker (Teltonika, Queclink, Concox, Meitrack, ...). Point your
hardware at Traccar as its documentation describes, then have Traccar forward
to Bindex:

1. In Bindex, add a GPS tracker called, say, "Traccar server", open its **GPS
   settings** and turn on **Relays other trackers**. Copy its token.
2. In `traccar.xml`, add position forwarding (key names as in Traccar 5 and 6;
   check your version's configuration reference):

   ```xml
   <entry key='forward.enable'>true</entry>
   <entry key='forward.json'>true</entry>
   <entry key='forward.url'>https://<your host>/api/device/gps/traccar?token=<relay token></entry>
   ```

   Event forwarding (`event.forward.enable`, `event.forward.url`) is accepted
   too: an event's position is stored, and an event without one counts as the
   tracker being heard.
3. Restart Traccar. Each device Traccar forwards is matched to a Bindex GPS
   tracker by its **unique id** (`device.uniqueId`, usually the IMEI) against
   the tracker's serial, and **registered automatically** the first time it
   appears, named as in Traccar. Attach each to its item afterwards.

A tracker that is not a relay can only post its own position through this
endpoint (its serial must equal `device.uniqueId`); anything else is refused
with `403`, so one tracker's token cannot write another's history. Traccar
positions marked `outdated` (the last one repeated) or `valid: false` are not
taken as new fixes.

### Batch format

```json
{
  "device": "truck-12",
  "battery": 64,
  "fixes": [
    { "ts": "2026-09-26T14:00:00Z", "lat": 51.5007, "lng": -0.1246, "accuracy": 6, "speed": 13.4, "heading": 92, "altitude": 35 }
  ]
}
```

`ts` is ISO 8601 or epoch seconds or milliseconds; speed is metres per second;
`lon` works for `lng`. A fix may carry its own `device` and `battery`, so a
relay can post for several trackers at once. Up to 50,000 fixes per request.

### Responses

```json
{ "ok": true, "deviceId": "…", "trackers": 1, "fixes": 3, "accepted": 2, "outOfOrder": 0,
  "rejected": 1, "entered": 0, "exited": 1, "recorded": 3, "suppressed": 0, "moved": 0,
  "skipped": 0, "refused": 0 }
```

`accepted` fixes were believed; `outOfOrder` arrived after a later fix and were
kept as history; `rejected` were jumps or fixes the tracker marked invalid.
`entered`/`exited` count confirmed geofence crossings. `recorded`,
`suppressed` and `moved` are the tracking core's counts. `refused` counts
reports for trackers this device may not report for.

## Which fixes are believed

Every fix is stored as a sighting (tech `gps`) with its coordinates, accuracy,
speed and heading, so the trail is complete. Not every fix is believed:

- **Late fixes.** A fix older than the tracker's last believed fix (a buffered
  upload, a retry) is stored in its place in history, with `outOfOrder` in its
  meta, but moves nothing and fires no geofence.
- **Jumps.** A fix that would need more than **`GPS_MAX_SPEED_MPS`** (70 m/s,
  250 km/h, by default; per tracker in its GPS settings) to reach from the last
  believed fix, after allowing up to 100 m of each fix's stated accuracy, is a
  glitch. It is stored with `rejected: "jump"` and attached to no item, so it
  moves nothing, and the map shows it only on request.
- **Re-anchoring.** If three rejected fixes in a row agree with each other, the
  tracker really is there (it was moved while off, or the first fix was the
  bad one), and the third is believed.
- **Invalid fixes.** A fix the tracker itself flags invalid (`valid=false`, a
  mock location) is stored flagged, like a jump. A position of exactly 0, 0
  (what many trackers send before their first fix) is dropped.
- A time more than a minute in the future is replaced by the server's, as for
  every sighting.

The tracker's own position on the device registry is its last believed fix.

## Geofences

A geofence is a **circle** (centre and radius) or a **polygon** (outline, and
holes if drawn as GeoJSON), stored as GeoJSON in `geofences.geometry`.
Geometry is plain TypeScript: great-circle distances, even-odd point-in-polygon
with longitudes unwrapped, so fences and trackers either side of the
antimeridian work. There is no PostGIS dependency.

**Crossing rules.** For each tracker and fence:

- A fix whose accuracy circle straddles the edge is **uncertain** and changes
  nothing. That band is also the hysteresis that stops a tracker parked on the
  line from flapping.
- A fix on the other side starts a **pending** crossing; a later fix still on
  that side at least the fence's **dwell** (30 seconds by default) after it
  confirms it; a fix back on the original side cancels it. With a dwell of 0
  the first fix confirms.
- The crossing is dated when the tracker **actually crossed** (the first fix on
  the new side), and `confirmed_at` records when it was confirmed.
- A fence drawn, reshaped, or switched back on after a tracker was last
  checked has never seen that tracker: its next fix tells the fence which side
  it is on **without an event**, so redrawing a yard never announces that every
  truck in it just arrived. The comparison uses server times only.

Confirmed crossings are stored in `geofence_events` and published as
`geofence.entered` / `geofence.exited`.

**Locations.** A fence linked to a location stands for it. A tracker confirmed
inside linked fences is in the location of the **smallest** one (a dock fence
inside a yard fence wins); outside every linked fence it is in no zone, which
the tracking core records as a position, not a move. Entering a fence moves
the attached item's position there and writes one `moved` event; with **Move
items when read** it also changes where the item is on file. An item on file
in a room of that location (the fence is round "Depot", the item is in "Depot /
Bay 4") is already there and stays in its room.

## Shipments

**Links.** A tracker is **put on a shipment**, or **fitted to a vehicle** (a
location, the shipment's `vehicle_location_id`), in which case it follows every
open shipment on that vehicle. Links are kept as history when they end.

**Origin and destination.** Each shipment's fences are, in order: the ones set
on the link, else the fence of the job's origin (or destination) location or of
its nearest ancestor with one. A job going to "HQ / Level 5 / Finance" arrives
when its tracker enters the fence drawn round "HQ".

**Milestones.**

| When a tracker... | Bindex |
| --- | --- |
| leaves the origin fence | stamps the departure, and sets the shipment **in transit** through the jobs core (which stamps `departed_at` and records "GPS: <tracker>" in the status history). If the jobs core refuses because lines are not loaded, the shipment is left as it is and a **prompt** asks a person to decide. Publishes `shipment.departed` either way. |
| enters a fence on the way, while in transit | adds a waypoint and publishes `shipment.waypoint_reached` |
| enters the destination fence | stamps the arrival, **prompts** for delivery to be confirmed (Map, the shipment, **Mark delivered**), and publishes `shipment.arrived`. It never marks a shipment delivered by itself: arriving at the gate is not the same as being unloaded. |

When the shipment is marked delivered (from anywhere), trackers put on it come
off it; single-use ones then wait to be returned. Vehicle trackers stay on
their vehicle.

**Route figures**, kept under `gps` in the shipment's metadata and refreshed
with every fix:

| Key | Meaning |
| --- | --- |
| `departedAt`, `arrivedAt` | When a tracker crossed the origin and destination fences |
| `travelledM` | Metres along the believed fixes since departure. With two trackers on one shipment each stretch is counted once. |
| `remainingM` | Straight-line metres from the last fix to the nearest edge of the destination fence. Road distance is longer. |
| `speedMps` | Average over the last half hour of fixes |
| `eta` | Now plus `remainingM` at `speedMps`. Null when stopped (under 0.5 m/s), with no destination fence, or more than two weeks out. An optimistic floor, not a promise. |
| `lastFix` | `{ lat, lng, at, deviceId }` |
| `prompt` | `{ status: "in_transit" \| "delivered", at, geofenceId, reason }`, cleared when the status is set or the prompt dismissed |
| `waypoints` | `[{ geofenceId, name, at }]`, the last 20 |

The shipment's own `eta` and `distance_km` columns are the plan and are never
overwritten.

## Tracker lifecycle

| Status | Means |
| --- | --- |
| `available` | Not on anything |
| `assigned` | On a shipment or fitted to a vehicle |
| `awaiting_return` | A **single-use** tracker whose shipment was delivered. It cannot be put on another shipment until marked returned. |
| `disposed` | Thrown away, lost, or retired. Disposing takes it off whatever it was on. **Put back in service** makes it available again. |

**Battery.** A tracker at or below its warning level (`GPS_BATTERY_LOW_PCT`, 20
by default, or its own) is flagged on the map and trackers list, and warned
about once (`tracker.battery_low`, plus Pushover or Wazuh when configured)
until it is charged back above the level plus 10. Trackers not heard from for
an hour are shown as silent.

## Maps and tiles

Maps use [Leaflet](https://leafletjs.com) with tiles from `MAP_TILE_URL`
(OpenStreetMap by default) and the `MAP_ATTRIBUTION` credit. The screens:

- **Map**: every tracker where it last reported, coloured by status, with the
  geofences; low battery, awaiting return and silent trackers are counted at
  the top. Refreshes every 15 seconds.
- **Trackers**: the fleet, links, lifecycle actions and GPS settings.
- **Trail** (from a tracker, or `/gps/items/:id` for an item): the fixes in a
  time range as a line, a slider and Play button that walk along it, geofence
  crossings, and optionally the fixes that were not believed.
- **Shipment map** (`/gps/shipments/:id`): origin and destination fences, the
  trails of its trackers since departure, route figures, the prompt, trackers
  on it and a timeline of statuses and crossings.
- **Geofences**: draw a circle (click the centre, set the radius) or polygon
  (click the corners; drag any handle), link it to a location, set its dwell.
  Administrators edit; everyone else can look.

**Tile providers.** OpenStreetMap's own servers are free for light use under
their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/);
a fleet refreshing maps all day should use a commercial provider (MapTiler,
Stadia Maps, Thunderforest and others give an XYZ URL with a key) or a
self-hosted tile server (for example `tileserver-gl` with an OpenMapTiles
extract). Set `MAP_TILE_URL` to its `{z}/{x}/{y}` template (`{s}` subdomains
work) and `MAP_ATTRIBUTION` to the credit its licence asks for.

The page's Content-Security-Policy allows the tile host automatically. Serve
tiles over **HTTPS**: the policy upgrades insecure requests and browsers block
plain-HTTP images on an HTTPS page anyway. A tile key in the URL is visible to
every signed-in user, as it is with any browser map.

## Events

All go to the audit log, webhooks and the polling feed
([event-backbone.md](event-backbone.md)). Hardware-originated ones have a
`device` actor naming the tracker.

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `geofence.entered`, `geofence.exited` | `geofence` | A crossing was confirmed | `{ eventId, geofenceId, geofenceName, locationId, deviceId, deviceName, itemId, unitId, shipmentIds, occurredAt, confirmedAt, lat, lng }` |
| `geofence.created`, `geofence.updated`, `geofence.deleted` | `geofence` | An administrator changed a fence | `{ name, kind, geometry, radiusM, locationId, active, dwellSeconds }`, plus `changed` and `statesReset` on update |
| `shipment.departed` | `shipment` | A tracker left the origin fence | `{ code, jobId, name, deviceId, deviceName, geofenceId, geofenceName, lat, lng, departedAt, status, statusApplied, refusal }` |
| `shipment.waypoint_reached` | `shipment` | A tracker entered another fence while in transit | `{ code, jobId, name, deviceId, deviceName, geofenceId, geofenceName, lat, lng, at, status }` |
| `shipment.arrived` | `shipment` | A tracker entered the destination fence | `{ code, jobId, name, deviceId, deviceName, geofenceId, geofenceName, lat, lng, arrivedAt, status, deliveryPrompted }` |
| `tracker.assigned` | `tracker` (device id) | Put on a shipment or vehicle | `{ deviceId, deviceName, linkId, shipmentId, shipmentCode, vehicleLocationId, vehicleName }` |
| `tracker.unassigned` | `tracker` | Taken off, by hand, on delivery, or on disposal | `{ deviceId, deviceName, linkId, shipmentId, shipmentCode, vehicleLocationId, reason, status }` |
| `tracker.status_changed` | `tracker` | Returned, disposed of, or back in service | `{ deviceId, deviceName, from, to, note }` |
| `tracker.battery_low` | `tracker` | Battery reached the warning level | `{ deviceId, deviceName, batteryPct, threshold, itemId }` |

A status change GPS makes also produces the jobs core's
`shipment.status_changed`.

## API

Session API under `/api/gps`, for signed-in people and API keys (read keys get
the `GET`s). Geofence and tracker-setting changes need an administrator's
browser session.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/gps/config` | Tile URL, attribution, max zoom, defaults, the tracker endpoints |
| `GET` | `/api/gps/trackers` | `{ trackers }`: each GPS tracker's device fields plus `gps` settings, `status`, last believed fix, `batteryLow`, `stale`, active `links` |
| `GET` | `/api/gps/trackers/:id` | One, with every link it has had |
| `PATCH` | `/api/gps/trackers/:id/settings` | Admin. `{ maxSpeedMps?, singleUse?, speedUnit?: "kn" \| "mps" \| "kmh" \| "mph" \| null, relay?, batteryLowPct? }`, kept under `settings.gps` on the device |
| `POST` | `/api/gps/trackers/:id/status` | `{ status: "available" \| "disposed", note? }` |
| `GET` | `/api/gps/trackers/:id/trail` | `?from=&to=&limit=&rejected=true`. Default the last 24 hours, at most 5,000 fixes (the latest, with `truncated`) |
| `GET` | `/api/gps/items/:id/trail` | Same, for an item, default 7 days, believed fixes only |
| `GET` | `/api/gps/geofences` | `?all=true` includes switched-off ones |
| `GET` | `/api/gps/geofences/:id` | |
| `POST` | `/api/gps/geofences` | Admin. `{ name, kind: "circle" \| "polygon", geometry (GeoJSON Point or Polygon), radiusM?, locationId?, active?, dwellSeconds?, color?, notes? }` |
| `PATCH` | `/api/gps/geofences/:id` | Admin. Any field. A new shape, or switching it on or off, resets which side trackers are on. |
| `DELETE` | `/api/gps/geofences/:id` | Admin. Crossings stay, with the fence's name. |
| `GET` | `/api/gps/events` | `?geofenceId=&deviceId=&shipmentId=&itemId=&before=&limit=`, newest first; pass `next` as `before` |
| `GET` | `/api/gps/links` | `?deviceId=&shipmentId=&vehicleLocationId=&active=true` |
| `POST` | `/api/gps/links` | `{ deviceId, shipmentId? \| vehicleLocationId?, originGeofenceId?, destinationGeofenceId? }` |
| `POST` | `/api/gps/links/:id/end` | Take the tracker off |
| `GET` | `/api/gps/shipments/open` | Shipments a tracker can be put on (needs jobs) |
| `GET` | `/api/gps/shipments/:id` | The shipment map: shipment, `gps` figures, fences, links, trails, crossings, status history |
| `POST` | `/api/gps/shipments/:id/dismiss-prompt` | Clear the suggestion without acting on it |

## Data, backups and retention

Migration `server/migrations/0031_gps.sql`; Drizzle tables in
`server/src/db/tables/gps.ts`.

| Table | Holds |
| --- | --- |
| `geofences` | name, kind, GeoJSON geometry, radius, linked location, active, dwell, colour, notes, `geometry_at` (last change of shape) |
| `gps_trackers` | per tracker: lifecycle status, last believed fix, the jump filter's run of rejected fixes, the last half hour of fixes, battery warning state, `evaluated_at` |
| `geofence_states` | which side of each fence each tracker is on, and any pending crossing. No row means outside. |
| `geofence_events` | every confirmed crossing, with the audit-log id it was published as |
| `gps_tracker_links` | trackers on shipments and vehicles, including ended ones |

Fixes themselves are sightings in the tracking core's `sightings` table.

**Backups** include geofences, tracker links and each tracker's lifecycle
status. The filter's memory, fence states and crossings are left out, like
sightings; after a restore each tracker's next fix learns its fences quietly.
A backup file from before this feature keeps the current geofences.

**Retention.** Sightings (the trail) are pruned after
`SIGHTINGS_RETENTION_DAYS`, and geofence crossings with them, daily.

## Privacy

GPS trails are location history, and a tracker in a vehicle, or a phone in a
pocket, is a person's location history. Before deploying:

- **Tell people.** Drivers and crews should know which vehicles and phones
  report, when, and who can see it. Traccar Client can be stopped by the person
  carrying it; that is a feature.
- **Who can see it.** Anyone signed in, and any API key, can read trackers,
  trails, crossings and shipment maps. Only administrators can register
  devices, draw fences or change tracker settings. The event feed and webhooks
  carry crossings, with coordinates, to wherever they are configured to go.
- **How long.** Keep `SIGHTINGS_RETENTION_DAYS` as short as the job allows;
  trails and crossings go with it. The **audit log keeps every published event
  forever** by design (it is tamper-evident), and crossings and shipment
  milestones include the coordinates of the crossing. If that is too much,
  keep GPS off or send only what you need to webhooks.
- **Stop tracking.** Disable the device in Readers and devices to ignore what
  it sends, dispose of it, or delete it. Switching the feature off stops
  accepting positions at once.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `MAP_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | XYZ tile template for every map |
| `MAP_ATTRIBUTION` | OpenStreetMap contributors | Credit shown on maps (HTML) |
| `MAP_MAX_ZOOM` | `19` | Highest zoom the tile service offers |
| `GPS_MAX_SPEED_MPS` | `70` | Faster than this between fixes is a jump. Trackers can override it. |
| `GPS_BATTERY_LOW_PCT` | `20` | Battery warning level. Trackers can override it. |

`SIGHTINGS_RETENTION_DAYS`, `TRACKING_DEDUP_SECONDS` and `DEVICE_INGEST_MAX_MB`
from the tracking core apply too.

## For other features

Import from `server/src/services/gps`.

- **Portal (T15)**: listen for `shipment.departed`, `shipment.waypoint_reached`,
  `shipment.arrived` and `geofence.*` on the event feed; `geofence.*` carries
  `shipmentIds`. Read `shipment.metadata.gps` for distance, straight-line
  distance to go, ETA and last position (`readShipmentGps(metadata)` parses it
  defensively). `shipmentMap(id)` returns everything the shipment map shows.
- **Geometry** (`haversineM`, `pointInPolygon`, `containment`, `stepFence`) is
  pure and exported for anything else that needs it.
- A delivered shipment ends its trackers' links from an
  `onShipmentStatusChanged` listener registered when `services/gps` is first
  imported.

## Limits

- Protocol parsers follow published descriptions; they are unverified against
  real hardware and every app version.
- Batches for one tracker are processed one at a time per server process. With
  several replicas, send each tracker to one replica (as for the tracking
  core's duplicate filter), or two batches from one tracker processed at once
  may both judge fences from the same starting state.
- ETA is straight-line distance over recent average speed. It knows nothing of
  roads, traffic or stops.
- Geometry treats polygon edges as straight lines in longitude and latitude
  (as GeoJSON does). Fine for sites and towns; a polygon hundreds of kilometres
  across has edges that differ from great-circle lines.

## Code map

```
server/migrations/0031_gps.sql
server/src/db/tables/gps.ts
server/src/services/gps/
  geo.ts          distances, point in polygon, boundaries (pure)
  fence.ts        compiled fences, containment, the crossing rule (pure)
  filter.ts       which fixes to believe (pure)
  route.ts        average speed and ETA (pure)
  protocols.ts    OsmAnd, Traccar Client JSON, Traccar forwarding, batch (pure)
  tiles.ts        CSP sources for the tile URL (pure)
  settings.ts     per-tracker GPS options
  ingest.ts       reports to sightings, crossings and milestones
  geofences.ts    fence records and the cached active set
  trackers.ts     lifecycle and links
  shipments.ts    milestones, route figures, the delivery hook
  queries.ts      trails, crossings, the shipment map
  events.ts       event types
  backup.ts prune.ts index.ts
server/src/routes/gps.ts                 /api/device/gps and /api/gps
client/src/features/gps/                 maps and screens
server/tests/gps-geometry.test.ts        geometry, fences, filter, route (pure)
server/tests/gps-protocols.test.ts       parsers and the batch planner (pure)
server/tests/gps-db.test.ts              a recorded trip over HTTP, on Postgres (opt-in)
server/tests/gps-fixtures.ts             the recorded trip (GPX)
```

## Testing

```bash
pnpm test                                     # pure logic, no database needed
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_gps \
  pnpm --filter bindex-server test            # also replays the trip on Postgres
```

The database test replays `gps-fixtures.ts` (a truck leaving a warehouse,
passing a depot, arriving at a site, with one multipath glitch and one fix
delivered late) through `/api/device/gps/osmand` one request per fix, and
checks the trail, exactly one exit from the origin and one entry to the
destination, the shipment going in transit and waiting for delivery, the item
arriving where the site's fence says, the events, that replaying the upload
changes nothing, and that delivery takes the single-use tracker off.
