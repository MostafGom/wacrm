-- ============================================================
-- 000 — Supabase compatibility bootstrap for plain Postgres
--
-- Migrations 001+ were written for Supabase, which ships a set of
-- roles, schemas and defaults before the first user migration runs.
-- This file recreates the small subset those migrations rely on, so
-- they can be replayed unchanged against a stock Postgres 17 +
-- pgvector instance:
--
--   * roles     anon / authenticated / service_role (+ postgres if
--               the cluster's superuser has a different name)
--   * privileges Supabase's default table/sequence/function grants
--   * auth      auth.users (Supabase column names), auth.uid(),
--               auth.role()
--   * storage   storage.buckets / storage.objects / foldername() —
--               the app's storage driver records every object here so
--               the bucket policies in 008/016/020/023/043 keep
--               authorising uploads
--   * realtime  an empty `supabase_realtime` publication; 048 reads it
--               to decide which tables get NOTIFY triggers
--
-- Must run as a superuser (the migration runner connects with
-- MIGRATION_DATABASE_URL). Every statement is idempotent.
--
-- How a request maps onto these roles (see src/lib/db/tx.ts):
--   BEGIN;
--   SELECT set_config('role', 'authenticated', true),
--          set_config('request.jwt.claim.sub', '<user uuid>', true);
--   ... query ...
--   COMMIT;
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------
-- Roles
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;

  -- Migrations hand SECURITY DEFINER functions to `postgres` so they
  -- bypass RLS. On clusters whose superuser has another name, create
  -- an equivalent (non-superuser, BYPASSRLS) owner role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN BYPASSRLS;
  END IF;

  -- The login role the application connects as. NOINHERIT: it has no
  -- table privileges of its own, so a code path that forgets to switch
  -- role fails with "permission denied" instead of running privileged.
  -- The migration runner sets its password from APP_DB_PASSWORD.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wacrm_app') THEN
    CREATE ROLE wacrm_app LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO wacrm_app;

-- ------------------------------------------------------------
-- Default privileges (mirrors Supabase)
--
-- Supabase grants everything on public objects to the API roles and
-- lets RLS decide. Migrations rely on that — they never GRANT table
-- access explicitly (027 even REVOKEs from it).
-- ------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, postgres;

DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT ALL ON TABLES TO anon, authenticated, service_role, postgres',
    current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT ALL ON SEQUENCES TO anon, authenticated, service_role, postgres',
    current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, postgres',
    current_user);
END
$$;

-- ------------------------------------------------------------
-- auth schema
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;

-- Column names match Supabase's auth.users so migration 017's
-- backfill, the handle_new_user trigger and the Supabase import
-- script work unchanged.
CREATE TABLE IF NOT EXISTS auth.users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT,
  encrypted_password  TEXT,
  email_confirmed_at  TIMESTAMPTZ,
  raw_user_meta_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sign_in_at     TIMESTAMPTZ,
  banned_until        TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON auth.users (lower(email));

-- Only the server (service_role) and SECURITY DEFINER functions may
-- touch auth tables; the API roles get nothing.
REVOKE ALL ON auth.users FROM PUBLIC, anon, authenticated;
GRANT ALL ON auth.users TO service_role, postgres;

-- auth.uid(): the user id the server bound to this transaction.
-- Same GUC name as Supabase/PostgREST, so function bodies copied from
-- Supabase behave identically.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT current_user::text
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role, postgres;

-- ------------------------------------------------------------
-- storage schema
--
-- Metadata only — bytes live on disk or in S3 (src/lib/storage).
-- The upload route inserts into storage.objects AS THE USER, so the
-- folder-scoped policies from the bucket migrations do the
-- authorisation, exactly as on Supabase.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, postgres;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  public              BOOLEAN NOT NULL DEFAULT FALSE,
  file_size_limit     BIGINT,
  allowed_mime_types  TEXT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id   TEXT NOT NULL REFERENCES storage.buckets(id),
  name        TEXT NOT NULL,
  owner       UUID,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS buckets_read ON storage.buckets;
CREATE POLICY buckets_read ON storage.buckets FOR SELECT USING (true);

GRANT SELECT ON storage.buckets TO anon, authenticated;
GRANT ALL ON storage.buckets TO service_role, postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects
  TO anon, authenticated, service_role, postgres;

-- Path segments except the file name, as in Supabase.
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

GRANT EXECUTE ON FUNCTION storage.foldername(TEXT)
  TO anon, authenticated, service_role, postgres;

-- ------------------------------------------------------------
-- Realtime publication
--
-- Never replicated (no slot is created). It is the single list of
-- realtime tables: 001/009/010/024/027 add to it, and 048 attaches a
-- NOTIFY trigger to each member.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;
