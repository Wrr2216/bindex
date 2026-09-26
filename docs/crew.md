# Crew check-in and credentials

Workers (employees, temps, a subcontractor's crew) each carry a **badge**
whose QR checks them in on a **job**. The scan shows at a glance whether they
hold what the job requires: a background check, a forklift licence, a site
induction. Each required credential is **green**, **amber** or **red**, and
depending on the job type a red either **blocks** the check-in until someone
overrides it with a reason, or lets them in with a **warning**. Checking out
at the end of the shift records their hours, which export as a roster and
timesheet workbook.

An optional **external verifier** (a background-check provider, a union
compliance service, or a small adapter in front of one) can be asked about
every badge at the door, and its answer is merged in before the decision.

Everything here is behind one instance feature switch, **Crew check-in**
(`features.crew`, stored as `features.crew` in `app_settings`). It is off by
default. With it off the Crew navigation entry, its screens and its Settings
card are gone, and every `/api/crew` request answers `404 feature_disabled`.
Check-in happens on jobs, so it also needs **Projects, jobs and shipments**
(`features.jobs`); with jobs off, workers, credentials, badges and the expiry
digest still work and the check-in and timesheet routes answer
`404 feature_disabled`.

- [Using it](#using-it)
- [How compliance is judged](#how-compliance-is-judged)
- [Job type rules](#job-type-rules)
- [The external verifier](#the-external-verifier)
- [The expiry digest](#the-expiry-digest)
- [HTTP API](#http-api)
- [Events](#events)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Testing](#testing)
- [Code map](#code-map)

## Using it

1. **Settings → Crew check-in → Credential types and rules** (administrators).
   A new instance has five credential types: Background check, Forklift
   licence, Site induction, OSHA 10 and DOT medical card. Each has how long it
   usually lasts (used to fill in the expiry from the issue date) and how many
   days before expiry it turns amber. Then, per job type, tick the credentials
   its crew must hold and choose **Warn, and let them in** or **Block until
   overridden** (optionally, only administrators may override).
2. **Crew → Workers → Add worker**: name, company or subcontractor, role,
   phone. Leave the badge code blank to get a `CRW-…` code, or type (or scan)
   the number of an ID card they already carry.
3. On the worker's page, **Add photo** (it goes on the badge), **Add
   credential** for each licence, check or induction, and attach a scan or
   photo of each under **Documents**. **Print badge** makes a bank-card sized
   (CR80) PDF for a card printer; **Print on a sheet** puts nine to a Letter
   page with cut lines. Several at once: tick them in the worker list.
4. **Crew → Check-in**, pick the job. The page listens for badges straight
   away: a handheld reader, the **Camera** button, or search by name. Each scan
   checks the worker in and shows their card:
   - **green** "Checked in": everything required is valid;
   - **amber** "Checked in with a warning": valid today but expiring soon, or
     red under a warning policy;
   - **red** "Not checked in: credentials": red under a blocking policy. Type
     why they are being let in anyway and press **Override and check in**. The
     reason, who gave it and when are kept on the check-in, in the timesheet
     and in the audit log.
   Someone still checked in on another job is offered **Check out there and
   in here**. An unknown badge offers to add a worker with that code.
5. At the end of the shift switch the panel to **Check out** and scan again,
   or use **Check out** on each row (with break minutes), or **Check out
   everyone**. Shifts can be corrected afterwards (**Edit**); administrators
   can delete one.
6. **Download XLSX** on the job, or **Crew → Timesheets** for any job (or all
   of them) and date range.

A worker page's QR, scanned with a phone's own camera, opens that worker's
page (`/crew/badge/<code>` redirects there). **New badge code** is for a lost
badge: the old one stops working at once. Marking a worker **inactive**
refuses their badge at the door (`409 worker_inactive`). A worker with hours
on file cannot be deleted, only made inactive, so timesheets keep their name.

A job type's task list can include a **Crew check-in** task (kind
`crew_checkin`); it is marked done when the first worker checks in on the job.

## How compliance is judged

Credentials are judged on the **calendar day** in the viewer's time zone (the
client sends it as `tz`), not the instant: a card that expires on the 12th is
good all day on the 12th. The daily digest uses UTC.

| Light | When |
| --- | --- |
| green | Status `valid`, and no expiry or more than the type's warning days away |
| amber | Status `valid`, expiring within the type's warning days (including today) |
| red | Missing, expired (by date or status), or status `pending`, `failed`, `suspended` or `revoked` |

Only red can stop anyone. A job's overall light is the worst of its required
credentials; with nothing required it is green ("No credentials required").

A worker may hold several credentials of one type (a renewal is a new
credential, so history stays). The **deciding** one is:

1. a verifier credential saying `failed`, `suspended`, `revoked` or `expired`,
   if there is one: the verifier is the authority it was plugged in to be, and
   a paper copy cannot out-vote it; otherwise
2. the one with the best light, then the latest expiry (no expiry counts as
   latest), then the latest issue date.

The gate (`decideGate` in `services/crew/model.ts`):

| Light | `warn` policy | `block` policy |
| --- | --- | --- |
| green | in | in |
| amber | in, flagged | in, flagged |
| red | in, flagged | refused (`409 credentials_blocked`) unless an override reason is given; with `overrideAdminOnly`, only an administrator's reason counts |

What the door saw is kept on the check-in (`compliance`,
`compliance_detail`, `policy`) and never rewritten: renewing or revoking a
credential later changes the **current** light shown on the roster, not the
record of what was known at the door.

## Job type rules

Stored with the job type itself, through jobs core's per-feature settings
(`setJobTypeSetting(id, "crew", …)`), so this feature adds no column to a
table it does not own:

```json
{ "required": ["forklift", "site_induction"], "policy": "block", "overrideAdminOnly": false }
```

Keys are credential type keys. A job with no type, or a type with nothing set,
requires nothing and warns. A key whose type has been retired (switched off)
or deleted asks for nothing, which is how an administrator stops asking for a
credential everywhere at once.

## The external verifier

Set `CREDENTIAL_VERIFY_URL` and every badge scanned at check-in, and every
**Check with verifier** on a worker page, sends:

```http
POST <CREDENTIAL_VERIFY_URL>
Content-Type: application/json
Authorization: Bearer <CREDENTIAL_VERIFY_TOKEN>        (when set)
User-Agent: Bindex-Crew/1

{ "badgeCode": "CRW-7F3K2A",
  "worker": { "id": "…", "name": "Dana Ruiz", "company": "Acme Movers" },
  "credentialTypes": ["background_check", "forklift", "site_induction", …] }
```

Answer with `200` and

```json
{ "credentials": [
  { "type": "background_check", "status": "clear", "expiresOn": "2027-01-31", "number": "88123", "issuer": "ScreenCo" },
  { "type": "forklift", "status": "revoked" }
] }
```

or a bare array of the same entries; `404` means the verifier does not know
this badge. Per entry:

- `type` (or `key`, `credential`): matched to a credential type key after
  lowercasing and turning spaces into underscores, so `"Forklift"` finds
  `forklift`. Types this instance does not have are reported as `unmatched`
  and ignored.
- `status`: `valid`, `active`, `clear`, `cleared`, `passed`, `ok`, `current`,
  `approved`, `verified`, `compliant` → valid; `pending`, `in_progress`,
  `processing`, `submitted`, `in_review` → pending; `expired`, `lapsed`;
  `failed`, `rejected`, `denied`, `not_clear`; `suspended`, `inactive`,
  `on_hold`; `revoked`, `cancelled`, `terminated`. Anything else drops the
  entry.
- `expiresOn` / `issuedOn` (or `expires_on`, `expires`, `expiry`, `issued_on`,
  `issued`): a date, or a timestamp whose date is taken.
- `number` (or `id`) and `issuer`: optional text.

Each type the verifier answers for is stored as one credential per worker with
source `verifier`, refreshed on every check (`verified_at`), and cannot be
edited by hand (delete it, or add a manual one). Only changes are published as
events. Redirects are not followed and replies over 256 KB are refused.

It **degrades quietly**: unset (or not an http(s) URL) it reports
`available: false` and its button disappears; slow (`CREDENTIAL_VERIFY_TIMEOUT_MS`,
default 5 s), down, or answering nonsense, the check-in goes ahead on what is
already on file, the result carries `verifier: { ok: false, error }`, the
screen says the verifier could not be reached, and the server logs
`crew.verify.failed`. `POST /api/crew/workers/:id/verify` is limited to 30 calls
a minute per person, since a provider may charge per check.

## The expiry digest

Once a day, at the first hourly check at or after `CREW_DIGEST_HOUR_UTC`
(default 13), the server lists every active worker's deciding credential of
every active type that has expired or expires within `CREW_EXPIRY_ALERT_DAYS`
(default 30; `0` turns it off), and:

- sends it through the configured notifications (Pushover and Wazuh, see
  [alerting](alerting.md)), high priority when something is within a week;
- publishes it as a `crew.credentials_expiring` event, so a webhook can turn it
  into an email or a ticket.

Every replica runs the timer; a conditional write to
`app_settings['crew.expiry_digest.last_sent']` lets exactly one send each day.
**Crew → Expiring** shows the same list for 7, 30, 60 or 90 days, and an
administrator can **Send the digest now**. Nothing is sent while the feature is
off.

## HTTP API

All under `/api/crew`, behind the usual session or API key. API keys with scope
`read` get the `GET`s. Rows marked *admin* need an administrator's browser
session. `tz` is an IANA time zone (default UTC).

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/status` | `{ verifier: { available }, digest: { days, hourUtc }, jobs, isAdmin }` |
| GET | `/credential-types` | `?all=true` includes retired ones |
| POST | `/credential-types` | `{ name, key?, description?, validityMonths?, warnDays?, active? }` *admin*; the key is made from the name when left out and never changes |
| PATCH | `/credential-types/:id` | same fields except `key` *admin* |
| DELETE | `/credential-types/:id` | *admin*; `409` while anyone holds one (retire it instead) |
| GET | `/job-types` | every job type with its `{ required, policy, overrideAdminOnly }` |
| PUT | `/job-types/:id/policy` | `{ required: string[], policy: "warn" \| "block", overrideAdminOnly? }` *admin* |
| GET | `/workers` | `?q=&company=&active=true\|false\|all&light=green\|amber\|red\|none&credentialType=<key>&expiring=<days>&tz=`; `active` defaults to `true`; `expiring` includes credentials already expired. Returns `{ workers, companies }`, each worker with `light` (the worst of what they hold, null for nothing on file), `checks`, `nextExpiry`, `onJob` |
| POST | `/workers` | `{ name, company?, role?, badgeCode?, phone?, active?, notes? }` |
| GET | `/workers/by-badge/:code` | `{ id, name, active }`; the code may be the badge link |
| GET | `/workers/:id` | `?tz=`; the worker, every credential judged, the last 50 shifts, totals |
| PATCH | `/workers/:id` | same fields, plus `photoAttachmentId` (a photo attachment of this worker, or null) |
| DELETE | `/workers/:id` | `409` while they have hours on file |
| POST | `/workers/:id/reissue-badge` | a new `CRW-…` code |
| POST | `/workers/:id/verify` | ask the verifier now; returns the verifier result |
| GET | `/workers/:id/badge.png` | preview |
| GET | `/workers/:id/badge.pdf` | `?layout=card\|sheet` |
| GET | `/badges.pdf` | `?ids=a,b,c&layout=card\|sheet` (up to 300) |
| POST | `/workers/:id/credentials` | `{ typeId \| typeKey, issuer?, number?, issuedOn?, expiresOn?, status?, notes? }`; `expiresOn` left out is worked out from the type's validity, `null` means it does not expire |
| PATCH | `/credentials/:id` | same fields except the type; verifier credentials only take `notes` |
| DELETE | `/credentials/:id` | |
| GET | `/jobs` | open jobs with how many are on site |
| GET | `/jobs/:jobId/roster` | `?tz=`; `{ job, policy, required, onSite, shifts, workers, totals }`; each entry has `current` compliance as well as what the door saw |
| GET | `/jobs/:jobId/candidates` | `?q=&tz=`; workers matching, each judged against this job |
| POST | `/jobs/:jobId/checkins` | `{ code? \| workerId?, via?, tz?, overrideReason?, switchJob?, note? }` |
| POST | `/jobs/:jobId/checkout` | `{ code? \| workerId?, at?, breakMinutes?, note? }` |
| POST | `/jobs/:jobId/checkout-all` | `{ at?, breakMinutes?, note? }` → `{ count }` |
| POST | `/checkins/:id/checkout` | `{ at?, breakMinutes?, note? }` |
| PATCH | `/checkins/:id` | `{ checkedInAt?, checkedOutAt? (null reopens), breakMinutes?, notes? }` |
| DELETE | `/checkins/:id` | *admin* |
| GET | `/timesheet` | `?jobId=&workerId=&from=&to=&tz=`; `{ rows, roster, totals }` |
| GET | `/timesheet.xlsx` | same query; sheets **Roster** (per worker per job), **Timesheet** (every shift) and, for up to 62 days, **Hours by day** |
| GET | `/expiring` | `?days=&tz=` |
| POST | `/expiry-digest` | `{ tz? }` *admin*; sends now → `{ count, delivered, skipped }` |

`code` is whatever was scanned: the badge link (`…/crew/badge/CRW-7F3K2A`), or
a bare code, matched without regard to case. `via` is any lower_snake_case
word (`scan`, `search`, `kiosk`); it defaults to `api` for API keys and
`manual` otherwise.

**Check-in responses.** `201 { status: "checked_in", checkin, worker,
compliance, policy, verifier, warned, overridden, movedFrom }`, or `200` with
`status: "already"` for someone already on this job. Refusals:

| Status | `code` | `details` |
| --- | --- | --- |
| 404 | `unknown_badge` | `{ code }` |
| 409 | `worker_inactive` | `{ worker }` |
| 409 | `checked_in_elsewhere` | `{ worker, jobId, jobCode, jobName, checkinId, since }`; send `switchJob: true` to check them out there first |
| 409 | `credentials_blocked` | `{ worker, compliance, policy, verifier, reason: "override_required" \| "override_admin_only" }` |
| 400 | `bad_request` | the job is completed or cancelled |

At most one open check-in per worker is enforced by a unique index, so two
scans at once cannot put someone on two jobs. A shift belongs to the day it
started on in `tz`; an open shift counts up to now. Times more than five
minutes in the future are refused.

## Events

Published on the event backbone, so they are in the audit log and can be sent
to webhooks. Phone numbers, notes and badge codes are left out: the feed is
readable by every signed-in user and API key.

| Type | Subject | `data` |
| --- | --- | --- |
| `crew.checked_in` | `job` | `{ jobId, jobCode, checkinId, workerId, workerName, company, via, compliance, summary, policy, overridden, overrideReason, movedFrom }` |
| `crew.check_in_refused` | `job` | `{ jobId, jobCode, workerId, workerName, compliance, summary, via }` |
| `crew.check_in_overridden` | `job` | `{ jobId, jobCode, checkinId, workerId, workerName, summary, checks: [{ type, reason, expiresOn }], reason, by }` |
| `crew.checked_out` | `job` | `{ jobId, checkinId, workerId, workerName, minutes, breakMinutes }` |
| `crew.checkin_updated` | `job` | `{ jobId, checkinId, workerId, before, after }` (times and break) |
| `crew.checkin_deleted` | `job` | `{ jobId, checkinId, workerId, checkedInAt, checkedOutAt, compliance, overrideReason }` |
| `crew.worker_created` | `crew_worker` | `{ name, company, role }` |
| `crew.worker_updated` | `crew_worker` | `{ name, changed: string[], active, reissued? }` |
| `crew.worker_deleted` | `crew_worker` | `{ name, company }` |
| `crew.credential_changed` | `crew_worker` | `{ action: "added" \| "updated" \| "removed", workerId, credentialId?, type, status, previousStatus?, expiresOn, source }` |
| `crew.credentials_expiring` | none | `{ days, count, expired, credentials: [{ workerId, workerName, company, type, typeName, expiresOn, daysLeft }] }` |
| `crew.policy_changed` | `job_type` | `{ jobType, before, after }` |

A webhook on `crew.check_in_overridden` is the natural "tell the safety
manager" alert.

## Data model

Migration `server/migrations/0039_crew.sql`; Drizzle definitions in
`server/src/db/tables/crew.ts`.

| Table | Holds |
| --- | --- |
| `crew_credential_types` | `key` (unique, lower_snake_case, fixed), `name` (unique, case-insensitive), description, `validity_months`, `warn_days`, active |
| `crew_workers` | name, company, role, `badge_code` (unique, case-insensitive), phone, `photo_attachment_id`, active, notes, metadata |
| `crew_credentials` | worker (cascade), type (restrict), issuer, number, `issued_on`, `expires_on`, `status`, `source` (`manual` \| `verifier`, one verifier row per worker and type), `verified_at`, notes, who created and changed it |
| `crew_checkins` | job (cascade), worker (restrict), in, out, `break_minutes`, via, `compliance` and `compliance_detail` as seen at the door, `policy`, `override_reason` with who, who checked in and out, notes. At most one open per worker |

Worker photos and credential documents are attachments (owner types
`crew_worker` and `crew_credential`, registered with media core so the orphan
sweep removes them after their record is deleted). `photo_attachment_id` is
deliberately not a foreign key: attachments are not in the JSON backup, and a
restore onto a new instance should keep the worker and lose only the picture.

Backups include all four tables. Restoring a file from before crew existed
keeps the current workers, credentials and types, and keeps check-ins whose
job still exists after the restore.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CREDENTIAL_VERIFY_URL` | blank (off) | The external verifier. |
| `CREDENTIAL_VERIFY_TOKEN` | blank | Sent as `Authorization: Bearer …` when set. |
| `CREDENTIAL_VERIFY_TIMEOUT_MS` | `5000` | How long a check-in waits for the verifier. |
| `CREW_EXPIRY_ALERT_DAYS` | `30` | Digest window; `0` turns the digest off. |
| `CREW_DIGEST_HOUR_UTC` | `13` | Earliest UTC hour the digest goes out. |

## Testing

```bash
pnpm test                                    # compliance, gate, dates, verifier replies, timesheet rollups
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_crew_test \
  pnpm --filter bindex-server exec tsx --test tests/crew-db.test.ts   # the whole flow on Postgres, with a scripted verifier
```

Point `TEST_DATABASE_URL` at a throwaway database: the event backbone's
database test, which reads the same variable, drops and recreates it when the
whole suite runs.

`server/tests/crew-verifier.test.ts` runs the verifier against a local
stand-in with no database (headers, body, 404, errors, timeouts, redirects).

## Code map

```
server/migrations/0039_crew.sql
server/src/db/tables/crew.ts
server/src/services/crew/
  index.ts            public surface; registers owner types and the crew_checkin task kind
  model.ts            compliance, gate, dates, badge scans, hours, verifier replies (pure)
  credentialTypes.ts  workers.ts  credentials.ts  policy.ts  checkins.ts
  verifier.ts         the external verifier call
  timesheet.ts        rows, rollups and the workbook
  badge.ts            badge PNG and PDF
  digest.ts           daily expiry digest
  events.ts           event types and publishing
  backup.ts           tables in the instance backup
server/src/routes/crew.ts
client/src/features/crew/               screens, API client, types
server/tests/crew.test.ts               pure logic
server/tests/crew-verifier.test.ts      the verifier call
server/tests/crew-db.test.ts            the whole flow on Postgres (opt-in)
```

## Follow-ups

- A badge QR scanned **outside** a check-in screen goes through the global
  scan overlay, which only knows item links, and offers to create an item.
  Routing `/crew/badge/` links in `client/src/scan/ScanProvider.tsx` to the
  worker page is a one-line change in a file this feature does not own.
- A link from the job page to its check-in board (`/crew/jobs/:id`) belongs in
  the jobs screens; for now the board is reached from Crew → Check-in.
- Fixed badge readers at a gate (a tracking-core device posting badge reads
  to a job) would let a turnstile check people in without a tablet.
- Shifts left open are flagged after 14 hours on the board but never closed
  automatically; an auto check-out time per job type would suit sites with
  fixed shifts.
- Managing workers and credentials is open to every signed-in user, like
  items; per-role permissions would let only supervisors mark a check valid.
