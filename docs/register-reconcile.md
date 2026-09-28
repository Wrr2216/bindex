# Asset register import and reconciliation

Another system usually keeps its own list of what should exist: an IT asset
management tool, the finance team's fixed-asset register, a Snipe-IT or Homebox
instance being retired. This feature takes that list as a spreadsheet, compares
it with what is on file here, and says what is missing, what is misplaced, and
what disagrees. It can also bring the list in as new records.

Nothing about any item changes until a person runs an action. Uploading,
mapping columns, reconciling and exporting a report only read the inventory.
Every action writes an item event.

It is switched on by the **Asset register reconciliation** feature switch
(`registerReconcile`, stored as `features.register_reconcile`, on by default)
and reached from **Audit → Reconcile against a register**. Switching it off
removes the link and the screens under `/audit/register`. The entry link lives
on the Audit page, so it also needs the Audit switch on. The HTTP API stays
available either way, like every other feature's.

## Workflow

1. **Upload** a CSV or XLSX file. The source system is detected from the headers
   (or chosen), and every column is mapped to a field automatically.
2. **Check the columns.** Change any mapping; the rows are re-read from the
   stored cells, so the file does not need uploading again. Rows with cells that
   could not be read (a cost that is not a number, a date that is not a date)
   are counted and listed.
3. **Check the locations.** Every distinct location the register names is
   shown with where it lands here. Map the ones that did not resolve; the
   mapping is remembered for every later register.
4. **Reconcile**, across everything or scoped to a group, a location and
   everything inside it, or both. The run is saved.
5. **Work the results** class by class, selecting one or many and acting on
   them, then export the discrepancy report.
6. **Run it again** after fixing things, and compare the two runs.

Or, from step 3, **Import as new items**: preview exactly what would be created,
then create it.

## Files

| | |
| --- | --- |
| Formats | CSV and XLSX, told apart by content, not by file name. An old `.xls` workbook is refused with a request to save it as `.xlsx` or `.csv`. |
| Size | Up to 32 MB and 50,000 data rows per upload. |
| Header | The first non-blank row. Blank headers become `Column N`; repeated ones become `Name (2)`. |
| Rows | Blank rows are skipped. Row numbers everywhere are the ones a spreadsheet program shows, with the header as row 1. |

CSV is read by a small RFC 4180 parser written for this (`csv.ts`). It handles
a UTF-8 byte order mark, Windows-1252 files from older Excel (UTF-8 is tried
strictly first), CRLF, LF and lone CR line endings, quoted fields containing
delimiters, doubled quotes and line breaks, comma, semicolon or tab delimiters
(detected from the header line, ignoring anything inside quotes), and Excel's
`sep=;` first line. A stray quote inside an unquoted field is kept as text. A
quoted field that never closes is refused, naming the line, because it means the
file was cut short.

XLSX is read with exceljs: the first worksheet with anything on it. Dates come
through as dates, rich text as its text, formulas as their last calculated
value.

## Fields

| Field | Used for | Normalised how |
| --- | --- | --- |
| Asset tag | Matching (first) | Trimmed; compared ignoring case. |
| Serial number | Matching (second), conflicts | Trimmed; compared ignoring case. |
| RFID / EPC | Matching (third), conflicts | Spaces, colons and dashes removed, `0x` dropped, uppercased when the result is hex. |
| Printed code | Matching (fourth) | A code printed by this instance (`INV-4F2K1B`), when the register records it. |
| Name | Fuzzy proposals, new items | Whitespace collapsed. |
| Model | Fuzzy proposals, conflicts | As written; compared loosely (see below). |
| Manufacturer, Category, Description | New items | As written. |
| Location | Misplaced check, new items | Resolved to a location (see below). |
| Custodian | Kept on the row and in new items' metadata | As written. |
| Cost | Conflicts, new items' value | To cents. `1299`, `$1,299.00`, `1.299,00 €`, `(45.10)` and `USD 12` all read. With both `.` and `,`, the last is the decimal point; a lone `,` before one or two digits is a decimal comma, before three a thousands separator. |
| Purchase date | New items' metadata | To `YYYY-MM-DD`. ISO dates, Excel serial days, `12 Mar 2023`, `Mar 12, 2023` and numeric dates. A numeric date is read month-first when the instance locale is `en-US` (or `en`, `en-PH`) and day-first otherwise, unless one part can only be a day. |
| Quantity | New items | A whole number. |

## Presets

Header names are compared by letters and digits only, so `Serial No.`,
`serial_no` and `SERIAL NO` are the same. A preset's own names are tried first,
then the generic ones, and each column is used for one field at most.

The Snipe-IT and Homebox lists are built from those projects' documented export
formats and have not been checked against a live export from every version.
Anything they miss can be mapped by hand in the Columns section.

