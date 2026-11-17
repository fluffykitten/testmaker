-- ============================================================================
-- Migration 027: Exam Session Scheduling Gate (Start / End Entry Window)
-- ============================================================================
-- Upgrades `public.get_student_exam_paper(TEXT)` so Exam Mode (`quizMode <> 'game'`)
-- enforces `scheduledStartAt` and `scheduledEndAt` against Postgres `NOW()` on
-- initial entry, withholding questions outside the window and returning
-- `scheduleStatus` ('active' | 'scheduled' | 'closed' | 'paused') + `serverNow`.
-- Already-started candidates continue uninterrupted for their durationMinutes,
-- and `submit_student_exam_attempt` continues accepting their submissions.
-- ============================================================================

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
    v_is_active BOOLEAN;
    v_quiz_mode TEXT;
    v_scheduled_start TIMESTAMPTZ := NULL;
    v_scheduled_end TIMESTAMPTZ := NULL;
    v_schedule_status TEXT := 'active';
    v_now TIMESTAMPTZ := NOW();
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

    IF v_schedule_status <> 'active' THEN
        RETURN jsonb_build_object(
            'publishedQuiz', v_quiz,
            'teacherPinHash', NULL,
            'isActive', FALSE,
            'scheduleStatus', v_schedule_status,
            'serverNow', v_now,
            'questions', '[]'::jsonb
        );
    END IF;

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

    v_strip_keys := (
        COALESCE((v_quiz->>'isExamMode')::boolean, FALSE)
        OR LOWER(COALESCE(v_quiz->>'quizMode', '')) = 'game'
    ) AND NOT COALESCE((v_quiz->>'showInstantSolutions')::boolean, FALSE);

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
        'teacherPinHash', NULL,
        'isActive', TRUE,
        'scheduleStatus', 'active',
        'serverNow', v_now,
        'questions', v_questions
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;
