# End-to-end test report

This report covers the whole product: every page, form and role gate, run in a real browser against the full docker stack.

Meta, the AI providers and SMTP are replaced by local fakes; see [`../testing.md`](../testing.md). No real WhatsApp, OpenAI or email account was used.

**Result:** 304 tests in 20 files. Two consecutive full runs each gave **292 passed, 12 skipped, 0 failed**, with no flaky tests, in about 1.9 minutes at 4 workers. The 12 skipped tests are 11 known product gaps plus one test that needs a stack restart. They are listed below.

## Coverage by area

| Spec | Tests | Covers |
|------|------:|--------|
| `00-smoke` | 1 | Sign up, confirm by email, connect WhatsApp, receive and reply in the inbox |
| `01-auth` | 16 | Sign-up and confirmation, login and logout, wrong password, rate limit, forgot/reset (single-use links), change password and email, sign out everywhere, auth CLI `create-user`/`reset-link` |
| `02-team` | 51 | Invites for every role (new user, existing user, cross-team conflict), invite errors (used, revoked, expired, unknown), role changes, removal, owner reset links; a role matrix over 30 API endpoints and every UI gate |
| `03-whatsapp` | 22 | Connect, Meta errors, test, verify registration, webhook URL, media mirroring, token rotation, disconnect; templates: sync, validation, text / buttons / IMAGE-header submit (resumable upload), approve and reject webhooks, edit, delete |
| `04-contacts` | 22 | CRUD, phone validation, exact and similar duplicates, tags, custom fields, notes, CSV import as admin and as agent, search and pagination, bulk delete, send template, read-only viewer |
| `05-inbox` | 21 | Live inbound messages and unread counts. Sending: text, quoted reply, image, document, voice note, template, buttons and list, quick replies, reactions. Inbound media mirroring, location and interactive messages. Delivery ticks, failed and rejected sends, assignment, status changes, the 24-hour window, the contact sidebar, search and filters |
| `06-pipelines` | 15 | Default pipeline seeding, stages (add, rename, recolour, drag to reorder, delete rules), deals (create, edit, drag between stages, won, lost, reopen), analytics, currency, role gates |
| `07-broadcasts` | 14 | Audiences (tag with excludes, custom field, CSV), variables, image header, send, failures and retry, resume, replies, draft, CSV export, delete rules, role gates |
| `08a`–`08e` automations | 53 | Builder (create, edit, duplicate, toggle, delete, validation), logs page, starter templates, every trigger that fires, every step type, all four condition kinds, send_webhook, wait and wait_for_reply through cron |
| `09-flows` | 24 | The three starter templates; a walk-through of every node type, re-prompts, handoff, agent pause, timeout through cron, the runs page; editing on the canvas (add, connect, delete, validation, media upload) |
| `10-ai` | 10 | OpenAI-compatible, OpenAI and Anthropic providers; knowledge base and embeddings; playground; inbox draft; auto-reply with its cap; handoff, take over and resume; usage; role gates |
| `11-realtime` | 4 | Presence (online, away, offline), live assignment notifications, marking notifications read, live updates between two users |
| `12-settings` | 14 | Overview counts, profile and avatar, browser notifications, security, appearance, quick replies, fields and tags, default currency, API keys |
| `13-public-api` | 18 | Every `/api/v1` endpoint and its response shape, scopes, 401/403/404 handling, rate limiting, signed outbound webhooks, the MCP server over stdio |
| `14-dashboard` | 4 | Empty state, exact metrics from known data, 7/30/90-day ranges, account scoping |
| `15-system` | 15 | Health, auth redirects for every dashboard route, cron secret, cron sidecar, webhook verify handshake and signature checks |

## Bugs found and fixed

The suite exposed real bugs. Each fix has a regression test (unit or integration) as well as its e2e test.