**Generic** (also the fallback for every preset)

| Field | Headers |
| --- | --- |
| Asset tag | asset tag, tag, asset tag number, tag number, asset, asset id, asset no, asset number, inventory number, inventory no, property tag |
| Serial number | serial, serial number, serial no, sn, s/n, serialnumber, service tag |
| RFID / EPC | epc, rfid, rfid tag, rfid epc, tag epc, epc hex, uhf tag |
| Printed code | bindex code, printed code, bindex asset code, inventory code |
| Name | name, item, item name, asset name, title, device name, hostname |
| Model | model, model number, model no, model name, part number, mpn |
| Manufacturer | manufacturer, brand, make, vendor |
| Category | category, type, asset type, asset class, class, kind |
| Description | description, notes, details |
| Location | location, room, site, building, place, area, location name |
| Custodian | custodian, assigned to, owner, user, checked out to, holder, employee, responsible |
| Cost | cost, price, value, purchase price, purchase cost, amount, unit cost |
| Purchase date | purchase date, purchased, date purchased, acquired, acquisition date, bought |
| Quantity | quantity, qty, count, units |

**Snipe-IT asset export** (Hardware list export, or the custom asset report).
Detected when there is an `Asset Tag` column plus one of `Checked Out To`,
`Model No.`, `Default Location` or `Purchase Cost`.

| Field | Headers |
| --- | --- |
| Asset tag | Asset Tag |
| Serial number | Serial, Serial Number |
| Name | Asset Name, Name, Item Name |
| Model | Model No., Model Number, Model |
| Manufacturer | Manufacturer |
| Category | Category |
| Description | Notes |
| Location | Location, Default Location, RTD Location |
| Custodian | Checked Out To, Assigned To, Full Name, Username, Email |
| Cost | Purchase Cost |
| Purchase date | Purchase Date |

**Homebox export** (Tools → Export inventory). Detected by any `HB.` column.

| Field | Headers |
| --- | --- |
| Asset tag | HB.asset_id |
| Serial number | HB.serial_number |
| Name | HB.name |
| Model | HB.model_number |
| Manufacturer | HB.manufacturer |
| Category | HB.labels |
| Description | HB.description, HB.notes |
| Location | HB.location (a `/`-separated path works as a path) |
| Cost | HB.purchase_price |
| Purchase date | HB.purchase_time, HB.purchase_date |
| Quantity | HB.quantity |

**ERP fixed-asset register.** Detected by `Acquisition Date`, `Acquisition
Cost`, `Date Acquired`, `In Service Date`, `Capitalization Date` or `Original
Cost`.

| Field | Headers |
| --- | --- |
| Asset tag | Asset Number, Asset No, Asset ID, Fixed Asset Number, FA Number, Asset |
| Serial number | Serial Number, Serial No, Serial |
| Name | Description, Asset Description, Asset Name, Name |
| Model | Model |
| Category | Asset Class, Asset Category, Class, Category, Asset Group |
| Location | Location, Location Code, Cost Center Location, Site |
| Custodian | Custodian, Responsible Person, Employee, Responsible |
| Cost | Acquisition Cost, Original Cost, Historical Cost, Cost, Acquisition Value, Gross Book Value |
| Purchase date | Acquisition Date, Date Acquired, In Service Date, In-Service Date, Capitalization Date, Capitalisation Date, Placed In Service |

## Locations

Register location text is resolved in this order:

1. **Full path.** `Warehouse / Aisle 3`, `Warehouse > Aisle 3`,
   `warehouse\aisle 3` and `Warehouse | Aisle 3` all mean the location
   *Aisle 3* inside *Warehouse*. Case and extra spaces do not matter.
2. **Name**, when exactly one location has that name.
3. **A saved mapping**, for text neither found. Mappings are keyed by the
   normalised text and kept for every later register.

There is deliberately no partial matching. `Chicago / Storage` does not resolve
to `Denver / Storage` just because only one location is called *Storage*: that
would send someone to the wrong building. Text that fits several locations is
reported as ambiguous. A row whose location did not resolve is never reported as
misplaced; the result carries a note instead.

## Matching

An **asset** here is an item, or one tracked unit of an item. Each register row
is matched by exact keys, in this order, and the first key that finds something
decides:

1. **Asset tag** against `asset_tag` identifiers.
2. **Serial** against `serial` identifiers and unit serials.
3. **RFID / EPC** against `rfid` identifiers, both sides normalised.
4. **Printed code**: the row's printed-code column, then its asset tag column,
   against item and unit codes. This catches registers that were filled in with
   the codes printed here.

