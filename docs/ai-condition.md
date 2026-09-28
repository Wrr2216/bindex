# Condition records and container capture

Record what state things are in, show crews how to handle them, and pack a
box's contents into the inventory in one step. AI reads photos to fill in
drafts; a person always checks and saves.

- [Using it](#using-it)
- [Condition reports](#condition-reports)
- [Before and after](#before-and-after)
- [Handling notes](#handling-notes)
- [Container capture](#container-capture)
- [Condition sweeps](#condition-sweeps)
- [Tuning sizes, categories and prompts](#tuning-sizes-categories-and-prompts)
- [Prompt design notes](#prompt-design-notes)
- [HTTP API](#http-api)
- [For other features](#for-other-features)
- [Events](#events)
- [Data, backups and deletion](#data-backups-and-deletion)

## Using it

The instance switch **AI condition and container capture** (Settings,
`aiCondition`, on by default) controls all of it:

- a **Condition** entry in the navigation: pack a new container, start or
  resume a condition sweep, and the latest reports across everything;
- a **Condition** card on every item page: its rating, reports, **Record
  condition**, **Before and after** and **Pack list**;
- a **handling banner** on the item page and in the scan overlay, whenever the
  item carries handling marks, a poor or damaged rating, or a handling note;
- **Settings → Condition and containers** for administrators.

Switching it off removes the screens and the navigation entry, and the API
answers `404 feature_disabled`. The records stay.

The AI buttons (**Assess with AI**, **Read with AI**, **Compare photos with
AI**) appear only when a vision model is configured (see
[media-ai-core.md](media-ai-core.md#setting-up-vision-and-transcription)).
Without one, everything else works by hand: reports, defects, handling notes,
pack lists, sweeps and the before/after comparison of recorded defects.

## Condition reports

A report is one observation of an item, or of one of its units, at a point in
time:

| Field | |
|---|---|
| Stage | `before`, `after`, `inspection`, or `custom` with a name ("return", "pre-sale"). |
| Rating | `excellent` (like new), `good` (light wear), `fair` (noticeable wear or minor damage), `poor` (heavy wear or several defects), `damaged` (broken or unusable as it is). May be left empty. |
| Defects | Each with an **area** ("top left corner of the lid"), a **type** (`scratch`, `dent`, `gouge`, `stain`, `crack`, `loose`, `missing_part`, `other`), a **severity** (`minor`, `moderate`, `major`) and a few words of description. |
| Notes | What the person wrote. |
| AI notes | What the model said, kept apart from the person's notes. |
| Handling note | One line for crews, such as "Handle with care to prevent further scratching". |
| Photos | Attachments of the item or its units. |

**Recording one.** Tap **Record condition**, pick the stage, take photos (or
pick earlier ones), and fill in the rest. With a vision model, **Assess with
AI** fills the rating, a description, the defects it can see and a handling
note. Every field it filled is outlined until someone touches it; if the model
said it was unsure, a warning says to check each one. Defects already listed
by hand are kept and the model's are added after them. If a handling note is
already there (a new report starts with the previous one), the model's
suggestion is offered with **Use it** rather than replacing it. Nothing is
saved until **Save report**.

**Photos** are uploaded the moment they are taken, as attachments of the item
(or the chosen unit) with the report's stage (`before`, `after`,
`inspection`, or the custom stage's name). So they are safe on the server even
if the form is abandoned, they show in the item's **Photos and files** gallery
under that stage, and claims can find them by stage. Tapping a photo in the
form leaves it out of the report without deleting it.

**Correcting and deleting.** Anyone signed in can correct a report, as with
items; the `condition_report.updated` event records every changed field before
and after, so the audit log keeps what it said. Only the person who recorded a
report, or an administrator, can delete it, because reports are evidence.
Deleting a report leaves its photos with the item.

## Before and after

**Before and after** on the item's Condition card puts two reports side by
side: photos, rating, notes and defects. It starts with the latest `after`
report and the latest `before` report recorded ahead of it, or the two most
recent reports when there is no such pair; either side can be changed.

The comparison of the defect lists is **deterministic**: the same two reports
always give the same answer, with no model involved. Two defects are the same
one when their type matches and their areas name the same place. Areas are
free text, so each is reduced to the words that locate it ("Top-left corner of
the lid" and "lid, top left corner" both become `corner left lid top`; "rear
panel, LHS" becomes `back left`), and:

- the same set of words is a match (score 1);
- one set inside the other ("lid" and "lid, top left corner") is a match
  (0.75);
- otherwise the share of words in common must be at least half.

Pairs are chosen best first, closer severity breaking ties, and each defect
pairs at most once. The result marks each defect of the after report **New**
(red) or **Worse** (amber), and each defect of the before report that has no
match as **Gone**. A summary line counts them and says whether the rating got
worse.

With a vision model, **Compare photos with AI** sends both sets of photos (up
to four each, before first) with the defects recorded before, and shows what
the model sees as new damage, what it no longer sees, and the rating it would
give now. This is a suggestion next to the recorded comparison; it changes
nothing.

## Handling notes

An item's handling line is built from:

1. **Handling marks** (Fragile, This side up, High value, Heavy, Keep dry)
   from its latest container capture;
2. its **rating**, when it is poor or damaged;
3. the **handling note** of its latest condition report.

The latest report wins, so recording a new report replaces the note. The form
carries the previous note forward, so it survives unless someone clears it:
clearing it is how a repaired item stops carrying "handle with care". A unit
uses its own latest report and falls back to the item's.

The line shows as a banner on the item page and in the scan overlay. Other
features get it from `handlingNoteFor` (see [For other
features](#for-other-features)); the text form reads, for example,
`Fragile · This side up. Damaged. Handle with care to prevent further scratching.`

## Container capture

**Pack list** on any item (any item can hold others), or **Pack a container**
on the Condition page for a new one, records what a box, tote, crate or pallet
is and what is in it:

1. Photograph the outside, with any writing or label, and the open top: up
   to four photos. They are kept on the container with stage `pack`.
2. **Read with AI** (with a vision model) or **Fill in by hand**.
3. Review: the container's name (the model's room and summary are offered as a
   name, handy for a box created as "Box"), size class, the room written on
   it, the writing itself exactly as written, a short summary, handling marks,
   and one line per kind of content with category, quantity, condition and
   whether it is fragile. Fields the model found hard to read are outlined in
   amber. A size the model gave that is not on your list is shown as a hint
   and not selected.
4. **Save and add N items** creates one item per ticked line **inside the
   container** (its parent), at the container's location unless you untick
   that, all in one transaction. Untick a line to record it without adding an
   item (it is already in the inventory). Lines with a condition or marked
   fragile also get a `before` condition report ("Recorded when packed"),
   fragile ones with the handling note "Fragile. Handle with care.".

The new items are ordinary items with `parentItemId` set, so container
labels, contents sheets, audits and spot checks work on them unchanged. They
are created with `enrichmentSource: "container-capture"` and do not start the
background product lookup that a hand-made item does (forty lines from one box
should not be forty web searches). Each gets a `created` history event with
`source: "container-capture"` and the container's id.

Every capture is kept. The container's latest capture supplies its size,
room, writing and handling marks on its item page and its handling line.
Capturing the same box twice adds new lines again, so untick lines that are
already inside.

On a new container from the Condition page, the item is created first (so its
photos have a record to belong to); closing the pack list leaves the item
there, empty.

## Condition sweeps

A sweep walks one location recording condition: **Condition → Condition
sweep**, pick the location and the stage (`inspection`, `before` or `after`),
**Start sweep**.

The sweep page lists everything recorded at that location or anywhere inside
it (domains excluded), with progress. Scan the next thing with a handheld
reader, the camera, or by typing its code, or pick it from the list when it
has no label. While the page is open every scan goes to the sweep, not to the
usual overlay, and a sweep scan does not add a "scanned" event to the item's
history (it uses the tracking core's resolver; QR links to an item page work
too). Scanning a unit's code or serial records against that unit.

For each item: take a photo, and with a vision model the assessment runs by
itself as soon as the first photo is in; check it, then **Save and next**.
Something scanned that is recorded elsewhere is flagged "Not recorded here"
and still saved; it is listed as checked "from elsewhere".

Progress is the set of reports carrying the sweep's id, so it survives a
closed tab, and two people can sweep the same floor. **Finish sweep** closes
it; a closed sweep takes no more reports.

## Tuning sizes, categories and prompts

**Settings → Condition and containers** (administrators) holds three things:

| Setting | Default | Used for |
|---|---|---|
| Container sizes | small, medium, large, wardrobe, dish pack, tote, pallet, crate | The size picker, and the list the model must choose from. |
| Content categories | Kitchenware, Dishes and glassware, Books and paper, Documents and files, Clothing and linens, Electronics, IT equipment, Office supplies, Tools and hardware, Decor and art, Toys and games, Furniture parts, Other | Suggestions for each content line, and the list the model must choose from. |
| Notes for the AI | empty | Appended to every prompt under "Notes from the organisation using this system". |

One entry per line, up to 40 entries of up to 40 characters each. Clearing a
list puts the defaults back. The lists are stored in `app_settings`
(`condition.size_classes`, `condition.categories`, `condition.prompt_hint`) and
apply at once, without a restart.

How the model's answers are mapped onto the lists:

- **Sizes and categories** match exactly, then ignoring case and punctuation
  ("DISH-PACK", "dishpack"), then by whole words either way ("Medium box" →
  `medium`, "books" → `Books and paper`, "wooden pallets" → `pallet`), the
  shortest entry winning. "palette" does not match `pallet`.
- A **size** that matches nothing is not selected; it is shown as a hint, and
  its confidence is capped at 0.3.
- A **category** that matches nothing becomes `Other` when the list has it,
  and is left empty when it does not. What a person types is kept as typed.
- `Domain` is never used as a category for contents, whatever the list says,
  because it switches on domain-name behaviour elsewhere.

Tips:

- Name sizes the way crews say them. If your "medium" is a 3 cu ft carton,
  say so in the notes: "medium is a 3 cubic foot carton; small is 1.5".
- Keep categories few and distinct; overlapping ones ("Kitchen", "Kitchenware")
  make the model's choice arbitrary.
- Use the notes for house conventions: "Totes are grey 60 litre crates with a
  yellow lid", "Red tape means high value", "Room numbers look like 3.14".
- Rename rather than add: renaming a category does not change items already
  created, since the category is stored on each item as text.

## Prompt design notes

The prompts are in `server/src/services/ai-condition/prompts.ts`; the parsers
in `normalize.ts` and `vocab.ts`.

- **One JSON object, with the vocabulary spelled out.** Every prompt lists the
  exact allowed values (`"scratch", "dent", …`) and the shape of the object.
  The parsers still map near misses back ("Scuffs" → scratch, "like new" →
  excellent, "4" → good on a 1 to 5 scale, "Handle with care" → fragile,
  "light" → minor), because models drift, and drop anything that cannot be
  mapped rather than storing it.
- **Only what is visible.** The system messages say to describe only visible
  damage, never to guess hidden damage, and not to report reflections,
  shadows, dust or packaging. The container prompt lists only contents that
  can be seen in an open box or read in the writing.
- **Handwriting verbatim.** Writing is transcribed line by line, uncorrected,
  so a person can compare it with the box; the room is pulled out separately.
- **Confidence per field.** The container prompt asks for a confidence per
  field and to lower it for faint, hidden or ambiguous writing; one overall
  number is accepted too and spread over the fields that were filled. Under
  0.6 a field is outlined in amber.
- **Comparing without false alarms.** The comparison prompt says how many
  photos are before and after, gives the defects already recorded before, and
  says that a recorded defect is not new even if easier to see, and that
  lighting, angle, framing and background changes are not damage.
- **Temperature 0**, and at most 4 photos for a container, 6 for an
  assessment and 4 + 4 for a comparison, each redrawn at 1600 px (the shared
  `visionJson` helper does this). A container read uses up to 2,000 output
  tokens, an assessment 1,200, a comparison 1,500.
- **Rate limit.** AI calls are limited to 30 a minute per person.
- **Never trusted blindly.** Every AI endpoint returns a draft; saving is a
  separate request with what the person confirmed, validated like any other
  input. A reply that is malformed, empty, an array or a refusal comes back
  as `found: false` with a message, and the person carries on by hand.

When changing a prompt, add the replies you see in the wild to
`server/tests/ai-condition-normalize.test.ts`.

**Developing without a key.** `server/tests/ai-condition-stub.ts` wraps the
media-ai-core stand-in and answers each condition prompt with a plausible
reply (a dish pack, a scratched desk, a new crack), and label reads with the
sample data plate:

```bash
pnpm --filter bindex-server exec tsx tests/ai-condition-stub.ts 4112
LLM_BASE_URL=http://127.0.0.1:4112/v1 LLM_API_KEY=stub LLM_VISION_MODEL=stub pnpm dev
```

## HTTP API

All under `/api/condition`, behind the usual session or API key (read-only
keys can use the `GET` routes). Every route answers `404 feature_disabled`
while the switch is off.

### Reports

| Method and path | |
|---|---|
| `GET /reports?itemId=&unitId=&sweepId=&limit=&before=` | Newest first, up to 200. Without filters, the latest across everything. Returns `{ reports, nextBefore }`; pass `nextBefore` as `before` for the next page. |
| `GET /reports/:id` | One report. |
| `POST /reports` | `{ itemId, unitId?, stage, stageLabel?, rating?, notes?, aiNotes?, defects?, handlingNote?, attachmentIds?, aiAssisted?, sweepId? }` → 201 with the report. |
| `PATCH /reports/:id` | Any of the fields above except `itemId` and `sweepId`. |
| `DELETE /reports/:id` | 204. The recorder or an administrator only (403 otherwise). |

A report as returned:

```json
{
  "id": "…", "itemId": "…", "itemName": "Oak desk", "itemAssetCode": "INV-4F2K1B",
  "unitId": null, "unitLabel": null,
  "stage": "before", "stageLabel": null, "rating": "fair",
  "notes": "Checked at pack-out", "aiNotes": "Scratches on the top and a dent on the front edge.",
  "defects": [{ "area": "front edge", "type": "dent", "severity": "moderate", "description": "Small dent" }],
  "handlingNote": "Handle with care to prevent further scratching.",
  "attachmentIds": ["…"],
  "photos": [{ "id": "…", "url": "/api/attachments/…", "thumbUrl": "/api/attachments/…/thumb", "stage": "before", "ownerType": "item", "ownerId": "…", "createdAt": "…" }],
  "aiAssisted": true, "sweepId": null,
  "createdBy": "local:…", "createdByName": "Dana Ruiz", "createdAt": "…", "updatedAt": "…"
}
```

`attachmentIds` must be photos of the item or of its units (400 otherwise).
`photos` lists those that still exist.

### AI drafts

Each saves nothing and answers `{ available, found, draft, lowConfidence,
message? }`. `available` is false when no vision model is configured.

| Method and path | Body | `draft` |
|---|---|---|
| `POST /assess` | `{ itemId, attachmentIds }` | `{ rating, summary, defects, handlingNote, confidence }` |
| `POST /containers/:itemId/read` | `{ attachmentIds }` (photos of that container) | `{ sizeClass, sizeClassRaw, handwrittenText, room, contentsSummary, contents: [{ name, category, qty, condition, fragile, description }], flags, confidence: { sizeClass, handwrittenText, room, contents } }` |
| `POST /compare/ai` | `{ before, after }` (report ids) | `{ summary, newDefects, resolvedDefects, ratingAfter, changed }` |

### Comparison, containers, handling, sweeps, settings

| Method and path | |
|---|---|
| `GET /compare?before=&after=` | `{ before, after, diff: { added, resolved, worsened, improved, unchanged, afterStatus, beforeStatus }, rating: "worse"\|"better"\|"same"\|null }`. `afterStatus[i]` is `new`, `worse`, `better` or `same` for the after report's defect `i`; `beforeStatus[i]` is `gone` or `matched`. |
| `GET /containers/:itemId` | `{ captures }`, newest first. |
| `POST /containers/:itemId/capture` | `{ containerName?, sizeClass?, handwrittenText?, room?, contentsSummary?, flags?, contents?: [{ name, category?, qty?, condition?, fragile?, description?, create? }], attachmentIds?, aiAssisted?, confidence?, inheritLocation? }` → 201 `{ capture, createdItemIds, reportIds }`. All or nothing. |
| `GET /handling?itemIds=a,b,c` | `{ notes: { [itemId]: { itemId, unitId, note, rating, reportId, reportedAt, flags, text } } }`. Up to 500 ids; items with nothing to say are absent. |
| `GET /sweeps?status=open\|closed` | `{ sweeps }` with `expected` and `checked` counts. |
| `POST /sweeps` | `{ locationId, stage?, name? }` → 201 with the sweep. |
| `GET /sweeps/:id` | The sweep with `items` (expected here, each with this sweep's latest report) and `extra` (checked but recorded elsewhere). |
| `POST /sweeps/:id/scan` | `{ code }` → `{ itemId, unitId, name, assetCode, primaryImageUrl, locationName, expected, report }`. 404 with a message for an unknown code. Records no history. |
| `POST /sweeps/:id/close` | Finish it. |
| `GET /settings` | `{ sizeClasses, categories, promptHint, vision, vocabulary }`. |
| `PUT /settings` | Administrators. `{ sizeClasses?, categories?, promptHint? }`. |

## For other features

Server, from `server/src/services/ai-condition`:

```ts
import { handlingNoteFor, handlingNotesForRefs, handlingText } from "../ai-condition";

// Manifests (T03): one line per item, a fixed three queries however many items.
const notes = await handlingNoteFor(lines.map((l) => l.itemId));
const text = notes.get(line.itemId)?.text ?? "";   // "" when there is nothing to say

// Per unit, falling back to the item's note; results in input order, null for nothing.
const perLine = await handlingNotesForRefs(lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId })));
```

`listReports({ itemId })` and `getReport(id)` give an item's condition
history, newest first, with photo links, for claims (T16) and inspections
(T13). Features that must not import this code can read the tables directly:
`condition_reports` (`item_id`, `unit_id`, `stage`, `stage_label`, `rating`,
`notes`, `ai_notes`, `defects` jsonb, `handling_note`, `attachment_ids`
uuid[], `ai_assisted`, `sweep_id`, `created_by`, `created_at`) and
`container_captures` (`item_id`, `size_class`, `handwritten_text`, `room`,
`contents_summary`, `contents` jsonb, `flags` text[], `attachment_ids`,
`created_item_ids`, `created_at`). The pack-day condition of a packed item is
its `before` report; its photos are attachments with stage `before` (and the
container's with stage `pack`).

Client, from `client/src/features/ai-condition`:

```tsx
<HandlingNoteBanner itemId={id} compact />   // nothing when there is nothing to say or the switch is off
const note = useHandlingNote(itemId);         // the raw note, for a custom card
<RatingBadge rating="fair" />
```

Two features already use this. Printed relocation manifests and load sheets
(T03) print each line's `handlingNotesForRefs` text under the item while this
feature is on (`services/integration/handlingNotes.ts`, through the jobs
core's `registerManifestNotes`). Placement cards and the entrance kiosk (T11)
show the same line next to the destination, through placement's own provider
(`services/placement/conditionNotes.ts`).

## Events

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `condition_report.created` | `condition_report` | A report was recorded (by hand, in a sweep, or for a packed item) | `{ reportId, itemId, itemName, unitId, stage, rating, defects (count), handlingNote, photos (count), aiAssisted, sweepId }` |
| `condition_report.updated` | `condition_report` | A report was corrected | `{ reportId, itemId, changed: string[], changes: { field: { from, to } } }` |
| `condition_report.deleted` | `condition_report` | A report was removed | `{ reportId, itemId, itemName, unitId, stage, rating, createdAt }` |
| `container.captured` | `item` (the container) | A pack list was saved | `{ captureId, containerId, sizeClass, room, flags, contentsSummary, lines, createdItemIds, aiAssisted }` |
| `condition_sweep.started` | `condition_sweep` | A sweep began | `{ sweepId, locationId, locationName, stage, expected }` |
| `condition_sweep.closed` | `condition_sweep` | A sweep was finished | `{ sweepId, locationId, locationName, stage, expected, checked }` |

Items created by a capture also emit `item.created` with `{ name, source:
"container-capture", containerId }`, and a renamed container `item.updated`
with `{ fields: ["name"], source: "container-capture" }`.

## Data, backups and deletion

Three tables (migration `0033_ai_condition.sql`): `condition_reports`,
`container_captures` and `condition_sweeps`.

- Deleting an item deletes its reports and captures; deleting a unit deletes
  its reports. Deleting a location leaves its sweeps, without a location.
  Photos are attachments and follow the attachment rules (swept within the
  hour once their owner is gone).
- The **JSON backup** includes all three tables. A restore puts them back
  after items, units and locations, dropping rows whose item or unit is not in
  the file. Restoring a file written before this feature (no condition tables)
  keeps the records already here, minus those whose item is gone. Photos are
  not in the JSON backup; see [media-ai-core.md](media-ai-core.md#backups).

## Follow-ups

- The per-container contents sheet PDF could print each line's handling note,
  as manifests and load sheets now do.
- Mapping the room written on a box to a destination location (for T11's
  destination rules).
