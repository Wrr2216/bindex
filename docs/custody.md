# Chain of custody and digital sign-off

Every box of sensitive files, every vault and every high-value piece of kit
gets a timestamped, signed trail from origin to destination. A **custody
transfer** records one handoff: who released which items, who received them,
when and where, under which seals, what the receiver found, and both parties'
signatures over a fingerprint of the exact list. An item's **chain of custody**
is the ordered list of transfers it has been through.

At delivery the receiving party reviews every line of a shipment, with its
photos and anything already flagged, marks what is missing, damaged or
refused, and signs, on the crew's device or on their own phone through a
one-time link. Items marked **custody-controlled** cannot be marked delivered
on a job until that has happened.

Every completed transfer produces a PDF receipt, is published to the
tamper-evident audit log, and can be verified at any time: the page says
whether the list and each signature still match what was signed, and which
audit-log entry recorded it.

- [Using it](#using-it)
- [The custody policy](#the-custody-policy)
- [Purposes](#purposes)
- [What is signed, and how it is verified](#what-is-signed-and-how-it-is-verified)
- [One-time signing links](#one-time-signing-links)
- [Events](#events)
- [HTTP API](#http-api)
- [Data model](#data-model)
- [Decisions](#decisions)
- [Code map and tests](#code-map-and-tests)
- [Follow-ups](#follow-ups)

## Using it

Everything is behind one instance switch, **Chain of custody** (Settings,
`features.custody`, off by default). With it off, the Custody navigation entry,
its screens and the section on item pages are gone; every `/api/custody` and
signing-link request answers `404 feature_disabled`; and the policy below is
not enforced (there would be no screen to satisfy it from). Delivery sign-off
for shipments also needs **Projects, jobs and shipments** switched on.

Signatures and receipts are stored through the attachments core, so the
database holds them; see [Attachments, signatures and AI
capture](media-ai-core.md) for storage and backups.

### Marking what is controlled

On an item's page, **Chain of custody → Require signed handoffs** marks it
custody-controlled, with an optional reason ("Personnel records"). Mark a
container and everything packed inside it, at any depth, is controlled too;
the item page says which container the control comes from. Anyone signed in
can mark an item; only an administrator can release the control, since that
weakens the policy.

### A handoff

1. **Custody → New handoff** (or **Hand off** on an item's page, which starts
   with that item on the list). Pick the purpose, who releases and who
   receives (you, a holder, or anyone else by name and organisation), where
   (a place on file and, if you allow it, the device's position), the job and
   shipment if there is one, the seal numbers and a condition note.
2. **Scan** what is being handed over. A handheld reader, the camera and the
   live reader feed all work, as on the job screens. Scan a container once:
   what is packed inside comes with it, listed under it. Unknown codes and
   product codes several items share are reported, not guessed.
3. **Confirm the count.** Count what is physically there and type the number.
   It must match the lines you can see (containers, not their contents) or the
   list is refused with the difference. Once it matches, the list is fixed.
4. **Both sign**, on this device one after the other, or send either party a
   one-time link to sign on their own phone. Each signer sees the exact
   statement they agree to.
5. When the last required signature lands the transfer is complete: the PDF
   receipt is written and stored, the handoff is published to the audit log,
   and the purpose's effect is applied (see [Purposes](#purposes)). The page
   then shows the receipt and its verification.

### Delivery sign-off for a shipment

**Custody** lists shipments on the road or at the door with no signed delivery
yet (by the shipment's status, or by its lines being loaded). **Review and
sign** opens the sign-off:

1. Say who is receiving. A delivery transfer is created holding every line on
   the shipment, each preset from its stage (a line already flagged damaged
   starts damaged), with the seals the shipment left with. Opening it again,
   from anywhere, resumes the same one.
2. The receiving party goes down the list, with each item's photos and flags,
   and marks anything **missing**, **damaged** or **refused**, with a note.
3. They sign here, or you **Send a link** and they review and sign on their
   own phone (their marks are theirs; yours are saved first so they start from
   them). The driver may sign as well; only the receiver's signature is
   required.
4. On completion each line's job stage follows the finding: received lines are
   marked **delivered**, the others **missing**, **damaged** or **refused**
   (an exception stage this feature registers), and the shipment is marked
   delivered. The job's stage history records them with `via: custody` and a
   note naming the transfer. Damaged and missing lines are where a claim starts.

### The item's chain

The item page shows whether it is controlled, its **current custodian** (the
receiver of the latest handoff; a refused line leaves it with whoever brought
it, a missing one with the last known holder), and every signed hop with both
parties, the place, the seals, what was found, the container it travelled in,
and both signatures. Transfers still being scanned or signed are listed
apart, as in progress.

### Receipts

**Receipt (PDF)** on a completed transfer is the stored receipt, byte for
byte: the one the audit log fingerprints. It carries the parties, the facts,
every line with what the receiver found, both signatures (image, name, role,
time, how it was captured, the statement and the hash of what they signed),
the item-list fingerprint, and a QR code of the transfer's page. Before
completion the same button draws a preview headed "PREVIEW, NOT A RECEIPT".

**Check a receipt PDF** on the Custody page takes a PDF someone hands you and
says which transfer it is the receipt for and whether it still verifies. A PDF
that has been edited in any way is not recognised.

## The custody policy

A controlled item (or a line whose item is packed inside a controlled
container) **cannot reach `delivered` or `placed` on a job** until a completed
transfer with purpose **Delivery** covers it:

- the same item, and the same unit or the whole item;
- a finding that passed custody: received or damaged (not missing or refused);
- recorded against this job, or against no job after the line was added to
  this one (someone forgot to pick the job; the handoff still happened).

It is enforced with the jobs core's stage guard (`registerStageGuard("custody",
…)`), so it holds for every way a line moves: scans, fixed readers, ticking
rows in the manifest, portals. A refused line comes back in the scan result's
`blocked` bucket with a message that names the item and, when it applies, the
container it travels in. Overriding (`force`) does not lift it: force exists to
move lines backward, and custody is not a sequencing rule. A pickup or handoff
does not count; only the delivery does.

**Not enforced yet:** moving an item to another location from its page, a bulk
edit, and the plain check-out button. Custody's own flows cover them (a
Check-out or Into storage transfer checks out or moves the items when it
completes), but blocking the generic paths needs a hook in the shared item and
assignment services; see [Follow-ups](#follow-ups).

## Purposes

| Purpose | Signatures | When it completes |
| --- | --- | --- |
| Pickup | both | The owner or site releases items to a carrier or crew. Nothing else changes. |
| Handoff | both | Custody passes between crews, drivers or custodians. |
| Delivery | receiver (driver optional) | With a job: each line's stage follows the finding (see above). From a shipment sign-off: the shipment is marked delivered. Satisfies the policy. |
| Check-out | both | When the receiver is a holder, every item (or unit) handed over is checked out to them. |
| Return | both | Items (or units) that are checked out are checked back in. |
| Into storage | both | With a place set, the items handed over are moved there. |

Effects run once, after the receipt and the audit-log entry, and their results
(and anything that failed, such as a job that was already completed) are kept
on the transfer and shown on its page. Only whole items and units handed over
are affected, not what is packed inside them, and only lines that passed
custody.

## What is signed, and how it is verified

Each signature is a T02 signature (`sign()`) owned by the transfer, over this
content, rebuilt the same way from the stored rows every time:

```json
{
  "kind": "bindex.custody_transfer", "version": 1,
  "code": "CUS-7F3K2A", "purpose": "delivery",
  "from": { "kind": "external", "name": "Acme Haulage", "org": null },
  "to": { "kind": "external", "name": "Jo Park", "org": "New HQ" },
  "place": { "name": "HQ / Level 5", "lat": null, "lng": null },
  "job": "JOB-6N9DBX", "shipment": "SHP-K2M4QA",
  "seals": ["SEAL-1"], "conditionNote": null,
  "count": 3,
  "items": [
    { "itemId": "…", "unitId": null, "assetCode": "INV-2FNWQC", "unitCode": null, "name": "Archive box",
      "via": "line", "inside": null, "outcome": "accepted", "note": null }
  ],
  "itemsHash": "<sha256 of the items array>"
}
```

- Order matters: lines are signed in the order they were scanned.
- Only snapshots are signed. The job, shipment, place and holder links are
  kept on the transfer but left out of the content, because the database clears
  them when those records are deleted, and that must not look like tampering.
  Item and unit ids are plain columns for the same reason: deleting an item
  later does not change what was handed over.
- `itemsHash` is also stored on the transfer when the list is locked.

**Verification** (the transfer page, `GET /api/custody/transfers/:id/verify`)
runs four independent checks and reports each:

1. The item list still hashes to the fingerprint stored when it was locked.
2. Each signature verifies against the content rebuilt now
   (`verifySignature`), and its image is intact.
3. The audit-log entry is there, still has the hash recorded when it was
   written, and names the same code, transfer and fingerprint.
4. The stored PDF still hashes to what the attachment and the audit-log entry
   recorded.

When a signature no longer matches, the signed snapshot (`getSignedContent`) is
compared with the rows as they are now, and the page lists what changed: lines
added, removed or edited (with the fields and the old and new finding), their
order, or header fields such as the seals.

The service refuses to change a list once its count is confirmed; the
verification is what catches a change made around the service, such as in the
database directly. As the audit log's own document explains, someone with full
control of the database can rewrite rows and recompute hashes; the audit-log
chain, its checkpoints, and any copy of the receipt or the event's hash held
elsewhere (a webhook receiver, the customer's PDF) are what catch that.

## One-time signing links

**Send a link** issues a link for one party: `https://<APP_BASE_URL>/custody-sign/<token>`.

- The token is 24 random bytes; only its sha256 is stored. It is shown once,
  works once, and expires after 72 hours (1 hour to 30 days through the API).
  Issuing a new link for the transfer replaces the old one; **Cancel it**
  revokes it.
- A handoff's link can only be sent once the count is confirmed, so the party
  sees a fixed list. A delivery's receiver link can be sent while the list is
  open: the receiver marks what they find and signs in one step, which fixes
  the list.
- The page is served by the server, not the app, because the app shows its
  sign-in screen to anyone without an account. It is a fixed shell plus a
  script from this origin (the site's CSP allows no inline script), renders
  everything with `textContent`, sends `no-referrer`, `noindex` and
  `no-store`, and shows only that transfer: its parties, facts, lines and
  photos of the items on it.
- Reads are limited to 120 a minute per IP, photos to 1,200, signing to 20
  per 15 minutes.
- The signature records the signer's IP address and browser, and the receipt
  says it was signed "on their own device (one-time link)". A signature made
  on the crew's device is recorded as captured by the signed-in person, and is
  attributed to an account only when the party is that account.

## Events

Registered under the **Custody** group for webhooks and the polling feed.

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `custody.transferred` | `custody_transfer` | A transfer completed and its receipt was written | `{ code, purpose, at, from, to, place, jobId, jobCode, shipmentId, shipmentCode, seals, count, counted, exceptions: { missing, damaged, refused }, itemsHash, signatures: [{ party, id, signerName, signedAt, contentHash, via }], receipt: { attachmentId, sha256 }, truncated, lines: [{ itemId, unitId, assetCode, outcome }] }` (lines capped at 500) |
| `custody.control_changed` | `item` | An item was marked or unmarked as controlled, or its reason changed | `{ assetCode, name, controlled, reason, previouslyControlled }` |
| `custody.link_issued` | `custody_transfer` | A signing link was issued | `{ code, party, expiresAt, signerName }` (never the token) |
| `custody.voided` | `custody_transfer` | An unfinished transfer was abandoned | `{ code, purpose, reason, wasSigned }` |

The audit-log entry id and hash of `custody.transferred` are stored on the
transfer and shown on the receipt page; the entry is the evidence the receipt
points to. Job stage changes made by a sign-off are published by the jobs
integration as `job.stage_changed` with `via: "custody"`.

## HTTP API

All under `/api/custody`, behind the usual session or API key (read keys get
the `GET`s). Releasing a control needs an administrator's browser session.

| Method and path | |
| --- | --- |
| `GET /meta` | Purposes (with required signatures), outcomes, party kinds |
| `GET /controls/:itemId` | `{ own, effective }`: the item's own control, and the effective one with the container it comes from |
| `PUT /controls/:itemId` | `{ controlled, reason? }` |
| `GET /items/:itemId/chain` | `{ item, controlled, control, controlledBy, custodian, hops, pending }` |
| `GET /transfers` | `?status=&purpose=&jobId=&shipmentId=&q=&limit=`; `q` matches code, party names and organisations, or a seal number exactly. Each with `lineCount` and `exceptionCount` |
| `POST /transfers` | `{ purpose, from, to, locationId?, lat?, lng?, accuracyM?, jobId?, shipmentId?, sealNumbers?, conditionNote?, notes? }`; a party is `{ kind: "entity" \| "user" \| "external", entityId?, userOid?, name?, org? }` |
| `GET /transfers/:id` | With `lines`, `signatures`, `required`, `missing`, `statements`, `link: { state, party, expiresAt }`, `counted` |
| `PATCH /transfers/:id` | Same fields, while scanning |
| `POST /transfers/:id/scan` | `{ codes, via?: "scan" \| "manual" }` → `{ added: [{ …, contents }], already, unknown, ambiguous, total }` |
| `POST /transfers/:id/lines/remove` | `{ ids }`; a container takes its contents with it |
| `POST /transfers/:id/outcomes` | `{ outcomes: [{ lineId, outcome, note? }] }`, while open |
| `POST /transfers/:id/lock` | `{ expectedCount, outcomes? }`; `409 count_mismatch` with `details: { listed, counted }` |
| `POST /transfers/:id/sign` | `{ party: "from" \| "to", signerName, signerEmail?, signerRole?, image, expectedCount?, outcomes? }`; `image` is the PNG as a data URL. Returns `{ completed, finalized, transfer }` |
| `POST /transfers/:id/link` | `{ party, hours? }` → `{ url, path, expiresAt, transfer }` (201) |
| `DELETE /transfers/:id/link` | Revoke the link |
| `POST /transfers/:id/void` | `{ reason? }`; a completed transfer answers 409 |
| `POST /transfers/:id/finalize` | Finish a completed transfer whose receipt or audit entry is missing (after a crash); repeats nothing |
| `GET /transfers/:id/receipt.pdf` | The stored receipt, or a preview before completion |
| `GET /transfers/:id/verify` | The verification report above |
| `POST /verify-receipt` | Body: the PDF (`Content-Type: application/pdf`) → `{ found, sha256, report }` |
| `GET /shipments/awaiting` | Shipments waiting for a delivery sign-off |
| `GET /shipments/:id/review` | `{ shipment, lines: [{ …, photos, controlled, presetOutcome }], deliveries, open }` |
| `POST /shipments/:id/sign-off` | `{ to, from?, locationId?, lat?, lng?, sealNumbers?, conditionNote? }` → the (new or open) delivery transfer |

Signing link, no account, mounted before the session guard:

| Method and path | |
| --- | --- |
| `GET /custody-sign/:token` | The signing page |
| `GET /custody-sign/assets/sign.js` | Its script |
| `GET /api/custody-public/:token` | What the party sees; `410 link_gone` when used, expired or revoked |
| `GET /api/custody-public/:token/photos/:attachmentId` | A photo of an item on the transfer |
| `POST /api/custody-public/:token/sign` | `{ signerName, signerEmail?, image, outcomes? }` → `{ ok, code, completed }` |

```bash
# A handoff by script: create, scan, confirm, sign both sides.
T=$(curl -s -H "x-api-key: $KEY" -H 'Content-Type: application/json' "$URL/api/custody/transfers" \
  -d '{"purpose":"pickup","from":{"kind":"external","name":"Records office"},"to":{"kind":"external","name":"Crew 3"},"sealNumbers":["004512"]}' | jq -r .id)
curl -s -H "x-api-key: $KEY" -H 'Content-Type: application/json' "$URL/api/custody/transfers/$T/scan" -d '{"codes":["INV-2FNWQC"]}'
curl -s -H "x-api-key: $KEY" -H 'Content-Type: application/json' "$URL/api/custody/transfers/$T/lock" -d '{"expectedCount":1}'
```

## Data model

Migration `server/migrations/0035_custody.sql`; Drizzle definitions in
`server/src/db/tables/custody.ts`.

| Table | Holds |
| --- | --- |
| `custody_controls` | One row per controlled item: reason, who, when. Deleted with the item. |
| `custody_transfers` | Code `CUS-…`, purpose, status (`draft`, `locked`, `completed`, `void`), both parties (kind, holder or account link, name and organisation snapshots), `at`, place (link, path snapshot, lat/lng/accuracy), job and shipment (links and code snapshots), seals, condition note, `content_hash`, the two signature ids and how each was captured, the signing link's hash, party, expiry and use, the receipt attachment, the audit-log entry id and hash, void details, `metadata.effects` |
| `custody_transfer_items` | The list in scan order: item and unit ids (plain columns), code and name snapshots, how it got there (`scan`, `contained`, `line`, `manual`), the container it travels in, the manifest line it came from, the finding and its note |

Signatures and receipts are rows of the attachments core's `signatures` and
`attachments` tables with owner type `custody_transfer` (registered with the
orphan sweep). The JSON backup includes the three tables above (signing-link
hashes left out) and restores them after items, holders, places and jobs;
signatures and receipts are covered by a database dump, as the attachments
document explains. Restored onto the same database, receipts verify as before.

## Decisions

- **Controls are a table, not item metadata.** The plan suggested a metadata
  flag. Item edits replace `items.metadata` wholesale (the item form rewrites
  it), so a flag there could be dropped by an unrelated edit, and a compliance
  control needs who set it, when and why, and a record when it is lifted.
- **A sign-off is a delivery transfer.** The shipment review creates a
  transfer with purpose Delivery whose lines are the manifest lines, so a
  delivery lands in each item's chain like any handoff, carries the same
  receipt and verification, and is what satisfies the policy.
- **The jobs core is untouched.** The policy is a stage guard, the refused
  stage is registered, and stage changes go through `setLineStage`.
- **The signing page is served by the server,** not the React app, because
  the app has no route that renders without a signed-in session.
- **Receipt times are UTC,** to the second: a receipt travels between time
  zones.

## Code map and tests

```
server/migrations/0035_custody.sql
server/src/db/tables/custody.ts
server/src/services/custody/
  index.ts        public surface; registers the owner type, the refused stage, the guard and event types
  model.ts        purposes, outcomes, statements, parties (pure)
  rules.ts        the guard's decision, current custodian, link tokens (pure)
  content.ts      what is signed, and diffs (pure)
  pdf.ts          the receipt (pure)
  publicPage.ts   the signing page shell and script
  transfers.ts    create, scan, lock, sign, links, void, list
  policy.ts       controls and the jobs stage guard
  finalize.ts     receipt, audit-log entry, effects
  chain.ts        an item's chain and custodian
  review.ts       shipment review, sign-off, awaiting
  verify.ts       verification
  public.ts       what a signing link shows
  backup.ts       tables in the instance backup
server/src/routes/custody.ts
client/src/features/custody/
server/tests/custody.test.ts        pure logic, the receipt, the page shell
server/tests/custody-db.test.ts     the whole flow on Postgres (opt-in)
```

```bash
pnpm test                                   # pure logic, no database needed
CUSTODY_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_custody \
  pnpm --filter bindex-server test          # also runs the Postgres flow
```

The Postgres test switches the custody and jobs features on in the database it
is given. It has its own variable because the event backbone's test drops and
recreates whatever database `TEST_DATABASE_URL` names, and test files run in
parallel.

## Follow-ups

- Block moving and checking out a controlled item outside custody's own flows
  (the item page's move and check-out, bulk edits, the tracking core's zone
  moves) with a small hook in `services/items.ts` and `services/assignments.ts`,
  the way the stage guard works for jobs.
- A **Delivery sign-off** button on the shipment page (T03's screen) linking to
  `/custody/shipments/:id/sign-off`, and the item's current custodian on the
  job manifest.
- Claims (T16): start a claim from a delivery line marked damaged or missing;
  the transfer, its photos and its audit entry are the evidence.
- Portal (T15): offer the receiver's signing link inside the stakeholder
  portal instead of a bare URL, and let a third-party crew be a party.
- Send the signing link by email or SMS when a notification channel exists.
- Vault tracking (T09/T10): record an Into storage transfer automatically when
  a vault's tracker enters its store's geofence, and show the vault's position
  on its chain.
- Offline field mode (T08): queue scans and signatures on the device and
  submit them when back online.
