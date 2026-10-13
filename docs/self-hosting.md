# Self-hosting on plain PostgreSQL

This fork runs without Supabase. The upstream project used Supabase for
the database (through PostgREST), auth, file storage and realtime. All
four are now part of the app, so the only infrastructure is **one
PostgreSQL 17 database with pgvector** and **one long-running Node.js
process**.

- Fastest path: [docker.md](./docker.md) (`docker compose up`).
- Auth email setup: [auth-emails.md](./auth-emails.md).

---

## How the pieces map

| Supabase feature | Replacement in this repo |
|---|---|
| Postgres + `auth.uid()` RLS | Same migrations, plus `db/migrations/000_supabase_compat.sql` (roles, `auth`/`storage` schemas, default privileges) |
| PostgREST + supabase-js | Typed Kysely repositories in `src/server/repos/` (types generated from the schema, `npm run db:types`). Client components call route handlers; see [architecture/data-layer.md](./architecture/data-layer.md) |
| Supabase Auth (GoTrue) | `src/lib/auth/`: scrypt passwords, sessions table + HttpOnly cookie, single-use links, optional SMTP. Routes: `/api/auth/*` |
| Storage buckets | `src/lib/storage/`: local disk or S3 driver. Metadata stays in `storage.objects`. Routes: `/api/storage/*` |
| Realtime `postgres_changes` | `db/migrations/048`: NOTIFY triggers. `src/lib/realtime/` serves them over SSE at `/api/realtime` |
| Service-role key | Postgres role `service_role` (BYPASSRLS), used through `asService()` |
| Supabase CLI migrations | `scripts/migrate.mjs` (`npm run db:migrate`) |

## Security model

1. **Login role.** The app connects as `wacrm_app`. This role is
   `NOINHERIT` and has no table privileges of its own.
2. **Per-transaction role switch.** Every query runs inside a
   transaction that first calls
   `set_config('role', 'authenticated' | 'anon' | 'service_role', true)`
   and `set_config('request.jwt.claim.sub', <user id>, true)`. Both
   settings are transaction-local, so pooled connections never leak an
   identity.
3. **RLS unchanged.** `auth.uid()` reads that setting, so the RLS
   policies from the original migrations apply unchanged. There are 158
   of them: account membership, role ranks, storage folders.
4. **No browser database access.** Client components only call route
   handlers. Each handler checks the session and role (`requireRole`)
   and runs repository queries under `asUser`. Those queries filter by
   account explicitly, and RLS enforces the same rules underneath.
5. **Service role.** Webhooks, engines, crons and the public API run as
   `service_role` and scope every query by `account_id`, as before.

## Requirements

- PostgreSQL 17 with the `vector` extension (the `pgvector/pgvector:pg17`
  image). Other 15+ versions should work but are not tested.
- **A superuser connection for migrations and imports.** It creates
  roles, BYPASSRLS and default privileges. Managed databases without
  superuser access are not supported.
- **A long-running Node 20+ process.** SSE streams and the LISTEN
  connection need it. Serverless platforms that cut responses short
  will break live updates.
- **Publicly reachable HTTPS (`PUBLIC_URL`)** for the Meta webhook and
  outbound media.

## Without Docker

```bash
npm ci
cp .env.local.example .env.local      # set DATABASE_URL, MIGRATION_DATABASE_URL, APP_DB_PASSWORD, ...
npm run db:migrate
npm run build && npm start
```

Schedule the crons (every minute is fine), for example with systemd
timers or crontab:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.example.com/api/automations/cron
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.example.com/api/flows/cron
```

## Migrating an existing Supabase deployment

`scripts/import-supabase.mjs` copies everything from the Supabase
project into the new database.

**What it copies:**
- Users, with their passwords. Supabase's bcrypt hashes are verified
  as-is and upgraded to scrypt on first login.
- All `public` tables.
- Storage metadata and the files themselves.
- Stored Supabase media URLs, which it rewrites to point at this
  deployment.

**Steps:**

1. Create and migrate the target database:

   ```bash
   npm ci
   MIGRATION_DATABASE_URL=postgres://postgres:...@localhost:5432/wacrm \
     APP_DB_PASSWORD=... npm run db:migrate
   ```

2. Run the import. Use Supabase's **direct** connection string from
   Project Settings → Database, not the pooler:

   ```bash
   SOURCE_DATABASE_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' \
   SUPABASE_URL=https://<ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=... \
   MIGRATION_DATABASE_URL=postgres://postgres:...@localhost:5432/wacrm \
   PUBLIC_URL=https://crm.example.com \
   STORAGE_DIR=/path/to/storage-volume \
   node scripts/import-supabase.mjs
   ```

   Options:
   - `--dry-run` rolls everything back.
   - `--skip-files` copies rows only.
   - `--files-only` resumes or retries the file download.
   - `--force` wipes a non-empty target first.

3. Deploy with the **same `ENCRYPTION_KEY`** as before. WhatsApp
   tokens, AI keys and webhook secrets are encrypted with it.

4. Users sign in again, because sessions aren't migrated. If the domain
   changed, update the webhook URL in the Meta app dashboard.

## Tests

```bash
npm test                     # unit tests (no database)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npm run test:integration   # real Postgres: repositories, RLS, auth, storage, realtime
```

`TEST_DATABASE_URL` must be a superuser connection. The tests create and
use a separate `wacrm_it` database.
