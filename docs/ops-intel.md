# Operations insights

Bindex watches what the readers, jobs and records say and points out what
does not add up: a carton still packed after its truck left, a pallet still
"loaded" hours after the truck was unloaded, the same serial on two records, a
tag read in two cities within minutes. It also measures how storage is used
(how long things sit, what moves, what is likely to be asked for next),
suggests which things to swap nearer the dock, and plans how a job's lines fit
its vehicles.

Every finding comes from a **fixed, documented rule** with thresholds an
administrator can change. A language model is only ever used, when one is
configured, to put a finding into plain words on request; it never decides
anything.

The feature switch is **Operations insights** in Settings, Features
(`features.opsIntel`, stored as `features.ops_intel`). It is **off** by
default. With it off the Insights page and its navigation entry are gone,
every `/api/ops` request answers `404 feature_disabled`, and the scheduled
runs do nothing.

Contents: [Using it](#using-it) · [The rules](#the-rules) ·
[Lifecycle](#the-lifecycle-of-an-anomaly) · [Storage analytics](#storage-analytics) ·
[Slotting](#slotting) · [Load planning](#load-planning) ·
[Location facts](#location-facts) · [Events](#events) · [API](#api) ·
[Data model](#data-model) · [Configuration](#configuration) · [Testing](#testing)

## Using it

1. Switch on **Operations insights** in Settings, Features. **Insights**
   appears in the navigation.
2. **Setup** tab (administrators): check the thresholds, give the dock and
   storage areas a distance to the dock, give each site its coordinates, and
   give each vehicle (a location that is a truck or trailer) what it can carry.
3. **Anomalies** tab: counts by severity, opened against resolved over the
   last 30 days, and the queue. **Run now** checks straight away; otherwise the
   rules run every `OPS_INTEL_INTERVAL_MIN` minutes (15 by default). Each
   anomaly links to the screen where it is fixed. Resolve it as **Fixed** or
   **Not a problem**, with a note saying what was done or why.
4. **Storage** tab: dwell time per place, long-stored things, top movers,
   A/B/C classes and when each thing is likely to be needed next.
5. **Slotting** tab: suggested swaps, each with the sentence that justifies it.
6. **Load planning** tab (needs Projects, jobs and shipments): pick a job, put
   the stops in delivery order, add a vehicle to see a what-if, and print the
   plan. Below it, every open shipment's estimated load against its vehicle.

Nothing here changes a job, a shipment or a record. Insights reads the
tracking, jobs and item tables and writes only its own.

## The rules

Each rule has an id (used in the API and events), a severity per finding,
and the thresholds below, all under Setup. Every rule can be switched off on
its own; switching one off clears its open anomalies at the next run.

"Open job" means planned or in progress. Completed jobs keep being checked
for **`jobLookbackDays`** (default **30**) days after they finish, because
completing a job does not find a missing carton. Cancelled jobs are never
checked.

| Rule | Finds | Severity | Thresholds (default) |
| --- | --- | --- | --- |
| `packed_not_loaded` | A line at **packed** whose shipment is loaded (medium) or has left, that is in transit, delivered or closed (high). A packed line on **no** shipment when the job has shipments and every one of them has left (high). | medium / high | none |
| `loaded_not_delivered` | A line still at **loaded** on a shipment that is delivered or closed, longer than the grace period after the shipment arrived. | high | `graceMinutes` **120** |
| `delivered_not_placed` | A line at **delivered** for longer than the threshold, on a job that places things: it has a task of kind `place`, or at least one line already placed. | medium | `hours` **24** |
| `duplicate_identifier` | The same serial, asset tag, MAC or RFID tag on two records, or two units of one record, compared on letters and digits only, uppercased (`sn-0042 a` equals `SN0042A`). Serials on units and serial identifiers are one kind; the kinds are not compared with each other. An item and one of its own units sharing a value is not a duplicate. Placeholders are ignored: values under three characters, one repeated character (`0000`), and `N/A`, `NONE`, `NULL`, `UNKNOWN`, `TBD`, `TBA`, `NOSERIAL`, `DEFAULT`, `To be filled by O.E.M.`, `System Serial Number`, `123456789` and similar. | high when the values are identical, medium when they differ only by formatting | none |
| `duplicate_record` | Two to `maxGroup` records in the **same location** with the same name and the same non-blank model (brand too, when given), compared ignoring case, accents, spacing and punctuation, and not told apart by two different serials. A larger group is treated as a set of identical things. Domains are ignored. | low | `maxGroup` **3** |
| `impossible_travel` | Two consecutive reads of one asset, in the look-back window, further apart than it could have travelled in the time between them. Each read's position is its own GPS fix, else the coordinates of its zone or the nearest location above it that has some. The distance is reduced by both GPS accuracy radii; reads in zones where one is inside the other are never compared. Found when the reduced distance is at least `minDistanceM` and the implied speed is over `maxSpeedKmh` (the time between reads counts as at least one second). **Sticky.** | high | `maxSpeedKmh` **120**, `minDistanceM` **1000**, `lookbackHours` **24** |
| `zone_mismatch` | An asset's latest position is in a zone that neither contains nor sits inside the location on its record, the record has not changed since the asset was last read, and it has been like that for longer than the threshold (counted from when it entered the zone, or from the last change to the record if that is later). A record in a container is where its container is. | medium; low when the record has no location | `hours` **4** |
| `not_seen` | A tagged asset (it has a position) that is active, whose unit (if the position is a unit's) is active, that is not checked out, and that no device has read for longer than the threshold. | medium | `days` **14** |
| `multi_shipment` | The same asset on lines on two or more different open shipments (planned, staged, loaded or in transit) of open jobs. A whole-item line clashes with any line for that item; two unit lines clash only for the same unit. | high when two of the shipments are loaded or in transit, else medium | none |

Titles name records by name and code and never use the words for the
configurable concepts, so they read the same whatever an instance calls things.

### Where the fix is made

| Rule | Link |
| --- | --- |
| `packed_not_loaded`, `loaded_not_delivered`, `delivered_not_placed`, `multi_shipment` | the job (`/jobs/<id>`) |
| `duplicate_identifier`, `impossible_travel`, `zone_mismatch`, `not_seen` | the record (`/items/<id>`) |
| `duplicate_record` | the location holding both (`/locations/<id>`) |

## The lifecycle of an anomaly

A **condition** (every rule except `impossible_travel`) is a state of the
data that is either there or not. An **event** (`impossible_travel`, "sticky")
is something that happened once.

Each problem is identified by its rule and a **key** (the manifest line, the
asset, the normalized identifier, the location and name, or for travel the
asset and the two places). At most one anomaly per rule and key is open.

On every run:

- A problem found with an anomaly already open refreshes it: its latest
  details and last-seen time. For an event, a newer occurrence also counts
  one more in `occurrences`; the same occurrence seen again inside the
  look-back window only moves last-seen.
- An open **condition** that a run no longer finds is closed with resolution
  `cleared` and the note "No longer found by a run." An open **event** stays
  open until a person resolves it.
- A person resolves an anomaly as **fixed** or **dismissed** ("Not a
  problem"), with a note; their account id and name are kept.
  - A condition marked **fixed** that the next run still finds opens a new
    anomaly pointing at the old one (`reopenedFrom`): it was not fixed.
  - A condition **dismissed** stays quiet while it lasts. When a run no longer
    finds it, it is marked cleared (`clearedAt`), and if it comes back later
    it is reported afresh.
  - An event is reported again only for an occurrence after the one resolved.
- Anomalies of a rule that has been switched off are closed as `cleared`,
  "The rule was switched off."
- A rule whose data could not be read (the query failed) leaves its
  anomalies exactly as they were; the run records the error.

Runs take a Postgres advisory lock, so two replicas, or a click on **Run now**
during a scheduled run, never run at once (the second click answers `409
run_in_progress`). The last 500 runs are kept in `ops_runs` with their counts
per rule.

## Storage analytics

Computed on request from the item history and positions, cached for a
minute (**Recalculate** recomputes).

- **Movement**: any recorded change of place: a reader moving an asset
  between zones (`moved` in its history); a move on file, meaning an update
  whose only changed fields are the location or container (an edit form that
  saves every field is not a move); or a bulk move that listed it. Counted
  over the window, **`windowDays`** (default **90**).
- **Where it is and since when (dwell)**: an active record's tracked zone and
  the time it entered it, when it has a position; otherwise its recorded
  location (or its container's) and the time of its last movement, or when it
  was added if it never moved. Domains are left out.
- **Long stored**: dwell of **`longStoredDays`** (default **180**) or more.
- **Per location**: how many things it holds, average and longest dwell, how
  many are long stored, moves in and out reported by readers in the window,
  **turnover** (moves out over the window per thing held now) and the A/B/C
  mix. Moves on file do not say where from, so they count toward a record's
  movements but not toward a location's moves in and out.
- **A/B/C classes**: records sorted by movements, most first (ties by id). A
  record is **A** while the movements of the records before it are under
  **`abcA`** (default **0.8**) of all movements, **B** while under **`abcB`**
  (default **0.95**), else **C**. A record that never moved is always C.
- **Retrieval prediction**: with at least two movements in the window, the
  next is predicted at the last movement plus the median gap between them.
  Moves per month is movements over the window × 30.

## Slotting

1. Only records in a location with a distance to the dock take part. A
   location without one takes the distance of the nearest location above it
   that has one.
2. The cut-off is the median distance over the records taking part.
3. Fast movers (class A) further out than the cut-off are taken furthest
   first; slow movers (class C) at or inside the cut-off, nearest first.
4. Each fast mover is paired with the first unused slow mover at least
   **`minGainM`** (default **5**) metres nearer the dock: a suggested **swap**.
   The saving shown is the gain × 2 (there and back) × the fast mover's moves
   per month.
5. A far fast mover with nobody left to swap with is listed as **move closer**,
   with no target.
6. At most **`maxSuggestions`** (default **50**).

Each suggestion carries a sentence built from exactly these facts.

## Load planning

Deliberately simple. It checks weight, volume and whether each piece fits
the interior; it does **not** arrange boxes in three dimensions and makes no
claim that a plan within capacity will physically stack.

**Weight and volume per line.** From the record's `metadata`:
`weightKg`, `volumeM3`, or `lengthCm`, `widthCm` and `heightCm` (volume is
their product). Values are per piece; a whole-item line of a quantity-10
record counts ten, a unit line one. Missing values come from the category's
defaults under Setup (matched ignoring case), then the instance defaults,
**`defaultWeightKg`** (**10**) and **`defaultVolumeM3`** (**0.05**). The plan
marks every figure that was not measured.

**Capacity per vehicle.** From the vehicle location's facts: **carries at
most** (kg), and **cargo volume** (m³) or else interior length × width ×
height. Only **`fillFactor`** (default **0.85**) of the volume counts as
usable, because boxes never stack without gaps. A vehicle with neither a
weight nor a volume limit is not planned onto.

**Which lines.** Lines at pending or packed are planned. Lines at loaded stay
on their shipment (they are on board). Lines already on one of the job's
shipments stay there unless **Repack from scratch** is on. Delivered, placed
and exception lines are left out and counted.

**Which vehicles.** The job's shipments that are planned, staged or loaded,
in the order they were created, each with its vehicle, plus any vehicle added
for a what-if (without a shipment).

**Packing: first-fit decreasing.** Lines are sorted by size, largest first:
size is the larger of the line's share of the biggest vehicle's weight limit
and its share of the biggest vehicle's usable volume (ties: volume, weight,
code). Each goes into the **first** vehicle, in order, where the weight and
volume still fit and each measured piece fits the interior in some
orthogonal orientation (sorted dimensions against sorted interior). Nothing is
ever added past a limit. A line that fits nowhere is listed with the reason:
heavier than any vehicle can carry, bigger than any vehicle holds, does not
fit inside any vehicle's interior, or no room left. A vehicle that is already
over a limit with the lines on board is flagged and gets nothing more.

**Stops and loading sequence.** A line's stop is its destination location,
else its destination label, else its floor, else the job's destination. Stops
are in the delivery order given (`stops`), then the rest by name in natural
order, with lines that have no destination at all last. In each vehicle, lines are loaded **last stop first** (so the first
stop's things come off first), heaviest first within a stop. Sequence 1 goes
in first.

**The printed plan** (`plan.pdf`) has a section per vehicle with its
capacity, load and utilization and the numbered sequence, then what did not
fit and the notes.

**Open shipments against their vehicles** estimates, for every open shipment
(planned to in transit), the lines on it that are still to load or on board
against its vehicle's capacity.

## Location facts

Optional, per location, stored in `ops_location_profiles`:

| Field | Used by |
| --- | --- |
| `role`: dock, pick, storage, staging, vehicle | labelling; vehicles are offered for what-if plans |
| `distanceToDockM` | slotting (inherited by locations inside it) |
| `lat`, `lng` (both or neither) | impossible travel (inherited) |
| `maxKg`, `maxM3`, `interiorLengthM`, `interiorWidthM`, `interiorHeightM` | load planning |
| `notes` | people |

A location's facts go when the location is deleted (at the next run) or when
every field is cleared.

## Events

Published to the audit log, webhooks and the polling feed
([event backbone](event-backbone.md)). Subject type `ops_anomaly` (id: the
anomaly id) or `ops_run`.

| Type | When | `data` |
| --- | --- | --- |
| `ops.anomaly_detected` | A run opened an anomaly | `{ rule, key, severity, title, subjectType, subjectId, itemId, jobId, shipmentId, locationId, link, reopenedFrom }` |
| `ops.anomaly_resolved` | A person resolved one (actor: that person), or a run cleared one (actor: system) | the same fields, plus `{ resolution: "fixed" \| "dismissed" \| "cleared", note }` |
| `ops.run_completed` | A run opened or cleared anything | `{ trigger, opened, cleared, truncated, byRule: { <rule>: { found, opened, cleared, ms, error? } } }` |

A run publishes at most 100 detected and 100 cleared events one by one;
`truncated` says when there were more. Every anomaly is in the table
regardless.

## API

Under the usual session or API-key authentication; everything answers `404
feature_disabled` while the switch is off. Read-only API keys get the `GET`s.
Changing thresholds and location facts needs an administrator's browser
session.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/ops/meta` | Rules with descriptions, severities, location roles, `explanations.available`, and the settings |
| GET | `/api/ops/settings` | The thresholds |
| PUT | `/api/ops/settings` | Admin. Any part of the settings; an unknown top-level key is refused, unknown nested keys are dropped, numbers are clamped to their ranges |
| GET | `/api/ops/summary?days=30` | Open counts by severity and rule, oldest open, opened and resolved per day, the last run |
| GET | `/api/ops/anomalies` | `status=open\|resolved\|all` (default open), `rule`, `severity` (comma-separated), `itemId`, `jobId`, `shipmentId`, `locationId`, `q` (title), `limit` (≤ 200), `offset`. `{ anomalies, total }`; open ones most severe first |
| POST | `/api/ops/anomalies/run` | Run the rules now. The run's counts per rule; `409 run_in_progress` if one is running |
| GET | `/api/ops/anomalies/:id` | One anomaly with the other occurrences of the same problem (`history`) |
| POST | `/api/ops/anomalies/:id/resolve` | `{ resolution: "fixed" \| "dismissed", note }`; the note is required. `409` if already resolved |
| POST | `/api/ops/anomalies/:id/explain` | `{ available, explanation }`. `available: false` without a language model; cached on the anomaly |
| GET | `/api/ops/storage?fresh=true` | The storage report: totals, per-location statistics, longest stored, top movers |
| GET | `/api/ops/storage/items` | `abc=A\|B\|C`, `locationId`, `longStored=true`, `q`, `sort=dwell\|movements\|next`, `limit` (≤ 500), `offset` |
| GET | `/api/ops/slotting` | `{ cutoffM, considered, withoutDistance, suggestions, rule }` |
| GET | `/api/ops/profiles` | `{ profiles }` |
| PUT | `/api/ops/profiles/:locationId` | Admin. Any fields; omitted ones keep their value, `null` clears one. `{ profile }`, or `null` when nothing is left |
| DELETE | `/api/ops/profiles/:locationId` | Admin |
| GET | `/api/ops/load-plans/jobs/:jobId` | `stops` (one parameter per stop key, repeated, in delivery order), `vehicles` (location ids, comma-separated), `repack=true`. `{ job, plan, generatedAt }` |
| GET | `/api/ops/load-plans/jobs/:jobId/plan.pdf` | The same, printed; `tz` for the printed time |
| GET | `/api/ops/shipments/capacity?jobId=` | `{ shipments }`: each open shipment's estimated load against its vehicle |

Stop keys are `loc:<location id>`, `label:<destination label, lowercased>`,
`floor:<floor, lowercased>` or `none`; the plan lists them.

## Data model

Migration `server/migrations/0043_ops_intel.sql`; Drizzle definitions in
`server/src/db/tables/ops-intel.ts`.

| Table | Holds |
| --- | --- |
| `ops_anomalies` | rule, key, severity, subject, item / unit / job / shipment / location ids (for filtering; no foreign keys, so the record of what was seen outlives what it was about), title, `detail` jsonb (the facts, including the threshold used), link, sticky, occurrences, occurred / first seen / last seen / cleared / resolved times, who resolved it and why, `reopened_from`, a cached explanation. Unique `(rule, key)` while open |
| `ops_runs` | every run's trigger, times, counts and per-rule results; the last 500 are kept |
| `ops_location_profiles` | the location facts above. No foreign key: a backup restore deletes and re-inserts locations with the same ids, and the facts should survive that |

Two SQL functions mirror pure helpers and are only used to narrow queries:
`ops_identity_key(text)` (identifier comparison) and `ops_haversine_m(...)`
(great-circle distance). The database test checks each against its
JavaScript twin.

Thresholds are stored as JSON in `app_settings` under `ops_intel.settings`,
laid over the defaults on every read, so a threshold added later takes its
default until changed.

**Backups** include `ops_location_profiles`. A file from before this feature
leaves the current facts alone. Anomalies and runs are not in the backup: the
next run rebuilds what is current, and every change to them is in the audit
log. Thresholds, like the rest of the instance configuration, are not in the
backup either.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `OPS_INTEL_INTERVAL_MIN` | `15` | Minutes between scheduled runs while the feature is on. `0` stops the schedule; **Run now** still works. The first run is 90 seconds after start. |

Plain-language explanations use the language model configured with
`LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. Without one the button is not
shown and the API answers `available: false`.

## Code map

```
server/migrations/0043_ops_intel.sql
server/src/db/tables/ops-intel.ts
server/src/services/ops-intel/
  index.ts        public surface
  model.ts        rule registry, settings, defaults and limits (pure)
  rules.ts        the rules (pure)
  reconcile.ts    the anomaly lifecycle (pure)
  places.ts geo.ts text.ts   location tree, distance, normalization (pure)
  gather.ts       the facts each rule reads (SQL, read-only)
  engine.ts       a run: gather, evaluate, reconcile, write, publish; the schedule
  anomalies.ts    queue, resolve, summary, explanations
  storage.ts slotting.ts     analytics (pure); storageData.ts reads and caches
  load.ts         load planning (pure); loadData.ts reads; loadPdf.ts prints
  profiles.ts settings.ts events.ts backup.ts
server/src/routes/ops-intel.ts
client/src/features/ops-intel/       the Insights page
server/tests/ops-intel-*.test.ts
```

## Testing

```bash
pnpm test                               # every rule, the lifecycle, analytics and planner; no database
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_ops_intel_test \
  pnpm --filter bindex-server test      # also the whole flow on Postgres
```

Every rule has a fixture that produces an anomaly and a fixed fixture that
resolves it, through the same reconcile step the scheduled run uses. The load
planner is checked against 300 generated plans for never exceeding a
vehicle's capacity, respecting stop order, and placing or reporting every line.