| Area | Bug | Fix |
|------|-----|-----|
| WhatsApp | `POST`/`DELETE /api/whatsapp/config` only checked for a session, so any member could replace or disconnect the number | Admin-only, checked before any Meta call (`requireAdminAccount`) |
| WhatsApp | The settings page offered Save and Reset to agents and viewers (the server refused them) | Gated, with an "admins only" hint |
| WhatsApp | The "Verify with Meta" diagnostic vanished immediately, because the config reload cleared it | Reload first, then show the result |
| Templates | Submitting an IMAGE-header template could not fetch a sample from a private host, even when the operator allow-listed it | The header fetch honours `WEBHOOK_ALLOWED_PRIVATE_HOSTS` |
| Public API | A non-uuid `{id}` returned 500 (a failed Postgres cast) | 404 `not_found` on every `/api/v1/*/{id}` route |
| Broadcasts | "Retry failed" or resume on an image-header campaign failed every recipient, because the image URL was only held by the browser tab | Stored on the broadcast (migration 049) and resent by server-side passes |
| Broadcasts | The API deleted a campaign that was still sending | 409, matching the disabled button in the UI |
| Settings | Overview counts for tags and templates only counted rows the viewing admin had created | Counted account-wide |
| Contacts | The first click on Create was lost: the duplicate check on blur disabled the button mid-click | The submit button no longer waits on the check (the server still returns 409 for a duplicate) |
| Contacts | Import dialog plurals showed "8 row ready" and "Import 8 contact" (next-intl ignores `*_plural` keys) | ICU plural messages in all four locales |
| Contacts | Viewers saw enabled edit, delete, note, tag and send controls that only produced 403 toasts | Read-only for viewers |
| Pipelines | Opening `/pipelines` directly never created the default pipeline (the seed ran before auth resolved and was never retried) | Seeds once the account is known (admin+) |
| Pipelines | Deleting a stage and then closing the dialog left the deleted column on the board | Board refreshes when the dialog closes |
| Pipelines | "Manage Pipelines", deal editing and dragging were offered to roles the server refuses | Role-gated; the delete text now says deals are deleted rather than archived |
| Automations | Round-robin assignment always picked the same member (an unordered `LIMIT 1`) | A real rotation over owner, admin and agent members, with a cursor per step |
| Automations | A step that failed inside an If/Else branch left the run marked `success` | The run is marked failed and stops |
| Automations | The builder had no inputs for template variables, so templates were sent without parameters | One input per `{{n}}`, required on activation |
| Automations | `message_content` conditions demanded an operand that the engine never reads | Validation per condition subject; the operand input is hidden |
| Automations | The run log listed a branch's steps before the condition that chose the branch | Execution order |
| Flows | Starter flows matched "hi" as a substring, so "ship" and "this" started the welcome menu | Flows gain whole-word matching (shared with automations); the starter flows use it |
| Flows | Handoff notes kept the literal `{{vars.name}}` text | Interpolated, and shown on the runs page |
| AI | Reaching the auto-reply cap went silent instead of handing off, as the settings text promises | Hands off to the configured agent with a summary |
| Inbox | At 1280px with the contact panel open, the contact name in the thread header shrank to zero width | Header layout reworked |
| Docker | On a fresh volume, `migrate` could start before Postgres accepted TCP connections (the healthcheck used the Unix socket) | `pg_isready -h 127.0.0.1` |

## Known gaps (not implemented in the product)

These are `test.fixme(true, "GAP: …")` stubs. The product itself does not offer these features.

- **Automations:**
  - The `conversation_assigned` trigger is offered in the builder, but nothing ever dispatches it.
  - The `time_based` trigger saves a schedule, but no scheduler ever fires it.
  - `new_contact_created` only fires for contacts created by an inbound WhatsApp message, not for contacts added in the UI, imported or created through the API.
  - `wait_for_reply` has no timeout branch. When it expires, the run simply stops.
- **Flows:** the `manual` trigger has no way to start a run.
- **Broadcasts:**
  - There is no scheduling.
  - A draft can't be reopened, edited or sent.
- **Contacts:**
  - Tags can't be renamed.
  - Custom fields are free text only.
- **Inbox:** there are no "mine" or "unassigned" filters.
- **Public API:** there are no tags or deals endpoints.
- **Auth:** the `ALLOW_SIGNUPS=false` path needs an app restart, so it isn't covered here. Unit tests cover it.

## Lower-severity observations (not fixed)

- Inbound messages are stamped with WhatsApp's whole-second timestamp. Two messages in the same second can therefore sort either way, both in the AI context and in a thread.
- A customer who taps a flow button within about 40 ms of the prompt, before the run has saved its position, gets matched against the start node.
- On the flow runs page, "ran for …" shows the time since the run ended, not how long it ran.
- Automation `send_webhook` requests are never signed, and the builder has no field for custom headers (the API supports them).
- `docs/public-api.md` shows contact phones as `+1415…`, but the API returns digits only.
- Sign-up and reset require at least 6 password characters, while Settings → Password requires 8 (checked client-side only).
