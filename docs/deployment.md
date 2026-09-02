# Deployment

## What you are running

One Node process and one Postgres database. The process serves the API and the
built client from the same origin on a single port, and applies any pending
migrations on boot.

It speaks plain HTTP. Something in front of it has to terminate TLS. It sets
`trust proxy` for exactly one hop, which is what a container behind a proxy
sees, so session cookies are marked secure and logged client addresses are the
real ones.

Two supported paths below. Take [Docker Compose](#docker-compose) if you manage
your own server and proxy, or [Coolify](#coolify) if you want a web interface
that handles the proxy, certificates and redeploys for you. Anything else that
can run a container works too; there is nothing unusual about this image.

## Docker Compose

Uses [Docker Compose](https://github.com/docker/compose) on top of the
[Docker Engine](https://github.com/moby/moby). The shipped
[`docker-compose.yml`](../docker-compose.yml) brings up the app and its database
together and reads the `.env` file beside it, so there is no list of variables
duplicated in the compose file to keep in step.

```bash
git clone https://github.com/wrr2216/bindex.git
cd bindex
cp .env.example .env
$EDITOR .env          # set SESSION_SECRET and APP_BASE_URL
docker compose up -d
docker compose logs -f app
```

`SESSION_SECRET` is the only value with no usable default:

```bash
openssl rand -hex 32
```

To use a database you already run, set `DATABASE_URL` in `.env`, then delete the
`db` service and the `depends_on` block from the compose file.

### Reverse proxy

Bindex needs the usual forwarded headers and nothing unusual. Two things matter:

- `APP_BASE_URL` must be the public URL, because redirect URIs are built from
  it.
- Item photos are uploaded through the proxy, so allow a body size of at least
  10 MB if yours defaults lower.

#### Caddy

```
inventory.example.com {
    reverse_proxy localhost:3000
}
```

#### nginx

```nginx
server {
    server_name inventory.example.com;
    listen 443 ssl;

    client_max_body_size 10m;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

#### Traefik

A standard HTTP router on port 3000. No special middleware is needed.

## Coolify

[Coolify](https://github.com/coollabsio/coolify) is a self-hosted platform that
gives you a web interface over your own server, and handles the reverse proxy,
certificates and redeploy-on-push. It suits this application well, because it
removes the two fiddly parts of the manual path: the proxy configuration and
renewing certificates.

Two ways to run Bindex on it. The compose route builds from source and gives you
redeploy on push. The image route pulls a pre-built multi-architecture image and
starts in seconds.

### From the repository, with Docker Compose

Create a new resource, choose **Docker Compose** as the build pack, and point it
at `https://github.com/wrr2216/bindex` with `docker-compose.yml` as the compose
file. Coolify reads the file, brings up both services, and puts them on their
own network.

### From the pre-built image

Create a new resource and choose **Docker Image**:

```
ghcr.io/wrr2216/bindex:latest
```

This skips the build entirely. You supply Postgres yourself, either as a Coolify
database resource or an existing server, and set `DATABASE_URL` to point at it.
Pin to a major tag such as `:1` rather than `:latest` if you would rather
control when a new version lands.

### Removing the published port

This is the one change worth making. The compose file publishes port 3000 on the
host so that a plain `docker compose up` works out of the box:

```yaml
    ports:
      - "${APP_PORT:-3000}:3000"
```

Under Coolify, a published port bypasses the proxy and exposes the application
on the host directly, which is almost never what you want. Delete those two
lines, or set `APP_PORT` to a port you have firewalled, and let the proxy do the
routing.

### Domain and certificates

Set the domain on the **app** service, including the container port:

```
https://inventory.example.com:3000
```

The port tells Coolify which port inside the container to route to. The service
stays reachable on the normal 80 and 443 outside. Coolify requests and renews
the certificate.

Then set `APP_BASE_URL` to the same public URL, without the port:

```
APP_BASE_URL=https://inventory.example.com
```

Getting this wrong is the most likely thing to bite you: sign-in redirects and
the NFC tag URLs shown on item pages are all built from `APP_BASE_URL`, so if it
disagrees with the real address, single sign-on fails and printed tag URLs point
somewhere useless.

### Environment variables

Set these in the Coolify UI rather than committing a `.env` file.
[`.env.example`](../.env.example) is the reference for what exists, and
[configuration.md](configuration.md) explains each one.

Coolify can generate secrets for you with its own variables, which saves
inventing them by hand:

| Variable | Generates |
| --- | --- |
| `SERVICE_PASSWORD_64_SESSION` | A 64-character random string, for `SESSION_SECRET` |
| `SERVICE_PASSWORD_POSTGRES` | A random database password |
| `SERVICE_FQDN_APP` | The generated fully qualified domain name |
| `SERVICE_URL_APP` | The full URL, useful for `APP_BASE_URL` |

The generated values are stable across redeploys and editable in the interface.
Note that changing `SESSION_SECRET` later signs everyone out, which is also how
you revoke every session at once.

## Health checks

`GET /healthz` answers `{"ok":true}` with no authentication, no session and no
database access. It reports that the process is alive, not that the database is
reachable, which is what you want from a liveness probe: a database outage
should not cause an orchestrator to restart a healthy process in a loop.

The compose file already declares a health check against it, so Coolify and any
other orchestrator can tell a deploy that came up from one that is failing to
start and quietly serving errors.

## Upgrading

Migrations run on boot, in filename order, each in its own transaction. A failed
migration rolls itself back and the process exits rather than serving against a
half-migrated schema.

With Docker Compose:

```bash
docker compose pull
docker compose up -d
```

With Coolify, press Redeploy, or let it redeploy automatically on push if you
deployed from the repository.

Take a backup before a major version upgrade. Migrations are written to be safe
to re-run, but restoring from a file is faster than reasoning about a schema at
three in the morning.

## Backups

Two layers, and you want both.

**Database dump.** The complete picture, including accounts, integration tokens
and uploaded photo bytes.

```bash
docker compose exec -T db pg_dump -U bindex bindex | gzip > bindex-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c bindex-2026-08-31.sql.gz | docker compose exec -T db psql -U bindex bindex
```

Coolify can run scheduled backups of a database resource to local storage or an
S3 bucket. If you deployed the bundled compose file, the database is part of the
stack rather than a separate resource, so either run the dump above on a cron
job or split Postgres out into its own Coolify database resource to get the
managed backups.

**Application snapshot.** Settings offers a JSON export of the inventory data:
items, identifiers, images, locations, groups, assignees and history. It leaves
out accounts, integration tokens and caches on purpose, because a snapshot file
travels and secrets should not. It is the right tool for moving data between
instances or recovering from a bad bulk edit; it is not a substitute for a
database dump.

Restoring a snapshot replaces all current inventory data and asks for
confirmation first.

## Scaling

A single process handles far more than most deployments need; the work is
almost entirely Postgres queries.

If you do run several replicas:

- Sessions live in Postgres, so any replica can serve any request.
- Set `DATABASE_POOL_MAX` so that replicas multiplied by pool size stays
  comfortably below the database's `max_connections`.
- Run background sync on one replica only. Set `NINJAONE_SYNC_INTERVAL_MIN=0`
  and `REGISTRAR_SYNC_INTERVAL_MIN=0` on the others, or two replicas will sync
  the same devices at the same time.
- The live reader feed is held in memory per process. A reader bridge must reach
  the same replica the browser polls, so either pin it or run the audit against
  a single instance.

## Resource use

Idle, the container sits around 120 MB of resident memory. Rendering a batch of
labels is the only operation that is meaningfully CPU-bound, because it
rasterises barcodes. A 1 vCPU, 1 GB instance is comfortable for a few thousand
items.

Postgres wants more memory than the app does once you pass tens of thousands of
items, because the trigram indexes on names and model numbers are what make
fuzzy search fast.
