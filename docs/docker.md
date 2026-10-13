# Running with Docker

`docker-compose.yml` runs the whole stack. Nothing external is needed
except your WhatsApp Business (Meta) credentials.

| Service   | What it does |
|-----------|--------------|
| `db`      | PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17`), data in the `pgdata` volume |
| `migrate` | One-shot job: applies `db/migrations/*.sql`, sets the app role's password, exits |
| `app`     | The Next.js server (standalone build, non-root), uploads in the `storage` volume |
| `cron`    | Calls `/api/automations/cron` and `/api/flows/cron` every `CRON_INTERVAL` seconds |

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

   Required for Compose:
   - `POSTGRES_PASSWORD` and `APP_DB_PASSWORD`. Both must be URL-safe,
     for example the output of `openssl rand -hex 24`.
   - `ENCRYPTION_KEY`
   - `META_APP_SECRET`
   - `PUBLIC_URL`
   - `AUTOMATION_CRON_SECRET`, if you use Wait steps or flows.

   You can leave `DATABASE_URL` and `MIGRATION_DATABASE_URL` as they
   are: Compose overrides them with the in-network `db` host.

2. Build and start. The `--env-file` flag is required because Compose
   only reads `.env` by default for `${VAR}` substitution, and this
   project keeps its config in `.env.local`:

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. Open [http://localhost:3000/signup](http://localhost:3000/signup) and
   create the first account. It becomes the owner of its workspace. To
   publish on another port, set `HOST_PORT=8080` in `.env.local`.

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container. Compose pins it to
> 3000 so that the port mapping and the healthcheck stay in sync.

## Public URL and HTTPS

Meta has to reach two things over HTTPS:
- the webhook (`/api/whatsapp/webhook`)
- the media URLs for files you send (`/api/storage/public/...`)

Put the app behind a TLS-terminating reverse proxy, such as Caddy,
nginx, Traefik or a Cloudflare Tunnel. Then set `PUBLIC_URL` to that
public origin.

The live inbox uses Server-Sent Events (`/api/realtime`). If your proxy
buffers responses, turn buffering off for that path. The app already
sends `X-Accel-Buffering: no` for nginx.

## Build-time vs runtime variables

- Only `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_LOCALE` (`en | ko |
  pt | es`) are inlined at build time. If you change them, rebuild.
- Everything else is read at runtime and never baked into the image:
  - the database URLs
  - `ENCRYPTION_KEY` and `META_APP_SECRET`
  - SMTP settings
  - storage settings
  - `PUBLIC_URL`

## Day-2 operations

```bash
# migration status / re-run (idempotent)
docker compose --env-file .env.local run --rm migrate node scripts/migrate.mjs status

# password reset link without SMTP, list users, create a user
docker compose exec app node scripts/auth-cli.mjs reset-link someone@example.com
docker compose exec app node scripts/auth-cli.mjs list-users
docker compose exec app node scripts/auth-cli.mjs create-user me@example.com 's3cret!' "My Name"

# backup
docker compose exec db pg_dump -U postgres -Fc wacrm > wacrm-$(date +%F).dump
docker run --rm -v wacrm_storage:/data -v "$PWD":/backup alpine \
  tar czf /backup/storage-$(date +%F).tgz -C /data .
```

## Plain Docker (no Compose)

```bash
docker build -t wacrm .
# run migrations once (MIGRATION_DATABASE_URL = superuser connection)
docker run --rm --env-file .env.local wacrm node scripts/migrate.mjs
docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 \
  -v wacrm-storage:/data/storage wacrm
```

## Notes

- **Received attachments are copied into storage.** Meta deletes media
  about 30 days after it arrives, and the copy is the only thing that
  outlives that.
  - The `storage` volume (or S3 bucket) grows with inbound volume.
  - Files over 16 MB are never copied.
  - To turn copying off per account, go to Settings → WhatsApp →
    Attachment Storage.
- **The cron service needs `AUTOMATION_CRON_SECRET`.** Without it both
  endpoints answer 503 and nothing is scheduled. Wait steps and flow
  timeouts depend on the cron.
- **Use S3 instead of the local volume** by setting
  `STORAGE_DRIVER=s3` plus the `S3_*` variables (see
  `.env.local.example`).
