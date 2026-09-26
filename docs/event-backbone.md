# Audit log, events and webhooks

Everything that happens in Bindex is published as an **event**. Each event is
written once to a **tamper-evident audit log**, and from there it goes out to
other systems in two ways: **webhooks** pushed to URLs you register, and a
**polling feed** for systems that would rather ask.

- The audit log is append-only and hash-chained inside Postgres. Changing or
  removing an entry, even directly in the database, is detectable, and the
  log can be exported with its hashes and checked by someone who has only the
  file.
- Webhooks are signed, retried with backoff for about 15 hours, and switched
  off with an alert if a receiver keeps failing.
- Both are managed by administrators under **Settings → Audit log** and
  **Settings → Webhooks**. There is no feature switch: with no webhooks
  configured, nothing leaves the server.

Contents: [Publishing events](#publishing-events-for-feature-developers) ·
[Event catalog](#event-catalog) ·
[Events from other features](#events-from-other-features) ·
[The event envelope](#the-event-envelope) ·
[Webhooks](#webhooks) · [Verifying signatures](#verifying-a-signature) ·
[Polling feed](#polling-feed) · [The audit log](#the-audit-log) ·
[Archiving](#archiving-old-entries) · [API](#api-reference) ·
[Configuration](#configuration)

## Publishing events (for feature developers)

```ts
import { publish, actorFromOid } from "../event-backbone";

await publish(
  "job.stage_changed",                         // type
  { jobId: job.id, from: "packed", to: "loaded" }, // data
  {
    actor: actorFromOid(userOid),              // who did it (defaults to system)
    subject: { type: "job", id: job.id },      // what it is about (optional)
  },
);
```

The signature, from `server/src/services/event-backbone/bus.ts`:

```ts
publish(
  type: string,
  data?: Record<string, unknown>,
  options?: { actor?: EventActor | null; subject?: EventSubject | null },
): Promise<AuditEntry | null>

type EventActor   = { kind: "user" | "api_key" | "device" | "system"; id: string | null; name?: string | null };
type EventSubject = { type: string; id: string };
```

The contract:

- **It never throws and never rejects.** If the event cannot be written (a
  malformed type, the database is down) it logs `events.publish.rejected` or
  `events.publish.failed` and resolves to `null`. A failure to audit never
  fails the action being audited, so there is no need for try/catch.
- **It resolves to the stored entry**, including its audit-log `id` and
  `hash`, once the row is committed. Keep the id if your feature wants to point
  at the evidence later (a custody receipt, a claim's evidence pack).
- **Call it after your transaction commits.** It writes on its own connection.
  An event published from inside a transaction that then rolls back records
  something that did not happen.
- **Types** are lowercase, dotted, at least two segments, `[a-z0-9_]` in each:
  `item.created`, `job.stage_changed`, `device.offline`. Name them
  `<subject>.<past-tense verb>`. `audit.checkpoint` is reserved.
- **Data** should let a consumer act without a follow-up request: ids, the
  before and after of what changed, human-readable names where cheap. It is
  made JSON-safe on the way in (Dates become ISO strings, bigints strings, NaN
  null, undefined keys dropped, NUL characters removed) and is capped at
  512 KB, past which it is replaced by `{ truncated: true, bytes, keys }`.
  Never put secrets or tokens in it: the feed is readable by every signed-in
  user and every API key.
- **Actors.** `actorFromOid(userOid)` maps the ids stored across the codebase:
  `api-key:<id>` becomes an `api_key` actor, null the `system` actor, anything
  else a `user`. `actorFromUser(currentUser(req))` does the same for a request.
  Hardware passes `{ kind: "device", id: device.id, name: device.name }`. For
  users and API keys the name may be left out; it is looked up when the event
  is written, so the log keeps the name as it was at the time.
- **Subject** is the one record the event is about, `{ type, id }` with the id
  as text. Leave it out for events about many records and list their ids in
  data.
- **Describe new types** so administrators can pick them for webhooks:

  ```ts
  import { registerEventTypes } from "../event-backbone";

  registerEventTypes([
    { type: "job.stage_changed", group: "Jobs", subject: "job", description: "A job moved to another stage." },
  ]);
  ```

  Registration is descriptive only. An unregistered type is still logged and
  delivered to endpoints whose patterns match it.

- **Document your types** in your feature's own document, and add a row for
  their prefix to [Events from other features](#events-from-other-features).

Item history needs nothing extra: every row written to an item's history is
published as `item.<action>`. `recordEvent()` in `services/items.ts` does it
for single changes. Code that writes history in bulk (the tracking core,
register reconciliation, offline field notes) publishes each row itself after
its transaction commits, so a new bulk writer must do the same. Reader-driven
moves (fixed readers, Bluetooth presence, GPS geofences) arrive as `item.moved`
with a `device` actor naming the reader, gateway or tracker. Two things are
published differently: the jobs core's per-line history rows go out together as
one `job.stage_changed` per batch, and restoring a backup does not republish
the history it brings back.

## Event catalog

Every type the core application and the event backbone emit. Features add
their own, listed in [Events from other features](#events-from-other-features).
`subject` is the subject type; ids are UUIDs unless stated.

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `item.created` | `item` | An item was added | `{ name }` from the app; `{ source: "ninjaone", deviceId }` or `{ source: "registrar", registrar }` from a sync |
| `item.updated` | `item` | An item changed | One of: `{ fields: string[] }` (edited fields, names only); `{ action: "checked_out" \| "checked_in", entity }`; `{ action: "unit_checked_out", unit, entity }`; `{ action: "unit_checked_in", entity }`; `{ spotCheck: "seen" \| "missing", by }`; `{ source: "registrar", flaggedMissing: true, reason }` |
| `item.updated` | none | Bulk edit, or an audit applied | `{ bulk: true, ids: string[], set: { locationId?, utilizedByEntityId?, companyId?, status? } }`; `{ audit: true, seen: number, flaggedMissing: number }` |
| `item.scanned` | `item` | A scanned code resolved to the item | `{ value }` (the code) |
| `item.moved` | `item` | The item changed zone. Fixed readers, Bluetooth presence and GPS geofences publish it with a `device` actor | `{ source: "tracking", tech, deviceId, deviceName, from, to, applied, unitId?, direction? }` from the [tracking core](tracking-core.md#building-on-the-tracking-core); other emitters document their own `source` |
| `item.deleted` | `item` | An item was deleted | `{ itemId }` |
| `item.deleted` | none | Bulk delete | `{ bulk: true, ids: string[] }` |
| `audit.checkpoint` | `audit_log` (id: the head id) | Daily, and on demand | `{ headId, headHash, count, keyId, signature }`, see [Checkpoints](#checkpoints) |
| `audit.verified` | `audit_log` | An administrator ran a verification | `{ ok, checked, firstBrokenId, headId }` |
| `audit.exported` | `audit_log` (id: `export`) | An administrator downloaded an export | `{ format: "ndjson" \| "csv", rows, complete, filter }` |
| `webhook.endpoint_created` | `webhook_endpoint` | An endpoint was added | `{ host, description, eventPatterns, active }` |
| `webhook.endpoint_updated` | `webhook_endpoint` | Changed, switched on or off, or its secret rotated | `{ host, description, eventPatterns, active, changed: string[] }` |
| `webhook.endpoint_deleted` | `webhook_endpoint` | An endpoint was removed | `{ host, description, eventPatterns, active }` |
| `webhook.endpoint_disabled` | `webhook_endpoint` | Switched off after 50 failures in a row | `{ host, description, eventPatterns, failureCount, reason }` |
| `webhook.ping` | `webhook_endpoint` | A test sent from Settings. Never logged; `id` is 0 and `hash` null | `{ message }` |

Webhook events record the endpoint's host, not its full URL: for many
receivers the path is itself a credential.

## Events from other features

Every feature that publishes events documents them in its own page. The prefix
is what to put in a webhook's patterns or the feed's `types` (`custody.*`,
`claim.*`). Every type below is registered in the code, so it appears in the
webhook picker under its group.

| Prefix | Feature | Types | Documented in |
| --- | --- | --- | --- |
| `item.*` | Items, every feature that changes one through `recordEvent`, and reader-driven moves from the tracking core | `created`, `updated`, `scanned`, `moved`, `deleted` | [Event catalog](#event-catalog) |
| `job.*` | Projects, jobs and shipments | `created`, `updated`, `stage_changed`, `task_status_changed` | [Jobs and shipments](#jobs-and-shipments) |
| `shipment.*` | Jobs (status) and GPS (milestones) | `status_changed`; `departed`, `waypoint_reached`, `arrived` | [Jobs and shipments](#jobs-and-shipments), [GPS](gps.md#events) |
| `ble.*` | Bluetooth beacons | `tag_zone_changed`, `tag_moved_after_hours`, `tag_missing`, `tag_found`, `battery_low` | [Bluetooth](ble.md#alerts-and-events) |
| `geofence.*` | GPS | `entered`, `exited`, `created`, `updated`, `deleted` | [GPS](gps.md#events) |
| `tracker.*` | GPS | `assigned`, `unassigned`, `status_changed`, `battery_low` | [GPS](gps.md#events) |
| `condition_report.*` | Condition records | `created`, `updated`, `deleted` | [Condition records](ai-condition.md#events) |
| `container.*` | Container capture | `captured` | [Condition records](ai-condition.md#events) |
| `condition_sweep.*` | Condition sweeps | `started`, `closed` | [Condition records](ai-condition.md#events) |
| `inspection.*` | Site inspections | `created`, `finding_added`, `finding_updated`, `finding_removed`, `completed`, `reopened`, `signoff_added`, `signed`, `deleted`, `share_created`, `share_revoked` | [Inspections](inspections.md#events) |
| `custody.*` | Chain of custody | `transferred`, `control_changed`, `link_issued`, `voided` | [Custody](custody.md#events) |
| `portal.*` | External portal | `grant_created`, `grant_updated`, `grant_revoked`, `grant_reissued`, `accessed`, `access_denied`, `code_sent`, `code_verified`, `code_failed`, `scanned`, `note_added`, `photo_added`, `handoff_signed`, `notify_changed`, `notification_sent` | [Portal](portal.md#events) |
| `claim.*` | Claims and incidents | `created`, `updated`, `status_changed`, `assigned`, `commented`, `lines_changed`, `exported`, `sla_breached` | [Claims](claims.md#events) |
| `document.*` | Documents | `created`, `completed`, `reopened`, `signed`, `exported`, `deleted` | [Documents](documents.md#events) |
| `document_packet.*` | Documents | `attached`, `withdrawn` | [Documents](documents.md#events) |
| `document_template.*` | Documents | `published` | [Documents](documents.md#events) |
| `crew.*` | Crew check-in | `checked_in`, `check_in_refused`, `check_in_overridden`, `checked_out`, `checkin_updated`, `checkin_deleted`, `worker_created`, `worker_updated`, `worker_deleted`, `credential_changed`, `credentials_expiring`, `policy_changed` | [Crew](crew.md#events) |
| `valuation.*` | Valuation | `recorded`, `high_value_marked` | [Valuation](valuation.md#events) |
| `declaration.*` | High-value declarations | `created`, `signed`, `deleted` | [Valuation](valuation.md#events) |
| `receipt.*` | Receipts | `confirmed` | [Valuation](valuation.md#events) |
| `warranty.*` | Warranty reminders | `expiring` | [Valuation](valuation.md#events) |
| `service.*` | Service reminders | `due`, `logged` | [Valuation](valuation.md#events) |
| `teardown.*` | Teardown guides | `guide_created`, `guide_processed`, `reassembly_completed`, `guide_deleted` | [Teardown](teardown.md#events) |
| `capture_session.*` | AI bulk capture | `committed` | [Bulk capture](bulk-capture.md#events) |
| `ops.*` | Operations insights | `anomaly_detected`, `anomaly_resolved`, `run_completed` | [Operations insights](ops-intel.md#events) |

Attachments, register reconciliation, consumables, tag commissioning, offline
field mode and placement publish no types of their own. Placement's and
custody's stage changes arrive as `job.stage_changed`; tag binding, data
plates and offline field notes as `item.updated`; and register reconciliation's
actions and imports as `item.<action>` with `source: "register"`.

### Jobs and shipments

The jobs core has no event list of its own: its hooks are published by
`services/integration/jobEvents.ts`. The actor is the person or API key that
made the change; with no person behind it, the device that reported it; or
else the system, under the name its source gave (a portal link, for example).

| Type | Subject | When | `data` |
| --- | --- | --- | --- |
| `job.created` | `job` | A job was created | `{ code, name, status, previousStatus: null }` |
| `job.updated` | `job` | A job's details or status changed | `{ code, name, status, previousStatus }` |
| `job.stage_changed` | `job` | Manifest lines moved to a stage, by any route: scans, readers, placement, custody, portal crews | `{ via, deviceId, note, count, byStage, truncated, lines: [{ jobItemId, itemId, unitId, shipmentId, from, to }] }`, lines capped at 500 |
| `job.task_status_changed` | `job` | A task changed status, by hand or following the manifest | `{ jobId, taskId, kind, title, from, to }` |
| `shipment.status_changed` | `shipment` | A shipment moved between planned, staged, loaded, in transit, delivered and closed | `{ code, jobId, name, from, to, forced, reason }` |

## The event envelope

Every webhook body and every entry of the polling feed has the same shape:

```json
{
  "id": 1042,
  "type": "item.updated",
  "occurredAt": "2026-09-26T14:03:11.512Z",
  "subject": { "type": "item", "id": "7d0c…" },
  "actor": { "kind": "user", "id": "local:5b1e…", "name": "Dana Ruiz" },
  "data": { "action": "checked_out", "entity": "Crew 3" },
  "hash": "9f2c…"
}
```

- `id` is the audit-log id: unique, and increasing in the order events were
  recorded. Use it to deduplicate, since delivery is at least once.
- `occurredAt` is when the event was recorded, in UTC, to the millisecond.
- `subject` is null for events about several records.
- `actor.kind` is `user`, `api_key`, `device` or `system`.
- `hash` is the event's audit-log hash. Store it and you hold an independent
  witness to the chain: if the log were ever rewritten, your copy would
  disagree.

New fields may be added. Ignore the ones you do not know.

## Webhooks

### Setting one up

Settings → Webhooks → **Add endpoint**. Give it the URL, a description, and
the events to send: pick types from the catalog, whole groups such as
`item.*`, or type a pattern. `*` matches any run of characters, dots included,
so `item.*` covers `item.created` and any future `item.unit.moved`, and `*` on
its own is everything.

The signing secret (`whsec_…`) is shown **once**, when the endpoint is
created. Store it in the receiver. **Rotate secret** issues a new one and
shows it once; the old one stops working immediately.

**Send test** posts a `webhook.ping` and shows the receiver's response. The
delivery log under each endpoint lists every attempt with its status code,
time taken and error, and **Resend** sends any logged event again.

### The request

```
POST <your URL>
Content-Type: application/json
User-Agent: Bindex-Webhooks/1
X-Bindex-Event: item.updated
X-Bindex-Delivery: 5531
X-Bindex-Signature: t=1790431391,v1=4b1f0c…

<envelope>
```

- Answer with any **2xx** within **10 seconds**. Do the real work afterwards;
  anything slower counts as a failure and is retried.
- **Redirects are not followed.** A 3xx is a failure; register the final URL.
- `X-Bindex-Delivery` identifies this attempt. A redelivery gets a new one, so
  deduplicate on the envelope's `id`, not on this header.
- Order is not guaranteed across retries. Sort by `id` if order matters.

### Retries

A failed attempt (non-2xx, timeout, connection error) is retried after
**1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours**: six attempts over
about 15 hours. After the sixth failure the delivery is marked **dead**; it
stays in the delivery log, where it can be resent by hand.

After **50 failed attempts in a row** across all its deliveries, an endpoint
is **switched off**, a `webhook.endpoint_disabled` event is logged, and an
alert goes out through the configured notifications (Pushover, Wazuh).
Deliveries queued for it wait. Fix the receiver and switch the endpoint back
on: its failure count resets and the waiting deliveries go out.

Delivery records are kept for 30 days after they finish, then pruned. The
events themselves stay in the audit log.

Every app replica runs the delivery worker. Each claims due deliveries with
`SELECT … FOR UPDATE SKIP LOCKED` and holds a one-minute lease while sending,
so two replicas never send the same delivery, and a replica that dies
mid-send only delays it until the lease runs out.

### Private networks

By default a webhook cannot be delivered to a private, loopback, link-local or
otherwise internal address, checked both when the URL is saved and against the
address actually connected to (so a public name that resolves to `10.0.0.5` is
refused too). This stops an endpoint being used to probe the network the
server runs on. To deliver to a warehouse or ERP system on your own network,
set `WEBHOOK_ALLOW_PRIVATE=true`.

### Verifying a signature

`X-Bindex-Signature` is `t=<unix seconds>,v1=<hex>`, where the hex is the
HMAC-SHA256 of `<t>.<raw body>` keyed with the endpoint secret (the whole
`whsec_…` string, as UTF-8). Verify against the **raw bytes** of the body,
before any JSON parsing, and reject timestamps more than five minutes from
your clock so a captured request cannot be replayed.

Node.js, no dependencies:

<!-- snippet: verify-node -->
```js
const crypto = require("node:crypto");

// rawBody: the request body exactly as received (string or Buffer).
function verifyBindexSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header) return false;
  let timestamp = null;
  const signatures = [];
  for (const piece of header.split(",")) {
    const [key, value] = piece.split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  const t = Number(timestamp);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}
```

With Express, take the raw body for that route:

```js
app.post("/bindex", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyBindexSignature(req.body, req.get("X-Bindex-Signature"), process.env.BINDEX_WEBHOOK_SECRET);
  if (!ok) return res.sendStatus(401);
  const event = JSON.parse(req.body);
  queue.push(event); // do the work later
  res.sendStatus(204);
});
```

Python, standard library only:

<!-- snippet: verify-python -->
```python
import hashlib
import hmac
import time


def verify_bindex_signature(raw_body: bytes, header: str, secret: str, tolerance_sec: int = 300) -> bool:
    if not header:
        return False
    timestamp, signatures = None, []
    for piece in header.split(","):
        key, _, value = piece.partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if timestamp is None or not timestamp.isdigit():
        return False
    if abs(time.time() - int(timestamp)) > tolerance_sec:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)
```

Both snippets are run against real signed deliveries by the test suite
(`server/tests/event-backbone*.test.ts`), so they stay correct.

## Polling feed

For systems that cannot receive webhooks, or want to catch up after being
offline:

```
GET /api/events?after=<id>&types=item.*,job.*&limit=100
```

```bash
curl -H "x-api-key: bdx_..." "https://inventory.example.com/api/events?after=0&types=item.*"
```

```json
{ "events": [ <envelope>, … ], "nextAfter": 1042, "hasMore": false }
```

- Returns events with an id greater than `after`, oldest first. Store
  `nextAfter` and send it back next time. Start from `0` for the whole
  history.
- `types` is a comma-separated list of patterns, as for webhooks. Leave it out
  for everything.
- `limit` is 1 to 500, default 100. When `hasMore` is true, ask again straight
  away.
- Works with a **read-only API key**, a session, or trusted mode. It is the
  same data the audit log holds, minus the chain fields.

## The audit log

### How the chain works

Each row of `audit_log` stores `prev_hash`, the hash of the row before it,
and `hash = sha256(prev_hash || canonical text of the row)`. The first row's
`prev_hash` is 64 zeros. Changing any stored field of any row changes its
hash, which no longer matches the next row's `prev_hash`; removing a row
leaves a `prev_hash` that matches nothing.

The hash is computed **by Postgres**, in a `BEFORE INSERT` trigger that takes a
transaction-level advisory lock, reads the head, assigns the id and timestamp
and computes the hash. Concurrent writers, including several app replicas,
queue on the lock and cannot fork the chain. Ids and timestamps are assigned
under the same lock, so the chain follows id order and time never runs
backwards along it. The trigger refuses to write under `REPEATABLE READ` or
`SERIALIZABLE`, where it would read a stale head.

`UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` raise an exception from
another trigger. There is no retention setting: nothing in the application
deletes audit rows.

The canonical text is the jsonb rendering of this array, exactly as
`jsonb_build_array(...)::text` prints it:

```
[id, occurred_at, actor_kind, actor_id, actor_name, type, subject_type, subject_id, data]
```

`occurred_at` is written as `YYYY-MM-DDTHH:MM:SS.mmmZ` in UTC. jsonb's
rendering is fully specified: `", "` and `": "` as separators, object keys
ordered by byte length and then bytewise, numbers without exponents.
`server/src/services/event-backbone/canonical.ts` is an exact JavaScript twin,
and the tests check the two agree on awkward data (Unicode, escapes, very large
and very small numbers, nested objects).

### Verifying

- **In the app:** Settings → Audit log → **Verify chain**, or
  `GET /api/audit-log/verify`. Recomputes every hash in SQL, in batches of
  5,000, and checks every link. It answers
  `{ ok, checked, firstBrokenId, reason, head, anchor, checkpoints }`;
  `firstBrokenId` is the first entry whose content does not match its hash or
  that does not link to the entry before it. Each run is itself logged as
  `audit.verified`.
- **Offline, from an export:** download the NDJSON export and run

  ```bash
  pnpm --filter bindex-server exec tsx src/services/event-backbone/verifyExport.ts audit-log.ndjson
  ```

  It needs no database and no configuration. Every row is checked against its
  own hash, so a filtered export still proves each row it contains; a full
  export also proves every link. Gaps (rows absent from the file) are
  reported: expected in a filtered export, a warning in a full one.

### Checkpoints

Once a day (checked hourly; skipped when nothing has happened since the last
one) the server appends an `audit.checkpoint` entry recording the head id,
head hash and row count, signed with HMAC-SHA256. The same facts go out
through the configured notifications (Pushover, Wazuh), so a copy of the head
exists somewhere the database cannot reach. An administrator can also write
one from Settings (**Checkpoint now**) or with `POST /api/audit-log/checkpoint`.

The signing key is `AUDIT_SIGNING_KEY`, or when that is blank a key derived
from `SESSION_SECRET`. Verification checks every checkpoint's signature;
checkpoints signed with a different key (the key was changed) are listed as
`unknownKey` rather than failing. Set `AUDIT_SIGNING_KEY` explicitly if you
might rotate the session secret.

### What it does and does not prove

The chain proves the log has not been edited **since the hashes were
computed**. Someone with full control of the database can rewrite rows and
recompute every hash after them, and the chain on its own cannot tell.
Likewise, deleting the newest entries leaves a shorter chain that is still
valid; it shows up only as a head older than one recorded elsewhere. What
catches that is a copy of a hash held elsewhere: the checkpoint notifications,
the `hash` in every webhook a receiver stored, an exported file, or the signed
checkpoints themselves (forging one needs the signing key, which lives in the
server's environment, not the database). For stronger separation, run the
application as a database role that does not own `audit_log`, so it cannot
disable the triggers.

### Exports

Settings → Audit log → **Export NDJSON** or **Export CSV**, or
`GET /api/audit-log/export?format=ndjson|csv` with the same filters as the
viewer. Both include `prev_hash` and `hash`. NDJSON carries every field
exactly as hashed and is the one to verify or hand to a third party. CSV is for
reading in a spreadsheet: cells a spreadsheet would run as a formula are
prefixed with an apostrophe, so it cannot be verified byte for byte. Exports
stream, so the size of the log does not matter, and each export is logged as
`audit.exported`.

### Archiving old entries

The application never deletes audit entries. When the table has to shrink, a
DBA archives the old part and keeps a signed checkpoint as the new start of
the chain:

1. **Checkpoint now** in Settings (or `POST /api/audit-log/checkpoint`). Note
   its id, `K`.
2. Export the full log as NDJSON, verify the file offline, and store it
   somewhere durable. It is the archive.
3. In `psql`, as the table owner:

   ```sql
   BEGIN;
   ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable;
   DELETE FROM audit_log WHERE id < K;
   ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable;
   COMMIT;
   ```

The retained log now starts with checkpoint `K`. Its `prev_hash` is the hash
of the last archived entry, and its signed data records that hash and the
number of entries before it. Verification accepts a log that starts this way,
reports it as `anchor`, and rejects one that starts anywhere else without a
valid signed checkpoint, so a quietly removed prefix is caught. To prove the
whole history later, verify the archive file, then check that its last hash
equals the anchor's `archivedHeadHash`.

Keep the signing key that signed checkpoint `K`: verification needs it to
accept the anchor.

### Backups

The audit log and webhook endpoints are **not** in the JSON backup
(Settings → Backup). A restore deletes and re-inserts rows, which the audit
log forbids by design, and endpoints hold signing secrets, which backups leave
out like API keys and accounts. Use the NDJSON export as the audit archive and
a database dump (`pg_dump`) for disaster recovery of everything.

## API reference

All audit-log and webhook routes need an administrator's **browser session**;
API keys get `403 session_required`. The feed accepts any signed-in user or
API key.

| Method and path | Purpose |
| --- | --- |
| `GET /api/audit-log` | Newest first. Filters: `type` (comma-separated prefixes such as `item.` or patterns such as `*.deleted`), `subjectType`, `subjectId`, `actor` (id, or part of the name), `from`, `to` (ISO date or timestamp; a bare `to` date includes that whole day). Paging: `limit` (≤ 200), `before=<nextBefore>`. Returns `{ entries, nextBefore }`. |
| `GET /api/audit-log/:id` | One entry. |
| `GET /api/audit-log/status` | `{ count, head, firstId, lastCheckpoint }`. |
| `GET /api/audit-log/verify` | Walk the chain. See [Verifying](#verifying). |
| `POST /api/audit-log/checkpoint` | Write a signed checkpoint now. |
| `GET /api/audit-log/export?format=ndjson\|csv` | Stream an export, same filters as the list. |
| `GET /api/webhooks` | Endpoints, with queued, retrying and dead counts and the last attempt. The secret is never included. |
| `GET /api/webhooks/catalog` | Known event types, for the picker. |
| `POST /api/webhooks` | `{ url, description?, eventPatterns: string[], active? }`. Returns the endpoint with `secret`, once. |
| `GET /api/webhooks/:id` | One endpoint. |
| `PATCH /api/webhooks/:id` | Any of the create fields. `active: true` on a switched-off endpoint resets its failure count. |
| `DELETE /api/webhooks/:id` | Remove it and its delivery log. |
| `POST /api/webhooks/:id/rotate-secret` | `{ secret }`, once. |
| `POST /api/webhooks/:id/ping` | Send `webhook.ping` now; returns the delivery with the response code. |
| `GET /api/webhooks/:id/deliveries` | Delivery log, newest first. `status`, `limit`, `before`. |
| `POST /api/webhooks/deliveries/:id/redeliver` | Send that delivery's event again, now, as a new delivery. |
| `GET /api/events` | The polling feed. |

A delivery's `status` is `pending` (not tried yet), `failed` (the last attempt
failed; retried at `nextAttemptAt`, or never if that is null, as for a failed
ping), `succeeded` or `dead`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Allow webhook URLs on private, loopback and link-local networks. |
| `AUDIT_SIGNING_KEY` | derived from `SESSION_SECRET` | Key for checkpoint signatures. Set it if the session secret might change. |

Checkpoint and failure alerts use the existing `PUSHOVER_*` and `WAZUH_*`
settings (see [alerting](alerting.md)) and are skipped quietly when neither is
configured.

The migration (`0025_event_backbone.sql`) runs `CREATE EXTENSION IF NOT EXISTS
pgcrypto`. pgcrypto ships with Postgres's contrib package, which the official
Docker image and every major managed Postgres include; since Postgres 13 the
database owner can create it without being a superuser. The database must use
UTF-8 encoding (the default) for hashes to match the offline verifier.
