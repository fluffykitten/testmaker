-- ============================================================================
-- Migration 024: Phase 3B Deep RLS, Rate Limiting, Draft-Lock Guard & Game Security
-- ============================================================================
-- Remediates:
--   1. VULN-P3-03: Strip `teacherPinHash` from `get_student_exam_paper` so
--      offline PIN hash digests never leak to candidate browsers.
--   2. VULN-P3-04: Enable strict RLS on `public.game_profiles`, strip `pin_hash`
--      from RPC responses, add `update_game_profile_student`, and cap
--      `sync_game_match_rewards` (coins <= 500, XP <= 1000).
--   3. VULN-P3-05: Add `security_rate_limits` and lockouts across PIN, teacher
--      login, Master PIN reset, and result lookup RPCs; gate Master PIN reset
--      behind `allow_teacher_account_claiming` or an active teacher session.
--   4. VULN-P3-06: Enforce `verify_roster_pin_if_enrolled` and `exam_draft_locks`
--      owner-token proof in `submit_student_exam_attempt`.
--   5. VULN-P3-08: Strip game-mode answer keys in `get_student_exam_paper` and
--      add `get_student_game_paper` + `check_game_question_answer` RPCs.
-- ============================================================================

-- ─── 1. Server-Side Rate Limiting Table & Internal Helpers (VULN-P3-05) ──────

CREATE TABLE IF NOT EXISTS public.security_rate_limits (
    scope_key TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ
);

ALTER TABLE public.security_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.security_rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_scope_key TEXT,
    p_max_attempts INT,
    p_window_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.security_rate_limits;
