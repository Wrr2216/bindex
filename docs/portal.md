# External portal: stakeholders and third-party crews

A **portal link** lets someone without a Bindex account follow, or work on,
one project, job or shipment:

- a **viewer** link is for the customer, the client's facilities manager or an
  IT asset owner. It shows a milestone timeline, the shipment's facts (code,
  weight, volume, distance, ETA, last known position), the inventory searchable
  by room, name, tag and condition with progress bars, flagged items with their
  photos, and the documents and signed receipts shared with it;
- a **crew** (contributor) link is for a subcontracted mover or another
  company's driver. On top of what a viewer sees, the crew can scan their own
  lines to a stage (camera, handheld reader or typed codes), add condition
  notes and photos, and sign a handoff. Everything they do is recorded against
  the link, never against a user.

Links look like `https://inventory.example.com/p/bdxp_…`. The token is 32
random bytes, shown once when the link is made, and stored only as a hash.
Every request re-reads the link, so revoking one, or reaching its expiry, stops
it on the next request.

Everything here is behind one instance switch, **External portal**
(`features.portal`, stored as `features.portal` in `app_settings`), off by
default. With it off the Portal screen and its navigation entry are gone,
`/api/portal/*` answers `404 portal_unavailable` for every link, and
`/api/portal-grants/*` answers `404 feature_disabled`. It is built on
projects, jobs and shipments, so switch those on too.

