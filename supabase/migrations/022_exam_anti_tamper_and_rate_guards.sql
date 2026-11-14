-- ============================================================================
-- Migration 022: Phase 2.5 — Exam Anti-Tamper, Draft Ownership, Performance
--                Optimization & Audit Rate Guards
-- ============================================================================
-- Addresses empirical bugs and security findings uncovered during the
-- 200-student live stress test & red-team simulation (`test:stress-200`):
--   1. BUG-01: Remove nonexistent `app_config.updated_at` in `save_student_exam_draft`.
--   2. VULN-H2a/H2b: Add `exam_draft_locks` per-student ownership token check +
--      256 KB payload byte cap across draft RPCs.
--   3. VULN-H1: Ignore client-supplied `score`, `percentage`, `teacher_adjusted_marks`,
--      `status`, and item marks on Exam Mode submissions in `submit_student_exam_attempt`;
--      clamp numeric bounds and duration/violations on all submissions.
--   4. VULN-H3a/H3b: Enforce single-attempt lock server-side when `limitOneAttempt`
--      is enabled (rejecting new `id` bypasses) and block blank-PIN `ON CONFLICT`
--      row overwrites.
--   5. VULN-H4: Enforce field size caps (`detail <= 1024` bytes), valid severities,
--      and per-student rate limits on `proctor_audit_events`.
--   6. VULN-H5: Return `allowStudentScriptDownload` directly from
--      `lookup_student_exam_result` so `StudentResultModal` never depends on
--      a blocked `app_config` read.
--   7. PERF-01: Upgrade `get_student_exam_paper` question assembly from N+1 loop
--      queries to a single set-based join.
-- ============================================================================

-- ─── 0. Clean Up Any STRESS200 Simulation Fixture Rows ───────────────────────

DELETE FROM public.quiz_submissions WHERE UPPER(TRIM(quiz_code)) = 'STRESS200';
DELETE FROM public.proctor_audit_events WHERE UPPER(TRIM(quiz_code)) = 'STRESS200';
DELETE FROM public.app_config WHERE key LIKE 'draft_STRESS200_%' OR key LIKE 'draft_stress200_%';

-- ─── 1. PERF-01: Set-Based `get_student_exam_paper` Optimization ─────────────

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
    v_raw TEXT;
    v_quiz JSONB;
    v_effective_pin TEXT;
    v_teacher_pin_hash TEXT;
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
BEGIN
    IF v_code = '' THEN
        RETURN NULL;
    END IF;

    -- 1. Fast per-code index lookup in app_config (primary `quiz_by_code_`, fallback `quiz_by_code:`)
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

    -- 2. Fallback: scan `published_quizzes` JSONB array by quizCode, id, testId, or previousCodes
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

    v_effective_pin := COALESCE(
        NULLIF(TRIM(COALESCE(v_quiz->>'teacherPin', '')), ''),
        NULLIF(TRIM(COALESCE(v_quiz->'headerConfig'->>'teacherPin', '')), ''),
        '1234'
    );
    v_teacher_pin_hash := 'sha256:' || LOWER(ENCODE(SHA256(CONVERT_TO(
        UPPER(TRIM(COALESCE(v_quiz->>'quizCode', v_code))) || '::' || v_effective_pin,
        'UTF8'
    )), 'hex'));

    IF jsonb_typeof(v_quiz->'headerConfig') = 'object' THEN
        v_header_inline := v_quiz->'headerConfig';
        v_quiz := v_quiz || jsonb_build_object(
            'headerConfig',
            v_header_inline - 'teacherPin' - 'questionOverrides'
        );
    END IF;
    v_quiz := v_quiz - 'teacherPin';

    v_is_active := COALESCE((v_quiz->>'isActive')::boolean, TRUE);
    IF NOT v_is_active THEN
        RETURN jsonb_build_object(
            'publishedQuiz', v_quiz,
            'teacherPinHash', v_teacher_pin_hash,
            'isActive', FALSE,
            'questions', '[]'::jsonb
        );
    END IF;

    -- 3. Resolve custom_tests & cloud header config
    v_test_id := TRIM(COALESCE(v_quiz->>'testId', ''));
    IF v_test_id <> '' THEN
        SELECT id, title, total_marks, question_ids, created_at
        INTO v_test_row
        FROM public.custom_tests
        WHERE id::text = v_test_id
        LIMIT 1;

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

    -- Resolve ordered question IDs
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
        - 'questionOverrides'
        - '_savedQuestionIds'
        - '_savedTotalMarks'
        - '_updatedAt'
        - 'updatedAt'
    );

    v_strip_keys := COALESCE((v_quiz->>'isExamMode')::boolean, FALSE)
        AND NOT COALESCE((v_quiz->>'showInstantSolutions')::boolean, FALSE);

    -- Build ordered sanitized questions array in a single set-based join
    IF v_qids IS NOT NULL AND array_length(v_qids, 1) > 0 THEN
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
                u.ord,
                CASE
                    WHEN (v_overrides ? u.qid) AND jsonb_typeof(v_overrides->u.qid) = 'object' THEN
                        COALESCE(to_jsonb(q), '{}'::jsonb) || (v_overrides->u.qid)
                    ELSE to_jsonb(q)
                END AS merged_q
            FROM unnest(v_qids) WITH ORDINALITY AS u(qid, ord)
            LEFT JOIN public.questions q
                ON q.id = (
                    CASE
                        WHEN u.qid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            THEN u.qid::uuid
                        ELSE NULL
                    END
                )
        ) sub
        WHERE merged_q IS NOT NULL;
    END IF;

    RETURN jsonb_build_object(
        'publishedQuiz', v_quiz,
        'customTest', v_test_meta,
        'headerConfig', v_header_clean,
        'teacherPinHash', v_teacher_pin_hash,
        'isActive', TRUE,
        'questions', v_questions
    );
