# Attachments, signatures and AI capture

Photos, video, audio and documents attached to any record; signatures that
prove what someone agreed to; and the AI helpers that read photos and speech.
One complete feature is built on top: reading serial numbers and data plates
off equipment labels.

This is shared infrastructure. Features that need files, signatures or vision
on their own records use the APIs below rather than building their own.

- [Using it](#using-it)
- [Storage, sizing and backups](#storage-sizing-and-backups)
- [Setting up vision and transcription](#setting-up-vision-and-transcription)
- [HTTP API](#http-api)
- [Server APIs for other features](#server-apis-for-other-features)
- [Client components](#client-components)
- [Security notes](#security-notes)

## Using it

The instance switch **AI capture from photos** (Settings, `aiCapture`, on by
default) controls everything this adds to the screens:

- **Photos and files** on every item, unit and location: take a photo or record
  a video with the camera, pick files from the library, watch uploads progress,
  play video in place, filter by stage (before, after, label, anything else),
  caption, download and delete. On an item with tracked units, chips switch
  between the item's own files and each unit's.
- **Set as main photo** turns an item's photo attachment into the picture shown
  everywhere else. It copies the bytes through the existing photo path, so
  nothing that shows an item's picture had to change.
- **Read from label**, on the item page and in the item form, photographs an
  equipment label and reads brand, model, serial number, part number, asset
  tag, MAC address, manufacture date and electrical ratings from it.

Turning the switch off hides all of it. The data stays, and the HTTP API keeps
working for other features and scripts, except the data-plate endpoints, which
refuse with 403.

### Reading a label

1. Tap **Read from label** and photograph the label, straight on and close.
2. The photo goes to the vision model, which returns every field it can read,
   a confidence per field, and the label's full text. Nothing is saved yet.
3. The review shows every field, editable, with a tick box per field:
   - A field the model was unsure of (confidence under 0.6) is outlined in
     amber with "Hard to read". An identifier that does not appear anywhere in
     the label's own transcribed text is treated as unsure whatever the model
     claimed, since that is what an invented value looks like.
   - A serial, MAC or asset tag already on another record is outlined in red,
     names that record, and starts unticked.
4. **Save** writes only the ticked fields:
   - brand and model onto the item;
   - serial, MAC and asset tag as identifiers, under the same uniqueness rules
     as typing them in (a duplicate is refused with a message naming the other
     record);
   - part number as a `sku` identifier, which is a product code and may repeat;
   - for a unit (pick it under **Save to**), the serial onto the unit itself.
   The label photo is kept as an attachment with stage `label`, carrying the
   whole reading (manufacture date, ratings, other identifiers such as FCC ID or
   IMEI, and the raw text) in its metadata. The most recent reading's date,
   ratings and other identifiers are shown under the gallery.

In the item form (new or edit), **Use these values** fills brand and model into
the form at once and holds the identifiers and the photo until you press
**Create item** or **Save changes**. Cancel the form and nothing is written.

MAC addresses are stored as `AA:BB:CC:DD:EE:FF`. Printed labels such as `S/N:`
or `P/N` are stripped from values; a serial that genuinely starts with `SN` is
left alone.

The button only appears when the switch is on and a vision model is configured.

## Storage, sizing and backups

| Setting | Default | What it does |
|---|---|---|
| `ATTACHMENT_DB_MAX_MB` | 8 | Files up to this size are stored in Postgres. |
| `ATTACHMENT_MAX_MB` | 512 | The largest upload accepted. |
| `DATA_DIR` | `./data` | Larger files are written under `DATA_DIR/attachments/`. |

Photos, audio notes, signatures and PDFs land in the database, where they are
transactional and covered by a database backup. Video, which is mostly larger,
goes to disk. An upload is streamed: it is held in memory only until it passes
the database threshold, then spilled to a temporary file and streamed there,
hashing (sha256) as it goes. A 200 MB video adds a few megabytes to the
server's memory, not 200.

The file's type is decided from its first bytes, not from the Content-Type the
client sent (see [Security notes](#security-notes)).

Files are served with `Accept-Ranges: bytes` and answer Range requests, so a
phone can seek in a long video without downloading it. Database files are
sliced in SQL (the column is stored uncompressed out of line, so a slice reads
only the pages it needs); disk files are read from an offset. Every attachment
is immutable, so responses carry an ETag of its sha256 and a year-long private
cache lifetime.

**Sizing.** Budget database space for photos: a phone photo is 2 to 5 MB, so
10,000 condition photos is 20 to 50 GB of Postgres. Budget disk for video at
roughly 100 to 150 MB per minute of 1080p phone footage. Raising
`ATTACHMENT_DB_MAX_MB` keeps more in the database; lowering it moves more to
disk.

**Docker.** `docker-compose.yml` mounts a named volume, `appdata`, at
`/app/data` and sets `DATA_DIR=/app/data`. Without a writable `DATA_DIR`,
uploads over `ATTACHMENT_DB_MAX_MB` fail with a 507 that says so, and the server
logs `attachments.data_dir.unwritable` at startup.

**Reverse proxies.** Most proxies cap request bodies well below video sizes
(nginx defaults to 1 MB). Raise the cap to at least `ATTACHMENT_MAX_MB`, for
example `client_max_body_size 512m;`, and allow long uploads
(`proxy_request_buffering off; proxy_read_timeout 600s;` on nginx). Node itself
allows five minutes to receive a request, which is about 14 Mbit/s for a 512 MB
file; see Follow-ups for resumable uploads.

### Backups

The JSON backup in Settings does **not** include attachments or signatures,
for the same reason it leaves out uploaded item photos: they are binary, and a
JSON file is the wrong place for gigabytes. Back up two things:

1. **Postgres**, which holds every attachment's metadata, every file up to
   `ATTACHMENT_DB_MAX_MB`, and every signature:
   `docker compose exec db pg_dump -U bindex -Fc bindex > bindex.dump`
2. **`DATA_DIR`**, which holds the larger files, named by attachment id:
   `docker run --rm -v bindex_appdata:/data -v "$PWD":/backup alpine tar czf /backup/appdata.tgz -C /data .`
   (the volume name is the Compose project name plus `_appdata`).

Take them together: a row whose file is missing answers 404 with "The file for
this attachment is missing from storage", and a file with no row is removed by
the sweep below.

Restoring a JSON backup over a running instance keeps the attachments of every
record that exists after the restore.

### Cleaning up

Owners are polymorphic (an attachment belongs to an `ownerType` and
`ownerId`), so there is no foreign key to cascade deletes. Instead, an hourly
sweep removes signatures and attachments whose owner no longer exists (after a
ten-minute grace period), and files under `DATA_DIR` that no row points to
(after an hour; partial uploads after six). Deleting an item therefore removes
its photos within the hour. The sweep, rather than a trigger, is also what lets
a JSON restore, which deletes and re-inserts every item in one transaction,
leave their photos alone.

## Setting up vision and transcription

Both are optional and degrade quietly: unconfigured, they report
`vision: false` / `transcription: false` in `GET /api/config` under
`integrations`, their buttons disappear, and the helpers return null.

**Vision** reuses the chat provider (`LLM_BASE_URL`, `LLM_API_KEY`) and needs a
model that accepts images:

| Setting | Default | |
|---|---|---|
| `LLM_VISION_MODEL` | `LLM_MODEL` | Must accept image input. |

The default `LLM_MODEL` is text-only, so set `LLM_VISION_MODEL` when using it:
pick a model from your provider's catalogue that lists image input. Small,
inexpensive multimodal models read printed labels well; there is no need for
the largest. Any OpenAI-compatible server works, including a local Ollama
(`LLM_BASE_URL=http://ollama:11434/v1`, any non-empty `LLM_API_KEY`, and a
vision model it serves). A model that cannot take images fails each call with a
400 that the server logs as `ai.data_plate.http_error` with the provider's
reason; the person sees "No label could be read".

Each label read is one request with one image, redrawn as a JPEG no larger than
1600 px (about 1,000 to 1,500 input tokens on most providers). Reads are
limited to 20 per minute per person.

**Transcription** uses any OpenAI-compatible `/audio/transcriptions` endpoint
and asks for `verbose_json`, so the transcript has timestamps:

| Setting | Default | |
|---|---|---|
| `STT_BASE_URL` | `LLM_BASE_URL` | OpenRouter has no transcription endpoint; set this when using it. |
| `STT_API_KEY` | `LLM_API_KEY` | |
| `STT_MODEL` | `whisper-1` | Use the name your provider gives its speech model. |

For example OpenAI (`https://api.openai.com/v1`), Groq
(`https://api.groq.com/openai/v1`), or a local
[speaches](https://github.com/speaches-ai/speaches) / faster-whisper server.
Providers cap uploads (OpenAI at 25 MB), so extract audio from video first.

**Developing without a key.** `server/tests/media-ai-core-stub.ts` is a tiny
OpenAI-compatible stand-in that answers chat/completions with a sample data
plate and audio/transcriptions with a sample transcript:

```bash
pnpm --filter bindex-server exec tsx tests/media-ai-core-stub.ts 4102
LLM_BASE_URL=http://127.0.0.1:4102/v1 STT_BASE_URL=http://127.0.0.1:4102/v1 \
  LLM_API_KEY=stub LLM_VISION_MODEL=stub pnpm dev
```

Tests import `startAiStub()` from the same file to script replies per test.

## HTTP API

All under `/api`, behind the usual session or API key. API keys with scope
`read` can list and download only.

### Attachments

`POST /api/attachments` uploads one file. The request body **is** the file,
streamed, not a form. Describe it with query parameters, or with
`X-Attachment-*` headers (URI-encoded) for clients that prefer headers:

| Query | Header | |
|---|---|---|
| `ownerType` | `X-Attachment-Owner-Type` | Required. `item`, `unit`, `location`, or a registered type. |
| `ownerId` | `X-Attachment-Owner-Id` | Required. The record's UUID. |
| `kind` | `X-Attachment-Kind` | `photo`, `video`, `audio`, `document`, `signature`. Inferred from the file when omitted. |
| `stage` | `X-Attachment-Stage` | Free text, stored lowercase: `before`, `after`, `pack`, `delivery`, `label`… |
| `caption` | `X-Attachment-Caption` | Up to 500 characters. |
| `type` | `X-Attachment-Type` | The real MIME type, when the body is sent as `application/octet-stream`. |
| `filename` | `X-Attachment-Filename` | Kept in `meta.filename`, used for downloads. |
| `width`, `height`, `durationMs` | same | Hints for video and audio (the server does not decode media). |
| | `X-Attachment-Meta` | A small JSON object stored as `meta`. Use `PATCH` for anything large. |

Send the body as `application/octet-stream` with the real type in `type`, so
no body parser on the way touches it. Returns 201 with the attachment:

```json
{
  "id": "…", "ownerType": "item", "ownerId": "…", "kind": "photo",
  "stage": "before", "caption": null, "mime": "image/jpeg", "sizeBytes": 2097152,
  "sha256": "…", "storage": "db", "width": 4032, "height": 3024, "durationMs": null,
  "meta": {}, "createdBy": "local:…", "createdAt": "…",
  "url": "/api/attachments/…", "thumbUrl": "/api/attachments/…/thumb"
}
```

Errors: 400 (unknown owner type, a kind that does not fit the file, an empty
body), 404 (the owner does not exist), 413 (over `ATTACHMENT_MAX_MB`, refused
from Content-Length before reading), 415 (not a supported type), 507
(`DATA_DIR` not writable).

```bash
curl -X POST --data-binary @door.mp4 -H 'Content-Type: application/octet-stream' \
  "$URL/api/attachments?ownerType=location&ownerId=$LOC&type=video/mp4&stage=before"
```

| Method and path | |
|---|---|
| `GET /api/attachments?ownerType=&ownerId=&kind=photo,video&stage=` | List, oldest first. |
| `GET /api/attachments/:id` | The file. Honours `Range` (206/416), `If-None-Match` (304), `HEAD`. |
| `GET /api/attachments/:id/thumb?w=320` | JPEG preview of a photo, 64 to 1024 px wide. |
| `PATCH /api/attachments/:id` | `{ caption?, stage?, meta? }`. The file never changes. |
| `POST /api/attachments/:id/primary` | Make an item's photo its main photo. Returns the item. |
| `DELETE /api/attachments/:id` | 204. A signature's image is refused with 409. |

### Signatures

| Method and path | |
|---|---|
| `POST /api/signatures` | `{ ownerType, ownerId, signerName, signerEmail?, signerRole?, statement, content, image? }`. `image` is the PNG as a data URL. Returns 201 with the signature. |
| `GET /api/signatures?ownerType=&ownerId=` | List, oldest first. |
| `GET /api/signatures/:id` | One signature, plus `content` exactly as signed. |
| `POST /api/signatures/:id/verify` | `{ content }` → `{ valid, reason, signedHash, currentHash, signedAt }`. |

`reason` is `ok`, `content_changed` (the content no longer hashes the same),
`image_missing` or `image_altered` (the signature image changed after signing).

### AI

| Method and path | |
|---|---|
| `GET /api/ai/status` | `{ languageModel, vision, transcription, aiCapture }`. |
| `POST /api/ai/data-plate?ownerType=item\|unit&ownerId=` | Body: the label photo. Returns `{ available, found, reading, taken, lowConfidence, message? }`. Saves nothing. The owner, when given, is excluded from `taken`. |
| `POST /api/ai/data-plate/apply` | `{ ownerType: "item"\|"unit", ownerId, brand?, model?, serial?, mac?, assetTag?, partNumber? }` → the updated item. 409 on a duplicate, naming the other record. |

`reading` is:

```json
{
  "brand": "Dell", "model": "Latitude 5440", "serial": "7XK2P93", "partNumber": "0R9KW3",
  "assetTag": null, "mac": "A4:BB:6D:12:34:56", "manufactureDate": "2024-03",
  "ratings": { "voltage": "19.5V", "amperage": "3.34A", "wattage": "65W", "frequency": null },
  "otherIdentifiers": [{ "label": "FCC ID", "value": "E2K-AX211NG" }],
  "confidence": { "brand": 0.98, "serial": 0.62, "partNumber": 0.4, "assetTag": 0, "…": 0 },
  "rawText": "DELL\nLatitude 5440\nS/N: 7XK2P93\n…"
}
```

## Server APIs for other features

Import from `server/src/services/media-ai-core` and `server/src/services/ai`.
These are the stable surface; the files behind them may move.

### Owners

```ts
import { registerOwnerType } from "../media-ai-core";

// Once, at module load, in a file your router imports.
registerOwnerType("job", async (id) => (await getJob(id)) !== null, { table: "jobs" });
```

`exists` is checked before every upload and signature. `table` (and
`idColumn`, default `id`) lets the orphan sweep find attachments of deleted
jobs with one query; without it, that type's orphans are never swept. Built in:
`item`, `unit`, `location`.

### Attachments

```ts
saveAttachment({
  ownerType, ownerId,
  kind?,              // inferred from the bytes when omitted
  stage?, caption?,
  mime?,              // the claim; the bytes decide
  bytes? | stream?,   // exactly one; a stream is never held in memory whole
  expectedSize?,      // Content-Length, to refuse early
  width?, height?, durationMs?, meta?,
  createdBy,          // user oid, or null
}, client?): Promise<Attachment>
```

Pass a `pg` `PoolClient` as `client` to insert inside your own transaction;
files saved that way are limited to `ATTACHMENT_DB_MAX_MB`, since a file on
disk cannot roll back.

| Function | |
|---|---|
| `listAttachments(ownerType, ownerId, { kind?, stage? })` | `kind` may be one kind or an array. Oldest first. |
| `getAttachment(id)` | Metadata, or null. |
| `getAttachmentStream(id, rangeHeader?)` | `{ status: 200 \| 206, stream, range, size, attachment }` or `{ status: 416 }`. |
| `readAttachmentBytes(id, limit?)` | The whole file as a Buffer, for processing (vision, PDFs). Refuses over `limit` (64 MB). |
| `updateAttachment(id, { caption?, stage?, meta? })` | |
| `deleteAttachment(id)` | Removes the row and the file. |
| `deleteAttachmentsForOwner(ownerType, ownerId)` | For features that delete their own records and want files gone now. |
| `setAsPrimaryPhoto(id)` | Item photos only. |
| `thumbnail(id, width)` / `renderJpeg(bytes, { maxEdge })` | JPEG previews; null for formats the decoder cannot read (HEIC). |
| `detectMime(head, declared?)`, `parseRange(header, size)` | The pure helpers underneath. |

### Signatures

```ts
const sig = await sign({
  ownerType: "shipment", ownerId,
  signerName, signerEmail?, signerRole?,
  statement: "I received the items listed, in the condition noted.",
  content: { shipment: code, lines: lines.map((l) => ({ id: l.id, qty: l.qty, condition: l.condition })) },
  image: pngBuffer,           // optional
  ip, userAgent,
  signedByUser: user?.oid ?? null,   // null for someone without an account
});

const { valid, reason } = await verifySignature(sig.id, buildContentTheSameWay());
```

`content` is any plain JSON. It is canonicalized (keys sorted at every depth,
no whitespace, JSON number and string forms, as in RFC 8785) and its sha256 is
stored, along with the canonical snapshot itself (`getSignedContent(id)`). To
verify, rebuild the content from the record **the same way** and pass it in:
key order does not matter, but array order does, and adding or renaming a
field is a change. Build it from a function you keep next to the record type,
include only what the signer actually attested to, and leave out fields that
change for unrelated reasons (`updatedAt`). `canonicalJson` and `contentHash`
are exported for anything else that needs a stable fingerprint.

The image is saved as an attachment of the same record with kind `signature`,
in the same transaction as the signature. It cannot be deleted on its own.

### AI helpers

```ts
import { visionJson, transcribe, aiAvailability } from "../ai";

const result = await visionJson({
  event: "ai.condition",        // log prefix
  system: "You assess the condition of items from photos. Reply with one JSON object.",
  prompt: "Return { rating, defects: [...] } …",
  images: [{ mime: a.mime, bytes }],   // up to 10; redrawn at most 1600 px
  maxTokens: 800,
  context: { itemId },          // extra log fields
});
if (!result) { /* unavailable, failed or unparseable: carry on without it */ }
```

Same contract as `chatJson`: one JSON object back or null, never throws, 45 s
timeout. Normalize the reply yourself with a pure function and test it with
fixtures, including malformed ones (see `normalizeDataPlate` and its tests).

```ts
const transcript = await transcribe({ path: "/tmp/audio.m4a", mime: "audio/mp4" });
// { text, segments: [{ start, end, text }], language?, durationSec? } | null
```

`transcribe` accepts `bytes`, `stream` (buffered, up to 50 MB) or `path`
(streamed from disk), plus optional `language` and `prompt` hints. Five-minute
timeout.

`aiAvailability()` returns `{ languageModel, vision, transcription }` for
gating on the server.

## Client components

Import from `client/src/features/media-ai-core`.

```tsx
<AttachmentGallery
  ownerType="inspection" ownerId={id}
  stages={["before", "after"]}      // chips offered up front
  stage="before"                    // or lock to one stage
  kinds={["photo", "video"]}        // default: photo, video, audio, document
  readOnly={false}
  headerActions={<button>…</button>}
  actions={(attachment, { close, reload }) => <button>…</button>}
  refreshKey={n}                    // bump to reload after saving elsewhere
  onChange={(list) => …}
/>

<SignaturePad onSigned={(pngDataUrl | null) => …} height={180} />

<SignDialog
  ownerType="shipment" ownerId={id}
  statement="I received the items listed."
  content={buildContent(shipment)}
  onSigned={(signature) => …}
  onClose={() => …}
  defaultName? defaultRole? defaultEmail? requireEmail? title?
/>

const { vision, transcription, languageModel } = useAiAvailability();
```

`SignaturePad` uses pointer events (finger, stylus and mouse draw the same
line; pressure is ignored), has Undo and Clear, keeps strokes across rotation,
and exports a transparent PNG cropped to the ink at twice screen resolution.
Show it on a white background.

Client calls (`uploadAttachment` with progress, `listAttachments`,
`updateAttachment`, `deleteAttachment`, `setPrimaryPhoto`, `createSignature`,
`listSignatures`, `verifySignature`, `readDataPlate`, `applyDataPlate`) and the
types are exported from the same module. `Modal` is exported for dialogs that
should match.

## Security notes

- The stored and served type comes from the file's leading bytes. SVG and HTML
  are refused outright: served from this origin, either would run script.
  Office files are recognised as zip and accepted under their declared type;
  plain text, CSV and JSON only when declared and free of control characters.
- Files are served with `X-Content-Type-Options: nosniff`, and anything that
  is not an image, video, audio, PDF or plain text is served as a download.
- Disk paths are derived from the attachment id and resolved inside
  `DATA_DIR`; nothing a client sends becomes part of a path.
- Any signed-in person can read and add attachments, as with items. Deleting
  is open to members too, except signature images.
- A signature's hashes make a changed record detectable; they do not stop
  someone with database access rewriting both. The tamper-evident audit log is
  what covers that.

## Follow-ups

- Resumable, chunked uploads for long video over poor connections (and for
  offline field mode to reuse).
- Server-side video thumbnails and duration (needs ffmpeg; T20 adds it).
- Per-owner access rules once external parties (the portal) can upload.
