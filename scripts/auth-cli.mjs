#!/usr/bin/env node
// ============================================================
// Operator CLI for the built-in auth — for installs without SMTP,
// or when the owner themselves is locked out.
//
//   node scripts/auth-cli.mjs reset-link <email>
//       print a single-use, 1-hour password-reset link
//   node scripts/auth-cli.mjs create-user <email> <password> [full name]
//       create a confirmed user (gets their own workspace, as owner)
//   node scripts/auth-cli.mjs list-users
//
// In docker-compose:  docker compose exec app node scripts/auth-cli.mjs ...
//
// Env: DATABASE_URL (the app role is enough) or MIGRATION_DATABASE_URL,
//      PUBLIC_URL for the link's base URL.
//
// Hash / token formats must match src/lib/auth/{password,session}.ts.
// ============================================================

import { createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(scryptCb);

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const base = (process.env.PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$15$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function asService(client, fn) {
  await client.query("BEGIN");
  try {
    // The app role can only act through service_role (NOINHERIT); a
    // superuser connection is unaffected by this.
    await client.query("SELECT set_config('role', 'service_role', true)");
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

const [command, ...args] = process.argv.slice(2);
const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  if (command === "reset-link") {
    const email = (args[0] ?? "").trim().toLowerCase();
    if (!email) throw new Error("usage: reset-link <email>");
    const link = await asService(client, async () => {
      const u = await client.query("SELECT id FROM auth.users WHERE lower(email) = $1", [email]);
      if (!u.rows[0]) throw new Error(`no user with email ${email}`);
      const token = randomBytes(32).toString("base64url");
      await client.query("DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND type = 'recovery'", [u.rows[0].id]);
      await client.query(
        `INSERT INTO auth.one_time_tokens (user_id, type, token_hash, expires_at)
         VALUES ($1, 'recovery', $2, now() + interval '1 hour')`,
        [u.rows[0].id, createHash("sha256").update(token).digest()],
      );
      const l = new URL("/auth/callback", base);
      l.searchParams.set("type", "recovery");
      l.searchParams.set("token", token);
      l.searchParams.set("next", "/reset-password");
      return l.toString();
    });
    console.log(link);
  } else if (command === "create-user") {
    const [emailRaw, password, ...nameParts] = args;
    const email = (emailRaw ?? "").trim().toLowerCase();
    if (!email || !password) throw new Error("usage: create-user <email> <password> [full name]");
    if (password.length < 6) throw new Error("password must be at least 6 characters");
    const hash = await hashPassword(password);
    const id = await asService(client, async () => {
      const r = await client.query(
        `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
         VALUES ($1, $2, $3::jsonb, now()) RETURNING id`,
        [email, hash, JSON.stringify({ full_name: nameParts.join(" ") })],
      );
      return r.rows[0].id;
    });
    console.log(`created ${email} (${id})`);
  } else if (command === "list-users") {
    const rows = await asService(client, async () =>
      (
        await client.query(
          `SELECT u.email, p.account_role, u.email_confirmed_at IS NOT NULL AS confirmed, u.last_sign_in_at
             FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id ORDER BY u.created_at`,
        )
      ).rows,
    );
    console.table(rows);
  } else {
    console.log("commands: reset-link <email> | create-user <email> <password> [name] | list-users");
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await client.end();
}
