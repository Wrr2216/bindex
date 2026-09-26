# Projects, jobs, shipments and relocation manifests

A **job** moves a set of things from where they are to where they are going:
an office floor to its new building, a delivery from stock to a site, a
clear-out to storage. Its **manifest** lists every item (or tracked unit) it
moves, where each one is going, and how far it has got. Crews scan labels to
move lines through **pack, load, deliver, place**, and anything scanned at the
wrong truck, or that is not on the job at all, is flagged on the spot.

Jobs can stand alone or belong to a **project** that runs in **phases** (floor
3 this weekend, floors 4 and 5 the next). Each job can have **shipments** (one
per truck or trailer run) and a **task list** that starts from its **job type**.

Everything here is behind one instance feature switch, **Projects, jobs and
shipments** (`features.jobs`, stored as `features.jobs` in `app_settings`). It
is off by default. With it off the Jobs navigation entry and its screens are
gone, and every `/api/projects`, `/api/jobs`, `/api/shipments` and
`/api/job-types` request answers `404 feature_disabled`.

## Using it

1. **Settings → Job types** (linked from the Jobs page for administrators):
   the kinds of work you do, each with the tasks a new job starts with. A new
   instance has two: Relocation and Delivery.
2. **Jobs → Projects → New project**, add its phases.
3. **New job** (from the project, a phase, or the Jobs page). Pick a type and
   its tasks are copied onto the job.
4. **Add items** to the manifest: scan or type codes, take everything in a
   location ("everything on floor 3"), or apply a move plan CSV.
5. **Add shipments**, one per truck run.
6. **Print the manifest**, floor by floor or department by department, and
   a **load sheet** per shipment.
7. **Scan to stage**: pick the stage (and the shipment when loading or
   unloading), press Start, and scan. Every read lands in the feed with a
   colour and a sound.
8. Move the shipment through staged, loaded, in transit, delivered, closed.
   It will not go past lines that have not caught up unless you force it and
   say why.

## Concepts

### Stages

Every manifest line has one stage.

| Stage | Kind | Meaning |
| --- | --- | --- |
| `pending` | progress | On the plan, nothing done yet |
| `packed` | progress | Packed and tagged |
| `loaded` | progress | On the truck (and on a shipment, if one was scanned) |
| `delivered` | progress | Off the truck at the destination |
| `placed` | progress | In its destination room or desk |
| `missing` | exception | Cannot be found |
| `wrong_shipment` | exception | Turned up on the wrong truck |
| `damaged` | exception | Damaged somewhere along the way |

Rules (`decideStage` in `services/jobs-core/rules.ts`):

- Moving **up** the ladder is always allowed, and may skip rungs (scanning
  straight to loaded implies packed).
- Scanning a line to a stage it is **already at or past** changes nothing and
  reports `alreadyAt`. A scan at the dock of something already delivered is
  old news, not an error.
- Moving **down** the ladder needs `force`.
- Moving to **pending** needs `force`; otherwise it is `blocked`.
- Moving **into** an exception is always allowed; moving **out** of one to
  any stage but pending is allowed (the missing box turned up).

### Shipment status

`planned → staged → loaded → in_transit → delivered → closed`

A shipment only counts the lines on it. Exception lines never hold it back.

| Moving to | Every line on it must have reached |
| --- | --- |
| `loaded`, `in_transit`, `delivered` | `loaded` (nothing left at the dock) |
| `closed` | `delivered` |

Otherwise the change is refused with `409 lines_not_ready` and
`details.blockers` counting the lines by stage. Moving backward is refused
with `409 backward`. Either can be forced, but only with a reason (`409
reason_required` without one); the reason is kept in
`shipment_status_history`. `departed_at` is stamped the first time a shipment
reaches `in_transit` or later, `arrived_at` the first time it reaches
`delivered` or later.

### Job status

`planned`, `in_progress`, `completed`, `cancelled`. Only planned and in
progress jobs accept scans and manifest additions (`400` otherwise, with a
message saying to reopen). The first stage change on a planned job starts it.
`started_at` and `completed_at` are stamped on the way; reopening clears
`completed_at`.

### Tasks

Tasks have a kind, a title, a status (`todo`, `doing`, `done`, `skipped`), an
optional assignee (a holder entity or a user id) and who completed them when.
Four kinds follow the manifest: `pack` (packed), `load` (loaded), `unload`
(delivered), `place` (placed). When the first line reaches the stage the task
moves to doing; when every line has, it is done. They only ever move forward,
and a skipped task is left alone.

