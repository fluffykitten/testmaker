-- ============================================================================
-- Migration 019: Candidate-facing exam submission security RPCs
-- ============================================================================
-- The static SPA talks to Supabase with the public anon key, so candidate
-- browsers must not need broad table reads for draft/resume/result flows.
-- These SECURITY DEFINER functions implement the narrow trust boundary:
--   * verify an invigilator unlock PIN without shipping the plaintext PIN;
--   * return only the requesting candidate's published result;
--   * answer the one-attempt check without a 100-row client-side scan.
--
-- NOTE: RLS on quiz_submissions/app_config is intentionally left unchanged in
-- this migration because the existing teacher dashboard writes those tables
-- directly with the anon key. Locking them down requires moving teacher writes
-- behind RPCs first (tracked separately in the submission review).
-- ============================================================================

-- ─── 1. Invigilator unlock PIN ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_teacher_unlock_pin(
    p_quiz_code TEXT,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_quizzes JSONB;
    v_stored TEXT;
BEGIN
    IF COALESCE(TRIM(p_quiz_code), '') = '' OR COALESCE(TRIM(p_pin), '') = '' THEN
        RETURN FALSE;
    END IF;

    SELECT value::jsonb INTO v_quizzes
    FROM public.app_config
    WHERE key = 'published_quizzes'
    LIMIT 1;

    IF v_quizzes IS NULL OR jsonb_typeof(v_quizzes) <> 'array' THEN
        RETURN FALSE;
    END IF;

    SELECT NULLIF(TRIM(elem->>'teacherPin'), '') INTO v_stored
    FROM jsonb_array_elements(v_quizzes) AS elem
    WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = UPPER(TRIM(p_quiz_code))
    LIMIT 1;

    RETURN v_stored IS NOT NULL AND v_stored = TRIM(p_pin);
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 2. Scoped student result lookup ─────────────────────────────────────────
-- Returns only the named candidate's published rows (result_pin stripped), so a
-- student never downloads classmates' answers, scores, or PINs.
CREATE OR REPLACE FUNCTION public.lookup_student_exam_result(
    p_quiz_code TEXT,
    p_student_query TEXT,
    p_result_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_query TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_query, '')), '\s+', ' ', 'g'));
    v_pin TEXT := TRIM(COALESCE(p_result_pin, ''));
    v_rows JSONB;
    v_has_unreleased BOOLEAN := FALSE;
    v_stored_pin TEXT;
BEGIN
    IF v_code = '' OR v_query = '' THEN
        RETURN jsonb_build_object(
            'status', 'not_found',
            'submissions', '[]'::jsonb,
            'hasUnreleased', FALSE
        );
    END IF;

    SELECT COALESCE(
        jsonb_agg(to_jsonb(s) - 'result_pin' ORDER BY s.submitted_at DESC NULLS LAST),
        '[]'::jsonb
    )
    INTO v_rows
    FROM public.quiz_submissions s
    WHERE UPPER(TRIM(s.quiz_code)) = v_code
      AND s.status = 'published'
      AND (
          LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_query
          OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_query
      );

    SELECT BOOL_OR(TRUE) INTO v_has_unreleased
    FROM public.quiz_submissions s
    WHERE UPPER(TRIM(s.quiz_code)) = v_code
      AND s.status <> 'published'
      AND (
          LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_query
          OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_query
      );

    IF v_rows = '[]'::jsonb THEN
        RETURN jsonb_build_object(
            'status', 'not_found',
            'submissions', '[]'::jsonb,
            'hasUnreleased', COALESCE(v_has_unreleased, FALSE)
        );
    END IF;

    SELECT NULLIF(TRIM(s.result_pin), '') INTO v_stored_pin
    FROM public.quiz_submissions s
    WHERE UPPER(TRIM(s.quiz_code)) = v_code
      AND s.status = 'published'
      AND (
          LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_query
          OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_query
      )
    ORDER BY s.submitted_at DESC NULLS LAST
    LIMIT 1;

    IF v_stored_pin IS NOT NULL AND v_stored_pin <> v_pin THEN
        RETURN jsonb_build_object(
            'status', 'pin_mismatch',
            'submissions', '[]'::jsonb,
            'hasUnreleased', FALSE
        );
    END IF;

    RETURN jsonb_build_object(
        'status', 'ok',
        'submissions', v_rows,
        'hasUnreleased', COALESCE(v_has_unreleased, FALSE)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'not_found',
        'submissions', '[]'::jsonb,
        'hasUnreleased', FALSE
    );
END;
$$;

-- ─── 3. Exact single-attempt check ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_student_attempt_submitted(
    p_quiz_code TEXT,
    p_student_name TEXT,
    p_student_class TEXT DEFAULT NULL,
    p_student_number TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_name, '')), '\s+', ' ', 'g'));
    v_class TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_class, '')), '\s+', ' ', 'g'));
    v_number TEXT := LOWER(TRIM(COALESCE(p_student_number, '')));
    v_row RECORD;
BEGIN
    IF v_code = '' OR v_name = '' THEN
        RETURN jsonb_build_object('submitted', FALSE);
    END IF;

    SELECT s.id, s.submitted_at
    INTO v_row
    FROM public.quiz_submissions s
    WHERE UPPER(TRIM(s.quiz_code)) = v_code
      AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_name
      AND (
          v_class = ''
          OR COALESCE(TRIM(s.student_class), '') = ''
          OR LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_class, '')), '\s+', ' ', 'g')) = v_class
      )
      AND (
          v_number = ''
          OR COALESCE(TRIM(s.candidate_number), '') = ''
          OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_number
      )
    ORDER BY s.submitted_at DESC NULLS LAST
    LIMIT 1;

    IF v_row.id IS NULL THEN
        RETURN jsonb_build_object('submitted', FALSE);
    END IF;

    RETURN jsonb_build_object(
        'submitted', TRUE,
        'submissionId', v_row.id,
        'submittedAt', v_row.submitted_at
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('submitted', FALSE);
END;
$$;

-- ─── Grants & lookup indexes ─────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.verify_teacher_unlock_pin(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_student_exam_result(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_student_attempt_submitted(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_quiz_submissions_attempt_lookup
    ON public.quiz_submissions (
        UPPER(TRIM(quiz_code)),
        LOWER(TRIM(student_name))
    );

CREATE INDEX IF NOT EXISTS idx_quiz_submissions_result_lookup
    ON public.quiz_submissions (
        UPPER(TRIM(quiz_code)),
        status
    );
