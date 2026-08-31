# HTTP API

Everything the web client does goes through this API, so anything the interface
can do, a script can do too.

## Authentication

Two ways in.

**Session cookie.** What the browser uses. Sign in at `POST /auth/login` and the
cookie is set for you.

**API key.** What scripts use. Create one under Settings, API keys. It is shown
once, at creation, and stored only as a hash.

```bash
curl -H "x-api-key: bdx_..." https://inventory.example.com/api/items
```

A present `x-api-key` header is authoritative. An unknown or revoked key is a
401 even if a valid session cookie came along too.

### Key scopes

| Scope | Allowed |
| --- | --- |
| `read` | `GET` and `HEAD` only. Anything else is a 403. |
| `read_write` | Every method. |

Some endpoints are browser-only regardless of scope, because they change how the
instance behaves for everyone or expose the whole database: `/api/settings`,
`/api/backup`, and the device management connect flow. A key on those returns
403 with code `session_required`.

## Conventions

Requests and responses are JSON. Identifiers are UUIDs. Timestamps are ISO 8601
in UTC. Money is an integer count of cents in `valueCents`, never a float.

Errors carry a stable machine-readable code alongside the message:

```json
{ "error": "That serial is already assigned to another unit.", "code": "conflict" }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Validation failed. `details` carries the field errors. |
| 401 | `unauthorized` | No valid session or key. |
| 403 | `forbidden` | Authenticated but not allowed. |
| 403 | `session_required` | Endpoint is browser-only. |
| 404 | `not_found` | |
| 409 | `conflict` | A uniqueness constraint rejected it. |
| 500 | `internal` | Logged server-side with the real cause. |

## Scanning

The endpoint the whole application is built around. Give it any code and it
tells you what that code is.

```
GET /api/scan/:code
```

```json
{
  "found": true,
  "item": { "id": "...", "name": "UniFi U6 Pro", "assetCode": "INV-4F2K1B", "...": "..." }
}
```

It resolves, in order: an exact identifier match, an item's printed asset code,
a tracked unit's own code or serial, and finally an unambiguous model or SKU
match. When a unit matched rather than the item itself, `item.matchedUnitId`
says which.

A miss returns `found: false` along with `code` and, where the code could be
identified against a product database, an `enrichment` object to prefill a
create form.

## Items

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/items` | `?q=`, `?locationId=`, `?companyId=`, `?kind=physical\|digital\|all` |
| `POST` | `/api/items` | |
| `GET` | `/api/items/:id` | Full detail: identifiers, images, children, units, assignments, history |
| `PATCH` | `/api/items/:id` | |
| `DELETE` | `/api/items/:id` | |
| `POST` | `/api/items/bulk` | `{ ids, set }` |
| `POST` | `/api/items/bulk-delete` | `{ ids }` |
| `GET` | `/api/items/:id/children` | Contents of an item used as a container |
| `POST` | `/api/items/:id/identifiers` | `{ type, value }` |
| `DELETE` | `/api/identifiers/:id` | |

Identifier types are `upc`, `serial`, `asset_tag`, `mac`, `sku`, `rfid`,
`domain` and `other`. Identity-bearing types (`serial`, `asset_tag`, `mac`,
`rfid`) are unique across the whole instance. Product codes are not, because two
identical tablets bought for two sites legitimately share a UPC.

### Units

A tracked unit is one physical copy of an item, with its own printed code,
serial, status, location and holder. The item's quantity follows the number of
units.

| Method | Path |
| --- | --- |
| `POST` | `/api/items/:id/units` |
| `PATCH` | `/api/items/:id/units/:unitId` |
| `DELETE` | `/api/items/:id/units/:unitId` |
| `POST` | `/api/items/:id/units/:unitId/checkout` |
| `POST` | `/api/items/:id/units/:unitId/checkin` |

