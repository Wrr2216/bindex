# Claims and incidents

When something is lost or damaged, a **claim** asks for money back for it. When
something goes wrong without money involved (a near miss, a scraped doorframe,
a pallet jack that failed) an **incident report** records it. Both live in one
list, share one workflow and one set of screens, and both do the same thing
first: they gather what is already on file about the things involved, so
nobody reconstructs from memory what happened on pack day.

- A claim picked from a job starts with that job's **damaged, missing and
  refused lines** ticked. Its **evidence pack** already holds each line's
  pack-day photos, condition notes, every stage change with when, how and who,
  and the audit-log entries behind them. Nothing is attached by hand.
- A **workflow** takes it from draft to submitted, under review, approved or
  denied, paid and closed, with a written reason wherever the outcome changes,
  a **reviewer**, comments, and a **decision deadline** that is flagged when
  missed.
- Every step is **published** to the tamper-evident audit log and to webhooks.
- It prints as an **adjuster-ready PDF** (summary, lines, per-line evidence
  with photos, timeline) and exports as a **spreadsheet**.
- An outside party holding a **portal link** can file a claim on their own
  delivery, when the portal feature is installed.

Contents: [Turning it on](#turning-it-on) · [Using it](#using-it) ·
[Workflow](#workflow) · [Amounts](#amounts) · [Deadlines](#deadlines) ·
[The evidence pack](#the-evidence-pack) · [Other features it reads](#other-features-it-reads) ·
[Filing from the portal](#filing-from-the-portal) · [Documents](#documents) ·
[Events](#events) · [HTTP API](#http-api) · [Data model](#data-model) ·
[Testing](#testing) · [Code map](#code-map)

## Turning it on

Settings → **Claims and incidents** (`features.claims`, off by default). With
it off, the Claims navigation entry and its screens are gone and every
`/api/claims` and `/api/claims-portal` request answers
`404 feature_disabled`. The data stays.

Claims work without jobs: a claim can list items by scanning them, or list
nothing at all (a delay). With **Projects, jobs and shipments** on as well, the
new-claim form offers a job and its lines, and each line's trip becomes part of
the evidence.

| Setting | Default | |
| --- | --- | --- |
| `CLAIMS_SLA_HOURS` | `240` | Hours from submission until a claim's decision is due (ten days). |
| `INCIDENT_SLA_HOURS` | `72` | The same for incident reports. |

## Using it

1. **Claims → New claim** (or **Report incident**). Pick the type, say what
   happened, and pick the **job**. Its lines load with the flagged ones
   (damaged, missing, refused, wrong shipment) ticked, each with the last note
   written against it and any claim it is already on. Scan or type codes to
   add anything else; while the form is open every scan is added. Save as a
   draft.
2. On the claim, **Evidence** under each line shows what was on file: the trip,
   photos before and after, condition notes, stage history, custody hops and
   audit ids. Put an estimate on each line (**Use the declared value** fills in
   the item's value), and describe the damage.
3. **Submit**. The evidence pack is fingerprinted and the decision clock starts.
4. A reviewer (see [who decides](#who-decides)) picks a **resolution** and an
   **approved** amount per line, then **Approves** or **Denies** with a note,
   and later **Marks paid** with the amount and a payment reference.
5. **Adjuster PDF** and **Spreadsheet** are on every claim, in every state.

An incident report is the same without amounts: **Close** is its decision.
**Open a claim from this** on an incident report starts a new claim with the
report's facts and a link back to it; the report itself stays as it was.

A claim taken down for someone else (a customer who phoned) records them as the
reporter, with the account that entered it in the history.

## Workflow

| From | To | Button | Note | Who |
| --- | --- | --- | --- | --- |
| draft | submitted | Submit | optional | anyone |
| draft | closed | Withdraw | required | anyone |
| submitted | under_review | Start review | optional | anyone |
| submitted | draft | Return to reporter | required | anyone |
| submitted | closed | Close | required | anyone |
| under_review | approved | Approve | required | reviewer or admin |
| under_review | denied | Deny | required | reviewer or admin |
| under_review | draft | Return to reporter | required | anyone |
| under_review | closed | Close | required | anyone |
| approved | paid | Mark paid | required | reviewer or admin |
| approved | under_review | Reopen | required | reviewer or admin |
| approved | closed | Close | required | anyone |
| denied | under_review | Reopen | required | reviewer or admin |
| denied | closed | Close | optional | anyone |
| paid | closed | Close | optional | anyone |
| closed | under_review | Reopen | required | reviewer or admin |

Incident reports never go to approved, denied or paid (`409
incident_no_money`); they close. The rules are pure functions in
`services/claims/workflow.ts` and the table above is served as
`GET /api/claims/meta` → `transitions`, so a screen can grey out a move before
trying it.

A move is refused with a code a script can act on:

| Code | Status | When |
| --- | --- | --- |
| `not_allowed` | 409 | Not on the table. The message lists where it can go. |
| `same_status` | 409 | Already there. |
| `note_required` | 400 | The move needs a note and none was given. |
| `lines_required` | 400 | Submitting a loss or damage claim with no lines. |
| `lines_undecided` | 409 | Approving while a line has no resolution, or no approved amount. |
| `amount_required` | 400 | Approving a claim without lines before an approved amount is entered. |
| `nothing_to_pay` | 409 | Marking paid when nothing was approved. |
| `incident_no_money` | 409 | Approving, denying or paying an incident report. |

Lines and amounts can be changed while a claim is draft, submitted or under
review. After a decision they are locked: reopen to change them. Only drafts
can be deleted, by whoever opened them or an administrator; a submitted claim
is part of the record and is closed instead.

### Who decides

Approving, denying, marking paid, reopening a decision, setting a line's
resolution or approved amount, and moving the deadline are for the **assigned
reviewer** or an **administrator**. The person who reported a claim cannot
decide it unless they are an administrator. Everything else is open to any
signed-in user and read-write API key.

Administrators assign anyone with an active account. Anyone else can **Take
it** when a claim is unassigned, or put down one assigned to them.

## Amounts

Integer cents throughout, in the instance currency at the time the claim was
opened (kept on the claim, so changing the setting later does not relabel old
claims). `services/claims/totals.ts` is the arithmetic, unit-tested:

- With lines, the claim's totals **are** the sums of its lines and cannot be
  typed in. Without lines (a delay, damage to a building) they are entered on
  the claim itself.
- The estimated total is the sum of the lines' estimates, or none when no line
  has one yet: an unpriced claim is not a claim for nothing.
- A **denied** line approves nothing, whatever amount was typed against it.
- A line is **decided** once it has a resolution (repair, replace, cash
  settlement, deny) and, unless denied, an approved amount.
- The approved total is empty until something is decided.
- Marking paid records the amount paid, the approved total unless another is
  given.

## Deadlines

Submitting sets `sla_due_at` to now plus `CLAIMS_SLA_HOURS` (or
`INCIDENT_SLA_HOURS`). A decision, or closing an undecided claim, stops the
clock; the claim then reads **decided in time** or **decided late**. Returning
a claim to its reporter clears the clock until it is submitted again; reopening
a decided claim starts a fresh window. The reviewer can move the deadline.

Every ten minutes each replica looks for submitted or under-review claims past
their deadline. Each one is stamped `sla_breached_at` in the same statement
that finds it, so it is announced exactly once, as a `claim.sla_breached`
event and a line in the claim's activity. Moving the deadline re-arms it. The
list's **Overdue** filter shows the ones still waiting.

## The evidence pack

`GET /api/claims/:id/evidence`. Built when asked for, from records nobody
edits from the claim, so it is read-only by construction. For each line:

| Part | From |
| --- | --- |
| **Trip** | The manifest line's stage history: when it was first packed, loaded, delivered and placed (a skipped rung counts as reached at the same moment), and each exception stage. |
| **Stage history** | Every stage change with time, stage, how (`scan`, `rfid`, `manual`, `portal`…), who, which device, which shipment, and its note. |
| **Photos and files** | Attachments on the item, on the unit (for a unit line), on the claim line itself, and those a condition report points at. Signature images are shown with their signatures, not as photos. |
| **Condition notes** | The manifest line's note, every note written with a stage change, photo captions, condition report notes and custody hand-off notes, oldest first. |
| **Condition reports** | When that feature is installed; see below. |
| **Chain of custody** | When that feature is installed; see below. |
| **Audit log** | Ids and hashes of the entries about the item and unit, and of the `job.stage_changed` entries that moved this line. |

Claim-wide: files attached to the claim, signatures recorded against its job or
shipment, the shipment's status history, and the claim's own audit entries.
`timeline` merges stage changes, condition reports, custody hops, shipment
milestones and the claim's own status changes into one story.

### Before and after

Each photo is placed **before**, **during** or **after** the trip. A stage it
was given decides first: `before`, `pack`, `packed`, `packing`, `pre`,
`pre_move`, `origin`, `pickup`, `label`, `survey` are before; `load`, `loaded`,
`loading`, `transit`, `in_transit`, `unload`, `unloading` are during; `after`,
`delivery`, `delivered`, `arrival`, `unpack`, `post`, `post_move`,
`destination`, `placed`, `damage`, `claim` are after. Otherwise its time
decides, against the line's own timestamps: before loading is before, from
loading until delivery is during, from delivery (or from the first exception
stage, when a line was flagged damaged before it was delivered) is after. With
no trip at all there is nothing to measure against and it is left undated.

### Fingerprint

`hash` is the sha256 of the pack's content in canonical JSON (the same
canonical form signatures use), leaving out the audit ids, the timeline and
account names, which only grow or can be renamed. Submitting stores it on the
claim (`evidence_hash`, `evidence_frozen_at`) and in the `claim.status_changed`
event, so the audit log holds a copy. The pack then says whether it is
`unchangedSinceSubmission`; a photo added later, or one deleted, changes it.
The PDF prints both.

### When things are deleted

A claim names its job, shipment, manifest lines, items and units by plain id,
not foreign key, and keeps a snapshot of each item's name, code and declared
value. Deleting a job therefore leaves the claim pointing at it: the claim
still says which job, and the lost stage history is **rebuilt from the
`job.stage_changed` events in the audit log**, which nothing deletes. (A bulk
read of more than 500 lines records the first 500 in its event, so a very large
batch may be recorded in part.)

Deleting an **item** deletes its photos within the hour (the attachment
sweep). The claim keeps its snapshot and its audit ids, but not the pictures:
download the PDF before deleting items that are on an open claim.

## Other features it reads

Condition reports, custody transfers and portal grants belong to features that
may not be installed. Their code is never imported: on each request the
evidence builder looks for their tables in the catalog (`to_regclass`), reads
whole rows as JSON (`to_jsonb(t)`) and normalizes each field from whichever of
its likely names is present (`services/claims/normalize.ts`, tested with
fixtures). A row that cannot be read is left out; a table whose shape is not
recognised is logged once (`claims.evidence.source_unreadable` or
`claims.evidence.source_failed`) and treated as absent. `GET /api/claims/meta`
→ `sources` says which were found.

| Table | Needs | Also reads, when present |
| --- | --- | --- |
| `condition_reports` | `id`, `item_id` | `unit_id`, `stage`, `rating`, `notes`, `ai_notes`, `defects` (jsonb `[{ area, type, severity, description }]`), `handling_note`, `attachment_ids` (uuid[] or jsonb), `created_by`, `created_at` |
| `custody_transfers` | `id`, and the items it moved: either rows in `custody_transfer_items` (`transfer_id` or `custody_transfer_id`, `item_id`, `unit_id`) or a column `items` / `item_ids` / `item_refs` (jsonb of ids or `{ itemId, unitId }`, or uuid[]) | `at` / `transferred_at` / `created_at`, `from_party` and `to_party` (text, or jsonb with `name`, `org`), `place_location_id`, `lat`, `lng`, `seal_numbers`, `condition_note`, `from_signature_id`, `to_signature_id`, `content_hash`, `audit_log_id` |
| `portal_grants` | `id`, `token_hash` (sha256 hex of the token, as for API keys) | `scope` and `scope_id`, or one of `shipment_id` / `job_id` / `project_id`; `role`, `grantee_name`, `grantee_email`, `grantee_org`, `expires_at`, `revoked_at`, `last_used_at` (touched on use) |

A condition report on an item counts for every line of that item; one on a
unit only for that unit's line. A custody transfer of the whole item counts for
each of its units, and a transfer of one unit counts for a claim on the item.

Delivery exceptions recorded at sign-off become manifest line stages
(`missing`, `damaged`, `refused`), which is what the new-claim form ticks: a
registered exception stage is flagged the same way as the built-in ones.

## Filing from the portal

With the portal feature installed (its `portal_grants` table exists), someone
holding a link scoped to a **shipment** or a **job** can file a claim on it:

| Method and path | |
| --- | --- |
| `GET /api/claims-portal/:token` | What the link can claim on: `{ grant: { name, org, scope, expiresAt }, scope, types, lines, claims }`. `lines` are that shipment's (or job's) manifest lines only; `claims` are those filed through this same link. |
| `POST /api/claims-portal/:token/claims` | `{ type, title?, description, occurredAt?, contactEmail?, lines: [{ jobItemId, damageDescription?, estimatedCents? }] }` → 201 `{ code, status, title, lines, currency, estimatedTotalCents, submittedAt }`. |

These are mounted before the session guard: the token is the credential. The
claim arrives **submitted**, with its evidence fingerprinted and its clock
running, reported by the grantee and attributed to the grant
(`reporter_grant_id`; in the audit log as a `system` actor with id
`portal-grant:<id>` and name "<grantee> (portal)", since the log's actor kinds
are fixed).

Answers: `404` for an unknown token, when no portal is installed, or when
claims are switched off; `410` for an expired or revoked link; `403` for a
project-wide link (a claim has to name a delivery); `400` when a line is not on
the granted shipment or job, reported as if it did not exist; `429` past 60
reads a minute or 5 claims per ten minutes from one address on one link.
Nothing about reviewers, amounts decided, comments or other claims is
returned.

**For the portal's page:** `client/src/features/claims` exports
`PortalClaimPanel` (lazy): `<Suspense><PortalClaimPanel token={token} /></Suspense>`
renders the form and the link's own claims, sends no cookie, and renders
nothing when claims are unavailable for that link.

## Documents

- `GET /api/claims/:id/claim.pdf?tz=`: Letter portrait. Header with code, type,
  status and a QR of the claim page; the facts (job, shipment, when, where,
  reporter, reviewer, deadline, references); estimated, approved and paid
  totals; what happened; the evidence fingerprint; the lines with estimated and
  approved amounts; then per line its trip, condition notes, reports, custody
  hops, **photos before and after** (up to four of each and two others per
  line, sixty in all, redrawn at 640 px), stage history and audit ids; files on
  the claim; signed records; the timeline. A photo the image decoder cannot
  read (HEIC) prints as a box pointing at the file.
- `GET /api/claims/:id/claim.xlsx?tz=`: sheets Summary, Lines (amounts as
  numbers with a total row), Evidence (every photo with a link, every note and
  hop), Timeline and Audit log.

Each download is recorded in the claim's activity and published as
`claim.exported`: an adjuster pack leaving the building is worth knowing about.

## Events

All with subject `claim`, and `data` carrying `code`, `type`, `status`,
`title`, `jobId`, `shipmentId`, `currency`, `estimatedTotalCents`,
`approvedTotalCents`, `paidTotalCents` and `assignee` alongside:

| Type | When | Extra `data` |
| --- | --- | --- |
| `claim.created` | Opened (by a person, a key or a portal link) | `lines`, `reporter` |
| `claim.updated` | Details edited | `changed` (field names) |
| `claim.status_changed` | Any move in the workflow | `from`, `to`, `note`; on submission `evidenceHash`, `slaDueAt` |
| `claim.assigned` | Reviewer changed | `from`, `to`, `toName` |
| `claim.commented` | A comment | `commentId`, `body` (up to 2,000 characters) |
| `claim.lines_changed` | Lines added, edited or removed | `added`, `updated`, `removed`, `lineId?`, `fields?` |
| `claim.exported` | PDF or spreadsheet downloaded | `format` |
| `claim.sla_breached` | Past its decision deadline undecided | `dueAt` |

Every row of the claim's activity records the audit-log id it was published as
(`auditLogId`), shown on the claim page.

## HTTP API

All under `/api`, with a session or API key; read keys get the `GET`s. Ids that
are not UUIDs answer 404. Amounts are integer cents.

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/claims/meta` | Types, statuses, resolutions, incident categories, transitions, SLA hours, which optional sources exist, whether jobs are on, the currency |
| GET | `/claims/reviewers` | Active accounts: `[{ userOid, name }]` |
| GET | `/claims/candidates` | `?jobId=&shipmentId=`: the job's lines, flagged first, each with its last note, declared value and open claims |
| GET | `/claims` | `?status=a,b&type=&kind=claim\|incident&jobId=&shipmentId=&assignee=me\|none\|<oid>&q=&overdue=true&limit=&offset=` → `{ claims, total }`, newest first, each with `sla` and `lineCount` |
| POST | `/claims` | `{ type, title, description?, category?, jobId?, shipmentId?, locationId?, occurredAt?, carrierReference?, insurerReference?, estimatedTotalCents?, reporterName?, reporterEmail?, relatedClaimId?, lines?: [line] }` → 201, the claim. A line is `{ jobItemId? \| itemId?+unitId? \| code?, description?, damageDescription?, estimatedCents?, notes? }`. Lines that cannot be resolved fail the whole request with `400 line_problems` and `details.problems`. With no `jobId`, lines all from one job set it (and their shipment, when they share one). |
| GET | `/claims/:id` | The claim with `lines`, `activity`, `totals`, `sla`, `transitions` open from here, and `viewer: { canDecide, decideRefusal }` |
| PATCH | `/claims/:id` | Any create field except lines, plus `approvedTotalCents`, `paymentReference`, `slaDueAt` |
| DELETE | `/claims/:id` | Drafts only; 204 |
| GET | `/claims/:id/evidence` | The evidence pack |
| POST | `/claims/:id/lines` | `{ lines: [line] }` → `{ added, alreadyOnClaim, problems, claim }`. A scanned item on the claim's job is matched to its manifest line. |
| PATCH | `/claims/:id/lines/:lineId` | `{ description?, damageDescription?, estimatedCents?, approvedCents?, resolution?, notes? }` → the claim |
| DELETE | `/claims/:id/lines/:lineId` | → the claim |
| POST | `/claims/:id/status` | `{ status, note?, paidTotalCents?, paymentReference? }` → the claim |
| POST | `/claims/:id/assign` | `{ userOid: string \| null }` or `{ me: true }` → the claim |
| POST | `/claims/:id/comments` | `{ body }` → 201, the activity row |
| GET | `/claims/:id/claim.pdf`, `/claim.xlsx` | `?tz=` |

Photos and documents are attached with the attachments API
(`docs/media-ai-core.md`) as owner type `claim` (quotes, receipts, photos
taken when it was reported) or `claim_line` (close-ups of one item's damage);
the evidence pack picks both up.

## Data model

Migration `server/migrations/0037_claims.sql`; Drizzle tables in
`server/src/db/tables/claims.ts`.

| Table | Holds |
| --- | --- |
| `claims` | code (`CLM-…` for claims, `INC-…` for incident reports, Crockford base32 like asset codes), type, category (incidents), status, title, description, job, shipment, location, occurred at, reporter (account, portal grant, name, contact), reviewer, currency, estimated, approved and paid totals, carrier, insurer and payment references, submitted, decided, paid and closed at, deadline and breach stamp, evidence fingerprint, metadata |
| `claim_lines` | claim, position, manifest line and its job, item, unit, snapshot of name, code and declared value, description, damage, estimated and approved amounts, resolution, notes. An item (or one unit) is on a claim once. |
| `claim_activity` | created, comment, status (from, to, note), assignment, lines, update, export and sla rows, with author (account or grant) and the audit-log id |

Only `claims.location_id` and the claim's own children are foreign keys; see
[when things are deleted](#when-things-are-deleted).

All three tables are in the instance backup (Settings → Backup). Attachments
on claims are not, as for every attachment; back up Postgres and `DATA_DIR`.

## Testing

```bash
pnpm test                       # pure rules: totals, transitions, deadlines, trip, normalizers
createdb bindex_claims_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_claims_test \
  pnpm --filter bindex-server exec tsx --test tests/claims-db.test.ts
```

The database suite runs the acceptance flow (a delivered, damaged line whose
claim shows its pack-day photo and notes with nothing attached by hand), the
workflow and its permission rules, incidents, the deadline watcher, job
deletion, the backup, and both the absent and present paths of the optional
features, using minimal stand-in tables created in the test database and
dropped afterwards (skipped where the real tables exist).

## Code map

```
server/migrations/0037_claims.sql
server/src/db/tables/claims.ts
server/src/services/claims/
  index.ts        public surface; registers owner types and event types
  model.ts        types, statuses, resolutions, categories (pure)
  totals.ts       the arithmetic (pure)
  workflow.ts     transitions, clock stamps, SLA state (pure)
  trip.ts         trip from stage history, before/after placement (pure)
  normalize.ts    reading other features' rows (pure)
  shared.ts       codes, who may decide
  sources.ts      finding and querying optional tables
  evidence.ts     the evidence pack and timeline
  claims.ts       claims, lines, workflow, reviewer, comments, pickers
  portal.ts       filing through a portal grant
  sla.ts          the deadline watcher
  events.ts       publishing to the audit log
  documents.ts pdf.ts xlsx.ts
  owners.ts backup.ts
server/src/routes/claims.ts      /api/claims and /api/claims-portal
client/src/features/claims/      screens, API client, types, portal panel
server/tests/claims.test.ts      pure logic
server/tests/claims-db.test.ts   Postgres (opt-in)
```
