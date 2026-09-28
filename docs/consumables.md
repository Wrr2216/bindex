# Consumables and equipment

Two kinds of things leave the building with a crew and are easy to lose track
of. **Consumables** are counted, not individually labelled: boxes, tape, pads,
stretch wrap. **Equipment** is labelled piece by piece and has to come back:
dollies, hand trucks, straps, lift gates, blankets.

Bindex tracks both under **Supplies**, with check-out and check-in by crew, truck
or branch. The feature is off until an administrator turns on **Consumables and
equipment** under Settings. Switching it off hides every Supplies screen and the
navigation link; the data stays.

## Crews, trucks and branches

A holder is an ordinary entity (the list under the holder name in the
navigation, "Assignees" by default) whose kind is `crew`, `vehicle` or
`branch`. Add them from the Supplies screen, or from that list. Any other entity
can hold supplies and equipment too; it is simply listed after them in the
pickers, and appears on the Supplies screen as soon as it has something out.

## Consumables

### Tracking an item as a supply

A supply is an item with a small side record: its unit (each, box, roll, ft),
a reorder point, a reorder quantity and a supplier. The item itself is
unchanged, so its barcode, photo and value work as they always have. The
item's value is the cost of one unit.

**Supplies, Add a supply** either creates a new item or marks an existing one.
Scanning a barcode there fills in whichever applies.

### Stock levels and movements

Stock is held per location. Every change to it is a movement, written in the
same transaction as the level it changes:

| Movement | What it does |
| --- | --- |
| Receive | Adds stock at a location. |
| Issue | Takes stock from a location and puts it on a holder's balance. |
| Return | Takes it off the holder's balance and back into a location. |
| Record use | Either straight off a shelf (the location goes down; the holder, if given, is who used it) or out of what a holder was issued (their balance goes down). |
| Transfer | Moves stock between two locations. |
| Count | Sets a location's level to what was counted and records the variance. |
| Adjust | Administrators only, and only with a reason. |

A level never goes below zero, and a holder cannot return or use more than they
have out. The one exception is an administrator's adjustment, which may take a
level negative, for stock that was used before its delivery was booked in.

Because every movement stores a positive quantity and the location it came
from or went to, the level at any location equals what came in minus what went
out. `GET /api/consumables/integrity` (administrators) compares the two for the
whole instance and lists any difference; an empty list is the normal state.

Each movement also keeps the unit cost at the time, so repricing an item later
does not change what past jobs cost.

### On a phone

Each movement is one screen: scan the supply, type a quantity, tap Done. Scanning
a location's label picks the location. The location and holder stay selected
between entries and are remembered on that device, so issuing ten different
supplies to one truck is ten scans and ten numbers.

A cycle count lists everything on file at a location. Scan anything else found
there to add it. **Hide what is on file while counting** makes it a blind count.

### Low stock

A supply is low at a location when its level there is at or below its reorder
point. A supply with a reorder point that is not stocked anywhere at all is low
too. The Supplies screen shows a card, and **Low stock** lists everything, grouped
by location, with a Receive button beside each line.

Once a day a digest of that list is sent through the notification destinations
in [alerting.md](alerting.md) (Pushover and Wazuh). The server checks every hour
and sends on the first check after `CONSUMABLES_DIGEST_HOUR` (server time,
default 7). The day is claimed in the database before anything is sent, so a
restart or a second replica cannot send it twice; a delivery that fails gives
the day back and the next hourly check retries. Nothing is sent when nothing is
low, when no destination is configured, or when the feature is off. Set
`CONSUMABLES_DIGEST_HOUR=-1` to turn the digest off.

## Equipment kits

A kit is many pieces checked out to one holder in one scan session, with a time
they are due back. Open **Check out a kit**, pick the holder, then scan each
piece with a handheld reader, the phone camera or a networked RFID reader. The
list shows what each read is before anything is checked out:

- a supply is refused, since it is issued rather than checked out;
- a piece already out to someone else is marked and will be handed over;
- a code that matches nothing is marked.

Each piece gets the same check-out record the item page uses, so it shows as out
on its own page and can be checked in from there too. The kit only groups those
records and carries the due time.

### End-of-day return

Open the holder from the Supplies screen. It shows, since the start of the day
(or any date you pick), what went out, what came back and what is still out,
with overdue pieces marked. **Start end-of-day return**, scan everything coming
back, then **Check in**. The result names exactly what is still out.

A piece that was out to a different holder is still taken back, because it is
physically here, and is flagged so someone can ask why. The same screen lists
the supplies the holder has out, with Return and Used buttons for each.

A kit closes itself once every piece is back. Kits past their due time appear as
overdue on the Supplies screen, on the holder, and at
`GET /api/consumables/kits/overdue`.

## Reports

**Reports** shows usage over a date range, by holder and by supply, with the cost.
**Download XLSX** exports the same with a third sheet listing every movement in
the range (up to 5,000).

- **Used** is what left the shelves and did not come back: issued minus returned,
  plus anything used straight off a shelf. Use recorded out of a holder's issued
  stock is already inside issued minus returned, so it is not added again.
- **Cost** is used times the unit cost captured on each movement.
- **Shrinkage** is what counts and adjustments found missing, net of anything
  they found extra.