### Check-out

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/items/:id/checkout` | `{ entityId, note? }` |
| `POST` | `/api/items/:id/checkin` | |

### Photos

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/items/:id/photo` | Raw image bytes, `Content-Type` is the image type |
| `POST` | `/api/items/:id/photo-from-url` | `{ url }`, fetched and stored locally |
| `GET` | `/api/photos/:id` | Serves a stored photo |

## Locations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/locations` | |
| `POST` | `/api/locations` | `{ name, parentId?, companyId?, address?, notes? }` |
| `GET` | `/api/locations/:id` | Contents, child containers and counts |
| `PATCH` | `/api/locations/:id` | |
| `DELETE` | `/api/locations/:id` | Items become unassigned rather than deleted |
| `POST` | `/api/locations/:id/items` | Move items in: `{ itemIds }` |

## Auditing

Reconcile a set of scanned codes against what is on file. Both are stateless:
the client holds the running set and sends it each time.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/locations/:id/verify` | One container. `{ codes }` |
| `POST` | `/api/locations/:id/verify/apply` | `{ presentIds, missingIds }` |
| `POST` | `/api/audit/reconcile` | Whole instance or one group. `{ codes, companyId? }` |
| `POST` | `/api/audit/apply` | `{ seenIds, missingIds }` |

A reconcile returns present, missing, unexpected and unresolved. Applying marks
what was seen as spot-checked and flags what was not.

## Reader ingest

For hardware that streams reads. Authenticated by a bearer token from
`INGEST_TOKEN`, not by a session or an API key, because a reader has neither.

```bash
curl -X POST https://inventory.example.com/api/device/scan \
     -H "Authorization: Bearer $INGEST_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"reader":"dock-1","epcs":["E28011606000020C1A2B3C4D"]}'
```

The audit screen polls `GET /api/audit/live?reader=dock-1&since=<seq>` for
whatever arrived since its last poll. Reads are held in memory, per reader
channel, and are lost on restart by design.

## Search

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/items?q=` | Full text and fuzzy matching, always available |
| `POST` | `/api/search/ask` | `{ query }`, describes what you want in a sentence |

`/api/search/ask` needs `LLM_API_KEY` and returns 400 without it. The response
includes the filter it derived alongside the results, so the interpretation is
always visible rather than implied.

## Reference data

`companies` are the ownership grouping and `entities` are who things are checked
out to. Both are simple lists.

| Method | Path |
| --- | --- |
| `GET` `POST` | `/api/companies`, `/api/entities` |
| `PATCH` `DELETE` | `/api/companies/:id`, `/api/entities/:id` |

The names in the interface are configurable, but the API paths are not; they are
part of the contract.

## Reports

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/stats` | Dashboard totals and breakdowns |
| `GET` | `/api/reports/items.csv` | Every item as CSV, with configured column names |

## Printing

Print endpoints return files rather than JSON, and are documented by example.

```
GET /api/print/label/:id/print.pdf              one item
GET /api/print/labels.pdf?ids=a,b,c             a batch, one page each
GET /api/print/unit/:unitId/print.pdf           one tracked unit
GET /api/print/unit-labels.pdf?ids=a,b,c        a batch of units
GET /api/print/container/:id/label.pdf          an item used as a container
GET /api/print/location/:id/label.pdf           a location
GET /api/print/manifest/:id/contents.pdf        a container's packing slip
GET /api/print/manifest/location/:id/contents.pdf
GET /api/print/labels.xlsx?ids=a,b,c            the same labels as a spreadsheet
GET /api/print/sample.pdf                       a test label, no record needed
```

Every `.pdf` route has a `preview.png` counterpart for showing on screen, and a
`compact.pdf` for the QR-only layout.

Batch routes accept `?style=compact`. A contents sheet accepts `?tz=` to set
the timezone of the printed timestamp.

## Instance configuration

```
GET /api/config
```

Unauthenticated, because the sign-in screen needs the instance name and colours
before anyone has signed in. It carries the vocabulary, the feature switches and
which integrations are configured, and nothing sensitive.

Changing it is administrator-only and browser-only:

```
GET  /api/settings
PUT  /api/settings
GET  /api/settings/users
POST /api/settings/users
```
