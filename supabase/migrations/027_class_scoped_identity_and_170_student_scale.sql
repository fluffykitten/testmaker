-- ============================================================================
-- Migration 027: Class-Scoped Same-Name Attempt Identity & 170-Student Scale
-- ============================================================================
-- Combines:
--   1. HOT-update fillfactor tuning on `app_config` & `exam_draft_locks`,
--      plus functional indexes for proctor audit rate guards and class-scoped
--      attempt checks.
--   2. Conditional lock-table touch inside `save_student_exam_draft` so repeating
--      cloud draft saves with the same owner token only refresh
--      `exam_draft_locks.updated_at` at most once every 10 minutes (~95% fewer
--      lock writes during a 60-minute exam).
--   3. Class-scoped homonym disambiguation in `check_student_attempt_submitted`
--      and `submit_student_exam_attempt` using `normalize_roster_class_label`
--      so same-name students in different classes never collide or inherit
--      another class's draft lock / duplicate-attempt rejection.
--   4. Support for Practice Mode `'graded'` status in `submit_student_exam_attempt`.
--   5. Stale draft cleanup RPC (`cleanup_stale_exam_drafts`) for teachers.
-- ============================================================================

-- ─── 1. Table & Index Optimizations for 170+ Concurrency ─────────────────────

ALTER TABLE public.app_config SET (fillfactor = 70);
ALTER TABLE public.exam_draft_locks SET (fillfactor = 70);

