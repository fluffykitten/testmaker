-- ============================================================================
-- Migration 037: 90-Minute Exam Paper Cache, Schedule-Safe Admin Pre-Warming,
--                & Unified `enter_student_exam_session` Start RPC
-- ============================================================================
-- Goals (zero reduction in anti-tamper, PIN, single-attempt, or RLS security):
--   1. Extend `exam_paper_cache` TTL from 5 minutes to 90 minutes (`INTERVAL
--      '90 minutes'`). Invalidation triggers on `app_config`, `questions`, and
--      `custom_tests` already purge modified entries immediately, and live
--      `scheduled_start_at` / `scheduled_end_at` bounds are still re-checked on
--      every request.
--   2. Preserve pre-warmed `exam_paper_cache` rows while an exam is in the
--      `'scheduled'` waiting room (before `scheduledStartAt`) so unlocking at
--      `HH:MM:00` serves 170+ students directly from warm cache without a cold
--      build stampede. (`'paused'` / `'closed'` still never serve questions.)
--   3. Add authenticated-teacher-only `prewarm_exam_paper_cache(p_quiz_codes)`
--      so Admin / Quiz Manager can warm all active & scheduled exams (e.g.,
--      `ICM-1`..`ICM-13`) ahead of exam start.
--   4. Add unified `enter_student_exam_session(p_payload)` RPC combining:
--        - Authoritative server `verify_student_pin` + brute-force rate limit
--        - Single-attempt check (`check_student_attempt_submitted`)
--        - Atomic `exam_draft_locks` owner-token verification / acquisition
--        - Cloud `app_config` draft lookup (only after PIN & lock succeed)
--      reducing 4 sequential/speculative lobby/start RPCs (~680 calls) down to
--      1 atomic Postgres round-trip (~170 calls).
-- ============================================================================

-- ─── 1. Shared Private Helper: Compile & Cache Sanitized Exam Paper ──────────

