# Documents, templates and conditional packets

Paperwork that goes with the work: a relocation sign-off, a site survey, a
handover certificate. Administrators build **templates** from blocks
(headings, text with merge fields, fields to fill in, tables of job data) and
group them into **packets** with conditions ("every job of type IT
relocation"). A job gets its packets on its own when it is created or changes
to match. People fill the documents in, **complete** them (the values are
fixed and hashed), **sign** them, and **export** a PDF whose hash is recorded,
so a copy that turns up later can be checked.

Everything here is behind one instance feature switch, **Documents**
(`features.documents`, stored as `features.documents` in `app_settings`). It
is off by default. With it off the Documents navigation entry and its screens
are gone, every `/api/documents`, `/api/document-templates`,
`/api/document-fields` and `/api/document-packets` request answers
`404 feature_disabled`, and jobs no longer get packets. Packets need
**Projects, jobs and shipments** (`features.jobs`) to be of any use;
documents on their own, without a job, work either way.

- [Using it](#using-it)
- [Templates](#templates)
- [Packets and conditions](#packets-and-conditions)
- [Filling, completing and signing](#filling-completing-and-signing)
- [PDFs and verification](#pdfs-and-verification)
- [HTTP API](#http-api)
- [Events](#events)
- [Extension points](#extension-points)
- [Data model](#data-model)
- [Security notes](#security-notes)

## Using it

1. **Settings → Documents → Field library** (optional): fields you use in
   several templates, such as "Site contact". One key per meaning is what lets
   a new document copy values from an earlier one.
2. **Templates → New template**: start blank or from the example sign-off.
   Add blocks, preview against the sample job or a real one, **Publish**.
3. **Packets → New packet**: pick the templates, in order, and the jobs they
   are for (job type, project, phase, site, rules on the job's details).
   **Try it on a job** says whether a job would match and why. **Apply to open
   jobs** attaches it to jobs already running.
4. Create a job of a matching type. Its documents are waiting under
   **Documents**, or at `/documents/jobs/<job id>`.
5. Open a document, fill it in (it saves as you type), **Complete**, then
   **Sign** each signature field on the signer's device.
6. **Export PDF**. Anyone holding the file can check it under **Documents →
   Verify a PDF**.

## Templates

### Blocks

| Block | Holds |
| --- | --- |
| Heading | Text, three sizes. Merge fields allowed. |
| Paragraph | Text; line breaks are kept. Merge fields allowed. |
| Field | One input: text (one line or several), number (with minimum and maximum), date, tick box, list of choices, signature, initials. Required or not, help text, and for signatures the statement the signer agrees to. |
| Table | Rows from job data: the manifest (filtered by floor, department or stage), the task list or the shipments. Choose the columns and a title; say what to print when there are no rows. |
| Divider | A rule. |

The editor is a list of blocks edited in place (move up and down, remove,
add), with no rich-text dependency. A field block carries its whole
definition; one inserted from the library is copied in and marked "from the
library", so changing the library never changes a published template.

A required tick box must be ticked, which is how an "I agree" box works.
Signature and initials fields are drawn through the signing dialog, never
typed.

### Merge fields

`{{path}}` in a heading, paragraph, table title or the printed title is
replaced with data. Unknown paths print nothing and are listed in the editor
preview (and, for administrators, on the document) so a typo is caught.

| Path | Value |
| --- | --- |
| `job.code`, `job.name`, `job.type`, `job.status`, `job.notes` | The job |
| `job.origin`, `job.destination` | Location names |
| `job.originPath`, `job.destinationPath` | Full paths, "HQ / Floor 3" |
| `job.scheduledStart`, `job.scheduledEnd`, `job.startedAt`, `job.completedAt` | Dates, in the viewer's time zone |
| `job.metadata.<key>` | Anything stored on the job (`setJobMetadata`) |
| `project.code`, `project.name`, `project.client`, `project.startsOn`, `project.endsOn` | The job's project |
| `phase.name`, `phase.startsOn`, `phase.endsOn` | The job's phase |
| `manifest.count`, `manifest.floors`, `manifest.departments` | The manifest |
| `manifest.packed`, `manifest.loaded`, `manifest.delivered`, `manifest.placed` | Lines at that step or past it |
| `shipments.count`, `shipments.codes`, `tasks.count`, `tasks.done` | Shipments and tasks |
| `org.name`, `app.name` | The instance |
| `document.id`, `document.title` | The document itself |
| `today` | Today's date; once completed, the completion date |
| `field.<key>` | A value filled in on this document |

Dates stored as a calendar day print as that day whatever the zone; times
print in the viewer's zone (the PDF takes `?tz=`). Numbers use the instance
locale; tick boxes print Yes or No; lists are joined with commas.

The preview uses a sample job that has a value for every path above, or a
real job you pick.

### Versions

- A new template is **version 1, draft**.
- **Save draft** writes into the draft. Saving over a template whose latest
  version is published starts a **new draft**, numbered after the highest
  version. There is only ever one draft.
- **Publish** freezes the draft. Anything that would stop people filling it
  in (a list with no choices, two fields with one key, an unknown table
  column, no blocks) is refused with what to fix.
- New documents start from the **latest published** version and keep it for
  good. A draft on an older version says so and offers **Duplicate**, which
  carries the values over to the newest version.
- **Discard changes** drops the draft and goes back to the published version.
- A template that documents use cannot be deleted; switch it off instead (no
  new documents, packets skip it).

## Packets and conditions

A packet is an ordered list of templates and the conditions saying which jobs
need them. Every kind of condition that is set must hold; within a list, any
one entry will do; a packet with no conditions applies to every job (the
editor asks before saving one that attaches itself).

| Condition | Holds when |
| --- | --- |
| Job type is one of | The job's type is in the list |
| Project is one of | The job belongs to one of the projects |
| Phase is one of | The job is in one of the phases |
| Site | The origin, the destination, or either (`siteSide`) is one of the locations or anywhere inside it |
| Rules | Tests on the job's `status`, `name`, `code`, `type`, `project`, `phase`, `origin`, `destination`, `scheduledStart`, `scheduledEnd`, `notes` or `metadata.<key>`, combined with all (default) or any |

Rule operators: `equals`, `not_equals`, `in`, `not_in` (a list, or a
comma-separated string), `contains`, `not_contains`, `starts_with`, `exists`,
`not_exists`, `gt`, `gte`, `lt`, `lte`. Text compares without regard to case
or surrounding space; numbers compare as numbers and ISO dates as dates; a
value that cannot be compared does not match. An empty job field matches only
the negative operators. `evaluateConditions` in
`services/documents/conditions.ts` holds the rules and is unit-tested.

### When packets attach

Documents listen to the jobs core's `onJobChanged` hook (no jobs-core file is
edited). On every job create and update:

- An **automatic** packet (`autoAttach`, switched on) that the job now
  matches and does not have is attached: one document per template, in packet
  order, from each template's latest published version. Templates not
  published yet are skipped and reported.
- An automatic packet the job **no longer** matches (its type changed) is
  withdrawn: its documents nobody has touched (drafts with no values) are
  deleted; filled-in ones are kept, and the packet shows "no longer matches
  this job". If the job matches again, the packet applies again and any
  template missing a document gets one.
- A packet is attached once. A document someone deleted on purpose is not
  recreated by the next job save.
- Switching a packet off, or setting it to attach by hand only, stops it
  attaching to new jobs; it is not a recall.
- Packets added by hand are never withdrawn automatically. **Remove** takes a
  packet off a job: untouched documents go, the rest stay.

Changes to one job's packets are serialised with an advisory lock, so a job
saved twice at once cannot get a packet twice. A failure here is logged
(`documents.packet.sync_failed`) and never fails the job change. **Check
packets** on the job's documents page runs the same sync by hand.

## Filling, completing and signing

A document is **draft**, **completed** or **signed**.

- **Draft**: values save as you type (after a short pause, and on leaving a
  field or the page). Each save sends only the fields changed, so two people
  filling different fields do not overwrite each other. Values are checked
  against their field (a number within its range, a real date, one of the
  choices) and a bad one is refused with the reason, shown under the field.
  Job data in merge fields and tables is live.
- **Copy from…** fills the draft from another document: every field with the
  same key whose value fits. Documents of the same template are offered first,
  then any other sharing a key. Signatures are never copied; values already
  filled in are kept unless you ask to replace them.
- **Duplicate** starts a new draft with the same values (not signatures), on
  the newest published version, on the same job.
- **Complete** requires every required field other than signatures. It then
  freezes the job data the document shows (merge context, table rows, today's
  date) into a **snapshot**, and stores the **content hash**: the sha256 of
  the canonical JSON of the template version, title, values (without
  signatures) and snapshot. From here the document prints what was agreed,
  not what the job says today.
- **Sign**: each signature or initials field opens the shared signing dialog
  (`SignDialog`). The signer signs the statement
  `{ kind: "bindex.document.signature", documentId, templateVersionId,
  contentHash, field }`, which the server hands out and checks: a signature
  made on another document, for another field, or before a change, is
  refused. When every required signature field is signed the document is
  **signed**. Optional fields can still be signed afterwards.
- **Reopen** takes a completed document back to draft, as long as nobody has
  signed it. A signed document never changes; duplicate it instead.
- Drafts can be deleted by anyone; completed and signed documents only by an
  administrator.

## PDFs and verification

`GET /api/documents/:id/pdf?tz=` renders the document on Letter paper: title
and details, every block with merge fields resolved, tables that flow across
pages with the header repeated, signature images with the signer's name,
role and time, and for a completed document a closing **Record** (status,
who completed it and when, each signature with its id, template version,
document id, content hash). Every page carries the **audit footer**: the
document id, its status, the content hash and the page number.

- A **draft** prints "DRAFT - not completed" and "Not completed: the content
  is not fixed and has no hash". It is not recorded.
- A **completed or signed** document's PDF is recorded in `document_exports`
  by the sha256 of its bytes and kept as an attachment of the document (stage
  `export`), and a `document.exported` event goes to the audit log. The
  response carries `X-Document-Sha256` and `X-Document-Export`.
- Rendering is deterministic: the PDF's dates come from the document, not the
  clock, so exporting the same state in the same time zone gives the same
  bytes and reuses the same record.

Checking:

- `POST /api/documents/verify-pdf` with the file as the body (the **Verify a
  PDF** screen) answers which export it is, when it was made, in which state,
  whether the document still matches it (`exportedContentStillCurrent`), and
  the document's full check. A file changed by even one byte is not found.
- `GET /api/documents/:id/verify` recomputes the content hash from the stored
  values and snapshot and compares it with the recorded one, then verifies
  every signature against it (which also checks each signature image is
  intact). Anyone rewriting a value in the database breaks both.

Text the standard PDF fonts cannot encode (emoji, CJK) prints as `?` rather
than failing the document.

## HTTP API

All under the usual session or API-key authentication. Template, field and
packet changes need an administrator's browser session (`requireAdmin`);
everything else is open to any signed-in user and to read-write API keys
(read keys get the `GET`s).

### Documents

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/api/documents/meta` | Field types, block types, table sources and their columns, merge fields, `share: { available, provider }`, whether jobs are on |
| GET | `/api/documents/jobs` | `?q=`: up to 50 jobs for pickers |
| GET | `/api/documents` | `?jobId=&templateId=&status=draft\|completed\|signed&q=&limit=` |
| POST | `/api/documents` | `{ templateId, jobId?, copyFromId? }` → the document detail |
| GET | `/api/documents/:id` | `?tz=`: document, template, version and body, job, packet, render model, signatures, what each signature field signs (`signing`), exports |
| PATCH | `/api/documents/:id` | `{ values?: { key: value \| null }, title? }`, drafts only |
| DELETE | `/api/documents/:id` | Drafts; completed or signed ones by an administrator |
| GET | `/api/documents/:id/copy-sources` | Documents sharing field keys, same template first |
| POST | `/api/documents/:id/copy-from` | `{ sourceId, overwrite? }` → `{ copied, skipped, values }` |
| POST | `/api/documents/:id/duplicate` | `{ jobId? }` → the new draft |
| POST | `/api/documents/:id/complete` | `{ tz? }`; 400 with `details.missing` naming empty required fields |
| POST | `/api/documents/:id/reopen` | 409 once anyone has signed |
| POST | `/api/documents/:id/signatures` | `{ fieldKey, signatureId }`, after `POST /api/signatures` with `ownerType: "document"` and the `signing[fieldKey]` statement and content |
| GET | `/api/documents/:id/verify` | `{ valid, status, content: { storedHash, currentHash, matches }, signatures: [...] }` |
| GET | `/api/documents/:id/pdf` | `?tz=&download=1` |
| POST | `/api/documents/:id/share` | `{ email?, expiresInDays?, allowSigning? }`; 404 `share_unavailable` without a portal |
| POST | `/api/documents/verify-pdf` | The PDF as the body (`Content-Type: application/pdf`, up to 32 MB) |
| GET | `/api/documents/job/:jobId` | `{ job, packets: [{ packetId, name, auto, applies, attachedAt }], documents }` |
| POST | `/api/documents/job/:jobId/sync` | Run the packet sync now → `{ attached, withdrawn }` |
| POST | `/api/documents/job/:jobId/packets` | `{ packetId }`: attach by hand |
| DELETE | `/api/documents/job/:jobId/packets/:packetId` | `{ removed, kept }` |

```bash
# Export a signed document and check the file later.
curl -b cookies -D headers -o signoff.pdf "$URL/api/documents/$DOC/pdf?tz=America/Chicago"
curl -b cookies -H 'Content-Type: application/pdf' --data-binary @signoff.pdf "$URL/api/documents/verify-pdf"
```

### Templates, fields and packets

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/api/document-templates` | `?all=true` includes switched-off ones; each with `latestVersion`, `publishedVersion`, `hasDraft`, `documentCount` |
| POST | `/api/document-templates` | `{ name, description?, title?, body?, active? }` (admin) |
| GET | `/api/document-templates/:id` | With `draft`, `published`, `editing`, `versions`, `problems` |
| PATCH | `/api/document-templates/:id` | Same fields (admin). `title` and `body` go into the draft |
| POST | `/api/document-templates/:id/publish` | (admin) |
| DELETE | `/api/document-templates/:id/draft` | Discard unpublished changes (admin) |
| DELETE | `/api/document-templates/:id` | Only when no document uses it (admin) |
| GET | `/api/document-templates/:id/versions/:n` | One version's title and body |
| POST | `/api/document-templates/preview` | `{ title?, body, jobId?, values?, tz? }` → render model and `problems` |
| POST | `/api/document-templates/preview.pdf` | Same body → a draft-marked PDF |
| GET | `/api/document-fields` | `?all=true` includes ones not offered in the editor |
| POST/PATCH/DELETE | `/api/document-fields[/:id]` | `{ key, label, type, required?, options?, multiline?, placeholder?, help?, statement?, min?, max?, active? }` (admin); `null` clears a setting |
| GET | `/api/document-packets` | With templates, conditions and how many jobs each is on |
| GET | `/api/document-packets/options` | Job types, projects with phases, rule fields and operators |
| POST | `/api/document-packets/test` | `{ conditions, jobId }` → `{ matches, checks }` |
| POST/PATCH/DELETE | `/api/document-packets[/:id]` | `{ name, description?, templateIds, conditions?, autoAttach?, active? }` (admin) |
| POST | `/api/document-packets/:id/apply` | Attach to every open job it matches now (admin) |

Template bodies are validated block by block; a bad one is refused with a
message naming the block, such as `Block 2, label: Every field needs a label.`

## Events

Published on the event backbone after each change commits, so they are in the
audit log and available to webhooks (group **Documents**).

| Type | Subject | `data` |
| --- | --- | --- |
| `document.created` | `document` | `{ title, templateId, version, jobId, packetId }` (documents started by hand; packet documents are summed up in `document_packet.attached`) |
| `document.completed` | `document` | `{ title, contentHash, jobId }` |
| `document.reopened` | `document` | `{ title }` |
| `document.signed` | `document` | `{ title, field, fieldLabel, signatureId, signerName, status, contentHash }` |
| `document.exported` | `document` | `{ title, sha256, contentHash, status, exportId }` |
| `document.deleted` | `document` | `{ title, status, jobId, contentHash }` |
| `document_packet.attached` | `job` | `{ packetId, name, documents, unpublished, auto }` |
| `document_packet.withdrawn` | `job` | `{ packetId, name, removed, kept, manual? }` |
| `document_template.published` | `document_template` | `{ name, version, blocks }` |

## Extension points

Import from `server/src/services/documents` (the index), never from the files
behind it.

### Sharing through the portal

The external portal is a separate feature. Documents feature-detect it: a
provider registered when its module loads turns sharing on, and until one is
registered `meta.share.available` is false and the **Share** button is
hidden. The portal does not register one yet, so the button stays hidden; see
[Integration](#integration).

```ts
import { registerDocumentShareProvider } from "../documents";

registerDocumentShareProvider({
  name: "portal",
  available: async () => (await getConfig()).features.portal,
  share: async ({ documentId, jobId, email, expiresInDays, allowSigning }, actor) => {
    const grant = await createGrant(/* ... */);
    return { url: grant.url, expiresAt: grant.expiresAt.toISOString() };
  },
});
```

A portal that lets an outside signer sign should call `getDocumentDetail(id)`
for `signing[fieldKey]`, sign with `sign()` from media-ai-core against
`ownerType: "document"`, then `attachSignature(id, { fieldKey, signatureId },
actor)`, the same path the screens use.

### More table sources

```ts
import { registerTableSource } from "../documents";

registerTableSource({
  name: "claims",
  label: "Claims",
  columns: [{ key: "code", label: "Claim" }, { key: "status", label: "Status" }],
  defaultColumns: ["code", "status"],
  filters: [],
  sample: [{ code: "CLM-1", status: "open" }],
  load: async (jobId) => ({ rows: await claimRowsFor(jobId), total }),
});
```

A column with `term: "item"` or `term: "location"` is headed with the
instance's own word for that concept.

### Service functions

| Function | For |
| --- | --- |
| `createDocument({ templateId, jobId?, packetId? }, actor)` | Starting a document from code |
| `listDocuments({ jobId?, templateId?, status?, q? })`, `jobDocuments(jobId)` | A job's paperwork (the portal, claims evidence) |
| `getDocumentDetail(id, tz)` | Render model, signatures and what each field signs |
| `completeDocument`, `attachSignature`, `verifyDocument` | The lifecycle |
| `documentPdf(id, { timeZone, actor })`, `verifyPdf(bytes)` | Exports and checks |
| `syncJobPackets(jobId, actor)`, `attachPacket`, `detachPacket` | Packets |
| `evaluateConditions`, `resolveMerge`, `buildRenderModel`, `renderDocumentPdf`, `documentContentHash` | The pure pieces |

### Client

`client/src/features/documents` exports the lazily loaded pages for
`App.tsx`, `DocumentsSettingsSection` for Settings, and
`<JobDocumentsPanel jobId={job.id} />`, the job's packets and documents as a
panel that renders nothing while the feature is off. The job page shows it
below the job's own documents (see [Integration](#integration)).

## Data model

Migration `server/migrations/0038_documents.sql`; Drizzle definitions in
`server/src/db/tables/documents.ts`.

| Table | Holds |
| --- | --- |
| `document_custom_fields` | The library: key (unique, lower_snake), label, type, required, `config` (options, multiline, placeholder, help, statement, min, max), active |
| `document_templates` | Name (unique, case-insensitive), description, active |
| `document_template_versions` | Template, version number, `draft` or `published` (at most one draft per template), printed title, `body` jsonb blocks, published at and by |
| `document_packets` | Name (unique), description, `conditions` jsonb, `auto_attach`, active |
| `document_packet_templates` | Packet, template, position |
| `document_job_packets` | Which packets a job has: `auto` (by conditions) or by hand, `applies` (false once an automatic packet stops matching but keeps filled-in documents) |
| `documents` | Template and version, job (cascade), packet (set null), position, title, status, `field_values` jsonb, `snapshot` jsonb, `content_hash`, copied from, completed at and by, signed at |
| `document_exports` | Every recorded PDF: document, sha256 (indexed), content hash, status, size, the attachment holding it |

Deleting a job deletes its documents; their signatures and exported PDFs
(attachments owned by `document`) go with the hourly orphan sweep. Deleting a
template is refused while documents use it.

Packet conditions are jsonb checked by the application, so a new kind of
condition needs no migration. Documents do not use `job_types.settings`:
conditions reach past the job type (project, phase, site, rules), so they
live on the packet.

### Backups

The JSON backup includes all eight tables. Signatures and exported PDFs are
attachments, which the JSON backup leaves out (see
[media-ai-core](media-ai-core.md#backups)): restoring over the same database
keeps them; on another database an export stays recorded by its hash with no
stored copy. Restoring a file written before documents existed clears
documents but keeps templates, fields and packets, the way job types are
kept.

## Security notes

- Signatures sign a server-built statement naming the document, the field and
  the content hash; `attachSignature` refuses a signature made on another
  record or over other content, so a client cannot pass off one signature as
  another.
- The content hash and signatures make a changed document detectable; they
  do not stop someone with database access rewriting everything and every
  hash. The tamper-evident audit log holds `document.completed`,
  `document.signed` and `document.exported` with the hashes, which is what
  covers that.
- Any signed-in user can fill, complete and sign documents, as with jobs.
  Deleting a completed or signed document takes an administrator; templates,
  fields and packets take an administrator's browser session.

## Integration

- The job page (`client/src/features/jobs-core/JobDetail.tsx`) renders
  `<JobDocumentsPanel jobId={job.id} />` after `<DocumentsPanel job={job} />`,
  and links to `/documents/jobs/<job id>` when the feature is on (added at
  integration, 1ca09fe). The documents are also listed under **Documents**.
- Follow-up: the portal should register a share provider as above, so a
  document can be shared through a portal link.

## Code map

```
server/migrations/0038_documents.sql
server/src/db/tables/documents.ts
server/src/services/documents/
  index.ts        public surface
  model.ts        blocks, field types, template checks (pure)
  merge.ts        merge fields and value formatting (pure)
  conditions.ts   packet conditions (pure)
  values.ts       value checks, required fields, copying (pure)
  layout.ts       the render model (pure)
  content.ts      content hash and signing statement (pure)
  pdf.ts          the PDF (pure)
  sources.ts      table sources registry
  sample.ts       the preview's sample job
  context.ts      live job data, snapshots, built-in table loaders
  fields.ts templates.ts packets.ts documents.ts exports.ts
  hooks.ts        owner type and the onJobChanged listener
  events.ts       event types
  share.ts        the portal seam
  backup.ts       tables in the instance backup
server/src/routes/documents.ts
client/src/features/documents/
server/tests/documents.test.ts      pure logic and the PDF
server/tests/documents-db.test.ts   the whole flow on Postgres (opt-in)
```

## Testing

```bash
pnpm test                                    # pure logic, no database
createdb bindex_documents_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_documents_test \
  pnpm --filter bindex-server exec tsx --test tests/documents-db.test.ts
```

The Postgres test runs the acceptance flow: an IT relocation job gets its
packet, a delivery job does not, a type change withdraws the untouched
document and keeps a filled one, the document is completed (required fields
enforced), signed (a mismatched signature refused), exported twice to the
same bytes, verified from the file, tampered with in the database and caught,
copied and duplicated, the template versioned, and the whole set taken
through a backup and restore.
