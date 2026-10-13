# Auth emails

Sign-in uses the app's own auth system: passwords in `auth.users` and
sessions in `auth.sessions` (see [self-hosting.md](./self-hosting.md)).
Three flows can send email:

| Flow | Link lands on | Valid for |
|------|---------------|-----------|
| Sign-up confirmation | `/auth/callback?type=signup_confirm` → `/dashboard` (or the invite page) | 24 h |
| Password reset ("Forgot password") | `/auth/callback?type=recovery` → `/reset-password` | 1 h |
| Email change (Settings → Profile) | `/auth/callback?type=email_change` → `/settings` | 24 h |

Every link is single-use. The database stores only the SHA-256 of the
token. `/auth/callback` consumes the token, signs the user in, and
redirects to a same-origin `next` path. Expired or reused links go to
`/login?error=link_expired`.

## With SMTP (optional)

```bash
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM="wacrm <no-reply@example.com>"
PUBLIC_URL=https://crm.example.com   # links point here
```

Any SMTP provider works, for example Postmark, SES, Mailgun, Resend's
SMTP endpoint, or your own server. Email text is localised with the
`Auth.email` catalogue in `messages/*.json`.

With SMTP configured:
- New accounts must confirm their email before they can sign in.
- "Forgot password" sends a reset link.
- An email change only applies after the new address confirms it.

## Without SMTP (default)

Nothing is emailed:
- **Sign-ups are active immediately.** The user is signed in straight
  after creating the account.
- **Email changes apply immediately.**
- **"Forgot password" tells the user to ask their workspace owner**
  instead of sending a link. A reset link can be created two ways:
  - **Owner, in the app:** Settings → Members → key icon next to a
    teammate. This shows a one-hour, single-use link to share with them.
  - **Operator, from the server** (also covers a locked-out owner):

    ```bash
    docker compose exec app node scripts/auth-cli.mjs reset-link someone@example.com
    ```

## Restricting sign-ups

Set `ALLOW_SIGNUPS=false` to close open registration. The first user of
a fresh install can always sign up, and so can anyone holding a valid
invite link (Settings → Members → Invite member).
