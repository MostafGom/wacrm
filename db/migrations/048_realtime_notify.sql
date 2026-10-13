-- ============================================================
-- 048 — Realtime over LISTEN/NOTIFY (replaces Supabase Realtime)
--
-- Every table in the `supabase_realtime` publication (001, 009, 010,
-- 024, 027 add to it) gets an AFTER ROW trigger that publishes the
-- change on channel `wacrm_realtime`. The app holds one LISTEN
-- connection per process (src/lib/realtime/hub.ts) and fans events
-- out over Server-Sent Events, filtered per subscriber to their
-- account (and, for notifications, to the recipient).
--
-- Payload (JSON text):
--   { t: table, op: INSERT|UPDATE|DELETE, a: account_id, u: user_id,
--     id: primary key value, new: row|null, old: row|null, ts }
-- NOTIFY payloads are capped at 8000 bytes: oversized events are sent
-- without `new`/`old` and with `trunc: true`; the hub re-reads the row.
--
-- To make a new table realtime: `ALTER PUBLICATION supabase_realtime
-- ADD TABLE x;` and call public.realtime_attach('x') (or re-run the
-- DO block at the bottom of this file in a new migration).
-- ============================================================

CREATE OR REPLACE FUNCTION public.realtime_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new      JSONB;
  v_old      JSONB;
  v_row      JSONB;
  v_account  UUID;
  v_payload  JSONB;
  v_text     TEXT;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  v_row := COALESCE(v_new, v_old);

  IF v_row ? 'account_id' THEN
    v_account := (v_row->>'account_id')::uuid;
  ELSIF v_row ? 'conversation_id' THEN
    -- messages / message_reactions carry no account_id of their own.
    SELECT c.account_id INTO v_account
      FROM public.conversations c
     WHERE c.id = (v_row->>'conversation_id')::uuid;
  END IF;

  -- No tenant → nobody may see it; don't broadcast.
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;

  v_payload := jsonb_build_object(
    't',   TG_TABLE_NAME,
    'op',  TG_OP,
    'a',   v_account,
    'u',   v_row->>'user_id',
    'id',  COALESCE(v_row->>'id', v_row->>'user_id'),
    'new', v_new,
    'old', v_old,
    'ts',  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_text := v_payload::text;

  IF octet_length(v_text) > 7500 THEN
    v_text := (v_payload - 'new' - 'old' || jsonb_build_object('trunc', true))::text;
  END IF;

  PERFORM pg_notify('wacrm_realtime', v_text);
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.realtime_notify() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.realtime_notify() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.realtime_attach(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS realtime_notify ON public.%I', p_table);
  EXECUTE format(
    'CREATE TRIGGER realtime_notify AFTER INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.realtime_notify()',
    p_table);
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_attach(TEXT) FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  LOOP
    PERFORM public.realtime_attach(r.tablename);
  END LOOP;
END
$$;
