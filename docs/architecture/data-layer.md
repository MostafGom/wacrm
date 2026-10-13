# Data layer

All data access goes through typed **Kysely** queries in **repositories**.
Each repository runs inside a role-scoped transaction. Client
components never query the database. They call route handlers.

```
client component ──fetch──► route handler ──► service / repo ──► Postgres
   apiRequest()             requireRole()      asUser(db => …)     RLS + roles
                                               asService(db => …)
engines / webhook / crons / v1 API ─────────► repo  (asService)
```

## Building blocks

| Module | Purpose |
|---|---|
| `src/server/db/index.ts` | `asUser(userId, fn)`, `asService(fn)`, `asAnon(fn)`, `sql`, type `Db` (a Kysely transaction) |
| `src/server/db/schema.gen.ts` | Generated table types (`npm run db:types`). Never edit by hand. |
| `src/server/db/errors.ts` | `isUniqueViolation`, `isPermissionDenied`, `pgCode`, … |
| `src/server/repos/<area>.ts` | Repository functions: `fn(db: Db, accountId, …)` |
| `src/lib/auth/account.ts` | `requireRole(min)` / `getCurrentAccount()` → `{ userId, accountId, role, account }`; `toErrorResponse`; `HttpError` |
| `src/lib/auth/api-context.ts` | `requireApiKey(request, scope)` for `/api/v1` |
| `src/lib/http/client.ts` | Browser `apiRequest<T>(path, { method, query, body })` → `{ data, error }` |
| `src/lib/realtime/client.ts` | Browser `createChannel(name).on('postgres_changes', …).subscribe()`; `channel.unsubscribe()` |
| `src/lib/storage/server.ts` / `client.ts` | `adminStorage()`, `userStorage(userId)` / `getBrowserStorage()` |
| `src/lib/auth/client.ts` | Browser `getAuthClient()` (sign in/out, session, password) |

Generated types use the same shapes the UI has always received:
- timestamps are ISO strings (`2024-01-02T03:04:05+00:00`)
- `date` is `YYYY-MM-DD`
- `numeric` and `bigint` are numbers
- `jsonb` is parsed JSON

## Rules

1. **Repositories take a `Db` as their first argument** and never open
   transactions themselves. The caller picks the boundary:

   ```ts
   const tags = await asUser(ctx.userId, (db) => listTags(db, ctx.accountId))
   ```

   Several calls that must commit together go in one `asUser` / `asService`
   callback.

2. **Scope explicitly.** Every repository query on tenant data filters by
   `account_id` (or joins to something that does), even under `asUser`.
   RLS is the second line of defense, not the only one. Under
   `asService`, RLS is off, so explicit scoping is mandatory.

3. **No network I/O inside a transaction.** Call Meta or AI providers
   first, then write. A transaction holds a pooled connection.

4. **Return only what the caller needs.** Select explicit columns where
   the client doesn't need the whole row. Never return secrets
   (`access_token`, `api_key`, `secret`, `key_hash`) to the browser.

5. **Embedded relations:** use `jsonObjectFrom` / `jsonArrayFrom` from
   `kysely/helpers/postgres`, and keep the result shape identical to
   what the UI already expects. For example `CONVERSATION_SELECT`
   produced `{ …conversation, contact: { …, contact_tags: [{ tags }] } }`.

6. **SECURITY DEFINER RPCs** stay in SQL. Call them with
   ``sql`SELECT public.fn(${a}, ${b})`.execute(db)`` from a repository.

7. **Route handlers** follow the existing style:

   ```ts
   export async function GET() {
     try {
       const ctx = await requireRole('viewer')
       const rows = await asUser(ctx.userId, (db) => repo.list(db, ctx.accountId))
       return NextResponse.json({ rows })
     } catch (err) {
       return toErrorResponse(err)
     }
   }
   ```

   - Throw `HttpError(status, translatedMessage)` for 4xx results.
   - Reuse existing i18n keys (`getT('Api.common')` etc.).
   - Keep role gates consistent with the RLS policy for the table:
     viewer reads, agent writes operational data, admin writes settings.
   - Mutations validate their body by hand. `zod` is not a dependency.

8. **Client components** replace `supabase.from(...)` with
   `apiRequest` calls to a route handler. Keep the UI behavior,
   optimistic updates and toasts as they were. Realtime subscriptions
   use `createChannel`.

9. **Tests:**
   - **Unit tests** mock the repository modules (`vi.mock('@/server/repos/x')`)
     and `@/server/db` (`asUser`/`asService` just call `fn({})`). See
     `src/lib/auth/account.test.ts`.
   - **Repositories** get an integration test (`*.int.test.ts`) against
     real Postgres. See `src/server/repos/notifications.int.test.ts`. Run with:

     ```bash
     TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres \
     TEST_DB_NAME=wacrm_it_<area> npm run test:integration -- src/server/repos/<area>
     ```

## Regenerating types

After adding a migration:

```bash
npm run db:migrate
npm run db:types     # needs a superuser URL in MIGRATION_DATABASE_URL
```
