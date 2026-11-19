-- ============================================================================
-- Migration 028: RLS-Locked Exam Paper Cache & Fast Lobby Resolution
-- ============================================================================
-- Eliminates Wave 1 (200-way simultaneous exam load) statement timeouts in
-- `get_student_exam_paper`:
--   1. Stores sanitized exam papers in a private, RLS-locked cache table
--      (`public.exam_paper_cache`) with 5-minute TTL and per-code advisory-lock
--      single-flight build (`pg_advisory_xact_lock`), so 200 simultaneous
--      students opening a quiz compile the sanitized paper once instead of
--      executing 200 redundant TOAST/JSONB sanitization builds.
--   2. Attaches AFTER triggers on `app_config` (guarded to quiz/header keys so
--      high-frequency `draft_%` writes never fire it), `questions`, and
--      `custom_tests` so pausing, re-activating, or editing any question or
--      header invalidates cached papers immediately.
--   3. Optimizes cold misses with indexed UUID `custom_tests` lookup and an
--      indexed `questions` PK CTE while keeping answer-key stripping and
--      `teacherPinHash: NULL` guarantees intact.
-- ============================================================================

-- ─── 1. Private RLS-Locked Exam Paper Cache Table ────────────────────────────

CREATE TABLE IF NOT EXISTS public.exam_paper_cache (
    quiz_code TEXT PRIMARY KEY,
    strip_keys BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) WITH (fillfactor = 70);

ALTER TABLE public.exam_paper_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exam_paper_cache FROM PUBLIC, anon, authenticated;

-- ─── 2. Instant Auto-Invalidation Trigger Functions ──────────────────────────

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
        DELETE FROM public.exam_paper_cache;
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
    DELETE FROM public.exam_paper_cache;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_exam_paper_cache_on_config() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_exam_paper_cache_all() FROM PUBLIC, anon, authenticated;

-- Separate INSERT/UPDATE and DELETE triggers with WHEN guards so `draft_%` saves never fire invalidation
DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_app_config_iu ON public.app_config;
CREATE TRIGGER trg_invalidate_exam_paper_cache_app_config_iu
    AFTER INSERT OR UPDATE ON public.app_config
    FOR EACH ROW
    WHEN (
        NEW.key LIKE 'quiz_by_code_%'
        OR NEW.key LIKE 'quiz_by_code:%'
        OR NEW.key = 'published_quizzes'
        OR NEW.key LIKE 'custom_test_header_%'
        OR NEW.key LIKE 'test_header_%'
    )
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_on_config();

DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_app_config_d ON public.app_config;
CREATE TRIGGER trg_invalidate_exam_paper_cache_app_config_d
    AFTER DELETE ON public.app_config
    FOR EACH ROW
    WHEN (
        OLD.key LIKE 'quiz_by_code_%'
        OR OLD.key LIKE 'quiz_by_code:%'
        OR OLD.key = 'published_quizzes'
        OR OLD.key LIKE 'custom_test_header_%'
        OR OLD.key LIKE 'test_header_%'
    )
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_on_config();

DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_questions ON public.questions;
CREATE TRIGGER trg_invalidate_exam_paper_cache_questions
    AFTER INSERT OR UPDATE OR DELETE ON public.questions
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_all();

DROP TRIGGER IF EXISTS trg_invalidate_exam_paper_cache_custom_tests ON public.custom_tests;
CREATE TRIGGER trg_invalidate_exam_paper_cache_custom_tests
    AFTER INSERT OR UPDATE OR DELETE ON public.custom_tests
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.invalidate_exam_paper_cache_all();

-- ─── 3. Optimized `get_student_exam_paper` With Single-Flight Cache ──────────

CREATE OR REPLACE FUNCTION public.get_student_exam_paper(
    p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_code, '')));
    v_cached_payload JSONB;
    v_raw TEXT;
    v_quiz JSONB;
    v_is_active BOOLEAN;
    v_test_id TEXT;
    v_test_row RECORD;
    v_test_meta JSONB := NULL;
    v_header_raw TEXT;
    v_header_cloud JSONB := '{}'::jsonb;
    v_header_inline JSONB := '{}'::jsonb;
    v_overrides JSONB := '{}'::jsonb;
    v_header_clean JSONB;
    v_qids TEXT[] := ARRAY[]::TEXT[];
    v_strip_keys BOOLEAN := TRUE;
    v_questions JSONB := '[]'::jsonb;
    v_result JSONB;