A unit's serial or code identifies that unit. When a key names both an item and
one of its units, the unit wins. When the deciding key is on several records
here, a later key on the row may pick one of them; either way the row is a
duplicate. When another key on the row points at a different record, the row
gets a note ("Serial SN-2 is recorded on INV-...") and, since its own record then
has a different serial, a serial conflict.

Matching is global: a row naming something outside the run's scope still matches
it (with a note), so scoping never makes a known asset look new. The scope only
limits which assets can be reported as missing from the register and which can
be proposed by fuzzy matching.

Domains (items in the *Domain* category) are left out entirely.

### Fuzzy proposals

A row that matched nothing exactly, with a name of three or more characters,
gets the most similar item in scope that no row claimed, using pg_trgm:

- candidates are items whose name is trigram-similar to the row's name, or
  whose model is similar to the row's model (each through its own trigram
  index);
- the score is `similarity(name, name)`, averaged with `similarity(model,
  model)` when both sides have a model;
- only scores of 0.40 or more are shown, with the score.

**A proposal is not a match.** The row stays *only in the register* and the
item stays *not in the register* until a person links them. Linking adds the
row's tag, serial and EPC to the item as identifiers where they are free, and
records the item's printed code on the register copy, so the next run matches
exactly.

## Classes

Every row, and every in-scope asset no row accounts for, gets one or more
classes. *Matched* means matched with nothing to fix.

