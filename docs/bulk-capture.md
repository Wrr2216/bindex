# AI bulk capture

Catalogue a whole room from a few photos or a short walkthrough video, survey
office desks against a standard kit, or turn a paper inventory into records.
A vision model drafts the list; a person checks and corrects it; only then are
items created.

- [Using it](#using-it)
- [How entries are merged](#how-entries-are-merged)
- [Desk surveys](#desk-surveys)
- [Paper inventories and manifests](#paper-inventories-and-manifests)
- [Cost guard](#cost-guard)
- [Creating the items](#creating-the-items)
- [Setting it up](#setting-it-up)
- [HTTP API](#http-api)
- [Events](#events)
- [Data and backups](#data-and-backups)
- [Developing and testing](#developing-and-testing)
- [Limits and follow-ups](#limits-and-follow-ups)

## Using it

**Capture** in the navigation (shown when the instance switch **AI bulk
capture**, `bulkCapture`, is on and a vision model is configured) lists
sessions in progress and finished, and starts a new one in one of three modes:

| Mode | For | Images |
|---|---|---|
| **Walkthrough** | A room, or a floor room by room | Photos, or a short video sampled into frames |
| **Desk survey** | Workstations in an office | One photo per desk |
| **Paper inventory** | A paper inventory, packing list or manifest, printed or handwritten | Photos of the pages, or a PDF |

A session has a **location** (the room, floor or office), an **image cap**
(see [Cost guard](#cost-guard)), and for walkthroughs and desks a **Photos
overlap** setting (see below). Sessions are saved as you go: close the tab
halfway through a floor and pick it up later from the list.

1. **Add images.** Take photos with the camera, pick several from the library,
   record or pick a video, or add a PDF. Photos can carry an **area**: the room
   of a floor walkthrough, or the desk of a desk survey (**Next desk** counts
   up: Desk 1, Desk 2, or 4B-12, 4B-13). Nothing is sent to the model yet.
2. **Analyse.** The bar above the list says how many images are waiting and how
   much of the cap is left, and **Analyse N images** sends them, two at a time,
   showing progress. **Stop after this** pauses. A failed image shows why and
   can be tried again.
3. **Review.** Each entry shows a crop of the thing it was seen in (when the
   model gave a box), its count, category, brand and model, and, when it was
   merged from several images, why. Entries the model was unsure of (under
   60%) are outlined in amber. You can:
   - **Edit** any field. An edited entry is yours: later images add evidence to
     it but never change it. A typed quantity is never recomputed.
   - **Merge** two or more ticked entries that are the same thing. The first in
     the list keeps its name.
   - **Split by image**, undoing an automatic merge, or **Split off** some of a
     count that turned out to be something else.
   - **Delete** an entry. Deleted entries are kept (and can be restored with
     **Show deleted**), so a later photo of the same thing does not bring it
     back.
   - **Add entry** for something the model missed.
   - Change an image's area. Its entries move with it; the stored reading is
     re-merged in the new area without another vision call.
4. **Create.** Nothing exists as an item until **Create N items** is pressed
   and confirmed. See [Creating the items](#creating-the-items).

## How entries are merged

Overlapping photos of one room show the same chairs several times. The merge
decides, conservatively, which sightings are the same entry, because a wrong
merge hides a real asset while a missed one only costs a tap.

A thing seen in an image joins an existing entry only when **all** of these hold:

- **Same area.** Entries never merge across rooms or desks.
- **Same category.** The model is asked to use a fixed vocabulary (seating,
  desk, table, storage, monitor, computer, laptop, peripheral, printer, phone,
  networking, av, appliance, lighting, artwork, fixture, equipment, tool,
  container, plant, other); free-text categories and names are mapped onto it.
- **No conflicting brand or model.** A Dell monitor and an HP monitor stay apart.
- **Names agree.** The head noun (the last word: "office *chair*") must match,
  no colour may conflict ("black chair" and "red chair" stay apart, checked
  against every name the entry has had), and either one name's words contain
  the other's ("chair" and "black office chair") or two thirds of the words are
  shared. "Monitor" and "monitor arm", or "TV" and "television", are **not**
  merged; merge those by hand.
- **One image, once.** An image adds to an entry at most once: two lines about
  chairs in one photo are two different kinds of chair.

**Counts.** Within one image, identical names add up. Across images, the
session's count rule decides:

- **Photos overlap** (the default): the largest count seen wins. Three photos
  showing 4, 6 and 3 of the same chairs give 6.
- Unticked: counts add up, for photos that each show a different part of a room.

Changing the rule recomputes every quantity that was not typed by hand.

**Explanations.** A merged entry says what happened, for example:
"Seen in photo 1 (4), photo 2 (6) and photo 3 (3). Overlapping photos usually
show the same things, so the largest count is used. Called “office chair” and
“black office chair”." Hand merges and splits add a note.

When an image is removed, its contributions come out of every entry, and an
entry only it supported goes too, unless a person edited or added it.

## Desk surveys

A desk survey is checked against a **desk template**: what a standard
workstation should have. The built-in template expects two monitors, a docking
station, a chair and a pedestal. Administrators edit templates, and add others
(a hot desk, a reception desk), in **Settings → AI bulk capture**. Each line
has a label, a count and **match words**: the names that count towards it (a
"monitor" line also counts "display" and "screen"). The head noun decides, so a
"monitor arm" is not a monitor.

The **Desk check** panel lists every desk with photos, what it has against each
line, what is missing (in amber), and anything else seen there. A desk whose
photo showed nothing recognisable still appears, missing everything. The
template is copied into the session when it starts, so editing templates
later does not change a survey under way.

When a desk photo has no desk label, a desk number the model reads off a sign
or sticker in the photo is used.

## Paper inventories and manifests

Each page image is transcribed into rows: line number, description, quantity,
condition codes, lot sticker (colour, lot, number), room and notes.

- **Condition codes** used on household-goods and office-move inventories are
  decoded into words, with the location numbers that follow them:
  `SC-3,7` becomes "scratched (corner, rear)", `BR 6` "broken (leg)". Codes:
  BE bent, BR broken, BU burned, CH chipped, CP carrier packed, CU contents
  unknown, D dented, DBO disassembled by owner, F faded, G gouged, L loose,
  M marred, MI mildew, MO moth-eaten, PBO packed by owner, R rubbed, RU rusted,
  SC scratched, SH short, SO soiled, T torn, W badly worn, Z cracked. Locations
  1 to 19: arm, bottom, corner, front, left, leg, rear, right, side, top,
  veneer, edge, center, inside, seat, drawer, door, shelf, hardware. Unknown
  codes are kept as written.
- **Lot stickers** are read from the line or from text such as "Red 2231-045".
  A lot or colour written once at the top of the page applies to every line
  that does not give its own.
- **Rooms** written on a line become the entry's area.

Photographing a page twice is safe: a line joins an existing entry only when
its **line number and description** agree, or its **sticker number** matches
(with no conflicting lot or colour). A line read twice is kept once, at the
larger count; different lines are never added together. Lines with neither a
number nor a sticker are never merged automatically.

**PDFs** are rendered page by page with `pdftoppm` (150 dpi, at most 2000 px)
when it is installed. Without it, the PDF button is hidden, a PDF sent through
the API is refused with a message saying so, and pages can be photographed or
uploaded as images instead.

## Cost guard

Every image analysed is one paid vision request, so:

- The review screen shows how many images are waiting and how many of the
  session's analyses are left **before** anything is sent, and nothing is sent
  until **Analyse** is pressed.
- Each session has an **image cap**: it cannot hold more images than that, and
  cannot make more vision calls than that. Calls are claimed and counted in the
  same transaction that picks the images, before the request is made, so two
  tabs cannot overspend it. A retried image counts again.
- New sessions start at the instance's **Most images per session** (Settings →
  AI bulk capture, default 40, at most 500), and no session can raise its own
  cap above it.
- A video is sampled at one frame every three seconds, at most 24 frames, and
  never more than the cap has room for; a PDF renders only as many pages as fit.
- The analyse endpoint takes at most 40 calls a minute per person (each reads
  up to four images).

## Creating the items

**Create** turns every pending entry into items in **one transaction**: all or
none. Options:

- **One record per piece** (on by default for desk surveys): three monitors
  become three items of quantity 1, each with its own code and label, rather
  than one item of quantity 3. Limited to 100 pieces per entry.
- **A location for each room/desk** (on by default for desk surveys): entries
  go into a location named after their area, inside the session's location,
  created if it does not exist. Unticked, an existing location of that name is
  still used and nothing is created.

Where an entry lands: the location set on the entry itself, else its area's
location, else the session's location. Items inherit the location's group, as
in the item form.

Each created item:

- has `enrichmentSource: "bulk-capture"` and, in `metadata`:

  ```json
  {
    "capture": {
      "sessionId": "…", "draftId": "…", "mode": "walkthrough",
      "sourceAttachmentIds": ["…"], "area": "Room 101", "piece": "2 of 3"
    },
    "desk": "4B-12",
    "manifest": { "lineNo": 12, "conditionCodes": ["SC-3,7"], "condition": "scratched (corner, rear)", "room": "Office 2" },
    "sticker": { "color": "red", "lot": "2231", "number": "045" }
  }
  ```

  (`desk` for desk surveys, `manifest` for paper inventories, `sticker` when
  one was read);
- gets its own photo attachment (stage `capture`) of the image it was seen in,
  cropped to the thing when the model gave a box, with the source image's
  attachment id, the box, and the frame time or page number in its metadata.
  It shows in the item's **Photos and files**. A crop also becomes the item's
  main photo; a whole room or a page does not. Because each item keeps its own
  copy, deleting the session afterwards loses nothing;
- is recorded as `item.created` in its history and the audit log.

Items made here skip the background product lookup that the item form starts
for a new item: fifty lookups at once would be slow and cost money. It stays
one tap away on each item.

Entries typed in by hand have no image and so no photo.

## Setting it up

1. A **vision model**: the same settings as reading labels
   (`LLM_API_KEY`, `LLM_VISION_MODEL`), described in
   [media-ai-core.md](media-ai-core.md#setting-up-vision-and-transcription).
   Without one, **Capture** disappears from the navigation and the API answers
   `available: false`.
2. The instance switch **AI bulk capture** (on by default) in Settings. Off,
   the screens and the whole `/api/bulk-capture` API are gone (404
   `feature_disabled`); sessions and their images stay.
3. Optional tools, found on the `PATH` at runtime:
   - **ffmpeg** (with ffprobe) for walkthrough video;
   - **pdftoppm** (poppler-utils) for PDF manifests; `pdfinfo`, from the same
     package, lets it say how many pages did not fit under the cap.

   The Docker image installs both (`apk add ffmpeg poppler-utils`). Without
   them the feature works with photos and images only, and says so.

Each image is sent redrawn at most 1600 px on its longest side (about 1,000 to
1,500 input tokens on most providers). A walkthrough photo asks for up to 2,000
output tokens, a manifest page up to 4,000. A model that handles small print
and handwriting well pays off for manifests; for rooms, a small multimodal
model is usually enough.

## HTTP API

All under `/api/bulk-capture`, behind the usual session or API key (read-only
keys can use the GET routes). Files are uploaded first through the attachments
API with owner type `capture_session`, then added to the session, so uploads
stream with progress and the usual size limits:

```bash
A=$(curl -s -X POST --data-binary @room.jpg -H 'Content-Type: application/octet-stream' \
  "$URL/api/attachments?ownerType=capture_session&ownerId=$SESSION&type=image/jpeg&stage=source" | jq -r .id)
curl -s -X POST -H 'Content-Type: application/json' -d "{\"attachmentId\":\"$A\",\"area\":\"Room 101\"}" \
  "$URL/api/bulk-capture/sessions/$SESSION/sources"
```

| Method and path | |
|---|---|
| `GET /status` | `{ available, vision, video, pdf, maxImagesPerSession, deskTemplates }`. |
| `GET /settings` | `{ maxImagesPerSession, deskTemplates }`. |
| `PUT /settings` | Administrators. Either field; templates are `{ id?, name, items: [{ key?, label, qty, match? }] }`. |
| `GET /sessions` | Newest activity first: counts of images, images waiting, entries to review and created. |
| `POST /sessions` | `{ mode: "walkthrough"\|"desk"\|"manifest", title?, locationId?, imageCap?, countRule?: "max"\|"sum", deskTemplateId? }` → 201, the session. |
| `GET /sessions/:id` | The session: `cap { imageCap, used, remaining, instanceMax }`, `toAnalyse`, `sources`, `drafts` (each with `explanation` and labelled `sources`), `deskCheck`, `counts`, `tools`. |
| `PATCH /sessions/:id` | `{ title?, locationId?, imageCap?, countRule?, deskTemplateId? }`. |
| `DELETE /sessions/:id` | 204. Removes drafts and images; created items are unaffected. |
| `POST /sessions/:id/sources` | `{ attachmentId, area? }` → 201 `{ added, message }`. A photo is one source; a video becomes frames, a PDF pages. Refused (and the upload removed) when the file cannot be read or the cap is full. |
| `PATCH /sessions/:id/sources/:sourceId` | `{ area }`. Re-merges its reading in the new area. |
| `DELETE /sessions/:id/sources/:sourceId` | Removes the image and what it contributed. |
| `POST /sessions/:id/sources/:sourceId/retry` | A failed image back to waiting. |
| `POST /sessions/:id/analyse` | `{ limit?: 1..4 }` (default 2). Reads the next waiting images → `{ available, analysed, failed, session }`. 409 when the cap is used up. Call again until `session.toAnalyse` is 0. |
| `POST /sessions/:id/drafts` | Add an entry: `{ name, qty?, category?, brand?, model?, description?, area?, locationId?, lineNo?, condition?, stickerColor?, stickerLot?, stickerNumber? }`. |
| `PATCH /sessions/:id/drafts/:draftId` | Any of those fields, or `status: "pending"` to restore. |
| `DELETE /sessions/:id/drafts/:draftId` | Marks it deleted (kept, restorable). |
| `POST /sessions/:id/drafts/merge` | `{ ids: [first, …] }`. |
| `POST /sessions/:id/drafts/:draftId/split` | `{ by: "source" }` or `{ qty: n }`. |
| `POST /sessions/:id/commit` | `{ draftIds?, individual?, areaLocations? }` → `{ created: [{ draftId, name, itemIds }], itemCount, photos: { saved, failed }, session }`. |

Every mutation returns the updated session, so a client never has to merge
state itself. Errors are the usual `{ error, code }`, with a message saying
what to do.

## Events

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `capture_session.committed` | `capture_session` | Reviewed entries were created as items | `{ sessionId, mode, title, locationId, itemIds, entries }` |

Every created item also emits `item.created` with
`{ name, source: "bulk-capture", sessionId }`. Link this table from the event
catalog in [event-backbone.md](event-backbone.md#event-catalog) when the
branches are integrated.

## Data and backups

Migration `0042_bulk_capture.sql` adds:

- `capture_sessions`: mode, title, location, status (`open`, `committed`),
  count rule, image cap and vision calls made, the desk template in force;
- `capture_sources`: one row per image read (photo, video frame, PDF page),
  its area, status and the normalized reading;
- `capture_drafts`: the reviewable entries, with the images each was seen in
  (`sources`), manifest fields, and the items created from it.

The image files are attachments owned by the session (`owner_type
'capture_session'`), stored and swept like every other attachment.

Sessions are **not** in the JSON backup. They are work in progress, and their
images are binary, which the JSON backup leaves out for the same reason as
attachments. What matters survives: the created items (with their metadata and
history) are in the JSON backup, and their capture photos are in a database
dump like every attachment.

## Developing and testing

Pure logic (names and categories, photo and manifest normalizers, the merge
rules, desk checks, settings) is tested without a database or a provider in
`server/tests/bulk-capture-merge.test.ts`, `-manifest.test.ts` and
`-desk.test.ts`, from the fixture replies in
`server/tests/bulk-capture-fixtures.ts`: three overlapping photos of one
conference room, two overlapping manifest pages and a desk.

`server/tests/bulk-capture-media.test.ts` samples a generated video and renders
a generated PDF when ffmpeg and pdftoppm are installed, and skips those cases
with a reason otherwise.

`server/tests/bulk-capture-db.test.ts` runs the whole flow against Postgres and
the stand-in provider from `server/tests/media-ai-core-stub.ts`: three
overlapping photos become nine entries (chairs merged to six, with the
explanation), review edits, merges and splits, and items appear only on
commit, each linked to its source photo. It also covers the cap, failed
readings and retries, moving an image to another room, a PDF manifest filed
into room locations, a desk survey created one record per piece, and video
frames:

```bash
createdb bindex_bulk_capture_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_bulk_capture_test \
  pnpm --filter bindex-server exec tsx --test tests/bulk-capture-db.test.ts
```

To click through the screens without a provider, point `LLM_BASE_URL` at a
stub that answers with the fixtures (see the stub file for how tests script
replies per request).

## Limits and follow-ups

- **Jobs.** Converting a manifest straight into a job's item list needs the
  jobs feature (T03), which this branch does not have. When it lands, the
  commit step can take a `jobId` and add the created items to the job.
- **Legacy stickers.** Sticker colour, lot and number are kept in
  `metadata.sticker`. When tag commissioning (T07) adds legacy-sticker
  identifiers, a one-off pass can turn these into identifiers so a sticker
  scan finds the item.
- **Bounding boxes** vary by provider; they only drive crops, and a box that
  does not make sense is dropped rather than trusted.
- **HEIC photos** cannot be redrawn for the model and are refused with a
  message; iPhones send JPEG from the camera button, and "Most Compatible"
  fixes the library.
- Analysis runs while the page is open (two images per request). A long
  walkthrough on a poor connection may be better as photos in several batches.
