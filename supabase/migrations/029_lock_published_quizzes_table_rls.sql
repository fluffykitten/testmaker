-- ============================================================================
-- Migration 029: Enable Strict RLS on Legacy `public.published_quizzes` Table
-- ============================================================================
-- Closes SEC-01 / SEC-05 from Plan/security_audit_2026-11-16.md and resolves
-- the Supabase Security Advisor warning:
--   "Table public.published_quizzes is public, but RLS has not been enabled."
--
-- The active TestMaker application stores published quiz payloads inside
-- `public.app_config` (accessed by candidates via SECURITY DEFINER RPCs), not
-- in `public.published_quizzes`. Because `public.published_quizzes` was created
-- outside versioned migrations, earlier RLS hardening migrations missed it.
--
-- Using `to_regclass('public.published_quizzes')` makes this migration safe
-- both on the live Supabase project (where the table exists) and on clean DB
-- replays (where the table does not exist).
-- ============================================================================

DO $$
DECLARE
    v_pol RECORD;
BEGIN
    IF to_regclass('public.published_quizzes') IS NULL THEN
        RETURN;
    END IF;

    -- 1. Drop any pre-existing permissive policies on public.published_quizzes
    FOR v_pol IN
        SELECT policyname, schemaname, tablename
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'published_quizzes'
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS %I ON %I.%I',
            v_pol.policyname,
            v_pol.schemaname,
            v_pol.tablename
        );
    END LOOP;

    -- 2. Enable Row-Level Security and revoke direct anon/authenticated grants
    EXECUTE 'ALTER TABLE public.published_quizzes ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.published_quizzes FROM PUBLIC, anon, authenticated';

    -- 3. Belt-and-braces teacher-only RLS policy (blocks anon even if a grant is later added)
    EXECUTE '
        CREATE POLICY "Teacher full access published_quizzes"
            ON public.published_quizzes FOR ALL
            USING (public.is_authenticated_teacher())
            WITH CHECK (public.is_authenticated_teacher())
    ';
END $$;
