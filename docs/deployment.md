# Deployment

## What you are running

One Node process and one Postgres database. The process serves the API and the
built client from the same origin on a single port, and applies any pending
migrations on boot.

It speaks plain HTTP. Put a reverse proxy in front of it for TLS. It sets
`trust proxy` for exactly one hop, which is what a container behind a proxy
sees, so session cookies are marked secure and logged client addresses are the
real ones.

## Docker Compose

The shipped [`docker-compose.yml`](../docker-compose.yml) is the intended path.
It reads the `.env` file beside it, so there is no list of variables duplicated
in the compose file to keep in step.

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
docker compose logs -f app
```

To use a database you already run, set `DATABASE_URL` in `.env` and remove the
`db` service and the `depends_on` block.

## Reverse proxy

Bindex needs the usual forwarded headers and nothing unusual. Two things matter:

- `APP_BASE_URL` must be the public URL, because redirect URIs are built from
  it.
- Uploads of item photos go through the proxy, so allow a body size of at least
  10 MB if your proxy defaults lower.

### Caddy

```
inventory.example.com {
    reverse_proxy localhost:3000
}
```

### nginx

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

### Traefik

Standard HTTP router on port 3000. No special middleware is needed.

## Health checks

`GET /healthz` answers `{"ok":true}` with no authentication, no session and no
database access. It reports that the process is alive, not that the database is
reachable, which is what you want from a liveness probe: a database outage
should not cause an orchestrator to restart a healthy process in a loop.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Migrations run on boot, in filename order, each in its own transaction. A failed
migration rolls itself back and the process exits rather than serving against a
half-migrated schema.

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
