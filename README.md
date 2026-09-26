<div align="center">

# Bindex

**Self-hosted inventory for physical things. Scan anything, find it anywhere.**

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/wrr2216/bindex/actions/workflows/ci.yml/badge.svg)](https://github.com/wrr2216/bindex/actions/workflows/ci.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-bindex-blue?logo=docker&logoColor=white)](https://github.com/wrr2216/bindex/pkgs/container/bindex)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

</div>

Bindex tracks where your things are. Scan any code on an object, whether that is
a barcode, a serial number, an asset tag, a MAC address or an RFID tag, and the
matching record opens. It does not matter which screen you are on or whether a
search box has focus. A code nobody has entered yet opens a create form, filled
in from a product database where the code can be identified.

It runs equally well for a house, a workshop, a small business or a warehouse.
What things are called, which features exist, and what printed codes look like
are all settings rather than code changes.

> **Project status.** Bindex ran privately for several months before this
> release, managing real inventory across multiple sites. It is stable and in
> daily use, but the public release is young: expect the API to move before 1.0.
> See [CHANGELOG.md](CHANGELOG.md).

## Contents

- [Why](#why)
- [Features](#features)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Signing in](#signing-in)
- [Making it yours](#making-it-yours)
- [Labels and hardware](#labels-and-hardware)
- [Documentation](#documentation)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Why

Most inventory tools make you find the record before you can do anything with
it. That is backwards for physical work. Standing in a storeroom holding a
thing, you already have the answer in your hand: the code printed on it.

Bindex is built around that. A handheld reader is a keyboard, and it types much
faster than a person can. Bindex watches for that pattern everywhere in the app,
so scanning is always the fastest path to a record, with no field to focus first
and no mode to switch into. Ordinary typing is untouched, because only
scanner-speed bursts are captured.

Everything else follows from wanting that to stay true: printed codes that are
short and unambiguous, containers that nest the way real shelves do, and audits
that let you walk a building rather than sit at a terminal.

## Features

**Scanning that works everywhere.** Handheld barcode readers, RFID and NFC desk
readers, and the phone camera all resolve to the same lookup, from any screen.

**Places, containers and things.** Locations nest, so a building holds a room
holds a shelf holds a tote. Items nest too, so a case can hold its own contents.
Both print labels and packing slips.

**Printed codes.** Every item gets a short code such as `INV-4F2K1B`, using an
alphabet with no I, L, O or U so a code read off a label cannot be mistyped into
a different one. An item with several identical copies can track each one
separately, each with its own code, so two of the same drill stay
distinguishable on the shelf.

**Auditing.** Reconcile one tote against what is on file, or walk a whole
building in a single pass with a networked reader, with the running tally
grouped by location.

**Check-out.** Record who has something, and get the full history back later.

**Search.** Postgres does the work: a generated full-text column, plus trigram
indexes for fuzzy matching on names and model numbers.

**Backups.** A complete JSON snapshot that round-trips, downloadable from
Settings, with restore behind a confirmation.

**Optional integrations.** Device management sync, domain registrar sync, a
barcode database, and web search for product photos and prices. Each one is off
until configured, and disappears from the interface when it is not.

**Configurable vocabulary.** Rename the core concepts to match how you talk. A
company keeps Item, Location, Company and Assignee; a household might use Thing,
Room, Household and Person. The words follow through the whole interface,
including the CSV export.

The features below are for warehouse, relocation and field work. Each has its
own switch in Settings, Features, so an instance shows only what it uses. The
exceptions are the audit log and webhooks, which are always on and send nothing
until a webhook is added, and tag commissioning, where only legacy sticker
numbers have a switch.

**Fixed readers and portals.** Zebra and Impinj RFID readers post their reads to
Bindex, each with its own token. A reader covers a zone, a dock-door portal
tells in from out, and every item keeps its current zone, how long it has been
there, and a history of where it was seen.

**Bluetooth beacons.** Gateways in each room report the tags they hear, and
Bindex places each tagged item in the room that hears it best, smoothed so it
does not flap between neighbours. Missing tags, moves out of hours and low
batteries raise alerts.

**GPS and geofences.** Phones running Traccar Client or OsmAnd, and any tracker
a Traccar server understands, report positions. Trails and geofences are drawn
on a map. Leaving a shipment's origin puts it in transit, and reaching its
destination asks for delivery to be confirmed.

**Jobs, shipments and relocations.** Projects run in phases, jobs carry a
manifest of what moves where, and shipments are the truck runs. Crews scan
labels to move lines through packed, loaded, delivered and placed, and anything
on the wrong truck is flagged on the spot.

**Placement.** At the truck, a scan shows the room each thing belongs in. Room
sweeps with a handheld reader, and readers fixed in rooms, confirm it arrived
and flag what is in the wrong room.

**Custody and sign-off.** Controlled items get a signed, timestamped trail of
hand-offs with a PDF receipt. A controlled item cannot be marked delivered on a
job until the receiver has signed for it, on the crew's device or their own
phone.

**Crew check-in.** Workers scan a badge onto a job and see at once whether their
credentials are in order. A job type can hold back anyone missing one until
someone overrides it with a reason. Hours export as a timesheet.

**Documents.** Templates with fields, job data and signatures are grouped into
packets that attach themselves to matching jobs. A completed document exports as
a PDF whose hash is recorded, so a copy can be checked later.

**Inspections.** A site is inspected before and after a move, the two are
compared so new damage stands out, both sides sign, and the report is shared
through a link that expires.

**Claims and incidents.** A claim starts from a job's damaged or missing lines
with their pack-day photos, notes and stage history already gathered, goes
through review against a deadline, and prints as a PDF for an adjuster.

**External portal.** A link lets someone without an account follow a project,
job or shipment, or lets a subcontracted crew scan, photograph and sign for its
own lines.

**Register reconciliation.** Import an asset register as CSV or XLSX, including
Snipe-IT and Homebox exports, and see what is missing, misplaced or disagrees,
or bring it in as new records.

**Consumables and equipment.** Boxes, tape and wrap are counted by location and
issued to crews, trucks and branches. Dollies and straps go out as kits and come
back through an end-of-day return.

**Tag commissioning.** Bind NFC and UHF RFID tags one at a time or in bulk,
print and encode RFID labels on a Zebra printer, and keep legacy colour and
number stickers working until they are replaced.

**Offline mode.** A phone or tablet keeps a copy of chosen locations, queues
moves, check-outs and audits while it has no signal, and sends each change
exactly once when it reconnects.

**Photos, files and data plates.** Photos, video and documents attach to any
record. A photo of an equipment label reads its serial number, model and MAC
address for a person to check and save.

**Condition and containers.** Condition reports record rated defects, compare
before and after, and carry a handling note that prints on the manifest. A
photo of an open box creates its contents as items inside it.

**Valuation and warranty.** Value history, estimates from photos, signed
high-value declarations, receipts matched to what they bought, warranty and
service reminders, and a valuation report with depreciation.

**Teardown guides.** A narrated video of something being taken apart becomes
numbered steps, a parts list and labels for the bags of hardware.

**Bulk capture.** Catalogue a room from photos or a short video, check desks
against a standard kit, or turn a paper inventory into records. A person reviews
every entry before anything is created.

**Audit log and webhooks.** Events from across the application are written to
a hash-chained log that can be exported and verified offline, and sent to
signed webhooks or read from a polling feed.

**Operations insights.** Fixed rules flag cartons left behind, duplicate
serials, and assets read in two places too far apart to have travelled between.
Storage analytics, slotting suggestions and a load planner work from the same
data.

**Optional services.** Reading labels, condition, receipts, rooms and paper
needs a vision model; teardown narration needs speech-to-text; portal codes and
emails need SMTP; video and PDF handling needs ffmpeg and poppler, which the
Docker image includes; maps need a tile server, OpenStreetMap's by default.
Without the service, a feature works by hand or hides the button that needs it.

## Quick start

```bash
git clone https://github.com/wrr2216/bindex.git
cd bindex
cp .env.example .env

# Set SESSION_SECRET to something random:
#   openssl rand -hex 32

docker compose up -d
```

Open <http://localhost:3000>. The first screen asks you to create the owner
account.

## Installation

Bindex is one container plus Postgres. It speaks plain HTTP and expects a
reverse proxy in front of it to terminate TLS.

### Docker Compose

The bundled [`docker-compose.yml`](docker-compose.yml) brings up the app and its
database together. Configuration comes from the `.env` file beside it.

```bash
cp .env.example .env
$EDITOR .env          # set SESSION_SECRET and APP_BASE_URL
docker compose up -d
```

Point your reverse proxy at port 3000. Migrations run on boot, so upgrading is:

```bash
docker compose pull && docker compose up -d
```

### Coolify

[Coolify](https://github.com/coollabsio/coolify) handles the reverse proxy,
certificates and redeploy on push for you. Create a resource from this
repository with the **Docker Compose** build pack, or from the pre-built image
below, then set the domain and environment variables in its interface.

[docs/deployment.md](docs/deployment.md#coolify) covers the two settings that
are easy to get wrong: removing the published port so the proxy handles
routing, and matching `APP_BASE_URL` to the real public URL.

### Pre-built images

```
ghcr.io/wrr2216/bindex:latest      # tracks main
ghcr.io/wrr2216/bindex:1           # latest 1.x
ghcr.io/wrr2216/bindex:1.2.3       # a specific release
```

Images are built for `linux/amd64` and `linux/arm64`, so a Raspberry Pi works.

### From source

Requires Node 20 or newer, pnpm, and a Postgres 14 or newer database.

```bash
pnpm install
pnpm build
pnpm migrate
pnpm start
```

## Configuration

Everything is set through environment variables, documented inline in
[`.env.example`](.env.example). Only three are required:

| Variable | Purpose |
| --- | --- |
| `APP_BASE_URL` | Public URL the browser reaches this at |
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Signs session cookies (`openssl rand -hex 32`) |

Everything else has a working default or turns a feature off when left blank.
See [docs/configuration.md](docs/configuration.md) for the full reference.

Naming, vocabulary and feature switches are **not** environment variables. They
live in the database and are edited in Settings, so changing them needs no
restart. `APP_NAME` and `ASSET_CODE_PREFIX` seed a brand new database and do
nothing after that.

## Signing in

Set `AUTH_MODE` to one of:

| Mode | Who gets in |
| --- | --- |
| `local` (default) | Email and password accounts managed in the app. The first visit creates the owner. |
| `oidc` | Any OpenID Connect provider: Entra ID, Google, Keycloak, Authentik, Okta. |
| `trusted` | Nobody signs in; every request is the same person. Only for a network where something else already decides who can reach the app. |

For OpenID Connect, set `OIDC_ISSUER_URL` to the issuer that serves
`/.well-known/openid-configuration`, add the client id and secret, and register
`https://your-host/auth/callback` with the provider.
`LOCAL_LOGIN_ENABLED=true` keeps a password account alongside single sign-on as
a way back in when the provider is unreachable.

Accounts are either administrators, who can change settings, manage accounts and
restore backups, or members, who can do everything else. `ALLOWED_EMAILS`
restricts sign-in to a list, whichever method is used.

## Making it yours

Settings, under an administrator account, controls:

- **Identity.** The name, an organisation, a tagline, an accent colour, and the
  prefix on printed codes. Codes already printed keep their old prefix, because
  a label on a shelf has to keep resolving.
- **Vocabulary.** What the four core concepts are called.
- **Features.** Thirty-two switches. Turning one off removes it from the
  navigation entirely, so a home instance is not cluttered with groups,
  check-out history or shipments it will never use.
- **Currency and locale.** How money and dates are formatted.

## Labels and hardware

Labels print from the browser to a printer attached to that same computer. The
server never talks to a printer, so there is nothing to configure on either end
beyond installing the driver once per machine.

The server renders each label into a PDF with one exact-size page per label.
That is deliberate: printing HTML to a continuous roll produces stray blank and
oversized labels, whereas one exact-size page produces one clean cut. Set the
size with `LABEL_WIDTH_MM` and `LABEL_HEIGHT_MM`.

Three things print: item and unit labels, container labels with a count of what
is inside, and full-page contents sheets listing everything in a container with
serial numbers and a print timestamp. Labels can also be exported as a
spreadsheet for label software that imports a data file.

For tags, any reader that presents itself as a keyboard works like a barcode
scanner, which covers most RFID and NFC desk readers. Every item and location
page shows its own URL, which can be written to an NFC tag as an NDEF URI
record. For walking a large space, [`bridge/`](bridge/) has a networked reader
bridge that streams tag reads into the audit screen.

Fixed and dock-door RFID readers from Zebra and Impinj, Bluetooth gateways, and
GPS trackers reporting through Traccar or OsmAnd post to their own endpoints
with per-device tokens ([readers](docs/tracking-core.md),
[Bluetooth](docs/ble.md), [GPS](docs/gps.md)). Zebra RFID printers print and
encode a label in one pass, and Chrome on Android reads and writes NFC tags
through Web NFC ([tag commissioning](docs/tag-commissioning.md)).

See [docs/hardware.md](docs/hardware.md) for tested equipment and setup.

## Documentation

- [Configuration reference](docs/configuration.md)
- [Deployment with Docker Compose or Coolify, backups and upgrades](docs/deployment.md)
- [Scanners, printers and tags](docs/hardware.md)
- [HTTP API](docs/api.md)
- [Notifications through Pushover and Wazuh](docs/alerting.md)
- [Audit log, events and webhooks](docs/event-backbone.md)
- [Fixed RFID readers, portals and the tracking core](docs/tracking-core.md)
- [Bluetooth beacons and room-level presence](docs/ble.md)
- [GPS trackers, maps and geofences](docs/gps.md)
- [Projects, jobs, shipments and manifests](docs/jobs-core.md)
- [Placement guidance](docs/placement.md)
- [Chain of custody and sign-off](docs/custody.md)
- [Crew check-in and credentials](docs/crew.md)
- [Documents and conditional packets](docs/documents.md)
- [Site inspections](docs/inspections.md)
- [Claims and incidents](docs/claims.md)
- [External portal](docs/portal.md)
- [Asset register import and reconciliation](docs/register-reconcile.md)
- [Consumables and equipment](docs/consumables.md)
- [Tag commissioning: NFC, RFID encoding, legacy stickers](docs/tag-commissioning.md)
- [Offline field mode](docs/offline-field.md)
- [Attachments, signatures and AI capture](docs/media-ai-core.md)
- [Condition records and container capture](docs/ai-condition.md)
- [Valuation, declarations, receipts and warranty](docs/valuation.md)
- [Teardown guides](docs/teardown.md)
- [AI bulk capture](docs/bulk-capture.md)
- [Operations insights](docs/ops-intel.md)
- [Tagdd+ parity plan and status](docs/tagdd-parity.md)

## Development

```bash
pnpm install
pnpm db:up            # Postgres on :5432 in Docker
cp .env.example .env
pnpm migrate
pnpm dev              # server on :3000, client on :5173
```

Open <http://localhost:5173>; Vite proxies `/api` and `/auth` to the server.
Setting `AUTH_MODE=trusted` skips sign-in while you work on something else.

```
server/    Express API, authentication, Drizzle schema, SQL migrations
client/    React app: global scan capture, item overlay, search, CRUD screens
bridge/    Optional networked RFID reader bridge and Bluetooth gateway script
docs/      Reference documentation
```

`pnpm typecheck`, `pnpm test` and `pnpm build` all run in CI on every pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the pieces fit together.

## Roadmap

Roughly in order of how likely each is to land next.

- Per-location permissions, so a member can be scoped to one site
- Translations, once the vocabulary layer proves itself in English

Open an issue if you need something that is not on this list. Real use cases
move things up it.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the development setup, the shape of the codebase, and the few conventions worth
knowing before you change something.

## Security

Please report security problems privately rather than in a public issue. See
[SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Logan Miller.

Bindex is free software licensed under the
[GNU Affero General Public License v3.0](LICENSE).

In short: you can run it, study it, change it and share it. If you distribute a
modified version, or run one as a network service that other people use, you
have to make your changes available under the same license. Running an
unmodified copy for yourself or your own organisation carries no obligation.
