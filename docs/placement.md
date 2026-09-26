# Placement guidance

When a delivery arrives, every box, chair and server has a room it belongs
in. Placement tells the crew which one as each label is scanned at the truck,
confirms it got there (by a button, a sweep of the room with a handheld
reader, or a fixed reader in the room), and flags anything in the wrong room,
off the wrong truck, or not on this job at all. Progress bars per floor and
per room show how far the delivery has got, and once a truck is delivered, a
list shows what never came off it.

It builds on two other features:

- **Projects, jobs and shipments** ([jobs-core.md](jobs-core.md)): each
  manifest line's destination, floor and department are the plan, and every
  outcome is a stage change recorded in the job's stage history.
- **Readers, beacons and trackers** ([tracking-core.md](tracking-core.md)):
  reads from readers in rooms are what confirm placement without anyone
  pressing a button. Without it, the card, sweeps with a handheld, and the
  kiosk (with scans at the tablet) still work.

The feature switch is **Placement guidance** (`features.placement`) in
Settings, Features. It is off by default and needs **Projects, jobs and
shipments** on. With either off, the Placement navigation entry and its
screens are gone, every `/api/placement` request answers `404
feature_disabled`, and readers place nothing.

## Using it

1. **Give every line a destination.** Open **Placement**, pick the job, and
   go to **Destinations**. Lines added from a location already know where
   they came from; the proposals use that (see [Destination
   rules](#destination-rules)). Add **room map** rows for the rooms whose
   names changed ("Old HQ / Floor 3 / Finance" goes to "New HQ / Level 5 /
   5.14"), tick the proposals you agree with, and apply them. A move plan CSV
   imported on the job page works too.
2. **At the truck: Where does this go?** Pick the truck being unloaded and
   press Start. Scan each label with a handheld, the camera button, a desk
   reader or the live reader feed. The screen shows the destination room in
   large type under a band in the floor's colour, with the desk, floor,
   department, crate and handling notes. **Placed here** records it placed.
   A label on another truck turns the screen red with an alarm and is flagged
   `wrong_shipment` on its line; a label that belongs to another job, or to
   no job, does the same and names the job it belongs to.
3. **In a room: Sweep a room.** Pick the room (with Bluetooth room beacons
   installed, the room the phone is in is picked for you), start, and walk the
   room with a handheld reader. The screen shows *belongs here 34/36*, *extra
   2 (belong in 3.14)*, what belongs here and has not been seen, and anything
   not on the job. Lines that belong here are placed as they are read; lines
   that belong elsewhere are flagged misplaced, with this room noted.
4. **Fixed readers in rooms** do the same without anyone sweeping (see
   [Room readers](#room-readers)).
5. **At a floor entrance: Entrance kiosk.** Put a tablet on a tripod by the
   door with the portal or reader there, pick that reader and what the
   entrance leads to, and start. Everything read shows in a large list with
   where it goes; anything bound for another floor, or not on this job,
   shows in red with an alarm. Labels scanned at the tablet show too. The
   kiosk only shows: rooms are confirmed by their own readers, sweeps and the
   card.
6. **Progress** on the job's Placement page: one bar for the job, one per
   floor in its colour, one per room; what is in the wrong room and where it
   was found; **missing after delivery** (see below); and everything still to
   place.

## Rules

### Where something belongs

A line **belongs** in a place when the place is its destination, or lies
within it (a reader covering one wall of room 5.14 is in 5.14). When the
destination lies within the place (a room on the floor a reader covers), the
line is only **nearby**: the read cannot say which room it went to, so
nothing changes.

Plans that name desks as locations ("5.14 / Desk A") need the reader or sweep
to say that places inside its room count: **Count desks inside this room** on
a sweep, **Covers desks inside** on a reader. The usual plan, where the
destination is the room and the desk is the line's destination label, needs
neither.

### The placement card

One scanned label, one line: a line not yet placed wins over a placed one,
and among those, one on the truck being unloaded (or on no truck) wins over
one on another truck. The outcomes:

| Outcome | Screen | Changes |
| --- | --- | --- |
| `ok` | Floor band, destination, desk, floor, department, notes, **Placed here** | nothing until the button: then `placed` |
| `no_destination` | Amber: the plan does not say | nothing |
| `already_placed` | Grey band | nothing |
| `wrong_shipment` | Red, alarm: planned for another truck | the line moves to `wrong_shipment` (once), with a note naming both trucks |
| `not_on_job` | Red, alarm: the jobs it is on instead | an observation on this job |
| `unknown` | Magenta: no item has this code | nothing |

**Placed here** works from any stage, including `wrong_shipment` ("placed
here anyway").

### Sweeps

Codes resolve as scanning to a stage does, so an item's own label stands in
for its units one scan at a time, and a line is claimed by the first code in
the batch that reaches it. A person chose the room and is standing in it, so
the room is taken at its word:

| Outcome | When | Changes |
| --- | --- | --- |
| `placed` | belongs here | moves to `placed` |
| `already` | belongs here and was placed, or read twice | nothing |
| `misplaced` | belongs anywhere else, whatever its stage, even if it was placed elsewhere before | moves to `misplaced`, with this room noted |
| `nearby` | its destination is inside this room (without desks counted) | nothing |
| `no_destination` | on the job with no destination | nothing |
| `held` | flagged damaged | nothing: a person decides |
| `not_on_job`, `unknown` | as on the card | an observation for `not_on_job` |
| `blocked` | a stage guard (another feature's rule) refused it | nothing; the reason is shown |

### Room readers

A background worker reads new sightings every
`PLACEMENT_READER_POLL_SECONDS` (2 by default) and applies those with a zone.
The zone is the one the tracking core gave the read: the reader's location,
the location its antenna is mapped to, or for a portal the side the tag went
through to. For each read of an item on a job **in progress**:

- **Placed** when the zone is the line's destination (or within it), from any
  stage except placed and damaged. A pending line whose box is already in its
  room is placed.
- **Misplaced**, with the zone noted, when the zone is a room this job
  delivers to (the destination of any of its lines, or inside one) and the
  line has left the origin: loaded, delivered, missing, or already misplaced
  elsewhere. A reader at the dock or in a corridor is never a verdict, and a
  reader in a room at the origin cannot flag a line still being packed.
- Nothing otherwise, including reads on the right floor but not in the room.
- **A placed line stays placed for readers.** A tag read through a wall from
  the next room is more likely than a desk walking off; a person's sweep can
  still flag it.
- A tag on the item matches the item's own line; a tag on a unit matches the
  unit's line, or the item's when the job moves the item whole. An item tag
  never stands in for one of several unit lines, because a reader cannot say
  which unit it saw.
- Per line, a placing read wins over any misplacing reads in the same batch,
  and of several misplacing reads the latest decides the room. Being read
  again in the room it is already misplaced in changes nothing.
- Reads older than 30 minutes (a backlog, or a reader that was offline) are
  skipped: they say where something was, not where it is.

Planned jobs have not started and finished jobs are history, so readers
leave both alone; the card and sweeps work on planned jobs too (and start
them, as any first scan does).

**Which readers count.** Every device with a zone confirms placement unless
it is switched off in **Settings, Placement: room readers**, stored as
`settings.placement.confirm = false` on the device. **Covers desks inside**
is `settings.placement.nested = true`. Both are merged into the device's
settings, so its other settings are untouched.

**How it reads the feed.** The tracking core has no listener hook and does
not need one: sightings have an increasing id, so the worker keeps a cursor
(`placement_cursors`) and reads what arrived since its last run. The first
run after the feature is switched on starts from the newest sighting, not
from history. Each run waits for sightings to be two seconds old, so a batch
whose transaction commits late is not skipped; if one still is, the tag is
read again within the reader's duplicate window. With several replicas, one
takes a Postgres advisory lock per run and the others skip it.

### Bluetooth room presence

When the Bluetooth feature (beacons, gateways and room-level presence) is
installed, its presence engine decides which room a tag is in and stores that
as a sighting with tech `ble`; the worker uses those like any other room
read, recording `via: ble`. Without it, a BLE read's zone is only the gateway
that heard it, which is not a room verdict, so BLE reads are ignored.

Placement detects the feature at run time: its migration (`0030_*.sql`) has
run and its switch (`features.ble`) is not explicitly off. Settings shows
whether it was found.

For phones, **Sweep a room** asks `GET /api/ble/me/room` for the room this
person's phone hears a room beacon in, and picks it when the answer has a
location id (`locationId`, `room.locationId`, `room.id` or `location.id`).
Any error, including a 404 when the feature is not installed, is ignored.

### Missing after delivery

Once a shipment is **delivered** or **closed**, each of its lines that is not
placed is listed:

- **Never unloaded**: still pending, packed or loaded. It never came off the
  truck.
- **Flagged missing**: already marked missing.
- **Unloaded, not in its room**: delivered but not placed.

Tick lines and **Flag missing** to move them to `missing`. Lines on trucks
still on the road, and lines on no truck, are not listed.

### Floors and colours

A line's floor is the plan's `floor`, or when it has none, the nearest place
above its destination whose name reads as a floor ("Level 5", "Floor 3",
"L5", "B1", "3rd floor", "Ground", "Mezzanine"). Each floor has a colour from
its number (floors 4 and 5 never share one, and floor 5 is the same colour on
every job); a job can override any floor's colour under **Destinations, Floor
colours** to match the signage on site.

## Destination rules

For each line with no destination (or every line, with **Also replace
destinations already set**), in this order:

1. **Room map.** The nearest mapped place at or above the line's origin
   decides. The rest of the origin's path is followed below the mapped
   destination: with "Old HQ / L3 / Finance" mapped to "New HQ / L5 /
   Finance", a desk at ".../Finance/Desk 12" goes to ".../Finance/Desk 12" at
   the new site when there is one, and to the new Finance when there is not.
2. **Same place.** With both ends of the move known (the job's origin and
   destination, or the roots picked above the proposals), "L3 / 3.14" under
   the origin goes to "L3 / 3.14" under the destination.
3. **Same name.** A place under the destination with the origin room's name,
   when exactly one has it (or exactly one whose parent also shares the
   origin's parent's name, for two kitchens on two floors).
4. **Department.** A place under the destination named after the line's
   department, when exactly one is.

A place at the origin (the origin room itself, or anything under the origin
root) is never proposed. A name that matches two places is listed as
ambiguous, with both, and left for a room map row. Applying writes the
destination through the jobs core's bulk line edit, and the floor when the
line had none (or had the old destination's floor). Proposals are worked out
again when applied, so what is applied is what the rules say at that moment.

## History and events

Every change goes through the jobs core's `setLineStage`, so it is in
`job_item_stage_history`, on the item's own history, in the job's task
progress (the Place task), in the audit log and on webhooks as
`job.stage_changed`, like any other stage change. `via` says how:

| `via` | From |
| --- | --- |
| `scan` | the card: Placed here, and wrong-shipment flags |
| `sweep` | a room sweep |
| `reader` | a room reader; `device_id` is the reader and the note names the room |
| `ble` | Bluetooth room presence |
| `manual` | Flag missing |

Placement registers one exception stage with the jobs core, **`misplaced`**
("Misplaced", orange). It shows in every stage picker and on the manifest
like the core's own.

**Observations** (`placement_observations`) keep what the stage history
cannot: the room a line was actually found in, the truck it came off, the job
a stranger belongs to. The job's **Log** tab lists them.

## Handling notes

The card and the kiosk show handling notes from any feature that provides
them (AI condition records write "handle with care to prevent further
scratching"). Placement does not write them. A provider registers when its
module loads:

```ts
import { registerHandlingNotes, handlingKey } from "../placement";

registerHandlingNotes("condition", async (refs) => {
  // refs: [{ itemId, unitId }]; a unit is asked about along with its item.
  const notes = new Map<string, string[]>();
  for (const r of await latestHandlingNotes(refs)) notes.set(handlingKey(r), [r.note]);
  return notes;
});
```

A provider that throws is logged (`placement.handling.failed`) and skipped.
The line's own manifest notes are shown alongside.

## HTTP API

Signed-in sessions and API keys. Read-only keys get the `GET`s. Changing
which readers confirm placement needs an administrator's browser session.
Everything else is open to any signed-in user, like the manifest.

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/api/placement/jobs` | Open jobs with a placement tally each |
| GET | `/api/placement/jobs/:id/progress` | Overall, by floor, by room, remaining, misplaced, `afterDelivery`, shipments, floors and colours |
| GET | `/api/placement/jobs/:id/observations?limit=` | Newest first |
| PUT | `/api/placement/jobs/:id/floor-colors` | `{ colors: { "Level 5": "#1d4ed8" } }`; replaces the overrides |
| POST | `/api/placement/jobs/:id/lookup` | `{ code, shipmentId?, record? }`; `record: false` only looks |
| POST | `/api/placement/jobs/:id/place` | `{ jobItemIds, code?, via? }` |
| POST | `/api/placement/jobs/:id/mark-missing` | `{ jobItemIds, note? }` |
| POST | `/api/placement/jobs/:id/sweep` | `{ locationId, codes, nested?, via? }`; returns each code's outcome and the room's totals |
| GET | `/api/placement/jobs/:id/rooms/:locationId?nested=true` | What belongs in a room, what is placed, what was found there that belongs elsewhere |
| GET | `/api/placement/jobs/:id/kiosk?deviceId=&locationId=&since=` | `{ cursor, zone, entries, unknown }`; poll with the cursor. Without `since`, the latest few |
| POST | `/api/placement/jobs/:id/kiosk/scan` | `{ code, deviceId?, locationId? }`; one kiosk entry, or null |
| GET | `/api/placement/jobs/:id/proposals?overwrite=&originRootId=&destinationRootId=` | A root left out is the job's own; an empty one is "anywhere" |
| POST | `/api/placement/jobs/:id/proposals/apply` | `{ jobItemIds?, overwrite?, originRootId?, destinationRootId? }` |
| GET | `/api/placement/jobs/:id/room-map` | `{ rows: [{ id, origin, destination }] }` |
| PUT | `/api/placement/jobs/:id/room-map` | `{ rows: [{ originLocationId, destinationLocationId }] }`; replaces the map |
| GET | `/api/placement/readers` | Devices with a zone and their placement settings, the worker's last run, whether BLE presence was found |
| PATCH | `/api/placement/readers/:deviceId` | Admin. `{ confirm?, nested? }` |

Places come back as `{ id, name, path }`, where `path` is the names from the
top of the tree down. A line comes back with its item, codes, stage, truck,
origin, destination, desk (`destinationLabel`), floor (`floor`, and
`planFloor` as the plan has it), `floorColor`, department, crate, notes and,
while misplaced, `lastActual` (where it was found, and when).

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PLACEMENT_READER_POLL_SECONDS` | `2` | How often room reads are applied. 0 stops readers from placing anything; the card, sweeps and the kiosk keep working. |

Per device, in `tracking_devices.settings.placement`: `confirm` (default
true) and `nested` (default false).

## Data model

Migration `server/migrations/0032_placement.sql`; Drizzle definitions in
`server/src/db/tables/placement.ts`.

| Table | Holds |
| --- | --- |
| `placement_room_map` | Per job: origin location to destination location, one row per origin |
| `placement_observations` | Job, line (null for a stranger), item, unit, code, outcome (`placed`, `misplaced`, `wrong_shipment`, `wrong_job`), expected and actual location, the truck being unloaded, the other job, device, via, who, note |
| `placement_cursors` | The reader worker's position in `sightings` |

Floor colour overrides live in `jobs.metadata.placement.floorColors`, written
with the jobs core's `setJobMetadata`. Deleting a job deletes its room map and
observations; deleting a location removes it from room maps and leaves
observations without it.

Backups include `placement_room_map` and `placement_observations`. The
cursor is left out: after a restore the worker starts again from the newest
sighting.

## Limits

- Room-level only, and only as good as the readers: a UHF reader reads
  through walls. Set the reader's **Ignore reads weaker than** in its device
  settings until it only sees its own room, and switch **Confirms placement**
  off for a reader that cannot be tamed. Placed lines are never flagged by a
  reader for this reason.
- The worker is a couple of seconds behind the reads.
- The location tree is cached for five seconds per server process; a room
  created moments ago is picked up on the next read of a line that goes there.

## Code map

```
server/migrations/0032_placement.sql
server/src/db/tables/placement.ts
server/src/services/placement/
  index.ts         public surface
  model.ts         the misplaced stage, via names, stage sets (registers the stage)
  tree.ts          location tree: relations, names, floors (pure)
  match.ts         readers, sweeps and the card: what a read means (pure)
  propose.ts       destination proposals (pure)
  progress.ts      tallies and "missing after delivery" (pure)
  colors.ts        floor colours (pure)
  handling.ts      handling notes providers
  data.ts          loading lines and the tree
  scan.ts          card, Placed here, sweeps, rooms, flag missing
  destinations.ts  room map and proposals
  jobs.ts          job lists, progress, floor colours
  kiosk.ts         kiosk feed and scans
  readers.ts       the room reader worker, BLE detection, reader settings
  observations.ts  observations
  backup.ts        tables in the instance backup
server/src/routes/placement.ts
client/src/features/placement/        screens, API client, types
server/tests/placement.test.ts        pure logic
server/tests/placement-db.test.ts     the whole flow on Postgres (opt-in)
```

## Testing

```bash
pnpm test                                   # pure logic, no database needed
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_placement_test \
  pnpm --filter bindex-server test          # also runs the Postgres flow
```

Use a database of its own for the Postgres flow: it restores a backup over
the database at the end.
