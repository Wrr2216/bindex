# Reader bridge

Streams UHF tag reads from a ThingMagic M7e into the Building Audit screen, so
you can walk a warehouse and watch the tally update instead of scanning things
one at a time.

```
  M7e reader                Raspberry Pi                 Bindex server
      |                          |                             |
      |  USB serial              |  POST /api/device/scan      |
      +------------------------->+---------------------------->+
                                                               |
  Audit screen <---- poll GET /api/audit/live ------------------+
```

The bridge is one Python file with no dependencies beyond the reader's own
library. Anything that can POST a list of EPCs to `/api/device/scan` works the
same way, so this is a reference implementation as much as a finished tool.

## On the server

Set one or more ingest tokens:

```
INGEST_TOKEN=<openssl rand -hex 24>    # comma-separate to allow several readers
```

The bridge sends its token as `Authorization: Bearer <token>`. With no token
configured the ingest endpoint is disabled and answers 503.

## Hardware

- Connect the dev kit's **USB/RS232** port, the FTDI one nearest the power jack,
  to the Pi. It appears as `/dev/ttyUSB0` with no driver needed. The native USB
  port is for modules with a native USB interface; the Pico is UART only.
- **Attach the antenna before powering the reader on.** Running it without one
  can damage the output stage.
- Match the antenna to the region: 902-928 MHz with `REGION=NA`, 865-868 MHz
  with `REGION=EU3`. The antenna in the EU kit is not the one for North America.
- Check the port with `ls /dev/ttyUSB*`.

## Install

```bash
cd bridge
./install.sh              # packages, python-mercuryapi, dialout group
# log out and back in so the dialout group applies
cp .env.example .env      # fill in SERVER_URL and DEVICE_TOKEN
```

`install.sh` builds `python-mercuryapi` against the MercuryAPI version it
bundles, which is 1.35. That predates the M7e, so if your reader is not
recognised on the first run, see below.

## MercuryAPI 1.37 for the M7e

The M7e needs MercuryAPI 1.37 or newer. The SDK is not redistributable, so it is
not included here: request the zip from JADAK at
<https://www.jadaktech.com/product/thingmagic-mercury-api/>, then rebuild the
Python module against it:

```bash
git clone https://github.com/gotthardp/python-mercuryapi.git
cd python-mercuryapi
make APIZIP=/path/to/mercuryapi-1.37.x.zip APIVER=1.37.x
sudo make install
```

`APIZIP` and `APIVER` default to 1.35; overriding them builds against the zip
you downloaded.

## Run it

```bash
READ_TEST=1 ./run.sh   # prints EPCs to the console, posts nothing
./run.sh               # streams new EPCs to the server
```

Wave a tag in front of the antenna during the read test. You should see
`Connecting to /dev/ttyUSB0` followed by tag lines, then `Streaming new EPCs`
once you drop the test flag.

Once it works, wrap `run.sh` in a systemd unit so it starts with the Pi.

## Using it

1. Tag your things, and store each tag's EPC on the item as an `rfid`
   identifier. Without that, a read has nothing to match.
2. Open **Audit**, then **Audit the whole building**, tick the live reader box and set
   the channel to your `READER_ID`, choose a scope, and start walking.
3. Reads stream in and reconcile as you go. Apply the result when you have
   covered the whole scope.

## Tuning

- **Range.** The Pico is +24 dBm through a single antenna, which is roughly one
  to three metres on a good tag. Walk close to the shelves; a higher-gain
  antenna helps more than anything else.
- **Power.** On a carrier-board build, feed the module's 5 V from your own
  supply and share only ground and UART with the Pi. Transmit spikes of around
  half an amp will brown out a Pi rail. The USB dev kit has its own adapter, so
  this does not apply to it.
- **Several readers.** Give each one a distinct `READER_ID` and pick that
  channel in the audit screen.

## Sightings, zones and portals

With the server's **Readers, beacons and trackers** feature on (it is by
default), every read the bridge posts is also stored as a sighting, and the
bridge appears in **Settings, Readers and devices** under its `READER_ID` the
first time it posts. Give it a zone there and turn on **Move items when read**
to make it a fixed zone reader.

Set `SEND_READS=1` to post to `/api/device/reads` instead of `/api/device/scan`.
Each tag then carries the antenna that saw it, its signal strength and the
time it was read, which a portal needs to tell which way a tag went. The audit
screen keeps working either way. `DEVICE_TOKEN` may be `INGEST_TOKEN` or the
device's own token from Settings. See [docs/tracking-core.md](../docs/tracking-core.md).
