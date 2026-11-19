-- ============================================================================
-- Migration 029: Re-Sync Teacher PIN Verification Parity
-- ============================================================================
-- Ensures `verify_teacher_unlock_pin(p_quiz_code, p_pin)` checks both
-- `quiz_by_code_<CODE>` and `quiz_by_code:<CODE>`, matches `published_quizzes`
-- by `quizCode`, `id`, `testId`, or `previousCodes`, and falls back to `'1234'`
-- when an existing quiz record omits an explicit `teacherPin` (matching
-- `quizManagerService` / `quizCodeService`).
-- ============================================================================

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
    v_code TEXT := UPPER(TRIM(COALESCE(p_quiz_code, '')));
    v_pin TEXT := TRIM(COALESCE(p_pin, ''));
    v_quiz JSONB := NULL;
    v_quizzes JSONB;
    v_stored TEXT;
BEGIN
    IF v_code = '' OR v_pin = '' THEN
        RETURN FALSE;
    END IF;

    -- 1. Primary lookup: fast per-code shard (`quiz_by_code_` or `quiz_by_code:`)
    BEGIN
        SELECT value::jsonb INTO v_quiz
        FROM public.app_config
        WHERE key IN ('quiz_by_code_' || v_code, 'quiz_by_code:' || v_code)
        ORDER BY CASE WHEN key = 'quiz_by_code_' || v_code THEN 0 ELSE 1 END
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v_quiz := NULL;
    END;

    -- 2. Fallback lookup: `published_quizzes` matching `quizCode`, `id`, `testId`, or `previousCodes`
    IF v_quiz IS NULL THEN
        BEGIN
            SELECT value::jsonb INTO v_quizzes
            FROM public.app_config
            WHERE key = 'published_quizzes'
            LIMIT 1;

            IF v_quizzes IS NOT NULL AND jsonb_typeof(v_quizzes) = 'array' THEN
                SELECT elem INTO v_quiz
                FROM jsonb_array_elements(v_quizzes) WITH ORDINALITY AS arr(elem, ord)
                WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = v_code
                   OR UPPER(TRIM(COALESCE(elem->>'id', ''))) = v_code
                   OR UPPER(TRIM(COALESCE(elem->>'testId', ''))) = v_code
                   OR EXISTS (
                       SELECT 1
                       FROM jsonb_array_elements_text(
                           CASE
                               WHEN jsonb_typeof(elem->'previousCodes') = 'array' THEN elem->'previousCodes'
                               ELSE '[]'::jsonb
                           END
                       ) AS prev_code
                       WHERE UPPER(TRIM(prev_code)) = v_code
                   )
                ORDER BY ord ASC
                LIMIT 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_quiz := NULL;
        END;
    END IF;

    IF v_quiz IS NULL THEN
        RETURN FALSE;
    END IF;

    v_stored := COALESCE(
        NULLIF(TRIM(v_quiz->>'teacherPin'), ''),
        NULLIF(TRIM(v_quiz->'headerConfig'->>'teacherPin'), ''),
        '1234'
    );

    RETURN v_stored = v_pin;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_teacher_unlock_pin(TEXT, TEXT) TO anon, authenticated;