CREATE INDEX IF NOT EXISTS idx_proctor_audit_guard_lookup
    ON public.proctor_audit_events (
        UPPER(TRIM(quiz_code)),
        LOWER(TRIM(student_id)),
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_quiz_submissions_attempt_class_lookup
    ON public.quiz_submissions (
        UPPER(TRIM(quiz_code)),
        LOWER(TRIM(student_name)),
        public.normalize_roster_class_label(student_class)
    );

-- ─── 2. Optimize `save_student_exam_draft` Lock Write Amplification ──────────

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

    -- Skip redundant lock-table writes when the same owner token was refreshed within the last 10 minutes
    IF NOT FOUND
       OR v_existing_hash IS DISTINCT FROM v_hash
       OR v_existing_ts IS NULL
       OR v_existing_ts < (NOW() - INTERVAL '10 minutes') THEN
        INSERT INTO public.exam_draft_locks (draft_key, owner_token_hash, updated_at)
        VALUES (p_key, v_hash, NOW())
        ON CONFLICT (draft_key) DO UPDATE
        SET owner_token_hash = EXCLUDED.owner_token_hash,
            updated_at = NOW();
    END IF;

    -- Schema of app_config is (key, value) only — never reference updated_at here
    INSERT INTO public.app_config (key, value)
    VALUES (p_key, COALESCE(p_value, ''))
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value;

    RETURN TRUE;
END;
$$;

-- ─── 3. Class-Normalized `check_student_attempt_submitted` ───────────────────

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
    v_class TEXT := public.normalize_roster_class_label(p_student_class);
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
          OR public.normalize_roster_class_label(s.student_class) = v_class
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

-- ─── 4. Class-Scoped `submit_student_exam_attempt` ───────────────────────────

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
    v_norm_class TEXT := public.normalize_roster_class_label(v_student_class);
    v_norm_number TEXT := LOWER(TRIM(COALESCE(v_candidate_number, '')));
    v_result_pin TEXT := TRIM(COALESCE(p_row->>'result_pin', ''));
    v_student_pin TEXT := TRIM(COALESCE(p_row->>'student_pin', ''));
    v_owner_token TEXT := TRIM(COALESCE(p_row->>'draft_owner_token', ''));
    v_owner_token_hash TEXT;
    v_draft_key TEXT;
    v_lock_hash TEXT := NULL;
    v_raw_quiz TEXT;
    v_quiz JSONB := NULL;
    v_is_exam_mode BOOLEAN := TRUE;
    v_limit_one_attempt BOOLEAN := TRUE;
    v_require_student_pin BOOLEAN := FALSE;
    v_duration_sec INT;
    v_violations_count INT;
    v_total_marks NUMERIC;
    v_score NUMERIC;
    v_percentage NUMERIC;
    v_q_results JSONB := COALESCE(p_row->'question_results', '[]'::jsonb);
    v_affected INT := 0;
    v_slug_name TEXT;
    v_slug_class TEXT;
    v_requested_status TEXT;
    v_final_status TEXT;
BEGIN
    IF p_row IS NULL OR v_id = '' OR v_quiz_code = '' OR LENGTH(v_id) > 120 THEN
        RETURN FALSE;
    END IF;

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
        v_require_student_pin := COALESCE((v_quiz->>'requireStudentPin')::boolean, FALSE);
    END IF;

    -- Strictly enforce roster PIN when quiz requires it (rejecting unregistered candidates),
    -- or verify if a roster PIN was explicitly supplied.
    IF (v_require_student_pin OR v_student_pin <> '') THEN
        IF NOT public.verify_roster_pin_if_enrolled(v_student_name, v_student_class, v_candidate_number, v_student_pin, v_require_student_pin) THEN
            RETURN FALSE;
        END IF;
    END IF;

    v_slug_name := REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(v_student_name)), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g');
    v_slug_class := REGEXP_REPLACE(REGEXP_REPLACE(v_norm_class, '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g');

    -- Enforce draft-lock ownership when an active draft lock exists for this candidate
    v_draft_key := COALESCE(
        NULLIF(TRIM(COALESCE(p_row->>'draft_key', '')), ''),
        CASE
            WHEN v_student_pin <> '' AND v_slug_name <> '' THEN
                'draft_' || v_quiz_code || '_' || v_slug_name || '__' || REGEXP_REPLACE(LOWER(v_student_pin), '[^a-z0-9_-]', '_', 'g')
            WHEN v_slug_name <> '' AND v_slug_class <> '' THEN
                'draft_' || v_quiz_code || '_' || v_slug_name || '__cls_' || v_slug_class
            ELSE
                'draft_' || v_quiz_code || '_' || REGEXP_REPLACE(
                    LOWER(TRIM(COALESCE(NULLIF(v_student_pin, ''), v_student_name))),
                    '[^a-z0-9_-]',
                    '_',
                    'g'
                )
        END
    );

    SELECT owner_token_hash INTO v_lock_hash
    FROM public.exam_draft_locks
    WHERE draft_key = v_draft_key
    LIMIT 1;

    -- Only check legacy un-classed / PIN-only lock keys when a Personal Exam PIN was supplied
    -- so homonyms without PINs in different classes never cross-match each other's locks.
    IF v_lock_hash IS NULL AND v_student_pin <> '' THEN
        SELECT owner_token_hash INTO v_lock_hash
        FROM public.exam_draft_locks
        WHERE draft_key IN (
            'draft_' || v_quiz_code || '_' || REGEXP_REPLACE(LOWER(v_student_pin), '[^a-z0-9_-]', '_', 'g'),
            'draft_' || v_quiz_code || '_' || REGEXP_REPLACE(LOWER(v_student_name), '[^a-z0-9_-]', '_', 'g')
        )
        LIMIT 1;
    END IF;

    IF v_lock_hash IS NOT NULL THEN
        IF v_owner_token = '' THEN
            RAISE EXCEPTION 'Active exam session belongs to another device. Please submit from the active exam device or ask the teacher to unlock.' USING ERRCODE = '42501';
        END IF;
        v_owner_token_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_owner_token, 'UTF8')), 'hex'));
        IF v_owner_token_hash <> v_lock_hash THEN
            RAISE EXCEPTION 'Active exam session belongs to another device. Please submit from the active exam device or ask the teacher to unlock.' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Enforce single-attempt lock server-side scoped by normalized class
    IF v_limit_one_attempt AND v_norm_name <> '' THEN
        IF EXISTS (
            SELECT 1
            FROM public.quiz_submissions s
            WHERE UPPER(TRIM(s.quiz_code)) = v_quiz_code
              AND s.id <> v_id
              AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_norm_name
              AND (
                  v_norm_class = ''
                  OR COALESCE(TRIM(s.student_class), '') = ''
                  OR public.normalize_roster_class_label(s.student_class) = v_norm_class
              )
              AND (
                  v_norm_number = ''
                  OR COALESCE(TRIM(s.candidate_number), '') = ''
                  OR LOWER(TRIM(COALESCE(s.candidate_number, ''))) = v_norm_number
              )
        ) THEN
            RETURN FALSE;
        END IF;
    END IF;

    v_duration_sec := GREATEST(0, LEAST(86400, COALESCE(NULLIF(p_row->>'duration_seconds', '')::int, 0)));
    v_violations_count := GREATEST(0, LEAST(1000, COALESCE(NULLIF(p_row->>'violations_count', '')::int, 0)));
    v_total_marks := GREATEST(0, LEAST(10000, COALESCE(NULLIF(p_row->>'total_marks', '')::numeric, 0)));

    v_requested_status := LOWER(TRIM(COALESCE(NULLIF(p_row->>'status', ''), 'submitted')));
    IF v_requested_status NOT IN ('submitted', 'graded')
       OR (v_is_exam_mode AND v_requested_status <> 'submitted')
       OR COALESCE(NULLIF(p_row->>'teacher_adjusted_marks', '')::numeric, 0) <> 0
       OR (v_total_marks > 0 AND COALESCE(NULLIF(p_row->>'score', '')::numeric, 0) > v_total_marks)
       OR COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0) > 100 THEN
        RETURN FALSE;
    END IF;
    v_final_status := CASE WHEN v_is_exam_mode THEN 'submitted' ELSE v_requested_status END;

    IF v_is_exam_mode THEN
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
        v_score := GREATEST(0, LEAST(GREATEST(v_total_marks, 0), COALESCE(NULLIF(p_row->>'score', '')::numeric, 0)));
        v_percentage := GREATEST(0, LEAST(100, COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0)));
    END IF;

    INSERT INTO public.quiz_submissions (
        id, quiz_id, quiz_code, quiz_title, subject,
        student_name, student_class, candidate_number, submitted_at, duration_seconds,
        score, total_marks, percentage, violations_count, proctoring_logs,
        raw_answers, question_results, topic_breakdown, status,
        teacher_adjusted_marks, teacher_notes, result_pin, updated_at
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
        v_final_status,
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
        status = EXCLUDED.status,
        teacher_adjusted_marks = 0,
        updated_at = NOW()
    WHERE public.quiz_submissions.status IN ('submitted', 'graded')
      AND NULLIF(TRIM(public.quiz_submissions.result_pin), '') IS NOT NULL
      AND TRIM(public.quiz_submissions.result_pin) = v_result_pin;

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    RETURN v_affected > 0;
EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE;
WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- ─── 5. Stale Draft Cleanup RPC ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_stale_exam_drafts(
    p_retention_hours INT DEFAULT 48
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cutoff TIMESTAMPTZ := NOW() - make_interval(hours => GREATEST(1, COALESCE(p_retention_hours, 48)));
    v_deleted_locks INT := 0;
    v_deleted_configs INT := 0;
BEGIN
    IF NOT public.is_authenticated_teacher() THEN
        RAISE EXCEPTION 'Teacher authentication required.' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.exam_draft_locks
    WHERE updated_at < v_cutoff;
    GET DIAGNOSTICS v_deleted_locks = ROW_COUNT;

    DELETE FROM public.app_config c
    WHERE c.key LIKE 'draft_%'
      AND NOT EXISTS (
          SELECT 1
          FROM public.exam_draft_locks l
          WHERE l.draft_key = c.key
      );
    GET DIAGNOSTICS v_deleted_configs = ROW_COUNT;

    RETURN v_deleted_locks + v_deleted_configs;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_student_exam_draft(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_student_attempt_submitted(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_exam_drafts(INT) TO authenticated;
