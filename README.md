# wacrm-without-supabase — CRM Template for WhatsApp on plain PostgreSQL

> Self-hostable CRM template for WhatsApp® — shared inbox, contacts,
> sales pipelines, broadcasts, and no-code automations. Fork it, brand
> it, host it.

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="900">
  </a>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/MostafGom/wacrm-without-supabase/actions/workflows/ci.yml/badge.svg)](https://github.com/MostafGom/wacrm-without-supabase/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Stars](https://img.shields.io/github/stars/MostafGom/wacrm-without-supabase?style=social)](https://github.com/MostafGom/wacrm-without-supabase/stargazers)

> **wacrm-without-supabase** is a fork of
> [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm) that runs on plain
> PostgreSQL — no Supabase. Auth, row-level
> security, file storage and realtime are built into the app, so the
> whole stack is `docker compose up`: one Postgres container and the
> app. See [Architecture](#architecture-standalone-postgres) below and
> [docs/self-hosting.md](./docs/self-hosting.md).

The upstream project's marketing site and docs live in a separate repo:
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)); they describe the original
Supabase-based setup. For this fork, follow the docs in this repo.

## What you get out of the box

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI or Anthropic key
  (stored encrypted; no per-seat AI fee, your data stays yours).
  One-click AI-drafted replies in the inbox, plus an optional
  auto-reply bot with a per-conversation cap and clean human handoff.
  Add a **knowledge base** (FAQs, policies, product docs) and it
  answers from your own content — hybrid retrieval (Postgres full-text,
  or semantic pgvector when an embeddings key is set).
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer. Every install
  is account-scoped, so one shared inbox can be staffed by a whole
  team. Solo use stays single-user with zero setup.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys —
  build your own automations on top of your CRM. See
  [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive your CRM from Claude, Cursor, and other AI
  assistants over the [Model Context Protocol](https://modelcontextprotocol.io).
  Read-only by default, opt-in writes. See [docs/mcp.md](./docs/mcp.md)
  (server in [`mcp-server/`](./mcp-server)).

## Why fork this?

This is a **template**, not a product. Forking means you get:

- **Full ownership** — your code, your database, your domain,
  your data. No SaaS lock-in, no seat pricing, no trust dance.
- **Full customisation** — add the fields your team needs, remove the
  modules you don't, redesign anything. The stack is boring on
  purpose (Next.js + PostgreSQL + Tailwind) so the learning curve is
  short.
- **Zero ops to start** — [Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST)
  Managed Node.js deploys a fork in a few clicks. No Docker, no
  Kubernetes, no infra team needed.
  ([See below ↓](#-deploy-on-hostinger-recommended))
- **Real security primitives** — token encryption (AES-256-GCM), RLS
  on every table, HMAC-verified webhooks, CSP, rate limiting, CI
  typecheck/build on every PR.

Not a framework. Not an SDK. A concrete, working CRM you can stand up
in an afternoon and make yours.

## Quick start

### Docker (everything included)

```bash
git clone https://github.com/MostafGom/wacrm-without-supabase.git
cd wacrm-without-supabase
cp .env.local.example .env.local   # set passwords, ENCRYPTION_KEY, Meta creds, PUBLIC_URL
docker compose --env-file .env.local up --build -d
```

Compose starts Postgres 17 (+pgvector), applies every migration, then
starts the app and a small scheduler for the cron endpoints. Open
<http://localhost:3000/signup> — the first account becomes the owner of
its workspace.

### Local development

```bash
npm install
cp .env.local.example .env.local
# a database to develop against:
docker run -d --name wacrm-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wacrm \
  -p 5432:5432 pgvector/pgvector:pg17
npm run db:migrate                 # uses MIGRATION_DATABASE_URL + APP_DB_PASSWORD
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

The UI ships in English, Korean, Brazilian Portuguese and Spanish — set
`NEXT_PUBLIC_APP_LOCALE` to `en`, `ko`, `pt` or `es` in `.env.local`
(catalogues live in `messages/`).

Prefer containers? See [docs/docker.md](./docs/docker.md) for the
Dockerfile + Docker Compose setup.

## 🚀 Deploy on Hostinger (recommended)

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="1000">
  </a>
</p>
<p align="center">
  <a href="https://wacrm.tech/docs/deployment-hostinger">
    <img src="https://img.shields.io/badge/Step--by--step_guide-wacrm.tech%2Fdocs-111?style=for-the-badge" alt="Step-by-step guide" height="44">
  </a>
</p>

**wacrm is built to run on [Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST).**
It's the path we test, document, and recommend — and the fastest way
to get a production-grade CRM live without owning a VPS or a
Kubernetes cluster.

### Why Hostinger?

| | |
|---|---|
| **One-click Git deploy** | Connect your fork, push to `main`, Hostinger builds and ships it. No SSH, no Docker, no CI to wire up — this repo's own `main` deploys this way. |
| **Managed Node.js** | Next.js 16 (App Router, server actions, ISR) runs out of the box on [Premium, Business, and Cloud](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST) shared plans. You don't manage Node versions, processes, or reverse proxies. |
| **Free SSL + free domain** | Automatic Let's Encrypt on your custom domain (or a free one included with annual plans). HTTPS is on by default — required for the WhatsApp Business webhook. |
| **Global CDN + LiteSpeed** | Static assets cached at the edge, dynamic routes served from LiteSpeed. Snappy dashboards out of the box, no Cloudflare setup required. |
| **Env vars + logs in hPanel** | Set `DATABASE_URL`, `WHATSAPP_*`, and `ENCRYPTION_KEY` from the panel — no `.env` on the server. Live application logs in the same UI. |
| **DDoS protection + daily backups** | Built-in, no add-ons. The webhook endpoint is a public target — having protection at the edge matters. |
| **Cheaper than a VPS** | Plans start at a few dollars a month — order-of-magnitude less than a comparable managed Node.js host, and the database is any PostgreSQL 17 with pgvector. |
| **24/7 human support** | Live chat support in 20+ languages — useful when your CRM is the thing your team relies on to talk to customers. |

### The 60-second version

1. **Fork** this repo on GitHub.
2. In **hPanel → Websites → Create**, pick **Node.js** and connect
   your fork.
3. Point `DATABASE_URL` at a PostgreSQL 17 + pgvector database, run
   `npm run db:migrate` against it once, and paste the remaining env
   vars into hPanel.
4. Push to `main`. Hostinger builds and serves it. Done.

Full walkthrough with screenshots:
**[wacrm.tech/docs/deployment-hostinger](https://wacrm.tech/docs/deployment-hostinger)**.

> _Note: wacrm is MIT-licensed and runs anywhere a long-running
> Node.js process and PostgreSQL do (a VPS with Docker, Railway,
> Hostinger...). Live updates use Server-Sent Events, so short-lived
> serverless functions are not a good fit._

## Documentation

Self-hosting this fork (database, auth, storage, realtime, migrating
off Supabase): **[docs/self-hosting.md](./docs/self-hosting.md)** and
[docs/docker.md](./docs/docker.md).

Upstream documentation — WhatsApp Business
API config, and production deploy — lives at
**[wacrm.tech/docs](https://wacrm.tech/docs)**
(source: [ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)).

Key pages:
- [Getting started](https://wacrm.tech/docs/getting-started)
- [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
- [Environment variables](https://wacrm.tech/docs/environment-variables)
- [Deploy on Hostinger](https://wacrm.tech/docs/deployment-hostinger)
- [Architecture](https://wacrm.tech/docs/architecture)
- [Troubleshooting](https://wacrm.tech/docs/troubleshooting)
- [WhatsApp connection troubleshooting](./docs/whatsapp-connection-troubleshooting.md)
  — what each "Save Configuration" error means, and the Meta code /
  trace id to quote to Meta support
- [Several WABAs on one deployment](./docs/multi-waba.md) — one Meta
  App or several; how `META_APP_SECRET` takes a comma-separated list
- [Auth emails](./docs/auth-emails.md) — optional SMTP for confirmation
  and password-reset emails, and how resets work without it

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — PostgreSQL 17 + pgvector, row-level security on every table.
- **Auth / storage / realtime** — built in (no external services).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Architecture (standalone Postgres)

```
browser ──► Next.js (Node runtime)
             ├─ route handlers    requireRole → repositories (Kysely) as the user
             ├─ /api/auth/*       sessions (HttpOnly cookie), scrypt passwords
             ├─ /api/storage/*    uploads → local disk or S3; public media route
             ├─ /api/realtime     Server-Sent Events  ◄── LISTEN wacrm_realtime
             └─ webhook / engines / crons / public API (service role)
                      │
                      ▼
             PostgreSQL 17 + pgvector
               roles: anon · authenticated · service_role (BYPASSRLS)
               auth.uid() = per-transaction setting → RLS policies
               NOTIFY triggers on realtime tables
```

- **RLS is kept, not rewritten.** The app connects as an unprivileged
  `wacrm_app` login role and switches to `authenticated` (with
  `auth.uid()` bound to the session user) for every transaction, so the
  158 policies from the original migrations still decide what each
  user can see. `db/migrations/000_supabase_compat.sql` recreates the
  roles, `auth` / `storage` schemas and defaults those migrations
  expected.
- **Data layer.** Typed Kysely repositories (`src/server/repos/`, types
  generated from the live schema with `npm run db:types`). Each one
  runs inside `asUser(userId, …)` or `asService(…)` and scopes by
  account explicitly; RLS is the second line of defence. Client
  components never touch the database: they call route handlers.
  Conventions: [docs/architecture/data-layer.md](./docs/architecture/data-layer.md).
- **Auth.** scrypt hashes (imported Supabase bcrypt hashes still work
  and are upgraded on login), database-backed sessions, single-use
  email / reset links, optional SMTP, owner- or CLI-generated reset links.
- **Storage.** Local disk (default) or any S3-compatible service;
  object metadata stays in `storage.objects` so bucket policies still
  authorise uploads.
- **Realtime.** Row triggers `pg_notify` changes; one LISTEN connection
  per server fans them out over SSE, filtered per account.

## Contributing

This is a template, not a collaborative product — the expected flow is
fork → customise → deploy, **not** upstream contribution. Bug reports
and security issues are welcome; feature PRs often belong in your fork
rather than here. Details in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`.github/SECURITY.md`](./.github/SECURITY.md).

## License

[MIT](./LICENSE). Fork it, brand it, host it.
