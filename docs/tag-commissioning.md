# Tag commissioning

Putting tags on things and telling Bindex which tag is on what: NFC tags a
phone can tap, UHF RFID tags a reader picks up in bulk, and the colour, lot and
number stickers of an older labelling system. The upgrade path a site usually
follows is **legacy stickers, then RFID, then RFID + NFC**, and Bindex shows
where each item is on it.

Everything here lives on the **Tags** page, on each item's page, and in the
print view.

| What | Where | Switched by |
|---|---|---|
| Tap to look up, tap to bind, write a tag | Floating NFC button, item and location pages | Only shown where the browser supports Web NFC |
| EPC per item and unit | Item page, Tags panel | Always on |
| Print and encode (ZPL, code,EPC CSV) | Print view | `printing` |
| Bulk binding sessions | Tags → Bulk binding | Always on |
| Tag tier badge and coverage report | Item page, list cards, Tags → Coverage | Always on |
| Legacy sticker numbers | Item page, Tags → Legacy stickers, list dots | `legacyTags` ("Legacy sticker numbers", off by default) |
| GS1 company prefix, sticker colours | Tags → Settings | Administrators |

## Phones and browsers

Reading and writing NFC from the browser uses
[Web NFC](https://developer.mozilla.org/en-US/docs/Web/API/Web_NFC_API), which
only **Chrome on Android** implements (version 89 or later). It also needs:

- the site served over **HTTPS** (or `localhost`),
- NFC switched on in the phone's settings,
- the page in the foreground with the screen on.

The first tap on an NFC button asks for permission. Once granted, tap lookup
turns itself back on when the app is next opened.

Everywhere else (iPhone, desktop browsers, Firefox) the NFC buttons are hidden
and a one-line hint says where they work. Two things still work without Web NFC:

- **A tag with a URL written on it opens the record on any phone**, iPhone
  included: the operating system reads URL tags on its own. Write tags from an
  Android phone, or with any tag-writing app using the URL on the record's page.
- **A desk NFC reader that types** (a keyboard-wedge USB reader) binds and looks
  up tags like a barcode scanner. On an item page use *Read an NFC tag with a
  reader*.

### Tap to look up

The round NFC button (bottom right, above the camera button) turns tap mode on.
While it is on, tapping a tag from any screen:

1. opens the page the tag links to, when it carries a URL record for this
   instance (or an `/items/…` or `/locations/…` link written through another
   address of it, such as a LAN name),
2. otherwise looks up its UID, through the same path a scanned barcode takes,
   and opens the record,
3. otherwise offers to bind the unknown tag: search for the item it is stuck
   on and pick it.

Screens that want taps for themselves take them first: an item page waiting for
*Tap an NFC tag to bind*, and an NFC bulk binding session.

### Writing a tag

Item and location pages have **Write to a tag** under *NFC tag*. It writes one
NDEF URL record with the page's address, overwriting what was there. Tick
**Make read-only** to lock the tag afterwards; the phone asks to confirm,
because a locked tag can never be rewritten or erased by anyone. Keep the tag
against the phone until it says it is done.

## Tags

### NFC

Any NFC Forum Type 2 tag works. The common ones:

| Tag | User memory | Notes |
|---|---|---|
| NTAG213 | 144 bytes | Plenty for a Bindex URL (about 60 to 80 characters). The cheapest. |
| NTAG215 | 504 bytes | |
| NTAG216 | 888 bytes | |

Their 7-byte UIDs are what *tap to bind* records. Bindex stores UIDs as bare
uppercase hex (`04A23B4C5D6E80`), however a reader reports them
(`04:a2:3b:4c:5d:6e:80`, `04 A2 3B …`), so a UID bound from a phone matches the
same tag read by a desk reader. Some readers report the bytes in reverse order;
those will not match a phone's reading of the same tag.

On metal, use tags made for metal (with a ferrite layer); ordinary stickers
read poorly or not at all.

### UHF RFID

Any EPC Class 1 Gen 2 (RAIN) inlay. Tags either arrive with a factory EPC,
which bulk binding records as it is, or get an EPC written by Bindex through
*Print and encode* (below).

### Dual-frequency

Dual-frequency chips, such as EM Microelectronic's EM4425, put a UHF interface
and an NFC interface on one inlay, so one label answers both a UHF reader and a
phone. Bind it both ways: its EPC as RFID (a bulk session, or print and
encode), then tap it to bind its NFC UID. The item then shows **RFID + NFC**.

A tag ID can be bound once only. If a chip reports the very same ID on both
radios, bind it as RFID; binding it again as NFC is refused.

## EPCs

Every item and every tracked unit gets an EPC for writing to a tag. The item
page shows it under *Tags*, and each unit card shows its own.

- It is assigned the first time the page is opened and kept, so the number on
  screen is the one that ends up on the tag.
- Until it has been sent to an encoder it follows the settings: set a GS1
  company prefix and the next look turns a private EPC into GIAI-96.
- **Once it has been sent to an encoder it is fixed**, even if the company
  prefix changes later.

A scan of an assigned EPC resolves to its record even if it was never recorded
as a tag, and *Print and encode* records it as the record's RFID tag anyway.

### GIAI-96 (with a GS1 company prefix)

When an administrator sets a GS1 company prefix (Tags → Settings), EPCs are
**GIAI-96**, the GS1 Global Individual Asset Identifier, encoded as the GS1 EPC
Tag Data Standard defines it:

| Bits | Field | Value |
|---|---|---|
| 8 | Header | `0x34` |
| 3 | Filter | `0` ("all others") |
| 3 | Partition | 12 minus the prefix length |
| 20 to 40 | Company prefix | Your prefix, 6 to 12 digits |
| 62 to 42 | Asset reference | A serial number from a database sequence |

The page shows the EPC as hex and as a tag URI, for example
`urn:epc:tag:giai-96:0.0614141.21`. Serial numbers are allocated by a Postgres
sequence and never reused; a restore into a new database moves the sequence
past the serials it brings back. The encoder and decoder are tested against the
Standard's GIAI example (`urn:epc:id:giai:0614141.12345400`), every partition,
and the field placement of the Standard's published SGTIN-96 example.

Use GIAI-96 whenever tags will be read by systems other than Bindex: a GS1
EPC is globally unique and every RAIN reader's software can decode it.

### bindex-96 (without a prefix)

Without a GS1 prefix, EPCs use a private scheme that packs the item's printed
code into the 96 bits, so any tag decodes back to the code on its label:

| Bits | Field |
|---|---|
| 8 | Header `0x42` |
| 4 | Position of the dash: `0` none, `1`-`13` after that many characters, `15` opaque |
| 84 | 14 characters of 6 bits: `0` padding, `1`-`10` for `0`-`9`, `11`-`36` for `A`-`Z` |

`INV-7F3K2A` becomes `4234D88084045432C0000000`; codes Bindex generates (a prefix of up to 8
characters, a dash and 6 more) always fit. A code that cannot be packed (longer
than 14 letters and digits, or with other characters) gets an **opaque** EPC
instead: the `15` marker followed by 84 bits of the record's UUID.

GS1 has no header reserved for private use. `0x42` sits in the range the Tag
Data Standard lists as reserved for future use, so GS1 decoders report an
unknown scheme rather than misreading it as one of theirs. These EPCs are only
unique within one Bindex instance.

## Print and encode

The print view (the page that opens from *Print label* and the other print
buttons) has an extra **Print and encode (RFID)** row when it is printing
items or units:

- **Download ZPL**: one ZPL label per record for a Zebra RFID printer-encoder
  (ZT411R, ZT421R, ZD621R and similar). It prints the same things as the PDF
  label (QR link, name, Code 128 of the printed code, the code in text) and
  writes the record's EPC in the same pass.
- **Download code,EPC CSV**: `code,epc,scheme,name,url`, one row per record,
  for encoders and label software that import a data file.

Pick the printer's resolution (203, 300 or 600 dpi). The label size follows
`LABEL_WIDTH_MM` and `LABEL_HEIGHT_MM`, the same as the PDF labels. Printing
through the browser stays the main path; this is an extra download.

Leave **Record the EPCs as these records' RFID tags** ticked and downloading
also stores each EPC as an `rfid` identifier on its record and fixes it. An EPC
already bound to another record is never moved.

### ZPL notes

Each label starts with

```
^RS8
^RFW,H,,,A^FD3414257BF400000000000015^FS
```

`^RS8` sets up EPC Class 1 Gen 2 encoding with the printer's own defaults for
program position, retries and what to do with a label that fails to encode
(normally, print VOID across it and try the next). `^RFW,H,,,A` writes the hex
EPC to the EPC memory bank and adjusts the PC length bits to match, so an inlay
that arrived with a 128-bit EPC ends up with a clean 96-bit one. The `A` option
needs Link-OS firmware, which the printers above run.

Text fields go through `^FH` so a name containing `^` or `~` cannot break the
label, and `^CI28` selects UTF-8. The built-in font covers Latin text; other
scripts need a font loaded on the printer.

To print: send the file to the printer as raw data, for example with Zebra
Setup Utilities (*Send file*), `lp -d <queue> -o raw labels.zpl`, or
`nc <printer-ip> 9100 < labels.zpl`. After loading a new roll of RFID media, run
the printer's RFID calibration from its menu or Zebra Setup Utilities so it
knows where the inlay sits on the label.

The ZPL is built from Zebra's documentation and has not yet been verified on a
printer.

## Binding

### One tag at a time

On an item page, the *Tags* panel offers the next step up:

- **Read an RFID tag**: the next read from a desk reader (anything that types)
  or the networked reader bridge is bound as RFID.
- **Tap an NFC tag to bind** (Web NFC) or **Read an NFC tag with a reader**.
- **Print and encode** opens the print view for the item.

Each unit card has the same for that unit. A tag bound to a unit still belongs
to the item, so every existing lookup finds the item; scanning it also
highlights the unit.

A tag already bound to something else is refused, and the message names the
record it is on. Binding a tag again to the same record does nothing.

### Bulk binding

Tags → **Bulk binding** walks a list of untagged items with a reader:

1. Pick RFID or NFC and a location. By default the list covers everything
   inside it, leaves out what already has a tag of that type, and has one entry
   per tracked unit for items that have units.
2. Start. The screen shows the next item, with its code and location.
3. Put a tag on it and read the tag: a desk reader, the networked reader (turn
   it on from the session), a phone tap for NFC, or type the ID. The tag binds
   to that item and the next one comes up.

Reads that are ignored, and say so: a tag already bound anywhere (it is never
moved), and the same tag read again (a UHF reader reports a tag many times a
second). **Undo last** takes back the last bind or skip; an undone bind removes
the tag, and the next read binds that item again. **Skip** leaves an item
untagged. Sessions are stored, so a reload or a second device picks up where
the first left off.

With UHF, keep the reader at low power or use a near-field desk antenna, so the
only unbound tag it sees is the one in your hand.

## Legacy stickers

Switch on **Legacy sticker numbers** in Settings → Features.

A legacy sticker is a colour, an optional lot and a number: *RED 1234 056*.
Bindex stores it as a `legacy` identifier in the form `COLOR-LOT-NUMBER`
(`RED-1234-56`), or `COLOR-NUMBER` without a lot, plus the parts separately.
Typing or scanning it in any of these forms finds the same record:

- any case: `red`, `Red`, `RED`;
- any separators: spaces, `-`, `/`, `.`, `_`, `,`, `#`, or a colour run straight
  into the lot (`RED1234 56`);
- any zero padding on the number, and on a lot made of digits: `056` is `56`,
  `0012` is `12`. A lot with letters (`A7`) is kept as written, uppercased.

This works in the scanner, in the search box, and on Tags → Legacy stickers →
*Look up a sticker*.

The colours come from a palette an administrator edits (Tags → Settings). The
default is red, orange, yellow, green, blue, purple, white and black. A colour
name is one word, because it becomes the first part of the stored form. The
generic *Add identifier* box accepts any single-word colour; the sticker forms
only offer the palette.

### Workflow

1. **Enter the stickered inventory.** Tags → Legacy stickers: pick the colour,
   lot and location, type the first number and what the box is, and **Save and
   next**. The next free number is filled in and the cursor goes back to the
   name, so a run of boxes is one line each.
2. **Find things by sticker.** Lists and contents show a coloured dot with the
   number; the full sticker is in the tooltip and on the item page.
3. **Upgrade to RFID.** Start a bulk binding session for the location, or
   print and encode new labels; the item keeps its sticker and moves up to the
   RFID tier. Watch progress on Tags → Coverage.

Each sticker can be on one record only. An item can have its sticker changed or
removed from its page.

## Tag tiers and coverage

Every item is in one tier, from least to most capable:

| Tier | Meaning |
|---|---|
| No tag | Nothing on file shows a label or tag is on it |
| Barcode / QR | A product barcode, serial or other code on file, an NFC tag on its own, or its printed Bindex code has been scanned at least once |
| Legacy sticker | A colour, lot and number sticker |
| RFID | A UHF tag: read in bulk from a distance |
| RFID + NFC | A UHF tag and an NFC tag, or one dual-frequency tag bound both ways |

The item page shows the tier with the next step up. List cards show it only
from RFID up, to keep lists quiet. Tags → **Coverage** counts items by tier for
every location, with the share a reader picks up in bulk (RFID coverage); pick a
location to see only it and everything inside it. Domains are not counted.

Bindex does not record when a label is printed, so an item whose label has
never been scanned and that has no other code on file counts as *No tag* even
if its label is on it. Scanning it once moves it up.

## API

All under `/api/tag-commissioning`, with a session or an API key. Changing the
settings needs an administrator's session.

| Method and path | Does |
|---|---|
| `GET /settings` | GS1 prefix, sticker palette, current EPC scheme |
| `PUT /settings` | `{ gs1CompanyPrefix?, palette? }` (administrators) |
| `GET /resolve?code=` | What a code would open, without recording a scan |
| `POST /summary` | `{ itemIds }` (up to 500): tier and sticker per item |
| `GET /items/:id` | Tier, tags, sticker and EPC of an item and of each unit (assigns EPCs not yet assigned) |
| `POST /items/:id/bind` | `{ type: "rfid" \| "nfc", value, unitId? }` |
| `PUT /items/:id/legacy` | `{ color, lot?, number }`: set the item's sticker |
| `DELETE /items/:id/legacy` | Remove it |
| `GET /legacy/parse?text=` | How a typed sticker would be stored |
| `GET /legacy/next?color=&lot=&after=` | Next free number in a colour and lot |
| `POST /legacy/items` | `{ name, color, lot?, number, locationId? }`: create an item with a sticker; answers with the next number |
| `POST /encode` | `{ itemIds?, unitIds?, format: "zpl" \| "csv", dpi?, bind?, sample? }`: a file download |
| `GET /report/tiers?locationId=` | Items by tier per location |
| `GET /sessions`, `POST /sessions`, `GET /sessions/:id` | Bulk binding sessions |
| `POST /sessions/:id/read` | `{ code }`: one tag read |
| `POST /sessions/:id/skip`, `/undo`, `/finish` | |

`nfc` and `legacy` are also accepted by the generic
`POST /api/items/:id/identifiers` and in `identifiers` when creating an item,
and are normalized the same way. `rfid` values made of hex are stored as bare
uppercase hex too.

## Data

Migration `0028_tag_commissioning.sql`:

- widens the `item_identifiers` type check to `nfc` and `legacy`, keeping every
  type earlier migrations allowed (`upc`, `serial`, `asset_tag`, `mac`, `sku`,
  `other`, `rfid`, `domain`);
- adds `nfc` and `legacy` to the set of identifier types whose value must be
  unique across all items;
- adds an index that matches RFID and NFC values on their letters and digits;
- `tag_identifier_units`: which unit a tag is on;
- `tag_legacy_stickers`: colour, lot and number of each sticker, kept by a
  trigger on `item_identifiers`;
- `tag_epcs` and the `tag_giai_serial_seq` sequence: assigned EPCs;
- `tag_bind_sessions`: bulk binding sessions.

Backups include `tag_identifier_units` and `tag_epcs`. Sticker structure is
rebuilt by the trigger when identifiers are restored. Binding sessions are work
in progress and are left out.

## Not yet verified on hardware

Built from documentation and tested with unit tests and a simulated Web NFC
reader, not yet on devices:

- the ZPL on a Zebra RFID printer (encoding, `^RFW` PC adjustment, void handling);
- Web NFC on a real Android phone, including locking tags;
- dual-frequency inlays such as EM4425.
