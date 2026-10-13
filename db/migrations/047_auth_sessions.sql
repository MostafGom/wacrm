-- ============================================================
-- 047 — Built-in authentication: sessions + one-time tokens
--
-- Replaces Supabase Auth's internal tables. Only the server (as
-- service_role) reads or writes these; the API roles get nothing.
--
-- Tokens are never stored in clear: the cookie / emailed link carries
-- a random 32-byte token, the row stores its SHA-256.
-- ============================================================

CREATE TABLE IF NOT EXISTS auth.sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash    BYTEA NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON auth.sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('signup_confirm', 'recovery', 'email_change')),
  token_hash   BYTEA NOT NULL UNIQUE,
  -- email_change: the address being confirmed.
  new_email    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS one_time_tokens_user_type_idx
  ON auth.one_time_tokens (user_id, type);

REVOKE ALL ON auth.sessions, auth.one_time_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON auth.sessions, auth.one_time_tokens TO service_role, postgres;

-- Keep profiles.email in step with auth.users.email (Supabase did this
-- implicitly through its own email-change flow + app code).
CREATE OR REPLACE FUNCTION auth.sync_profile_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = COALESCE(NEW.email, '') WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION auth.sync_profile_email() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.sync_profile_email();