BEGIN
    IF v_code = '' THEN
        RETURN NULL;
    END IF;

    -- Fast path: return cached sanitized payload immediately without locking
    SELECT c.payload
    INTO v_cached_payload
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_code
      AND c.cached_at > (NOW() - INTERVAL '5 minutes')
    LIMIT 1;

    IF FOUND AND v_cached_payload IS NOT NULL THEN
        RETURN v_cached_payload;
    END IF;

    -- Single-flight per-code build so 200 cold hits do not run 200 duplicate TOAST builds
    PERFORM pg_advisory_xact_lock(hashtext('exam_paper_cache:' || v_code));

    -- Re-check cache after acquiring lock (workers #2..#200 return right away)
    SELECT c.payload
    INTO v_cached_payload
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_code
      AND c.cached_at > (NOW() - INTERVAL '5 minutes')
    LIMIT 1;

    IF FOUND AND v_cached_payload IS NOT NULL THEN
        RETURN v_cached_payload;
    END IF;

    SELECT value INTO v_raw
    FROM public.app_config
    WHERE key IN ('quiz_by_code_' || v_code, 'quiz_by_code:' || v_code)
    ORDER BY CASE WHEN key = 'quiz_by_code_' || v_code THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_raw IS NOT NULL AND TRIM(v_raw) <> '' THEN
        BEGIN
            v_quiz := v_raw::jsonb;
        EXCEPTION WHEN OTHERS THEN
            v_quiz := NULL;
        END;
    END IF;

    IF v_quiz IS NULL THEN
        SELECT value INTO v_raw
        FROM public.app_config
        WHERE key = 'published_quizzes'
        LIMIT 1;

        IF v_raw IS NOT NULL AND TRIM(v_raw) <> '' THEN
            BEGIN
                SELECT elem INTO v_quiz
                FROM jsonb_array_elements(v_raw::jsonb) WITH ORDINALITY AS arr(elem, ord)
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
                       ) pc
                       WHERE UPPER(TRIM(pc)) = v_code
                   )
                ORDER BY ord ASC
                LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_quiz := NULL;
            END;
        END IF;
    END IF;

    IF v_quiz IS NULL THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(v_quiz->'headerConfig') = 'object' THEN
        v_header_inline := v_quiz->'headerConfig';
        v_quiz := v_quiz || jsonb_build_object(
            'headerConfig',
            v_header_inline - 'teacherPin' - 'teacherPinHash' - 'questionOverrides'
        );
    END IF;
    v_quiz := v_quiz - 'teacherPin' - 'teacherPinHash';

    v_is_active := COALESCE((v_quiz->>'isActive')::boolean, TRUE);
    IF NOT v_is_active THEN
        v_result := jsonb_build_object(
            'publishedQuiz', v_quiz,
            'teacherPinHash', NULL,
            'isActive', FALSE,
            'questions', '[]'::jsonb
        );
        INSERT INTO public.exam_paper_cache (quiz_code, strip_keys, payload, cached_at)
        VALUES (v_code, TRUE, v_result, NOW())
        ON CONFLICT (quiz_code) DO UPDATE
        SET strip_keys = EXCLUDED.strip_keys,
            payload = EXCLUDED.payload,
            cached_at = NOW();
        RETURN v_result;
    END IF;

    v_test_id := TRIM(COALESCE(v_quiz->>'testId', ''));
    IF v_test_id <> '' THEN
        IF v_test_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT id, title, total_marks, question_ids, created_at
            INTO v_test_row
            FROM public.custom_tests
            WHERE id = v_test_id::uuid
            LIMIT 1;
        ELSE
            SELECT id, title, total_marks, question_ids, created_at
            INTO v_test_row
            FROM public.custom_tests
            WHERE id::text = v_test_id
            LIMIT 1;
        END IF;

        IF FOUND THEN
            v_test_meta := jsonb_build_object(
                'id', v_test_row.id,
                'title', v_test_row.title,
                'total_marks', v_test_row.total_marks,
                'question_ids', to_jsonb(COALESCE(v_test_row.question_ids, ARRAY[]::UUID[])),
                'created_at', v_test_row.created_at
            );
        END IF;

        SELECT value INTO v_header_raw
        FROM public.app_config
        WHERE key IN ('custom_test_header_' || v_test_id, 'test_header_' || v_test_id)
        ORDER BY CASE WHEN key = 'custom_test_header_' || v_test_id THEN 0 ELSE 1 END
        LIMIT 1;

        IF v_header_raw IS NOT NULL AND TRIM(v_header_raw) <> '' THEN
            BEGIN
                v_header_cloud := v_header_raw::jsonb;
            EXCEPTION WHEN OTHERS THEN
                v_header_cloud := '{}'::jsonb;
            END;
        END IF;
    END IF;

    IF jsonb_typeof(v_header_cloud->'_savedQuestionIds') = 'array' AND jsonb_array_length(v_header_cloud->'_savedQuestionIds') > 0 THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_qids
        FROM jsonb_array_elements_text(v_header_cloud->'_savedQuestionIds') x;
    ELSIF v_test_meta IS NOT NULL AND v_test_row.question_ids IS NOT NULL AND array_length(v_test_row.question_ids, 1) > 0 THEN
        SELECT COALESCE(array_agg(id_val::text), ARRAY[]::TEXT[]) INTO v_qids
        FROM unnest(v_test_row.question_ids) id_val;
    ELSIF jsonb_typeof(v_quiz->'questionIds') = 'array' THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_qids
        FROM jsonb_array_elements_text(v_quiz->'questionIds') x;
    END IF;

    v_overrides := (
        CASE WHEN jsonb_typeof(v_header_inline->'questionOverrides') = 'object' THEN v_header_inline->'questionOverrides' ELSE '{}'::jsonb END
    ) || (
        CASE WHEN jsonb_typeof(v_header_cloud->'questionOverrides') = 'object' THEN v_header_cloud->'questionOverrides' ELSE '{}'::jsonb END
    );

    v_header_clean := (
        (v_header_inline || v_header_cloud)
        - 'teacherPin'
        - 'teacherPinHash'
        - 'questionOverrides'
        - '_savedQuestionIds'
        - '_savedTotalMarks'
        - '_updatedAt'
        - 'updatedAt'
    );

    -- Strip answer keys in Exam Mode OR Game Mode unless instant solutions are explicitly enabled
    v_strip_keys := (
        COALESCE((v_quiz->>'isExamMode')::boolean, FALSE)
        OR LOWER(COALESCE(v_quiz->>'quizMode', '')) = 'game'
    ) AND NOT COALESCE((v_quiz->>'showInstantSolutions')::boolean, FALSE);

    IF v_qids IS NOT NULL AND array_length(v_qids, 1) > 0 THEN
        WITH ordered_qids AS (
            SELECT
                u.ord,
                u.qid,
                CASE
                    WHEN u.qid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN u.qid::uuid
                    ELSE NULL
                END AS q_uuid
            FROM unnest(v_qids) WITH ORDINALITY AS u(qid, ord)
        ),
        matched_questions AS (
            SELECT q.*
            FROM public.questions q
            WHERE q.id IN (SELECT o.q_uuid FROM ordered_qids o WHERE o.q_uuid IS NOT NULL)
        )
        SELECT COALESCE(
            jsonb_agg(
                public.sanitize_question_json_for_student(merged_q, v_strip_keys)
                ORDER BY ord
            ),
            '[]'::jsonb
        )
        INTO v_questions
        FROM (
            SELECT
                o.ord,
                CASE
                    WHEN (v_overrides ? o.qid) AND jsonb_typeof(v_overrides->o.qid) = 'object' THEN
                        COALESCE(to_jsonb(q), '{}'::jsonb) || (v_overrides->o.qid)
                    ELSE to_jsonb(q)
                END AS merged_q
            FROM ordered_qids o
            LEFT JOIN matched_questions q ON q.id = o.q_uuid
        ) sub
        WHERE merged_q IS NOT NULL;
    END IF;

    v_result := jsonb_build_object(
        'publishedQuiz', v_quiz,
        'customTest', v_test_meta,
        'headerConfig', v_header_clean,
        'teacherPinHash', NULL,
        'isActive', TRUE,
        'questions', v_questions
    );

    INSERT INTO public.exam_paper_cache (quiz_code, strip_keys, payload, cached_at)
    VALUES (v_code, v_strip_keys, v_result, NOW())
    ON CONFLICT (quiz_code) DO UPDATE
    SET strip_keys = EXCLUDED.strip_keys,
        payload = EXCLUDED.payload,
        cached_at = NOW();

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;

-- Clear any stale cache entries upon applying Migration 028
DELETE FROM public.exam_paper_cache;