BEGIN
    IF COALESCE(TRIM(p_scope_key), '') = '' THEN
        RETURN TRUE;
    END IF;

    SELECT * INTO v_row
    FROM public.security_rate_limits
    WHERE scope_key = p_scope_key
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN TRUE;
    END IF;

    IF v_row.locked_until IS NOT NULL AND v_row.locked_until > NOW() THEN
        RETURN FALSE;
    END IF;

    -- Window elapsed (and any previous lockout expired) -> clear counter
    IF v_row.window_started_at < NOW() - MAKE_INTERVAL(secs => GREATEST(1, p_window_seconds)) THEN
        UPDATE public.security_rate_limits
        SET attempt_count = 0,
            window_started_at = NOW(),
            locked_until = NULL
        WHERE scope_key = p_scope_key;
        RETURN TRUE;
    END IF;

    IF v_row.attempt_count >= GREATEST(1, p_max_attempts) THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_rate_limit_failure(
    p_scope_key TEXT,
    p_max_attempts INT,
    p_window_seconds INT,
    p_lockout_seconds INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_window_cutoff TIMESTAMPTZ := NOW() - MAKE_INTERVAL(secs => GREATEST(1, p_window_seconds));
    v_lock_until TIMESTAMPTZ := NOW() + MAKE_INTERVAL(secs => GREATEST(1, p_lockout_seconds));
    v_max INT := GREATEST(1, p_max_attempts);
BEGIN
    IF COALESCE(TRIM(p_scope_key), '') = '' THEN
        RETURN;
    END IF;

    INSERT INTO public.security_rate_limits (scope_key, attempt_count, window_started_at, locked_until)
    VALUES (
        p_scope_key,
        1,
        NOW(),
        CASE WHEN v_max <= 1 THEN v_lock_until ELSE NULL END
    )
    ON CONFLICT (scope_key) DO UPDATE
    SET attempt_count = CASE
            WHEN public.security_rate_limits.window_started_at < v_window_cutoff
                 AND (public.security_rate_limits.locked_until IS NULL OR public.security_rate_limits.locked_until <= NOW())
                THEN 1
            ELSE public.security_rate_limits.attempt_count + 1
        END,
        window_started_at = CASE
            WHEN public.security_rate_limits.window_started_at < v_window_cutoff
                 AND (public.security_rate_limits.locked_until IS NULL OR public.security_rate_limits.locked_until <= NOW())
                THEN NOW()
            ELSE public.security_rate_limits.window_started_at
        END,
        locked_until = CASE
            WHEN (
                CASE
                    WHEN public.security_rate_limits.window_started_at < v_window_cutoff
                         AND (public.security_rate_limits.locked_until IS NULL OR public.security_rate_limits.locked_until <= NOW())
                        THEN 1
                    ELSE public.security_rate_limits.attempt_count + 1
                END
            ) >= v_max THEN v_lock_until
            WHEN public.security_rate_limits.locked_until IS NOT NULL AND public.security_rate_limits.locked_until > NOW()
                THEN public.security_rate_limits.locked_until
            ELSE NULL
        END;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_rate_limit(
    p_scope_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(TRIM(p_scope_key), '') = '' THEN
        RETURN;
    END IF;

    DELETE FROM public.security_rate_limits
    WHERE scope_key = p_scope_key
       OR (locked_until IS NOT NULL AND locked_until < NOW() - INTERVAL '1 day');
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_rate_limit_failure(TEXT, INT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_rate_limit(TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 2. Rate-Limited Auth, PIN & Result Lookup RPCs (VULN-P3-05) ─────────────

CREATE OR REPLACE FUNCTION public.verify_teacher_access_pin(
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_entered TEXT := TRIM(COALESCE(p_pin, ''));
    v_stored TEXT;
    v_hash TEXT;
    v_ok BOOLEAN := FALSE;
    v_scope TEXT := 'master_pin:global';
BEGIN
    IF v_entered = '' THEN
        RETURN FALSE;
    END IF;

    IF NOT public.check_rate_limit(v_scope, 5, 900) THEN
        RETURN FALSE;
    END IF;

    SELECT TRIM(value) INTO v_stored
    FROM public.app_config
    WHERE key = 'access_pin'
    LIMIT 1;

    IF v_stored IS NULL OR v_stored = '' THEN
        RETURN FALSE;
    END IF;

    v_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_entered, 'UTF8')), 'hex'));

    IF LENGTH(v_stored) = 64 AND v_stored ~ '^[0-9a-fA-F]{64}$' THEN
        v_ok := (v_hash = LOWER(v_stored));
    ELSE
        v_ok := (v_entered = v_stored OR v_hash = LOWER(v_stored));
    END IF;

    IF v_ok THEN
        PERFORM public.clear_rate_limit(v_scope);
        RETURN TRUE;
    END IF;

    PERFORM public.record_rate_limit_failure(v_scope, 5, 900, 900);
    RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.login_teacher_account(
    p_identifier TEXT,
    p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ident TEXT := LOWER(TRIM(COALESCE(p_identifier, '')));
    v_pw TEXT := COALESCE(p_password, '');
    v_scope TEXT := 'teacher_login:' || COALESCE(NULLIF(v_ident, ''), '__empty__');
    v_profile public.teacher_profiles;
    v_stored TEXT;
    v_salt TEXT;
    v_expected_hex TEXT;
    v_candidate_hex TEXT;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '12 hours';
    v_claiming_enabled BOOLEAN := FALSE;
BEGIN
    IF v_ident = '' THEN
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Invalid username/email or password.'
        );
    END IF;

    IF NOT public.check_rate_limit(v_scope, 8, 600) THEN
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Too many failed login attempts. Please wait 10 minutes before trying again.'
        );
    END IF;

    SELECT *
    INTO v_profile
    FROM public.teacher_profiles
    WHERE is_active = TRUE
      AND (
          LOWER(TRIM(COALESCE(email, ''))) = v_ident
          OR LOWER(TRIM(COALESCE(username, ''))) = v_ident
          OR LOWER(TRIM(COALESCE(name, ''))) = v_ident
      )
    LIMIT 1;

    IF NOT FOUND THEN
        PERFORM public.record_rate_limit_failure(v_scope, 8, 600, 600);
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Invalid username/email or password.'
        );
    END IF;

    v_stored := TRIM(COALESCE(v_profile.password_hash, ''));
    IF v_stored = '' THEN
        SELECT LOWER(TRIM(COALESCE(value, 'false'))) IN ('true', '1', 'yes')
        INTO v_claiming_enabled
        FROM public.app_config
        WHERE key = 'allow_teacher_account_claiming'
        LIMIT 1;

        IF NOT COALESCE(v_claiming_enabled, FALSE) THEN
            RETURN jsonb_build_object(
                'status', 'error',
                'error', 'This profile has no password and account claiming is currently disabled by the administrator.'
            );
        END IF;

        RETURN jsonb_build_object(
            'status', 'setup_required',
            'profile', public.sanitize_teacher_profile_json(v_profile),
            'message', 'This educator profile does not have a password yet. Claim it below with the School Master PIN.'
        );
    END IF;

    IF v_pw = '' THEN
        PERFORM public.record_rate_limit_failure(v_scope, 8, 600, 600);
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Invalid username/email or password.'
        );
    END IF;

    IF POSITION(':' IN v_stored) > 0 THEN
        v_salt := SPLIT_PART(v_stored, ':', 1);
        v_expected_hex := LOWER(SPLIT_PART(v_stored, ':', 2));
        v_candidate_hex := LOWER(ENCODE(SHA256(CONVERT_TO(v_salt || '::' || v_pw, 'UTF8')), 'hex'));
    ELSE
        v_expected_hex := LOWER(v_stored);
        v_candidate_hex := LOWER(ENCODE(SHA256(CONVERT_TO(v_pw, 'UTF8')), 'hex'));
    END IF;

    IF v_candidate_hex <> v_expected_hex THEN
        PERFORM public.record_rate_limit_failure(v_scope, 8, 600, 600);
        RETURN jsonb_build_object(
            'status', 'invalid_credentials',
            'error', 'Invalid username/email or password.'
        );
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    DELETE FROM public.teacher_auth_sessions
    WHERE teacher_id = v_profile.id AND expires_at <= NOW();

    v_token := LOWER(ENCODE(SHA256(CONVERT_TO(
        gen_random_uuid()::text || '::' || clock_timestamp()::text || '::' || random()::text,
        'UTF8'
    )), 'hex'));
    v_token_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    INSERT INTO public.teacher_auth_sessions (token_hash, teacher_id, role, expires_at)
    VALUES (v_token_hash, v_profile.id, COALESCE(NULLIF(TRIM(v_profile.role), ''), 'teacher'), v_expires_at);

    UPDATE public.teacher_profiles
    SET last_login_at = NOW(),
        updated_at = NOW()
    WHERE id = v_profile.id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'token', v_token,
        'expiresAt', v_expires_at,
        'profile', public.sanitize_teacher_profile_json(v_profile)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_teacher_password_with_master_pin(
    p_identifier TEXT,
    p_new_password TEXT,
    p_master_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ident TEXT := LOWER(TRIM(COALESCE(p_identifier, '')));
    v_pw TEXT := COALESCE(p_new_password, '');
    v_scope TEXT := 'master_reset:' || COALESCE(NULLIF(v_ident, ''), 'global');
    v_claiming_enabled BOOLEAN := FALSE;
    v_salt TEXT;
    v_pw_hash TEXT;
    v_profile public.teacher_profiles;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '12 hours';
BEGIN
    SELECT LOWER(TRIM(COALESCE(value, 'false'))) IN ('true', '1', 'yes')
    INTO v_claiming_enabled
    FROM public.app_config
    WHERE key = 'allow_teacher_account_claiming'
    LIMIT 1;

    IF NOT COALESCE(v_claiming_enabled, FALSE) AND NOT public.is_authenticated_teacher() THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Master PIN password resets are disabled while account claiming is locked. Please ask an administrator to enable Account Claiming.'
        );
    END IF;

    IF NOT public.check_rate_limit(v_scope, 5, 900) THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Too many failed password reset attempts. Please wait 15 minutes before trying again.'
        );
    END IF;

    IF NOT public.verify_teacher_access_pin(p_master_pin) THEN
        PERFORM public.record_rate_limit_failure(v_scope, 5, 900, 900);
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Invalid 6-digit School Master PIN.'
        );
    END IF;

    IF v_ident = '' THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'Please enter your username, email, or educator name.'
        );
    END IF;

    IF LENGTH(TRIM(v_pw)) < 6 THEN
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'New password must be at least 6 characters.'
        );
    END IF;

    v_salt := SUBSTRING(
        LOWER(ENCODE(SHA256(CONVERT_TO(gen_random_uuid()::text || '::' || clock_timestamp()::text, 'UTF8')), 'hex'))
        FROM 1 FOR 16
    );
    v_pw_hash := v_salt || ':' || LOWER(ENCODE(SHA256(CONVERT_TO(v_salt || '::' || v_pw, 'UTF8')), 'hex'));

    UPDATE public.teacher_profiles
    SET password_hash = v_pw_hash,
        last_login_at = NOW(),
        updated_at = NOW()
    WHERE is_active = TRUE
      AND (
          LOWER(TRIM(COALESCE(email, ''))) = v_ident
          OR LOWER(TRIM(COALESCE(username, ''))) = v_ident
          OR LOWER(TRIM(COALESCE(name, ''))) = v_ident
      )
    RETURNING * INTO v_profile;

    IF NOT FOUND THEN
        PERFORM public.record_rate_limit_failure(v_scope, 5, 900, 900);
        RETURN jsonb_build_object(
            'status', 'error',
            'error', 'No active educator account matched that email or username.'
        );
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    DELETE FROM public.teacher_auth_sessions
    WHERE teacher_id = v_profile.id OR expires_at <= NOW();

    v_token := LOWER(ENCODE(SHA256(CONVERT_TO(
        gen_random_uuid()::text || '::' || clock_timestamp()::text || '::' || random()::text,
        'UTF8'
    )), 'hex'));
    v_token_hash := LOWER(ENCODE(SHA256(CONVERT_TO(v_token, 'UTF8')), 'hex'));

    INSERT INTO public.teacher_auth_sessions (token_hash, teacher_id, role, expires_at)
    VALUES (v_token_hash, v_profile.id, COALESCE(NULLIF(TRIM(v_profile.role), ''), 'teacher'), v_expires_at);

    RETURN jsonb_build_object(
        'status', 'ok',
        'token', v_token,
        'expiresAt', v_expires_at,
        'profile', public.sanitize_teacher_profile_json(v_profile)
    );