END;
$$;

-- ─── 2. BUG-01 + VULN-H2a/H2b: Draft Ownership Locks & Size Caps ────────────

CREATE TABLE IF NOT EXISTS public.exam_draft_locks (
    draft_key TEXT PRIMARY KEY,
    owner_token_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.exam_draft_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_draft_locks FROM anon, authenticated;

-- Drop old Migration 021 signatures cleanly to prevent PostgREST overload ambiguity
DROP FUNCTION IF EXISTS public.save_student_exam_draft(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_student_exam_draft(TEXT);
DROP FUNCTION IF EXISTS public.delete_student_exam_draft(TEXT);

CREATE OR REPLACE FUNCTION public.save_student_exam_draft(
    p_key TEXT,
    p_value TEXT,
    p_owner_token TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_token TEXT := NULLIF(TRIM(COALESCE(p_owner_token, '')), '');
    v_hash TEXT;
    v_existing_hash TEXT;
    v_existing_ts TIMESTAMPTZ;
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) < 8 OR LENGTH(p_key) > 180 THEN
        RETURN FALSE;
    END IF;

    -- Cap draft payload at 256 KB to block app_config storage exhaustion attacks
    IF OCTET_LENGTH(COALESCE(p_value, '')) > 262144 THEN
        RETURN FALSE;
    END IF;

    IF v_token IS NULL THEN
        RETURN FALSE;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    SELECT owner_token_hash, updated_at
    INTO v_existing_hash, v_existing_ts
    FROM public.exam_draft_locks
    WHERE draft_key = p_key
    LIMIT 1;

    IF FOUND AND v_existing_ts > (NOW() - INTERVAL '24 hours') AND v_existing_hash <> v_hash THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.exam_draft_locks (draft_key, owner_token_hash, updated_at)
    VALUES (p_key, v_hash, NOW())
    ON CONFLICT (draft_key) DO UPDATE
    SET owner_token_hash = EXCLUDED.owner_token_hash,
        updated_at = NOW();

    -- Schema of app_config is (key, value) only — never reference updated_at here
    INSERT INTO public.app_config (key, value)
    VALUES (p_key, COALESCE(p_value, ''))
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value;

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_student_exam_draft(
    p_key TEXT,
    p_owner_token TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_token TEXT := NULLIF(TRIM(COALESCE(p_owner_token, '')), '');
    v_hash TEXT;
    v_lock_hash TEXT;
    v_val TEXT;
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) < 8 OR LENGTH(p_key) > 180 THEN
        RETURN NULL;
    END IF;

    IF v_token IS NULL THEN
        RETURN NULL;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    SELECT owner_token_hash INTO v_lock_hash
    FROM public.exam_draft_locks
    WHERE draft_key = p_key
    LIMIT 1;

    IF FOUND AND v_lock_hash <> v_hash THEN
        RETURN NULL;
    END IF;

    SELECT value INTO v_val
    FROM public.app_config
    WHERE key = p_key
    LIMIT 1;

    RETURN v_val;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_student_exam_draft(
    p_key TEXT,
    p_owner_token TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_token TEXT := NULLIF(TRIM(COALESCE(p_owner_token, '')), '');
    v_hash TEXT;
    v_lock_hash TEXT;
BEGIN
    IF p_key IS NULL OR p_key NOT LIKE 'draft_%' OR LENGTH(p_key) < 8 OR LENGTH(p_key) > 180 THEN
        RETURN FALSE;
    END IF;

    IF v_token IS NULL THEN
        RETURN FALSE;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    SELECT owner_token_hash INTO v_lock_hash
    FROM public.exam_draft_locks
    WHERE draft_key = p_key
    LIMIT 1;

    IF FOUND AND v_lock_hash <> v_hash THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.app_config WHERE key = p_key;
    DELETE FROM public.exam_draft_locks WHERE draft_key = p_key;
    RETURN TRUE;
END;
$$;

-- ─── 3. VULN-H1, H3a, H3b: Anti-Tamper `submit_student_exam_attempt` ─────────

CREATE OR REPLACE FUNCTION public.submit_student_exam_attempt(
    p_row JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id TEXT := TRIM(COALESCE(p_row->>'id', ''));
    v_quiz_code TEXT := UPPER(TRIM(COALESCE(p_row->>'quiz_code', '')));
    v_quiz_id TEXT := COALESCE(NULLIF(TRIM(COALESCE(p_row->>'quiz_id', '')), ''), UPPER(TRIM(COALESCE(p_row->>'quiz_code', ''))));
    v_student_name TEXT := COALESCE(NULLIF(TRIM(COALESCE(p_row->>'student_name', '')), ''), 'Student');
    v_student_class TEXT := p_row->>'student_class';
    v_candidate_number TEXT := p_row->>'candidate_number';
    v_norm_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(v_student_name, '')), '\s+', ' ', 'g'));
    v_norm_number TEXT := LOWER(TRIM(COALESCE(v_candidate_number, '')));
    v_result_pin TEXT := TRIM(COALESCE(p_row->>'result_pin', ''));
    v_raw_quiz TEXT;
    v_quiz JSONB := NULL;
    v_is_exam_mode BOOLEAN := TRUE;
    v_limit_one_attempt BOOLEAN := TRUE;
    v_duration_sec INT;
    v_violations_count INT;
    v_total_marks NUMERIC;
    v_score NUMERIC;
    v_percentage NUMERIC;
    v_q_results JSONB := COALESCE(p_row->'question_results', '[]'::jsonb);
    v_affected INT := 0;
BEGIN
    IF p_row IS NULL OR v_id = '' OR v_quiz_code = '' OR LENGTH(v_id) > 120 THEN
        RETURN FALSE;
    END IF;

    -- Resolve quiz policy metadata (`isExamMode` & `limitOneAttempt`)
    SELECT value INTO v_raw_quiz
    FROM public.app_config
    WHERE key IN ('quiz_by_code_' || v_quiz_code, 'quiz_by_code:' || v_quiz_code)
    ORDER BY CASE WHEN key = 'quiz_by_code_' || v_quiz_code THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_raw_quiz IS NOT NULL AND TRIM(v_raw_quiz) <> '' THEN
        BEGIN
            v_quiz := v_raw_quiz::jsonb;
        EXCEPTION WHEN OTHERS THEN
            v_quiz := NULL;
        END;
    ELSE
        SELECT value INTO v_raw_quiz FROM public.app_config WHERE key = 'published_quizzes' LIMIT 1;
        IF v_raw_quiz IS NOT NULL AND TRIM(v_raw_quiz) <> '' THEN
            BEGIN
                SELECT elem INTO v_quiz
                FROM jsonb_array_elements(v_raw_quiz::jsonb) WITH ORDINALITY AS arr(elem, ord)
                WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = v_quiz_code
                   OR UPPER(TRIM(COALESCE(elem->>'id', ''))) = v_quiz_code
                ORDER BY ord ASC
                LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_quiz := NULL;
            END;
        END IF;
    END IF;

    IF v_quiz IS NOT NULL THEN
        v_is_exam_mode := COALESCE((v_quiz->>'isExamMode')::boolean, TRUE);
        v_limit_one_attempt := COALESCE((v_quiz->>'limitOneAttempt')::boolean, TRUE);
    END IF;

    -- Enforce single-attempt lock server-side when inserting a new submission ID (blocks H3a bypass)
    IF v_limit_one_attempt AND v_norm_name <> '' THEN
        IF EXISTS (
            SELECT 1
            FROM public.quiz_submissions s
            WHERE UPPER(TRIM(s.quiz_code)) = v_quiz_code
              AND s.id <> v_id
              AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_norm_name
              AND (
                  v_norm_number = ''
                  OR COALESCE(TRIM(s.candidate_number), '') = ''
                  OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_norm_number
              )
        ) THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- Parse & clamp numeric inputs strictly
    v_duration_sec := GREATEST(0, LEAST(86400, COALESCE(NULLIF(p_row->>'duration_seconds', '')::int, 0)));
    v_violations_count := GREATEST(0, LEAST(1000, COALESCE(NULLIF(p_row->>'violations_count', '')::int, 0)));
    v_total_marks := GREATEST(0, LEAST(10000, COALESCE(NULLIF(p_row->>'total_marks', '')::numeric, 0)));

    -- Reject explicit client privilege-escalation / score-forgery claims
    IF LOWER(TRIM(COALESCE(NULLIF(p_row->>'status', ''), 'submitted'))) <> 'submitted'
       OR COALESCE(NULLIF(p_row->>'teacher_adjusted_marks', '')::numeric, 0) <> 0
       OR (v_total_marks > 0 AND COALESCE(NULLIF(p_row->>'score', '')::numeric, 0) > v_total_marks)
       OR COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0) > 100 THEN
        RETURN FALSE;
    END IF;

    IF v_is_exam_mode THEN
        -- Exam Mode: Student browsers never hold authoritative answer keys, so ignore client-claimed scores
        -- and force item results into awaiting-evaluation state until teacher/auto grading runs.
        v_score := 0;
        v_percentage := 0;
        IF jsonb_typeof(v_q_results) = 'array' THEN
            SELECT COALESCE(
                jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(qr) = 'object' THEN
                            qr || jsonb_build_object(
                                'earnedMarks', 0,
                                'isCorrect', FALSE,
                                'correctAnswer', 'See mark scheme',
                                'aiFeedback', 'Awaiting examiner AI evaluation'
                            )
                        ELSE qr
                    END
                ),
                '[]'::jsonb
            )
            INTO v_q_results
            FROM jsonb_array_elements(v_q_results) qr;
        ELSE
            v_q_results := '[]'::jsonb;
        END IF;
    ELSE
        -- Practice Mode: still enforce bounded ranges [0..total_marks] and [0..100]
        v_score := GREATEST(0, LEAST(GREATEST(v_total_marks, 0), COALESCE(NULLIF(p_row->>'score', '')::numeric, 0)));
        v_percentage := GREATEST(0, LEAST(100, COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0)));
    END IF;

    INSERT INTO public.quiz_submissions (
        id,
        quiz_id,
        quiz_code,
        quiz_title,
        subject,
        student_name,
        student_class,
        candidate_number,
        submitted_at,
        duration_seconds,
        score,
        total_marks,
        percentage,
        violations_count,
        proctoring_logs,
        raw_answers,
        question_results,
        topic_breakdown,
        status,
        teacher_adjusted_marks,
        teacher_notes,
        result_pin,
        updated_at
    )
    VALUES (
        v_id,
        v_quiz_id,
        v_quiz_code,
        LEFT(COALESCE(p_row->>'quiz_title', ''), 200),
        LEFT(COALESCE(p_row->>'subject', ''), 120),
        LEFT(v_student_name, 120),
        LEFT(COALESCE(v_student_class, ''), 64),
        LEFT(COALESCE(v_candidate_number, ''), 64),
        COALESCE(NULLIF(p_row->>'submitted_at', '')::timestamptz, NOW()),
        v_duration_sec,
        v_score,
        v_total_marks,
        v_percentage,
        v_violations_count,
        COALESCE(p_row->'proctoring_logs', '[]'::jsonb),
        COALESCE(p_row->'raw_answers', '{}'::jsonb),
        v_q_results,
        COALESCE(p_row->'topic_breakdown', '{}'::jsonb),
        'submitted',
        0,
        '',
        v_result_pin,
        NOW()
    )
    ON CONFLICT (id) DO UPDATE
    SET quiz_title = EXCLUDED.quiz_title,
        subject = EXCLUDED.subject,
        student_name = EXCLUDED.student_name,
        student_class = EXCLUDED.student_class,
        candidate_number = EXCLUDED.candidate_number,
        submitted_at = EXCLUDED.submitted_at,
        duration_seconds = EXCLUDED.duration_seconds,
        score = EXCLUDED.score,
        total_marks = EXCLUDED.total_marks,
        percentage = EXCLUDED.percentage,
        violations_count = EXCLUDED.violations_count,
        proctoring_logs = EXCLUDED.proctoring_logs,
        raw_answers = EXCLUDED.raw_answers,
        question_results = EXCLUDED.question_results,
        topic_breakdown = EXCLUDED.topic_breakdown,
        status = 'submitted',
        teacher_adjusted_marks = 0,
        updated_at = NOW()
    WHERE public.quiz_submissions.status = 'submitted'
      -- Block H3b blank-PIN overwrite hijack: updates require matching non-empty result_pin
      AND NULLIF(TRIM(public.quiz_submissions.result_pin), '') IS NOT NULL
      AND TRIM(public.quiz_submissions.result_pin) = v_result_pin;

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    RETURN v_affected > 0;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 4. VULN-H5: Include `allowStudentScriptDownload` in Result Lookup ───────

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
    v_raw_quiz TEXT;
    v_allow_download BOOLEAN := FALSE;
