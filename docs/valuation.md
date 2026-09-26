# Valuation, declarations, receipts and warranty

What things are worth and how that is known; signed declarations of
high-value items; receipts matched to the items they bought; warranties and
scheduled service with reminders; and a valuation report for insurers and
asset registers.

> **AI values are estimates.** "Estimate from photos" asks a vision model to
> identify an item and suggest a value range. The model sees only the photos,
> can misidentify a model, and has no access to live prices. Every estimate is
> reviewed and confirmed by a person before it is saved, is labelled "AI
> estimate" wherever it appears (item page, declarations, the report), keeps
> the model's own confidence, and never replaces an appraisal. Treat it as a
> starting point for a declared value, not as evidence of one.

- [Using it](#using-it)
- [How receipt matching works](#how-receipt-matching-works)
- [Declarations and signatures](#declarations-and-signatures)
- [Reminders](#reminders)
- [The valuation report](#the-valuation-report)
- [Setting it up](#setting-it-up)
- [Data, backups and restores](#data-backups-and-restores)
- [HTTP API](#http-api)
- [Events](#events)
- [Server APIs for other features](#server-apis-for-other-features)
- [Limits and follow-ups](#limits-and-follow-ups)

## Using it

The instance switch **Valuation and warranty** (Settings, `valuation`, on by
default) adds a **Valuation** screen to the navigation and a **Value and
warranty** panel to every item page. Switched off, both disappear, the
`/api/valuation` routes answer 404 `feature_disabled`, and no reminders go
out. The data stays.

### On an item

- **Value** is the item's current value, where it came from (AI estimate,
  receipt, web price, appraisal, entered by hand) and when. Every value ever
  recorded is kept: **Value history** lists them newest first, each with the
  value before it, who recorded it and on what basis.
- **Estimate from photos** (only when a vision model is configured): take or
  pick up to six photos of the item. The model returns brand, model, category,
  materials, condition, visible wear, a one-line description, and a value range
  with the reasoning behind it and a confidence. Every field is editable; the
  suggested value is the middle of the range. When web search is configured,
  the current web price is looked up alongside for comparison, and **Use web
  price** records that instead. **Confirm value** saves it; the photos (kept as
  the item's attachments with stage `valuation`) and the full estimate are
  stored with the valuation as its evidence. Optionally the brand and model
  are saved onto the item.
- **Record value** records one by hand, from an appraisal or a price seen
  elsewhere, with a date and a basis.
- **High value**: a record at or over the instance threshold is high value
  automatically; *Always* and *Never* override that per item or unit.
- **Purchase, warranty and hour meter**: purchase date, price paid and
  vendor; warranty end date, provider and terms; and an hour-meter reading
  for equipment serviced by hours of use. Receipts fill these in (below).
- **Book value**: straight-line depreciation from the purchase date (see
  [the report](#the-valuation-report)).
- **Service**: plans that recur every so many days, every so many hours of
  use, or both (due at whichever comes first). Each shows what is due and
  when; **Log service** records the work (date, meter reading, cost, notes)
  and moves the next due point. A plan counted in hours needs the meter
  reading when service is logged.
- **Receipts** and **Declarations** that name the item are listed with links.

An item with tracked units is valued unit by unit, picked with the chips at
the top of the panel; the item's own value is the total of its units, as it
already is everywhere else, so recording a value on the item itself is
refused with a message saying to pick a unit.

### The Valuation screen

- **Overview**: total and high-value totals, how many current values are AI
  estimates, warranty and service due, the most valuable high-value records,
  and what was valued recently. Administrators can **Send reminders now**.
- **Declarations**: start one for a location (and everything inside it), a
  group, or a job reference, optionally filled with every high-value record
  in it; the list of existing ones.
- **Receipts**: start one and the list.
- **Report**: download the valuation report as PDF or XLSX.

### Receipts

1. **New receipt** (or **Add receipt** on an item page, which offers that item
   first when matching).
2. Take a photo of the receipt, or upload the photo or PDF.
3. **Read with AI** reads vendor, date, currency, every line (description,
   quantity, unit price, line total, product code, serial, and any warranty
   or protection plan in months), subtotal, tax and total. Arithmetic that
   does not add up, and a printed date that is not a real date, are listed as
   warnings. Without a vision model, type the lines instead.
4. Check the header and lines, **Save changes**, and pick for each line which
   item it bought: a proposal (with the reason, such as "Serial 7XK2P93
   matches"), another item found by name, a new item created from the line, or
   nothing.
5. **Confirm and save on items**. Every matched item or unit gets the
   purchase date, price paid and vendor, a link to this receipt, and, when a
   line states one, a warranty end date counted from the purchase date.
   Ticking **Also record the price paid as its value** adds a valuation with
   source `receipt`, dated the purchase date. A new item created from a line
   gets the price as its value.

The receipt file is stored once, as an attachment of the receipt, and every
item it is matched to links to it rather than holding a copy. A confirmed
receipt is read-only apart from its notes, and only an administrator can
delete it (items keep their purchase facts and lose the link).

Numeric dates such as `03/02/2024` are read month-first or day-first by the
instance locale (Settings → Locale), unless one of the numbers settles it
(`31/01/2024`). The date as printed is shown next to the date field.

Price paid: for a line matched to a unit, the unit price; for a line matched
to an item, the line total (quantity × unit price), since an item's value is
the value of all of it. When several lines go to the same record (a laptop and
its protection plan), the record's purchase price comes from the dearest of
them and its warranty from the longest term any of them states.

## How receipt matching works

Candidates come from exact hits on a line's serial or product code (serial,
SKU, UPC and asset-tag identifiers, unit serials, model numbers) and from the
closest names by trigram similarity. Each is scored on its strongest evidence:

| Evidence | Score |
| --- | --- |
| The line's serial is the item's (or a unit's) serial | 1.00 |
| A serial on file appears in the line's text | 0.95 |
| The line's product code is a SKU or UPC on file | 0.90 |
| The line's product code is the model number | 0.85 |
| The model number appears in the line's text | 0.80 |
| The names are alike (trigrams, and abbreviated words such as "LAT" for "Latitude") | up to 0.75 |

Up to three candidates of at least 0.30 are offered per line. One is
pre-selected when it scores at least 0.45, best evidence first across the
whole receipt, and a record is pre-selected for at most one line. A person
confirms or changes every line; nothing is saved by the proposal itself.

## Declarations and signatures

A high-value declaration (`HVI-00001`, numbered in order) lists items and the
value declared for each, with brand, model, serial, asset code, condition,
materials and description, and where each value came from. Lines added from
items are filled from the item, its current value and its newest AI
description; declared values can be changed on a draft (the source then shows
as "Entered").

**Review and sign** opens the shared signature dialog: the signer's name,
role and email, the statement they agree to (it names the declaration, the
number of items and the total, and says AI estimates are estimates when any
line is one), and their drawn signature. The signature covers a canonical JSON
of the declaration: code, title, scope, currency, notes, and every line's
declared facts and value, in line order, and the total. Once signed:

- the declaration is read-only and cannot be deleted;
- a `declaration.signed` event is written to the tamper-evident audit log,
  and its entry number is kept on the declaration and printed on the PDF;
- the page and the PDF say whether the declaration still matches what was
  signed. Any change to a declared fact after signing, including a direct
  edit in the database, shows as "no longer matches what was signed".

A signature made while the declaration was being edited elsewhere is refused
("The declaration changed while it was being signed"). Each line is a
snapshot: changing or deleting the item later does not change what was
declared. The PDF shows current item photos next to the declared facts.

Declaration scopes are a location (including the locations inside it), a group
(`company`), or a job. Jobs are not a record in this build, so a job-scoped
declaration carries the job reference as text; see
[Limits](#limits-and-follow-ups).

## Reminders

An hourly check (the first a few minutes after start) announces:

- **warranties** ending within the reminder window (Settings → Valuation and
  warranty, default 30 days), once per warranty end date;
- **service** that is due soon or overdue, once per due point. "Soon" is
  within a number of days (default 14) for calendar plans, or within a share
  of the interval (default 10%) for plans counted in hours.

Each announcement is a `warranty.expiring` or `service.due` event, which
webhooks and the polling feed deliver, and one notification digest per check
through Pushover and Wazuh when configured (and not turned off in the
valuation settings). The digest lists what is newly due and how many others
are still open. Logging service moves the due point, so the next one is
announced in turn. Every replica runs the check; an advisory lock lets one
run at a time and the "announced" markers are written in the same
transaction, so nothing is sent twice.

## The valuation report

Valuation → Report, or `GET /api/valuation/report`. Filter by location
(including everything inside it) and group, group by location or group,
optionally high-value only, as of any date. One row per item, or per unit for
an item with tracked units (each unit has its own serial, value and place):

photo, name, brand, model, category, serials, status, quantity, condition,
materials, purchase date, vendor, purchase price, value, when and how it was
valued (with the AI confidence for estimates), useful life, age, book value,
high value, warranty end, and a link to the item.

**Depreciation** is straight line: `book = cost − (cost − salvage) × min(1,
age ÷ life)`, where cost is the purchase price (or the recorded value when no
price is on file), age runs from the purchase date to the report date in
years of 365.25 days, life is the category's useful life (Settings, matched
without regard to case) or the default (5 years), and salvage is a percentage
of cost (default 0). Records without a purchase date have no book value.

The PDF is US Letter with a summary, a section per group with subtotals, and
a footnote on depreciation and AI estimates. The XLSX has a **Records** sheet
(numbers as numbers, currency formatted, a filter row, frozen header, a small
photo per row) and a **Summary** sheet by group. Photos are taken from the
unit's photos, the item's main photo when it is stored here, or its newest
photo attachment; remote image URLs are never fetched. Past 400 photos, rows
go without, to keep the file a size someone can email.

## Setting it up

Nothing is required: without AI, values, receipts (typed in), declarations,
warranty, service, reminders and the report all work.

| For | Needs |
| --- | --- |
| Estimate from photos, Read with AI | A vision model: `LLM_API_KEY` and `LLM_VISION_MODEL` (see [media-ai-core](media-ai-core.md#setting-up-vision-and-transcription)). Each estimate or receipt read is one request; both share a limit of 20 per minute per person. |
| Web price next to an estimate | `BRAVE_API_KEY` and a language model, as for the existing price lookup. |
| Reading PDF receipts | `pdftoppm` (poppler-utils) on the server's PATH. The Docker image installs it. Without it PDFs are stored and typed in by hand; photos of receipts are read either way. The first three pages are read, at 150 dpi. |
| Reminder notifications | Pushover or Wazuh, as for other alerts ([alerting](alerting.md)). Events go to webhooks regardless. |

Administrator settings are under **Settings → Valuation and warranty**:
high-value threshold (default 2,500.00 in the instance currency; 0 turns
automatic marking off), warranty reminder window, service "due soon" window in
days and as a share of an hour interval, default useful life, salvage
percentage, useful life per category, and whether reminders go out as
notifications. They are stored in the database (`app_settings` key
`valuation.settings`) and take effect without a restart.

Values are in the instance currency. An estimate that comes back in another
currency is flagged in the review and is not converted.

## Data, backups and restores

Migration `0040_valuation.sql` adds:

| Table | Holds |
| --- | --- |
| `valuations` | Every value recorded: value, previous value, source, basis, confidence, range, date, and the evidence as JSON. Never updated. |
| `valuation_profiles` | Purchase, warranty, high-value override and hour meter, one per item and one per unit. |
| `service_plans`, `service_records` | Plans and the log of work done. |
| `receipts`, `receipt_lines` | Receipts, their lines and what each line was matched to. |
| `hv_declarations`, `hv_declaration_lines` | Declarations and the declared snapshot of each line. |

Item-scoped tables cascade with their item or unit. Receipt and declaration
lines link to items without a foreign key and keep a snapshot, so a signed
declaration outlives the item it names.

All eight tables are in the JSON backup and are restored with it. A backup
written before this feature leaves valuation data alone: values, profiles and
service of items that exist after the restore are kept. Receipt files,
declaration signatures and their images are attachments and signatures (T02),
which the JSON backup leaves out as it does all binaries; they stay in the
database across a restore. Back up Postgres for those.

## HTTP API

All under `/api/valuation`, behind the usual session or API key; a read-only
API key can use the GET routes. Routes marked *admin* need an administrator's
browser session.

| Method and path | |
| --- | --- |
| `GET /status` | `{ vision, webPrice, pdfReceipts, thresholdCents, warrantyAlertDays }` |
| `GET /settings`, `PUT /settings` (*admin*) | The settings above. `PUT` takes any subset. |
| `GET /overview` | Totals, high-value records, due list, recent valuations, draft counts. |
| `GET /due` | `{ warranty: [...], service: [...] }`, open now, with `isNew` for not yet announced. |
| `POST /digest/run` (*admin*) | Announce what is newly due now. `{ announced, notified }`. |
| `GET /items/:itemId` | The item panel: records (item and units) with value, high value, profile, latest valuation, warranty state and book value; all valuations; service plans with status; the service log; receipts; declarations. |
| `GET /items/:itemId/valuations` | Valuation history, newest first. |
| `POST /items/:itemId/estimate` | `{ unitId?, attachmentIds: [1–6 photo attachment ids of this item or unit], crossCheck? }` → `{ available, found, estimate, webPrice, attachmentIds, currency, message? }`. Saves nothing. |
| `POST /items/:itemId/valuations` | `{ unitId?, valueCents, source: ai\|web\|receipt\|manual\|appraisal, basis?, confidence?, lowCents?, highCents?, valuedOn?, details?, apply?: { brand?, model? } }` → 201 with the valuation. |
| `PUT /items/:itemId/profile` | `{ unitId?, purchaseDate?, purchaseCents?, vendor?, warrantyEnds?, warrantyTerms?, warrantyProvider?, highValue?: auto\|yes\|no, usageHours? }`. Omitted fields are untouched; `null` clears. |
| `POST /items/:itemId/service-plans` | `{ unitId?, name, intervalDays?, intervalHours?, lastDoneAt?, lastDoneHours?, notes? }` → 201. |
| `PATCH /service-plans/:id`, `DELETE /service-plans/:id` | Change or remove a plan (its log stays). |
| `POST /service-plans/:id/done` | `{ doneAt?, hours?, costCents?, notes? }` → the plan with its new status. |
| `GET /declarations`, `POST /declarations` | List; create with `{ scope: company\|location\|job, scopeId?, scopeLabel?, title?, notes?, populate?, itemIds? }`. |
| `GET /declarations/:id` | With `lines`, `totalCents`, `signingContent` and `statement` (pass both to the signature dialog as they are), `signature`, `verification`. |
| `PATCH /declarations/:id`, `DELETE /declarations/:id` | Drafts only: `{ title?, notes?, scopeLabel? }` (a job reference). |
| `POST /declarations/:id/lines` | `{ lines: [{ itemId, unitId? }] }`. An item with units adds each unit. |
| `PATCH /declarations/:id/lines/:lineId`, `DELETE …` | `{ declaredCents?, name?, description?, materials?, condition?, serial?, notes? }`. |
| `POST /declarations/:id/signed` | `{ signatureId }`: seal a draft with a signature made through `POST /api/signatures` with `ownerType: "hv_declaration"`, the declaration's id, and `content: signingContent`. 409 if it no longer matches. |
| `GET /declarations/:id/verify` | `{ valid, reason, signedHash, currentHash, signedAt, code }`. |
| `GET /declarations/:id/pdf?tz=` | The declaration as a PDF. |
| `GET /receipts?itemId=&status=`, `POST /receipts` | List; start one (`{ notes? }`). Upload the file with `POST /api/attachments?ownerType=receipt&ownerId=<id>`. |
| `GET /receipts/:id`, `PUT /receipts/:id`, `DELETE /receipts/:id` | Read; edit a draft (`{ vendor, purchaseDate, currency, subtotalCents, taxCents, totalCents, notes, lines: [...] }`, lines replace the list); delete (a confirmed one: administrators only). |
| `POST /receipts/:id/read` | Read the files with AI, replacing the draft's lines. `{ available, found, reading, receipt, message? }`. |
| `GET /receipts/:id/matches?preferItemId=` | Per line, in order: `{ candidates: [{ itemId, unitId, name, assetCode, score, reason, explanation }], suggested }`. |
| `POST /receipts/:id/confirm` | `{ lines: [{ lineId, itemId?, unitId?, create?, setValue?, setWarranty? }] }` → `{ receipt, matched, notes }`. |
| `GET /report?format=pdf\|xlsx\|json&locationId=&companyId=&includeSublocations=&groupBy=location\|company&highValueOnly=&asOf=&tz=` | The valuation report. |

## Events

Registered under the **Valuation** group in the webhook picker. Subjects are
UUIDs.

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `valuation.recorded` | `item` | A value was recorded | `{ valuationId, itemId, itemName, unitId, source, valueCents, previousCents, currency, confidence, valuedOn }` |
| `valuation.high_value_marked` | `item` | A new value put a record at or over the threshold | `{ itemId, itemName, unitId, valueCents, thresholdCents, currency }` |
| `declaration.created` | `hv_declaration` | A declaration was started | `{ declarationId, code, title, scope, scopeLabel, lines, totalCents }` |
| `declaration.signed` | `hv_declaration` | A declaration was signed | `{ declarationId, code, title, signatureId, signerName, signerRole, contentHash, lines, totalCents, currency }` |
| `declaration.deleted` | `hv_declaration` | A draft was deleted | `{ declarationId, code, title }` |
| `receipt.confirmed` | `receipt` | A receipt was confirmed | `{ receiptId, vendor, purchaseDate, totalCents, currency, lines, matched: [{ itemId, unitId, created }] }` |
| `warranty.expiring` | `item` | A warranty entered the reminder window | `{ itemId, unitId, name, warrantyEnds, daysLeft, provider }` |
| `service.due` | `item` | Service became due soon or overdue | `{ itemId, unitId, name, planId, planName, state, dueAt, dueHours, daysLeft, hoursLeft }` |
| `service.logged` | `item` | Service was logged | `{ planId, name, itemId, unitId, doneAt, hours }` |

Recording a value also adds an `item.updated` event (`{ source: "valuation",
fields, valuationId, unitId? }`) to the item's own history.

## Server APIs for other features

Import from `server/src/services/valuation`:

```ts
import { recordValuation, receiptsForItem, getItemValuation, declarationContent } from "../valuation";

// Record a value (a claims or inspection feature settling a value, say).
await recordValuation({ itemId, unitId, valueCents, source: "appraisal", basis: "Adjuster's report 1142" }, userOid);

// The receipts that name an item, for an evidence pack.
const receipts = await receiptsForItem(itemId);   // each with thumbUrl; files via listAttachments("receipt", id)
```

Owner types `receipt` and `hv_declaration` are registered with the attachment
and signature registries, so their files and signatures are swept with them.

## Limits and follow-ups

- **Jobs.** The jobs feature (T03) is not in this build, so a job-scoped
  declaration stores the job's reference as text. Once jobs exist, the scope
  should link to the job and fill the declaration from the job's items.
- **Currencies.** Values are in the instance currency; an estimate or receipt
  in another currency is flagged, not converted.
- **Estimates.** The model sees the photos only. A cross-check against more
  than one price source, and against sold listings rather than asking prices,
  would make the web comparison more useful.
- **Receipts.** One receipt per purchase; a line that bought several units of
  an item is matched to the item or one unit, not split across units.
- **Report size.** Up to 20,000 rows and 400 photos per report, generated in
  the request.