### Floor and department

A line's `floor` and `department` are the **move plan's grouping**: the floor
it is going to and the department it belongs to (departments usually move as a
unit). Where it came from is `origin_location_id`, snapshotted when the line
was added. Manifests group by floor, department, origin room or shipment.

## Adding lines

**By code.** Asset codes, unit codes, unit serials, any identifier (RFID EPC,
MAC, serial, asset tag) or the item page link a label QR carries. A unit code
adds that unit; an item code adds the whole item. A product code (UPC, SKU)
shared by several items is reported as ambiguous rather than guessed. A unit
whose item is already on the job as a whole counts as already there.

**Everything in a location.** Items in the location or anywhere beneath it,
items packed inside container items found there (`includeContents`, default
on), and tracked units wherever they individually sit within the subtree, one
line each (`perUnit`, default on). Domains are skipped. The department is
taken from the location tree (`departmentLevel`, default 1: the level just
below the chosen location, so choosing a floor whose rooms are departments
works) and falls back to the item's holder when that holder is an entity of
kind `department`. The floor is left for the move plan unless you give one, or
a `floorLevel`.

**Move plan CSV.**

```csv
code,destination,floor,department,desk,crate,notes
,HQ / Level 5 / Finance,5,Finance,,,
,Level 5 / 5.14,5,Legal,,,
INV-7F3K2A,,,,Desk 5.12-A,C1,
INV-9QX3TR,LOC-4F2K1B,,,,,Fragile
```

- A row **with a code** adds that item (unless adding is turned off) and sets
  its line's fields. A row **without a code but with a department** sets every
  line in that department. Blank cells leave a line as it is.
- A header row is optional; without one the columns are read as `code,
  destination, floor, department, desk, crate, notes`. Header names are
  matched loosely (`Asset Code`, `Dept`, `Level`, `Seat`, `Crate #`, ...).
- Commas, semicolons and tabs all work as separators; quoted fields may hold
  separators and line breaks; a BOM is ignored.
- `destination` matches a location by id, printed code (`LOC-…`), full path
  (`HQ / Level 5 / 5.12`, `/` or `>` between levels), the end of a path
  (`Level 5 / 5.12`) or a name, each only when exactly one location matches.
  A destination that matches nothing, or more than one place, is reported and
  its text kept as the line's destination label.
- The whole file applies in one transaction.

## Scanning

`POST /api/jobs/:id/advance` with the codes and a target stage. Codes are
trimmed and de-duplicated, resolved in four queries whatever the batch size,
and matched to this job's lines. Every code lands in exactly one bucket:

| Bucket | Meaning | Changes anything |
| --- | --- | --- |
| `advanced` | Moved to the stage (and onto the shipment, if it had none) | yes |
| `alreadyAt` | Already at the stage or past it | no |
| `wrongShipment` | On this job but on another shipment; `shipmentCode` names it | no, unless `force` moves it here |
| `notOnJob` | A known item this job does not include; `otherJobs` lists open jobs it is on | no |
| `unknown` | Resolves to nothing | no |
| `blocked` | Refused by a rule or a registered guard, with the reason | no |

Two codes for the same line in one batch (an RFID tag and a barcode) advance
it once. A unit code matches that unit's line, or the whole item's line. An
item code matches the whole-item line, or else the next unit line not yet at
the stage, so an item label can stand in for its identical units one scan at
a time. Stage changes on one job are serialised with a row lock on the job.

Each change writes one row to `job_item_stage_history` (from, to, via, device,
who, note, shipment) and one `item_events` row on the item with action
`updated` and detail `{ source: "job", jobId, jobCode, stage, from, jobItemId,
unitId, shipmentId, via }`. (`item_events.action` is a fixed set; a new action
would mean editing a CHECK other branches also touch, so the detail carries
the meaning.) No `scanned` events are written: a dock reader would write
thousands an hour.

The **scan-to-stage panel** claims the page's scan capture
(`useScan().armBulkCapture`) while running, so a handheld reader, the camera
and the networked reader feed all arrive the same way. Reads are batched for
150 ms. Starting with the live reader on clears the reader channel first,
because the feed reports each tag only once per channel. Results show with a
colour and a Web Audio cue: a chirp for advanced, a soft blip for already, a
low double buzz for anything that needs a person. `via` is recorded as `rfid`
while the live reader feed is on, `scan` otherwise, and `manual` for typed
codes; a handheld scan made while the feed is on is therefore recorded as
`rfid`.

## Documents

