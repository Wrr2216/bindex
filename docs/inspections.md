# Site inspections

A building is inventoried like anything else. A **pre-move inspection**
records the condition of a site before the crew starts: scuffed walls, dented
doors, cracked floor tiles, a bent dock leveler, a scratched elevator car. A
**post-move inspection** records it again once the work is done, and is
**compared** with the pre-move one, so damage the move caused stands out from
damage that was already there. Both are **signed** by the facility contact and
the crew lead, printed as a **PDF report**, and can be **shared** with someone
without an account through a link that runs out.

Everything here is behind one instance switch, **Site inspections**
(`features.inspections`, off by default). With it off, the Inspections
navigation entry and its screens are gone, every `/api/inspections` request
answers `404 feature_disabled`, and share links stop working.

- [Using it](#using-it)
- [How the comparison works](#how-the-comparison-works)
- [Signing and verifying](#signing-and-verifying)
- [Share links](#share-links)
- [Jobs](#jobs)
- [AI](#ai)
- [HTTP API](#http-api)
- [Events](#events)
- [Data model](#data-model)
- [For other features](#for-other-features)

## Using it

1. **Inspections → New inspection.** Pick the kind:
   - **Pre-move**, before the move starts;
   - **Post-move**, once it is done. It is compared with the latest pre-move
     inspection of the same site (preferring one on the same job) unless you
     pick another;
   - **Site**, an inspection on its own.

   Pick the site from your locations, or type its name. With a job, the site
   defaults to the job's origin for a pre-move inspection and its destination
   for a post-move one, and there are buttons for both: a relocation usually
   inspects both buildings, before and after.
2. **Walk the site.** For each thing worth recording, either
   - **Add damage by AI**: take one photo. The model says inside or outside,
     which room, the exact spot (wall, floor, baseboard, trim, door, frame,
     ceiling, window, elevator, dock, stairs, fixture, other), a plain
     description and a severity. The form opens filled in; change anything and
     save. If the model cannot help, the form opens empty with the photo
     attached. Nothing is saved until you press Save.
   - **Enter manually**: the same form, in the same order (where, room, spot,
     details, severity, photos).

   The room field suggests every location below the site ("Floor 3 /
   Kitchen") and every room already written at this site, so the same room is
   spelled the same way before and after. The next finding starts in the room
   of the last one. An inspection with no findings is a valid result: "no
   damage found" is worth signing.
3. **Complete inspection.** Findings lock, and the job's matching task closes.
4. **Sign-off.** The facility contact and the crew lead each sign on the
   device (name, role, drawn signature). With both signatures in, the
   inspection is **signed**.
5. **Report PDF**, or **Share the report** for a read-only link.

**Reopen** unlocks the findings. Signatures already collected stay, and each
shows "Changed since signing" if what it covered is then edited; completing it
again without a change makes them count again.

Only an administrator can delete a signed inspection, or a pre-move inspection
that a completed post-move inspection is compared with.

## How the comparison works

Each finding of the post-move inspection is paired with at most one finding of
the pre-move inspection, and every finding lands in one of four groups:

| Group | Meaning |
| --- | --- |
| **New damage** | A post-move finding with no pre-move counterpart. Shown first, in red, on screen, in the PDF and on the share page. |
| **Worse than before** | Paired, and the post-move severity is higher (minor < moderate < major). |
| **Recorded before, not found after** | A pre-move finding nothing paired with: repaired, or missed on the way out. |
| **Unchanged** | Paired, same or lower severity. Also a post-move finding marked "Already there before the move" that has no pre-move counterpart: damage the facility contact pointed out that the pre-move inspection missed. It is not counted as new. |

Pairs are decided in this order, each step claiming findings the later ones
cannot:

1. **A person's choice.** On a draft post-move inspection, each finding has a
   "Pair automatically / Not in the pre-inspection / Same as pre #n" picker.
2. **An AI pair.** "Match the rest with AI" asks a language model about the
   findings still unpaired, which catches "Boardroom" before and "Conference
   room" after, or "trim" against "baseboard". Its pairs are stored on the
   finding, need a confidence of at least 0.6, and can be undone with the
   picker. Running it again reconsiders its earlier pairs, never a person's.
3. **Same room and same spot.** Two findings are in the same room when they
   name the same location record, or when their names agree once case,
   punctuation and filler words ("Room", "the") are dropped. "Room 3.12" and
   "3.12" agree; "Room 101" and "Room 102" do not. A location path such as
   "Floor 3 / Kitchen" also agrees with free text "Kitchen". When several
   findings share a room and spot, the most similar descriptions pair first.

Steps 1 and 2 are stored; step 3 is recomputed on every read and is
deterministic, which is what lets a signature cover the comparison.

The logic is `compareFindings` in `server/src/services/inspections/pairing.ts`,
tested in `server/tests/inspections.test.ts`.

## Signing and verifying

Signatures use the shared signing from [attachments and signatures](media-ai-core.md):
the signer's name, role, email, the statement they agree to, the drawn image,
and the sha256 of the canonical JSON of what they signed.

What is signed is built by the server from the record
(`GET /api/inspections/:id/sign-request`), and the server checks the signature
against the record again before it fills a sign-off slot, so a signature made
on a draft, or while someone edited a finding, does not count. The signed
content (`buildSignContent` in `content.ts`) is:

- the inspection: code, kind, the site as named, its location and job ids, the
  pre-inspection it is compared with, inspectors and notes;
- every finding: area, room, location, spot, exact spot, description,
  severity, pre-existing flag, and the sha256 of each photo;
- for a post-move inspection, the comparison: every pair and its group, with
  the pre-move finding's severity and description.

Timestamps and status are left out on purpose, so reopening and completing
again without a change keeps signatures valid, while editing a finding,
deleting or replacing a photo, or reopening and editing the pre-move
inspection a post-move one is compared with, all show as "Changed since
signing" everywhere the signature appears: the screen, the PDF and the share
page. The PDF prints the current content fingerprint under the signatures.

The statements, per role:

> I have reviewed this post-move inspection of *site*. Signing for the facility
> (or: for the crew), I agree that it records the condition of the site after
> the move, and the comparison with the pre-move inspection, including every
> finding and photo listed.

## Share links

**Share the report** creates a read-only link that lasts 1 to 90 days (14 by
default). It opens a page with the whole report and its photos, and a PDF
download, with no sign-in and no script. Links can be copied again while they
work and withdrawn at any time; the screen shows how often each was opened.

- The token is `<share id>.<expiry>.<MAC>`: the MAC is HMAC-SHA256 over the id
  and expiry, keyed with a key derived from `SESSION_SECRET`, truncated to 144
  bits. A changed id or expiry, or a token signed with another key, is refused
  before the database is asked. **Rotating `SESSION_SECRET` invalidates every
  link**, which is the right failure for a leaked secret.
- The expiry in the token must match the stored link, and a withdrawn link
  answers `410`, as does an expired one ("This link has expired. Ask the person
  who sent it for a new one."). An unknown token answers `404`.
- Only the files the report shows can be fetched through a link: the photos of
  its findings (and of the pre-move findings it is compared with) and the
  signature images.
- Pages are sent with `Cache-Control: private, no-store`, `X-Robots-Tag:
  noindex` and `Referrer-Policy: no-referrer`. The link carries the sender's
  time zone (`?tz=`) for the times it prints.
- Requests are limited to 300 a minute per address.

This is deliberately small. The external portal (T15) may absorb it later into
its own access grants.

## Jobs

When the jobs feature is on, an inspection can belong to a job:

- A new inspection claims the job's first open task of the matching kind
  (`pre_inspection` or `post_inspection`) that no other inspection has claimed,
  or the one you name, and moves it to *doing*.
- **Completing** the inspection marks that task *done*. An inspection with a
  job but no claimed task closes every open task of its kind with
  `completeTasksByKind`. An ad hoc inspection closes nothing.
- **Reopening** moves a done task back to *doing*.

Deleting the job keeps the inspection (it is evidence about a building) and
clears its job link. The same goes for deleting its location.

## AI

Both AI helpers are optional and follow the shared setup in
[attachments and signatures](media-ai-core.md#setting-up-vision-and-transcription).
When unconfigured, their buttons are not shown and everything works by hand.

| Button | Needs | What is sent |
| --- | --- | --- |
| Add damage by AI | a vision model (`LLM_VISION_MODEL`, or an `LLM_MODEL` that takes images) | One photo, redrawn at most 1600 px, the site's name, whether it is before or after the move, and up to 80 known room names |
| Match the rest with AI | a language model (`LLM_API_KEY`) | Text only: up to 60 unpaired findings from each side (room, spot, severity, description) |

Both are limited to 20 calls a minute per person. Replies are normalized by
pure functions (`normalizeDamageReading`, `normalizeAiMatches`) that accept
what models actually send: wrapped objects, spot words such as "skirting" or
"door jamb", severities such as "cosmetic" or "severe", confidences as 0.8,
"80%" or "high". A room the model names is snapped to a known room when exactly
one matches, which is what makes before and after pair up. Tests run against
the local stub (`server/tests/inspections-ai.test.ts`).

## HTTP API

All under `/api/inspections`, behind the usual session or API key (read keys
get the `GET`s). Deleting a signed inspection needs an administrator's browser
session.

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/meta` | Kinds, statuses, areas, spots, severities, sign-off roles, share limits, `ai: { vision, languageModel }` |
| GET | `/` | `?jobId=&locationId=&kind=pre\|post\|adhoc&status=draft\|completed\|signed&q=&limit=`; each with `jobCode`, `jobName`, `preCode`, `findingCount` |
| POST | `/` | `{ kind, locationId?, siteName?, jobId?, jobTaskId?, preInspectionId?, inspectors?, notes? }` → the detail |
| GET | `/:id` | The detail: the inspection, `job`, `task`, `location`, `preInspection`, `findings` (with `number` and `photos`), `preFindings`, `rooms`, `comparison`, `signatures` (each with `verification` and `role`), `editable` |
| PATCH | `/:id` | Same fields as POST except `kind` (draft only). Changing the pre-inspection clears stored pairs. |
| DELETE | `/:id` | 204 |
| POST | `/:id/complete` | Locks findings, closes the job task |
| POST | `/:id/reopen` | Back to draft |
| POST | `/:id/findings` | `{ area?, room?, locationId?, spot, spotDetail?, description, severity?, preExisting?, aiGenerated?, aiSuggestion?, attachmentIds? }` (draft only) |
| PATCH | `/:id/findings/:findingId` | Same fields. Photos dropped from a finding are deleted if they were taken for it. |
| DELETE | `/:id/findings/:findingId` | 204 |
| POST | `/:id/findings/:findingId/pair` | `{ preFindingId: id \| null }` (null: "not in the pre-inspection") or `{ auto: true }` |
| GET | `/:id/comparison` | `{ preInspection, comparison }` |
| POST | `/:id/ai/damage` | `{ attachmentId }` → `{ available, suggestion, message? }`. Saves nothing. |
| POST | `/:id/ai/match` | → `{ available, considered, paired, preInspection, comparison }` |
| GET | `/:id/sign-request?role=facility_contact\|crew_lead` | `{ ownerType, ownerId, role, statement, content }` for `POST /api/signatures` |
| POST | `/:id/signoffs` | `{ role, signatureId }` → the detail. `409 content_changed` if the signature does not match the record now. |
| GET | `/:id/report.pdf` | `?tz=` for printed times; `&download=1` to download |
| GET | `/:id/shares` | Every link, with `active`, `openCount`, `lastOpenedAt`, and `token`, `path`, `url` while it works |
| POST | `/:id/shares` | `{ days? }` (default 14, at most 90) → the link |
| DELETE | `/:id/shares/:shareId` | Withdraws it |

Photos are uploaded with the shared attachments API, owned by the inspection:

```bash
curl -X POST --data-binary @dent.jpg -H 'Content-Type: application/octet-stream' \
  "$URL/api/attachments?ownerType=inspection&ownerId=$ID&stage=finding&type=image/jpeg"
```

Stage `finding` marks a photo taken for a finding (the screens use it; such a
photo is removed when no finding shows it any more). The "Site photos" gallery
on the inspection uses stage `overview`.

Share links, with no sign-in:

| Method | Path | |
| --- | --- | --- |
| GET | `/api/share/inspections/:token` | The report as a page. `?tz=` |
| GET | `/api/share/inspections/:token/report.pdf` | The PDF |
| GET | `/api/share/inspections/:token/files/:attachmentId` | A photo or signature the report shows; `?w=64..1024` for a JPEG preview |

## Events

Published to the audit log and webhooks (see [events](event-backbone.md)),
subject `inspection`. Every event's data has `code`, `kind`, `status`, `site`
and `jobId`, plus:

| Type | When | Extra `data` |
| --- | --- | --- |
| `inspection.created` | Started | `preInspectionId`, `jobTaskId` |
| `inspection.finding_added` | A finding was recorded | `findingId`, `room`, `spot`, `severity`, `aiGenerated`, `photos` (count) |
| `inspection.finding_updated` | Changed, or paired by hand | `findingId`, `changed` (field names), and for pairing `pairedWithId`, `pairing` |
| `inspection.finding_removed` | Removed | `findingId`, `room`, `spot`, `description` |
| `inspection.completed` | Completed | `findings` (count), `comparison` (the four counts, post-move only), `completedTaskIds` |
| `inspection.reopened` | Reopened | `previousStatus` |
| `inspection.signoff_added` | A sign-off slot was filled | `role`, `signatureId`, `signerName`, `contentHash` |
| `inspection.signed` | Both sign-offs are in and valid | `facilitySignatureId`, `crewSignatureId`, `contentHash`, or `reused: true` when signatures from before a reopen still hold |
| `inspection.deleted` | Deleted | |
| `inspection.share_created` | A share link was created | `shareId`, `expiresAt` |
| `inspection.share_revoked` | A share link was withdrawn | `shareId` |

Task changes also appear as `job.task_status_changed`.

## Data model

Migration `server/migrations/0034_inspections.sql`; Drizzle definitions in
`server/src/db/tables/inspections.ts`.

| Table | Holds |
| --- | --- |
| `inspections` | code `INS-…`, kind `pre\|post\|adhoc`, status `draft\|completed\|signed`, job and job task, location and `site_name` (the site as named when it started, so renaming a location changes no report), the pre-inspection a post-inspection is compared with, inspectors, notes, the two sign-off signature ids, who and when for start, completion and signing, metadata |
| `inspection_findings` | inspection, sequence, area `inside\|outside`, room (text) and optional location, spot, exact spot, description, severity `minor\|moderate\|major`, `ai_generated` and the model's original `ai_suggestion`, `pre_existing`, `attachment_ids`, and on a post finding the stored pair (`paired_with_id`, `pair_source` `ai\|manual`) |
| `inspection_shares` | inspection, expiry, who created it, when revoked, open count and last opened |

Photos and signature images are T02 attachments owned by the inspection
(owner type `inspection`, registered with the orphan sweep); signatures are T02
signatures on the same owner. Spots are checked only for shape in the
database; the list is in `services/inspections/model.ts`, so adding one needs
no migration.

**Backups.** `inspections` and `inspection_findings` are in the JSON backup.
Share links are left out, like API keys, since they grant access; a restore
keeps the current links of every inspection that still exists. Photos and
signatures follow T02's rules: back up Postgres and `DATA_DIR`. As with jobs,
restoring a file written before inspections existed clears them.

## For other features

Import from `server/src/services/inspections`.

- `compareFindings(pre, post)` and `buildReport(id)`: a claim (T16) can take a
  post-move inspection's new damage, with photos, as evidence.
- `renderShareHtml`, `openShare`, `reportFileIdsFor`: what a portal (T15)
  needs to show a report under its own access rules instead of a share link.
- `inspectionPdf(id, tz)` for a document packet (T17).
- The events above for notifications.

## Code map

```
server/migrations/0034_inspections.sql
server/src/db/tables/inspections.ts
server/src/services/inspections/
  index.ts        public surface, PDF image loading, the AI entry points
  model.ts        kinds, spots, severities, labels, sign-off statements (pure)
  pairing.ts      the comparison (pure)
  ai.ts           prompts and reply normalization (pure), readDamage, matchWithAi
  content.ts      what a signature covers (pure)
  inspections.ts  lifecycle, findings, pairing overrides, sign-offs, job tasks
  report.ts       the report model shared by the PDF and the share page
  pdf.ts html.ts  the two renderers (pure)
  share.ts        share-link tokens and rows
  events.ts       event types
  backup.ts       tables in the instance backup
server/src/routes/inspections.ts             /api/inspections and /api/share/inspections
client/src/features/inspections/             screens, API client, types
server/tests/inspections.test.ts             pairing, AI normalization, tokens, content, renderers
server/tests/inspections-ai.test.ts          AI calls against the local stub
server/tests/inspections-db.test.ts          a full pre/post cycle on Postgres (opt-in)
```

## Testing

```bash
pnpm test        # pure logic and the AI stub, no database needed
createdb bindex_inspections_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_inspections_test \
  pnpm --filter bindex-server exec tsx --test tests/inspections-db.test.ts
```
