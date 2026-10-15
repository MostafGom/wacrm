# Testing

There are three layers of tests:

| Layer | Command | What it needs |
|-------|---------|---------------|
| Unit | `npm test` | Nothing |
| Integration (repos, RLS, engines against real Postgres) | `npm run test:integration` | A Postgres 17 + pgvector at `TEST_DATABASE_URL` |
| End-to-end (real browser, whole stack) | `npm run e2e:up && npm run e2e` | Docker |

The end-to-end suite needs **no Meta developer app, no AI key and no
SMTP account**. A local stack points the app at fake services that
speak the same protocols.

## The end-to-end stack

`docker-compose.e2e.yml` layers onto `docker-compose.yml`, using dummy
secrets from `e2e/.env.e2e`:

| Service | URL on the host | Role |
|---------|-----------------|------|
| `app` | http://localhost:3000 | The production build of the app |
| `db`, `migrate`, `cron` | – | As in production; cron ticks every 5 s |
| `fakes` | http://localhost:4010 | Fake WhatsApp Cloud API, customer simulator, fake OpenAI/Anthropic, webhook receiver |
| `mailpit` | http://localhost:8025 | Catches every email the app sends (sign-up confirmation, resets, …) |

The app reaches the fakes through test-only environment switches, which
are off by default and documented in `.env.local.example`:

- `META_GRAPH_BASE_URL=http://fakes:4010/v21.0`
- `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`
- `WEBHOOK_ALLOWED_PRIVATE_HOSTS=fakes` and `AI_PROVIDER_ALLOWED_PRIVATE_HOSTS=fakes`, which open the SSRF guard for that one host
- `SMTP_URL=smtp://mailpit:1025`

When these are unset, production behaviour is unchanged, and unit tests
assert that.

```bash
npm run e2e:up      # fresh stack: down -v, then build and start (waits for healthy)
npm run e2e         # Playwright, all specs
npm run e2e -- e2e/specs/05-inbox.spec.ts          # one file
npm run e2e -- --ui                                 # interactive runner
npm run e2e:logs    # follow app + fakes logs
npm run e2e:down    # stop and delete volumes
```

After changing app code or the fakes, rebuild just that service:

```bash
docker compose -p wacrm-e2e --env-file e2e/.env.e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d --build app
```

### Failures

Playwright keeps a trace, a screenshot and a video for every failed
test in `test-results/`. It also writes an HTML report to
`playwright-report/`, which you open with `npx playwright show-report`.
Open a trace with `npx playwright show-trace test-results/<test>/trace.zip`.
The trace shows each step's DOM, console output and network calls.

Server-side errors show up in `npm run e2e:logs`.

## Trying it by hand: the phone simulator

```bash
npm run e2e:up
npm run e2e:seed
```

The seed signs up four users (owner, admin, agent, viewer, password
`Passw0rd!demo`) and confirms them through Mailpit. It connects the
default fake number `100000000000001` and syncs templates, then creates:

- tags, a custom field, 30 contacts
- a pipeline with deals
- a keyword automation and the `welcome_menu` flow
- an AI config against the fake provider, plus a knowledge document
- a few inbound conversations

Everything goes through the HTTP API, so seeding exercises the real code paths.

Then open the app and http://localhost:4010 side by side. The simulator
is a WhatsApp-style phone:

- Pick or create a customer and type a message. It reaches the app as a
  signed Meta webhook, and the inbox updates live.
- Messages the business sends appear on the phone. Buttons and lists are
  clickable, and tapping one sends an interactive reply.
- Attach a sample image, document or voice note; react to messages; reply
  with a quote.
- Hold delivery statuses, mark messages read or failed, and see the ticks
  change in the app.
- Side tabs show outbound webhook deliveries (with signature checks), the
  AI request log, the fake WABA's templates and the error-injection settings.

Special customer numbers:

| Number | Behaviour |
|--------|-----------|
| `+15550000999` | Accepted, then a `failed` status webhook (131026, undeliverable) |
| `+15550000998` | Rejected at send time (131030) |

A `bad-token` access token makes every Graph call fail with error 190.
New templates you submit are approved automatically about 1.5 s later.

## Writing an end-to-end spec

Specs live in `e2e/specs/NN-area.spec.ts`. Run them with 4 workers, in
any order. The rules:

- **Every file creates its own world.** Use `newOwner()` and
  `addMember(owner, role)` from `e2e/support/accounts.ts`. They sign up
  through the API and confirm through Mailpit.
  - Connect a fresh fake number with `connectWhatsApp(owner)`; every
    account gets its own phone-number id.
  - Use `randomCustomerPhone()` for customers.
  - Never rely on another file's data.
- **Drive the UI**, through `pageAs(browser, user)` → `{ context, page }`
  and accessible locators (`getByRole`, `getByLabel`, …). Use `api(user,
  …)` for setup and for checks the UI can't show.
- **Assert on the outside world.** Check what the fake Meta received with
  `fakes.waitForOutbound`, webhook deliveries with `fakes.waitForHooks`,
  and emails with `waitForAuthLink`.
- **No sleeps.** Background work (webhook processing, automations,
  statuses) is asynchronous, so poll with `expect.poll` or the
  `waitFor*` helpers. `runCron()` runs the cron endpoints once, instead
  of waiting for the sidecar.
- **Time travel** (a flow timeout, the 24-hour window): use `sql(...)` to
  backdate a timestamp. Use it only for things the app itself can't do.
- **Known gaps** in the product are `test.fixme(true, "GAP: …")`. Bugs
  awaiting a fix are `test.fixme(true, "BUG: …")`. Both are listed in
  [`testing/e2e-report.md`](testing/e2e-report.md).