CREATE OR REPLACE FUNCTION public._compile_and_cache_exam_paper(
    p_code TEXT,
    p_allow_scheduled BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT := UPPER(TRIM(COALESCE(p_code, '')));
    v_now TIMESTAMPTZ := NOW();
    v_raw TEXT;
    v_quiz JSONB := NULL;
    v_header_inline JSONB := '{}'::jsonb;
    v_is_active BOOLEAN := TRUE;
    v_quiz_mode TEXT := 'exam';
    v_scheduled_start TIMESTAMPTZ := NULL;
    v_scheduled_end TIMESTAMPTZ := NULL;
    v_schedule_status TEXT := 'active';
    v_test_id TEXT;
    v_test_row RECORD;
    v_test_meta JSONB := NULL;
    v_header_raw TEXT;
    v_header_cloud JSONB := '{}'::jsonb;
    v_overrides JSONB := '{}'::jsonb;
    v_header_clean JSONB;
    v_qids TEXT[] := ARRAY[]::TEXT[];
    v_strip_keys BOOLEAN := TRUE;
    v_questions JSONB := '[]'::jsonb;
    v_school_classes JSONB := NULL;
    v_security_tiers JSONB := NULL;
    v_hide_emergency_btn BOOLEAN := NULL;
    v_cfg_row RECORD;
    v_result JSONB;
BEGIN
    IF v_code = '' THEN
        RETURN jsonb_build_object('status', 'not_found');
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
        RETURN jsonb_build_object('status', 'not_found');
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
    v_quiz_mode := LOWER(COALESCE(NULLIF(TRIM(v_quiz->>'quizMode'), ''), 'exam'));

    IF NULLIF(TRIM(COALESCE(v_quiz->>'scheduledStartAt', '')), '') IS NOT NULL THEN
        BEGIN
            v_scheduled_start := (v_quiz->>'scheduledStartAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            v_scheduled_start := NULL;
        END;
    END IF;

    IF NULLIF(TRIM(COALESCE(v_quiz->>'scheduledEndAt', '')), '') IS NOT NULL THEN
        BEGIN
            v_scheduled_end := (v_quiz->>'scheduledEndAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            v_scheduled_end := NULL;
        END;
    END IF;

    IF NOT v_is_active THEN
        v_schedule_status := 'paused';
    ELSIF v_quiz_mode <> 'game' THEN
        IF v_scheduled_start IS NOT NULL AND v_now < v_scheduled_start THEN
            v_schedule_status := 'scheduled';
        ELSIF v_scheduled_end IS NOT NULL AND v_now > v_scheduled_end THEN
            v_schedule_status := 'closed';
        ELSE
            v_schedule_status := 'active';
        END IF;
    ELSE
        v_schedule_status := 'active';
    END IF;

    IF v_schedule_status IN ('paused', 'closed') THEN
        IF EXISTS (SELECT 1 FROM public.exam_paper_cache WHERE quiz_code = v_code) THEN
            DELETE FROM public.exam_paper_cache WHERE quiz_code = v_code;
        END IF;
        RETURN jsonb_build_object(
            'status', v_schedule_status,
            'scheduleStatus', v_schedule_status,
            'publishedQuiz', v_quiz,
            'serverNow', v_now
        );
    END IF;

    IF v_schedule_status = 'scheduled' AND NOT COALESCE(p_allow_scheduled, FALSE) THEN
        RETURN jsonb_build_object(
            'status', 'scheduled',
            'scheduleStatus', 'scheduled',
            'publishedQuiz', v_quiz,
            'serverNow', v_now
        );
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('exam_paper_cache:' || v_code));
    v_now := NOW();

    IF NOT COALESCE(p_allow_scheduled, FALSE) THEN
        SELECT c.payload
        INTO v_result
        FROM public.exam_paper_cache c
        WHERE c.quiz_code = v_code
          AND c.cached_at > (v_now - INTERVAL '90 minutes')
          AND (c.scheduled_start_at IS NULL OR v_now >= c.scheduled_start_at)
          AND (c.scheduled_end_at IS NULL OR v_now <= c.scheduled_end_at)
        LIMIT 1;

        IF FOUND AND v_result IS NOT NULL THEN
            RETURN jsonb_build_object(
                'status', 'cached',
                'scheduleStatus', 'active',
                'payload', v_result,
                'serverNow', v_now
            );
        END IF;
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

    FOR v_cfg_row IN
        SELECT key, value
        FROM public.app_config
        WHERE key IN ('school_classes', 'exam_security_tiers', 'hide_emergency_exam_button')
    LOOP
        IF v_cfg_row.value IS NOT NULL AND TRIM(v_cfg_row.value) <> '' THEN
            BEGIN
                IF v_cfg_row.key = 'school_classes' AND jsonb_typeof(v_cfg_row.value::jsonb) = 'array' THEN
                    v_school_classes := v_cfg_row.value::jsonb;
                ELSIF v_cfg_row.key = 'exam_security_tiers' AND jsonb_typeof(v_cfg_row.value::jsonb) = 'array' THEN
                    v_security_tiers := v_cfg_row.value::jsonb;
                ELSIF v_cfg_row.key = 'hide_emergency_exam_button' THEN
                    IF LOWER(TRIM(BOTH '"' FROM TRIM(v_cfg_row.value))) = 'true' THEN
                        v_hide_emergency_btn := TRUE;
                    ELSIF LOWER(TRIM(BOTH '"' FROM TRIM(v_cfg_row.value))) = 'false' THEN
                        v_hide_emergency_btn := FALSE;
                    END IF;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                -- Ignore malformed config value
            END;
        END IF;
    END LOOP;

    v_result := jsonb_build_object(
        'publishedQuiz', v_quiz,
        'customTest', v_test_meta,
        'headerConfig', v_header_clean,
        'teacherPinHash', NULL,
        'isActive', TRUE,
        'scheduleStatus', 'active',
        'serverNow', v_now,
        'questions', v_questions,
        'schoolClasses', v_school_classes,
        'securityTiers', v_security_tiers,
        'hideEmergencyExamButton', v_hide_emergency_btn
    );

    INSERT INTO public.exam_paper_cache (
        quiz_code, strip_keys, scheduled_start_at, scheduled_end_at, payload, cached_at
    )
    VALUES (
        v_code,
        v_strip_keys,
        CASE WHEN v_quiz_mode <> 'game' THEN v_scheduled_start ELSE NULL END,
        CASE WHEN v_quiz_mode <> 'game' THEN v_scheduled_end ELSE NULL END,
        v_result,
        v_now
    )
    ON CONFLICT (quiz_code) DO UPDATE
    SET strip_keys = EXCLUDED.strip_keys,
        scheduled_start_at = EXCLUDED.scheduled_start_at,
        scheduled_end_at = EXCLUDED.scheduled_end_at,
        payload = EXCLUDED.payload,
        cached_at = EXCLUDED.cached_at;

    RETURN jsonb_build_object(
        'status', 'cached',
        'scheduleStatus', v_schedule_status,
        'payload', v_result,
        'serverNow', v_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public._compile_and_cache_exam_paper(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ─── 2. 90-Minute `get_student_exam_paper` (Preserving Scheduled Cache) ───────

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
    v_now TIMESTAMPTZ := NOW();
    v_cache_row RECORD;
    v_compiled JSONB;
    v_status TEXT;
BEGIN
    IF v_code = '' THEN
        RETURN NULL;
    END IF;

    -- Fast path: check 90-minute cache first (handles both active hits & scheduled waits without touching app_config)
    SELECT c.payload, c.cached_at, c.scheduled_start_at, c.scheduled_end_at
    INTO v_cache_row
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_code
      AND c.cached_at > (v_now - INTERVAL '90 minutes')
    LIMIT 1;

    IF FOUND AND v_cache_row.payload IS NOT NULL THEN
        IF v_cache_row.scheduled_start_at IS NOT NULL AND v_now < v_cache_row.scheduled_start_at THEN
            -- Keep pre-warmed cache row intact while blocking questions until scheduled_start_at
            RETURN jsonb_build_object(
                'publishedQuiz', v_cache_row.payload->'publishedQuiz',
                'teacherPinHash', NULL,
                'isActive', FALSE,
                'scheduleStatus', 'scheduled',
                'serverNow', v_now,
                'questions', '[]'::jsonb
            );
        END IF;

        IF v_cache_row.scheduled_end_at IS NOT NULL AND v_now > v_cache_row.scheduled_end_at THEN
            DELETE FROM public.exam_paper_cache WHERE quiz_code = v_code;
            RETURN jsonb_build_object(
                'publishedQuiz', v_cache_row.payload->'publishedQuiz',
                'teacherPinHash', NULL,
                'isActive', FALSE,
                'scheduleStatus', 'closed',
                'serverNow', v_now,
                'questions', '[]'::jsonb
            );
        END IF;

        RETURN v_cache_row.payload || jsonb_build_object(
            'scheduleStatus', 'active',
            'serverNow', v_now,
            'publicRosterDirectory', public.get_public_roster_directory()
        );
    END IF;

    v_compiled := public._compile_and_cache_exam_paper(v_code, FALSE);
    v_status := COALESCE(v_compiled->>'status', 'not_found');

    IF v_status = 'not_found' THEN
        RETURN NULL;
    END IF;

    IF v_status IN ('paused', 'closed', 'scheduled') THEN
        RETURN jsonb_build_object(
            'publishedQuiz', v_compiled->'publishedQuiz',
            'teacherPinHash', NULL,
            'isActive', FALSE,
            'scheduleStatus', COALESCE(v_compiled->>'scheduleStatus', v_status),
            'serverNow', COALESCE((v_compiled->>'serverNow')::timestamptz, v_now),
            'questions', '[]'::jsonb
        );
    END IF;

    RETURN (v_compiled->'payload') || jsonb_build_object(
        'scheduleStatus', 'active',
        'serverNow', COALESCE((v_compiled->>'serverNow')::timestamptz, v_now),
        'publicRosterDirectory', public.get_public_roster_directory()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;

-- ─── 3. Teacher-Only Admin Pre-Warm RPC (Active + Scheduled Exams) ────────────

CREATE OR REPLACE FUNCTION public.prewarm_exam_paper_cache(
    p_quiz_codes TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
    v_compiled JSONB;
    v_status TEXT;
    v_warmed TEXT[] := ARRAY[]::TEXT[];
    v_skipped TEXT[] := ARRAY[]::TEXT[];
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT public.is_authenticated_teacher() THEN
        RAISE EXCEPTION 'Educator authentication required to pre-warm exam cache.'
            USING ERRCODE = '42501';
    END IF;

    -- Also keep the indexed roster directory meta warm alongside papers
    IF NOT EXISTS (SELECT 1 FROM public.school_roster_meta WHERE singleton_id = 1) THEN
        PERFORM public.rebuild_school_roster_cache();
    END IF;

    IF p_quiz_codes IS NULL OR array_length(p_quiz_codes, 1) IS NULL THEN
        RETURN jsonb_build_object(
            'warmedCodes', to_jsonb(v_warmed),
            'skippedCodes', to_jsonb(v_skipped),
            'missingCodes', to_jsonb(v_missing),
            'warmedCount', 0,
            'ttlMinutes', 90,
            'cachedAt', NOW()
        );
    END IF;

    FOR v_code IN
        SELECT DISTINCT UPPER(TRIM(c))
        FROM unnest(p_quiz_codes) AS c
        WHERE TRIM(COALESCE(c, '')) <> ''
        ORDER BY 1
    LOOP
        v_compiled := public._compile_and_cache_exam_paper(v_code, TRUE);
        v_status := COALESCE(v_compiled->>'status', 'not_found');

        IF v_status = 'cached' THEN
            v_warmed := array_append(v_warmed, v_code);
        ELSIF v_status IN ('paused', 'closed') THEN
            v_skipped := array_append(v_skipped, v_code);
        ELSE
            v_missing := array_append(v_missing, v_code);
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'warmedCodes', to_jsonb(v_warmed),
        'skippedCodes', to_jsonb(v_skipped),
        'missingCodes', to_jsonb(v_missing),
        'warmedCount', COALESCE(array_length(v_warmed, 1), 0),
        'ttlMinutes', 90,
        'cachedAt', NOW()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.prewarm_exam_paper_cache(TEXT[]) TO anon, authenticated;

-- ─── 4. Unified Atomic Exam Entry RPC (`enter_student_exam_session`) ────────

CREATE OR REPLACE FUNCTION public.enter_student_exam_session(
    p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_quiz_code TEXT := UPPER(TRIM(COALESCE(p_payload->>'quiz_code', '')));
    v_student_name TEXT := TRIM(COALESCE(p_payload->>'student_name', ''));
    v_student_class TEXT := TRIM(COALESCE(p_payload->>'student_class', ''));
    v_candidate_number TEXT := TRIM(COALESCE(p_payload->>'candidate_number', ''));
    v_student_pin TEXT := TRIM(COALESCE(p_payload->>'student_pin', ''));
    v_draft_key TEXT := TRIM(COALESCE(p_payload->>'draft_key', ''));
    v_owner_token TEXT := NULLIF(TRIM(COALESCE(p_payload->>'draft_owner_token', '')), '');
    v_require_student_pin BOOLEAN := COALESCE((p_payload->>'require_student_pin')::boolean, FALSE);
    v_limit_one_attempt BOOLEAN := COALESCE((p_payload->>'limit_one_attempt')::boolean, TRUE);
    v_acquire_lock BOOLEAN := COALESCE((p_payload->>'acquire_lock')::boolean, TRUE);
    v_raw_quiz TEXT;
    v_quiz JSONB := NULL;
    v_pin_res JSONB := NULL;
    v_student_obj JSONB := NULL;
    v_attempt_res JSONB := NULL;
    v_hash TEXT;
    v_existing_hash TEXT;
    v_existing_ts TIMESTAMPTZ;
    v_lock_found BOOLEAN := FALSE;
    v_lock_acquired BOOLEAN := FALSE;
    v_draft_val TEXT := NULL;
BEGIN
    IF v_quiz_code = '' OR v_student_name = '' THEN
        RETURN jsonb_build_object(
            'status', 'invalid_input',
            'error', 'Candidate name and exam code are required.'
        );
    END IF;

    -- Resolve authoritative security flags server-side (never trust client spoofing)
    SELECT c.payload->'publishedQuiz'
    INTO v_quiz
    FROM public.exam_paper_cache c
    WHERE c.quiz_code = v_quiz_code
    LIMIT 1;

    IF v_quiz IS NULL THEN
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
            SELECT value INTO v_raw_quiz
            FROM public.app_config
            WHERE key = 'published_quizzes'
            LIMIT 1;

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
    END IF;

    IF v_quiz IS NOT NULL THEN
        v_require_student_pin := COALESCE((v_quiz->>'requireStudentPin')::boolean, FALSE);
        v_limit_one_attempt := COALESCE((v_quiz->>'limitOneAttempt')::boolean, TRUE);
    END IF;

    -- 1. Personal 4-digit PIN verification + brute-force rate limit
    IF v_require_student_pin THEN
        v_pin_res := public.verify_student_pin(v_student_name, v_student_class, v_student_pin);
        IF COALESCE((v_pin_res->>'valid')::boolean, FALSE) IS NOT TRUE THEN
            RETURN jsonb_build_object(
                'status', CASE WHEN COALESCE((v_pin_res->>'unconfigured')::boolean, FALSE) THEN 'pin_unconfigured' ELSE 'invalid_pin' END,
                'valid', FALSE,
                'unconfigured', COALESCE((v_pin_res->>'unconfigured')::boolean, FALSE),
                'error', COALESCE(v_pin_res->>'error', 'Invalid candidate name or PIN.')
            );
        END IF;
        v_student_obj := v_pin_res->'student';
        IF v_candidate_number = '' AND v_student_obj IS NOT NULL THEN
            v_candidate_number := TRIM(COALESCE(v_student_obj->>'candidateNumber', ''));
        END IF;
    END IF;

    -- 2. Single-attempt enforcement (class-normalized & homonym-safe)
    IF v_limit_one_attempt THEN
        v_attempt_res := public.check_student_attempt_submitted(
            v_quiz_code,
            v_student_name,
            NULLIF(v_student_class, ''),
            NULLIF(v_candidate_number, '')
        );
        IF COALESCE((v_attempt_res->>'submitted')::boolean, FALSE) IS TRUE THEN
            RETURN jsonb_build_object(
                'status', 'already_submitted',
                'valid', TRUE,
                'submitted', TRUE,
                'submissionId', v_attempt_res->>'submissionId',
                'submittedAt', v_attempt_res->>'submittedAt',
                'student', v_student_obj
            );
        END IF;
    END IF;

    -- 3. Draft lock check / atomic acquisition + cloud draft fetch
    IF v_draft_key LIKE 'draft_%' AND LENGTH(v_draft_key) BETWEEN 8 AND 180 AND v_owner_token IS NOT NULL THEN
        v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_owner_token, 'UTF8')), 'hex'));

        SELECT owner_token_hash, updated_at
        INTO v_existing_hash, v_existing_ts
        FROM public.exam_draft_locks
        WHERE draft_key = v_draft_key
        LIMIT 1;
        v_lock_found := FOUND;

        IF v_lock_found AND v_existing_ts > (NOW() - INTERVAL '24 hours') AND v_existing_hash <> v_hash THEN
            RETURN jsonb_build_object(
                'status', 'locked_other_device',
                'valid', TRUE,
                'submitted', FALSE,
                'student', v_student_obj,
                'error', 'Active exam session belongs to another device. Please resume from your active exam device or ask the teacher to unlock.'
            );
        END IF;

        SELECT value INTO v_draft_val
        FROM public.app_config
        WHERE key = v_draft_key
        LIMIT 1;

        IF v_acquire_lock AND (
            NOT v_lock_found
            OR v_existing_hash IS DISTINCT FROM v_hash
            OR v_existing_ts IS NULL
            OR v_existing_ts < (NOW() - INTERVAL '10 minutes')
        ) THEN
            INSERT INTO public.exam_draft_locks (draft_key, owner_token_hash, updated_at)
            VALUES (v_draft_key, v_hash, NOW())
            ON CONFLICT (draft_key) DO UPDATE
            SET owner_token_hash = EXCLUDED.owner_token_hash,
                updated_at = NOW()
            WHERE public.exam_draft_locks.owner_token_hash = EXCLUDED.owner_token_hash
               OR public.exam_draft_locks.updated_at IS NULL
               OR public.exam_draft_locks.updated_at <= (NOW() - INTERVAL '24 hours')
            RETURNING TRUE INTO v_lock_acquired;

            IF NOT COALESCE(v_lock_acquired, FALSE) THEN
                RETURN jsonb_build_object(
                    'status', 'locked_other_device',
                    'valid', TRUE,
                    'submitted', FALSE,
                    'student', v_student_obj,
                    'error', 'Active exam session belongs to another device. Please resume from your active exam device or ask the teacher to unlock.'
                );
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'status', CASE WHEN NULLIF(TRIM(COALESCE(v_draft_val, '')), '') IS NOT NULL THEN 'draft_found' ELSE 'ready' END,
        'valid', TRUE,
        'submitted', FALSE,
        'student', v_student_obj,
        'draftJson', NULLIF(v_draft_val, '')
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.enter_student_exam_session(JSONB) TO anon, authenticated;