BEGIN
    IF v_code = '' OR v_query = '' THEN
        RETURN jsonb_build_object(
            'status', 'not_found',
            'submissions', '[]'::jsonb,
            'hasUnreleased', FALSE,
            'allowStudentScriptDownload', FALSE
        );
    END IF;

    SELECT value INTO v_raw_quiz
    FROM public.app_config
    WHERE key IN ('quiz_by_code_' || v_code, 'quiz_by_code:' || v_code)
    ORDER BY CASE WHEN key = 'quiz_by_code_' || v_code THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_raw_quiz IS NOT NULL AND TRIM(v_raw_quiz) <> '' THEN
        BEGIN
            v_allow_download := COALESCE((v_raw_quiz::jsonb->>'allowStudentScriptDownload')::boolean, FALSE);
        EXCEPTION WHEN OTHERS THEN
            v_allow_download := FALSE;
        END;
    ELSE
        SELECT value INTO v_raw_quiz FROM public.app_config WHERE key = 'published_quizzes' LIMIT 1;
        IF v_raw_quiz IS NOT NULL AND TRIM(v_raw_quiz) <> '' THEN
            BEGIN
                SELECT COALESCE((elem->>'allowStudentScriptDownload')::boolean, FALSE)
                INTO v_allow_download
                FROM jsonb_array_elements(v_raw_quiz::jsonb) WITH ORDINALITY AS arr(elem, ord)
                WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = v_code
                   OR UPPER(TRIM(COALESCE(elem->>'id', ''))) = v_code
                   OR UPPER(TRIM(COALESCE(elem->>'testId', ''))) = v_code
                   OR EXISTS (
                       SELECT 1
                       FROM jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(elem->'previousCodes') = 'array' THEN elem->'previousCodes' ELSE '[]'::jsonb END
                       ) pc
                       WHERE UPPER(TRIM(pc)) = v_code
                   )
                ORDER BY ord ASC
                LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_allow_download := FALSE;
            END;
        END IF;
    END IF;
    v_allow_download := COALESCE(v_allow_download, FALSE);

    SELECT COALESCE(
        jsonb_agg(
            CASE
                WHEN v_allow_download THEN to_jsonb(s) - 'result_pin'
                ELSE (to_jsonb(s) - 'result_pin') || jsonb_build_object(
                    'question_results',
                    COALESCE(
                        (
                            SELECT jsonb_agg(qr - 'questionText' - 'correctAnswer' - 'criteriaBreakdown')
                            FROM jsonb_array_elements(
                                CASE WHEN jsonb_typeof(s.question_results) = 'array' THEN s.question_results ELSE '[]'::jsonb END
                            ) qr
                        ),
                        '[]'::jsonb
                    )
                )
            END
            ORDER BY s.submitted_at DESC NULLS LAST
        ),
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
            'hasUnreleased', COALESCE(v_has_unreleased, FALSE),
            'allowStudentScriptDownload', v_allow_download
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
            'hasUnreleased', FALSE,
            'allowStudentScriptDownload', v_allow_download
        );
    END IF;

    RETURN jsonb_build_object(
        'status', 'ok',
        'submissions', v_rows,
        'hasUnreleased', COALESCE(v_has_unreleased, FALSE),
        'allowStudentScriptDownload', v_allow_download
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'not_found',
        'submissions', '[]'::jsonb,
        'hasUnreleased', FALSE,
        'allowStudentScriptDownload', FALSE
    );