A range counts movements made within it, so a return today of something issued
yesterday shows as negative use in a report covering only today.

## API

Everything is under `/api/consumables` and follows the conventions in
[api.md](api.md): session cookie or API key, JSON, a read-only key limited to
`GET`. Quantities are numbers with up to three decimals; money is integer cents.

| Method and path | Purpose |
| --- | --- |
| `GET /catalog?q=` | Every supply with its total on hand, levels by location, what holders have out, and whether it is low. |
| `GET /items/:itemId` | One supply, with holder balances and its last 50 movements. |
| `PUT /items/:itemId` | Track an item as a supply or change `unit`, `reorderPoint`, `reorderQty`, `supplier`. |
| `DELETE /items/:itemId` | Stop tracking it. Levels and history are kept. |
| `GET /lookup?code=` | What a scanned code is, with the supply's levels when it is one. |
| `POST /resolve` | `{ codes }` to many descriptions at once: item or unit, location, or unknown, whether it is a supply, and who has it. |
| `POST /movements` | Record a movement (below). |
| `GET /movements` | History, filtered by `itemId`, `holderId`, `locationId`, `reason`, `from`, `to`; `limit` up to 500, `offset`. |
| `POST /counts` | `{ locationId, lines: [{ itemId, countedQty }], note? }`: a whole cycle count in one transaction. |
| `GET /locations/:id` | What one location holds. |
| `GET /low-stock` | Everything at or below its reorder point. |
| `GET /integrity` | Administrators: levels that disagree with their movements. |
| `GET /holders` | Crews, trucks, branches and anyone with something out, with counts. |
| `GET /holders/:id?since=` | One holder's supplies, movements since `since`, and equipment out and back (default: since local midnight on the server). |
| `POST /kits` | `{ holderId, expectedReturnAt?, jobRef?, note?, lines: [{ itemId, unitId? }] }`. Returns the kit and any lines that could not go out. |
| `GET /kits?status=open\|closed\|overdue\|all&holderId=` | Kits with out and back counts. |
| `GET /kits/overdue` | Every piece still out past its kit's due time. |
| `GET /kits/:id` | A kit, its pieces and `missing`, the ones still out. |
| `POST /returns` | `{ holderId?, lines: [{ itemId, unitId? }] }`: check pieces in. Returns what was returned, what was not out, and what the holder still has out. |
| `GET /reports/usage?from=&to=` | Usage by holder and by item. A bare date for `to` includes that whole day. Defaults to the last 30 days. |
| `GET /reports/usage.xlsx?from=&to=` | The same, as a workbook. |

A movement body has `reason`, `itemId` and the fields that reason needs:

```json
{ "reason": "receive",  "itemId": "…", "qty": 48, "locationId": "…" }
{ "reason": "issue",    "itemId": "…", "qty": 20, "locationId": "…", "holderId": "…", "jobRef": "JOB-1182" }
{ "reason": "return",   "itemId": "…", "qty": 6,  "locationId": "…", "holderId": "…" }
{ "reason": "consume",  "itemId": "…", "qty": 3,  "holderId": "…" }
{ "reason": "consume",  "itemId": "…", "qty": 2,  "locationId": "…" }
{ "reason": "transfer", "itemId": "…", "qty": 10, "locationId": "…", "toLocationId": "…" }
{ "reason": "count",    "itemId": "…", "countedQty": 23, "locationId": "…" }
{ "reason": "adjust",   "itemId": "…", "delta": -4, "locationId": "…", "note": "Water damage" }
```

`note` is accepted on every movement and required on an adjustment, which is
refused for API keys and for members. A refused movement changes nothing and
answers with a 400 that says what is on hand or outstanding.

Codes accepted by `lookup` and `resolve`: any identifier (barcode, RFID, serial),
an item or unit asset code, a unit serial, a location code, and the URL printed
in a label's QR code. Resolving records no "scanned" event in an item's history,
so a roll of tape scanned all day does not bury everything else.

## Data

| Table | Holds |
| --- | --- |
| `consumable_items` | Which items are supplies, and how they are counted. |
| `stock_levels` | Quantity per item and location. |
| `stock_movements` | Every change, with holder, job reference, note, unit cost, and for counts what was expected and found. |
| `equipment_kits`, `equipment_kit_lines` | Kits and the check-out record of each piece. |
| `consumable_digest_runs` | One row per day the low-stock digest ran. |

All but the digest log are included in backups. Deleting a location removes its
levels; the movements stay, without the location. Deleting a holder keeps its
name on past movements, kits and reports, but anything it still had out stops
counting as outstanding, so return or record it first.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONSUMABLES_DIGEST_HOUR` | `7` | Hour of the day (server time zone, 0 to 23) after which the daily low-stock digest is sent. `-1` turns it off. |

## Tests

`server/tests/consumables.test.ts` covers the movement rules, a randomized
replay and the digest text. `server/tests/consumables-db.test.ts` runs the
acceptance checks against a real Postgres: levels equal to the sum of movements
through every kind of movement, no overselling under concurrent issues, a
12-piece kit with a partial return showing exactly what is missing, and a digest
sent once a day. It needs its own database and is skipped without one:

```bash
createdb bindex_test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_test pnpm test
```
