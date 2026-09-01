-- LAC-3619: Supabase security advisor flagged rls_disabled_in_public /
-- sensitive_columns_exposed. The app reaches Postgres only through
-- DATABASE_URL as the table owner (RLS does not apply to owners unless
-- FORCE is set), but Supabase exposes every public-schema table through
-- PostgREST to anyone holding the project URL + anon key. Enabling RLS
-- with no policies default-denies that API path without affecting the app.
-- Idempotent: only touches tables that still have RLS disabled, so it is
-- safe on databases where this was already applied manually (prod,
-- 2026-09-01).
DO $$
DECLARE t record;
BEGIN
	FOR t IN
		SELECT schemaname, tablename
		FROM pg_tables
		WHERE schemaname = 'public' AND NOT rowsecurity
	LOOP
		EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
	END LOOP;
END $$;
