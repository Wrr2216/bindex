# Scanners, printers and tags

None of this is required. Bindex works with a phone camera and a sheet of
handwritten labels. But the workflow gets much faster with the right kit, and
this is what the pieces do.

## Barcode scanners

Any handheld scanner that presents itself as a keyboard works, which is nearly
all of them. There is no driver, no pairing inside the app, and nothing to
configure: plug it in and scan.

Bindex detects a scan by how fast the characters arrive. A scanner types a whole
code in a few milliseconds, far faster than a person, so a burst of at least
four characters arriving at that speed is treated as a scan. It fires on Enter
or on a short pause, so it works whether or not the scanner is configured to
send a carriage return.

The consequence worth knowing: you never have to focus a search box first. Scan
from any screen and the record opens. Ordinary typing, including into the search
box, is never mistaken for a scan.

Corded USB scanners are the least trouble. Wireless ones that pair as a
Bluetooth keyboard behave identically once connected. If yours has a mode
setting, use HID or keyboard wedge rather than serial.

## Label printers

Labels print from your browser to a printer attached to your own machine. The
server renders the PDF; it never talks to a printer. That means no printer
configuration on the server, no queue to manage, and no network path from the
server to your desk.

Install the printer driver once per machine. Then, in the print dialog:

- Set the paper size to the roll or stock you loaded, or add a custom size with
  the same dimensions and zero margins.
- Set the scale to **100 percent**. Fit or Default stretches the label and
  breaks the barcode.

The PDF has one exact-size page per label. This is deliberate. Printing HTML to
a continuous roll produces stray blank labels and oversized ones, because the
browser decides where pages break. One exact-size page yields one clean cut.

Set the printed size with `LABEL_WIDTH_MM` and `LABEL_HEIGHT_MM`. The default,
62 by 25.4 mm, suits a 62 mm continuous roll cut to one inch. If pages come out
rotated, `LABEL_ROTATE_DEG` accepts 0, 90, 180 or 270.

Phones print the same way over AirPrint. There is no separate mobile path.

Two label styles print for each record: the standard label, with the name and a
barcode of the printed code, and a compact style that is the QR code alone with
the code beneath it, for small items.

For label software that imports a spreadsheet rather than printing a PDF, every
print view also offers the same labels as an XLSX download, one row per label.

## RFID and NFC

Two different uses, both built on the same identifier model.

### Desk readers

Any RFID or NFC reader that presents itself as a keyboard types a tag's ID the
same way a barcode scanner types a barcode, so it needs no special support. On
an item page, **Bind an RFID tag** attaches the next read to that item. Reading
it later opens the item from anywhere.

### NFC tags

Every item and location page shows its own URL. Write that to a tag as an NDEF
URI record with any tag writer, and tapping the tag with a phone opens the page.
The in-app scanner resolves the same URL, so one tag serves both a phone tap and
a reader.

NTAG213 stickers hold far more than a URL needs and cost very little.

### Walking a building

For auditing a large space, a UHF reader that streams continuously beats
scanning items one at a time. [`bridge/`](../bridge/) contains a bridge for a
ThingMagic M7e that posts tag reads to the server, which the audit screen polls.

The bridge is one Python file with no dependencies beyond the reader library, so
it is as much a reference implementation as a finished tool. Anything that can
POST a list of tag IDs to `/api/device/scan` with a bearer token works the same
way. Set `INGEST_TOKEN` to enable the endpoint.

Store each tag's ID on its item as an `rfid` identifier, or a read has nothing
to match against.

Expect one to three metres of range from a compact reader on a good tag. Walk
close to the shelves. A higher-gain antenna helps more than anything else you
can change.

## Printed codes

Every item gets a short code, printed as a barcode and shown on its page. The
random part uses Crockford base32, which omits I, L, O and U, so a code read off
a worn label cannot be mistyped into a different valid one.

The prefix is a setting. Codes already issued keep their old prefix when it
changes, because a label on a shelf has to keep resolving.

Location codes are derived from the location's identifier rather than random, so
reprinting a label for the same shelf always produces the same code.
