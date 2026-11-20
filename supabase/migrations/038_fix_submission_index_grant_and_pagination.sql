-- ============================================================================
-- Migration 038: Fix normalize_roster_class_label Execute Grant &
--                quiz_submissions Pagination Index
-- ============================================================================
-- Fixes two production issues observed in hosted Postgres / PostgREST logs:
--   1. SQLSTATE 42501 (`permission denied for function normalize_roster_class_label`)
--      on direct teacher PostgREST INSERT/UPDATE into `public.quiz_submissions`.
--      Migration 034 revoked EXECUTE on `normalize_roster_class_label(TEXT)` while
--      adding expression index `idx_quiz_submissions_code_norm_name_class` that
--      evaluates it on every write. The function is a pure IMMUTABLE string
--      normalizer with zero table access, so granting EXECUTE to anon and
--      authenticated has no security exposure and restores teacher grading/sync.
--   2. SQLSTATE 57014 (`canceling statement due to statement timeout`) on
--      paginated `SELECT * FROM public.quiz_submissions ORDER BY submitted_at DESC`.
--      Adds composite B-tree index `(submitted_at DESC, id DESC)` for fast,
--      deterministic index-ordered pagination.
-- ============================================================================

-- ─── 1. Restore EXECUTE on pure IMMUTABLE expression-index helper ────────────
GRANT EXECUTE ON FUNCTION public.normalize_roster_class_label(TEXT) TO anon, authenticated;

-- ─── 2. Deterministic Pagination Index for Quiz Manager Sync ─────────────────
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_submitted_at_desc
    ON public.quiz_submissions (submitted_at DESC, id DESC);

ANALYZE public.quiz_submissions;
