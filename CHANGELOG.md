# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Everything before 1.0.0 ran privately, on a single deployment. Those releases
are listed because the migrations they introduced are still applied in order on
a fresh install, and because the history explains why some things are shaped the
way they are.

## [Unreleased]

## [1.0.0] - 2026-08-31

First public release. The application was generalised so that one codebase
serves any deployment, and everything specific to its original operator was
removed.

### Added

- Instance configuration stored in the database and edited in Settings: name,
  organisation, tagline, accent colour, printed-code prefixes, currency and
  locale. Environment variables now only seed a database that has never booted.
- Configurable vocabulary for the four core concepts, applied throughout the
  interface, the CSV export and the search prompt.
- Eleven feature switches, each of which removes its screens from the
  navigation when off.
- Email and password accounts, with roles, first-run setup and account
  management in Settings. Passwords are hashed with scrypt.
- `AUTH_MODE=trusted`, for deployments where a network or a proxy already
  controls access.
- A web application manifest generated from the instance configuration, so an
  installed shortcut carries the right name and colour.
- Unit tests for password hashing, printed-code generation and the lookup
  heuristics, run in CI alongside typecheck and build.
- Public documentation: configuration reference, deployment guide, hardware
  notes and HTTP API reference.

### Changed

- Single sign-on now works with any OpenID Connect provider rather than one
  vendor, configured by issuer URL.
- Printed-code prefixes are read from settings by the database triggers that
  generate them, so a change takes effect immediately without rewriting codes
  that have already been printed.
- The label spreadsheet export moved from a vendor-specific route to
  `/api/print/labels.xlsx`.
- Logging is now a small built-in structured logger with no external
  dependency, with `text` and `json` output.

### Removed

- All branding, seeded organisation data and internal infrastructure defaults
  belonging to the original private deployment.
- A disabled mobile printing path that had been switched off behind a constant,
  along with roughly four hundred lines of unreachable code.
- A vendor SDK archive of about 90 MB that had been committed to the reader
  bridge and is not redistributable. The bridge README explains how to obtain
  it.

### Fixed

- `docker-compose.yml` declared a dependency on a database service that the file
  never defined. It went unnoticed because the real deployment pointed at an
  external Postgres.
- Optional model requests sent the system prompt in a field that chat
  completions endpoints ignore, so it never took effect.

## [0.9.0] - 2026-08-06

### Added

- Backup and restore: a JSON snapshot of the inventory data, downloadable from
  Settings, with restore inside a single transaction.
- Optional price and photo lookup for an item that already exists.
- Search by describing what you are looking for, which returns the filter it
  derived alongside the results.
- Per-unit check-out, so one copy of a multi-quantity item can be out while the
  rest stay on the shelf (`0019_unit_assignments`).

## [0.8.0] - 2026-07-06

### Added

- API keys with read and read-write scopes, stored as hashes and shown once
  (`0016_api_keys`).
- Per-unit printed codes, so identical units stay distinguishable on the shelf
  (`0018_unit_identifiers`).

### Fixed

- Adding an item whose UPC was already on file returned a server error. A
  product code identifies a product rather than a unit, so only
  identity-bearing identifiers are globally unique now
  (`0017_identifier_uniqueness`).
- An item code could collide with a unit code, letting one scan resolve to two
  records. Both generators now check across items and units.

## [0.7.0] - 2026-06-16

### Added

- Verify contents on a location, reconciling present, missing, unexpected and
  unknown reads.
- Building-wide audit: walk a site and reconcile everything seen against
  everything in scope, grouped by location.
- Reader bridge for streaming tag reads over the network, with token
  authentication on the ingest endpoint.

## [0.6.0] - 2026-05-26

### Added

- Ownership grouping for locations and items (`0012_companies`,
  `0015_item_company`).
- Domain names tracked as inventory, with Cloudflare and Porkbun sync, expiry
  dates and an expiry digest (`0012_domains`, `0014_domain_category_idx`).
- Location hierarchy, so a building holds a room holds a shelf holds a tote
  (`0013_location_hierarchy`).
- Printable contents sheets for containers, and a spreadsheet export of the
  same label data.

## [0.5.0] - 2026-04-28

### Added

- Item photos, captured from a phone camera or imported from a URL
  (`0008_photos`).
- Individually tracked units of a multi-quantity item, each with its own
  serial, status, location and value (`0009_units`, `0010_unit_value`).
- Spot checks on retrieval: moving a container prompts to confirm a random item
  from it, and flags what was not confirmed (`0011_spotcheck`).

## [0.4.0] - 2026-04-07

### Added

- Assignees: people, teams, customers or sites an item can be out with
  (`0004_entities`).
- Monetary value on items, and dashboard totals (`0005_item_value`).
- Check-out and check-in with full history (`0006_assignments`).
- RFID and NFC identifiers, bound to an item by reading the next tag
  (`0007_rfid`).

## [0.3.0] - 2026-03-11

### Added

- Printed asset codes, generated by a database trigger
  (`0002_ninjaone_labels`).
- Label printing as an exact-size PDF with one page per label, after two
  earlier attempts using HTML page rules produced stray and oversized labels.
- Device management sync, matching on serial number and writing the asset code
  back into the device record (`0003_ninjaone_oauth`).

## [0.2.0] - 2026-02-24

### Added

- Global scan capture: a handheld reader is detected anywhere in the app by the
  speed of its keystrokes, with no field to focus first.
- Camera scanning on phones and tablets.
- Product lookup for unknown barcodes, cached by code.
- Single sign-on and Postgres-backed sessions.
- Browse, search and detail screens.

## [0.1.0] - 2026-02-12

### Added

- Initial schema: locations, items, identifiers, images and an event log
  (`0001_init`).
- Full-text and trigram search in Postgres.
- Item and location CRUD, and the React client shell.

[Unreleased]: https://github.com/wrr2216/bindex/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/wrr2216/bindex/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/wrr2216/bindex/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/wrr2216/bindex/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/wrr2216/bindex/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/wrr2216/bindex/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/wrr2216/bindex/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/wrr2216/bindex/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/wrr2216/bindex/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/wrr2216/bindex/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wrr2216/bindex/releases/tag/v0.1.0