| Class | Meaning |
| --- | --- |
| Matched | Matched on a key; location, keys, model and cost agree. |
| Misplaced | Matched, and the register's location resolved to a different location from the asset's here (including none here). |
| Field conflict | Matched, and asset tag, serial, EPC, model or cost differ. A field is only compared when both sides have a value. Models are compared ignoring case, spaces, dashes, dots and underscores, and one containing the other counts as the same (`Latitude 5420` and `Dell Latitude-5420`). |
| Only in the register | No record here matched. May carry a fuzzy proposal. |
| Not in the register | An asset in scope that no row matched. An item with tracked units is accounted for unit by unit, unless a row names the item itself. |
| Duplicate | The register repeats an asset tag, serial, EPC or printed code; or two rows match the same asset; or a row's key is on several records here. |
| Flagged missing | The asset is flagged missing here (an item's flag, or a unit whose status is `missing`). On a row, the register says it exists; on an asset not in the register, it is probably gone. |

## Runs

A run stores its counts, the scope, and one result per row and per unaccounted
asset, with a snapshot of the asset as it was, so an old run still reads
correctly after items change or are deleted.

Each result is open, resolved (an action handled it) or ignored (with a
reason). Running the same register again carries ignored results forward, so a
decision to ignore something is made once, unless the result has picked up a
class that was not ignored (an ignored flagged-missing row that is now also
misplaced comes back open).

**Comparing two runs** pairs register rows by their register key (asset tag,
then serial, EPC, printed code, name; repeated keys are counted in order), and
unaccounted assets by the asset. That lines up re-runs of one upload and uploads
of successive versions of the same register. It reports what was cleared, what
is new, what moved between classes, and per-class counts before and after.
Ignored results count as cleared.

## Actions

All actions take many results at once. A result an action does not apply to is
skipped with a reason. A resolved or ignored result has to be reopened before
another action applies to it.

| Action | Applies to | What it does | Item event |
| --- | --- | --- | --- |
| Move to the register's location | Misplaced | Sets the item's (or unit's) location to the register's. | `moved` with `from`, `to` |
| Keep it where it is here | Misplaced | Rewrites the register copy's location to this location's path. | `updated` |
| Copy register → here | Any matched row | Name, model and cost onto the item (cost onto the unit for a unit, rolling up); serial onto the unit, or as a `serial` identifier; asset tag and EPC as `asset_tag` and `rfid` identifiers. An item's only identifier of that type is replaced; otherwise one is added. An identifier already on another item is skipped with a reason. | `updated` with the fields |
| Copy here → register copy | Any matched row | Writes the item's values into the stored register row and records the change. | `updated` with the fields |
| Create items | Only in the register | Creates items with identifiers, as in import-only mode. | `created` |
| Link to the proposed match | Only in the register, with a proposal | See fuzzy proposals. | `updated` |
| Flag missing | Not in the register | Flags the item missing (a unit gets status `missing`). | `updated` |
| Clear missing flag | Flagged missing | Clears the flag (and a unit's `missing` status). | `updated` |
| Ignore, with a reason | Anything | Marks the results ignored. | `updated` per item; one summary event for rows with no item |
| Reopen | Resolved or ignored | Makes them open again. | `updated` |

Every event's detail has `source: "register"` with the run and register ids.

The register copy is never written back to the source system. Changes copied
into it are listed on the **Register updates** sheet of the XLSX report, with
the value the source system had and the value to change it to.

## Reports

From a run, as XLSX or PDF:

- summary: register, file, row count, scope, run time, and per class the total,
  open, resolved and ignored counts;
- one section per class (a worksheet each in XLSX) listing register row, tag and
  serial, register name and location, printed code, item name, location here,
  details (match key, each conflict, proposal, notes) and status;
- XLSX only: the register updates sheet.

The PDF uses the standard PDF fonts, which cover Windows-1252; other characters
are reduced to their base letter or printed as `?`. It lists clean matches only
up to 200 rows; above that it gives their count, because they are not
discrepancies and would bury the sections that are. The XLSX keeps every row
and every character.

## Import-only mode

**Import as new items** plans one new item per row whose asset tag, serial and
EPC are all free, and shows the plan before anything is created: every item with
its name, model, identifiers, location, quantity and value, every skipped row
with its reason, and warnings.

Rows are skipped when their tag, serial or EPC is already on file (naming the
record), when they repeat an earlier row's key, when they have nothing to call
the item by, or when they were already imported. A row without a name is named
by its model, then the first line of its description, then its tag or serial. A
location that does not resolve uses the chosen default location (with a
warning), or none.

The commit re-plans and refuses to run (409) unless the plan is identical to the
previewed one, so what is created is exactly what was shown. Two simultaneous
commits of the same rows create them once. Created items record where they came
from in `metadata.register` (register id and name, row number, purchase date,
custodian, location text) and link back from the register row.

## API

All under `/api/register-reconcile`, behind the usual session or API key.
Read-only keys can use the `GET` endpoints.

| Method | Path | |
| --- | --- | --- |
| GET | `/presets` | Fields and presets. |
| GET | `/imports` | Uploaded registers. |
| POST | `/imports?filename=&name=&preset=` | Upload: the file is the raw request body (any content type except JSON). |
| GET | `/imports/:id` | Mapping, per-field coverage, sample rows, runs. |
| PATCH | `/imports/:id` | `{ name?, preset?, mapping? }`. A new preset without a mapping re-detects the mapping. |
| DELETE | `/imports/:id` | Deletes the register and its runs; created items stay. |
| GET | `/imports/:id/rows?offset=&limit=&q=&issues=1` | Stored rows. |
| GET | `/imports/:id/locations` | Distinct location texts and how each resolved. |
| POST | `/imports/:id/reconcile` | `{ companyId?, locationId? }` → the saved run. |
| POST | `/imports/:id/import-preview` | `{ companyId?, defaultLocationId? }` → the plan and its `hash`. |
| POST | `/imports/:id/import-commit` | The same options plus `planHash`. |
| GET, PUT | `/location-map` | List mappings; `{ text, locationId }` saves one, `locationId: null` forgets it. |
| GET | `/runs?importId=` | Runs. |
| GET, DELETE | `/runs/:id` | A run with per-class open/resolved/ignored counts. |
| GET | `/runs/:id/results?class=&status=open\|resolved\|ignored\|all&q=&offset=&limit=` | Results, up to 1,000 a page. |
| POST | `/runs/:id/actions` | `{ action, resultIds, ... }`, up to 20,000 results. See the table above for actions; `copy_fields` takes `direction` (`to_bindex` or `to_register`) and `fields`, `ignore` takes `reason`, `create_items` takes `companyId` and `defaultLocationId`. |
| GET | `/runs/:id/compare/:otherId` | Comparison, older run first whichever order they are given in. |
| GET | `/runs/:id/report.xlsx`, `/runs/:id/report.pdf` | Reports. |

## Performance

Measured on a development machine against 5,500 items and a 5,000-row register
(3,500 matched by tag, 1,000 by serial, 500 needing fuzzy proposals):

| Step | Time |
| --- | --- |
| Upload and parse | 1.3 s |
| Reconcile (matching 1.0 s, saving 5,500 results 1.0 s) | 2.1 s |
| A page of results | 20 ms |
| XLSX report | 0.6 s |
| PDF report (72 pages) | 1.0 s |
| Bulk move of 444 misplaced items | 0.5 s |

Assets are loaded in three queries (items, units, identifiers) and matched in
memory. Fuzzy proposals are one query per few hundred rows, split across up to
four database connections; the worst case, 5,000 rows with nothing matching
exactly against 5,500 similarly named items, took 4.5 s. Above 20,000 unmatched
rows, proposals are skipped for the remainder.

## Storage and backups

Migration `0026_register_reconcile.sql` adds `register_imports`,
`register_rows` (original cells in `raw`, normalised fields alongside, copied
changes in `edits`, and the item a row created), `register_location_map`,
`reconciliation_runs` and `reconciliation_results`.

All five are in the JSON backup. Restoring a backup written before this feature
existed empties them.