- `GET /api/jobs/:id/manifest.pdf?groupBy=floor|department|origin|shipment|none&floor=&department=&shipmentId=&stage=&tz=`:
  landscape Letter relocation manifest. Each line has its code, crate, where
  it came from, where it goes (location path and desk), a box per step ticked
  if reached, exceptions in red; group bands with counts; two signature blocks;
  a QR of the job page.
- `GET /api/jobs/:id/manifest.xlsx?…`: the same lines as a spreadsheet with a
  heading row per group, a tick per step reached, and filters on the header.
- `GET /api/shipments/:id/load-sheet.pdf?tz=`: a bill-of-lading style load
  sheet: carrier, vehicle, ETA, weight, volume, distance, seal numbers, every
  line with load and delivery boxes, a seal check and shipper / carrier /
  consignee signatures.

Text the standard PDF fonts cannot encode (emoji, CJK) prints as `?` rather
than failing the document.

## HTTP API

All under the usual session or API-key authentication. Job type changes need
an administrator's browser session; everything else is open to any signed-in
user and to read-write API keys (read keys get the `GET`s).

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/api/jobs/meta` | Stages, task kinds and every status list |
| GET | `/api/job-types` | `?all=true` includes inactive ones |
| GET | `/api/job-types/:id` | |
| POST | `/api/job-types` | `{ name, color?, description?, taskTemplate?: [{ kind, title }], active? }` (admin) |
| PATCH | `/api/job-types/:id` | same fields (admin) |
| DELETE | `/api/job-types/:id` | jobs keep their tasks (admin) |
| GET | `/api/projects` | `?status=&q=`; each with job and phase counts and progress |
| POST | `/api/projects` | `{ name, companyId?, entityId?, status?, startsOn?, endsOn?, notes? }` |
| GET | `/api/projects/:id` | with phases, jobs and progress |
| PATCH | `/api/projects/:id` | same fields |
| DELETE | `/api/projects/:id` | only when it has no jobs |
| POST | `/api/projects/:id/phases` | `{ name, sequence?, startsOn?, endsOn?, notes? }` |
| PATCH | `/api/projects/:id/phases/:phaseId` | same fields |
| DELETE | `/api/projects/:id/phases/:phaseId` | its jobs stay on the project |
| GET | `/api/jobs` | `?projectId=&phaseId=&jobTypeId=&status=&q=`; each with progress |
| POST | `/api/jobs` | `{ name, projectId?, phaseId?, jobTypeId?, status?, originLocationId?, destinationLocationId?, scheduledStart?, scheduledEnd?, notes?, seedTasks? }` |
| GET | `/api/jobs/:id` | with tasks, shipments and progress by floor, department and shipment |
| PATCH | `/api/jobs/:id` | same fields |
| DELETE | `/api/jobs/:id` | removes its manifest, shipments, tasks and history |
| GET | `/api/jobs/:id/progress` | |
| GET/POST | `/api/jobs/:id/tasks` | `{ title, kind?, sequence?, status?, assigneeEntityId?, assigneeUserOid?, dueAt?, notes? }` |
| PATCH/DELETE | `/api/jobs/:id/tasks/:taskId` | |
| GET | `/api/jobs/:id/items` | `?stage=&shipmentId=(id or none)&floor=&department=&q=&limit=&offset=`; returns `{ lines, total, floors, departments }` |
| POST | `/api/jobs/:id/items` | `{ codes, shipmentId?, destinationLocationId?, destinationLabel?, floor?, department?, crateNo?, notes? }` |
| POST | `/api/jobs/:id/items/from-location` | `{ locationId, includeContents?, perUnit?, departmentLevel?, floorLevel?, …line fields }` |
| POST | `/api/jobs/:id/items/import` | `{ csv, addMissing?, shipmentId? }` |
| PATCH | `/api/jobs/:id/items` | `{ ids, set: { …line fields } }` |
| POST | `/api/jobs/:id/items/remove` | `{ ids }` |
| POST | `/api/jobs/:id/items/stage` | `{ ids, stage, shipmentId?, via?, deviceId?, force?, note? }` |
| POST | `/api/jobs/:id/advance` | `{ codes, stage, shipmentId?, via?, deviceId?, force?, note? }` |
| GET | `/api/jobs/:id/history` | `?limit=` (newest first) |
| GET | `/api/jobs/for-item/:itemId` | every job line an item is on |
| GET | `/api/jobs/:id/manifest.pdf`, `/manifest.xlsx` | see Documents |
| GET | `/api/shipments` | `?jobId=&status=` |
| POST | `/api/shipments` | `{ jobId, name, vehicleLocationId?, carrier?, sealNumbers?, weightKg?, volumeM3?, distanceKm?, eta?, notes? }` |
| GET | `/api/shipments/:id` | with progress and status history |
| PATCH | `/api/shipments/:id` | same fields except status |
| POST | `/api/shipments/:id/status` | `{ status, force?, reason? }` |
| DELETE | `/api/shipments/:id` | its lines stay on the job |
| GET | `/api/shipments/:id/load-sheet.pdf` | |

`via` defaults to `api` for API-key callers and `manual` for people. Any
lower_snake_case value is accepted, so a portal can record `portal`.

## Data model

Migration `server/migrations/0024_jobs_core.sql`; Drizzle definitions in
`server/src/db/tables/jobs-core.ts`.

| Table | Holds |
| --- | --- |
| `job_types` | name (unique, case-insensitive), color, description, `task_template` jsonb `[{kind,title}]`, `settings` jsonb per feature, active |
| `projects` | code `PRJ-…`, name, client `company_id` / `entity_id`, status, `starts_on`, `ends_on`, notes, metadata |
| `project_phases` | project, sequence, name, window (`starts_on`, `ends_on`), notes |
| `jobs` | code `JOB-…`, project, phase, job type, name, status, origin and destination locations, scheduled and actual start and end, notes, metadata |
| `job_tasks` | job, sequence, kind, title, status, assignee entity or user, due, started, completed at and by, notes, metadata |
| `shipments` | code `SHP-…`, job, name, status, vehicle location, carrier, `seal_numbers text[]`, weight kg, volume m³, distance km, ETA, departed, arrived, notes, metadata |
| `shipment_status_history` | every status change with forced flag and reason |
| `job_items` | the manifest: job, shipment, item, unit, origin (snapshot), destination location and label, floor, department, crate, stage with when and by whom, notes, metadata. Unique per job, item and unit |
| `job_item_stage_history` | every stage change: from, to, via, device, user, actor, note, shipment |

Codes are `PRJ-`, `JOB-` or `SHP-` and six Crockford base32 characters, like
asset codes, retried on the rare collision. Deleting a job cascades to its
manifest, tasks, shipments and history. Deleting an item cascades to its lines.
Deleting a location nulls it wherever it is referenced.

Stage names, task kinds and `via` values are checked only for shape
(lower_snake_case) in the database, and against the registries in the
service. That is deliberate: a later feature adds its own without a migration
that fights this one.

Backups include all nine tables. Restoring a file written before jobs existed
clears jobs but keeps job types, the way groups are kept for files that
predate groups.

## Extension points

Later features import from `server/src/services/jobs-core` (the index), never
from the files behind it, and register their hooks when their own module loads.

### Vocabulary

```ts
import { registerExceptionStage, registerTaskKind } from "../jobs-core";