END;
$$;

-- ─── 5. VULN-H4: Enforce Size, Field & Rate Guards on Proctor Audit Logs ─────

CREATE OR REPLACE FUNCTION public.enforce_proctor_audit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_recent_count INT := 0;
BEGIN
    IF public.is_authenticated_teacher() THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.actor, '') <> 'student' THEN
        RAISE EXCEPTION 'Students may only write actor=student audit events.' USING ERRCODE = '42501';
    END IF;

    IF LENGTH(TRIM(COALESCE(NEW.quiz_code, ''))) NOT BETWEEN 2 AND 32
       OR LENGTH(TRIM(COALESCE(NEW.student_id, ''))) NOT BETWEEN 1 AND 120
       OR LENGTH(TRIM(COALESCE(NEW.student_name, ''))) NOT BETWEEN 1 AND 120
       OR LENGTH(TRIM(COALESCE(NEW.event_type, ''))) NOT BETWEEN 2 AND 64 THEN
        RAISE EXCEPTION 'Invalid proctor audit event field lengths.' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(NEW.severity, '') NOT IN ('info', 'warning', 'critical') THEN
        RAISE EXCEPTION 'Invalid proctor audit severity.' USING ERRCODE = '22023';
    END IF;

    IF OCTET_LENGTH(COALESCE(NEW.detail, '')) > 1024 THEN
        RAISE EXCEPTION 'Proctor audit detail exceeds 1024-byte cap.' USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*) INTO v_recent_count
    FROM public.proctor_audit_events e
    WHERE UPPER(TRIM(e.quiz_code)) = UPPER(TRIM(NEW.quiz_code))
      AND LOWER(TRIM(e.student_id)) = LOWER(TRIM(NEW.student_id))
      AND e.created_at >= NOW() - INTERVAL '10 minutes';

    IF v_recent_count >= 60 THEN
        RAISE EXCEPTION 'Proctor audit event rate limit exceeded.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_proctor_audit_guard ON public.proctor_audit_events;
CREATE TRIGGER trg_enforce_proctor_audit_guard
    BEFORE INSERT ON public.proctor_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_proctor_audit_guard();

-- ─── 6. Permissions for Updated RPC Signatures ───────────────────────────────

GRANT EXECUTE ON FUNCTION public.save_student_exam_draft(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_draft(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_student_exam_draft(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_student_exam_result(TEXT, TEXT, TEXT) TO anon, authenticated;

