-- ============================================================================
-- Migration 025: Personal Exam PIN Hardening
-- 1. Normalize ICM class label spacing ("X IPA3" <-> "X IPA 3") in PIN RPCs.
-- 2. Strictly enforce roster PIN verification on submit_student_exam_attempt
--    when requireStudentPin = TRUE (rejecting unregistered candidates).
-- 3. Support composite (student_name + student_pin) draft lock keys cleanly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.normalize_roster_class_label(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_clean TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_raw, '')), '\s+', ' ', 'g'));
    v_match TEXT[];
    v_grade TEXT;
BEGIN
    IF v_clean = '' THEN
        RETURN '';
    END IF;

    v_match := REGEXP_MATCH(v_clean, '^(x|xi|xii|10|11|12)\s*[- ]?\s*(ipa|ips)\s*[- ]?\s*0*(\d+)$');
    IF v_match IS NOT NULL THEN
        v_grade := CASE v_match[1]
            WHEN '10' THEN 'x'
            WHEN '11' THEN 'xi'
            WHEN '12' THEN 'xii'
            ELSE v_match[1]
        END;
        RETURN v_grade || ' ' || v_match[2] || ' ' || v_match[3];
    END IF;

    RETURN v_clean;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_roster_class_label(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_student_pin(
    p_name TEXT,
    p_class TEXT DEFAULT NULL,
    p_pin TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_roster_json TEXT;
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := public.normalize_roster_class_label(p_class);
    v_clean_pin TEXT := TRIM(COALESCE(p_pin, ''));
    v_scope TEXT := 'student_pin:' || v_clean_name || '::' || v_clean_class;
    v_matched JSONB := NULL;
BEGIN
    IF v_clean_name = '' THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Candidate full name is required.');
    END IF;

    IF NOT public.check_rate_limit(v_scope, 10, 600) THEN
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Too many failed PIN attempts. Please wait 10 minutes or verify your PIN with the invigilator.'
        );
    END IF;

    IF v_clean_pin = '' OR LENGTH(v_clean_pin) <> 4 THEN
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object('valid', false, 'error', 'Please enter a valid 4-digit PIN.');
    END IF;

    SELECT value INTO v_roster_json FROM public.app_config WHERE key = 'school_roster' LIMIT 1;
    IF v_roster_json IS NULL OR TRIM(v_roster_json) = '' OR TRIM(v_roster_json) = '[]' THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster not configured in database.');
    END IF;

    BEGIN
        SELECT elem INTO v_matched
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'name', '')), '\s+', ' ', 'g')) = v_clean_name
          AND (v_clean_class = '' OR public.normalize_roster_class_label(elem->>'class') = v_clean_class)
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster data is invalid or corrupt in database.');
    END;

    IF v_matched IS NULL THEN
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Candidate "' || TRIM(p_name) || '" was not found in the school roster' ||
                     CASE WHEN v_clean_class <> '' THEN ' for class ' || TRIM(p_class) ELSE '' END ||
                     '. Please check your spelling or verify with your teacher.'
        );
    END IF;

    IF TRIM(COALESCE(v_matched->>'pin', '')) <> v_clean_pin THEN
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object(
            'valid', false,
            'error', 'Incorrect 4-digit PIN for ' || (v_matched->>'name') || '. Please verify with your teacher.'
        );
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    RETURN jsonb_build_object(
        'valid', true,
        'student', jsonb_build_object(
            'id', v_matched->>'id',
            'name', v_matched->>'name',
            'class', v_matched->>'class',
            'candidateNumber', v_matched->>'candidateNumber'
        )
    );
END;
$$;

DROP FUNCTION IF EXISTS public.verify_roster_pin_if_enrolled(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.verify_roster_pin_if_enrolled(
    p_student_name TEXT,
    p_student_class TEXT DEFAULT NULL,
    p_candidate_number TEXT DEFAULT NULL,
    p_student_pin TEXT DEFAULT NULL,
    p_require_enrolled BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_roster_json TEXT;
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := public.normalize_roster_class_label(p_student_class);
    v_clean_pin TEXT := TRIM(COALESCE(p_student_pin, ''));
    v_matched JSONB := NULL;
    v_stored_pin TEXT;
BEGIN
    IF v_clean_name = '' THEN
        RETURN NOT p_require_enrolled;
    END IF;

    IF p_require_enrolled AND (v_clean_pin = '' OR LENGTH(v_clean_pin) <> 4) THEN
        RETURN FALSE;
    END IF;

    SELECT value INTO v_roster_json FROM public.app_config WHERE key = 'school_roster' LIMIT 1;
    IF v_roster_json IS NULL OR TRIM(v_roster_json) = '' OR TRIM(v_roster_json) = '[]' THEN
        RETURN NOT p_require_enrolled;
    END IF;

    BEGIN
        SELECT elem INTO v_matched
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'name', '')), '\s+', ' ', 'g')) = v_clean_name
          AND (
              v_clean_class = ''
              OR TRIM(COALESCE(elem->>'class', '')) = ''
              OR public.normalize_roster_class_label(elem->>'class') = v_clean_class
          )
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RETURN NOT p_require_enrolled;
    END;

    IF v_matched IS NULL THEN
        RETURN NOT p_require_enrolled;
    END IF;

    v_stored_pin := TRIM(COALESCE(v_matched->>'pin', ''));
    IF v_stored_pin = '' THEN
        RETURN NOT p_require_enrolled;
    END IF;

    RETURN v_stored_pin = v_clean_pin;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_roster_pin_if_enrolled(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

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

    -- Enforce draft-lock ownership when an active draft lock exists for this candidate
    v_draft_key := COALESCE(
        NULLIF(TRIM(COALESCE(p_row->>'draft_key', '')), ''),
        CASE
            WHEN v_student_pin <> '' AND v_slug_name <> '' THEN
                'draft_' || v_quiz_code || '_' || v_slug_name || '__' || REGEXP_REPLACE(LOWER(v_student_pin), '[^a-z0-9_-]', '_', 'g')
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

    -- Enforce single-attempt lock server-side
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

    v_duration_sec := GREATEST(0, LEAST(86400, COALESCE(NULLIF(p_row->>'duration_seconds', '')::int, 0)));
    v_violations_count := GREATEST(0, LEAST(1000, COALESCE(NULLIF(p_row->>'violations_count', '')::int, 0)));
    v_total_marks := GREATEST(0, LEAST(10000, COALESCE(NULLIF(p_row->>'total_marks', '')::numeric, 0)));

    IF LOWER(TRIM(COALESCE(NULLIF(p_row->>'status', ''), 'submitted'))) <> 'submitted'
       OR COALESCE(NULLIF(p_row->>'teacher_adjusted_marks', '')::numeric, 0) <> 0
       OR (v_total_marks > 0 AND COALESCE(NULLIF(p_row->>'score', '')::numeric, 0) > v_total_marks)
       OR COALESCE(NULLIF(p_row->>'percentage', '')::numeric, 0) > 100 THEN
        RETURN FALSE;
    END IF;

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

GRANT EXECUTE ON FUNCTION public.verify_student_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;