registerExceptionStage("refused", { label: "Refused", color: "#f97316" });
registerTaskKind("crew_checkin", { label: "Crew check-in" });
```

Only exception stages can be added; the progress ladder is fixed because
progress bars and shipment rules are built on it. A registered kind shows up
in job type templates and task pickers (via `/api/jobs/meta`).

### Hooks (`hooks.ts`)

| Function | Called | Use |
| --- | --- | --- |
| `registerStageGuard(name, guard)` | before a batch is written, inside its transaction | Return `[{ jobItemId, reason }]` to veto lines; they come back as `blocked` with the reason. `ctx` has the job, target stage, `force`, `via`, who, and each line's item, unit, shipment and current stage. A guard that throws aborts the batch (fail closed). Read only; do not write to `jobs` from a guard. |
| `onStageChanged(listener)` | after commit | `(changes, ctx)`, one entry per line changed |
| `onShipmentStatusChanged(listener)` | after commit | `{ shipment, from, to, forced, reason, userOid, actor }` |
| `onJobChanged(listener)` | after create or update | `{ job, previous (null on create), userOid }` |
| `onTaskStatusChanged(listener)` | after a task changes status, by hand or by the manifest | `{ task, previousStatus, userOid }` |

Each returns a function that unregisters it. A listener that throws is logged
(`jobs.hook.failed`) and does not affect the change or the caller.

### Service functions

| Function | For |
| --- | --- |
| `advanceStage(jobId, codes, stage, { shipmentId?, via, deviceId?, userOid?, actor?, force?, note? })` | Anything that scans: readers, portals, placement kiosks |
| `setLineStage(jobId, jobItemIds, stage, opts)` | Changing lines by id: delivery exceptions, placement confirmations |
| `listJobItems(jobId, filters)`, `jobLinesForItem(itemId)` | Reading the manifest; which job and destination an item has |
| `stageHistory(jobId, limit)`, `lineHistory(jobItemId)` | Timelines, claims evidence, custody chains |
| `getJobProgress`, `progressByJob`, `progressByShipment`, `progressByProject` | Progress bars anywhere; the arithmetic is `rollup` / `rollupCounts` |
| `completeTasksByKind(jobId, kind, actor)` | Closing your task when your work finishes |
| `setJobMetadata(jobId, key, value)`, `setShipmentMetadata(id, key, value)`, `setJobTypeSetting(id, feature, value)`, `getJobTypeSetting(id, feature)` | Storing per-feature data under your own key, without a migration or a collision |
| `createJob`, `updateJob`, `createShipment`, `setShipmentStatus`, `addItemsByCodes`, `addItemsFromLocation`, `importManifestCsv`, `updateJobItems` | Everything the screens do |
| `resolveScanCodes(codes)` | The batch code resolver (to be merged with T01's) |
| `decideStage`, `checkShipmentTransition`, `hasReached` | The rules, for a screen that wants to grey out a move before trying it |

### Suggested attachment points

- **T10 GPS**: a tracker link and route figures in `shipment.metadata.gps`;
  `setShipmentStatus(id, "in_transit")` on leaving the origin fence (it
  stamps `departed_at`); `onShipmentStatusChanged` for milestones.
- **T11 Placement**: `advanceStage(jobId, codes, "placed", { via: "reader",
  deviceId })`; register an exception stage `misplaced` if you want one on the
  line; `destination_location_id`, `destination_label` and `floor` are the
  plan; `wrongShipment` and `notOnJob` already come back from every scan.
- **T13 Inspections**: tasks of kind `pre_inspection` / `post_inspection`;
  call `completeTasksByKind` when an inspection is completed.
- **T14 Custody**: `registerStageGuard("custody", …)` vetoes delivering a
  controlled item without a transfer, with no change to this module; delivery
  exceptions are `setLineStage(…, "missing" | "damaged" | "refused")` after
  `registerExceptionStage("refused", …)`.
- **T15 Portal**: `advanceStage` with `via: "portal"` and `actor` set to the
  grant's name (`userOid` null); milestones from `shipment_status_history`,
  `job_item_stage_history` and the hooks.
- **T16 Claims**: `lineHistory(jobItemId)` for the line's trip; `job_items`
  in `damaged` are the natural claim candidates.
- **T17 Documents**: `onJobChanged` fires on creation and on every update with
  the previous row, so a job type change is `previous.jobTypeId !==
  job.jobTypeId`; packets per type in `setJobTypeSetting(typeId, "documents", …)`.
- **T18 Crew**: `registerTaskKind("crew_checkin", …)`; required credentials
  per type in `setJobTypeSetting(typeId, "crew", …)`.
- **T22 Operations**: `job_item_stage_history` for dwell between stages;
  `shipments.weight_kg` / `volume_m3` and vehicle location metadata for load
  planning.

## Code map

```
server/migrations/0024_jobs_core.sql
server/src/db/tables/jobs-core.ts        Drizzle tables and row types
server/src/services/jobs-core/
  index.ts        public surface
  model.ts        stages, task kinds, statuses, registries (pure)
  rules.ts        stage, shipment and job transition rules (pure)
  match.ts        which line each scanned code means (pure)
  rollups.ts      progress arithmetic (pure)
  csv.ts          move plan parsing (pure)
  places.ts       destination matching, subtree walking (pure)
  codes.ts        PRJ/JOB/SHP codes
  hooks.ts        guards and listeners
  resolve.ts      batch code resolver
  jobTypes.ts projects.ts jobs.ts shipments.ts manifest.ts advance.ts progress.ts
  documents.ts pdf.ts xlsx.ts   printed manifests and load sheets
  backup.ts       tables in the instance backup
server/src/routes/jobs-core.ts
client/src/features/jobs-core/           screens, API client, types
server/tests/jobs-core.test.ts           pure logic
server/tests/jobs-core-db.test.ts        the whole flow on Postgres (opt-in)
```

## Testing

```bash
pnpm test                                   # pure logic, no database needed
JOBS_CORE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_jobs_core \
  pnpm --filter bindex-server test          # also runs the Postgres flow
```
