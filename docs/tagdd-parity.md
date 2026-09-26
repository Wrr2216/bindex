# Tagdd+ feature parity plan

Source: every page in `https://tagdd.io/sitemap_index.xml`, scraped 2026-09-26
(24 URLs: home, Movers, Commercial & Office, Home app, Home portal, pricing,
four feature posts, two release notes, three Learn articles, support, training).

Goal: give Bindex the Tagdd+ capabilities that matter for **warehouse,
commercial and industrial** use, with BLE, GPS and RFID as first-class tracking
technologies. Residential-only and marketing items are listed at the end with
the reason they are left out.

## 1. What Tagdd+ does, and where Bindex stands

| # | Tagdd+ capability (as advertised) | Bindex today | Feature |
|---|---|---|---|
| 1 | Dual-frequency RFID/NFC tags: UHF bulk reads (40–50 ft, 100–150+ tags/s), NFC tap (<4 cm), one ID across both radios | Desk readers as keyboards, `rfid` identifiers, one M7e bridge, NFC tags carrying the item URL | T01, T07 |
| 2 | Fixed readers: door scanners (antenna + tablet + reader on a tripod), dock antenna arrays, handheld readers | One bridge posting to an in-memory channel; no reader registry, zones, direction or history | T01 |
| 3 | BLE tracking: AirTag-style beacons on equipment and materials; BLE room beacons for room-level matching | None | T09 |
| 4 | GPS: single-use trackers in transit, vaults tracked by GPS, live transit visibility, "updates at key locations" | None | T10 |
| 5 | Bulk RFID audits of floors, trucks, rooms in one pass | Building audit with live reader feed | T01 (extends) |
| 6 | Room-based delivery guidance: readers send crews to the right room, flag missing or wrong-shipment items | None | T11 |
| 7 | NFC "tap" lookup from a phone | NFC tag holds the item URL; no Web NFC read/write | T07 |
| 8 | QR and legacy sticker support (color, lot, tag number), with a path to RFID and RFID+NFC | QR/barcode yes; legacy stickers no | T07 |
| 9 | AI box capture: OCR handwriting on boxes, box size, contents, categories, condition | None | T12 |
| 10 | Serial number and data-plate capture straight off equipment labels | None | T02 |
| 11 | Condition photos per carton, before/after, AI-written handling notes | One primary photo per item | T02, T12 |
| 12 | AI property inspection pre/post: one photo → room, exact spot, description; before/after comparison; shareable report | None | T13 |
| 13 | Video disassembly: narrated video → numbered, timestamped steps, parts-detached list, flagged callouts, export | None | T20 |
| 14 | AI high-value declaration: photo → brand, model, materials, condition, estimated value; signed | Price lookup by web search only | T19 |
| 15 | Receipt matching: photo of a receipt → purchase date, value, warranty, linked to the item | None (warranty is on the roadmap) | T19 |
| 16 | Full-room inventory from a camera walkthrough; box-level itemized list from one photo | None | T21 |
| 17 | AI inventory converter: paper inventory → digital | None | T21 |
| 18 | AI error detection: missing cartons, duplicates, packing/loading/delivery mismatches | Missing flag from audits only | T22 |
| 19 | Load planning from predicted volume/weight; warehouse dwell time, retrieval prediction, layout suggestions | None | T22 |
| 20 | Immutable audit logs | `item_events`, editable, not chained | T04 |
| 21 | WMS, dispatch, CRM, claims, billing/ERP integrations "fed clean, real-time tag data" | REST API and API keys; no webhooks (on the roadmap) | T04 |
| 22 | Reconciliation against your asset register, flagging missing or misplaced | Audit against Bindex's own records only | T05 |
| 23 | Floor- and department-level bulk relocation manifests | Per-container contents sheets | T03 |
| 24 | Multi-site, multi-phase staged moves in one system | None | T03 |
| 25 | Custom job and move types per organization (Dashboard v1.1.1) | None | T03 |
| 26 | Consumables (boxes, tape, pads, wrap) and equipment (dollies, straps, lift gates) with check-in/out by crew, truck, branch | Single-item check-out only | T06 |
| 27 | Vault tracking: items into vaults, vaults tracked by GPS/BLE, chain of custody after unload | Nesting containers only | T01, T09, T10, T14 |
| 28 | Chain of custody for sensitive files, timestamped origin → destination | None | T14 |
| 29 | Digital signature and validation on the customer's own device; review and sign at delivery | None | T14 |
| 30 | Customer portal: shipment ID, weight, distance, ETA, searchable inventory by room, scan/placement progress, flagged items | None | T15 |
| 31 | Assign inventory to a third party (another company's driver inventories at destination) | None | T15 |
| 32 | Claims center: claim pulls pack-day condition notes and photos automatically; status; estimated total | None | T16 |
| 33 | Documents: packets, interactive form filling, draft copying, custom fields, packets conditional on job type (Dashboard v1.1.1) | None | T17 |
| 34 | Crew check-in by badge scan with compliance status shown at check-in | None | T18 |
| 35 | Insurance-ready valued export | CSV export, contents sheets | T19 |
| 36 | Mobile app for crews working in dead zones | Installable PWA shell; no offline data | T08 |

### Left out, and why

- **Tagdd+ Home consumer app and its $30/year app-store billing.** Consumer
  product and billing; Bindex is self-hosted and AGPL. The home-inventory
  capabilities it advertises (room organization, receipts, insurance export)
  are covered by T19 and T21.
- **Yembo video-survey integration.** A proprietary partner API. T05 and T21
  give a generic import path that a survey export can use.
- **LaborNet CID compliance.** A proprietary partner. T18 builds the same
  "scan the badge, see compliance" flow on credentials Bindex stores itself,
  with a hook for an external verifier.
- **Pro subscriptions / feature gating (Dashboard v1.1.0).** Bindex already
  gates features with instance switches; paid tiers do not apply.
- **Pricing pages, newsletter, training videos, support form, WordPress
  publishing.** Marketing and content, not product.

## 2. Build plan

Features are built by separate developer agents, each on its own branch, each
opening its own draft pull request.

**Wave 1** branches from `main`. T01–T04 are cores that later features build
on; T05–T08 are independent.

**Wave 2** branches from the integration branch
`claude/tagdd-feature-parity-igoea3`, after T01–T04 are merged into it, and
opens its pull requests against that branch.

| ID | Feature | Branch | Migration | Dev port | Depends on |
|---|---|---|---|---|---|
| T01 | Tracking core and fixed RFID readers | `claude/tagdd-t01-tracking-core` | 0022 | 3101 | — |
| T02 | Attachments, signatures, AI vision; data-plate capture | `claude/tagdd-t02-media-ai-core` | 0023 | 3102 | — |
| T03 | Projects, jobs, shipments and relocation manifests | `claude/tagdd-t03-jobs-core` | 0024 | 3103 | — |
| T04 | Tamper-evident audit log, event bus, webhooks | `claude/tagdd-t04-event-backbone` | 0025 | 3104 | — |
| T05 | Asset register import and reconciliation | `claude/tagdd-t05-register-reconcile` | 0026 | 3105 | — |
| T06 | Consumables and equipment accountability | `claude/tagdd-t06-consumables` | 0027 | 3106 | — |
| T07 | Tag commissioning: NFC, RFID encoding, legacy stickers | `claude/tagdd-t07-tag-commissioning` | 0028 | 3107 | — |
| T08 | Offline field mode | `claude/tagdd-t08-offline-field` | 0029 | 3108 | — |
| T09 | BLE beacons, gateways and room-level presence | `claude/tagdd-t09-ble` | 0030 | 3109 | T01 |
| T10 | GPS trackers, maps and geofences | `claude/tagdd-t10-gps` | 0031 | 3110 | T01, T03, T04 |
| T11 | Room-based placement guidance | `claude/tagdd-t11-placement` | 0032 | 3111 | T01, T03 |
| T12 | AI container capture and condition records | `claude/tagdd-t12-ai-condition` | 0033 | 3112 | T02 |
| T13 | Pre/post facility inspections | `claude/tagdd-t13-inspections` | 0034 | 3113 | T02, T03 |
| T14 | Chain of custody and digital sign-off | `claude/tagdd-t14-custody` | 0035 | 3114 | T02, T03, T04 |
| T15 | External portal: stakeholders and third-party crews | `claude/tagdd-t15-portal` | 0036 | 3115 | T01, T02, T03, T04 |
| T16 | Claims and incidents | `claude/tagdd-t16-claims` | 0037 | 3116 | T02, T03 |
| T17 | Documents and conditional packets | `claude/tagdd-t17-documents` | 0038 | 3117 | T02, T03 |
| T18 | Crew check-in and credentials | `claude/tagdd-t18-crew` | 0039 | 3118 | T03 |
| T19 | Valuation, high-value declarations, receipts, warranty | `claude/tagdd-t19-valuation` | 0040 | 3119 | T02, T04 |
| T20 | Teardown video to reassembly guide | `claude/tagdd-t20-teardown` | 0041 | 3120 | T02 |
| T21 | AI bulk capture: walkthroughs and paper manifests | `claude/tagdd-t21-bulk-capture` | 0042 | 3121 | T02 |
| T22 | Operations intelligence: anomalies, dwell, load planning | `claude/tagdd-t22-ops-intel` | 0043 | 3122 | T01, T03 |

## 3. Brief shared by every developer prompt

Every prompt below is sent together with this brief. `<ID>`, `<slug>`,
`<branch>`, `<NNNN>`, `<port>` and `<base>` come from the table above.

```text
You are a senior full-stack developer adding one feature to Bindex, a
self-hosted, AGPL inventory app (TypeScript). You work alone on your own branch
and open your own draft pull request. Other developers are building other
features on other branches at the same time, so follow the collision rules
exactly.

REPOSITORY
- You are in an isolated git worktree of github.com/Wrr2216/bindex.
- Start with: git fetch origin <base> && git checkout -b <branch> origin/<base>
- Read first: CONTRIBUTING.md, README.md, docs/hardware.md, docs/api.md,
  server/src/db/schema.ts, server/src/services/config.ts, server/src/index.ts,
  server/src/routes/api.ts, client/src/App.tsx, client/src/scan/ScanProvider.tsx.
- Stack: Express 5 + zod + Drizzle over node-postgres, raw SQL migrations
  (server/); React 19 + react-router 7 + Tailwind 4 + Vite (client/); pnpm
  workspace. pdf-lib, exceljs, bwip-js, @napi-rs/canvas are already available.

HOW THIS CODEBASE WORKS (follow it)
- routes/ parse and validate with zod via parse() from lib/http, then delegate;
  services/ hold logic and database access; lib/ has no domain knowledge.
- Errors: throw badRequest/notFound/forbidden/HttpError from lib/errors with a
  message that tells a person what to do.
- Logs: logger.info("dotted.stable.name", { variable: parts }).
- Nothing user-visible hardcoded for the four core concepts: use useTerms() for
  item/location/group/holder words in the client.
- A user-visible feature gets ONE instance feature switch that removes its
  screens and navigation when off.
- Optional integrations (AI, SMTP, external services) degrade quietly: when
  unconfigured they report available:false and disappear from the UI. Never
  throw because something optional is missing.
- Mutations that change instance behaviour (settings, devices, webhooks,
  templates) use requireAdmin. API keys with scope "read" are already limited
  to GET/HEAD by the auth layer.
- Hardware and other non-browser clients authenticate with tokens and are
  mounted before the session guard, like server/src/routes/device.ts.
- Page-level scan capture: useScan().armCapture(handler) for the next scan,
  useScan().armBulkCapture(handler) for every scan until cancelled with null.
- Comments explain why, not what. Match the surrounding style.

COLLISION RULES (other branches edit the same shared files)
- Put new code in files you own:
    server/src/services/<slug>/..., server/src/routes/<slug>.ts,
    server/src/db/tables/<slug>.ts, client/src/features/<slug>/...,
    server/tests/<slug>*.test.ts, docs/<slug>.md
- Migration: exactly one new file, server/migrations/<NNNN>_<slug_with_underscores>.sql.
  Idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS before ADD).
  Never edit an existing migration. Do not create other numbers.
- Drizzle tables go in server/src/db/tables/<slug>.ts. Append exactly one line
  at the very end of server/src/db/schema.ts: export * from "./tables/<slug>";
- In client/src/api/client.ts change `async function req<T>(` to
  `export async function req<T>(` (every branch makes this identical change) and
  put your client calls in client/src/features/<slug>/api.ts, your types in
  client/src/features/<slug>/types.ts. Do not add methods to the shared `api`
  object and do not add types to client/src/types.ts, except the Features type.
- Shared files you may touch, only by appending the smallest possible change at
  the end of the relevant list, never reordering or reformatting:
    server/src/routes/api.ts (import + one mount line)
    server/src/index.ts (only for a pre-auth router or a background job)
    server/src/env.ts and .env.example (new variables, in a block commented with <ID>)
    server/src/services/config.ts (your one feature switch: Features type, KEYS,
      defaults, build, FEATURE_KEYS)
    server/src/routes/settings.ts (one line in the features zod object, e.g.
      `myFeature: z.boolean().optional()`; without it the switch cannot be saved)
    client/src/pages/Settings.tsx (one import and one component line after the
      last section, only for admin-only configuration screens)
    client/src/types.ts (Features type only), client/src/config/useConfig.tsx
      (FALLBACK.features), client/src/components/settings/InstanceSettings.tsx
      (FEATURE_LABELS)
    client/src/App.tsx (routes inside AppShell), client/src/components/Layout.tsx
      (nav link before Settings)
    server/src/services/backup.ts (append your tables to TABLES and DATE_FIELDS;
      do NOT change BACKUP_VERSION, the integrator bumps it once)
    docker-compose.yml (only if you need a volume or service)
- Do not edit CHANGELOG.md, README.md or docs/api.md; document everything in
  docs/<slug>.md. The integrator links it.
- Do not upgrade existing dependencies. Add a new one only when it clearly earns
  its place; use pnpm --filter <pkg> add, and commit the lockfile.
- The item_identifiers type CHECK constraint is owned by T07. Nobody else
  changes it.

VERIFY BEFORE YOU PUSH
- pnpm install; pnpm typecheck; pnpm test; pnpm build. All must pass.
- Unit-test pure logic with node:test in server/tests/<slug>*.test.ts (see
  server/tests/codes.test.ts: set DATABASE_URL and SESSION_SECRET before a
  dynamic import).
- Postgres 16 is running locally (host localhost, port 5432, user postgres,
  password postgres). Use your own database:
    PGPASSWORD=postgres createdb -h localhost -U postgres bindex_<slug_with_underscores>
    cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_<slug_with_underscores> \
      SESSION_SECRET=dev-secret-0123456789 pnpm migrate
  Then apply your migration file a second time with psql to prove it is
  idempotent.
- Tests that need Postgres read TEST_DATABASE_URL and skip with a reason when
  it is unset, so CI (which has no database) stays green.
- Smoke-test the real server: build, then run it with PORT=<port>
  AUTH_MODE=trusted and the same DATABASE_URL, and exercise every endpoint you
  added with curl (and a device token where relevant). Never use ports 3000 or
  5173. Stop your server when done. Express sendFile refuses paths containing a
  dot directory and worktrees live under .claude/, so copy client/dist outside
  the worktree and set CLIENT_DIST to that copy; this is not a code bug.
- If you change the client, run the Vite build and, where practical, load your
  screens with Playwright/Chromium (preinstalled; do not run playwright install)
  against your running server to confirm they render without console errors.
- Re-read your own diff adversarially before pushing.

GIT AND PULL REQUEST
- Small, logical commits. Message style matches the repo history: imperative,
  sentence case, no prefix ("Add a networked reader bridge"). End every commit
  message with these two lines:
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_017iFnEmQqPZXkcdcVqyBWRK
- Push only your own branch: git push -u origin <branch>. On a network error
  retry up to 4 times, waiting 2s, 4s, 8s, 16s. Never push to any other branch.
  Never force-push, merge, or rebase anyone else's work.
- Open a DRAFT pull request with the GitHub MCP tool (load it with ToolSearch
  "select:mcp__github__create_pull_request"): owner Wrr2216, repo bindex,
  head <branch>, base <base>, draft true, title "<ID>: <feature title>".
  Body sections: Summary; Tagdd+ parity (which advertised capability this
  delivers); What changed; Shared files touched (list each); How to test;
  Hardware or services needed; Follow-ups. End the body with exactly:

    🤖 Generated with [Claude Code](https://claude.com/claude-code)

    https://claude.ai/code/session_017iFnEmQqPZXkcdcVqyBWRK

- Do not include any model name or model identifier anywhere except the
  Co-Authored-By trailer above.

FINAL REPORT (your last message)
Branch, PR URL, migration file, feature switch name, shared files touched, what
works end to end, what is stubbed or untested against real hardware, exact test
and build results, and anything the integrator must do when merging.
```

## 4. Feature prompts

### T01 — Tracking core and fixed RFID readers

```text
FEATURE T01: Tracking core and fixed RFID readers
slug: tracking-core   branch: claude/tagdd-t01-tracking-core   base: main
migration: 0022   port: 3101   feature switch: tracking ("Readers, beacons and trackers")

WHY
Tagdd+ sells "instant, autonomous tracking: bulk RFID reads, room-level BLE
matching, GPS in transit", with door scanners (antenna + tablet + reader on a
tripod), handheld readers and dock antenna arrays. Bindex today has one reader
bridge that posts EPCs into an in-memory channel (server/src/services/livefeed.ts,
server/src/routes/device.ts, bridge/). Nothing is stored, there is no device
registry, no zones, no direction, no history. You are building the shared
tracking core that the BLE (T09), GPS (T10) and placement (T11) features will
plug into, plus the fixed-RFID-reader use case end to end.

BUILD
1. Device registry. Table tracking_devices: id, kind (rfid_reader,
   rfid_portal, ble_gateway, ble_beacon, ble_tag, gps_tracker, nfc_reader,
   mobile), name, external_id (reader serial, MAC, IMEI; unique per kind),
   location_id (the zone a fixed device covers, nullable), item_id and unit_id
   (the asset a tag or tracker is attached to, nullable), updates_location
   boolean (whether reads by this device may move items), settings jsonb
   (portal antenna map, RSSI floor, dwell), token_hash (per-device ingest token,
   stored hashed like API keys), battery_pct, last_seen_at, last_lat, last_lng,
   disabled, created_at, updated_at. Keep `kind` a text column with a CHECK so
   T09/T10 can use the kinds already listed; do not add kinds they would need
   to migrate.
2. Sightings. Table sightings (bigserial id): observed_at, received_at,
   device_id, tech (rfid, ble, gps, nfc, barcode, manual), code (raw EPC /
   beacon id / tracker id), item_id, unit_id, location_id (resolved zone), rssi,
   antenna, direction (in|out|null), lat, lng, accuracy_m, speed_mps,
   heading_deg, meta jsonb. Indexes for (item_id, observed_at desc),
   (device_id, observed_at desc), (observed_at). Retention by
   SIGHTINGS_RETENTION_DAYS (default 90) with a daily prune job started in
   index.ts.
3. Latest position. Table asset_positions keyed by the asset (item, or item +
   unit): last tech, location_id, lat, lng, device_id, observed_at, and
   previous location_id. Update only when the new sighting is newer.
4. Services in server/src/services/tracking/:
   - resolve.ts: batch-resolve raw codes to { itemId, unitId } using
     item_identifiers (any type, including rfid), items.asset_code,
     item_units.asset_code and item_units.serial, in a fixed number of queries.
     Normalize EPC hex (uppercase, strip spaces/colons). Do NOT record "scanned"
     item events (getByIdentifier does; reads from hardware must not flood
     history).
   - ingest.ts: recordSightings(device, reads[]) → insert sightings, update
     asset_positions and device last_seen, return { accepted, matched,
     unknown }. When an asset's zone changes, record one item event with
     action "moved" and detail { source: "tracking", tech, deviceId, from, to }.
     Only change items.location_id / item_units.location_id when the device has
     updates_location = true. Duplicate suppression: ignore a repeat of the
     same code on the same device within a configurable window (default 5s).
   - direction.ts: pure function inferring in/out for a portal from a read
     sequence using the antenna→side map in settings (e.g. antennas 1,2 =
     outside, 3,4 = inside; first-seen side vs last-seen side within a window).
     Unit-test it thoroughly.
   - adapters/: pure parsers turning vendor payloads into normalized reads,
     each unit-tested with fixture payloads taken from vendor documentation:
       generic JSON { device, reads: [{ code, ts?, rssi?, antenna?, tech?, lat?, lng? }] }
       Zebra FX/ATR IoT Connector JSON (tag data events with idHex, peakRssi,
         antenna, timestamp; single object or array)
       Impinj R700 IoT device interface webhook/stream JSON (tagInventoryEvent
         with epcHex, antennaPort, peakRssiCdbm, timestamp)
       Impinj Speedway Connect HTTP POST (form-encoded reader_name,
         mac_address, field_names, field_values)
     Tolerate unknown fields; reject garbage with a 400 that says what was
     expected. Mark these as "built from documentation, not yet verified on
     hardware" in docs.
5. Device auth. Export a middleware requireDevice(kinds?) from
   server/src/services/tracking/auth.ts (or routes) that accepts a per-device
   token (Authorization: Bearer or x-device-token) and sets the device on the
   request, and still accepts the global INGEST_TOKEN (mapping to a device
   looked up or auto-created by the reader id in the payload, kind
   rfid_reader, so the existing bridge keeps working unchanged).
6. Routes (token-auth, pre-session, under /api/device, extend
   server/src/routes/device.ts): keep POST /api/device/scan exactly compatible
   (still feeds livefeed for the Building Audit screen) and ALSO record
   sightings; add POST /api/device/reads (generic), /reads/zebra,
   /reads/impinj, /reads/speedway-connect.
   Session routes under /api/tracking: CRUD devices (admin; create returns the
   device token once), GET /items/:id/positions and /items/:id/sightings
   (paged), GET /locations/:id/present (assets whose latest position is in
   that zone or its descendants), GET /feed?since=<id> (recent sightings for a
   live view), POST /devices/:id/rotate-token (admin).
7. Client (client/src/features/tracking-core/):
   - Settings → "Readers and devices" (admin): list, add, edit, zone picker
     (location tree), attach-to-asset picker, portal antenna map editor, token
     shown once with copy button, last seen and battery.
   - Item detail: a "Last seen" card (zone, device, time, tech, map link when
     lat/lng) and a sightings timeline; gated by the feature switch.
   - Location detail: "Detected here now" list.
   - A "Live reads" screen showing the feed across devices with zone and
     direction, for commissioning a portal.
   - Building Audit: let the reader channel be picked from registered devices
     instead of free text (keep free text working).
8. Update bridge/m7e_bridge.py so it can optionally send antenna and RSSI to
   /api/device/reads (off by default; the existing /scan path must still work).
9. docs/tracking-core.md: concepts (device, zone, sighting, position),
   setup for a dock-door portal and a zone reader, vendor configuration steps
   for each adapter, the generic payload, retention, and privacy notes.

ACCEPTANCE
- An existing bridge posting to /api/device/scan with INGEST_TOKEN still
  drives the Building Audit live feed, and those reads now also appear in
  sightings.
- A device with its own token posting Zebra, Impinj or generic payloads
  produces sightings, updates positions, and (with updates_location) moves the
  item and writes one "moved" event per zone change, not per read.
- A two-zone portal fixture yields the correct in/out direction.
- 10,000 reads in one request are accepted in well under a few seconds
  (batch inserts, batch resolution).
- Feature switch off hides every screen.
```

### T02 — Attachments, signatures and AI vision; data-plate capture

```text
FEATURE T02: Attachments, signatures and AI vision; serial and data-plate capture
slug: media-ai-core   branch: claude/tagdd-t02-media-ai-core   base: main
migration: 0023   port: 3102   feature switch: aiCapture ("AI capture from photos")

WHY
Tagdd+ attaches "condition photos on every carton", video clips and signed
records to everything, and uses AI to read "serial numbers and equipment data
plates straight off the label — no manual lookup, no typos". Bindex stores one
primary photo per item (server/src/services/photos.ts, item_photos bytea) and
has a text-only LLM client (server/src/services/enrichment/model.ts, chatJson,
OpenAI-compatible, LLM_BASE_URL / LLM_API_KEY / LLM_MODEL). Eight later
features need photos, video, signatures and vision on records other than
items. You build that shared layer, plus one complete feature on top of it.

BUILD
1. Attachments. Table attachments: id, owner_type (text: item, unit,
   location, and any future owner such as job, shipment, inspection, claim,
   custody, document), owner_id uuid, kind (photo, video, audio, document,
   signature), stage (free text such as before, after, pack, delivery;
   nullable), caption, mime, size_bytes, sha256, storage (db|disk), bytes bytea
   (for db), path (for disk), width, height, duration_ms, meta jsonb,
   created_by, created_at. Index (owner_type, owner_id).
   Storage policy: bytes up to ATTACHMENT_DB_MAX_MB (default 8) in Postgres;
   larger files (video) on disk under DATA_DIR (default ./data; add a named
   volume in docker-compose.yml mounted at /app/data and set DATA_DIR there).
   ATTACHMENT_MAX_MB default 512. Stream large uploads to disk; do not buffer a
   500 MB video in memory. Serve with correct Content-Type and HTTP Range
   support so video seeks on phones. Validate mime by magic bytes, not only by
   header. Compute sha256 while streaming.
   Service API (server/src/services/media-ai-core/attachments.ts), stable for
   other features:
     saveAttachment({ ownerType, ownerId, kind, stage?, caption?, mime,
       stream|bytes, createdBy }) → Attachment
     listAttachments(ownerType, ownerId, { kind?, stage? })
     getAttachmentStream(id, range?)
     deleteAttachment(id)
     registerOwnerType(name, exists: (id) => Promise<boolean>) so owners
       are validated without this module knowing every table.
   Routes /api/attachments: POST (raw body upload; owner, kind, stage, caption
   as query params or headers), GET list, GET /:id (stream), DELETE /:id.
   Items keep their existing primary photo; offer "set as primary" from an
   item photo attachment by reusing savePhoto.
2. Signatures. Table signatures: id, owner_type, owner_id, signer_name,
   signer_email, signer_role, statement (the exact text attested),
   content_hash (sha256 of the canonical JSON of what was signed, so a later
   change to the record is detectable), attachment_id (the PNG), signed_at,
   ip, user_agent, signed_by_user (nullable: external signers have none).
   Service sign({...}) and verifySignature(id, currentContent) → { valid,
   reason }. Route POST /api/signatures and GET list by owner.
3. AI helpers in server/src/services/ai/ (stable for other features):
   - visionJson({ event, system, prompt, images: { mime, bytes }[],
     maxTokens?, context? }) → Record<string, unknown> | null. Same contract
     as chatJson: OpenAI-compatible chat/completions with content parts
     [{ type: "text" }, { type: "image_url", image_url: { url: "data:…" } }],
     one JSON object back, null on any failure, never throws. Downscale images
     to max 1600 px JPEG with @napi-rs/canvas before sending. Timeout 45s.
   - transcribe({ bytes|stream, mime, filename }) → { text, segments: [{ start,
     end, text }] } | null via an OpenAI-compatible /audio/transcriptions
     endpoint (response_format verbose_json).
   - Env (append in env.ts/.env.example): LLM_VISION_MODEL (defaults to
     LLM_MODEL), STT_BASE_URL (defaults to LLM_BASE_URL), STT_API_KEY
     (defaults to LLM_API_KEY), STT_MODEL (default whisper-1). Expose
     env.llmVisionConfigured and env.sttConfigured.
   - Report availability in GET /api/config integrations as vision and
     transcription (append to that object only).
4. Client shared components (client/src/features/media-ai-core/), exported
   for other features:
   - <AttachmentGallery ownerType ownerId stage? kinds? /> with camera capture
     (<input type=file accept capture>), library pick, upload progress, video
     playback, stage filter chips (Before / After / …), delete.
   - <SignaturePad onSigned /> (pointer events, pressure-agnostic, clear,
     undo, exports PNG), and <SignDialog ownerType ownerId statement content />
     that captures name, role, email and the signature, then calls the API.
   - useAiAvailability() hook.
5. The feature: serial and data-plate capture.
   On the item form and item detail, "Read from label" opens the camera. The
   photo goes to POST /api/ai/data-plate, which calls visionJson and returns
   { brand, model, serial, partNumber, assetTag, mac, manufactureDate,
   ratings: { voltage, amperage, wattage, frequency }, otherIdentifiers[],
   confidence per field, rawText }. The user reviews every field (editable,
   low-confidence fields highlighted) before anything is saved; accepted
   values fill brand/model and add serial/mac/asset_tag identifiers (respect
   the existing uniqueness rules and show a clear error on a duplicate). The
   label photo is kept as an attachment with stage "label". Works for units
   too (serial on the unit). Hidden when vision is not configured or the switch
   is off.
6. docs/media-ai-core.md: storage policy, sizing, backup note (attachments on
   disk are outside the JSON backup; say how to back them up), the helper
   APIs other features must use, provider setup for vision and transcription.

ACCEPTANCE
- Upload and stream back a 200 MB video with Range requests without memory
  blowing up; a 2 MB photo lands in Postgres; both list under their owner.
- visionJson and transcribe return null and never throw with no key set.
- A signature verifies, and fails verification after the signed content
  changes.
- Data-plate capture fills fields only after the user confirms.
- Unit tests: magic-byte detection, range parsing, canonical JSON hashing,
  vision response parsing (fixture replies, including malformed ones).
```

### T03 — Projects, jobs, shipments and relocation manifests

```text
FEATURE T03: Projects, jobs, shipments and relocation manifests
slug: jobs-core   branch: claude/tagdd-t03-jobs-core   base: main
migration: 0024   port: 3103   feature switch: jobs ("Projects, jobs and shipments")

WHY
Tagdd+ Commercial promises "multi-site and multi-phase coordination: staged
moves across departments, floors, or locations stay reconciled in one system",
"bulk relocation manifests generated floor-by-floor, department-by-department",
"custom job and move types tailored to each organization", and a task list per
job (pre-inspection, pack, load, deliver, post-inspection). Every item is
"tracked continuously from pack-out through final delivery". Bindex has no
notion of a job or a shipment. You build it; later features hang their work
off jobs and shipments.

BUILD
1. Data model:
   - job_types: org-defined name, color, description, default task template
     (jsonb list of { kind, title }), active.
   - projects: code (PRJ- plus Crockford base32, reuse lib/codes style), name,
     client company_id / entity_id, status, starts_on, ends_on, notes.
   - project_phases: project_id, sequence, name, window.
   - jobs: code (JOB-…), project_id?, phase_id?, job_type_id?, name, status
     (planned, in_progress, completed, cancelled), origin_location_id,
     destination_location_id, scheduled_start, scheduled_end, notes.
   - job_tasks: job_id, sequence, kind (pre_inspection, pack, load, transit,
     unload, place, post_inspection, custom), title, status (todo, doing,
     done, skipped), assignee entity/user, completed_at, completed_by. Seeded
     from the job type template. Later features attach to a task kind.
   - shipments: code (SHP-…), job_id, name, status (planned, staged, loaded,
     in_transit, delivered, closed), vehicle_location_id (a location that is a
     truck or trailer), seal_numbers text[], weight_kg, volume_m3, distance_km,
     eta, departed_at, arrived_at.
   - job_items (manifest lines): job_id, shipment_id?, item_id, unit_id?,
     origin_location_id (snapshot when added), destination_location_id,
     destination_label (desk/room text), floor, department, crate_no, stage
     (pending, packed, loaded, delivered, placed, missing, wrong_shipment,
     damaged), stage_at, stage_by, notes. Unique per (job, item, unit).
   - job_item_stage_history: every stage change with who, when, how (scan,
     rfid, manual, api), device id if any.
2. Services (server/src/services/jobs-core/): CRUD for all of the above; add
   items to a job by code list, by location subtree ("everything on floor 3"),
   or by CSV (code, destination, floor, department, desk); advanceStage(jobId,
   codes[], stage, { shipmentId?, via, deviceId? }) → { advanced, alreadyAt,
   notOnJob (scanned but not on this job), wrongShipment } with a local batch
   code resolver (item_identifiers, asset codes, unit codes/serials; no
   "scanned" events; T01 has an equivalent and the integrator will unify).
   Shipment status rules (e.g. cannot mark delivered while lines are still
   pending unless forced, with a reason). Progress rollups per job, shipment,
   floor and department.
3. Manifests: PDF (pdf-lib, follow server/src/services/printing/manifest.ts
   look) and XLSX, grouped floor-by-floor or department-by-department, with
   destination, crate numbers, stage checkboxes and a signature line; one per
   shipment as a bill of lading style load sheet with seal numbers.
4. Routes under /api/jobs, /api/projects, /api/shipments, /api/job-types
   (job types admin-only).
5. Client (client/src/features/jobs-core/): Projects list and detail with
   phases; Job detail with task list, manifest table (filter by floor,
   department, stage, shipment), progress bars, bulk destination assignment;
   "Scan to stage" panel that uses useScan().armBulkCapture and also accepts
   the live reader feed, showing each scan's result (advanced, already done,
   NOT ON THIS JOB, WRONG SHIPMENT) with a clear colour and sound; Shipment
   detail with load sheet; Settings → Job types. Nav entry "Jobs".
6. Emit item events for stage changes with detail { source: "job", jobId,
   stage }, one per item per change.
7. docs/jobs-core.md, including the extension points: task kinds, stage
   names, and service functions later features call.

ACCEPTANCE
- Create a project with two phases, a job from a job type (tasks seeded), add
  all items under a floor, assign destinations by department via CSV, print
  the floor manifest PDF, scan items to loaded on a shipment, see wrong-shipment
  and not-on-job flagged, deliver and place, and see progress hit 100%.
- Pure logic (stage transition rules, CSV parsing, rollups) is unit-tested.
```

### T04 — Tamper-evident audit log, event bus and webhooks

```text
FEATURE T04: Tamper-evident audit log, event bus and outbound webhooks
slug: event-backbone   branch: claude/tagdd-t04-event-backbone   base: main
migration: 0025   port: 3104   feature switch: none (admin settings sections)

WHY
Tagdd+ promises "immutable audit logs … evidence you can hand straight to a
claims adjuster" and feeds "clean, real-time tag data" into WMS, dispatch, CRM,
claims and ERP systems. Bindex writes item_events through recordEvent() in
server/src/services/items.ts; they can be edited or deleted and nothing leaves
the system unless polled. Webhooks are already on the README roadmap.

BUILD
1. Event bus: server/src/services/event-backbone/bus.ts exporting
   publish(type, data, { actor?, subject? }) — type is dotted
   (item.created, item.moved, job.stage_changed, device.offline …), subject
   is { type, id }, actor is { kind: user|api_key|device|system, id, name }.
   Never throws into the caller. recordEvent() in items.ts calls publish with
   type item.<action> (the ONLY edit you make to items.ts: one call at the end
   of recordEvent). Other features will call publish directly.
2. Audit log: append-only table audit_log (bigserial id, occurred_at, actor
   fields, type, subject_type, subject_id, data jsonb, prev_hash, hash).
   Hash chaining done inside Postgres so concurrent writers cannot fork the
   chain: a BEFORE INSERT trigger takes a transaction-level advisory lock,
   reads the head hash, and sets hash = sha256(prev_hash || canonical text of
   the row) with pgcrypto (CREATE EXTENSION IF NOT EXISTS pgcrypto). A BEFORE
   UPDATE OR DELETE trigger raises an exception. Retention is not allowed to
   delete rows; document that a DBA can archive by exporting and re-genesis
   with a signed checkpoint row.
   - Verify: GET /api/audit-log/verify (admin) walks the chain in SQL in
     batches and returns { ok, checked, firstBrokenId }.
   - Daily checkpoint: a background job appends an audit.checkpoint row with
     the head hash and count, and sends it through notify() (Pushover/Wazuh,
     best-effort) so an external copy of the head exists.
   - Viewer: GET /api/audit-log with filters (type prefix, subject, actor,
     date range) and cursor paging; export as NDJSON and CSV including hashes.
3. Webhooks: webhook_endpoints (url, description, secret, event patterns
   text[] with * wildcards like item.* , active, failure_count, disabled_at,
   created_by) and webhook_deliveries (endpoint_id, audit_log_id, event type,
   status pending|succeeded|failed|dead, attempts, next_attempt_at,
   response_status, response_ms, last_error). An in-process worker polls with
   SELECT … FOR UPDATE SKIP LOCKED so two app replicas do not double-send;
   retries with backoff 1m, 5m, 30m, 2h, 12h then dead; endpoints auto-disable
   after 50 consecutive failures and notify(). Each POST carries JSON
   { id, type, occurredAt, subject, actor, data } and headers
   X-Bindex-Event, X-Bindex-Delivery, X-Bindex-Signature:
   t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>" with the secret>. 10s timeout,
   no redirects, block private and link-local targets (reuse isBlockedHost in
   server/src/services/images.ts; allow an explicit WEBHOOK_ALLOW_PRIVATE=true
   for on-prem WMS on a LAN). Admin UI in Settings → Webhooks: create (secret
   shown once), pattern picker from an event catalog, send test ping, delivery
   log with response codes, redeliver.
4. Polling feed for systems that cannot receive webhooks:
   GET /api/events?after=<id>&types=item.*,job.* (API-key friendly, read scope).
5. Client: Settings → Audit log (admin) viewer with verify button and export;
   Settings → Webhooks.
6. docs/event-backbone.md: event catalog (every type currently emitted and
   the shape of data), signature verification snippets (Node and Python),
   retry policy, the polling feed, and how other features must publish.

ACCEPTANCE
- Every existing item event also lands in audit_log with a valid chain.
- UPDATE or DELETE on audit_log fails. Tampering a row directly (disable the
  trigger in a test DB) makes verify report the first broken id.
- 20 concurrent publishes produce a single unbroken chain.
- A local test receiver gets signed webhooks; a 500 is retried with backoff;
  signature verifies with the documented snippet.
- Unit tests: pattern matching, signature, backoff schedule, canonicalization.
```

### T05 — Asset register import and reconciliation

```text
FEATURE T05: Asset register import and reconciliation
slug: register-reconcile   branch: claude/tagdd-t05-register-reconcile   base: main
migration: 0026   port: 3105   feature switch: registerReconcile ("Asset register reconciliation")

WHY
Tagdd+ Commercial: "Reconciliation against your asset register — automatically
flag what's missing or misplaced against your existing IT asset management
records." Bindex audits only against its own records. The README roadmap also
asks for "Import from CSV, and from Snipe-IT and Homebox exports".

BUILD
1. Upload a register as CSV or XLSX (exceljs is available; parse CSV with a
   small RFC 4180 parser you write and test, handle BOM, quoted newlines,
   ; and , delimiters). Store register_imports (name, source preset, file
   sha256, row count, column mapping, created_by) and register_rows (raw jsonb
   plus normalized asset_tag, serial, epc, name, model, location_text,
   custodian, cost, purchase_date).
2. Column mapping UI with auto-detect by header names and saved presets:
   Generic, Snipe-IT asset export, Homebox export, and "ERP fixed-asset
   register" (asset number, description, serial, location, cost, acquisition
   date). Location text maps to Bindex locations by exact path, then name,
   then a mapping table the user edits once and is remembered.
3. Reconcile a register against Bindex, optionally scoped to a company or a
   location subtree. Match on, in order: asset tag, serial, RFID/EPC, Bindex
   asset code, then fuzzy name+model with pg_trgm similarity (show the score;
   fuzzy matches are proposals, not facts). Classify every row and item:
   matched, misplaced (location differs), field conflict (serial/model/cost
   differ), register-only (missing from Bindex), Bindex-only (unregistered),
   duplicate (two rows or items claim the same key), and flagged-missing in
   Bindex. Save the run (reconciliation_runs, reconciliation_results) so it can
   be reopened and compared with a later run.
4. Actions from the result screen, each explicit and bulk-capable: create
   items from register-only rows (with identifiers), move misplaced items to
   the register location or accept Bindex's location, copy chosen fields
   either direction, flag missing, mark ignored with a reason.
5. Export the discrepancy report as XLSX and PDF (summary counts, then one
   section per class).
6. Import-only mode: "Import as new items" for moving off Snipe-IT or Homebox,
   with a dry-run preview showing exactly what will be created.
7. Client screens under client/src/features/register-reconcile/, reached
   from Audit (nav stays as is) and gated by the switch.
8. docs/register-reconcile.md with preset column lists and matching rules.

ACCEPTANCE
- A 5,000-row register reconciles in seconds with batched queries.
- Every class above is produced by a fixture and covered by unit tests of the
  pure matching/classification code.
- Nothing is written to items until the user runs an action; every action
  records item events.
```

### T06 — Consumables and equipment accountability

```text
FEATURE T06: Consumables and equipment accountability
slug: consumables   branch: claude/tagdd-t06-consumables   base: main
migration: 0027   port: 3106   feature switch: consumables ("Consumables and equipment")

WHY
Tagdd+ "monitors consumables — boxes, tape, pads, stretch wrap — and equipment
like dollies, hand trucks, lift gates, and straps, with check-in/check-out
accountability by crew, truck, or branch." Bindex has quantity on items and
single-item check-out (server/src/services/assignments.ts) but no stock
levels, usage or kit check-out.

BUILD
1. Consumables: mark an item as consumable (store on items.metadata or a
   side table; do not add columns to items) with unit of measure, reorder
   point, reorder quantity and preferred supplier text. Table stock_levels
   (item_id, location_id, qty numeric) and stock_movements (item_id,
   from_location_id, to_location_id, qty, reason receive|issue|return|
   transfer|consume|adjust|count, holder entity id (crew/truck/branch as
   entities with kind crew|vehicle|branch), job_ref text (free text now; T03
   jobs may exist later), note, created_by, created_at). Stock level updates
   and movement insert in one transaction; never negative unless an admin
   adjusts with a reason.
2. Flows: receive stock (scan or pick), issue to a crew/truck/branch, return
   unused, record consumption, cycle count with variance, transfer between
   locations. Each is quick on a phone: scan the item code, type a quantity,
   done.
3. Low-stock: dashboard card and list; a daily check sends one notify()
   digest (lib/notify.ts) listing items below reorder point per location.
4. Equipment kits: check out many equipment items to one holder in a single
   scan session using armBulkCapture, with an expected return date; "End of
   day return" screen per holder shows what went out vs what came back and
   flags what is still out; overdue list. Build on the existing assignments
   service for the per-item records rather than duplicating it.
5. Reports: usage by holder and by item over a date range, cost of
   consumables used (valueCents per unit), XLSX export.
6. Client under client/src/features/consumables/, nav "Supplies".
7. docs/consumables.md.

ACCEPTANCE
- Receiving, issuing, returning and counting keep stock_levels equal to the
  sum of movements (a test proves it).
- A kit check-out of 12 items and a partial return shows exactly the missing
  ones.
- Low-stock digest fires once per day, not per request.
```

### T07 — Tag commissioning: NFC, RFID encoding, legacy stickers

```text
FEATURE T07: Tag commissioning — NFC tap and write, RFID encoding and bulk binding, legacy stickers
slug: tag-commissioning   branch: claude/tagdd-t07-tag-commissioning   base: main
migration: 0028   port: 3107   feature switch: legacyTags ("Legacy sticker numbers"); NFC and RFID tools follow existing switches

WHY
Tagdd+ tags "carry one unique ID across two radios" (UHF RFID for bulk reads,
NFC for tap lookup), crews "tap any carton or item with a phone to instantly
see what it is and exactly where it belongs", and the platform "reads QR codes
and legacy inventory stickers too … color, lot, and tag number", with an
upgrade path "legacy stickers → RFID → RFID + NFC". Bindex writes the item URL
to NFC tags by hand (client/src/components/NfcTagUrl.tsx) and binds one RFID
read at a time.

BUILD
1. You own the item_identifiers type CHECK constraint. Read every migration
   that touched it, then add 'nfc' and 'legacy' while keeping every existing
   type (including 'domain' if present). Keep the uniqueness index semantics
   (add 'nfc' to the unique set; 'legacy' is unique too). Update the
   IdentifierType unions on server and client.
2. Web NFC (Chrome on Android; feature-detect "NDEFReader" in window and hide
   everything elsewhere, with a one-line hint):
   - "Tap to look up": scan, read serialNumber (UID) and NDEF records; a URL
     record pointing at this instance opens that page; otherwise resolve the
     UID as an 'nfc' identifier; unknown → offer to bind.
   - "Tap to bind" on item and unit pages: binds the UID as 'nfc'.
   - "Write tag": write a URL record with the item/location URL; optional
     make-read-only after a confirm.
   - Feed tap results into the same resolution as scans (useScan().scan).
3. RFID encoding for printer-encoders and handheld writers:
   - EPC generation per item: GIAI-96 when an admin sets a GS1 company
     prefix (encode/decode per the GS1 EPC Tag Data Standard; unit-test against
     published examples), otherwise a documented private 96-bit scheme derived
     from the asset code. Show the EPC on the item page.
   - "Print and encode" in the print view: ZPL download for Zebra RFID
     printers (ZT411R/ZT421R/ZD621R) with ^RS8 and ^RFW,H writing the EPC plus
     the human-readable code and barcode; the label size follows
     LABEL_WIDTH_MM/LABEL_HEIGHT_MM. Also a CSV of code,EPC for other
     encoders. Printing through the browser stays the default; this is an
     extra download.
   - Bulk binding session: pick a list (e.g. items in a location without an
     rfid identifier), start the session, and each new tag read from a desk
     reader or the live reader feed binds to the next item in the list, with
     undo for the last binding and a skip button. Ignore tags already bound.
4. Legacy stickers: color + lot + tag number fields (colors from an
   admin-editable palette, default red, orange, yellow, green, blue, purple,
   white, black), stored as a 'legacy' identifier normalized to
   COLOR-LOT-NUMBER plus structured metadata; typing or scanning "RED 1234 056"
   or "red-1234-56" resolves it (normalize padding and separators, unit-test
   it). Items lists and container contents show a coloured dot with the tag
   number. Allow fast sequential entry: after saving one item, the next tag
   number is pre-filled.
5. Tag tier badge on every item: none / barcode-QR / legacy / RFID / RFID+NFC,
   with an "upgrade" action pointing to bind flows, and a report "items by tag
   tier" per location so a site can see its RFID coverage.
6. docs/tag-commissioning.md: supported phones/browsers, tag types (NTAG213/
   215/216, dual-frequency chips such as EM4425), EPC schemes, ZPL notes,
   and the legacy sticker workflow.

ACCEPTANCE
- Migration keeps every existing identifier valid on a database restored from
  a current backup.
- GIAI-96 encode/decode round-trips published examples.
- Legacy sticker normalization tests cover spacing, case, padding.
- Bulk binding binds N distinct tags to N items in order and never rebinds a
  tag already in use.
```

### T08 — Offline field mode

```text
FEATURE T08: Offline field mode for warehouses and job sites
slug: offline-field   branch: claude/tagdd-t08-offline-field   base: main
migration: 0029 (only if you need server tables; otherwise leave the number unused)
port: 3108   feature switch: offline ("Work offline on this device")

WHY
Tagdd+ ships a crew mobile app used inside trucks, basements and steel
warehouses. Bindex is an installable PWA (client/public/sw.js) that caches only
the shell and always sends /api to the network, so a scan in a dead zone
fails.

BUILD
1. Offline read cache: on demand ("Make available offline" per location
   subtree or job, or a whole small instance), store items, units,
   identifiers, locations and asset codes in IndexedDB (write a small typed
   wrapper; no heavy dependency). Scans resolve locally when offline and show
   a clear OFFLINE badge with the cache age.
2. Offline write queue for the actions field staff do: scan-to-verify, move
   item to location, check-out/check-in, spot check, audit apply, add note or
   photo (photo bytes stored in IndexedDB until sent). Each queued action has
   a client-generated idempotency key.
3. Server idempotency: accept an Idempotency-Key header on those POST/PATCH
   routes (a tiny middleware you add, storing key → response for 24h in an
   idempotency_keys table from your migration), so a retried sync never
   applies twice. Apply it by wrapping routes at mount time in your own file
   rather than editing each route, if possible; otherwise keep edits to one
   line per route.
4. Sync: Background Sync API where available, otherwise retry on 'online'
   and on app focus; oldest first; conflicts (item moved or deleted since the
   cache) are shown in a "Needs attention" list with keep-mine / keep-server
   choices; never silently drop an action.
5. Service worker: keep "never serve stale /api as current"; add a versioned
   cache for built assets so the app opens offline; show "update available".
6. A device-level settings panel: cache size, last sync, queued actions,
   clear cache.
7. docs/offline-field.md, including what does not work offline.

ACCEPTANCE
- With the network cut in Chromium DevTools (Playwright offline mode), scan
  a cached code, move it, check it out, reconnect, and see exactly one of each
  change on the server.
- Replaying the same queued request twice changes nothing the second time.
- Unit tests for the queue ordering and conflict rules.
```

### T09 — BLE beacons, gateways and room-level presence

```text
FEATURE T09: BLE beacons, gateways and room-level presence
slug: ble   branch: claude/tagdd-t09-ble   base: claude/tagdd-feature-parity-igoea3
migration: 0030   port: 3109   feature switch: ble ("Bluetooth beacons")
Depends on T01 (tracking core) already merged into your base: use
tracking_devices, sightings, asset_positions, recordSightings, requireDevice.

WHY
Tagdd+ "BLE beacons (AirTag-style) extend visibility to equipment and
materials on the job and in the warehouse", "BLE room beacons" enable
"room-level BLE matching", and vaults are "tracked with GPS or BLE tags".

BUILD
1. Two deployment patterns, both first-class:
   A. Fixed gateways, mobile tags: BLE gateways (kind ble_gateway, installed
      in a zone) report advertisements from asset tags (kind ble_tag,
      attached to an item/unit/vault). The asset's zone is decided from RSSI.
   B. Fixed room beacons, mobile phone: room beacons (kind ble_beacon, one
      per room/dock/zone) and a phone running a scanner report which beacons
      it hears; the phone's user is placed in that room so scans on that phone
      default to that room (useful for placement, T11).
2. Advertisement parsing (pure, unit-tested with byte fixtures): iBeacon
   (UUID/major/minor/tx power), Eddystone-UID, -URL, -TLM (battery voltage,
   temperature), AltBeacon, and raw MAC-only. Normalize a tag identity as a
   stable string (ibeacon:<uuid>:<major>:<minor>, eddystone:<ns>:<inst>,
   mac:<AA:BB:…>). Battery from TLM updates tracking_devices.battery_pct.
3. Gateway ingest adapters (token-auth, mounted under /api/device like T01):
   generic JSON, and documented formats for common gateways: Minew G1 / MG3
   (JSON array with mac, rssi, rawData, timestamp), Ingics/iGS, and
   Kontakt.io-style or Teltonika TCP-to-HTTP forwarders where their JSON is
   documented. Parse from vendor docs; label as unverified on hardware.
   Optional MQTT subscription (BLE_MQTT_URL, topic pattern) using the mqtt
   package only if configured; otherwise not loaded.
4. Zone presence engine (pure core + thin persistence): per tag, keep a short
   window of RSSI per gateway, smooth (EWMA or median), apply a per-gateway
   RSSI offset for calibration, pick the strongest zone, and change zone only
   when the new zone beats the current by a hysteresis margin for N seconds
   (defaults configurable). "Missing" when not heard for T minutes. Persist
   through recordSightings so positions, events and moves work as in T01.
   Unit-test flapping between two rooms, hysteresis, and timeouts.
5. Reference gateway: bridge/ble_gateway.py using bleak, running on a
   Raspberry Pi, batching advertisements to /api/device/reads (tech ble)
   with its device token; README section like bridge/README.md.
6. Phone path: Web Bluetooth scanning is not generally available, so provide
   the reference gateway as the phone-less path and, for phones, a documented
   endpoint that a native companion or Android beacon scanner app can post to
   (room beacons heard → current room for that user, expiring after a few
   minutes). Expose GET /api/ble/me/room for the client to prefill locations.
7. UI: register tags/beacons/gateways (extend T01's device screens with BLE
   fields: UUID/major/minor, tx power, RSSI offset), "Calibrate zone" helper
   that records RSSI while a tag sits in a room, a zone occupancy view
   (what is in each room now), equipment "not seen in X hours" list, battery
   low list, and item detail showing BLE presence.
8. Alerts: tag left its zone out of hours, tag missing, battery low → publish
   events via T04 publish() and notify() digests.
9. docs/ble.md: hardware choices, placement, calibration, limits of RSSI
   room-level accuracy (be honest: adjacent rooms can confuse; more gateways
   help).

ACCEPTANCE
- A simulated stream of gateway reports moves a tag from Dock A to Aisle 3
  exactly once despite RSSI noise, and marks it missing after the timeout.
- Parsers pass byte-level fixtures for every format above.
```

### T10 — GPS trackers, maps and geofences

```text
FEATURE T10: GPS trackers, maps and geofences
slug: gps   branch: claude/tagdd-t10-gps   base: claude/tagdd-feature-parity-igoea3
migration: 0031   port: 3110   feature switch: gps ("GPS tracking")
Depends on T01 (devices, sightings, positions), T03 (shipments), T04 (publish).

WHY
Tagdd+: "single-use GPS trackers give customers real assurance — they can see
exactly where their belongings are throughout the move", "live transit
visibility", "vaults tracked with GPS", and customers "receive updates when
their shipment arrives at key locations on its journey, just like major
shipping and logistics companies".

BUILD
1. Ingest (token-auth under /api/device): OsmAnd/Traccar client protocol
   (HTTP GET/POST with id, lat, lon, timestamp, speed, bearing, altitude,
   accuracy, batt), Traccar server event/position forwarding JSON, and a
   generic JSON batch. This makes any Traccar-supported hardware tracker
   usable via a Traccar server, and phones via the Traccar Client app. Store
   as sightings (tech gps) with lat/lng/accuracy/speed/heading; update the
   device and the attached asset's position. Reject impossible jumps
   (configurable max speed) and out-of-order points without breaking history.
2. Geofences: table geofences (name, kind circle|polygon, geometry as jsonb
   GeoJSON, radius_m, location_id link so a warehouse/site location has a
   fence, active). Point-in-polygon and haversine in pure TypeScript (no
   PostGIS; unit-tested, including antimeridian-safe distance). Enter/exit
   detection with a dwell/debounce, recorded as geofence_events and
   published (T04) as geofence.entered / geofence.exited. When a fence is
   linked to a location, an attached asset entering it may update its
   location if the device has updates_location.
3. Shipments (T03): link a tracker to a shipment (or to its vehicle
   location); compute distance travelled, remaining straight-line distance
   and a simple ETA from recent average speed; set shipment in_transit on
   leaving the origin fence and prompt delivered on entering the destination
   fence. Milestones are published so T15 can notify stakeholders.
4. Map UI: Leaflet (add dependency) with OpenStreetMap tiles by default and a
   MAP_TILE_URL / MAP_ATTRIBUTION override for self-hosted or commercial
   tiles; update the helmet CSP imgSrc/connectSrc in server/src/index.ts
   minimally to allow the configured tile host. Screens: live map of all
   trackers, per-asset trail with time slider, shipment map with fences,
   geofence editor (draw circle/polygon).
5. Single-use tracker lifecycle: assign to a shipment, auto-unassign on
   delivery, "return/dispose" status, battery warnings.
6. docs/gps.md: Traccar setup, supported protocols, privacy (retention,
   who can see locations), tile provider notes.

ACCEPTANCE
- Replaying a recorded GPX-like fixture through the OsmAnd endpoint produces a
  trail, one exit from the origin fence, one entry to the destination fence,
  a shipment moving to in_transit then prompted delivered, and events.
- Geometry functions are unit-tested with known coordinates.
```

### T11 — Room-based placement guidance

```text
FEATURE T11: Room-based placement guidance and delivery matching
slug: placement   branch: claude/tagdd-t11-placement   base: claude/tagdd-feature-parity-igoea3
migration: 0032   port: 3111   feature switch: placement ("Placement guidance")
Depends on T01 (sightings, devices, zones) and T03 (jobs, job_items with
destination_location_id, advanceStage).

WHY
Tagdd+: "Readers direct crews to the correct room based on where each item was
tagged at pack-out — and flag anything missing or on the wrong shipment", "every
box in the truck, tracked to the room it belongs in", with "live scan and
delivery-placement progress bars".

BUILD
1. Destination rules: when a job has none set, propose destinations from
   origin (same department/room name mapping, or a mapping table origin room →
   destination room editable per job); bulk apply.
2. "Where does this go?" mode for the delivery crew: scan (barcode, NFC,
   desk RFID, camera) and get a full-screen card: destination room/desk,
   floor, department, big colour band per floor, handling notes, and a
   "Placed here" button. Wrong-job and wrong-shipment scans get a loud red
   card and sound.
3. Room confirmation: a fixed or handheld reader in a room (T01 device with
   location = that room) or a BLE room presence (if T09 exists at runtime;
   otherwise skip) marks items read there as placed if that room is their
   destination, or as misplaced with the actual room otherwise. Handheld
   sweep mode: pick the room, sweep, see "belongs here: 34/36, extra: 2
   (belong in 3.14)".
4. Progress: per job, per floor, per room placement progress bars and a
   remaining list; a "missing after delivery" list once the shipment is
   delivered.
5. Kiosk view for a tablet on a tripod at a floor entrance (door-portal
   setup): large list of what just passed and where each goes, auto-updating
   from the live feed.
6. docs/placement.md.

ACCEPTANCE
- Scans and reader sweeps produce placed/misplaced/wrong-shipment outcomes
  consistent with job_items and are recorded via T03's stage history.
- Pure matching logic is unit-tested.
```

### T12 — AI container capture and condition records

```text
FEATURE T12: AI container capture and condition records
slug: ai-condition   branch: claude/tagdd-t12-ai-condition   base: claude/tagdd-feature-parity-igoea3
migration: 0033   port: 3112   feature switch: aiCondition ("AI condition and container capture")
Depends on T02 (attachments, visionJson, AttachmentGallery).

WHY
Tagdd+ "AI Box Capture: photographs box notes and auto-attaches contents to
the inventory. Identifies box size (small, medium, large, wardrobe, dish pack)
and item categories, descriptions, and condition", "OCR reads handwriting on
boxes — room, contents, 'fragile'", "condition documentation … before and
after", and "AI writes the handling note — 'handle with care to prevent
further scratching'".

BUILD
1. Container capture: from a container item (or a new one), take 1–4 photos
   (outside with handwriting, open top). visionJson returns { sizeClass
   (configurable list, defaults small, medium, large, wardrobe, dish pack,
   plus tote, pallet, crate for warehouses), handwrittenText, room,
   contentsSummary, contents: [{ name, category, qty, condition, fragile }],
   flags: fragile|this side up|high value, confidence }. The user edits and
   then creates child items inside the container in one step (reuse item
   creation; parentItemId = the container), stores photos as attachments
   with stage "pack".
2. Condition records: table condition_reports (item_id/unit_id, stage
   before|after|inspection|custom, rating excellent|good|fair|poor|damaged,
   notes, ai_notes, defects jsonb [{ area, type scratch|dent|gouge|stain|
   crack|loose|missing_part|other, severity, description }], handling_note,
   attachment ids, created_by, created_at). "Assess condition with AI" from
   photos fills a draft the user confirms. Before/after comparison view
   side-by-side with new defects highlighted (AI compare of the two sets
   plus a deterministic diff of defect lists).
3. Handling notes surface on item overlays, manifests (T03 PDF if present;
   add a hook rather than editing T03 files heavily), and placement cards.
4. Bulk "condition sweep": walk a location, scan each item, snap a photo,
   AI suggests rating and notes, next.
5. docs/ai-condition.md with prompt design notes and how to tune categories.

ACCEPTANCE
- With vision unconfigured, manual condition reports still work and AI
  buttons are hidden.
- Fixture-based tests for parsing and normalizing AI replies, and for the
  defect diff.
```

### T13 — Pre/post facility inspections

```text
FEATURE T13: Pre- and post-move facility inspections
slug: inspections   branch: claude/tagdd-t13-inspections   base: claude/tagdd-feature-parity-igoea3
migration: 0034   port: 3113   feature switch: inspections ("Site inspections")
Depends on T02 (attachments, visionJson, SignDialog) and T03 (jobs, tasks
pre_inspection/post_inspection).

WHY
Tagdd+ "treats the property itself as something to inventory, with a
Pre-Inspection Survey before the move starts and a Post-Inspection Survey once
it's done." Flow: inside/outside → one photo → AI identifies "the room, the
exact spot (wall, baseboard, trim, door), and a plain-English description" →
editable → save; "Same Location → Room → Locations → Details flow runs twice",
producing "before/after comparisons and shareable reports". For commercial
sites: dock doors, corridors, elevators, floors, walls in the origin and
destination facilities.

BUILD
1. inspections (job_id?, location_id (site), kind pre|post|adhoc, status
   draft|completed|signed, started_by, completed_at) and inspection_findings
   (inspection_id, area inside|outside, room text + location_id?, spot
   (wall, floor, baseboard, trim, door, frame, ceiling, window, elevator,
   dock, stairs, fixture, other), description, severity, ai_generated bool,
   pre_existing bool, attachment ids).
2. "Add damage by AI": one photo → visionJson returns room guess, spot,
   description, severity; the user can change any field; "Enter manually"
   is always available.
3. Post vs pre comparison: pair findings by room+spot (and AI similarity when
   available) into unchanged, new, worsened, resolved; the report makes new
   damage obvious.
4. PDF report: cover (site, job, dates, inspectors), findings by room with
   photos, comparison section, signatures (SignDialog: facility contact and
   crew lead). Shareable read-only link via a signed, expiring URL (no login).
5. Job integration: completing the inspection completes the matching job task.
6. docs/inspections.md.

ACCEPTANCE
- A full pre/post cycle on a job produces a PDF with the comparison and both
  signatures; the share link works logged-out and expires.
- Pairing logic unit-tested.
```

### T14 — Chain of custody and digital sign-off

```text
FEATURE T14: Chain of custody and digital sign-off
slug: custody   branch: claude/tagdd-t14-custody   base: claude/tagdd-feature-parity-igoea3
migration: 0035   port: 3114   feature switch: custody ("Chain of custody")
Depends on T02 (signatures, SignDialog), T03 (jobs, shipments, job_items),
T04 (publish, audit log).

WHY
Tagdd+ Commercial: "Chain of custody for sensitive files — every box of
documents gets a timestamped, auditable trail from origin to destination —
important when compliance is on the line." Movers: "Customers sign and
validate inventories … directly on their own device" and at delivery "the
customer checks the full item list — including anything flagged with damage —
against what was delivered, then signs … Timestamped, dated, and stored
automatically." Vaults keep "full chain of custody, even after the truck is
unloaded."

BUILD
1. Custody model: custody_transfers (from_party, to_party as entity or user or
   free-text external party with name/org, at, place location_id and lat/lng
   if known, items: list of item/unit ids scanned, seal numbers,
   condition_note, signature ids for both parties, content_hash of the item
   list). A custody chain per item is the ordered list of transfers; show it
   on item detail, and "current custodian".
2. Sensitive-item policy: mark items or containers as custody-controlled
   (metadata flag); moving, checking out or delivering them without a custody
   transfer is blocked with a clear message (enforce in your own service; add
   the smallest possible hook in T03's advanceStage only if unavoidable, and
   say so in the PR).
3. Handoff flow: scan items (bulk capture), confirm the count, both parties
   sign on one device (or the receiving party signs on theirs via a one-time
   link), seal numbers captured, PDF receipt generated with the item list,
   hashes and signatures, published to the audit log.
4. Delivery sign-off (review and sign): for a shipment, the receiving party
   sees every line with photos and damage flags, marks exceptions (missing,
   damaged, refused), and signs; exceptions become job_item stages and can be
   turned into a claim later (T16 will link).
5. Verification: a receipt page shows whether the signed content still
   matches (verifySignature) and the audit-log entry id.
6. docs/custody.md.

ACCEPTANCE
- A controlled container cannot be delivered without a transfer; with one, the
  item's chain shows each hop with signatures and the PDF verifies.
- Changing an item list after signing makes verification fail visibly.
```

### T15 — External portal: stakeholders and third-party crews

```text
FEATURE T15: External portal for stakeholders and third-party crews
slug: portal   branch: claude/tagdd-t15-portal   base: claude/tagdd-feature-parity-igoea3
migration: 0036   port: 3115   feature switch: portal ("External portal")
Depends on T01 (positions), T02 (attachments), T03 (projects, jobs,
shipments), T04 (events for milestones).

WHY
Tagdd+ gives every shipper their own portal: "shipment ID, weight, distance,
and delivery estimate — live, without calling dispatch", inventory "searchable
by room, item name, tag number, or condition" with "live scan and
delivery-placement progress bars" and "high-value and condition-noted items
flagged automatically"; plus "assign inventory to a 3rd party — any moving
company can use Tagdd+ to inventory a shipment at destination. Assign their
driver and get a full digital inventory, origin to destination". Commercial
equivalents: the client's facilities manager, an IT asset owner, a
subcontracted crew.

BUILD
1. Access grants: portal_grants (scope: project | job | shipment, role viewer
   | contributor, grantee name/email/org, token hash, expires_at, revoked_at,
   last_used_at, created_by). Links are https://<host>/p/<token>; tokens are
   long random, stored hashed; optional email one-time code before first use.
   Rate-limit with lib/rateLimit. Every access is logged (T04 publish).
2. Public server routes mounted before the session guard (/api/portal/…),
   strictly limited to the granted scope; never expose other jobs, users,
   costs unless the grant allows values.
3. Client: routes under /p/:token rendered outside the sign-in Gate (edit
   App.tsx Gate minimally), branded with the instance name/colour, mobile
   first. Viewer sees: timeline of milestones (created, packed, loaded, in
   transit, arrived, delivered, placed) from T03 stages and T04 events;
   shipment facts (code, weight, volume, distance, ETA, last known position
   and time); searchable inventory by room/destination, name, tag, condition
   with progress bars; flagged items (high value, condition notes) with
   photos; documents and signed receipts shared to them.
4. Contributor (third-party crew) can: scan items to a stage on their granted
   shipment/job only (camera scanner and manual code entry; reuse the camera
   component), add photos and condition notes, sign a handoff. Everything
   they do is attributed to the grant, not to a user.
5. Notifications: optional SMTP (SMTP_URL, SMTP_FROM; nodemailer only if
   configured, degrade quietly) sending milestone emails to viewers who opted
   in: departed, arrived at key locations (T10 geofence events when present),
   delivered. Throttle and de-duplicate.
6. Admin UI to create, list, revoke grants and see access logs.
7. docs/portal.md including a threat model section.

ACCEPTANCE
- A viewer link shows exactly one shipment and nothing else (tests for scope
  enforcement on every portal route); an expired or revoked link fails
  closed.
- A contributor link can advance only its own shipment's lines.
```

### T16 — Claims and incidents

```text
FEATURE T16: Claims and incident center
slug: claims   branch: claude/tagdd-t16-claims   base: claude/tagdd-feature-parity-igoea3
migration: 0037   port: 3116   feature switch: claims ("Claims and incidents")
Depends on T02 (attachments) and T03 (jobs, job_items); uses T12 condition
reports and T14 delivery exceptions when those tables exist at runtime
(detect them; do not import their code).

WHY
Tagdd+: "Every claim pulls in the pack-day condition notes and photos
automatically — customers aren't reconstructing what happened from memory",
a Claims Center with claim number, type, status (Under Review) and estimated
total, "evidence you can hand straight to a claims adjuster".

BUILD
1. claims (code CLM-…, type loss|damage|property_damage|delay|other,
   status draft|submitted|under_review|approved|denied|paid|closed,
   job_id?, shipment_id?, reporter (user or portal grant), description,
   estimated_total_cents, approved_total_cents, carrier/insurer reference) and
   claim_lines (item_id/unit_id?, description, damage description,
   estimated_cents, approved_cents, resolution repair|replace|cash|deny).
2. Evidence auto-assembly: for each line, pull the item's condition history,
   stage history with timestamps, custody hops, attachments by stage
   (before/after) and audit-log ids into a read-only evidence pack.
3. Workflow: status transitions with required notes, assignment to a
   reviewer, comments, SLA timer, and events published.
4. Exports: adjuster-ready PDF (summary, lines, per-line evidence with
   photos, timeline) and XLSX.
5. Incident reports (no money involved: near misses, site damage,
   equipment failure) share the same screens with type incident.
6. Portal hook: if T15's grant tables exist, let a viewer file a claim on
   their shipment (feature-detect at runtime).
7. docs/claims.md.

ACCEPTANCE
- Creating a claim from a delivered, damaged job line shows its pack-day
  photos and condition notes without any manual attaching.
- Totals and transitions are unit-tested.
```

### T17 — Documents and conditional packets

```text
FEATURE T17: Documents, templates and conditional packets
slug: documents   branch: claude/tagdd-t17-documents   base: claude/tagdd-feature-parity-igoea3
migration: 0038   port: 3117   feature switch: documents ("Documents")
Depends on T02 (signatures, attachments) and T03 (job types, jobs).

WHY
Tagdd+ Dashboard v1.1.1 (2026-09-24): "a brand new documents management page
with support for document packets", "interactive document form filling, draft
copying, and custom field creation", "customizable move and job types", and
"conditional document packets based on specific job and move types".

BUILD
1. Templates: document_templates (name, version, body as structured blocks:
   heading, paragraph with {{merge.fields}}, custom field inputs (text,
   number, date, checkbox, select, signature, initials), tables bound to job
   data such as the manifest) and custom_fields definitions reusable across
   templates. Versioning: editing a published template creates a new version;
   filled documents keep the version they used.
2. Packets: document_packets (name, ordered templates, conditions: job type
   in [...], project, phase, site, custom rule on job fields), auto-attached
   to a job when it is created or its type changes.
3. Filling: documents (template version, job_id, status draft|completed|
   signed, values jsonb, created_by) with autosave, "copy from previous
   draft", required-field validation, signature fields via SignDialog.
4. Rendering: PDF with pdf-lib (merge fields resolved, tables, signatures,
   audit footer with document id and content hash). Share via T15 portal when
   present (feature-detect).
5. Admin template editor (block list editor, no rich-text dependency unless
   small), preview with a sample job.
6. docs/documents.md.

ACCEPTANCE
- A job of type "IT relocation" automatically gets its packet; filling,
  signing and exporting produces a PDF whose hash is recorded and verifies.
- Condition evaluation and merge-field resolution are unit-tested.
```

### T18 — Crew check-in and credentials

```text
FEATURE T18: Crew check-in and credentials
slug: crew   branch: claude/tagdd-t18-crew   base: claude/tagdd-feature-parity-igoea3
migration: 0039   port: 3118   feature switch: crew ("Crew check-in")
Depends on T03 (jobs, job tasks).

WHY
Tagdd+ Crew Check-In: "Tap Add Crew, choose Scan QR, and scan the badge … The
scan checks the crew member in on the job and reports their CID status
automatically … If someone's CID isn't active, that shows up here too, before
they're on the truck." Industrial sites need the same for site inductions,
forklift licences, background checks and safety training.

BUILD
1. workers (name, company/subcontractor, badge_code unique, photo attachment
   if T02 present, phone, active) and credentials (worker_id, type from an
   admin list such as background check, forklift, site induction, OSHA 10,
   DOT medical; issuer, number, issued_on, expires_on, status, document
   attachment). Printable badge with QR (reuse bwip-js and the print
   pipeline style).
2. Check-in: on a job, "Add crew" → scan badge QR (armCapture or camera) or
   search; shows compliance at a glance (green/amber/red per required
   credential; required credentials configured per job type); block or
   warn per job-type policy with an override reason; check-out at end of
   shift; hours per worker per job.
3. External verifier hook: optional CREDENTIAL_VERIFY_URL called with the
   badge code, merging returned statuses (degrades quietly), so a provider
   like a background-check service can be plugged in.
4. Expiry: daily digest of credentials expiring within N days (notify()),
   worker list filters.
5. Roster and timesheet export (XLSX) per job and date range.
6. docs/crew.md.

ACCEPTANCE
- Scanning a badge with an expired required credential shows red and blocks
  (or warns, per policy); overriding records who and why.
- Compliance evaluation is unit-tested.
```

### T19 — Valuation, high-value declarations, receipts and warranty

```text
FEATURE T19: Valuation, high-value declarations, receipts and warranty
slug: valuation   branch: claude/tagdd-t19-valuation   base: claude/tagdd-feature-parity-igoea3
migration: 0040   port: 3119   feature switch: valuation ("Valuation and warranty")
Depends on T02 (visionJson, attachments, SignDialog) and T04 (publish).

WHY
Tagdd+: "Point a camera at it. AI pulls the item, the model, and the value …
identifies the brand, model, materials, and condition, then estimates a
declared value — turning a tedious manual form into a scan-and-confirm-and-sign
flow"; "each declaration becomes a signed, dated record"; "receipt matching —
photograph a receipt and Tagdd+ links it to the right item automatically";
"purchase date, manufacturer, and dimensions saved per item"; "insurance-ready
documentation, valued and organized". The README roadmap lists "warranty and
service intervals, with reminders".

BUILD
1. AI valuation: photo(s) → visionJson { brand, model, materials, condition,
   description, estimatedValue { low, high, currency, basis } }, optionally
   cross-checked with the existing web price lookup
   (server/src/services/enrichment/pricing.ts) when configured. The user
   confirms; value lands in valueCents with a valuation record (source,
   date, basis, confidence) kept as history.
2. High-value declarations: declarations (code HVI-…, scope job/location/
   company, items with declared values, total, status draft|signed, signed
   via SignDialog, PDF). Threshold setting marks items as high value
   automatically.
3. Receipts: photo or PDF of a receipt → visionJson { vendor, date, lines
   [{ description, qty, unitPrice, sku, serial }], total, tax, currency } →
   proposed matches to existing items (by serial, model, name similarity) →
   confirm → purchase date, price, vendor, receipt attachment stored per item.
4. Warranty and service: warranty end date and terms per item/unit;
   service intervals (every N days or N hours of use) with next due; daily
   digest of warranty expiring and service due via notify() and events.
5. Insurance/asset valuation report: PDF and XLSX by location/room/company
   with photos, serials, purchase date, value, depreciation (straight-line,
   configurable life per category).
6. docs/valuation.md with a clear note that AI estimates are estimates.

ACCEPTANCE
- Receipt fixture parsing and item matching unit-tested; valuation history
  preserved; declarations sign and verify.
```

### T20 — Teardown video to reassembly guide

```text
FEATURE T20: Teardown video to reassembly guide
slug: teardown   branch: claude/tagdd-t20-teardown   base: claude/tagdd-feature-parity-igoea3
migration: 0041   port: 3120   feature switch: teardown ("Teardown guides")
Depends on T02 (attachments with large-file disk storage and Range streaming,
transcribe, visionJson).

WHY
Tagdd+ Video Disassembly: record in-app or choose a video from the library
(e.g. AirDropped by another crew member), "narrate while you work", and it
"turns narration into numbered steps … each step paired with the exact clip it
came from", keeps a "running Parts Detached list, tagged as Furniture or
Hardware", carries "flagged callouts" (e.g. "14 screws total"), travels with
the item ("View Video"), and exports "a clean disassembly report to print or
share". Industrial equivalents: racking, workstations, lab and server
equipment, machinery relocation.

BUILD
1. Attach a teardown video to an item or unit (record via
   <input capture> or pick from library), stored through T02.
2. Processing job (in-process queue, resumable, status visible): extract
   audio with ffmpeg if available on PATH (document installing it in the
   Docker image; add it to the Dockerfile) → transcribe with timestamps →
   language model turns segments into steps [{ n, title, instruction, start,
   end, callout? }] and parts [{ name, kind hardware|component|cable|other,
   qty, stepN }] (chatJson); optionally grab a keyframe per step with ffmpeg
   and let visionJson refine part names. Everything degrades: no ffmpeg or no
   STT → the video is still attached and steps can be written manually.
3. Guide screen: numbered steps with timestamps that seek the video,
   callouts highlighted, parts list with check-off at reassembly (reverse
   order view), edit any step or part.
4. Export: PDF report (steps, callouts, parts, keyframes) and a share link
   (via T15 if present).
5. Parts bag labels: print labels for hardware bags linked to the item
   (reuse the print pipeline) so "no missing hardware".
6. docs/teardown.md with provider and ffmpeg setup.

ACCEPTANCE
- With a short sample video and a stubbed transcription reply (fixture), the
  pipeline yields steps and parts; with no provider configured the item still
  gets its video and manual steps.
- Step/part extraction parsing unit-tested with fixtures.
```

### T21 — AI bulk capture: walkthroughs and paper manifests

```text
FEATURE T21: AI bulk capture — walkthroughs and paper manifests
slug: bulk-capture   branch: claude/tagdd-t21-bulk-capture   base: claude/tagdd-feature-parity-igoea3
migration: 0042   port: 3121   feature switch: bulkCapture ("AI bulk capture")
Depends on T02 (visionJson, attachments).

WHY
Tagdd+: "Full-room inventory in seconds — walk through with your phone, Tagdd+
catalogs everything", "box-level inventory — scan a packed box, get an
itemized list", "office- and desk-level inventory — workstations, monitors,
chairs, logged individually", and the "AI-assisted inventory converter: turn a
paper-based inventory into a digital inventory automatically — regardless of
how it arrived".

BUILD
1. Walkthrough capture: pick a location (room/floor), take a series of
   photos (or a short video; sample frames server-side with ffmpeg if
   present, else photos only). visionJson per image returns detected items
   [{ name, category, brand?, model?, qty, bbox?, confidence }]. Merge
   duplicates across overlapping photos (same category + similar name + same
   room; keep it conservative and explain merges). Output is a draft list the
   user reviews (edit, merge, split, delete) before anything is created.
2. Desk-level mode for offices: per desk/workstation, expect monitor(s),
   dock, chair, pedestal; flag missing expected items per a template.
3. Paper/PDF manifest converter: upload photos or a PDF of a paper inventory
   (render PDF pages to images with pdf-lib is not possible; use a
   pdfjs-dist or poppler (pdftoppm) path if available, else accept images
   only and say so) → visionJson extracts rows { lineNo, description,
   qty, condition codes, sticker color/lot/number (T07 legacy tags if present),
   room } → draft list → create items and, optionally, add them to a job (T03
   if present, feature-detect).
4. Draft sessions persist (capture_sessions, capture_drafts) so a long
   walkthrough survives a refresh; every created item links back to its
   source photo attachment.
5. Cost guard: show the number of images to be analysed; a per-session cap
   setting.
6. docs/bulk-capture.md.

ACCEPTANCE
- Fixture AI replies for three overlapping photos yield a merged, editable
  draft; nothing is created until the user confirms.
- Merge logic and manifest row parsing unit-tested.
```

### T22 — Operations intelligence

```text
FEATURE T22: Operations intelligence — anomalies, dwell time, load planning
slug: ops-intel   branch: claude/tagdd-t22-ops-intel   base: claude/tagdd-feature-parity-igoea3
migration: 0043   port: 3122   feature switch: opsIntel ("Operations insights")
Depends on T01 (sightings, positions) and T03 (jobs, shipments, job_items).

WHY
Tagdd+ on AI in operations: "detect missing cartons, flag duplicate entries,
and identify inconsistencies between packing, loading, and delivery — catching
issues in real time"; "by predicting total volume and weight, AI can optimize
truck space and suggest loading sequences"; "in storage environments, AI
tracks how long items have been stored, predicts retrieval times, and helps
optimize warehouse layouts".

BUILD (deterministic first; language model only for explanations)
1. Anomaly rules engine (pure, unit-tested), run on a schedule and on demand,
   results in anomalies (rule, severity, subject, detail, first_seen,
   resolved_at, resolved_by):
   - packed but never loaded; loaded but not delivered after shipment
     delivered; delivered but not placed after N hours
   - duplicate records (same serial/model/name in same location; identifiers
     differing only by formatting)
   - sighted in two distant zones within an impossible time
   - item's last sighting zone ≠ its recorded location for > N hours
   - asset not seen by any reader for > N days while marked active
   - job_items on two open shipments
   Each anomaly links to the fix screen; resolving records who and why;
   events published when T04 is present.
2. Dwell time and storage analytics: time in location from positions/
   events; per-zone occupancy and turnover; items stored longer than a
   threshold; retrieval frequency; ABC classification by movement count.
3. Slotting suggestions: fast movers far from dock/pick zones (zones get an
   optional distance-to-dock value) → suggest swaps; explain the rule.
4. Load planning: volume and weight per item (from metadata, category
   defaults, or dimensions), shipment totals vs vehicle capacity (vehicle
   location metadata: max kg, max m³, interior L×W×H); first-fit-decreasing
   packing across vehicles with a stop-order-aware loading sequence (last
   delivered, first loaded); printable load plan. Keep the algorithm simple,
   documented and tested; no 3D bin-packing claims.
5. Dashboard page "Insights" with counts, trends and the anomaly queue.
6. docs/ops-intel.md listing every rule and its thresholds.

ACCEPTANCE
- Every rule has a fixture test producing and resolving an anomaly.
- The load planner never exceeds capacity and respects stop order in tests.
```

## 5. Integration notes

- Merge order into `claude/tagdd-feature-parity-igoea3`: T01–T04 first (wave 2
  starts from that), then wave 2 in any order, then T05–T08.
- Expected textual conflicts are all append-only lists: `schema.ts` export
  lines, `routes/api.ts` mounts, feature switch lists, `backup.ts` TABLES,
  `.env.example`, `App.tsx` routes, `Layout.tsx` links. Keep both sides.
- After everything lands: bump `BACKUP_VERSION` once, write the CHANGELOG
  entry, add the new features to the README, link each `docs/<slug>.md` from
  the README Documentation list, and unify the two batch code resolvers from
  T01 and T03 into one module.