Contents: [Using it](#using-it) · [What a link can see](#what-a-link-can-see) ·
[Crew links](#crew-links) · [Emailed codes](#emailed-codes) ·
[Milestone emails](#milestone-emails) · [HTTP API](#http-api) ·
[Events](#events) · [Data model](#data-model) · [Backups](#backups) ·
[Configuration](#configuration) · [Threat model](#threat-model) ·
[For other features](#for-other-features) · [Testing](#testing) ·
[Code map](#code-map)

## Using it

Administrators only, from **Portal** in the navigation:

1. **New link**. Search for the project, job or shipment by code or name.
2. Choose what they can do: **view**, or **work on it as a crew** (crew links
   cover one job or one shipment, never a whole project).
3. Name the person or company, and optionally their organisation and email.
4. Pick when it stops working (30 days by default, at most 400).
5. Options:
   - **Share documents and signed receipts** (on by default): files and
     signatures filed on the shared record (see below).
   - **Show values**: item values; off by default, and when off no value is
     ever sent to the browser. High-value items are flagged either way.
   - **Ask for an emailed code on each new device** (needs an email address and
     SMTP).
   - **Email them milestones** (needs an email address). The person can switch
     this off, or on, from the portal page.
   - For crew links, **the stages they can scan to** (packed, loaded, delivered,
     placed, damaged and missing by default).
   - A note for staff, never shown on the portal.
6. **Make link**. The link and a QR code are shown once. Copy it, show the QR
   to a driver, or tick **Email the link to them now**.

Opening a link from the list shows its settings (all editable), **Revoke**
(stops it at once), **Issue a new link** (replaces the token; the old one stops
at once and every verified device has to enter a code again), the files it
shares (add documents there), the crew's notes, and its **access log**: every
visit, refusal, scan, note, photo, signature and change, from the audit log.

## What a link can see

A link is scoped to exactly one record. The server loads that scope on every
request and holds every query to it.

| Scope | Lines (manifest) | Shipments | Shared files and signatures |
| --- | --- | --- | --- |
| Shipment | lines currently on that shipment | that one | filed on the shipment |
| Job | every line of the job | the job's | filed on the job or its shipments |
| Project | every line of every job in the project | those jobs' | filed on the project, its jobs or their shipments |

A line moved off a shipment disappears from that shipment's portal at once.

**What is shown:** the record's name and code (and, for a shipment, the job it
belongs to); status, timeline and progress; shipment code, name, status,
carrier, vehicle, seal numbers, weight, volume, distance, ETA, departure and
arrival; the last known position; each line's item name, make and model, asset
and unit code, stage, room (destination location or label), floor,
department, crate, handling note (`job_items.notes`), flags, photos, crew
notes and stage history (stage, when, and whether a reader or a crew link
recorded it).

**What is never shown:** other jobs, shipments or lines; user names or ids
(histories say "by crew link" or "by reader", never who); job, shipment and
item notes other than a line's handling note; serial numbers, identifiers and
label photos; internal locations other than a line's destination and a job's
origin and destination; values, unless the link shows values; costs; a
signer's email, IP address or browser; the reasons given for forced status
changes.

**Flagged** items are those that are high value (worth at least
`PORTAL_HIGH_VALUE`), in an exception stage (missing, damaged, wrong shipment,
or any stage a feature registers), carry a crew condition note or a photo filed
as `damage`, or have a handling note.

**Photos** shown are attachments of the line's item (or unit, for a unit line)
with one of the stages `condition`, `damage`, `before`, `after`, `pack`,
`delivery`, `placed`. Label photos and anything a feature files under its own
stage stay inside.

**Documents** are attachments of kind document or photo filed on the shared
record (and, for a job or project, its shipments and jobs), and every signature
on them, when the link shares documents. Staff add them from the link's detail
in the Portal screen, or anywhere else that files on a project, job or
shipment.

**The timeline** is created, packed, loaded, in transit, arrived, delivered,
placed. Packed, loaded, delivered and placed come from the lines' stages and
`job_item_stage_history` (a step is done when every line has reached it;
missing or damaged lines do not hold it back). In transit and arrived come
from the shipments' `departed_at` and `arrived_at` and, when a GPS feature
publishes them, `geofence.*` events. A step the work went straight past counts
as done. In transit and arrived are left out when nothing travels on a
shipment.

**Last known position** is the newest of `shipment.metadata.gps` (where a GPS
feature keeps a tracker's fix; `{ lat, lng, at }`, or the same under `last`,
`position` or `lastFix`) and the newest tracking-core position of anything on
the shipment (a tracker packed with the load, or the zone a reader last saw it
in).

The page refreshes the overview every minute while it is visible.

## Crew links

A crew link covers one job or one shipment, and can:

- **Scan to a stage** it is allowed. Codes go through the jobs core's resolver
  and matcher, against the scope's lines only, and the matched lines are moved
  through the core (`setLineStage`): its rules, its lock, its guards, its
  history and its events. A code for anything outside the scope comes back as
  *not in scope* with nothing more about where it is; `force` is never used, so
  a crew cannot move a line backwards or take one off another shipment; a line
  on no shipment is not pulled onto a shipment link's shipment. A shipment
  link always works its own shipment; a job link may pick one of the job's.
- **Add a condition note** (good, fair, poor or damaged, and text) to a line in
  scope.
- **Add a photo** to a line in scope (images only, up to 25 MB, on one of the
  photo stages above). It is filed on the line's item or unit, so staff see it
  in the item's gallery.
- **Sign a handoff** for the shipment (or the job): the signed content lists
  every line with the stage it had reached, and is stored as a T02 signature
  on the shipment or job, with the drawn signature as its image.

Attribution: stage history records `via = "portal"`, `user_oid` null and the
actor `"<name>, <organisation> (portal)"`; photos record `created_by =
"portal:<grant id>"` and the grant in `meta.portal`; notes record the grant;
signatures have `signed_by_user` null and the grant's id in the signed
content. Every action is also published with actor
`{ kind: "system", id: "portal:<grant id>", name: "<name> (portal)" }`.

### The scope guard

The portal decides which lines a scan may move before it asks the core to
move them, but the core plans again under its own lock. A stage guard,
`portal-scope`, registered with the jobs core, vetoes any line in that batch
that the portal call did not choose. It is keyed to the call through
`AsyncLocalStorage` and only acts on changes made with `via = "portal"` inside
a portal call, so it never touches anyone else's scans.

## Emailed codes

With **Ask for an emailed code** on, the link alone opens only a page asking for
a code. **Email me a code** sends six digits to the link's address; they work
for 10 minutes and for five tries. Entering the right one gives that browser a
**pass** (random, stored hashed, kept in the browser's local storage) that
lasts 30 days or until the link expires, whichever is sooner. Each new device
asks again. Reissuing the link, changing its email address or turning the
option on drops every pass. Sending is limited to five codes per link per 15
minutes, checking to ten tries per link and thirty per address.

Without SMTP the option cannot be turned on, and a link that already has it
fails closed: the code cannot be sent, so the link cannot be opened.

## Milestone emails

Optional. With `SMTP_URL` set, people whose link has milestone emails on get
an email when:

- a shipment in scope leaves (`shipment.status_changed` to `in_transit`);
- it arrives at, or leaves, a key location (`geofence.*` events, when a GPS
  feature publishes them; see [For other features](#for-other-features));
- it is delivered (`shipment.status_changed` to `delivered`);
- a job in scope is completed (`job.updated` to `completed`, for job and project
  links).

The notifier reads the audit log by event type every 30 seconds (the event bus
is the audit log, so no feature has to know about the portal). Each milestone
is one row per link, so it is never sent twice (a shipment that goes back to
loaded and out again does not email again). A person gets at most one email
per `PORTAL_NOTIFY_INTERVAL_MIN` (15 minutes by default); milestones in
between wait and go out together. Links revoked, expired or switched off
before their email goes out are never emailed. Nothing older than a day is
sent, so turning email on after a long time does not unleash a backlog. On a
server's first run the notifier starts from the newest event. Several replicas
share the work safely: the cursor row and each person's pending rows are
locked while in use.

Emails are plain text, never contain the link (only its hash is stored), and
name the record and the milestones with their times in UTC.

nodemailer is loaded only when `SMTP_URL` is set. Without it the options that
need email are greyed out, the portal page has no email switch, and nothing is
queued.

## HTTP API

### Portal (link holders)

Under `/api/portal`, mounted **before the session middleware**: a portal
request never reads, creates or extends a Bindex session, and `AUTH_MODE=trusted`
never applies to it. Send the token in `X-Portal-Token` (or
`Authorization: Bearer bdxp_…`) and, for a link that asks for a code, the pass in
`X-Portal-Pass`. Tokens are never read from the query string, which ends up in
logs. Every response is `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

| Method | Path | |
| --- | --- | --- |
| GET | `/session` | Who the link is for, its role, permissions, expiry, masked email, instance branding and stage names; for crews, the stages, photo stages, conditions, handoff statement and (job links) shipments. `scope` is null until a required code is entered. |
| POST | `/code` | Email a code (links that ask for one). |
| POST | `/code/verify` | `{ code }` → `{ pass, expiresAt }`. |
| GET | `/overview` | Scope, jobs, shipments with facts, progress and last position, overall progress, milestones, updates. |
| GET | `/items` | `?q=&room=&stage=&floor=&department=&shipmentId=&flag=flagged\|high_value\|exception\|noted&limit=&offset=` → `{ lines, total, facets: { rooms (with progress), floors, departments, stages } }`. |
| GET | `/items/:lineId` | `{ line, photos, notes, history }`. |
| GET | `/flagged` | Flagged lines with up to four photo ids each. |
| GET | `/documents` | `{ shared, documents, receipts }`. |
| GET | `/files/:id` | A shared file (`?thumb=64..1024` for a JPEG preview of a photo). |
| POST | `/notifications` | `{ enabled }`: milestone emails on or off, by the person themselves. |
| POST | `/scan` | Crews: `{ codes (≤ 500), stage, shipmentId?, note? }` → `{ advanced, alreadyAt, wrongShipment, notInScope, unknown, blocked }`. |
| POST | `/items/:lineId/notes` | Crews: `{ body, condition? }`. |
| POST | `/items/:lineId/photos` | Crews: the photo as the raw body (`application/octet-stream`), `?type=&stage=&caption=`. |
| POST | `/handoff` | Crews: `{ signerName, signerRole?, image (PNG data URL), shipmentId? }`. |

Errors: `401 link_invalid` (missing, malformed, unknown or reissued token),
`401 link_expired`, `401 link_revoked`, `401 code_required`, `401 code_wrong`,
`403` (a viewer link trying to change something), `404` for anything outside
the scope (a line, a shipment, a file: the same answer whether it exists or
not), `404 portal_unavailable` (switch off), `429 rate_limited`, `503
mail_unavailable` (a code cannot be emailed).

Rate limits (per server process, in memory, `lib/rateLimit`): 300 requests a
minute per address; 30 refused links per address per 15 minutes (then 429);
120 writes and 30 photo uploads a minute per link; the code limits above.

### Administrators

Under `/api/portal-grants`, behind an administrator's **browser session** (API
keys get `403 session_required`).

| Method | Path | |
| --- | --- | --- |
| GET | `/` | `?state=active\|inactive&scope=&targetId=&q=`. Never includes the token or its hash. |
| GET | `/status` | `{ mailAvailable, trustedMode, baseUrl, highValue, notifyIntervalMinutes, defaultExpiryDays, maxExpiryDays, defaultStages, stages }`. |
| GET | `/targets?q=` | Projects, jobs and shipments matching a code or name. |
| POST | `/` | `{ scope, targetId, role, granteeName, granteeEmail?, granteeOrg?, expiresAt, showValues?, showDocuments?, allowedStages?, requireCode?, notify?, note?, sendEmail?, baseUrl? }` → `201 { grant, token, url, qr, emailed }`. The token is returned this once. `baseUrl` (the browser's origin) builds the link; `APP_BASE_URL` otherwise. |
| GET | `/:id` | One link. |
| PATCH | `/:id` | Any field but scope and target. |
| POST | `/:id/revoke` | |
| POST | `/:id/reissue` | `{ sendEmail?, baseUrl? }` → a new token, once. |
| GET | `/:id/activity?before=` | The link's audit-log entries, newest first. |
| GET | `/:id/notes` | Notes its crew wrote. |

## Events

Published to the audit log (and webhooks) with subject
`{ type: "portal_grant", id }`. Actions through a link have the actor
`{ kind: "system", id: "portal:<grant id>", name: "<name> (portal)" }`;
administrators' changes have the administrator. Email addresses are never in
event data (the feed is readable by every signed-in user); IP addresses and
browsers of portal visits are.

| Type | When | `data` |
| --- | --- | --- |
| `portal.grant_created`, `portal.grant_updated`, `portal.grant_revoked`, `portal.grant_reissued` | An administrator made, changed, revoked or replaced a link | `{ scope, targetId, targetCode, role, granteeName, granteeOrg, hasEmail, expiresAt, showValues, showDocuments, allowedStages, requireCode, notify }` (+ `changed` on update) |
| `portal.accessed` | A visit: the first request from an address, then again after 15 minutes of activity | `{ ip, userAgent, scope, role }` |
| `portal.access_denied` | A revoked or expired link, or one missing its code, was used (throttled the same way) | `{ reason, ip, userAgent }` |
| `portal.code_sent`, `portal.code_verified`, `portal.code_failed` | Emailed codes | `{ ip }` on verify and failure |
| `portal.scanned` | A crew scan | `{ jobId, shipmentId, stage, advanced, alreadyAt, wrongShipment, notInScope, unknown, blocked, jobItemIds }` |
| `portal.note_added` | | `{ jobId, jobItemId, itemId, unitId, condition, noteId }` |
| `portal.photo_added` | | `{ jobId, jobItemId, itemId, unitId, attachmentId, stage }` |
| `portal.handoff_signed` | | `{ signatureId, contentHash, ownerType, ownerId, ownerCode, lines, byStage, signerName }` |
| `portal.notify_changed` | The person switched milestone emails | `{ enabled }` |
| `portal.notification_sent` | Milestone emails went out | `{ milestones, count }` |

A crew scan also produces the usual `job.stage_changed` (actor: system, named
after the link, `via: "portal"`). Every request is also logged to the server
log as `portal.request` (grant, method, path, address); refusals as
`portal.denied`.

## Data model

Migration `server/migrations/0036_portal.sql`; Drizzle definitions in
`server/src/db/tables/portal.ts`.

| Table | Holds |
| --- | --- |
| `portal_grants` | scope and exactly one of `project_id`, `job_id`, `shipment_id` (deleting the record deletes its links); role; grantee name, email, organisation; `show_values`, `show_documents`, `allowed_stages`, `require_code`, `notify`; `token_hash` (sha256) and `token_last4`; `expires_at`, `revoked_at`/`revoked_by`; `last_used_at`, `use_count` (requests); staff `note`; `created_by`. CHECKs keep the scope and target in step, crews off projects, and codes to links with an email. |
| `portal_codes` | The one outstanding emailed code per link: hash, attempts, expiry. |
| `portal_passes` | Browsers that entered a code: pass hash, expiry, address, browser, last use. |
| `portal_notes` | Crew condition notes: link (kept as null if the link goes), author name, job, line, item, unit, condition, text. |
| `portal_notifications` | One row per link and milestone key: title, event id, time, `pending`/`sent`/`skipped`/`failed`. |
| `portal_notifier_state` | The notifier's audit-log cursor (one row). |

Expired codes are deleted, and passes a day after they expire, hourly.

## Backups

The JSON backup includes `portal_grants` (without token hashes) and
`portal_notes`. On a restore a link that still exists keeps its current token,
and stays revoked or keeps the earlier expiry if that changed after the file
was written: a restore never brings a revoked link back. A link that exists
only in the file comes back with no working link; reissue it. A token hash
found in a file is ignored. Links and notes whose project, job, shipment or
line is not in the snapshot are dropped. Codes, passes and the notification log
are not backed up.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SMTP_URL` | blank | `smtp://user:pass@host:587` (STARTTLS when the server offers it) or `smtps://user:pass@host:465`. Blank turns email off. |
| `SMTP_FROM` | `"<app name>" <no-reply@<APP_BASE_URL host>>` | The From address. |
| `PORTAL_HIGH_VALUE` | `1000` | Items worth at least this much, in the instance currency, are flagged high value. `0` turns the flag off. |
| `PORTAL_NOTIFY_INTERVAL_MIN` | `15` | Minimum minutes between two milestone emails to one person. |
| `APP_BASE_URL` | | Builds links in emails when the administrator's browser does not say its origin. |

## Threat model

**Assets.** The inventory, positions, documents and signatures of one scope;
the ability to change stages, add evidence and sign on a crew's behalf; the
link tokens themselves; external people's email and IP addresses.

**Actors.** The link holder (trusted with their scope only); anyone the link is
forwarded to or who finds it (browser history, a shared screen, a proxy log);
an attacker on the internet with no link; a malicious or careless crew; staff
(trusted, but mistakes happen); someone with a copy of the database or a backup
file.

**Entry points.** `/api/portal/*` (public, token-authed), the `/p/:token` page,
`/api/portal-grants/*` (administrators), the emailed code, the notifier's
emails, the JSON backup.

| Threat | Mitigation |
| --- | --- |
| Guessing a token | 256 random bits; shape checked before any query; refusals rate limited per address and logged. |
| A stolen database or backup opens links | Tokens and passes are stored as sha256 hashes only; backups carry no hashes; a hash in a backup file is ignored. |
| A leaked link | Every link expires (at most 400 days); revocation and reissue take effect on the next request; optional emailed code per device; access log with addresses shows unexpected use. |
| Token in logs | Never in query strings; `Referrer-Policy: no-referrer` (helmet) so it does not leak to linked sites; no request logging of paths with tokens in the app. |
| Reading outside the scope | Every query takes its condition from the loaded scope; every id a request names (line, shipment, file) is checked against it and anything else is a 404 that does not say whether it exists; tests call every route with ids from outside. |
| Learning about other jobs from scan results | Scans match only the scope's lines; outside codes come back as "not in scope" with no job, shipment or line. |
| A crew changing other shipments' lines | Planned against its own lines only, moved by id, never with force, and the `portal-scope` stage guard vetoes anything else inside the core's lock. |
| A viewer changing anything | Every write checks the role (403). |
| Values, costs, users, serials leaking | Explicit column lists; values only with `show_values`; no user ids or names; no identifiers, serials or label photos. |
| Session fixation, CSRF, a portal visit becoming a staff session | The portal API is mounted before the session middleware and uses no cookies; the page sends `credentials: "omit"`; tokens travel in a header, which cross-site requests cannot set without a CORS preflight the server never grants. |
| Revoked or expired links working | Checked on every request from the database, no caching; passes and codes are deleted on revoke and reissue; milestone emails already queued are skipped. |
| Brute-forcing the six-digit code | Needs the token as well; 10-minute life, 5 tries per code (counted atomically), 5 codes per 15 minutes, 10 tries per link and 30 per address per 15 minutes. |
| Malicious uploads | Images only, type decided from the bytes (T02), SVG and HTML refused, 25 MB cap enforced while streaming; served with `nosniff`. |
| A forged or altered handoff | The signed content is canonical JSON with its hash (T02); the audit log records the signature id and hash. |
| Email abuse (spam, header injection) | Emails go only to the address an administrator set; no user text in headers except names with line breaks removed; plain text; no links in milestone emails. |
| Audit log flooding | Visits are throttled to one entry per address per 15 minutes; refusals likewise; unknown tokens are only logged. |
| A restore resurrecting a revoked link | Current revocations and earlier expiries win over the file. |

**Residual risks and deliberate limits.**

- Anyone holding a link can use it until it expires or is revoked. Use the
  emailed code for anything sensitive, and short expiries.
- The token is in the page URL, so it is in the holder's browser history and in
  the offline cache of the installable app shell, and a reverse proxy that logs
  full request lines logs it. Exclude `/p/` from access logs if that matters.
- `AUTH_MODE=trusted` makes everyone who can reach the server its owner; a
  portal adds nothing there, and loading the portal page in that mode creates
  the usual trusted session for the staff app (the portal API itself still
  never does). The Portal screen warns about this.
- Rate limits live in each server process's memory and reset on restart; with
  several replicas each has its own.
- Viewers see the organisation and name a crew link was issued to on that
  crew's notes, and the signer's name on receipts.
- Portal visit events record IP addresses and browsers, which every signed-in
  user can read through the event feed.
- A photo filed on an item (not a unit) is visible from every line of that
  item, including unit lines on another shipment.

## For other features

- **GPS (T10).** Publish `geofence.<verb>` events; the notifier and the
  timeline read them by type. `verb` `entered`, `enter`, `arrived` or `arrival`
  means arriving at a key location, `exited`, `exit`, `left`, `departed` or
  `departure` leaving one. The event is routed by `data.shipmentId` (or
  subject `shipment`), else `data.jobId` (or subject `job`), else
  `data.itemId` (or subject `item`, looked up to its open job line). The place
  is `data.geofenceName`, `data.fenceName`, `data.geofence.name`,
  `data.fence.name`, `data.locationName` or `data.name`; `data.geofenceId`,
  `data.geofence.id` or `data.locationId` de-duplicates. `data.code` and
  `data.name` of a shipment make a nicer title. Keep a tracker's latest fix in
  `shipment.metadata.gps` as `{ lat, lng, at }` to show it as the last known
  position.
- **Custody (T14), claims (T16), documents (T17).** Signatures and files on a
  project, job or shipment are shared with links that share documents. The
  portal registers the owner types `project`, `job` and `shipment` with T02 only
  if nobody has yet. Condition evidence from crews is in `portal_notes` and in
  photos with `meta.portal`.
- **Services.** `server/src/services/portal` exports the grant functions,
  `loadScope`, and the read functions, for a feature that wants to add a tab.

## Testing

```bash
pnpm test                                    # pure logic and email, no database
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_portal \
  pnpm --filter bindex-server test           # also every portal route on Postgres
```

`server/tests/portal-db.test.ts` calls every portal route with a viewer link on
one shipment, a crew link on that shipment and one on its job, and checks that
nothing about the other shipment, the other job or their lines appears in any
answer, that ids from outside are refused, that viewers cannot write, that a
crew moves only its own lines, that missing, malformed, unknown, expired and
revoked links fail on every route, that no response sets a cookie, the emailed
code, the scope guard, the administrators' routes, milestone emails with
de-duplication and throttling, and the backup rules.

For email in development, run the SMTP stub and point the server at it:

```bash
pnpm --filter bindex-server exec tsx tests/portal-smtp-stub.ts 2525
SMTP_URL=smtp://127.0.0.1:2525 pnpm dev
```

## Code map

```
server/migrations/0036_portal.sql
server/src/db/tables/portal.ts
server/src/services/portal/
  index.ts       public surface; registers the stage guard, owner types, event types
  tokens.ts      tokens, passes, codes (pure)
  policy.ts      grant state, roles, stages, limits (pure)
  milestones.ts  timeline, event-to-milestone, email text, throttle (pure)
  position.ts    last known position (pure)
  handoff.ts     signed handoff content (pure)
  scope.ts       loading a grant's scope; the line condition
  grants.ts      administrators' functions; tokens, codes and passes
  views.ts       everything a portal page reads
  contribute.ts  crew scans, notes, photos, handoffs
  guard.ts       the portal-scope stage guard
  access.ts      access logging
  mailer.ts      optional SMTP, loaded lazily
  notifier.ts    milestone emails from the audit log
  notes.ts       crew notes for administrators
  backup.ts      tables in the instance backup
server/src/routes/portal.ts        /api/portal (pre-session) and /api/portal-grants
client/src/features/portal/        the link page, the Portal screen, API client, types
server/tests/portal*.ts            tests and the SMTP stub
```
