# Teardown guides

Film something being taken apart while you say what you are doing, and Bindex
turns the video into a reassembly guide: numbered steps, each tied to the
moment in the video it came from, a running list of the parts that came off
(hardware, components, cables), callouts for the things that are easy to get
wrong, a printable report, and labels for the bags the hardware goes into.
The guide stays with the item, so whoever puts it back together has it.

Typical uses: pallet racking and shelving, workstations and lab benches,
server and network equipment, machinery being relocated, furniture systems.

- [Using it](#using-it)
- [What happens to the video](#what-happens-to-the-video)
- [When something is not set up](#when-something-is-not-set-up)
- [Setting up ffmpeg, transcription and the models](#setting-up-ffmpeg-transcription-and-the-models)
- [HTTP API](#http-api)
- [Events](#events)
- [Storage, backups and housekeeping](#storage-backups-and-housekeeping)
- [Security notes](#security-notes)
- [Follow-ups](#follow-ups)

## Using it

The instance switch **Teardown guides** (Settings, `teardown`, on by default)
controls all of it. Off, the screens, the navigation link and the API
(`/api/teardown`, which answers 404 `feature_disabled`) go away, and queued
processing waits until it is switched back on. Guides already made are kept.

### Starting a guide

On an item's page, under **Teardown guides**, press **New guide**:

1. Give it a title (or keep the suggested "*item* teardown"), and if the item
   has tracked units, say whether the teardown is of the item as a whole or of
   one unit.
2. Then either
   - **Record a video**: opens the phone's camera;
   - **Choose from library**: pick a video already on the device, including one
     AirDropped or shared by another crew member (an audio recording of the
     narration works too);
   - **Or use one already attached**: any video or audio already in the item's
     (or unit's) photos and files;
   - **No video: write the steps by hand**.

The video is stored as an ordinary attachment of the item or unit with stage
`teardown` (see [media-ai-core](media-ai-core.md)), so it also shows in the
record's photos and files, with the same large-file storage and seeking.
Processing starts as soon as the guide is created.

**Narrating well.** Say what you are removing, how many, and anything to watch
for, as you do it: "Next, take out the four M6 bolts on the left upright. Keep
the safety pins, there are eight in total." Counts, warnings and "label this"
become callouts; the things you name become parts.

### The guide

- The **video** sits beside the steps (above them on a phone). Each step's
  time, or its picture, plays exactly that step's clip and stops at its end.
  The **Narration** panel lists the transcript with timestamps to jump to.
- **Take apart** lists the steps in order: title, time in the video,
  instruction, callout (highlighted), picture, and the parts that came off.
- **Put back** lists the same steps in reverse with a tick box per part, and a
  progress bar. Ticks are saved on the server, so several people can work
  through one guide; **Clear ticks** starts again.
- **Parts** is the whole list, filterable by kind, each with its quantity,
  step, note and tick box. A part the vision model renamed shows the name it
  was heard as.
- Every step and part can be edited. In a step, **Now** sets its start or end
  to where the video is, **Use this frame as the picture** takes the paused
  frame as the step's picture (this works without ffmpeg, in the browser), and
  **Move up**/**Move down** reorder it. **Add a step** starts at the video's
  current position.
- **Report (PDF)** is a Letter-size disassembly report: the callouts together
  up front, every step with its time and picture, the parts with a box to tick
  at reassembly, and a reverse-order reassembly checklist. It carries a QR code
  back to the guide.
- **Bag labels** prints one label per bag of hardware, one bag per step that
  detached any (plus one for hardware not tied to a step), on the same label
  printer and roll as item labels. The label reads "Step 3: 14 × M6 bolt, 4 ×
  washer" with the item's name; its barcode is the item's (or unit's) own
  asset code, so scanning a bag brings up the item, and its QR code opens the
  guide at that step with the video cued to it.
- **More** has **Read the steps again** (keeps the transcript, asks the
  language model again), **Transcribe again**, **Use a different video** and
  **Delete guide**. Deleting a guide removes its steps, parts and step
  pictures; the video stays with the item.

When the narration is read again, or read for a guide that already has steps,
the result does not overwrite anything: it waits under the video as "The
narration gave 12 steps and 9 parts", with **Use them**, **Discard** and a
preview.

The guides are also listed under **Teardowns** in the navigation, with a
search by guide or item.

## What happens to the video

Processing runs on the server, one guide at a time per server process. The
guide shows each stage while it runs and can be left and come back to.

1. **Sound track.** ffmpeg copies the sound out of the video as small mono
   audio (16 kHz AAC at 32 kbit/s, about 14 MB an hour), in ten-minute pieces,
   so every piece is well under providers' upload limits.
2. **Transcription.** Each piece goes to the speech-to-text provider, which
   returns the words with timestamps.
3. **Steps and parts.** The transcript is split into windows of about four
   minutes, and the language model turns each into steps
   (`{ n, title, instruction, start, end, callout }`) and parts detached
   (`{ name, kind, qty, stepN }`, kind one of hardware, component, cable,
   other). The replies are cleaned up before use: times are kept inside the
   window they came from, steps are put in time order, kinds are mapped from
   synonyms ("fastener", "furniture", "wire"), counts are read from words
   ("fourteen", "a dozen"), and anything unusable is dropped.
4. **Step pictures.** ffmpeg takes a still from the middle of each step.
5. **Part names.** The vision model is shown each step's picture with the
   parts heard for it and may make a name more specific ("bolt" becomes "M6
   hex bolt"). Parts a person has edited are left alone.

Each stage stores its result before the next begins. If the server restarts
mid-job, another process (or the same one on boot) takes the job over within
about three and a half minutes and carries on from the last piece stored, so
nothing already transcribed is paid for twice. A job that stops three times
without finishing is marked failed. **Stop** halts a job; **Continue** picks it
up where it stopped. After a failure, **Try again** does the same.

## When something is not set up

Everything degrades; the video is always kept and steps can always be written
by hand. What each missing piece means:

| Missing | Effect |
| --- | --- |
| Speech to text | Nothing is transcribed. The guide notes why; steps and parts are written by hand. With ffmpeg, processing still takes a picture for every step given a start time. |
| Language model | Steps are drafted straight from the transcript: a new step at each pause or "next", "then", "now"; sentences with warnings, counts or "label" become callouts; counted parts ("the four M4 screws") are picked out of the words. The guide says so. |
| A reply from the language model for part of the narration | That part is drafted straight from the transcript as above, and the guide says which minutes. |
| ffmpeg | A video up to 24 MB is sent for transcription whole (some providers accept only audio; installing ffmpeg avoids that). A larger one is not transcribed, and the guide says to install ffmpeg. Steps get no pictures from the server; **Use this frame** still works in the browser. |
| Vision model | Part names stay as heard. |
| Sound in the video | The guide notes that there is no narration to read. |

`GET /api/teardown/status` reports `{ ffmpeg, transcription, languageModel,
vision, printing }`, and the new-guide dialog says which of these apply.

## Setting up ffmpeg, transcription and the models

**ffmpeg.** The Docker image includes it (`apk add ffmpeg` in the runtime
stage; delete that line in the `Dockerfile` for a smaller image without it).
Elsewhere install it with `apt install ffmpeg` or `brew install ffmpeg`. The
server looks for it once, at the first job, on `PATH` or at `FFMPEG_PATH`, and
logs `teardown.ffmpeg.found` or `teardown.ffmpeg.missing`; restart the server
after installing it. Only the `ffmpeg` binary is used, not `ffprobe`.

| Setting | Default | |
| --- | --- | --- |
| `FFMPEG_PATH` | `ffmpeg` | The ffmpeg binary. |

**Transcription** uses the `STT_BASE_URL`, `STT_API_KEY` and `STT_MODEL`
settings described in [media-ai-core](media-ai-core.md#setting-up-vision-and-transcription):
any OpenAI-compatible `/audio/transcriptions` endpoint that returns
`verbose_json` (OpenAI `whisper-1`, Groq, or a local faster-whisper or
speaches server). OpenRouter has no transcription endpoint, so set these when
the language model is on OpenRouter. The item's name, brand and model are sent
as a vocabulary hint.

**Steps and parts** use the chat model (`LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_MODEL`). Each window of narration is one request of a few thousand
characters asking for up to 2,000 tokens back; the helper waits ten seconds
for each, which is why windows are kept short. A slow local model that misses
that falls back to the transcript draft for that window.

**Part names from pictures** use the vision model (`LLM_VISION_MODEL`), one
request per eight steps that have both a picture and parts, each picture
redrawn at most 1,600 px.

Each person can create guides and start processing 30 times an hour in all;
past that the server answers 429 until the hour is up.

**Developing without a key.** `server/tests/teardown-stub.ts` is a stand-in
provider that answers as a narrated workstation teardown:

```bash
pnpm --filter bindex-server exec tsx tests/teardown-stub.ts 4120
LLM_BASE_URL=http://127.0.0.1:4120/v1 STT_BASE_URL=http://127.0.0.1:4120/v1 \
  LLM_API_KEY=stub LLM_VISION_MODEL=stub-vision pnpm dev
```

A sample video is quick to make with ffmpeg's test pattern and a tone:
`ffmpeg -f lavfi -i testsrc2=size=320x240:rate=15 -f lavfi -i sine=frequency=440 -t 60 -pix_fmt yuv420p -shortest sample.mp4`.

## HTTP API

All under `/api/teardown`, behind the usual session or API key (read-only keys
can use the `GET` routes). Every change answers with the whole guide.

| Method and path | |
| --- | --- |
| `GET /status` | `{ ffmpeg, transcription, languageModel, vision, printing }`. |
| `GET /guides?itemId=&q=&limit=` | Summaries, most recently changed first. `itemId` includes the item's units' guides; `q` searches guide title, item name and asset code. |
| `POST /guides` | `{ itemId, unitId?, title?, notes?, videoAttachmentId?, process? }` → 201 with the guide. With a video, processing starts unless `process: false`. The video must be a `video` or `audio` attachment of the item or one of its units; a unit's video makes the guide that unit's. |
| `GET /guides/:id` | The guide (below). |
| `PATCH /guides/:id` | `{ title?, notes?, videoAttachmentId?, process? }`. A new video clears what was read from the old one (steps stay) and is processed unless `process: false`. |
| `DELETE /guides/:id` | 204. Removes steps, parts and step pictures; the video stays. |
| `POST /guides/:id/process` | `{ mode?: "continue" \| "steps" \| "all" }` → 202. `continue` does whatever is missing; `steps` reads steps again from the transcript; `all` transcribes again. 409 while processing. |
| `POST /guides/:id/process/cancel` | Stop a queued or running job. |
| `POST /guides/:id/draft/apply` | Replace the steps and parts with the ones waiting for review, then take their pictures. 409 when nothing is waiting. |
| `DELETE /guides/:id/draft` | Discard them. |
| `POST /guides/:id/steps` | `{ title, instruction?, start?, end?, callout?, keyframeAttachmentId?, afterN? }` (`afterN: 0` puts it first; omitted, last). |
| `PATCH /steps/:stepId` | Any of those, plus `n` to move it. `keyframeAttachmentId` must be a photo attachment of the guide (owner type `teardown_guide`); `null` removes the picture. |
| `DELETE /steps/:stepId` | Its parts stay on the list, not tied to a step. |
| `POST /guides/:id/parts` | `{ name, kind?, qty?, stepId?, note? }`. Without `kind`, it is worked out from the name. |
| `PATCH /parts/:partId` | Any of those, plus `reassembled: true \| false` to tick it off. |
| `DELETE /parts/:partId` | |
| `POST /guides/:id/reassembly/reset` | Clear every tick. |
| `GET /guides/:id/report.pdf?tz=` | The report. `tz` is an IANA time zone for the printed time. |
| `GET /guides/:id/bag-labels.pdf?steps=3,5` | Label PDF, one exact-size page per bag. `steps` picks bags by step number (`0` is hardware not tied to a step); omitted, every bag. 404 when there is no hardware to label, or when label printing is switched off. |

A step picture taken in the browser is uploaded with the attachment API
(`POST /api/attachments?ownerType=teardown_guide&ownerId=<guide>&kind=photo&stage=keyframe`)
and then set with `PATCH /steps/:stepId`.

The guide:

```json
{
  "id": "…", "title": "Lab workstation teardown", "notes": null,
  "itemId": "…", "unitId": null,
  "item": { "id": "…", "name": "Lab workstation", "assetCode": "INV-4F2K1B", "brand": "Dell", "model": "Precision 3660", "category": null },
  "unit": null,
  "video": { "id": "…", "kind": "video", "mime": "video/mp4", "url": "/api/attachments/…", "…": "…" },
  "durationSec": 58,
  "transcript": { "text": "…", "segments": [{ "start": 0, "end": 5.2, "text": "…" }], "language": "english", "complete": true },
  "draft": null,
  "job": {
    "status": "done", "stage": null, "progress": null, "error": null, "attempts": 1,
    "notes": [{ "code": "refined", "message": "1 part name was made more specific from the step pictures." }],
    "queuedAt": "…", "startedAt": "…", "finishedAt": "…"
  },
  "steps": [
    { "id": "…", "n": 2, "title": "Remove the top cover", "instruction": "Remove the four M4 screws…",
      "start": 12.8, "end": 28, "callout": "The fan cable is still attached to the cover",
      "source": "narration", "keyframe": { "id": "…", "url": "…", "thumbUrl": "…" }, "updatedAt": "…" }
  ],
  "parts": [
    { "id": "…", "stepId": "…", "stepN": 2, "name": "M4 x 6 mm pan head screw", "kind": "hardware", "qty": 4,
      "note": null, "source": "narration", "heardAs": "M4 screw", "edited": false,
      "reassembledAt": null, "reassembledBy": null }
  ],
  "createdBy": "local:…", "createdAt": "…", "updatedAt": "…"
}
```

`job.status` is `idle`, `queued`, `running`, `done` or `failed`; while running,
`stage` is `audio`, `transcribe`, `steps`, `keyframes` or `refine` and
`progress` is `{ done, total }` within it. `job.notes` explain anything
skipped, by `code`: `no_transcription`, `no_language_model`, `model_partial`,
`no_ffmpeg_large`, `no_ffmpeg_frames`, `no_audio`, `no_speech`, `no_video`,
`draft_pending`, `refined`, `refine_unanswered`, `stopped`. `draft` is
`{ complete: true, steps, parts }` when steps read from the narration are
waiting for review (parts refer to steps by `step`, 1-based), or
`{ complete: false, windowsDone, windowsTotal }` while they are being read.

## Events

Published to the audit log and webhooks (see [event-backbone](event-backbone.md)),
with subject `{ type: "teardown_guide", id }`:

| Type | When | `data` |
| --- | --- | --- |
| `teardown.guide_created` | A guide was started | `{ guideId, itemId, unitId, title, hasVideo }` |
| `teardown.guide_processed` | Processing finished | `{ guideId, itemId, unitId, title, transcribed, steps, parts, draftPending, notes }` (`notes` is the list of note codes) |
| `teardown.reassembly_completed` | The last part was ticked off | `{ guideId, itemId, unitId, title, parts }` |
| `teardown.guide_deleted` | A guide was deleted | `{ guideId, itemId, unitId, title }` |

## Storage, backups and housekeeping

Three tables (`server/migrations/0041_teardown.sql`): `teardown_guides`,
`teardown_steps` and `teardown_parts`. The processing queue is the guides
table itself: a guide waiting to be processed has `job_status = 'queued'`.
Every server replica runs the worker; a job is claimed with `SELECT … FOR
UPDATE SKIP LOCKED` and held with a heartbeat and a token, so two replicas
never process the same guide and a stale holder's writes are refused.

The video is an attachment of the item or unit. Step pictures are attachments
of the guide (owner type `teardown_guide`, stage `keyframe`), stored like
photos: in Postgres up to `ATTACHMENT_DB_MAX_MB`.

While a video is being processed, ffmpeg works on a copy of it under
`DATA_DIR/teardown-work/<guide>/` (a pipe will not do: phones write the video's
index at the end of the file). Allow free space there for the largest video
being processed; the copy is removed when the job ends, and anything left by a
crash is removed after a day.

Guides point at their item without a foreign key. A JSON restore deletes and
re-inserts every item in one transaction, and a cascade would take the guides
with it. Instead an hourly sweep removes guides whose item has been deleted
(after a ten-minute grace period), and the attachment sweep then removes their
step pictures.

The **JSON backup** in Settings includes the three tables. Restoring a file
that has guides replaces the instance's guides with the file's; restoring an
older file without them leaves the guides alone. Videos and step pictures are
attachments, which the JSON backup does not carry; back up Postgres and
`DATA_DIR` as described in [media-ai-core](media-ai-core.md#backups).

## Security notes

- Any signed-in person can create, edit and process guides, as with items.
  Read-only API keys can list and read guides and download the report and
  labels.
- A guide's video must already be an attachment of its item or one of its
  units, and a step's picture an attachment of the guide itself, so a guide
  cannot be used to reach files of other records.
- ffmpeg reads only the server's own copy of an attachment, and is given no
  argument that comes from a person (no file names, no filters).
- Transcripts and step text are sent to the configured providers, the same as
  the rest of the AI features. Leave the providers unset to keep everything on
  the server.

## Follow-ups

- A share link for a guide, read-only and without an account: a crew at the
  destination opens the guide from the bag label without signing in. The
  external portal (T15) and jobs (T03) it would build on are now in the build;
  the link itself is not written yet.
- The chat helper waits a fixed ten seconds; a per-call timeout would let
  processing send larger windows to slower (local) models.
- A server-side path to an attachment's file would let ffmpeg read videos on
  disk in place instead of copying them.
- Poster frames and durations for every video attachment, now that ffmpeg is
  in the image (a T02 follow-up).
- Recording in the app with a live transcript, and resumable uploads for long
  videos over poor connections.