END;
$$;

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
    v_clean_class TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_class, '')), '\s+', ' ', 'g'));
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
    IF v_roster_json IS NULL OR v_roster_json = '' OR v_roster_json = '[]' THEN
        RETURN jsonb_build_object('valid', false, 'unconfigured', true, 'error', 'School roster not configured in database.');
    END IF;

    BEGIN
        SELECT elem INTO v_matched
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'name', '')), '\s+', ' ', 'g')) = v_clean_name
          AND (v_clean_class = '' OR LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'class', '')), '\s+', ' ', 'g')) = v_clean_class)
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
    v_scope TEXT := 'result_lookup:' || v_code || '::' || v_query;
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

    IF NOT public.check_rate_limit(v_scope, 10, 600) THEN
        RETURN jsonb_build_object(
            'status', 'pin_mismatch',
            'submissions', '[]'::jsonb,
            'hasUnreleased', FALSE,
            'allowStudentScriptDownload', FALSE,
            'rateLimited', TRUE
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
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
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
        PERFORM public.record_rate_limit_failure(v_scope, 10, 600, 600);
        RETURN jsonb_build_object(
            'status', 'pin_mismatch',
            'submissions', '[]'::jsonb,
            'hasUnreleased', FALSE,
            'allowStudentScriptDownload', v_allow_download
        );
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

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

-- ─── 3. Strip `teacherPinHash` & Game Mode Answer Keys (VULN-P3-03 + VULN-P3-08) ─

CREATE OR REPLACE FUNCTION public.sanitize_question_json_for_student(
    p_question JSONB,
    p_strip_keys BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_q JSONB;
    v_insert_res JSONB;
    v_data_tables JSONB;
    v_subs JSONB;
BEGIN
    IF p_question IS NULL OR jsonb_typeof(p_question) <> 'object' THEN
        RETURN p_question;
    END IF;

    v_q := p_question - 'source_pdf_url' - 'metadata';
    IF NOT COALESCE(p_strip_keys, TRUE) THEN
        RETURN v_q;
    END IF;

    IF jsonb_typeof(v_q->'insert_resources') = 'array' AND jsonb_array_length(v_q->'insert_resources') > 0 THEN
        v_insert_res := v_q->'insert_resources';
    ELSIF jsonb_typeof(v_q->'mark_scheme'->'_insert_resources') = 'array' AND jsonb_array_length(v_q->'mark_scheme'->'_insert_resources') > 0 THEN
        v_insert_res := v_q->'mark_scheme'->'_insert_resources';
    ELSE
        v_insert_res := NULL;
    END IF;

    IF jsonb_typeof(v_q->'data_tables') = 'array' AND jsonb_array_length(v_q->'data_tables') > 0 THEN
        v_data_tables := public.strip_data_tables_expected_answers(v_q->'data_tables');
    ELSIF jsonb_typeof(v_q->'mark_scheme'->'_data_tables') = 'array' AND jsonb_array_length(v_q->'mark_scheme'->'_data_tables') > 0 THEN
        v_data_tables := public.strip_data_tables_expected_answers(v_q->'mark_scheme'->'_data_tables');
    ELSE
        v_data_tables := NULL;
    END IF;

    IF jsonb_typeof(v_q->'sub_questions') = 'array' THEN
        SELECT COALESCE(jsonb_agg(
            CASE
                WHEN jsonb_typeof(sq) = 'object' THEN
                    (
                        sq - 'mark_scheme' - 'guidance' - 'common_misconceptions' - 'acceptable_answers' - 'correct_answer' - 'correctAnswer'
                    ) || (
                        CASE
                            WHEN sq ? 'data_tables' AND jsonb_typeof(sq->'data_tables') = 'array'
                                THEN jsonb_build_object('data_tables', public.strip_data_tables_expected_answers(sq->'data_tables'))
                            ELSE '{}'::jsonb
                        END
                    )
                ELSE sq
            END
        ), '[]'::jsonb)
        INTO v_subs
        FROM jsonb_array_elements(v_q->'sub_questions') sq;
    ELSE
        v_subs := v_q->'sub_questions';
    END IF;

    v_q := (
        v_q - 'scratchpad' - 'guidance' - 'common_misconceptions' - 'acceptable_answers' - 'correct_answer' - 'correctAnswer' - 'source_pdf_url' - 'metadata'
    ) || jsonb_build_object('mark_scheme', 'null'::jsonb);

    IF v_subs IS NOT NULL THEN
        v_q := v_q || jsonb_build_object('sub_questions', v_subs);
    END IF;
    IF v_insert_res IS NOT NULL THEN
        v_q := v_q || jsonb_build_object('insert_resources', v_insert_res);
    END IF;
    IF v_data_tables IS NOT NULL THEN
        v_q := v_q || jsonb_build_object('data_tables', v_data_tables);
    END IF;

    RETURN v_q;
END;
$$;

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
    IF NOT v_is_active THEN
        RETURN jsonb_build_object(
            'publishedQuiz', v_quiz,
            'teacherPinHash', NULL,
            'isActive', FALSE,
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

    -- Strip answer keys in Exam Mode OR Game Mode unless instant solutions are explicitly enabled
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
        'questions', v_questions
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_student_game_paper(
    p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_paper JSONB;
    v_questions JSONB;
BEGIN
    v_paper := public.get_student_exam_paper(p_code);
    IF v_paper IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(
        jsonb_agg(public.sanitize_question_json_for_student(q, TRUE)),
        '[]'::jsonb
    )
    INTO v_questions
    FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_paper->'questions') = 'array' THEN v_paper->'questions' ELSE '[]'::jsonb END
    ) q;

    RETURN v_paper || jsonb_build_object(
        'teacherPinHash', NULL,
        'questions', v_questions
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_game_question_answer(
    p_code TEXT,
    p_question_index INT,
    p_answer TEXT
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
    v_test_id TEXT;
    v_test_row RECORD;
    v_header_raw TEXT;
    v_header_cloud JSONB := '{}'::jsonb;
    v_header_inline JSONB := '{}'::jsonb;
    v_overrides JSONB := '{}'::jsonb;
    v_qids TEXT[] := ARRAY[]::TEXT[];
    v_target_qid TEXT;
    v_q RECORD;
    v_merged JSONB;
    v_ms JSONB;
    v_options JSONB;
    v_ans TEXT := TRIM(COALESCE(p_answer, ''));
    v_norm_ans TEXT := LOWER(TRIM(COALESCE(p_answer, '')));
    v_correct_idx INT := -1;
    v_correct_text TEXT := '';
    v_acceptable TEXT[] := ARRAY[]::TEXT[];
    v_is_correct BOOLEAN := FALSE;
    v_opt TEXT;
    v_idx INT;
    v_first_pt TEXT;
BEGIN
    IF v_code = '' OR COALESCE(p_question_index, 0) < 0 THEN
        RETURN jsonb_build_object('valid', FALSE, 'isCorrect', FALSE);
    END IF;

    SELECT value INTO v_raw
    FROM public.app_config
    WHERE key IN ('quiz_by_code_' || v_code, 'quiz_by_code:' || v_code)
    ORDER BY CASE WHEN key = 'quiz_by_code_' || v_code THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_raw IS NOT NULL AND TRIM(v_raw) <> '' THEN
        BEGIN v_quiz := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_quiz := NULL; END;
    END IF;

    IF v_quiz IS NULL THEN
        SELECT value INTO v_raw FROM public.app_config WHERE key = 'published_quizzes' LIMIT 1;
        IF v_raw IS NOT NULL AND TRIM(v_raw) <> '' THEN
            BEGIN
                SELECT elem INTO v_quiz
                FROM jsonb_array_elements(v_raw::jsonb) WITH ORDINALITY AS arr(elem, ord)
                WHERE UPPER(TRIM(COALESCE(elem->>'quizCode', ''))) = v_code
                   OR UPPER(TRIM(COALESCE(elem->>'id', ''))) = v_code
                ORDER BY ord ASC
                LIMIT 1;
            EXCEPTION WHEN OTHERS THEN v_quiz := NULL; END;
        END IF;
    END IF;

    IF v_quiz IS NULL THEN
        RETURN jsonb_build_object('valid', FALSE, 'isCorrect', FALSE);
    END IF;

    IF jsonb_typeof(v_quiz->'headerConfig') = 'object' THEN
        v_header_inline := v_quiz->'headerConfig';
    END IF;
    v_test_id := TRIM(COALESCE(v_quiz->>'testId', ''));
    IF v_test_id <> '' THEN
        SELECT question_ids INTO v_test_row FROM public.custom_tests WHERE id::text = v_test_id LIMIT 1;
        SELECT value INTO v_header_raw
        FROM public.app_config
        WHERE key IN ('custom_test_header_' || v_test_id, 'test_header_' || v_test_id)
        ORDER BY CASE WHEN key = 'custom_test_header_' || v_test_id THEN 0 ELSE 1 END
        LIMIT 1;
        IF v_header_raw IS NOT NULL AND TRIM(v_header_raw) <> '' THEN
            BEGIN v_header_cloud := v_header_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_header_cloud := '{}'::jsonb; END;
        END IF;
    END IF;

    IF jsonb_typeof(v_header_cloud->'_savedQuestionIds') = 'array' AND jsonb_array_length(v_header_cloud->'_savedQuestionIds') > 0 THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_qids FROM jsonb_array_elements_text(v_header_cloud->'_savedQuestionIds') x;
    ELSIF v_test_row.question_ids IS NOT NULL AND array_length(v_test_row.question_ids, 1) > 0 THEN
        SELECT COALESCE(array_agg(id_val::text), ARRAY[]::TEXT[]) INTO v_qids FROM unnest(v_test_row.question_ids) id_val;
    ELSIF jsonb_typeof(v_quiz->'questionIds') = 'array' THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_qids FROM jsonb_array_elements_text(v_quiz->'questionIds') x;
    END IF;

    IF v_qids IS NULL OR (p_question_index + 1) > COALESCE(array_length(v_qids, 1), 0) THEN
        RETURN jsonb_build_object('valid', FALSE, 'isCorrect', FALSE);
    END IF;

    v_target_qid := v_qids[p_question_index + 1];
    v_overrides := (
        CASE WHEN jsonb_typeof(v_header_inline->'questionOverrides') = 'object' THEN v_header_inline->'questionOverrides' ELSE '{}'::jsonb END
    ) || (
        CASE WHEN jsonb_typeof(v_header_cloud->'questionOverrides') = 'object' THEN v_header_cloud->'questionOverrides' ELSE '{}'::jsonb END
    );

    IF v_target_qid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT * INTO v_q FROM public.questions WHERE id = v_target_qid::uuid LIMIT 1;
    END IF;

    IF v_q.id IS NOT NULL THEN
        v_merged := to_jsonb(v_q);
    ELSE
        v_merged := '{}'::jsonb;
    END IF;
    IF (v_overrides ? v_target_qid) AND jsonb_typeof(v_overrides->v_target_qid) = 'object' THEN
        v_merged := v_merged || (v_overrides->v_target_qid);
    END IF;

    v_ms := v_merged->'mark_scheme';
    v_options := COALESCE(v_merged->'options', '[]'::jsonb);

    IF jsonb_typeof(v_ms->'acceptable_answers') = 'array' THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_acceptable
        FROM jsonb_array_elements_text(v_ms->'acceptable_answers') x;
    END IF;
    IF array_length(v_acceptable, 1) IS NULL AND jsonb_typeof(v_ms->'marking_points') = 'array' THEN
        SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_acceptable
        FROM jsonb_array_elements_text(v_ms->'marking_points') x;
    END IF;

    IF jsonb_typeof(v_options) = 'array' AND jsonb_array_length(v_options) > 0 THEN
        v_first_pt := UPPER(TRIM(COALESCE(v_acceptable[1], '')));
        IF v_first_pt ~ '^[A-D]$' THEN
            v_correct_idx := ASCII(v_first_pt) - 65;
        ELSE
            FOR v_idx IN 0..(jsonb_array_length(v_options) - 1) LOOP
                v_opt := LOWER(TRIM(COALESCE(v_options->>v_idx, '')));
                IF v_opt = LOWER(TRIM(COALESCE(v_acceptable[1], ''))) THEN
                    v_correct_idx := v_idx;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_correct_idx >= 0 AND v_correct_idx < jsonb_array_length(v_options) THEN
            v_correct_text := COALESCE(v_options->>v_correct_idx, '');
            IF v_ans ~ '^[0-9]+$' AND v_ans::int = v_correct_idx THEN
                v_is_correct := TRUE;
            ELSIF UPPER(v_ans) = CHR(65 + v_correct_idx) THEN
                v_is_correct := TRUE;
            ELSIF v_norm_ans = LOWER(TRIM(v_correct_text)) THEN
                v_is_correct := TRUE;
            END IF;
        END IF;
    ELSE
        v_correct_text := COALESCE(v_acceptable[1], '');
        IF v_norm_ans <> '' THEN
            SELECT EXISTS (
                SELECT 1
                FROM unnest(v_acceptable) AS acc
                WHERE LOWER(TRIM(acc)) = v_norm_ans
                   OR POSITION(LOWER(TRIM(acc)) IN v_norm_ans) > 0
            ) INTO v_is_correct;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'valid', TRUE,
        'isCorrect', v_is_correct,
        'correctOptionIndex', CASE WHEN v_correct_idx >= 0 THEN v_correct_idx ELSE NULL END,
        'correctAnswerText', v_correct_text
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('valid', FALSE, 'isCorrect', FALSE);
END;
$$;

-- ─── 4. `public.game_profiles` Strict RLS & Economy Caps (VULN-P3-04) ────────

ALTER TABLE public.game_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_profiles TO authenticated;

DROP POLICY IF EXISTS "Teacher full access game_profiles" ON public.game_profiles;
CREATE POLICY "Teacher full access game_profiles"
    ON public.game_profiles FOR ALL
    USING (public.is_authenticated_teacher())
    WITH CHECK (public.is_authenticated_teacher());

CREATE OR REPLACE FUNCTION public.auth_game_profile(
    p_handle TEXT,
    p_pin_hash TEXT,
    p_real_name TEXT DEFAULT NULL,
    p_class TEXT DEFAULT 'Grade 10',
    p_avatar JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_handle TEXT := LOWER(TRIM(COALESCE(p_handle, '')));
    v_pin_hash TEXT := TRIM(COALESCE(p_pin_hash, ''));
    v_scope TEXT := 'game_auth:' || COALESCE(NULLIF(v_clean_handle, ''), '__empty__');
    v_existing public.game_profiles;
    v_new_id UUID;
    v_avatar JSONB;
BEGIN
    IF v_clean_handle = '' THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Creative handle is required.');
    END IF;

    IF v_pin_hash = '' THEN
        RETURN jsonb_build_object('success', FALSE, 'error', '4-digit PIN is required.');
    END IF;

    IF NOT public.check_rate_limit(v_scope, 8, 600) THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'error', 'Too many failed PIN attempts. Please wait 10 minutes before trying again.'
        );
    END IF;

    SELECT * INTO v_existing
    FROM public.game_profiles
    WHERE LOWER(handle) = v_clean_handle
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        IF v_existing.pin_hash = v_pin_hash THEN
            PERFORM public.clear_rate_limit(v_scope);
            RETURN jsonb_build_object(
                'success', TRUE,
                'action', 'login',
                'profile', (to_jsonb(v_existing) - 'pin_hash')
            );
        ELSE
            PERFORM public.record_rate_limit_failure(v_scope, 8, 600, 600);
            RETURN jsonb_build_object('success', FALSE, 'error', 'Incorrect 4-digit PIN for this handle.');
        END IF;
    ELSE
        v_avatar := COALESCE(p_avatar, '{
          "skin": "#ffd8b3",
          "eyes": "curious",
          "hair": "curly_brunette",
          "outfit": "lab_coat",
          "prop": "erlenmeyer_flask",
          "aura": "none"
        }'::jsonb);

        INSERT INTO public.game_profiles (
            handle, real_name, class, pin_hash, avatar, coins, xp, level, unlocked_items, topic_mastery, match_history
        )
        VALUES (
            LEFT(TRIM(p_handle), 64),
            NULLIF(LEFT(TRIM(COALESCE(p_real_name, '')), 120), ''),
            COALESCE(NULLIF(LEFT(TRIM(p_class), 64), ''), 'Grade 10'),
            v_pin_hash,
            v_avatar,
            50,
            0,
            1,
            '["default_lab_coat", "erlenmeyer_flask"]'::jsonb,
            '{}'::jsonb,
            '[]'::jsonb
        )
        RETURNING id INTO v_new_id;

        SELECT * INTO v_existing FROM public.game_profiles WHERE id = v_new_id;

        RETURN jsonb_build_object(
            'success', TRUE,
            'action', 'register',
            'profile', (to_jsonb(v_existing) - 'pin_hash')
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_game_profile_student(
    p_profile_id UUID,
    p_pin_hash TEXT,
    p_avatar JSONB DEFAULT NULL,
    p_unlocked_items JSONB DEFAULT NULL,
    p_cost INT DEFAULT 0,
    p_class TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile public.game_profiles;
    v_cost INT := GREATEST(0, COALESCE(p_cost, 0));
    v_scope TEXT := 'game_update:' || COALESCE(p_profile_id::text, 'none');
BEGIN
    IF p_profile_id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Profile ID is required.');
    END IF;

    IF NOT public.check_rate_limit(v_scope, 8, 600) THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Rate limit exceeded. Please wait before updating.');
    END IF;

    IF COALESCE(p_cost, 0) < 0 THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Invalid negative item cost.');
    END IF;

    SELECT * INTO v_profile FROM public.game_profiles WHERE id = p_profile_id LIMIT 1;
    IF v_profile.id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Profile not found.');
    END IF;

    IF v_profile.pin_hash <> TRIM(COALESCE(p_pin_hash, '')) THEN
        PERFORM public.record_rate_limit_failure(v_scope, 8, 600, 600);
        RETURN jsonb_build_object('success', FALSE, 'error', 'Unauthorized profile modification.');
    END IF;

    IF v_profile.coins < v_cost THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Insufficient coins.');
    END IF;

    PERFORM public.clear_rate_limit(v_scope);

    UPDATE public.game_profiles
    SET coins = v_profile.coins - v_cost,
        avatar = COALESCE(p_avatar, v_profile.avatar),
        unlocked_items = CASE
            WHEN p_unlocked_items IS NOT NULL AND jsonb_typeof(p_unlocked_items) = 'array'
                THEN p_unlocked_items
            ELSE v_profile.unlocked_items
        END,
        class = COALESCE(NULLIF(LEFT(TRIM(COALESCE(p_class, '')), 64), ''), v_profile.class),
        updated_at = NOW()
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;

    RETURN jsonb_build_object(
        'success', TRUE,
        'profile', (to_jsonb(v_profile) - 'pin_hash')
    );
END;
$$;

DROP FUNCTION IF EXISTS public.sync_game_match_rewards(UUID, INT, INT, TEXT, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.sync_game_match_rewards(
    p_profile_id UUID,
    p_coins INT,
    p_xp INT,
    p_subject TEXT,
    p_topic_results JSONB,
    p_match_summary JSONB,
    p_pin_hash TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile public.game_profiles;
    v_coins INT;
    v_xp INT;
    v_mastery JSONB;
    v_subj_mastery JSONB;
    v_history JSONB;
    v_item JSONB;
    v_topic TEXT;
    v_correct BOOLEAN;
    v_curr_topic JSONB;
    v_c_correct INT;
    v_c_total INT;
    v_new_xp INT;
    v_new_level INT;
    v_subject TEXT := COALESCE(NULLIF(LEFT(TRIM(COALESCE(p_subject, '')), 120), ''), 'General');
BEGIN
    IF p_profile_id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Profile not found.');
    END IF;

    IF COALESCE(p_coins, 0) < 0 OR COALESCE(p_xp, 0) < 0 THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Negative reward deltas are not permitted.');
    END IF;

    IF p_topic_results IS NOT NULL AND jsonb_typeof(p_topic_results) = 'array' AND jsonb_array_length(p_topic_results) > 100 THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Topic results batch exceeds limit.');
    END IF;

    SELECT * INTO v_profile FROM public.game_profiles WHERE id = p_profile_id LIMIT 1;
    IF v_profile.id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Profile not found.');
    END IF;

    IF p_pin_hash IS NOT NULL AND v_profile.pin_hash <> TRIM(p_pin_hash) THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Unauthorized reward sync.');
    END IF;

    -- Cap per-match economy gains server-side
    v_coins := LEAST(GREATEST(COALESCE(p_coins, 0), 0), 500);
    v_xp := LEAST(GREATEST(COALESCE(p_xp, 0), 0), 1000);

    v_new_xp := v_profile.xp + v_xp;
    v_new_level := 1 + FLOOR(v_new_xp / 150);

    v_mastery := COALESCE(v_profile.topic_mastery, '{}'::jsonb);
    v_subj_mastery := COALESCE(v_mastery->v_subject, '{}'::jsonb);

    IF p_topic_results IS NOT NULL AND jsonb_typeof(p_topic_results) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_topic_results)
        LOOP
            v_topic := LEFT(TRIM(COALESCE(v_item->>'topic', 'General')), 120);
            IF v_topic = '' THEN v_topic := 'General'; END IF;
            v_correct := COALESCE((v_item->>'correct')::boolean, FALSE);
            v_curr_topic := COALESCE(v_subj_mastery->v_topic, '{"correct": 0, "total": 0, "masteryPct": 0}'::jsonb);

            v_c_correct := COALESCE((v_curr_topic->>'correct')::int, 0) + (CASE WHEN v_correct THEN 1 ELSE 0 END);
            v_c_total := COALESCE((v_curr_topic->>'total')::int, 0) + 1;

            v_subj_mastery := jsonb_set(
                v_subj_mastery,
                ARRAY[v_topic],
                jsonb_build_object(
                    'correct', v_c_correct,
                    'total', v_c_total,
                    'masteryPct', ROUND((v_c_correct::numeric / v_c_total::numeric) * 100),
                    'lastPracticed', NOW()
                )
            );
        END LOOP;
    END IF;

    v_mastery := jsonb_set(v_mastery, ARRAY[v_subject], v_subj_mastery);

    v_history := COALESCE(v_profile.match_history, '[]'::jsonb);
    IF p_match_summary IS NOT NULL THEN
        v_history := (jsonb_build_array(p_match_summary) || v_history);
        IF jsonb_array_length(v_history) > 20 THEN
            SELECT jsonb_agg(elem) INTO v_history
            FROM (
                SELECT elem FROM jsonb_array_elements(v_history) WITH ORDINALITY arr(elem, idx)
                WHERE idx <= 20
            ) sub;
        END IF;
    END IF;

    UPDATE public.game_profiles
    SET coins = v_profile.coins + v_coins,
        xp = v_new_xp,
        level = v_new_level,
        topic_mastery = v_mastery,
        match_history = v_history,
        updated_at = NOW()
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;

    RETURN jsonb_build_object('success', TRUE, 'profile', (to_jsonb(v_profile) - 'pin_hash'));
END;
$$;

-- ─── 5. Draft-Lock + Roster-PIN Submission Guard (VULN-P3-06) ────────────────

CREATE OR REPLACE FUNCTION public.verify_roster_pin_if_enrolled(
    p_student_name TEXT,
    p_student_class TEXT DEFAULT NULL,
    p_candidate_number TEXT DEFAULT NULL,
    p_student_pin TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_roster_json TEXT;
    v_clean_name TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_name, '')), '\s+', ' ', 'g'));
    v_clean_class TEXT := LOWER(REGEXP_REPLACE(TRIM(COALESCE(p_student_class, '')), '\s+', ' ', 'g'));
    v_clean_pin TEXT := TRIM(COALESCE(p_student_pin, ''));
    v_matched JSONB := NULL;
    v_stored_pin TEXT;
BEGIN
    IF v_clean_name = '' THEN
        RETURN TRUE;
    END IF;

    SELECT value INTO v_roster_json FROM public.app_config WHERE key = 'school_roster' LIMIT 1;
    IF v_roster_json IS NULL OR TRIM(v_roster_json) = '' OR TRIM(v_roster_json) = '[]' THEN
        RETURN TRUE;
    END IF;

    BEGIN
        SELECT elem INTO v_matched
        FROM jsonb_array_elements(v_roster_json::jsonb) AS elem
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'name', '')), '\s+', ' ', 'g')) = v_clean_name
          AND (
              v_clean_class = ''
              OR TRIM(COALESCE(elem->>'class', '')) = ''
              OR LOWER(REGEXP_REPLACE(TRIM(COALESCE(elem->>'class', '')), '\s+', ' ', 'g')) = v_clean_class
          )
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RETURN TRUE;
    END;

    IF v_matched IS NULL THEN
        RETURN TRUE;
    END IF;

    v_stored_pin := TRIM(COALESCE(v_matched->>'pin', ''));
    IF v_stored_pin = '' THEN
        RETURN TRUE;
    END IF;

    RETURN v_stored_pin = v_clean_pin;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_roster_pin_if_enrolled(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

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

    -- Enforce roster PIN when quiz requires PIN or candidate provided a roster PIN
    IF (v_require_student_pin OR v_student_pin <> '') THEN
        IF NOT public.verify_roster_pin_if_enrolled(v_student_name, v_student_class, v_candidate_number, v_student_pin) THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- Enforce draft-lock ownership when an active draft lock exists for this candidate
    v_draft_key := COALESCE(
        NULLIF(TRIM(COALESCE(p_row->>'draft_key', '')), ''),
        'draft_' || v_quiz_code || '_' || REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(NULLIF(v_student_pin, ''), v_student_name))),
            '[^a-z0-9_-]',
            '_',
            'g'
        )
    );

    SELECT owner_token_hash INTO v_lock_hash
    FROM public.exam_draft_locks
    WHERE draft_key = v_draft_key
    LIMIT 1;

    IF v_lock_hash IS NULL AND v_student_pin <> '' THEN
        SELECT owner_token_hash INTO v_lock_hash
        FROM public.exam_draft_locks
        WHERE draft_key = 'draft_' || v_quiz_code || '_' || REGEXP_REPLACE(LOWER(v_student_name), '[^a-z0-9_-]', '_', 'g')
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

-- ─── 6. Permissions & Comments ───────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.verify_teacher_access_pin(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_teacher_account(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_teacher_password_with_master_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_student_pin(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_student_exam_result(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_paper(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_game_paper(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_game_question_answer(TEXT, INT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_game_profile(TEXT, TEXT, TEXT, TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_game_profile_student(UUID, TEXT, JSONB, JSONB, INT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_game_match_rewards(UUID, INT, INT, TEXT, JSONB, JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_student_exam_attempt(JSONB) TO anon, authenticated;
