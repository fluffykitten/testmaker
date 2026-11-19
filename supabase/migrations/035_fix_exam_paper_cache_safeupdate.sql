-- ============================================================================
-- Migration 035: Fix `pg_safeupdate` ("DELETE requires a WHERE clause") in Cache Triggers
-- ============================================================================
-- Migration 032 introduced AFTER triggers on `app_config`, `questions`, and
-- `custom_tests` to clear `public.exam_paper_cache`. In branches without a
-- specific quiz code (`published_quizzes`, `custom_test_header_%`,
-- `test_header_%`, `questions`, `custom_tests`), those functions ran a bare:
--   DELETE FROM public.exam_paper_cache;
-- Supabase runs `pg_safeupdate`, which aborts any unqualified DELETE without a
-- WHERE clause — rolling back upserts to `published_quizzes`,
-- `custom_test_header_*`, `custom_tests`, and `questions`, while single-code
-- `quiz_by_code_*` writes succeeded because that IF branch had a WHERE clause.
--
-- Redefining both trigger functions with `WHERE quiz_code IS NOT NULL` unblocks
-- all writes while keeping existing trigger bindings intact.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.invalidate_exam_paper_cache_on_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key TEXT := CASE WHEN TG_OP = 'DELETE' THEN COALESCE(OLD.key, '') ELSE COALESCE(NEW.key, '') END;
BEGIN
    IF v_key LIKE 'quiz_by_code_%' OR v_key LIKE 'quiz_by_code:%' THEN
        DELETE FROM public.exam_paper_cache
        WHERE quiz_code = UPPER(TRIM(SUBSTRING(v_key FROM 14)));
    ELSIF v_key = 'published_quizzes'
       OR v_key LIKE 'custom_test_header_%'
       OR v_key LIKE 'test_header_%' THEN
        DELETE FROM public.exam_paper_cache
        WHERE quiz_code IS NOT NULL;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.invalidate_exam_paper_cache_all()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.exam_paper_cache
    WHERE quiz_code IS NOT NULL;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_exam_paper_cache_on_config() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_exam_paper_cache_all() FROM PUBLIC, anon, authenticated;

-- Flush any stale cache rows safely under pg_safeupdate
DELETE FROM public.exam_paper_cache WHERE quiz_code IS NOT NULL;
