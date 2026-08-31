# Contributing

## Getting set up

You need Node 20 or newer, pnpm, and Docker for the database.

```bash
pnpm install
pnpm db:up
cp .env.example .env
pnpm migrate
pnpm dev
```

Set `AUTH_MODE=trusted` in `.env` while working on something other than
authentication, and you will not have to sign in on every restart.

`pnpm typecheck` checks both halves. It runs on every pull request, along with a
production build.

## How the pieces fit together

```
server/src/routes/      HTTP: parse, validate, delegate. No business logic.
server/src/services/    Business logic and database access.
server/src/lib/         Small shared utilities with no domain knowledge.
server/migrations/      Numbered SQL, applied in order on boot.
client/src/pages/       One screen each.
client/src/components/  Shared UI.
client/src/config/      Instance configuration: names, vocabulary, features.
client/src/scan/        Reader and camera capture, and the overlay a scan opens.
```

A few decisions worth knowing before you change something:

- **Postgres does the searching.** A generated `tsvector` column handles full
  text and trigram indexes handle fuzzy name matching. There is no search
  service to run.
- **Migrations are append-only.** Add a new numbered file rather than editing an
  old one; the runner records which have been applied by filename.
- **Nothing user-visible is hardcoded.** Names of concepts come from the
  instance configuration, so use `useTerms()` in the client rather than writing
  "Company" into a label. Feature switches gate whole screens.
- **Optional integrations degrade quietly.** An unconfigured integration reports
  that it is unavailable and disappears from the interface. It never throws.

## Adding a migration

Create `server/migrations/00NN_short_name.sql`. Write it so it can run against a
database that already has the change, using `IF NOT EXISTS` and
`CREATE OR REPLACE`, and update `server/src/db/schema.ts` to match. Each file
runs in its own transaction and is rolled back on failure.

## Style

Match the code around you. Beyond that:

- Comments explain why, not what. If a line needs a comment to say what it does,
  the line is usually the thing to fix.
- Errors that reach a person say what to do about it.
- Log events have stable dotted names (`enrich.result`), with the variable parts
  in the metadata object, so a log line stays greppable across releases.

## Pull requests

Describe what changes and why. Say what you tested. Small pull requests get
read sooner than large ones.

## Licensing of contributions

Bindex is licensed under the GNU Affero General Public License v3.0. By opening
a pull request you agree that your contribution is licensed the same way. There
is no contributor licence agreement to sign.

## Reporting a security issue

Please do not open a public issue for a security problem. See
[SECURITY.md](SECURITY.md).
